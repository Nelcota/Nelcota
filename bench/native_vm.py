#!/usr/bin/env python3
"""Bounded native/systemd and guest power-cut acceptance on an owned KVM VM.

This manual Actions harness never runs on an unknown/self-hosted machine.
The guest's loss of RAM is not physical host/controller power-loss evidence.
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from native_preflight import inventory
from native_evidence import publish
from watchdog import atomic_json, process_identity, stop_owner

IMAGE = "ubuntu-24.04-server-cloudimg-amd64.img"
ORIGIN = "https://cloud-images.ubuntu.com/releases/noble/release/"
GIB = 1024 ** 3
MIB = 1024 ** 2
MAXIMUM_SECONDS = 1800
SCENARIOS = ("runtime", "runtime-inflight", "runtime-pitr-error", "runtime-pitr-reboot", "cluster-routing", "default-root", "host-root", "clock-drift", "remove-boundary")
PITR_SCENARIOS = {"runtime-pitr-error", "runtime-pitr-reboot"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(arguments, *, timeout=30, check=True):
    result = subprocess.run([str(value) for value in arguments], capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError("Host command failed: " + Path(arguments[0]).name + " exit " + str(result.returncode))
    return result


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def receive(url, path, limit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    digest = hashlib.sha256()
    length = 0
    began = time.monotonic()
    with opener.open(url, timeout=30) as response, path.open("xb") as target:
        require(response.url.startswith(ORIGIN) and response.url.startswith("https://"), "Unexpected image download origin")
        while True:
            value = response.read(1024 * 1024)
            if not value:
                break
            length += len(value)
            require(length <= limit and time.monotonic() - began < 300, "Image download exceeded its boundary")
            digest.update(value)
            target.write(value)
    return {"bytes": length, "sha256": digest.hexdigest(), "url": url}


def network_bytes():
    total = 0
    for item in Path("/sys/class/net").iterdir():
        if item.name == "lo":
            continue
        for direction in ["rx_bytes", "tx_bytes"]:
            total += int((item / "statistics" / direction).read_text())
    return total


def unit(identity):
    require(re.fullmatch(r"native-vm-[a-z0-9-]{1,64}", identity), "Invalid VM service identity")
    return identity + ".service"


def unit_fields(identity):
    output = command(["systemctl", "show", unit(identity), "--property=Description,LoadState,ActiveState,ControlGroup,MainPID"], check=False).stdout
    return dict(line.split("=", 1) for line in output.decode().splitlines() if "=" in line)


def stop_owned(identity, *, power_cut=False, before_signal=None):
    require(before_signal is None or power_cut and callable(before_signal), "Invalid owned cut witness callback")
    state = unit_fields(identity)
    if state.get("LoadState") == "not-found":
        return state
    require(state.get("Description") == identity, "Refusing to stop a foreign systemd service")
    if state.get("ActiveState") in {"inactive", "failed"}:
        return state
    arguments = ["systemctl", "stop", unit(identity)]
    if power_cut:
        arguments = ["systemctl", "kill", "--signal=SIGKILL", "--kill-whom=all", unit(identity)]
    if before_signal is not None:
        before_signal()
    command(arguments)
    until = time.monotonic() + 15
    while time.monotonic() < until:
        state = unit_fields(identity)
        if state.get("ActiveState") in {"inactive", "failed"} and state.get("MainPID", "0") == "0":
            return state
        time.sleep(0.2)
    raise RuntimeError("Owned VM service did not stop")


def watchdog(directory):
    owner = json.loads((directory / "ownership.json").read_text())
    identity = owner["identity"]
    unit(identity)
    require(directory.resolve() == Path(owner["output"]).resolve(), "Watchdog ownership path mismatch")
    while not (directory / "watchdog-disarmed").exists():
        reason = None
        now = time.monotonic()
        try:
            heartbeat = json.loads((directory / "heartbeat.json").read_text())
            if now - heartbeat["monotonic"] > 30:
                reason = "resource_observation_gap"
        except (OSError, ValueError, KeyError):
            reason = "missing_resource_observer"
        if process_identity(owner["pid"]) != owner["process_identity"]:
            reason = "controller_disappeared"
        if now - owner["started_monotonic"] > MAXIMUM_SECONDS:
            reason = "campaign_duration_limit"
        if reason is not None:
            state = stop_owned(identity)
            atomic_json(directory / "public/emergency-stop.json", {"reason": reason, "unit_state": state})
            stop_owner(owner)
            return
        time.sleep(1)


class Guest:
    def __init__(self, identity, directory):
        self.identity = identity
        self.directory = directory
        self.ssh_port = free_port()
        self.https_port = free_port()
        while self.https_port == self.ssh_port:
            self.https_port = free_port()
        self.ready = False
        self.guard_failure = None
        self.phase = "preparation"
        self.fault_until = 0
        self.network_initial = network_bytes()
        self.stopped = threading.Event()
        self.last_guest_sample = time.monotonic()
        self.samples = 0
        self.started = time.monotonic()

    def ssh(self, arguments, *, timeout=30, check=True):
        options = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes",
                   "-o", "UserKnownHostsFile=" + str(self.directory / "known_hosts"),
                   "-o", "ConnectTimeout=5", "-i", str(self.directory / "client"), "-p", str(self.ssh_port)]
        return command(["ssh", *options, "g05@127.0.0.1", shlex.join([str(value) for value in arguments])],
                       timeout=timeout, check=check)

    def copy(self, source, target):
        command(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes",
                 "-o", "UserKnownHostsFile=" + str(self.directory / "known_hosts"), "-o", "ConnectTimeout=5",
                 "-i", self.directory / "client", "-P", str(self.ssh_port), source, "g05@127.0.0.1:" + target], timeout=60)

    def action(self, action, *extra, timeout=60):
        result = self.ssh(["sudo", "-n", "python3", "/opt/g05-tools/native_guest.py", self.identity, action, *extra],
                          timeout=timeout, check=False)
        if result.returncode:
            try:
                evidence = json.loads(result.stdout)
            except ValueError:
                evidence = {"failure_type": "unstructured_guest_command", "exit_code": result.returncode}
            with (self.directory / "public/guest-action-failures.jsonl").open("a") as stream:
                stream.write(json.dumps({"action": action, "phase": self.phase, "monotonic": time.monotonic(),
                                         "evidence": evidence}, allow_nan=False) + "\n")
            raise RuntimeError("Native guest action failed: " + action)
        if action == "token":
            return result.stdout.decode().strip()
        return json.loads(result.stdout)

    def start(self):
        self.assert_safe()
        self.ready = False
        state = unit_fields(self.identity)
        if state.get("LoadState") != "not-found":
            require(state.get("Description") == self.identity and state.get("ActiveState") in {"inactive", "failed"},
                    "Refusing to reset or replace an existing foreign/running VM service")
        command(["systemctl", "reset-failed", unit(self.identity)], check=False)
        command(["systemd-run", "--unit=" + self.identity, "--description=" + self.identity,
                 "--property=MemoryMax=4G", "--property=MemorySwapMax=0", "--property=CPUQuota=200%",
                 "--property=TasksMax=128", "--property=RuntimeMaxSec=1800", "--property=KillMode=control-group",
                 "--property=TimeoutStopSec=10", "--", "qemu-system-x86_64", "-accel", "kvm", "-cpu", "host",
                 "-smp", "2", "-m", "3072", "-display", "none", "-no-reboot",
                 "-serial", "file:" + str(self.directory / "serial.log"),
                 "-drive", "file=" + str(self.directory / "guest.qcow2") + ",if=virtio,format=qcow2,cache=none",
                 "-drive", "file=" + str(self.directory / "seed.iso") + ",media=cdrom,readonly=on",
                 "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:" + str(self.ssh_port) + "-:22,hostfwd=tcp:127.0.0.1:" + str(self.https_port) + "-:443",
                 "-device", "virtio-net-pci,netdev=net0"], timeout=30)
        self.fault_until = time.monotonic() + 180
        until = time.monotonic() + 180
        while time.monotonic() < until:
            self.assert_safe()
            result = self.ssh(["true"], timeout=8, check=False)
            if result.returncode == 0:
                return
            time.sleep(1)
        raise RuntimeError("Owned guest SSH readiness deadline")

    def assert_safe(self):
        if self.guard_failure is not None:
            raise RuntimeError("Native VM safety guard: " + self.guard_failure)
        require(time.monotonic() - self.started <= MAXIMUM_SECONDS, "Native VM duration exhausted")
        require(not (self.directory / "public/emergency-stop.json").exists(), "Independent native VM watchdog stopped the run")

    def guard(self):
        while not self.stopped.is_set():
            now = time.monotonic()
            try:
                memory = {}
                for line in Path("/proc/meminfo").read_text().splitlines():
                    values = line.split()
                    if values[0] in {"MemTotal:", "MemAvailable:"}:
                        memory[values[0]] = int(values[1]) * 1024
                fs = os.statvfs(self.directory)
                require(memory["MemAvailable:"] >= memory["MemTotal:"] * 0.1, "host_memory_reserve")
                require(fs.f_bavail >= fs.f_blocks * 0.15 and fs.f_favail >= fs.f_files * 0.15, "host_filesystem_reserve")
                traffic = network_bytes() - self.network_initial
                require(traffic <= 4 * GIB, "external_traffic_budget")
                state = unit_fields(self.identity)
                group = state.get("ControlGroup", "")
                if group:
                    require(state.get("Description") == self.identity, "VM_service_ownership")
                    events_path = Path("/sys/fs/cgroup") / group.lstrip("/") / "memory.events"
                    if events_path.is_file():
                        events = dict(line.split() for line in events_path.read_text().splitlines())
                        require(int(events.get("oom_kill", "0")) == 0, "VM_oom_kill")
                sample = {"monotonic": now, "phase": self.phase, "host_memory_bytes": memory,
                          "host_free_filesystem_fraction": fs.f_bavail / fs.f_blocks,
                          "external_network_bytes_since_start": traffic, "vm_unit": state}
                serial = self.directory / "serial.log"
                if serial.exists():
                    require(serial.stat().st_size <= 4 * MIB, "serial_log_budget")
                if self.ready:
                    try:
                        probe = self.action("resources", timeout=12)
                        self.last_guest_sample = time.monotonic()
                        require(probe["free_filesystem_fraction"] >= 0.15 and probe["free_inode_fraction"] >= 0.15, "guest_filesystem_reserve")
                        mem = probe["memory_bytes"]
                        require(mem["MemAvailable"] >= mem["MemTotal"] * 0.1, "guest_memory_reserve")
                        postgres_bytes = sum(value for name, value in probe["disk_bytes"].items() if name.startswith("postgres"))
                        require(postgres_bytes <= 2048 * MIB, "guest_postgres_disk_budget")
                        require(probe["disk_bytes"].get("storage", 0) <= 256 * MIB, "guest_storage_disk_budget")
                        for value in probe["units"].values():
                            require(value.get("memory_events", {}).get("oom_kill", 0) == 0, "guest_unit_oom_kill")
                        sample["guest"] = probe
                    except (OSError, ValueError, subprocess.TimeoutExpired, RuntimeError) as error:
                        if str(error).startswith(("guest_", "VM_")):
                            raise
                        require(time.monotonic() - self.last_guest_sample <= 30 or time.monotonic() < self.fault_until,
                                "guest_observation_gap")
                        sample["guest_sample_error_type"] = type(error).__name__
                with (self.directory / "public/resources.jsonl").open("a") as stream:
                    stream.write(json.dumps(sample, allow_nan=False) + "\n")
                self.samples += 1
                atomic_json(self.directory / "heartbeat.json", {"monotonic": time.monotonic()})
            except Exception as error:
                self.guard_failure = str(error)[:200]
                try:
                    stop_owned(self.identity)
                finally:
                    atomic_json(self.directory / "public/critical-stop.json", {"reason": self.guard_failure, "monotonic": now})
                return
            self.stopped.wait(5)


class Connection(http.client.HTTPSConnection):
    def __init__(self, port, context):
        super().__init__("stress.localhost", context=context, timeout=5)
        self.forwarded_port = port

    def connect(self):
        transport = socket.create_connection(("127.0.0.1", self.forwarded_port), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(transport, server_hostname="stress.localhost")
        except Exception:
            transport.close()
            raise


class Api:
    def __init__(self, guest, certificate):
        self.guest = guest
        self.context = ssl.create_default_context(cadata=certificate)
        self.attempts = 0
        self.received_bytes = 0
        self.sent_bytes = 0

    def request(self, method, path, *, token=None, value=None, raw=None, expected=(200,), headers=None):
        self.guest.assert_safe()
        fields = dict(headers or {})
        body = raw
        if value is not None:
            body = json.dumps(value).encode()
            fields["Content-Type"] = "application/json"
        if token is not None:
            fields["Authorization"] = "Bearer " + token
        fields["Accept-Encoding"] = "identity"
        connection = Connection(self.guest.https_port, self.context)
        try:
            self.attempts += 1
            self.sent_bytes += len(body or b"")
            connection.request(method, path, body=body, headers=fields)
            response = connection.getresponse()
            content = response.read(MIB + 1)
            self.received_bytes += len(content)
            require(len(content) <= MIB, "Native response body exceeded its bound")
            require(response.status in expected, "Unexpected native HTTP status " + str(response.status))
            return content
        finally:
            connection.close()

    def ready(self, seconds=90):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            self.guest.assert_safe()
            try:
                result = json.loads(self.request("GET", "/health"))
                if result.get("status") == "ok":
                    return
            except (OSError, ValueError, RuntimeError, http.client.HTTPException):
                time.sleep(0.5)
        raise RuntimeError("Native verified HTTPS health deadline")


def signup(api, email, password):
    account = json.loads(api.request("POST", "/auth/v1/signup", value={"email": email, "password": password}, expected=(201,)))
    require(isinstance(account, dict) and isinstance(account.get("access_token"), str) and bool(account["access_token"]),
            "Native signup returned no access token")
    user = account.get("user")
    require(isinstance(user, dict) and user.get("email") == email, "Native signup returned another identity")
    return account["access_token"]


def clock_probe(guest, api, token, service, result):
    """Step only the owned guest's wall clock; the observer stays monotonic."""
    require(isinstance(token, str) and len(token) <= 4096 and len(token.split(".")) == 3,
            "Invalid clock-probe access token")
    encoded = token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    expires = claims.get("exp")
    now = int(time.time())
    require(type(expires) is int and 0 < expires - now <= 1500,
            "Clock probe requires a fresh bounded access-token lifetime")
    target = expires + 120
    require(0 < target - now <= 1800, "Guest clock step exceeded its bound")
    initial = guest.ssh(["timedatectl", "show", "--property=NTP", "--value"]).stdout.strip()
    require(initial in {b"yes", b"no"}, "Unknown guest NTP state")
    result.update({"scope": "owned guest wall-clock control; no host/controller clock change or throughput credit",
                   "initial_ntp_enabled": initial == b"yes", "planned_forward_seconds": target - now,
                   "maximum_forward_seconds": 1800, "observer_clock": "external monotonic",
                   "status": "failed"})
    path = "/rest/v1/native_probe?select=id&order=id"
    require(json.loads(api.request("GET", path, token=token)) == [{"id": 1}], "Clock canary failed before the step")
    try:
        guest.ssh(["sudo", "-n", "timedatectl", "set-ntp", "false"])
        guest.ssh(["sudo", "-n", "date", "--utc", "--set=@" + str(target), "+%s"])
        shifted = guest.ssh(["date", "+%s"]).stdout.strip()
        require(shifted.isdigit() and len(shifted) <= 16, "Invalid stepped guest clock")
        result["observed_forward_seconds"] = int(shifted) - time.time()
        require(abs(int(shifted) - target) <= 5 and 0 < result["observed_forward_seconds"] <= 1805,
                "Guest clock did not perform the declared bounded step")
        guest.assert_safe()
        api.request("GET", path, token=token, expected=(401,))
        result["expired_access_rejected"] = True
        require(json.loads(api.request("GET", path, token=service)) == [{"id": 1}],
                "Service-role canary failed during the controlled clock step")
        result["long_lived_service_canary_passed"] = True
        api.request("GET", path, expected=(401,))
    finally:
        restored_epoch = int(time.time())
        restore_ntp = "false"
        if initial == b"yes":
            restore_ntp = "true"
        for label, arguments in [
            ("wall_clock", ["sudo", "-n", "date", "--utc", "--set=@" + str(restored_epoch), "+%s"]),
            ("ntp_state", ["sudo", "-n", "timedatectl", "set-ntp", restore_ntp]),
        ]:
            try:
                result[label + "_restore_exit_code"] = guest.ssh(arguments, check=False, timeout=15).returncode
            except Exception as error:
                result[label + "_restore_failure_type"] = type(error).__name__
    require(result.get("wall_clock_restore_exit_code") == 0 and result.get("ntp_state_restore_exit_code") == 0,
            "Owned guest clock or NTP restoration failed")
    raw = guest.ssh(["date", "+%s"]).stdout.strip()
    require(raw.isdigit() and len(raw) <= 16, "Invalid restored guest clock")
    result["restored_clock_offset_seconds"] = abs(int(raw) - time.time())
    require(result["restored_clock_offset_seconds"] <= 5, "Guest clock did not return to the external observer time")
    restored_ntp = guest.ssh(["timedatectl", "show", "--property=NTP", "--value"]).stdout.strip()
    require(restored_ntp == initial, "Guest NTP state changed after restoration")
    require(json.loads(api.request("GET", path, token=token)) == [{"id": 1}],
            "Ordinary access canary failed after restoring the guest clock")
    result["ordinary_access_restored"] = True
    result["status"] = "passed"


