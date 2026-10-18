#!/usr/bin/env python3
"""Run supplemental final-ELF HTTP probes on a disposable Actions VM only."""
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

from campaign import docker
from matrix_pressure import PROFILE, require
from native_artifact import artifact
from native_evidence import publish
from native_preflight import inventory
from watchdog import atomic_json, cleanup, process_identity
from ledger_capacity import DEFAULT_PROVISIONAL_RATE, STEP_SECONDS, offered_rates

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_PATHS = {"crates", "sdk", "migrations", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"}


def capacity_profile():
    return {'provisional_rate':DEFAULT_PROVISIONAL_RATE, 'step_seconds':STEP_SECONDS,
            'rates':offered_rates(DEFAULT_PROVISIONAL_RATE)}


def campaign_arguments(binary, identity, full):
    command = [sys.executable, str(ROOT/'bench/launch.py'), '--kind', 'fault', '--run-id', identity,
               '--binary', str(binary), '--focus', 'matrix', '--rate', '8']
    if full:
        return command + ['--capacity', '--provisional-rate', str(DEFAULT_PROVISIONAL_RATE),
                          '--matrix-step-seconds', '120']
    return command + ['--matrix-step-seconds', '20']


def capacity_probe_evidence(probes):
    profile = capacity_profile()
    require(isinstance(probes,list) and len(probes)==len(profile['rates']),
            'Missing complete four-step capacity evidence')
    for probe, rate in zip(probes, profile['rates']):
        require(isinstance(probe,dict) and type(probe.get('rate')) is int and probe['rate']==rate
                and type(probe.get('requested_seconds')) is int
                and probe['requested_seconds']==profile['step_seconds']
                and type(probe.get('elapsed_seconds')) in {int,float}
                and math.isfinite(probe['elapsed_seconds'])
                and probe['elapsed_seconds']>=profile['step_seconds']
                and type(probe.get('nominal_qualified')) is bool,
                'Capacity receipt differs from the actual declared rate or five-minute duration')
    return probes


def input_artifact(directory, provenance, native):
    require(provenance["source_commit"] == native["source_commit"] and native["status"] == "passed"
            and native["total_cases"] == 12 and native["common_elf_verified"] is True,
            "Supplemental probes need the independently verified final native artifact")
    value = artifact(directory, native["source_commit"])
    require(value["binary_sha256"] == native["binary_sha256"]
            and value["size_bytes"] == native["common_executable_size_bytes"], "Downloaded native artifact differs from retained evidence")
    trees = provenance["product_tree_objects"]
    require(set(trees) == PRODUCT_PATHS, "Missing complete final product tree identity")
    dirty = subprocess.check_output(["git", "status", "--porcelain", "--", *sorted(PRODUCT_PATHS)], cwd=ROOT, text=True, timeout=10)
    require(not dirty.strip(), "Product sources changed in the working tree after the retained ELF was built")
    for path, expected in trees.items():
        actual = subprocess.check_output(["git", "rev-parse", "HEAD:" + path], cwd=ROOT, text=True, timeout=10).strip()
        require(re.fullmatch("[0-9a-f]{40}", expected) is not None and actual == expected,
                "Product sources changed after the retained native ELF was built")
    return {"source_commit": value["source_commit"], "binary_sha256": value["binary_sha256"],
            "size_bytes": value["size_bytes"], "product_tree_objects": trees,
            "artifact_workflow_run_id": native["workflow_run_id"],
            "scope": "The retained Actions ELF is distinct from the local performance ELF; current product trees must match its build source."}


def kernel_budget(identity, prefix="g05-matrix-"):
    relative = next(line.split(":", 2)[2] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    root = Path("/sys/fs/cgroup").resolve()
    path = (root / relative.lstrip("/")).resolve(strict=True)
    require(prefix in {"g05-matrix-", "g05-browser-auth-"}, "Unknown owned diagnostic unit namespace")
    require(path.is_relative_to(root) and prefix + identity + ".service" in path.parts,
            "Supplemental controller is outside its owned systemd unit")
    quota, period = (path / "cpu.max").read_text().split()
    memory, swap, tasks = [(path / name).read_text().strip() for name in ["memory.max", "memory.swap.max", "pids.max"]]
    require(quota.isdigit() and int(quota) == int(period) and memory == str(512 * 1024 ** 2)
            and swap == "0" and tasks == "128", "Supplemental controller kernel budget differs")
    return {"cpu_quota_usec": int(quota), "cpu_period_usec": int(period), "memory_bytes": int(memory), "swap_bytes": 0, "pids": 128}


def read_receipt(path):
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 1024 ** 2,
            "Missing bounded supplemental receipt")
    return json.loads(path.read_text())


def export_resources(source, destination, roles=None):
    require(not source.is_symlink() and source.is_file(), "Missing supplemental resource series")
    samples, previous, maximum_gap = 0, None, 0
    peaks = {}
    target = destination / "resources.jsonl.gz"
    with source.open("rb") as stream, target.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as encoded:
        while True:
            line = stream.readline(256 * 1024 + 1)
            if not line:
                break
            require(len(line) <= 256 * 1024 and samples < 600, "Supplemental resource inventory exceeded its ceiling")
            row = json.loads(line)
            now = row["monotonic"]
            phase = row["phase"]
            if roles is not None:
                require(phase in {"preparation", "untrusted-ca", "live-panel-SDK", "teardown"}, "Unexpected owned browser observation phase")
                phase = phase.lower()
            require(type(now) in {int, float} and math.isfinite(now) and now >= 0
                    and re.fullmatch("[a-z0-9-]{1,80}", phase) is not None, "Invalid supplemental observation")
            if previous is not None:
                require(now >= previous, "Resource observations moved backwards")
                maximum_gap = max(maximum_gap, now - previous)
            previous = now
            projected = {"monotonic": now, "phase": phase, "components": {}}
            for name, values in row["component_cgroups"].items():
                role = None
                if roles is None:
                    match = re.search(r"-(app|pg)-([01])$", name)
                    require(match is not None, "Unexpected supplemental component identity")
                    role = match[1] + "-" + match[2]
                if roles is not None:
                    role = roles.get(name)
                    require(role in {"app-0", "app-1", "pg-0", "proxy", "browser"}, "Unexpected owned browser component")
                require(role not in projected["components"], "Duplicate supplemental component role")
                point = {"memory_current_bytes": values["memory.current"], "memory_peak_bytes": values["memory.peak"],
                         "anonymous_bytes": values["memory.stat"]["anon"], "tasks": values["pids.current"],
                         "oom_events": values["memory.events"]["oom"], "oom_kills": values["memory.events"]["oom_kill"],
                         "cpu_throttled_usec": values["cpu.stat"]["throttled_usec"]}
                require(all(type(value) is int and value >= 0 for value in point.values()), "Invalid supplemental kernel gauge")
                projected["components"][role] = point
                maxima = peaks.setdefault(role, {key: 0 for key in point})
                for key, value in point.items():
                    maxima[key] = max(maxima[key], value)
            require(projected["components"], "Resource observation has no owned components")
            encoded.write(json.dumps(projected, separators=(",", ":"), allow_nan=False).encode() + b"\n")
            samples += 1
    require(samples > 1 and target.stat().st_size <= 1024 ** 2, "Missing or excessive public resource evidence")
    with target.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"samples": samples, "maximum_gap_seconds": maximum_gap, "component_peaks": peaks,
            "public_file": target.name, "compressed_bytes": target.stat().st_size, "sha256": digest,
            "scope": "Numeric cgroup projection only; private resource/log/SQL fields are excluded."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--full", action="store_true")
    args = parser.parse_args()
    available = inventory()
    require(available["cpu_affinity_slots"] >= 4 and not docker("ps", "-aq") and not docker("volume", "ls", "-q"),
            "Supplemental probes require their empty disposable four-CPU Docker VM")
    run, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch("[0-9]{1,20}", run) is not None and re.fullmatch("[0-9]{1,4}", attempt) is not None,
            "Missing supplemental workflow identity")
    identity = "native-matrix-" + run + "-" + attempt
    budget = kernel_budget(run + "-" + attempt)
    provenance = read_receipt(ROOT / "docs/goals/results/stress/final-local-candidate.json")
    native = read_receipt(ROOT / "docs/goals/results/stress/native-final-suite/index.json")
    proof = input_artifact(args.artifact, provenance, native)
    (args.artifact / "nelcota").chmod(0o555)
    output = ROOT / "target/stress-g05" / identity
    private = output.with_name(output.name + "-operator")
    public = output.with_name(output.name + "-public")
    require(not output.exists() and not private.exists() and not public.exists(), "Preserve prior supplemental evidence")
    private.mkdir(mode=0o700, parents=True)
    began = time.monotonic()
    report = {"identity": identity, "source": available["source"], "binary_sha256": proof["binary_sha256"],
              "scenario": "supplemental-backend-matrix", "certifies_g05": False, "status": "failed",
              "cleanup_confirmed": False, "resource_samples": 0, "completed_effective_load_seconds": 0,
              "checks": {"product_artifact": proof, "controller_kernel_budget": budget, "profile": PROFILE,
                         "full_profile": args.full, "local_load_checkpoint_credit_seconds": 0,
                         "cases": {}, "foreground_phases": {}, "scope": "Separate disposable backend diagnostic; overlapping remote time is excluded from the local eight-hour checkpoint."}}
    command = campaign_arguments(args.artifact.resolve()/'nelcota', identity, args.full)
    step = 20
    if args.full:
        step = 120
        report['checks']['capacity_profile'] = capacity_profile()
    child = None
    try:
        images = {}
        for image in ["ubuntu:24.04", "postgres:17-alpine"]:
            docker("pull", image)
            state = json.loads(docker("image", "inspect", image))[0]
            images[image] = {"id": state["Id"], "repo_digests": state["RepoDigests"], "size_bytes": state["Size"]}
        report["checks"]["images"] = images
        with (private / "campaign.private.log").open("x") as log:
            child = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 2450
            while child.poll() is None:
                require((private / "campaign.private.log").stat().st_size <= 16 * 1024 ** 2,
                        "Supplemental private log reached its byte ceiling")
                require(time.monotonic() <= deadline, "Supplemental launcher reached its duration ceiling")
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        require(child.returncode == 0, "Supplemental campaign failed")
        completion = read_receipt(output / "completion.json")
        clean = read_receipt(output / "cleanup.json")
        violations = read_receipt(output / "resource-violations.json")
        report["checks"]["original_completion"] = completion
        require(completion["status"] == "passed" and completion["cleanup_confirmed"] is True
                and clean["confirmed"] is True and not violations, "Supplemental resource/cleanup gates failed")
        for name in PROFILE["scenarios"]:
            probes = read_receipt(output / ("matrix-" + name + "-probes.json"))
            foreground = read_receipt(output / ("matrix-" + name + ".json"))
            require(probes["status"] == "passed" and foreground["nominal_qualified"] is True
                    and foreground["requested_seconds"] == step and foreground["elapsed_seconds"] >= step,
                    "Supplemental case or nominal foreground evidence is incomplete")
            if args.full:
                require(foreground['supplemental_action']['entire_action_within_offered_window'] is True,
                        'Full supplemental action extended beyond its offered ledger traffic')
            report["checks"]["cases"][name] = probes
            report["checks"]["foreground_phases"][name] = foreground
        report["resource_samples"] = completion["resource_observations"]
        report["completed_effective_load_seconds"] = completion["load_seconds"]
        report["checks"]["capacity"] = None
        if args.full:
            report["checks"]["capacity"] = read_receipt(output / "capacity.json")
            probes = read_receipt(output / 'capacity-probes.json')
            report['checks']['capacity_probes'] = capacity_probe_evidence(probes)
        for name in ["invariants.json", "restore.json", "lost-commit-replies.json", "launch-manifest.json"]:
            report["checks"][name] = read_receipt(output / name)
        with (output / "resources.jsonl").open("rb") as stream:
            report["checks"]["private_resource_series_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = {"type": type(error).__name__}
        path = output / 'capacity-probes.json'
        if path.is_file():
            report['checks']['capacity_probes'] = read_receipt(path)
        preparation = output / 'preparation-failure.json'
        if preparation.exists():
            from project_diagnostics import validate as validate_setup
            try:
                value = read_receipt(preparation)
                require(set(value)=={'phase','source','target'} and value['phase']=='preparation', 'Unknown setup diagnostic envelope')
                report['checks']['preparation_failure'] = {'phase':'preparation',
                    'source':validate_setup(value['source']), 'target':validate_setup(value['target'])}
            except Exception:
                report['checks']['preparation_diagnostic_invalid'] = True
        failure = output / "matrix-failure.json"
        if failure.is_file():
            report["checks"]["failed_supplemental_probe"] = read_receipt(failure)
        for name in PROFILE["scenarios"]:
            path = output / ("matrix-" + name + "-probes.json")
            if path.is_file():
                report["checks"]["cases"].setdefault(name, read_receipt(path))
            path = output / ("matrix-" + name + ".json")
            if path.is_file():
                report["checks"]["foreground_phases"].setdefault(name, read_receipt(path))
        path = output / "completion.json"
        if path.is_file():
            completion = read_receipt(path)
            report["checks"]["original_completion"] = completion
            report["resource_samples"] = completion["resource_observations"]
            report["completed_effective_load_seconds"] = completion["load_seconds"]
    finally:
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                child.wait(timeout=60)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
        ownership = output / "ownership.json"
        owner_released = True
        if ownership.is_file():
            manifest = read_receipt(ownership)
            cleanup(manifest)
            owner_released = process_identity(manifest["pid"]) != manifest["process_identity"]
        # Preflight refused every pre-existing container, and cleanup only used
        # the manifest's nonce/label ownership checks. This is read-only census.
        report["cleanup_confirmed"] = owner_released and not docker("ps", "-aq") and not docker("volume", "ls", "-q")
        if not report["cleanup_confirmed"]:
            report["status"] = "failed"
        report["elapsed_seconds_including_preparation"] = time.monotonic() - began
        public.mkdir(mode=0o755)
        if (output / "resources.jsonl").is_file():
            try:
                resource = export_resources(output / "resources.jsonl", public)
                report["checks"]["resource_evidence"] = resource
                require(resource["samples"] == report["resource_samples"] and resource["maximum_gap_seconds"] <= 30,
                        "Public resource coverage disagrees with completed campaign evidence")
            except Exception as error:
                report["status"] = "failed"
                report["checks"]["resource_publication_failure"] = {"type": type(error).__name__}
        atomic_json(public / "matrix.json", report)
        (public / "matrix.json").chmod(0o644)
        publish(report)
    require(report["status"] == "passed", "Supplemental matrix did not pass")


if __name__ == "__main__":
    main()
