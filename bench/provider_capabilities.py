#!/usr/bin/env python3
"""Discover allocator telemetry from the exact provider on a disposable Actions VM.

No BaaS workload runs here. Observed gauges do not establish live-owner release
or explain historical anonymous memory. Only the owned provider can export to
the private bridge listener; labels and payloads never enter public evidence.
"""

import base64
import gzip
import hashlib
import hmac
import http.server
import ipaddress
import json
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

from campaign import docker
from host_resources import owned_cgroup_snapshot, require_no_oom
from native_preflight import inventory
from otlp_metrics import MAX_BODY, memory_points
from ownership import LABEL, OwnedDocker
from watchdog import atomic_json, cleanup, host_reserves, process_identity

IMAGE = "rustfs/rustfs@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c"
IMAGE_ID = "sha256:f6b22807f10db2aee80b8a9ed1e36bd12c2fba25ac2d98dc3b0332a23f1a5c4d"
MAXIMUM_SECONDS = 300
ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FIELDS = {"identity", "source", "certifies_g05", "status", "scope", "controller_kernel_budget", "resource_samples",
                 "profile", "image", "image_id", "heap_ownership_status", "completed_effective_load_seconds",
                 "collector_unauthorized_probe_status", "exports_received", "telemetry_wire_bytes", "first_memory_export",
                 "last_memory_export", "resource_peaks", "allocator_numeric_points", "blocker", "failure",
                 "cleanup_confirmed", "cleanup_errors", "elapsed_seconds_including_preparation", "telemetry_failure"}
PUBLIC_FIELDS.add("allocator_capabilities")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class Receiver(http.server.ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, address, token, *, maximum_exports=128, maximum_wire_bytes=16 * 1024 ** 2):
        require(type(maximum_exports) is int and 1 <= maximum_exports <= 256,
                "Invalid bounded telemetry export count")
        require(type(maximum_wire_bytes) is int and 1 <= maximum_wire_bytes <= 16 * 1024 ** 2,
                "Invalid bounded telemetry wire bytes")
        self.token, self.peer = token, None
        self.maximum_exports, self.maximum_wire_bytes = maximum_exports, maximum_wire_bytes
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(2)
        self.exports = self.received = 0
        self.first, self.last = None, None
        self.failure = None
        super().__init__(address, Handler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *arguments):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def do_POST(self):
        server = self.server
        tokens = self.headers.get_all("X-G05-Probe") or []
        if self.client_address[0] != server.peer or len(tokens) != 1 or len(tokens[0]) > 128 or not tokens[0].isascii() or not hmac.compare_digest(tokens[0], server.token):
            self.send_error(403)
            return
        try:
            require(self.path == "/v1/metrics", "Unexpected telemetry path")
            lengths = self.headers.get_all("Content-Length") or []
            require(len(lengths) == 1 and self.headers.get("Transfer-Encoding") is None,
                    "Ambiguous or streaming telemetry length")
            length = lengths[0]
            require(re.fullmatch(r"[0-9]{1,8}", length) is not None and int(length) <= MAX_BODY,
                    "Provider telemetry request exceeded its byte budget")
            require(self.headers.get("Content-Type", "").split(";", 1)[0] == "application/x-protobuf",
                    "Unsupported telemetry content type")
            body = self.rfile.read(int(length))
            require(len(body) == int(length), "Truncated telemetry request")
            points = memory_points(body, self.headers.get("Content-Encoding", ""))
            require(len(points) <= 64, "Provider memory inventory exceeded its 64-point report budget")
            observation = {"observed_monotonic": time.monotonic(), "points": points}
            with server.lock:
                require(server.exports < server.maximum_exports and server.received + len(body) <= server.maximum_wire_bytes,
                        "Provider telemetry exceeded its cumulative budget")
                server.exports += 1
                server.received += len(body)
                if server.first is None:
                    server.first = observation
                server.last = observation
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
        except Exception as error:
            with server.lock:
                server.failure = {"type": type(error).__name__}
                if type(error) in {ValueError, RuntimeError}:
                    server.failure["reason"] = str(error)[:160]
            self.send_error(400)


def network_bytes():
    total = 0
    for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
        name, raw = line.split(":", 1)
        if name.strip() == "lo":
            continue
        fields = raw.split()
        total += int(fields[0]) + int(fields[8])
    return total


