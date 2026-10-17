#!/usr/bin/env python3
"""Measure owned RustFS runtime workers separately from ordinary G05 campaigns.

Three fresh fixtures vary one public runtime setting at a time. Small signed
PUT/GET/DELETE bursts verify bytes, then observe ten minutes without traffic.
OS owners and allocator gauges do not establish exact live heap ownership.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

from campaign import docker
from host_resources import owned_cgroup_snapshot, require_no_oom
from native_preflight import inventory
from objects import S3Inventory
from ownership import LABEL, OwnedDocker
from ports import published_port
from provider_capabilities import IMAGE, IMAGE_ID, Receiver, allocator_capabilities, controller_budget, network_bytes, require
from watchdog import atomic_json, cleanup, host_reserves, process_identity

ROOT = Path(__file__).resolve().parents[1]
MAXIMUM_SECONDS = 3600
PROFILES = {
    "default": {},
    "runtime-workers": {"RUSTFS_RUNTIME_WORKER_THREADS": "4"},
    "fsync-workers": {"RUSTFS_RUNTIME_FSYNC_BLOCKING_THREADS": "4"},
}
RUNTIME_KEYS = {"RUSTFS_RUNTIME_WORKER_THREADS", "RUSTFS_RUNTIME_FSYNC_BLOCKING_THREADS",
                "RUSTFS_RUNTIME_MAX_BLOCKING_THREADS"}
ALLOCATOR_GAUGES = {"rustfs_memory_allocator_reserved_bytes", "rustfs_memory_allocator_committed_bytes",
                    "rustfs_memory_allocator_page_committed_bytes"}
PROFILE = {"provider_cpus": .5, "provider_memory_mib": 1024, "provider_pids": 256,
           "data_mib": 512, "writable_layer_mib": 512, "concurrency": 16, "bursts": 60,
           "burst_interval_seconds": 3, "pressure_seconds": 180, "idle_seconds": 600,
           "payload_bytes": 64, "maximum_signed_requests_per_case": 4096, "sample_seconds": 5,
           "maximum_fd_observation_entries": 4096, "maximum_resource_samples_per_case": 200,
           "maximum_telemetry_exports_per_case": 256, "maximum_telemetry_wire_bytes_per_case": 16 * 1024 ** 2,
           "maximum_observation_gap_seconds": 30, "maximum_case_seconds": 1080,
           "maximum_total_seconds": MAXIMUM_SECONDS, "maximum_network_bytes": 4 * 1024 ** 3,
           "host_memory_reserve_fraction": .1, "host_disk_inode_reserve_fraction": .15}
PUBLIC_FIELDS = {"identity", "source", "status", "certifies_g05", "scope", "image", "image_id", "profile",
                 "controller_kernel_budget", "cpu_affinity", "cases", "cleanup_confirmed", "elapsed_seconds",
                 "completed_effective_baas_load_seconds", "heap_ownership_status", "failure"}
CASE_FIELDS = {"name", "status", "overrides", "snapshots", "requests_attempted", "requests_completed", "verified_operations",
               "unauthorized_collector_status", "container_runtime_environment", "unauthorized_provider_status",
               "physical_inventory", "failure", "exports_received", "allocator_capabilities", "resource_samples",
               "telemetry_wire_bytes", "telemetry_failure",
               "allocator_first_observation", "allocator_last_observation",
               "maximum_gap_seconds", "peaks", "resource_series_sha256", "resource_violations", "cleanup_confirmed",
               "cleanup_errors", "elapsed_seconds", "measured_pressure_seconds", "measured_idle_seconds", "heap_ownership_status"}


def overrides(name):
    require(name in PROFILES, "Unknown bounded provider runtime profile")
    return dict(PROFILES[name])


class Client(S3Inventory):
    """Reuse the ordinary small-object signer with a shared fail-closed budget."""
    def __init__(self, endpoint, access, secret, bucket, stopped):
        super().__init__(endpoint, access, secret, bucket)
        self.lock, self.stopped = threading.Lock(), stopped
        self.attempted = self.completed = 0

    def send(self, parameters, method="GET", key=None, body=None):
        require(method in {"GET", "PUT", "DELETE", "HEAD"}, "Unexpected direct provider method")
        require(not self.stopped.is_set(), "Provider traffic stopped by a guard")
        with self.lock:
            require(self.attempted < PROFILE["maximum_signed_requests_per_case"], "Provider request ceiling reached")
            self.attempted += 1
        try:
            result = super().send(parameters, method=method, key=key, body=body)
        except urllib.error.HTTPError as error:
            error.close()
            raise
        with self.lock:
            self.completed += 1
        return result


def transfer(client, payload, stopped):
    """Stop all new provider traffic as soon as a byte/HTTP check fails."""
    try:
        key = "bench/" + str(uuid.uuid4())
        expected = hashlib.sha512(payload + key.encode("ascii")).digest()
        client.send({}, method="PUT", key=key, body=expected)
        body = client.send({}, key=key)
        require(body == expected, "Provider returned different object bytes")
        client.send({}, method="DELETE", key=key)
        return True
    except BaseException:
        stopped.set()
        raise


def process_owners(pid, generation):
    require(process_identity(pid) == generation, "Provider PID generation changed")
    root = Path(f"/proc/{pid}")
    before = set((root / "task").iterdir())
    require(0 < len(before) <= PROFILE["provider_pids"], "Provider process exceeded its thread boundary")
    names = {"rustfs": 0, "tokio": 0, "rayon": 0, "other": 0}
    races = 0
    for task in before:
        try:
            name = (task / "comm").read_text().strip()
        except FileNotFoundError:
            races += 1
            continue
        category = "other"
        for prefix in ["rustfs", "tokio", "rayon"]:
            if name.startswith(prefix):
                category = prefix
                break
        names[category] += 1
    after = set((root / "task").iterdir())
    descriptors = list((root / "fd").iterdir())
    require(len(descriptors) <= PROFILE["maximum_fd_observation_entries"], "Provider descriptor evidence exceeded its boundary")
    sockets = 0
    for descriptor in descriptors:
        try:
            sockets += os.readlink(descriptor).startswith("socket:[")
        except FileNotFoundError:
            races += 1
    require(process_identity(pid) == generation, "Provider changed while observing its owners")
    return {"process_threads": len(after), "thread_categories": names,
            "thread_census_stable": before == after and races == 0,
            "descriptors": len(descriptors), "sockets": sockets, "observed_entry_races": races}


def runtime_environment(configuration):
    result = {}
    for entry in configuration:
        name, separator, value = entry.partition("=")
        if name not in RUNTIME_KEYS:
            continue
        if separator == "=" and value == "":
            result[name] = None
            continue
        require(separator == "=" and value.isdigit() and 1 <= int(value) <= 1024, "Invalid runtime worker evidence")
        result[name] = int(value)
    return result


def allocator_observation(snapshot):
    if snapshot is None:
        return None
    observed = snapshot["observed_monotonic"]
    require(type(observed) in {int, float} and math.isfinite(observed) and observed >= 0, "Invalid allocator observation time")
    gauges = {}
    for point in snapshot["points"]:
        if point["name"] not in ALLOCATOR_GAUGES or point["kind"] != "gauge" or point["available"] is not True:
            continue
        value = point["value"]
        require(type(value) in {int, float} and math.isfinite(value) and 0 <= value <= 2 ** 53,
                "Invalid allocator gauge value")
        require(point["name"] not in gauges, "Ambiguous duplicate allocator gauge")
        gauges[point["name"]] = value
    return {"observed_monotonic": observed, "gauges_bytes": gauges}


def require_telemetry(receiver):
    with receiver.lock:
        last = allocator_observation(receiver.last)
        require(receiver.exports >= 3 and last is not None, "Missing repeated allocator observations")
        require(0 <= time.monotonic() - last["observed_monotonic"] <= 15
                and set(last["gauges_bytes"]) == ALLOCATOR_GAUGES, "Missing fresh complete allocator gauges")


def retain_receiver_evidence(receiver, report, directory, errors):
    """Malformed observations must fail the case without bypassing fixture cleanup."""
    try:
        with receiver.lock:
            report.update(exports_received=receiver.exports, telemetry_wire_bytes=receiver.received,
                          allocator_capabilities=allocator_capabilities((receiver.last or {}).get("points", [])))
            report["allocator_first_observation"] = allocator_observation(receiver.first)
            report["allocator_last_observation"] = allocator_observation(receiver.last)
            report["telemetry_failure"] = None
            if receiver.failure is not None:
                atomic_json(directory / "telemetry-failure.private.json", receiver.failure)
                category = "validation_or_transport"
                if receiver.failure.get("reason") == "Provider telemetry exceeded its cumulative budget":
                    category = "cumulative_budget"
                report["telemetry_failure"] = {"type": receiver.failure["type"], "category": category}
    except Exception as error:
        report["status"] = "failed"
        errors.append("telemetry_evidence_" + type(error).__name__)


def public_payload(report):
    require(isinstance(report, dict) and not set(report) - PUBLIC_FIELDS, "Unknown provider runtime public field")
    require(re.fullmatch(r"native-provider-runtime-[0-9]+-[0-9]+", report.get("identity", "")) is not None
            and re.fullmatch(r"[0-9a-f]{40}", report.get("source", "")) is not None,
            "Missing immutable provider runtime identity")
    require(report.get("certifies_g05") is False and report.get("status") in {"passed", "failed"}
            and type(report.get("cleanup_confirmed")) is bool, "Missing scoped runtime verdict")
    cases = report.get("cases", [])
    require(isinstance(cases, list) and len(cases) <= len(PROFILES), "Unexpected runtime case cardinality")
    for row in cases:
        require(isinstance(row, dict) and not set(row) - CASE_FIELDS and row.get("name") in PROFILES,
                "Unknown provider runtime case field")
    require(len({row["name"] for row in cases}) == len(cases), "Duplicate provider runtime case identity")
    if report["status"] == "passed":
        require(report["cleanup_confirmed"] is True and len(cases) == len(PROFILES)
                and {row.get("name") for row in cases} == set(PROFILES), "Passing runtime verdict lacks all independent cases")
        for row in cases:
            require(row.get("status") == "passed" and row.get("cleanup_confirmed") is True
                    and row.get("verified_operations") == PROFILE["bursts"] * PROFILE["concurrency"]
                    and row.get("resource_samples", 0) >= 2 and 0 <= row.get("maximum_gap_seconds", 31) <= 30
                    and row.get("measured_pressure_seconds", -1) >= PROFILE["pressure_seconds"]
                    and row.get("measured_idle_seconds", -1) >= PROFILE["idle_seconds"],
                    "Passing runtime verdict lacks complete operation/resource evidence")
    raw = json.dumps(report, separators=(",", ":"), allow_nan=False).encode()
    require(len(raw) <= 65536, "Provider runtime public evidence exceeded its byte ceiling")
    return raw


def publish(directory, report):
    raw = public_payload(report)
    digest = hashlib.sha256(raw).hexdigest()
    encoded = base64.b64encode(gzip.compress(raw, mtime=0)).decode()
    parts = [encoded[index:index + 3000] for index in range(0, len(encoded), 3000)]
    require(len(parts) <= 9, "Provider runtime notice exceeded its annotation budget")
    directory.mkdir(mode=0o755)
    path = directory / "provider-runtime.json"
    atomic_json(path, report)
    path.chmod(0o644)
    summary = {key: report[key] for key in ["identity", "source", "status", "cleanup_confirmed"]}
    summary["report_sha256"] = digest
    notices = [("Provider runtime summary", summary)]
    notices.extend(("Provider runtime evidence", {"part": index, "parts": len(parts), "sha256": digest,
                                                  "encoding": "gzip+base64", "payload": content})
                   for index, content in enumerate(parts, 1))
    for title, value in notices:
        text = json.dumps(value, separators=(",", ":"), allow_nan=False).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        require(len(text.encode()) <= 3900, "Provider runtime notice exceeded its byte ceiling")
        print("::notice title=" + title + "::" + text, flush=True)


def case(name, identity, output, provider_cpu, deadline, initial_network):
    directory = output / name
    directory.mkdir(mode=0o700)
    server, volume = identity + "-" + name, identity + "-" + name + "-data"
    owned = OwnedDocker(identity, docker)
    began, resource_at = time.monotonic(), time.monotonic()
    manifest = {"identity": identity, "pid": os.getpid(), "process_identity": process_identity(os.getpid()),
                "output": str(directory), "reserve_path": str(directory), "started_monotonic": began,
                "maximum_seconds": PROFILE["maximum_case_seconds"], "preparation_seconds": 150,
                "containers": [server], "volumes": [volume]}
    atomic_json(directory / "ownership.json", manifest)
    phase, stage = "preparation", "receiver"
    stopped, heartbeat_stop, sampler_stop, first_sample = [threading.Event() for _ in range(4)]
    observations, violations = [], []
    report = {"name": name, "status": "failed", "overrides": overrides(name), "snapshots": [],
              "requests_attempted": 0, "requests_completed": 0, "verified_operations": 0}
    receiver = receiver_thread = sampler = client = None

    def heartbeat():
        while not heartbeat_stop.is_set():
            atomic_json(directory / "heartbeat.json", {"phase": phase, "monotonic": time.monotonic(), "resource_monotonic": resource_at})
            heartbeat_stop.wait(2)
    heart = threading.Thread(target=heartbeat, daemon=True)
    heart.start()
    watcher = subprocess.Popen([sys.executable, str(Path(__file__).with_name("watchdog.py")), str(directory / "ownership.json")],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    previous = signal.getsignal(signal.SIGTERM)
    def terminate(signum, frame):
        stopped.set()
        raise RuntimeError("Owned provider runtime case terminated")
    signal.signal(signal.SIGTERM, terminate)

    def require_running():
        require(not stopped.is_set() and watcher.poll() is None and not violations,
                "Provider runtime observer or watchdog failed")
        require(time.monotonic() < deadline and time.monotonic() - began < PROFILE["maximum_case_seconds"],
                "Provider runtime duration reached its ceiling")

    def wait(seconds):
        require_running()
        require(not stopped.wait(max(0, seconds)), "Provider runtime traffic stopped")
        require_running()

    def retain_snapshot(label):
        require_running()
        require(observations and time.monotonic() - observations[-1]["monotonic"] <= 30,
                "No fresh provider observation for the phase boundary")
        report["snapshots"].append({"label": label, **observations[-1]})

    try:
        require(host_reserves(directory) is None, "Provider runtime host reserve failed")
        gateways = [x["Gateway"] for x in json.loads(docker("network", "inspect", "bridge"))[0]["IPAM"]["Config"] if "Gateway" in x]
        require(len(gateways) == 1 and ipaddress.ip_address(gateways[0]).version == 4
                and ipaddress.ip_address(gateways[0]).is_private, "Missing private telemetry bridge")
        token = secrets.token_hex(32)
        receiver = Receiver((gateways[0], 0), token,
                            maximum_exports=PROFILE["maximum_telemetry_exports_per_case"],
                            maximum_wire_bytes=PROFILE["maximum_telemetry_wire_bytes_per_case"])
        receiver_thread = threading.Thread(target=receiver.serve_forever, daemon=True)
        receiver_thread.start()
        endpoint = "http://" + gateways[0] + ":" + str(receiver.server_address[1])
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        denied = None
        try:
            with opener.open(urllib.request.Request(endpoint + "/v1/metrics", data=b"", method="POST"), timeout=5):
                pass
        except urllib.error.HTTPError as error:
            denied = error.code
            error.close()
        require(denied == 403, "Telemetry receiver accepted an unauthorized probe")
        report["unauthorized_collector_status"] = denied
        access, secret = secrets.token_hex(16), secrets.token_hex(32)
        environment = {"RUSTFS_ACCESS_KEY": access, "RUSTFS_SECRET_KEY": secret, "RUSTFS_CONSOLE_ENABLE": "false",
                       "RUSTFS_OBS_ENDPOINT": endpoint, "RUSTFS_OBS_METRIC_ENDPOINT": endpoint + "/v1/metrics",
                       "RUSTFS_OBS_METRICS_EXPORT_ENABLED": "true", "RUSTFS_OBS_ENDPOINT_HEADERS": "x-g05-probe=" + token,
                       "RUSTFS_OBS_ENDPOINT_METRICS_HEADERS": "x-g05-probe=" + token,
                       "RUSTFS_OBS_TRACES_EXPORT_ENABLED": "false", "RUSTFS_OBS_LOGS_EXPORT_ENABLED": "false",
                       "RUSTFS_OBS_PROFILING_EXPORT_ENABLED": "false", "RUSTFS_OBS_USE_STDOUT": "false",
                       "RUSTFS_MEMORY_OBSERVABILITY_INTERVAL_SECS": "5", "RUSTFS_OBS_METER_INTERVAL": "5", **overrides(name)}
        flags = []
        for key in environment:
            flags.extend(["-e", key])
        stage = "provider-startup"
        owned("volume", "create", "--label", LABEL + "=" + identity, volume)
        owned("run", "-d", "--name", server, "--label", LABEL + "=" + identity, "--cpus", ".5", "--cpuset-cpus", str(provider_cpu),
              "--memory", "1024m", "--memory-swap", "1024m", "--pids-limit", "256", "--cap-drop", "ALL",
              "--security-opt", "no-new-privileges", "-p", "127.0.0.1::9000", "--mount",
              "type=volume,source=" + volume + ",destination=/data", *flags, IMAGE, env=environment)
        state = json.loads(owned("inspect", server))[0]
        port = published_port(owned, server, 9000, int(state["NetworkSettings"]["Ports"]["9000/tcp"][0]["HostPort"]))
        receiver.peer = state["NetworkSettings"]["Networks"]["bridge"]["IPAddress"]
        require(ipaddress.ip_address(receiver.peer).version == 4 and ipaddress.ip_address(receiver.peer).is_private,
                "Provider telemetry peer escaped the private bridge")
        report["container_runtime_environment"] = runtime_environment(state["Config"]["Env"])
        require(all(report["container_runtime_environment"].get(k) == int(v) for k, v in overrides(name).items()),
                "Container lacks the requested runtime setting")
        client = Client("http://127.0.0.1:" + str(port), access, secret, "g05-runtime-" + secrets.token_hex(8), stopped)
        ready = False
        for _ in range(80):
            require_running()
            try:
                client.send({}, method="PUT")
                ready = True
            except (OSError, urllib.error.URLError):
                pass
            if ready:
                break
            wait(.25)
        require(ready, "Provider did not become ready for signed work")
        denied = None
        try:
            with opener.open(client.endpoint + client.path, timeout=5):
                pass
        except urllib.error.HTTPError as error:
            denied = error.code
            error.close()
        require(denied == 403, "Provider accepted an unsigned private-bucket request")
        report["unauthorized_provider_status"] = denied
        host_pid, generation, started_at = state["State"]["Pid"], process_identity(state["State"]["Pid"]), state["State"]["StartedAt"]
        require(type(host_pid) is int and host_pid > 1 and isinstance(generation, str) and generation.isdigit(),
                "Missing provider process identity")

        def observe():
            nonlocal resource_at
            while not sampler_stop.is_set():
                cycle = time.monotonic()
                step = "owner-watchdog"
                try:
                    require_running()
                    step = "host-network-reserve"
                    require(host_reserves(directory) is None and network_bytes() - initial_network <= PROFILE["maximum_network_bytes"],
                            "Provider runtime reached a host/network reserve")
                    step = "provider-identity"
                    state = json.loads(owned("inspect", "--size", server))[0]
                    require(state["State"]["Running"] and not state["State"]["OOMKilled"] and state["RestartCount"] == 0
                            and state["State"]["Pid"] == host_pid and state["State"]["StartedAt"] == started_at,
                            "Provider unexpectedly restarted or changed process")
                    step = "kernel-budget"
                    values = owned_cgroup_snapshot(owned, server)
                    require_no_oom(values["memory.events"])
                    require(values["memory.max"] == 1024 ** 3 and values["pids.max"] == 256
                            and values["cpu.max"]["quota_usec"] * 2 == values["cpu.max"]["period_usec"],
                            "Provider kernel budget changed")
                    step = "data-disk-budget"
                    disk = int(owned("exec", server, "du", "-sk", "/data").split()[0]) * 1024
                    require(disk <= 512 * 1024 ** 2 and state["SizeRw"] <= 512 * 1024 ** 2, "Provider disk budget reached")
                    step = "telemetry"
                    require(receiver.failure is None, "Provider telemetry export failed")
                    step = "observation-gap"
                    now = time.monotonic()
                    if observations:
                        require(now - observations[-1]["monotonic"] <= 30, "Provider observation gap exceeded thirty seconds")
                    step = "process-owners"
                    row = {"monotonic": now, "elapsed_seconds": now - began, "phase": phase,
                           "memory_current_bytes": values["memory.current"], "memory_peak_bytes": values["memory.peak"],
                           "anonymous_bytes": values["memory.stat"]["anon"], "file_bytes": values["memory.stat"]["file"],
                           "cgroup_tasks": values["pids.current"], "data_bytes": disk, "writable_layer_bytes": state["SizeRw"],
                           "oom_events": values["memory.events"]["oom"], "oom_kills": values["memory.events"]["oom_kill"],
                           "owners": process_owners(host_pid, generation)}
                    step = "resource-write"
                    require(len(observations) < PROFILE["maximum_resource_samples_per_case"], "Provider observation count exceeded its budget")
                    with (directory / "resources.jsonl").open("a") as stream:
                        stream.write(json.dumps(row, allow_nan=False) + "\n")
                    observations.append(row)
                    resource_at = now
                    first_sample.set()
                except Exception as error:
                    violations.append({"type": type(error).__name__, "phase": phase, "step": step})
                    stopped.set()
                    return
                sampler_stop.wait(max(0, 5 - (time.monotonic() - cycle)))
        sampler = threading.Thread(target=observe, daemon=True)
        sampler.start()
        require(first_sample.wait(15), "Provider sampler did not start")
        retain_snapshot("before-pressure")
        payload = secrets.token_bytes(PROFILE["payload_bytes"])

        phase, stage = "pressure", "signed-put-get-delete"
        pressure_at = time.monotonic()
        with ThreadPoolExecutor(max_workers=16) as workers:
            try:
                for burst in range(PROFILE["bursts"]):
                    target = pressure_at + burst * PROFILE["burst_interval_seconds"]
                    wait(target - time.monotonic())
                    require(time.monotonic() <= target + 3, "Provider could not deliver its declared burst schedule")
                    futures = [workers.submit(transfer, client, payload, stopped) for _ in range(PROFILE["concurrency"])]
                    for future in futures:
                        require(future.result(timeout=15) is True, "Provider object operation did not complete")
                        report["verified_operations"] += 1
                wait(pressure_at + PROFILE["pressure_seconds"] - time.monotonic())
            except BaseException:
                stopped.set()
                raise
        report["measured_pressure_seconds"] = time.monotonic() - pressure_at
        retain_snapshot("after-pressure")
        phase, stage = "post-load-idle", "owner-release-observation"
        idle_at = time.monotonic()
        for seconds in [60, 180, 360, 600]:
            wait(idle_at + seconds - time.monotonic())
            retain_snapshot("idle-" + str(seconds))
        report["measured_idle_seconds"] = time.monotonic() - idle_at
        stage = "telemetry-completeness"
        require_telemetry(receiver)
        stage = "final-provider-inventory"
        physical = client.inventory()
        require(not physical["keys"] and physical["bytes"] == 0 and physical["multipart_uploads"] == 0,
                "Provider API retained objects or multipart state")
        require_running()
        report["physical_inventory"] = {"objects": 0, "bytes": 0, "multipart_uploads": 0}
        report["status"] = "passed"
    except Exception as error:
        stopped.set()
        report["failure"] = {"stage": stage, "phase": phase, "type": type(error).__name__}
    finally:
        phase = "teardown"
        sampler_stop.set()
        errors = []
        if sampler is not None:
            sampler.join(timeout=15)
            if sampler.is_alive():
                errors.append("sampler_join_timeout")
        if client is not None:
            report.update(requests_attempted=client.attempted, requests_completed=client.completed)
        if receiver is not None:
            for action in [receiver.shutdown, receiver.server_close]:
                try:
                    action()
                except Exception as error:
                    errors.append("receiver_cleanup_" + type(error).__name__)
            if receiver_thread is not None:
                receiver_thread.join(timeout=10)
                if receiver_thread.is_alive():
                    errors.append("receiver_join_timeout")
            retain_receiver_evidence(receiver, report, directory, errors)
        if observations:
            report["resource_samples"] = len(observations)
            report["maximum_gap_seconds"] = max([b["monotonic"] - a["monotonic"] for a, b in zip(observations, observations[1:])], default=0)
            report["peaks"] = {key: max(row[key] for row in observations) for key in ["memory_current_bytes", "memory_peak_bytes",
                              "anonymous_bytes", "cgroup_tasks", "data_bytes", "writable_layer_bytes"]}
            report["resource_series_sha256"] = hashlib.sha256((directory / "resources.jsonl").read_bytes()).hexdigest()
        report["resource_violations"] = violations
        clean = False
        try:
            cleanup(manifest)
            clean = not docker("ps", "-aq", "--filter", "label=" + LABEL + "=" + identity, "--filter", "name=" + server) and not docker("volume", "ls", "-q", "--filter", "label=" + LABEL + "=" + identity, "--filter", "name=" + volume)
        except Exception as error:
            errors.append("fixture_cleanup_" + type(error).__name__)
        report["cleanup_confirmed"] = clean
        if clean:
            (directory / "watchdog-disarmed").touch()
            try:
                watcher.wait(timeout=15)
            except subprocess.TimeoutExpired:
                errors.append("watchdog_join_timeout")
                watcher.terminate()
                watcher.wait(timeout=5)
        if not clean or errors or violations:
            report["status"] = "failed"
        report["cleanup_errors"] = errors
        heartbeat_stop.set()
        heart.join(timeout=5)
        if heart.is_alive():
            report["status"] = "failed"
            report["cleanup_errors"].append("heartbeat_join_timeout")
        signal.signal(signal.SIGTERM, previous)
        report["elapsed_seconds"] = time.monotonic() - began
        report["heap_ownership_status"] = "not verified; no live-byte or cache attribution inferred"
        atomic_json(directory / "result.json", report)
    return report


def main():
    available = inventory()
    require(os.geteuid() == 0 and available["cpu_affinity_slots"] >= 4, "Runtime probe needs its disposable four-CPU Actions VM")
    require(subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, timeout=10).strip() == available["source"],
            "Provider runtime checkout differs from its workflow source")
    require(not docker("ps", "-aq"), "Refuse provider runtime control on a Docker host with existing containers")
    run, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch(r"[0-9]{1,20}", run) is not None and re.fullmatch(r"[0-9]{1,4}", attempt) is not None,
            "Missing immutable runtime workflow identity")
    budget = controller_budget("runtime-" + run + "-" + attempt)
    cpus = sorted(os.sched_getaffinity(0))
    os.sched_setaffinity(0, {cpus[0]})
    identity = "native-provider-runtime-" + run + "-" + attempt
    output = ROOT / "target/stress-g05" / identity
    public = output.with_name(output.name + "-public")
    require(not output.exists() and not public.exists(), "Preserve previous provider runtime evidence")
    output.mkdir(mode=0o700, parents=True)
    began, initial_network = time.monotonic(), network_bytes()
    report = {"identity": identity, "source": available["source"], "status": "failed", "certifies_g05": False,
              "scope": __doc__, "image": IMAGE, "controller_kernel_budget": budget, "cpu_affinity": cpus[:2],
              "profile": PROFILE, "cases": [], "completed_effective_baas_load_seconds": 0,
              "heap_ownership_status": "not verified; OS owner/gauge diagnostic only", "cleanup_confirmed": False}
    all_owned = {"identity": identity, "containers": [identity + "-" + name for name in PROFILES],
                 "volumes": [identity + "-" + name + "-data" for name in PROFILES]}
    atomic_json(output / "predeclared-profile.json", report)
    try:
        require(host_reserves(output) is None, "Provider runtime host reserve failed")
        docker("pull", IMAGE)
        image = json.loads(docker("image", "inspect", IMAGE))[0]
        require(image["Id"] == IMAGE_ID and image["Size"] <= 512 * 1024 ** 2, "Runtime provider image differs from the declared artifact")
        report["image_id"] = image["Id"]
        for name in PROFILES:
            result = case(name, identity, output, cpus[1], began + MAXIMUM_SECONDS, initial_network)
            report["cases"].append(result)
            require(result["cleanup_confirmed"] and not result["cleanup_errors"], "Provider runtime cleanup failed; stop independent cases")
            require(result["status"] == "passed", "Provider runtime case failed; investigate before offering more traffic")
        report["cleanup_confirmed"] = not docker("ps", "-aq", "--filter", "label=" + LABEL + "=" + identity) and not docker("volume", "ls", "-q", "--filter", "label=" + LABEL + "=" + identity)
        require(report["cleanup_confirmed"], "Provider runtime retained an owned resource after its cases")
        if all(row["status"] == "passed" for row in report["cases"]):
            report["status"] = "passed"
    except Exception as error:
        report["failure"] = {"type": type(error).__name__}
    finally:
        try:
            cleanup(all_owned)
            report["cleanup_confirmed"] = not docker("ps", "-aq", "--filter", "label=" + LABEL + "=" + identity) and not docker("volume", "ls", "-q", "--filter", "label=" + LABEL + "=" + identity)
        except Exception as error:
            report["cleanup_confirmed"] = False
            report.setdefault("failure", {"type": type(error).__name__})
        if not report["cleanup_confirmed"]:
            report["status"] = "failed"
        report["elapsed_seconds"] = time.monotonic() - began
        publish(public, report)
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("::notice title=Provider runtime bootstrap failure::" + json.dumps({"type": type(error).__name__}), flush=True)
        raise SystemExit(1)
