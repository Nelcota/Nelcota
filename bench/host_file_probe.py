#!/usr/bin/env python3
"""Validate the optional private-file graph on a fresh disposable Actions VM."""
import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from campaign import docker, effective_cpus
from fleet_private_files import COUNTS, PROFILE, PROTOCOL, require, validate_receipt, validate_run
from host_campaign import REQUIRED_IMAGES
from matrix_probe import input_artifact, read_receipt
from native_evidence import notices
from native_preflight import inventory
from watchdog import atomic_json, cleanup, process_identity, stop_generator, stop_owner

ROOT = Path(__file__).resolve().parents[1]
CASES = [(1, 4, "quota"), (5, 1, "shared")]
STEP_SECONDS = 60
CASE_SECONDS = 1200
PROFILE_SCOPE = "Functional private-file preflight; 60-second phases are not five-minute capacity or final fairness certification"


def campaign_arguments(binary, identity, projects, rate, policy):
    require((projects, rate, policy) in CASES, "Unknown private-file preflight topology")
    return [sys.executable, str(ROOT / "bench/launch.py"), "--kind", "host", "--run-id", identity,
            "--binary", str(binary), "--projects", str(projects), "--rate", str(rate),
            "--seconds", str(STEP_SECONDS), "--disk-mib", "1536", "--cpu-period-micros", "100000",
            "--project-cpu-policy", policy, "--private-file-isolation"]