def controller_budget(identity):
    relative = next(line.split(":", 2)[2] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    root = Path("/sys/fs/cgroup").resolve()
    path = (root / relative.lstrip("/")).resolve(strict=True)
    require(path.is_relative_to(root) and "g05-provider-" + identity + ".service" in path.parts,
            "Provider controller must run inside its owned bounded systemd unit")
    quota, period = (path / "cpu.max").read_text().split()
    memory, swap, tasks = [(path / name).read_text().strip() for name in ["memory.max", "memory.swap.max", "pids.max"]]
    require(quota.isdigit() and int(quota) * 2 == int(period) and memory == str(256 * 1024 ** 2)
            and swap == "0" and tasks == "128", "Controller kernel budget differs from the declared profile")
    return {"cpu_quota_usec": int(quota), "cpu_period_usec": int(period), "memory_bytes": int(memory), "swap_bytes": 0, "pids": 128}


def public_payload(report):
    require(isinstance(report, dict) and not set(report) - PUBLIC_FIELDS, "Unknown provider evidence field")
    require(report.get("certifies_g05") is False and isinstance(report.get("cleanup_confirmed"), bool),
            "Missing scoped provider cleanup verdict")
    require(re.fullmatch(r"native-provider-[0-9]+-[0-9]+", report.get("identity", "")) is not None
            and re.fullmatch(r"[0-9a-f]{40}", report.get("source", "")) is not None,
            "Missing immutable provider evidence identity")
    require(report.get("status") in {"passed", "failed", "blocked"}, "Invalid provider capability verdict")
    raw = json.dumps(report, separators=(",", ":"), allow_nan=False).encode()
    require(len(raw) <= 65536, "Provider public evidence exceeded its byte budget")
    return raw


def write_public_report(directory, report):
    public_payload(report)
    directory.mkdir(mode=0o755)
    path = directory / "provider-capabilities.json"
    atomic_json(path, report)
    # The controller runs as root; the artifact uploader runs as the runner.
    # Only this validated public report crosses the private 0700 boundary.
    path.chmod(0o644)


def allocator_capabilities(points):
    allocator = [point for point in points if point["available"] and
                 point["name"].startswith(("rustfs_memory_allocator_", "rustfs_allocator_", "allocator_"))]
    gauges = {point["name"]: point["value"] for point in allocator if point["kind"] == "gauge"}
    memory_names = {"rustfs_memory_allocator_reserved_bytes", "rustfs_memory_allocator_committed_bytes",
                    "rustfs_memory_allocator_page_committed_bytes"}
    availability = gauges.get("rustfs_memory_allocator_malloc_requested_bytes_available")
    live = None
    if availability in {0, 1}:
        live = bool(availability)
    return {"numeric_points": len(allocator), "memory_gauges_observed": sorted(memory_names.intersection(gauges)),
            "requested_bytes_available": live, "live_owner_release": "not verified"}


def publish(report):
    raw = public_payload(report)
    digest = hashlib.sha256(raw).hexdigest()
    encoded = base64.b64encode(gzip.compress(raw, mtime=0)).decode()
    parts = [encoded[index:index + 3000] for index in range(0, len(encoded), 3000)]
    require(len(parts) <= 9, "Provider evidence exceeded the per-step annotation budget")
    summary = {key: report.get(key) for key in ["identity", "source", "status", "cleanup_confirmed", "resource_samples", "exports_received"]}
    summary["report_sha256"] = digest
    values = [("Provider memory summary", summary)]
    values.extend(("Provider memory evidence", {"part": index, "parts": len(parts), "sha256": digest,
                                               "encoding": "gzip+base64", "payload": value})
                  for index, value in enumerate(parts, 1))
    for title, value in values:
        text = json.dumps(value, separators=(",", ":"), allow_nan=False).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        require(len(text.encode()) <= 3900, "Provider notice exceeded its byte budget")
        print("::notice title=" + title + "::" + text, flush=True)


def main():
    available = inventory()
    require(os.geteuid() == 0 and available["cpu_affinity_slots"] >= 4, "Provider control needs its disposable four-CPU VM")
    require(not docker("ps", "-aq"), "Refuse provider discovery on a Docker host with existing containers")
    run, attempt = [os.environ.get(name, "") for name in ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]]
    require(re.fullmatch(r"[0-9]{1,20}", run) is not None and re.fullmatch(r"[0-9]{1,4}", attempt) is not None,
            "Missing immutable provider run identity")
    suffix = run + "-" + attempt
    budget = controller_budget(suffix)
    cpus = sorted(os.sched_getaffinity(0))
    os.sched_setaffinity(0, {cpus[0]})
    identity = "native-provider-" + suffix
    output = ROOT / "target/stress-g05" / identity
    public = output.with_name(output.name + "-public")
    require(not output.exists() and not public.exists(), "Preserve previous provider evidence")
    output.mkdir(parents=True, mode=0o700)
    began, initial_network = time.monotonic(), network_bytes()
    name, volume = identity + "-server", identity + "-data"
    owner = {"identity": identity, "pid": os.getpid(), "process_identity": process_identity(os.getpid()),
             "output": str(output), "reserve_path": str(output), "started_monotonic": began,
             "maximum_seconds": MAXIMUM_SECONDS, "preparation_seconds": 150, "containers": [name], "volumes": [volume]}
    atomic_json(output / "ownership.json", owner)
    phase, resource_at = "preparation", began
    stage = "preflight"
    stop = threading.Event()
    def heartbeat():
        while not stop.is_set():
            atomic_json(output / "heartbeat.json", {"phase": phase, "monotonic": time.monotonic(), "resource_monotonic": resource_at})
            stop.wait(2)
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    watcher = subprocess.Popen([sys.executable, str(Path(__file__).with_name("watchdog.py")), str(output / "ownership.json")],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    def terminate(signum, frame):
        raise RuntimeError("Owned provider control terminated by its watchdog")
    previous = signal.signal(signal.SIGTERM, terminate)
    owned = OwnedDocker(identity, docker)
    receiver = worker = None
    report = {"identity": identity, "source": available["source"], "certifies_g05": False, "status": "failed",
              "scope": __doc__, "controller_kernel_budget": budget, "resource_samples": 0,
              "profile": {"provider_cpu": 0.5, "provider_memory_mib": 1024, "provider_pids": 128,
                          "provider_data_mib": 512, "provider_writable_layer_mib": 512, "maximum_network_bytes": 4 * 1024 ** 3,
                          "maximum_seconds": MAXIMUM_SECONDS, "observation_seconds": 90, "sample_seconds": 5,
                          "heap_export_interval_seconds": 5, "transport": "nonce-authenticated local bridge HTTP; no public ingress",
                          "minimum_free_memory_fraction": 0.1, "minimum_free_disk_inode_fraction": 0.15},
              "image": IMAGE, "heap_ownership_status": "not run", "completed_effective_load_seconds": 0}
    atomic_json(output / "predeclared-profile.json", report)
    try:
        require(host_reserves(output) is None, "Provider preflight host reserve failed")
        stage = "private-bridge-receiver"
        bridge = json.loads(docker("network", "inspect", "bridge"))[0]["IPAM"]["Config"]
        gateways = [value["Gateway"] for value in bridge if "Gateway" in value]
        require(len(gateways) == 1 and ipaddress.ip_address(gateways[0]).version == 4
                and ipaddress.ip_address(gateways[0]).is_private, "No private default bridge gateway")
        token = secrets.token_hex(32)
        receiver = Receiver((gateways[0], 0), token)
        worker = threading.Thread(target=receiver.serve_forever, daemon=True)
        worker.start()
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
        report["collector_unauthorized_probe_status"] = denied
        stage = "image-pull"
        docker("pull", IMAGE)
        image = json.loads(docker("image", "inspect", IMAGE))[0]
        require(image["Id"] == IMAGE_ID and image["Size"] <= 512 * 1024 ** 2, "Provider image differs from the declared artifact")
        report["image_id"] = image["Id"]
        stage = "owned-fixture-creation"
        owned("volume", "create", "--label", LABEL + "=" + identity, volume)
        environment = {"RUSTFS_ACCESS_KEY": secrets.token_hex(16), "RUSTFS_SECRET_KEY": secrets.token_hex(32),
                       "RUSTFS_CONSOLE_ENABLE": "false", "RUSTFS_OBS_ENDPOINT": endpoint,
                       "RUSTFS_OBS_METRIC_ENDPOINT": endpoint + "/v1/metrics", "RUSTFS_OBS_METRICS_EXPORT_ENABLED": "true",
                       "RUSTFS_OBS_ENDPOINT_HEADERS": "x-g05-probe=" + token,
                       "RUSTFS_OBS_ENDPOINT_METRICS_HEADERS": "x-g05-probe=" + token,
                       "RUSTFS_OBS_TRACES_EXPORT_ENABLED": "false", "RUSTFS_OBS_LOGS_EXPORT_ENABLED": "false",
                       "RUSTFS_OBS_PROFILING_EXPORT_ENABLED": "false", "RUSTFS_OBS_USE_STDOUT": "false",
                       "RUSTFS_MEMORY_OBSERVABILITY_INTERVAL_SECS": "5", "RUSTFS_OBS_METER_INTERVAL": "5"}
        flags = []
        for key in environment:
            flags.extend(["-e", key])
        owned("run", "-d", "--name", name, "--label", LABEL + "=" + identity, "--cpus", ".5", "--cpuset-cpus", str(cpus[1]),
              "--memory", "1024m", "--memory-swap", "1024m", "--pids-limit", "128", "--mount",
              "type=volume,source=" + volume + ",destination=/data", *flags, IMAGE, env=environment)
        state = json.loads(owned("inspect", name))[0]
        receiver.peer = state["NetworkSettings"]["Networks"]["bridge"]["IPAddress"]
        require(ipaddress.ip_address(receiver.peer).is_private, "Provider peer escaped the private bridge")
        until = time.monotonic() + 90
        peaks = {"memory_bytes": 0, "anonymous_bytes": 0, "tasks": 0, "data_bytes": 0, "writable_layer_bytes": 0}
        phase = "observation"
        stage = "bounded-observation"
        while time.monotonic() < until:
            require(host_reserves(output) is None and network_bytes() - initial_network <= 4 * 1024 ** 3,
                    "Provider control reached a host/network limit")
            state = json.loads(owned("inspect", "--size", name))[0]
            require(state["State"]["Running"] and not state["State"]["OOMKilled"] and not state["State"]["Restarting"],
                    "Provider exited or restarted unexpectedly")
            resource = owned_cgroup_snapshot(owned, name)
            require_no_oom(resource["memory.events"])
            require(resource["memory.max"] == 1024 ** 3 and resource["pids.max"] == 128 and
                    resource["cpu.max"]["quota_usec"] * 2 == resource["cpu.max"]["period_usec"], "Provider kernel budget changed")
            disk = int(owned("exec", name, "du", "-sk", "/data").split()[0]) * 1024
            require(disk <= 512 * 1024 ** 2 and state["SizeRw"] <= 512 * 1024 ** 2, "Provider disk quota reached")
            require(receiver.failure is None, "Provider telemetry parser failed")
            resource_at = time.monotonic()
            values = {"memory_bytes": resource["memory.current"], "anonymous_bytes": resource["memory.stat"]["anon"],
                      "tasks": resource["pids.current"], "data_bytes": disk, "writable_layer_bytes": state["SizeRw"]}
            for key, value in values.items():
                peaks[key] = max(peaks[key], value)
            report["resource_samples"] += 1
            time.sleep(min(5, max(0, until - time.monotonic())))
        with receiver.lock:
            report.update(exports_received=receiver.exports, telemetry_wire_bytes=receiver.received,
                          first_memory_export=receiver.first, last_memory_export=receiver.last)
        report["resource_peaks"] = peaks
        points = []
        if receiver.last is not None:
            points = receiver.last["points"]
        capability = allocator_capabilities(points)
        report["allocator_capabilities"] = capability
        report["allocator_numeric_points"] = capability["numeric_points"]
        report["status"] = "blocked"
        report["blocker"] = "No numeric allocator telemetry observed; heap ownership remains unverified"
        if capability["memory_gauges_observed"]:
            report["status"] = "passed"
            report.pop("blocker")
    except Exception as error:
        report["status"] = "failed"
        report["failure"] = {"phase": phase, "stage": stage, "type": type(error).__name__}
    finally:
        phase = "teardown"
        errors = []
        if receiver is not None:
            try:
                receiver.shutdown()
                receiver.server_close()
            except Exception as error:
                errors.append({"owner": "receiver", "type": type(error).__name__})
            with receiver.lock:
                report.update(exports_received=receiver.exports, telemetry_wire_bytes=receiver.received,
                              first_memory_export=receiver.first, last_memory_export=receiver.last,
                              telemetry_failure=receiver.failure)
        if worker is not None:
            worker.join(timeout=10)
            if worker.is_alive():
                errors.append({"owner": "receiver-thread", "type": "join_timeout"})
        try:
            cleanup(owner)
            clean = not docker("ps", "-aq", "--filter", "label=" + LABEL + "=" + identity) and not docker("volume", "ls", "-q", "--filter", "label=" + LABEL + "=" + identity)
        except Exception as error:
            clean = False
            errors.append({"owner": "docker-fixtures", "type": type(error).__name__})
        report["cleanup_confirmed"] = clean
        if clean:
            (output / "watchdog-disarmed").touch()
            try:
                watcher.wait(timeout=15)
            except subprocess.TimeoutExpired:
                errors.append({"owner": "watchdog", "type": "join_timeout"})
                watcher.terminate()
                watcher.wait(timeout=5)
        if not clean or errors:
            report["status"] = "failed"
        report["cleanup_errors"] = errors
        stop.set()
        thread.join(timeout=5)
        signal.signal(signal.SIGTERM, previous)
        report["elapsed_seconds_including_preparation"] = time.monotonic() - began
        write_public_report(public, report)
        publish(report)
    if report["status"] == "failed":
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Bootstrap/cgroup rejection can precede output creation. Never expose
        # raw Docker stderr, signed image URLs or generated configuration.
        print("::notice title=Provider capability bootstrap failure::" + json.dumps({"type": type(error).__name__}), flush=True)
        raise SystemExit(1)