def campaign_identity(run, attempt, scenario, pass_index=None):
    require(re.fullmatch(r"[0-9]{1,20}", run) is not None and re.fullmatch(r"[0-9]{1,4}", attempt) is not None,
            "Invalid workflow identity")
    identity = "native-vm-" + run + "-" + attempt
    if pass_index is not None:
        require(type(pass_index) is int and pass_index in {1, 2} and
                scenario in SCENARIOS,
                "Unknown bounded native suite case")
        identity += "-p" + str(pass_index) + "-" + scenario
    return identity


def campaign(binary, output, scenario, pass_index=None):
    capabilities = inventory()
    require(os.geteuid() == 0, "Native VM control requires root on the disposable Actions VM")
    require(os.access("/dev/kvm", os.R_OK | os.W_OK), "KVM is unavailable to the isolated VM controller")
    require(capabilities["cpu_affinity_slots"] >= 4, "Native VM campaign needs four CPU slots")
    require(not output.exists(), "Preserve prior native VM evidence")
    output.mkdir(parents=True, mode=0o700)
    public = output / "public"
    public.mkdir(mode=0o755)
    began = time.monotonic()
    binary_digest = hashlib.file_digest(binary.open("rb"), "sha256").hexdigest()
    cpu_sum = 2.25
    if scenario == "cluster-routing":
        cpu_sum = 3.25
    if scenario == "runtime-inflight":
        cpu_sum += .05
    if scenario in PITR_SCENARIOS:
        cpu_sum += .1
    identity = campaign_identity(os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"], scenario, pass_index)
    unit(identity)
    require(unit_fields(identity).get("LoadState") == "not-found", "VM service already exists")
    owner = {"identity": identity, "output": str(output), "pid": os.getpid(),
             "process_identity": process_identity(os.getpid()), "started_monotonic": began,
             "maximum_seconds": MAXIMUM_SECONDS}
    atomic_json(output / "ownership.json", owner)
    atomic_json(output / "heartbeat.json", {"monotonic": began})
    atomic_json(public / "predeclared-profile.json", {
        "scope": "disposable Ubuntu 24.04 x64 native functional and guest power-cut acceptance; no production certification",
        "source": capabilities["source"], "scenario": scenario,
        "binary_sha256": binary_digest,
        "maximum_seconds": MAXIMUM_SECONDS, "vm_vcpus": 2, "vm_memory_mib": 3072,
        "guest_target_cpu_ceiling": 1.5, "guest_os_cpu_reserve": 0.5,
        "guest_target_memory_ceiling_mib": 2048, "guest_os_memory_reserve_mib": 1024,
        "sum_of_individual_guest_unit_cpu_quotas": cpu_sum,
        "individual_quota_oversubscription_is_bounded_by_parent_slice": True,
        "vm_process_memory_mib": 4096, "vm_process_cpu_quota": 2, "vm_process_pids": 128,
        "guest_root_virtual_disk_gib": 12, "maximum_external_network_bytes": 4 * GIB,
        "network_budget_scope": "since controller start; includes image and guest package downloads, excludes checkout and outer build/tool installation",
        "host_and_guest_available_memory_minimum_fraction": 0.1, "host_and_guest_free_disk_inode_minimum_fraction": 0.15,
        "guest_postgres_maximum_disk_mib": 2048, "guest_storage_maximum_disk_mib": 256,
        "sample_seconds": 5, "maximum_guest_sample_gap_seconds": 30,
        "boot_fault_observation_grace_seconds": 180, "tls_verification": True,
        "ssh_host_key_verification": "fresh controller-generated Ed25519 host key injected through owned cloud-init seed",
        "host_power_loss_certified": False, "off_host_restore_certified": False,
        "public_dns_acme_certified": False, "workload_maximum_mutations_per_second": 1,
        "in_flight_cut": {"enabled": scenario == "runtime-inflight", "blocked_writes": 1,
                          "helper_cpu_quota": .05, "helper_memory_mib": 48, "helper_pids": 16,
                          "maximum_table_lock_seconds": 30, "helper_runtime_seconds": 40,
                          "maximum_observation_age_seconds": 2,
                          "scope": "Owned guest table lock; blocked before COMMIT, no physical host power loss"},
        "controlled_PITR_adapter_error": {"enabled": scenario in PITR_SCENARIOS,
                                         "helper_cpu_quota": .1, "helper_memory_mib": 96,
                                         "helper_pids": 32, "helper_runtime_seconds": 120,
                                         "real_PG_files_modified": False,
                                         "scope": "Actual CLI error handling after inert owned marker; no real PITR/S3/data-corruption claim"},
        "PITR_error_boot_persistence": {"enabled": scenario == "runtime-pitr-reboot",
                                        "minimum_post_boot_observation_seconds": 20,
                                        "maximum_post_boot_observation_seconds": 50,
                                        "maximum_post_boot_samples": 22,
                                        "explicit_recovery_deferred_until_after_boot_observation": True,
                                        "scope": "Loss of owned guest RAM after known marker-only adapter cleanup; unchanged real PG files"},
        "controlled_guest_clock": {"enabled": scenario == "clock-drift", "maximum_forward_seconds": 1800,
                                   "step_verification_tolerance_seconds": 5,
                                   "maximum_restored_offset_seconds": 5, "restore_command_timeout_seconds": 15,
                                   "ntp_restoration": "original state", "host_clock_modified": False}})
    guest = Guest(identity, output)
    guard = threading.Thread(target=guest.guard, daemon=True)
    guard.start()
    watcher = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--watchdog", str(output)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    report = {"identity": identity, "source": capabilities["source"], "binary_sha256": binary_digest,
              "scenario": scenario, "certifies_g05": False, "checks": []}
    clean = False
    try:
        sums = receive(ORIGIN + "SHA256SUMS", output / "SHA256SUMS", MIB)
        entries = [line.split() for line in (output / "SHA256SUMS").read_text().splitlines()]
        expected = [fields[0] for fields in entries if len(fields) == 2 and fields[1].lstrip("*") == IMAGE]
        require(len(expected) == 1 and re.fullmatch(r"[0-9a-f]{64}", expected[0]), "Missing unique cloud image checksum")
        image = receive(ORIGIN + IMAGE, output / IMAGE, 1024 * MIB)
        require(image["sha256"] == expected[0], "Cloud image checksum mismatch")
        image_info = json.loads(command(["qemu-img", "info", "--output=json", output / IMAGE]).stdout)
        require(image_info.get("format") == "qcow2" and not image_info.get("backing-filename"), "Unexpected cloud image backing chain")
        require(0 < image_info.get("virtual-size", 0) <= 12 * GIB, "Cloud image exceeds declared guest disk")
        report["image"] = image
        report["image_checksum_manifest"] = sums
        command(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", output / IMAGE, output / "guest.qcow2", "12G"])
        for name in ["client", "host"]:
            command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", output / name])
        host_key = (output / "host.pub").read_text().split()[:2]
        (output / "known_hosts").write_text("[127.0.0.1]:" + str(guest.ssh_port) + " " + " ".join(host_key) + "\n")
        user = {"users": [{"name": "g05", "sudo": "ALL=(ALL) NOPASSWD:ALL", "lock_passwd": True,
                           "shell": "/bin/bash", "ssh_authorized_keys": [(output / "client.pub").read_text().strip()]}],
                "ssh_pwauth": False, "disable_root": True,
                "ssh_keys": {"ed25519_private": (output / "host").read_text(), "ed25519_public": (output / "host.pub").read_text()},
                "write_files": [{"path": "/etc/g05-native-owner", "permissions": "0600", "owner": "root:root", "content": identity + "\n"}]}
        (output / "user-data").write_text("#cloud-config\n" + json.dumps(user) + "\n")
        (output / "meta-data").write_text(json.dumps({"instance-id": identity, "local-hostname": "g05-native"}))
        command(["cloud-localds", output / "seed.iso", output / "user-data", output / "meta-data"])
        guest.phase = "boot"
        guest.start()
        guest.ssh(["sudo", "-n", "cloud-init", "status", "--wait"], timeout=180)
        guest.copy(binary, "/tmp/nelcota-g05")
        guest.copy(Path(__file__).with_name("native_guest.py"), "/tmp/native_guest.py")
        guest.copy(Path(__file__).with_name("native_cluster.py"), "/tmp/native_cluster.py")
        guest.copy(Path(__file__).with_name("native_contracts.py"), "/tmp/native_contracts.py")
        guest.ssh(["sudo", "-n", "install", "-m", "755", "/tmp/nelcota-g05", "/usr/local/bin/nelcota"])
        installed_digest = guest.ssh(["sha256sum", "/usr/local/bin/nelcota"]).stdout.decode().split()[0]
        require(installed_digest == binary_digest, "Guest binary differs from the frozen controller input")
        guest.ssh(["sudo", "-n", "install", "-d", "-m", "700", "/opt/g05-tools"])
        guest.ssh(["sudo", "-n", "install", "-m", "600", "/tmp/native_guest.py", "/opt/g05-tools/native_guest.py"])
        guest.ssh(["sudo", "-n", "install", "-m", "600", "/tmp/native_cluster.py", "/opt/g05-tools/native_cluster.py"])
        guest.ssh(["sudo", "-n", "install", "-m", "600", "/tmp/native_contracts.py", "/opt/g05-tools/native_contracts.py"])
        if scenario == "runtime-inflight":
            guest.copy(Path(__file__).with_name("native_inflight.py"), "/tmp/native_inflight.py")
            guest.ssh(["sudo", "-n", "install", "-m", "600", "/tmp/native_inflight.py", "/opt/g05-tools/native_inflight.py"])
        if scenario in PITR_SCENARIOS:
            guest.copy(Path(__file__).with_name("native_pitr_failure.py"), "/tmp/native_pitr_failure.py")
            guest.ssh(["sudo", "-n", "install", "-m", "600", "/tmp/native_pitr_failure.py", "/opt/g05-tools/native_pitr_failure.py"])
        guest.ready = True
        guest.last_guest_sample = time.monotonic()
        if scenario in {"default-root", "host-root", "remove-boundary"}:
            guest.phase = "native-" + scenario
            report["native_contract"] = guest.action(scenario, timeout=850)
            evidence = report["native_contract"]
            if scenario == "default-root":
                require(evidence["init_exit_code"] == 0, "Documented native init from cwd failed")
                require(evidence["environment_file_absolute"], "Documented native cwd produced a relative systemd EnvironmentFile")
                require(evidence["systemd_verify_exit_code"] == 0 and evidence["up_exit_code"] == 0,
                        "Documented native cwd failed actual systemd verification or activation")
                require(evidence["cwd_migration_exit_code"] == 0 and evidence["root_environment_migration_exit_code"] == 0,
                        "Native migrations from host cwd or NELCOTA_ROOT failed")
                require(evidence["fixture_table_created"] and evidence["migration_journal_present"] and evidence["applied_fixture_migrations"] == 1,
                        "Native cwd migrations were absent or repeated")
                require(evidence["running_binary_identity"]["running_binary_sha256"] == binary_digest,
                        "Native cwd app differs from the frozen artifact")
            if scenario == "host-root":
                require(not evidence["first_database_password_changed"] and not evidence["first_caddy_configuration_changed"],
                        "Second native host directory modified the first installation")
                require(evidence["second_init_exit_code"] != 0 and not evidence["second_host_created"] and not evidence["second_unit_created"],
                        "Second native host directory was accepted on the same machine")
                require(evidence["owner_rejection_reported"], "Second native host failed without the specific ownership rejection")
                require(evidence["first_sentinel_rows"] == 1, "Second native host directory changed existing fixture data")
            if scenario in {"host-root", "remove-boundary"}:
                require(evidence["first_native_init"]["running_binary_identity"]["running_binary_sha256"] == binary_digest,
                        "Native contract app differs from the frozen artifact")
            if scenario == "remove-boundary":
                require(evidence["remove_exit_code"] != 0 and evidence["specific_rejection"],
                        "Native remove ignored an unsafe backup configuration")
                require(evidence["machine_owner_preserved"] and evidence["manifest_preserved"] and evidence["cluster_preserved"]
                        and evidence["sentinel_rows"] == 1 and evidence["configuration_fault_preserved"]
                        and evidence["app_unit_after"].get("ActiveState") == "active",
                        "Rejected native remove mutated protected runtime state")
                require(evidence["configuration_fault_removed"], "Native removal fault remained installed")
            certificate = guest.ssh(["sudo", "-n", "cat", "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"]).stdout.decode()
            Api(guest, certificate).ready()
            if scenario == "remove-boundary":
                report["native_remove"] = guest.action("remove", timeout=220)
            guest.assert_safe()
            report["checks"].append("native installation contract " + scenario)
            report["status"] = "passed"
            return
        if scenario == "cluster-routing":
            guest.phase = "native-cluster-routing"
            report["cluster_routing"] = guest.action("cluster-routing", timeout=800)
            evidence = report["cluster_routing"]
            require(not evidence["sentinel_password_changed"], "Native init changed an unrelated cluster password")
            require(evidence["init_exit_code"] != 0, "Native init accepted an unsupported cluster port layout")
            require(evidence["layout_rejection_reported"], "Native init failed without reporting the required layout guard")
            require(evidence["sentinel_rows"] == 1, "Native init modified unrelated sentinel data")
            require(not evidence["host_root_created"] and not evidence["native_postgres_configuration_written"],
                    "Native init wrote configuration before rejecting the cluster collision")
            report["checks"].append("native cluster port collision rejected before project/configuration or unrelated database changes")
            guest.assert_safe()
            report["status"] = "passed"
            return
        guest.phase = "native-init"
        report["native_init"] = guest.action("prepare", timeout=650)
        require(report["native_init"]["binary_sha256"] == json.loads((public / "predeclared-profile.json").read_text())["binary_sha256"], "Guest binary differs from frozen input")
        require(report["native_init"]["running_binary_identity"]["running_binary_sha256"] == binary_digest,
                "Actual running native app differs from the frozen input")
        certificate = guest.ssh(["sudo", "-n", "cat", "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"]).stdout.decode()
        require(len(certificate) <= 65536, "Native CA exceeded its bound")
        report["tls_ca_sha256"] = hashlib.sha256(certificate.encode()).hexdigest()
        api = Api(guest, certificate)
        api.ready()
        untrusted = Connection(guest.https_port, ssl.create_default_context())
        rejected = False
        try:
            untrusted.connect()
        except ssl.SSLCertVerificationError:
            rejected = True
        finally:
            untrusted.close()
        require(rejected, "Untrusted native Caddy CA was accepted")
        report["checks"].append("verified native HTTPS and rejection of an untrusted CA")
        guest.phase = "native-functional"
        second = guest.ssh(["sudo", "-n", "/usr/local/bin/nelcota", "-C", "/opt/g05-native", "init", "--local", "--project", "refused", "--yes"], check=False)
        require(second.returncode != 0, "Native second project was accepted")
        report["checks"].append("second native project refused")
        guest.phase = "native-signup"
        users = []
        password = secrets.token_urlsafe(32)
        for name in ["alice", "bob"]:
            users.append(signup(api, name + "@example.invalid", password))
        guest.phase = "native-functional"
        service = guest.action("token")
        require(re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", service), "Native service token output was not a JWT")
        api.request("POST", "/rest/v1/native_probe", token=users[0], value={"id": 1, "value": 1}, expected=(201,))
        require(json.loads(api.request("GET", "/rest/v1/native_probe?select=id", token=users[1])) == [], "Native RLS leaked another user's row")
        api.request("GET", "/rest/v1/native_probe", expected=(401,))
        report["checks"].append("native signup, two-user RLS isolation and anonymous rejection")
        if scenario == "clock-drift":
            guest.phase = "native-clock-drift"
            report["clock_drift"] = {}
            clock_probe(guest, api, users[0], service, report["clock_drift"])
            report["checks"].append("guest clock advance rejects expired access while service access remains valid; clock/NTP and ordinary access restored")
            guest.phase = "native-remove"
            report["native_remove"] = guest.action("remove", timeout=200)
            guest.assert_safe()
            report["status"] = "passed"
            return
        original = b"g05-native-before"
        api.request("POST", "/storage/v1/object/native/kept.bin", token=service, raw=original,
                    expected=(201,), headers={"Content-Type": "application/octet-stream"})
        require(api.request("GET", "/storage/v1/object/native/kept.bin", token=service) == original, "Native uploaded bytes differ")
        api.request("GET", "/storage/v1/object/native/kept.bin", expected=(404,))
        if scenario in PITR_SCENARIOS:
            from native_pitr_failure import PROFILE as PITR_PROFILE, helper_name
            guest.phase = "controlled-pitr-error"
            helper = helper_name(identity)
            arguments = []
            if scenario == "runtime-pitr-reboot":
                arguments = ["--defer-recovery"]
            helper_command = ["sudo", "-n", "systemd-run", "--quiet", "--wait", "--pipe", "--collect",
                             "--unit=" + helper, "--description=g05-pitr-error:" + identity,
                             "--slice=g05native.slice", "--property=CPUQuota=10%", "--property=CPUQuotaPeriodSec=100ms",
                             "--property=MemoryMax=96M", "--property=MemorySwapMax=0", "--property=TasksMax=32",
                             "--property=RuntimeMaxSec=120", "--property=TimeoutStopSec=5",
                             "--property=Nice=19", "--property=IOSchedulingClass=idle", "--property=KillMode=control-group",
                             "/usr/bin/python3", "/opt/g05-tools/native_pitr_failure.py", identity]
            raw = guest.ssh([*helper_command, *arguments], timeout=145).stdout
            require(len(raw) <= 65536, "Controlled PITR report exceeded its byte boundary")
            report["native_contract"] = json.loads(raw)
            control = report["native_contract"]
            if scenario == "runtime-pitr-reboot":
                from native_pitr_failure import BINARY, FLAG, SAVED, MARKER
                from native_pitr_reboot import observe as observe_boot, recover as recover_boot_fixture
                require(control.get("explicit_fixture_recovery_deferred") is True
                        and control.get("unknown_state_kept_stopped") is True,
                        "Immediate PITR fencing/deferred recovery was not reached before boot")
                # Establish a durable disposable installation before testing boot fencing.
                guest.ssh(["sudo", "-n", "sync"], timeout=30)
                guest.assert_safe()
                before_boot = guest.action("resources")["boot_id"]
                guest.phase = "pitr-error-guest-reboot"
                guest.ready = False
                guest.fault_until = time.monotonic() + 180
                report["power_cut_unit_state"] = stop_owned(identity, power_cut=True)
                guest.start()
                guest.ready = True
                guest.last_guest_sample = time.monotonic()
                require(guest.action("resources")["boot_id"] != before_boot,
                        "PITR boot control did not change the guest kernel boot")
                control["guest_boot_id_changed"] = True
                actual_adapter = guest.ssh(["sudo", "-n", "sha256sum", str(BINARY)]).stdout.decode().split()[0]
                require(actual_adapter == control["original_adapter_sha256"],
                        "Controlled package cleanup did not persist across boot")
                for path in [FLAG, SAVED, MARKER]:
                    guest.ssh(["sudo", "-n", "test", "!", "-e", str(path)])
                control["controlled_cleanup_persisted_across_boot"] = True
                guest.phase = "pitr-error-post-boot-observation"
                control["boot_observation"] = observe_boot(guest, api, users[0])
                guest.phase = "pitr-error-explicit-fixture-recovery"
                recover_boot_fixture(guest, helper_command, control)
            require(control.get("profile") == PITR_PROFILE and control.get("real_PG_files_modified") is False
                    and control.get("owned_marker_written_before_adapter_failure") is True
                    and control.get("controlled_adapter_and_flag_removed") is True
                    and control.get("fixture_rows_preserved") is True
                    and type(control.get("restore_exit_code")) is int and control["restore_exit_code"] != 0,
                    "Controlled native restore error or explicit fixture recovery was not verified")
            api.ready()
            require(api.request("GET", "/storage/v1/object/native/kept.bin", token=service) == original,
                    "PITR adapter control changed private fixture bytes")
            require(json.loads(api.request("GET", "/rest/v1/native_probe?select=id", token=users[1])) == [],
                    "PITR adapter control lost RLS isolation")
            api.request("GET", "/rest/v1/native_probe", expected=(401,))
            api.request("GET", "/storage/v1/object/native/kept.bin", expected=(404,))
            control["post_explicit_recovery_unauthorized_API_status"] = 401
            control["post_explicit_recovery_other_user_rows"] = 0
            control["post_explicit_recovery_private_file_status"] = 404
            if scenario == "runtime-pitr-reboot":
                guest.phase = "pitr-error-post-boot-verdict"
                require(control["boot_observation"].get("unknown_state_kept_stopped_after_boot") is True,
                        "Unknown native PITR recovery state reopened after guest boot")
                report["checks"].append("native restore-error fence survives owned guest RAM loss before any explicit fixture recovery")
            require(control.get("unknown_state_kept_stopped") is True,
                    "Unknown native restore error automatically reopened the project")
            report["checks"].append("controlled native restore adapter error stays closed; original executable, rows, private bytes and authorization recover explicitly")
            guest.phase = "native-remove"
            report["native_remove"] = guest.action("remove", timeout=200)
            guest.assert_safe()
            report["status"] = "passed"
            return
        guest.phase = "native-backup"
        backup = guest.action("backup", timeout=150)
        report["backup"] = {key: value for key, value in backup.items() if key != "dump"}
        api.request("POST", "/rest/v1/native_probe", token=users[0], value={"id": 2, "value": 2}, expected=(201,))
        api.request("PUT", "/storage/v1/object/native/kept.bin", token=service, raw=b"g05-native-after",
                    expected=(200,), headers={"Content-Type": "application/octet-stream"})
        guest.phase = "native-restore"
        restored = time.monotonic()
        guest.action("restore", "--dump", backup["dump"], timeout=200)
        api.ready()
        report["restore_elapsed_seconds"] = time.monotonic() - restored
        require(json.loads(api.request("GET", "/rest/v1/native_probe?select=id&order=id", token=users[0])) == [{"id": 1}], "Native restore did not produce its declared rewind")
        require(api.request("GET", "/storage/v1/object/native/kept.bin", token=service) == original, "Native restore lost matching immutable file bytes")
        report["checks"].append("native backup and same-target restore of matching database and file bytes; one intentional row rewind")
        guest.phase = "native-writer-before-power-cut"
        acknowledged = []
        load_began = time.monotonic()
        with (output / "acknowledged-operations.jsonl").open("x") as ledger:
            for operation in range(100, 130):
                before = time.monotonic()
                api.request("POST", "/rest/v1/native_probe", token=users[0], value={"id": operation, "value": operation}, expected=(201,))
                acknowledged.append(operation)
                ledger.write(json.dumps({"operation": operation, "acknowledged_monotonic": time.monotonic()}) + "\n")
                ledger.flush()
                os.fsync(ledger.fileno())
                time.sleep(max(0, 1 - (time.monotonic() - before)))
        report["completed_effective_load_seconds"] = min(30, time.monotonic() - load_began)
        before_boot = guest.action("resources")["boot_id"]
        guest.phase = "guest-power-cut"
        guest.ready = False
        guest.fault_until = time.monotonic() + 180
        fault_began = time.monotonic()
        if scenario == "runtime-inflight":
            from native_cut import BLOCKED_ID, capture, witness
            guest.ready = True
            arm = guest.action("inflight-arm", timeout=12)
            try:
                with ThreadPoolExecutor(max_workers=1) as pressure:
                    pending = pressure.submit(api.request, "POST", "/rest/v1/native_probe", token=users[0],
                                              value={"id": BLOCKED_ID, "value": BLOCKED_ID}, expected=(201,))
                    waiting_at = time.monotonic()
                    observed = None
                    observed_at = waiting_at
                    while time.monotonic() - waiting_at <= 3:
                        guest.assert_safe()
                        require(not pending.done(), "Controlled write completed before the cut witness")
                        observed, observed_at = capture(lambda: guest.action("inflight-status", timeout=8))
                        if observed == {"lockers": 1, "waiting_writes": 1, "helper_active": True}:
                            break
                        time.sleep(.025)
                    def before_cut_signal():
                        nonlocal fault_began
                        control = witness(observed, time.monotonic() - observed_at, pending.done())
                        report["in_flight_cut_control"] = {"arm": arm, "before_cut": control}
                        guest.ready = False
                        fault_began = time.monotonic()
                    report["power_cut_unit_state"] = stop_owned(identity, power_cut=True, before_signal=before_cut_signal)
                    require("in_flight_cut_control" in report, "Guest stopped before its actual cut witness")
                    disconnected = False
                    try:
                        pending.result(timeout=6)
                    except (OSError, http.client.HTTPException):
                        disconnected = True
                    require(disconnected, "Blocked write did not disconnect across the guest cut")
                    report["in_flight_cut_control"]["blocked_request_disconnected"] = True
            finally:
                if guest.ready:
                    guest.action("inflight-disarm", timeout=12)
        if scenario != "runtime-inflight":
            report["power_cut_unit_state"] = stop_owned(identity, power_cut=True)
        guest.start()
        guest.ready = True
        guest.last_guest_sample = time.monotonic()
        api.ready()
        report["guest_power_cut_recovery_seconds"] = time.monotonic() - fault_began
        after = guest.action("resources")
        recovered_identity = guest.action("identity")
        require(recovered_identity["running_binary_sha256"] == binary_digest,
                "Recovered native app differs from the frozen input")
        require(after["boot_id"] != before_boot, "Guest power cut did not produce a fresh kernel boot")
        actual = json.loads(api.request("GET", "/rest/v1/native_probe?select=id&order=id", token=users[0]))
        require([item["id"] for item in actual] == [1, *acknowledged], "Guest power cut lost or duplicated an externally acknowledged operation")
        require(api.request("GET", "/storage/v1/object/native/kept.bin", token=service) == original, "Guest power cut corrupted uploaded bytes")
        report["checks"].append("guest power cut: changed kernel boot, native boot activation and external acknowledgement reconciliation")
        report["power_cut_reconciliation"] = {"acknowledged": len(acknowledged), "missing": 0, "duplicate": 0,
                                               "extra": 0, "file_sha256": hashlib.sha256(original).hexdigest(),
                                               "running_binary_identity": recovered_identity,
                                               "fault_during_in_flight_write": False,
                                               "scope": "loss of guest RAM after completed durable acknowledgements; no host power loss claim"}
        if scenario == "runtime-inflight":
            from native_cut import reconcile
            values = json.loads(api.request("GET", "/rest/v1/native_probe?select=id,value&order=id", token=users[0]))
            result = reconcile(values, acknowledged)
            api.request("GET", "/rest/v1/native_probe", expected=(401,))
            require(json.loads(api.request("GET", "/rest/v1/native_probe?select=id", token=users[1])) == [],
                    "Recovered native runtime exposed another user's rows")
            api.request("GET", "/storage/v1/object/native/kept.bin", expected=(404,))
            after_lock = guest.action("inflight-status", timeout=8)
            require(after_lock == {"lockers": 0, "waiting_writes": 0, "helper_active": False},
                    "Interrupted native write or helper survived recovery")
            report["in_flight_cut_control"]["after_recovery"] = after_lock
            report["in_flight_cut_control"]["recovered_unauthorized_API_status"] = 401
            report["in_flight_cut_control"]["recovered_other_user_rows"] = 0
            report["in_flight_cut_control"]["recovered_unauthorized_private_file_status"] = 404
            report["power_cut_reconciliation"].update(result, fault_during_in_flight_write=True,
                scope="Loss of guest RAM with one observed table-lock-blocked unacknowledged write; thirty ACKs and row values retained, blocked write rolled back. No cut-during-COMMIT or physical host power-loss claim")
            report["checks"].append("external witness of one blocked write at guest cut; acknowledged row values survive and uncommitted write rolls back")
        guest.phase = "post-load-idle"
        for _ in range(6):
            guest.assert_safe()
            time.sleep(5)
        report["idle_resources"] = guest.action("resources")
        guest.phase = "native-remove"
        report["native_remove"] = guest.action("remove", timeout=200)
        guest.assert_safe()
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["failure"] = {"phase": guest.phase, "type": type(error).__name__, "reason": str(error)[:256]}
        if guest.ready:
            try:
                report["guest_diagnostics"] = guest.action("diagnostics", timeout=20)
            except Exception as diagnostic:
                report["diagnostic_failure_type"] = type(diagnostic).__name__
    finally:
        guest.stopped.set()
        guard.join(timeout=20)
        state = stop_owned(identity)
        clean = state.get("ActiveState") in {"inactive", "failed"} and state.get("MainPID", "0") == "0"
        if clean:
            (output / "watchdog-disarmed").touch()
        watcher.wait(timeout=15)
        report["elapsed_seconds_including_preparation"] = time.monotonic() - began
        report["resource_samples"] = guest.samples
        report["cleanup_confirmed"] = clean
        report["cleanup_scope"] = "owned QEMU service stopped; private guest disk/keys remain only on the disposable runner until its destruction"
        report["safety_guard_failure"] = guest.guard_failure
        if report.get("status") == "passed" and (not clean or guest.guard_failure is not None):
            report["status"] = "failed"
            report["failure"] = {"phase": "cleanup", "type": "RuntimeError", "reason": "Native cleanup or safety guard did not pass"}
        atomic_json(public / "native-vm.json", report)
        publication = output.with_name(output.name + "-public")
        publication.mkdir(mode=0o755)
        for path in public.iterdir():
            require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 16 * MIB,
                    "Native structured artifact exceeded its publication boundary")
            target = publication / path.name
            shutil.copyfile(path, target)
            target.chmod(0o644)
        publish(report)
        require(report.get("status") == "passed" and clean and guest.guard_failure is None, "Native VM acceptance failed; preserved structured evidence")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--watchdog", type=Path)
    parser.add_argument("--pass-index", type=int, choices=[1, 2])
    parser.add_argument("--scenario", choices=SCENARIOS, default="runtime")
    args = parser.parse_args()
    if args.watchdog is not None:
        watchdog(args.watchdog.resolve(strict=True))
        return
    require(args.binary is not None and args.output is not None, "Native VM requires a binary and fresh output directory")
    def stop(signum, frame):
        raise RuntimeError("Native VM controller received termination or its duration limit")
    for signum in [signal.SIGTERM, signal.SIGINT, signal.SIGALRM]:
        signal.signal(signum, stop)
    signal.setitimer(signal.ITIMER_REAL, MAXIMUM_SECONDS)
    campaign(args.binary.resolve(strict=True), args.output.resolve(), args.scenario, args.pass_index)


if __name__ == "__main__":
    main()