def prepare_images():
    result = {}
    for image in REQUIRED_IMAGES:
        docker("pull", image)
        values = json.loads(docker("image", "inspect", image))
        require(isinstance(values, list) and len(values) == 1 and isinstance(values[0], dict), "Missing required host image metadata")
        value = values[0]
        identifier, size, digests = value.get("Id"), value.get("Size"), value.get("RepoDigests")
        require(isinstance(identifier, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", identifier) is not None
                and type(size) is int and 0 < size <= 2 * 1024 ** 3 and isinstance(digests, list) and 0 < len(digests) <= 4
                and all(isinstance(item, str) and re.fullmatch(r"[a-z0-9][a-z0-9./_-]{1,100}@sha256:[0-9a-f]{64}", item) is not None
                        for item in digests), "Invalid bounded required host image evidence")
        result[image] = {"id": identifier, "size_bytes": size, "repo_digests": digests}
    return result


def kernel_budget(identity):
    relative = next(line.split(":", 2)[2] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    base = Path("/sys/fs/cgroup").resolve()
    path = (base / relative.lstrip("/")).resolve(strict=True)
    require(path.is_relative_to(base) and "g05-host-files-" + identity + ".service" in path.parts,
            "Host-file controller is outside its owned systemd unit")
    quota, period = (path / "cpu.max").read_text().split()
    require(quota.isdigit() and int(period) > 0 and int(quota) * 2 == int(period)
            and (path / "memory.max").read_text().strip() == str(512 * 1024 ** 2)
            and (path / "memory.swap.max").read_text().strip() == "0"
            and (path / "pids.max").read_text().strip() == "128", "Host-file controller budget differs")
    return {"cpu_quota_usec": int(quota), "cpu_period_usec": int(period), "memory_bytes": 512 * 1024 ** 2,
            "swap_bytes": 0, "pids": 128, "maximum_seconds": 2700,
            "CPU_policy": {"target_app_role_affinity_bound": 1, "target_PostgreSQL_role_affinity_bound": 1,
                           "generator": 1, "telemetry": .25, "controller": .5, "independent_watchdog": .05,
                           "effective_sum": 3.8, "telemetry_slot_sum": .8, "telemetry_slot_OS_reserve": .2,
                           "five_project_shared_quota_sum_exceeds_role_affinity_bound": True,
                           "one_project_configured_quota_sum": 3.8, "five_project_configured_quota_sum": 11.8},
            "separate_watchdog": {"CPU_percent": 5, "memory_mib": 128, "swap_bytes": 0,
                                  "tasks": 32, "maximum_seconds": 1500, "case_deadline_seconds": CASE_SECONDS}}


def checked_lease(value, output, projects, launcher_pid, now):
    require(isinstance(value, dict) and isinstance(value.get("identity"), str)
            and re.fullmatch(r"nelcota-fleet-[0-9a-f]{32}", value["identity"]) is not None,
            "Missing owned fleet identity")
    identity = value["identity"]
    require(value.get("output") == str(output) and value.get("reserve_path") == str(output)
            and not output.is_symlink() and output.is_dir(), "Fleet ownership escaped its fresh output")
    expected = {identity + "-metrics", identity + "-load"}
    expected.update(identity + "-" + role + "-" + str(index) for role in ["app", "pg"] for index in range(projects))
    volumes = {identity + "-metrics-data", *[identity + "-data-" + str(index) for index in range(projects)]}
    require(isinstance(value.get("containers"), list) and len(value["containers"]) == len(expected)
            and set(value["containers"]) == expected and isinstance(value.get("volumes"), list)
            and len(value["volumes"]) == len(volumes) and set(value["volumes"]) == volumes,
            "Fleet lease includes foreign or duplicate resource names")
    pid, began = value.get("pid"), value.get("started_monotonic")
    require(type(pid) is int and pid > 1 and process_identity(pid) == value.get("process_identity")
            and isinstance(value.get("process_identity"), str) and value["process_identity"].isdigit()
            and os.getpgid(pid) == launcher_pid, "Fleet owner is not in the fresh launcher session")
    require(type(began) in {int, float} and math.isfinite(began) and 0 <= now - began <= 15
            and type(value.get("maximum_seconds")) is int and value["maximum_seconds"] == 7200
            and value.get("preparation_seconds") == 900, "Fleet lease is stale or has an unknown budget")
    return {**value, "maximum_seconds": CASE_SECONDS}


def watch_command(unit, lease, cpu):
    require(re.fullmatch(r"g05-host-files-watch-[0-9]{1,20}-[0-9]{1,4}-[15]", unit) is not None
            and type(cpu) is int and cpu >= 0, "Unknown independent fleet watchdog")
    return ["sudo", "-n", "systemd-run", "--collect", "--unit=" + unit,
            "--description=G05 private files " + unit, "--uid=" + str(os.getuid()), "--gid=" + str(os.getgid()),
            "--working-directory=" + str(ROOT), "--property=CPUQuota=5%", "--property=CPUAffinity=" + str(cpu),
            "--property=MemoryMax=128M", "--property=MemorySwapMax=0", "--property=TasksMax=32",
            "--property=RuntimeMaxSec=1500", "--property=Nice=19", "--property=IOSchedulingClass=idle",
            "--property=KillMode=control-group", sys.executable, str(ROOT / "bench/watchdog.py"), str(lease)]


def stop_watch(unit):
    require(re.fullmatch(r"g05-host-files-watch-[0-9]{1,20}-[0-9]{1,4}-[15]", unit) is not None,
            "Unknown independent fleet watchdog")
    result = subprocess.run(["sudo", "-n", "systemctl", "show", unit,
                             "--property=Id", "--property=LoadState", "--property=Description"],
                            capture_output=True, text=True, timeout=15)
    require(result.returncode in {0, 1} and isinstance(result.stdout, str) and len(result.stdout) <= 1024,
            "Cannot verify independent watchdog state")
    lines = result.stdout.splitlines()
    fields = dict(line.split("=", 1) for line in lines if "=" in line)
    require(len(lines) == 3 and len(fields) == 3 and set(fields) == {"Id", "LoadState", "Description"}
            and fields["Id"] == unit + ".service", "Cannot verify independent watchdog identity")
    # --collect can unload the guard after the campaign disarms it. systemd
    # still returns a default Description for this absent unit.
    if fields["LoadState"] == "not-found":
        return {"status": "absent", "identity_verified": True, "load_state": "not-found"}
    require(result.returncode == 0 and fields["LoadState"] == "loaded"
            and fields["Description"] == "G05 private files " + unit, "Refusing to stop another systemd unit")
    subprocess.run(["sudo", "-n", "systemctl", "stop", unit], check=True, capture_output=True, timeout=30)
    return {"status": "stopped", "identity_verified": True, "load_state": "loaded"}


def require_watch(unit):
    result = subprocess.run(["sudo", "-n", "systemctl", "is-active", "--quiet", unit],
                            capture_output=True, timeout=15)
    require(result.returncode == 0, "Independent host-file watchdog exited during foreground work")


def project_receipts(output, projects):
    profile = read_receipt(output / "manifest.json")
    require(profile.get("projects") == projects and profile.get("seconds_per_step") == STEP_SECONDS
            and profile.get("private_file_isolation") == PROFILE and profile.get("capacity_qualification") is False,
            "Host-file campaign changed its declared profile")
    ledger = [json.loads(line) for line in (output / "traffic-ledger.jsonl").read_text().splitlines()]
    validate_run(output, profile, ledger)
    values = []
    for path in sorted(output.glob("private-isolation-*.json")):
        value = read_receipt(path)
        phase = path.stem.removeprefix("private-isolation-")
        validate_receipt(value, projects, during_load=phase not in {"before", "after"}, run_id=output.name, phase=phase)
        values.append(value)
    return {"private_file_receipts": values, "CPU_affinity": profile["cpu_affinity"],
            "controller_CPU_affinity": profile["private_file_controller_cpu_affinity"],
            "project_CPU_allocation": profile["project_cpu_allocation"], "seconds_per_step": STEP_SECONDS}


def partial_receipts(output, projects):
    """Keep original failure counts even when a complete graph cannot certify."""
    values = []
    paths = sorted(output.glob("private-isolation-*.json"))
    require(len(paths) <= 10, "Unexpected private-file receipt cardinality")
    for path in paths:
        value = read_receipt(path)
        phase = path.stem.removeprefix("private-isolation-")
        if value.get("status") == "passed":
            validate_receipt(value, projects, during_load=phase not in {"before", "after"}, run_id=output.name, phase=phase)
            values.append(value)
            continue
        require(set(value) == {"status", "protocol", "failure_type", "counts", "requests_total",
                               "logical_HTTP_bytes_total", "run_id", "phase"}
                and value["status"] == "failed" and value["protocol"] == PROTOCOL
                and value["run_id"] == output.name and value["phase"] == phase
                and re.fullmatch(r"[a-z0-9-]{1,80}", phase) is not None
                and isinstance(value["failure_type"], str)
                and re.fullmatch(r"[A-Za-z]{1,80}", value["failure_type"]) is not None,
                "Unknown private-file failure publication fields")
        counts = value["counts"]
        require(isinstance(counts, dict) and set(counts) == set(COUNTS)
                and all(type(item) is int and 0 <= item <= PROFILE["maximum_requests"] for item in counts.values())
                and counts["projects"] == projects, "Invalid private-file partial counts")
        for key, maximum in [("requests_total", PROFILE["maximum_requests"]),
                             ("logical_HTTP_bytes_total", PROFILE["maximum_logical_HTTP_bytes"])]:
            require(type(value[key]) is int and 0 <= value[key] <= maximum, "Invalid partial traffic accounting")
        values.append(value)
    return values


def export_resources(source, destination, projects):
    require(not source.is_symlink() and source.is_file(), "Missing host-file resource series")
    count, previous, gap = 0, None, 0
    roles = {role + "-" + str(index) for role in ["app", "pg"] for index in range(projects)} | {"metrics"}
    peaks = {}
    with source.open("rb") as stream, destination.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as encoded:
        while True:
            line = stream.readline(512 * 1024 + 1)
            if not line:
                break
            require(len(line) <= 512 * 1024 and count < 600, "Host-file resource series exceeded its ceiling")
            row = json.loads(line)
            now = row["monotonic"]
            require(type(now) in {int, float} and math.isfinite(now) and now >= 0
                    and re.fullmatch(r"[a-z0-9-]{1,80}", row["phase"]) is not None, "Invalid resource sample")
            if previous is not None:
                require(now >= previous, "Host-file samples moved backwards")
                gap = max(gap, now - previous)
            previous = now
            projected = {"monotonic": now, "phase": row["phase"], "components": {}}
            for name, point in row["component_cgroups"].items():
                # Docker inspect's Name includes one leading slash; the
                # controller stores that exact Name in component_cgroups.
                match = re.fullmatch(r"/?nelcota-fleet-[0-9a-f]{32}-(app-[0-9]|pg-[0-9]|metrics)", name)
                require(match is not None and match[1] in roles and match[1] not in projected["components"], "Unexpected host-file role")
                numeric = {"memory_current_bytes": point["memory.current"], "memory_peak_bytes": point["memory.peak"],
                           "anonymous_bytes": point["memory.stat"]["anon"], "tasks": point["pids.current"],
                           "oom_events": point["memory.events"]["oom"], "oom_kills": point["memory.events"]["oom_kill"]}
                require(all(type(value) is int and value >= 0 for value in numeric.values()), "Invalid kernel resource gauge")
                projected["components"][match[1]] = numeric
                maximum = peaks.setdefault(match[1], dict.fromkeys(numeric, 0))
                for key, value in numeric.items():
                    maximum[key] = max(maximum[key], value)
            require(set(projected["components"]) == roles, "Incomplete host-file component census")
            encoded.write(json.dumps(projected, separators=(",", ":"), allow_nan=False).encode() + b"\n")
            count += 1
    require(count > 1 and destination.stat().st_size <= 1024 ** 2, "Missing or excessive host-file resource evidence")
    return {"samples": count, "maximum_gap_seconds": gap, "component_peaks": peaks,
            "public_file": destination.name, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}


def public_notices(report):
    result = []
    for line in notices(report):
        require(line.startswith("::notice title=Native VM "), "Unknown notice codec boundary")
        result.append(line.replace("::notice title=Native VM ", "::notice title=Host file isolation ", 1))
    return result


def close_case(child, lease, unit, output, projects, case):
    errors = []
    try:
        if lease is not None:
            stop_generator(lease)
            stop_owner(lease)
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=60)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
    except Exception as error:
        errors.append({"step": "stop-owned-processes", "failure_type": type(error).__name__})
    try:
        if lease is not None:
            cleanup(lease)
    except Exception as error:
        errors.append({"step": "owned-resource-cleanup", "failure_type": type(error).__name__})
    try:
        case["original_private_file_receipts"] = partial_receipts(output, projects)
    except Exception as error:
        errors.append({"step": "original-private-file-receipts", "failure_type": type(error).__name__})
    try:
        clean = read_receipt(output / "cleanup.json")
        case["cleanup_confirmed"] = clean.get("confirmed") is True and not docker("ps", "-aq") and not docker("volume", "ls", "-q")
        require(case["cleanup_confirmed"], "Host-file fixture cleanup is incomplete")
        # Keep the independent deadline guard if owned resources still exist.
        case["independent_watchdog_close"] = stop_watch(unit)
    except Exception as error:
        errors.append({"step": "confirm-cleanup-and-stop-watch", "failure_type": type(error).__name__})
    if errors:
        case["status"] = "failed"
    case["cleanup_errors"] = errors
    return not errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    available = inventory()
    require(available["cpu_affinity_slots"] >= 4 and effective_cpus(sorted(os.sched_getaffinity(0))) >= 3.8
            and not docker("ps", "-aq") and not docker("volume", "ls", "-q"),
            "Host-file probes need their empty disposable Docker VM")
    run, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch(r"[0-9]{1,20}", run) is not None and re.fullmatch(r"[0-9]{1,4}", attempt) is not None,
            "Missing host-file workflow identity")
    proof = input_artifact(args.artifact, read_receipt(ROOT / "docs/goals/results/stress/final-local-candidate.json"),
                           read_receipt(ROOT / "docs/goals/results/stress/native-final-suite/index.json"))
    binary = (args.artifact / "nelcota").resolve(strict=True)
    binary.chmod(0o555)
    identity = "host-files-" + run + "-" + attempt
    base = ROOT / "target/stress-g05"
    public, private = base / (identity + "-public"), base / (identity + "-operator")
    require(not public.exists() and not private.exists(), "Preserve previous host-file evidence")
    private.mkdir(mode=0o700, parents=True)
    public.mkdir(mode=0o755)
    began = time.monotonic()
    report = {"identity": identity, "source": available["source"], "binary_sha256": proof["binary_sha256"],
              "scenario": "host-private-file-preflight", "certifies_g05": False, "status": "failed", "cleanup_confirmed": False,
              "resource_samples": 0, "completed_effective_load_seconds": 0,
              "checks": {"scope": PROFILE_SCOPE, "product_artifact": proof, "profile": PROFILE,
                         "controller_kernel_budget": kernel_budget(run + "-" + attempt), "cases": [],
                         "local_load_checkpoint_credit_seconds": 0}}
    previous = signal.getsignal(signal.SIGTERM)

    def terminate(signum, frame):
        raise RuntimeError("Host-file preflight terminated")

    signal.signal(signal.SIGTERM, terminate)
    try:
        report["checks"]["images"] = prepare_images()
        for projects, rate, policy in CASES:
            name = identity + "-p" + str(projects)
            output = base / name
            require(not output.exists(), "Preserve earlier host-file case")
            unit = "g05-host-files-watch-" + run + "-" + attempt + "-" + str(projects)
            lease, child = None, None
            case = {"projects": projects, "rate_per_project": rate, "CPU_policy": policy, "status": "failed",
                    "cleanup_confirmed": False, "last_collection_stage": "launch"}
            report["checks"]["cases"].append(case)
            logpath = private / ("p" + str(projects) + ".private.log")
            try:
                with logpath.open("x") as log:
                    child = subprocess.Popen(campaign_arguments(binary, name, projects, rate, policy), cwd=ROOT,
                                             stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    deadline = time.monotonic() + CASE_SECONDS
                    next_watch_probe = 0
                    while child.poll() is None:
                        require(time.monotonic() <= deadline and time.monotonic() - began <= 2400,
                                "Host-file preflight duration ceiling reached")
                        require(logpath.stat().st_size <= 16 * 1024 ** 2, "Host-file log exceeded its byte ceiling")
                        if lease is None and (output / "ownership.json").exists():
                            lease = checked_lease(read_receipt(output / "ownership.json"), output, projects, child.pid, time.monotonic())
                            path = private / ("p" + str(projects) + "-lease.json")
                            atomic_json(path, lease)
                            subprocess.run(watch_command(unit, path, max(os.sched_getaffinity(0))),
                                           check=True, capture_output=True, timeout=20)
                        if lease is not None and time.monotonic() >= next_watch_probe and not (output / "watchdog-disarmed").exists():
                            require_watch(unit)
                            next_watch_probe = time.monotonic() + 5
                        time.sleep(.5)
                case["exit_code"] = child.returncode
                case["last_collection_stage"] = "original-completion"
                completion = read_receipt(output / "completion.json")
                case["original_completion"] = completion
                case["resource_violations"] = read_receipt(output / "resource-violations.json")
                case["acceptance_failures"] = read_receipt(output / "acceptance-failures.json")
                case["last_collection_stage"] = "private-file-receipts"
                case.update(project_receipts(output, projects))
                case["last_collection_stage"] = "resource-projection"
                series = export_resources(output / "resources.jsonl", public / ("resources-p" + str(projects) + ".jsonl.gz"), projects)
                case["resource_evidence"] = series
                report["resource_samples"] += series["samples"]
                case["last_collection_stage"] = "acceptance"
                require(lease is not None and child.returncode == 0 and completion["status"] == "passed"
                        and not case["resource_violations"] and not case["acceptance_failures"]
                        and series["maximum_gap_seconds"] <= 30, "Host-file campaign failed its original acceptance gates")
                case["status"] = "passed"
                case["last_collection_stage"] = "complete"
            except BaseException as error:
                case["failure_type"] = type(error).__name__
                raise
            finally:
                require(close_case(child, lease, unit, output, projects, case), "Host-file teardown or evidence failed")
        report["status"] = "passed"
    except BaseException as error:
        report["failure"] = type(error).__name__
    finally:
        signal.signal(signal.SIGTERM, previous)
        try:
            report["cleanup_confirmed"] = not docker("ps", "-aq") and not docker("volume", "ls", "-q")
        except Exception as error:
            report["checks"]["final_cleanup_failure_type"] = type(error).__name__
        if not report["cleanup_confirmed"]:
            report["status"] = "failed"
        report["elapsed_seconds_including_preparation"] = time.monotonic() - began
        atomic_json(public / "report.json", report)
        for line in public_notices(report):
            print(line, flush=True)
    raise SystemExit(report["status"] != "passed")


if __name__ == "__main__":
    main()
