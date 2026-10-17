#!/usr/bin/env python3
"""Repeat the real native-identity unit test on its disposable bounded CI VM."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
NAME = "updates::runtime::tests::running_native_identity_rejects_replacement_even_with_the_same_hash"
REPETITIONS = 1000
MAXIMUM_SECONDS = 240


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def executable(build):
    require(not build.is_symlink() and build.is_file() and build.stat().st_size <= 16 * 1024 ** 2,
            "Missing bounded compiler artifact index")
    values = []
    for line in build.read_text().splitlines():
        row = json.loads(line)
        if row.get("reason") != "compiler-artifact" or row.get("target", {}).get("name") != "nelcota_cli":
            continue
        if row.get("profile", {}).get("test") is not True or not isinstance(row.get("executable"), str):
            continue
        path = Path(row["executable"])
        require(not path.is_symlink(), "Refusing a redirected test executable")
        path = path.resolve(strict=True)
        require(path.parent == ROOT / "target/debug/deps" and path.is_file(), "Unknown test executable boundary")
        values.append(path)
    require(len(values) == 1, "Expected exactly one compiled CLI unit executable")
    return values[0]


def child_budget():
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 ** 2, 1024 ** 2))


def repeat(binary, locations):
    began = time.monotonic()
    result = {"requested_repetitions": REPETITIONS, "attempted": 0, "passed": 0, "status": "failed"}
    for _ in range(REPETITIONS):
        if time.monotonic() - began >= MAXIMUM_SECONDS:
            result["failure_category"] = "duration_limit"
            break
        with tempfile.TemporaryFile() as output:
            try:
                process = subprocess.run([str(binary), NAME, "--exact", "--test-threads=1", "--nocapture"],
                                         stdout=output, stderr=subprocess.STDOUT, timeout=10, preexec_fn=child_budget)
            except subprocess.TimeoutExpired:
                result["failure_category"] = "unit_timeout"
                result["attempted"] += 1
                break
            result["attempted"] += 1
            require(output.tell() <= 1024 ** 2, "Identity output exceeded its private byte budget")
            output.seek(0)
            text = output.read().decode(errors="replace")
        require("running 1 test" in text, "Filtered identity test did not execute")
        if process.returncode != 0:
            result["failure_category"] = "unit_failure"
            result["panic_locations"] = locations(text)
            break
        require("1 passed; 0 failed" in text, "Missing exact unit completion receipt")
        result["passed"] += 1
    result["elapsed_seconds"] = time.monotonic() - began
    if result["passed"] == REPETITIONS:
        result["status"] = "passed"
    return result


def main():
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "Identity repetition requires the disposable Actions VM")
    source = os.environ.get("GITHUB_SHA", "")
    require(re.fullmatch("[0-9a-f]{40}", source) is not None, "Missing frozen repetition source")
    relative = next(line.split(":", 2)[2] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    cgroup = (Path("/sys/fs/cgroup") / relative.lstrip("/")).resolve(strict=True)
    require(cgroup.is_relative_to("/sys/fs/cgroup") and any(part.startswith("g05-identity-") and part.endswith(".service") for part in cgroup.parts),
            "Identity repetition requires its owned systemd budget")
    quota, period = (cgroup / "cpu.max").read_text().split()
    require(quota.isdigit() and int(quota) == 2 * int(period) and
            (cgroup / "memory.max").read_text().strip() == str(4 * 1024 ** 3) and
            (cgroup / "memory.swap.max").read_text().strip() == "0" and
            (cgroup / "pids.max").read_text().strip() == "128", "Identity kernel budget differs from its profile")
    spec = importlib.util.spec_from_file_location("ci_diagnostics", ROOT / "scripts/report-ci-diagnostics.py")
    diagnostics = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(diagnostics)
    binary = executable(ROOT / "target/native-identity-build.jsonl")
    with binary.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    report = repeat(binary, diagnostics.panic_locations)
    report.update(source=source, test=NAME, test_binary_sha256=digest, certifies_g05=False,
                  scope="Repeated real unit test only; no BaaS traffic or endurance credit; production identity validation remains fail-closed",
                  profile={"cpu": 2, "memory_mib": 4096, "swap_mib": 0, "tasks": 128, "unit_timeout_seconds": 10,
                           "maximum_seconds": MAXIMUM_SECONDS, "external_runtime_max_seconds": 300, "test_threads": 1})
    path = ROOT / "target/native-identity-public.json"
    require(not path.exists(), "Preserve previous identity evidence")
    path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    message = json.dumps(report, separators=(",", ":"), allow_nan=False).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    require(len(message.encode()) <= 3900, "Identity public notice exceeded its budget")
    print("::notice title=Native executable identity repetitions::" + message, flush=True)
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("::error title=Identity repetition control failed::" + type(error).__name__, flush=True)
        raise SystemExit(1)
