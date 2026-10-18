#!/usr/bin/env python3
"""Read-only capacity inventory of an explicitly selected disposable Actions VM."""

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path


def command(arguments: list[str]) -> dict:
    """Return bounded tool output without installing or changing services."""
    if shutil.which(arguments[0]) is None:
        return {"available": False}
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"available": True, "failure": type(error).__name__}
    return {
        "available": True,
        "exit_code": result.returncode,
        "stdout": result.stdout.strip()[:1024],
    }


def inventory() -> dict:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("This preflight requires an explicit Actions dispatch")
    if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("Refusing to inventory an unknown or self-hosted runner")
    source = os.environ.get("GITHUB_SHA", "")
    if re.fullmatch(r"[0-9a-f]{40}", source) is None:
        raise RuntimeError("Missing immutable workflow source")
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        fields = line.split()
        if fields[0] in {"MemTotal:", "MemAvailable:"}:
            memory[fields[0].removesuffix(":")] = int(fields[1]) * 1024
    filesystem = os.statvfs(".")
    pid1 = Path("/proc/1/comm").read_text().strip()
    tools = {}
    for name in ("qemu-system-x86_64", "cloud-localds", "genisoimage", "xorriso"):
        tools[name] = shutil.which(name) is not None
    return {
        "schema": 1,
        "source": source,
        "runner_environment": "github-hosted",
        "measurement": "read-only capacity inventory; no stress or runtime acceptance",
        "cpu_affinity_slots": len(os.sched_getaffinity(0)),
        "memory_bytes": memory,
        "filesystem_free_bytes": filesystem.f_bavail * filesystem.f_frsize,
        "filesystem_free_inodes": filesystem.f_favail,
        "pid1": pid1,
        "systemd": command(["systemctl", "is-system-running"]),
        "noninteractive_sudo": command(["sudo", "-n", "true"]),
        "kvm_exists": Path("/dev/kvm").exists(),
        "kvm_read_write": os.access("/dev/kvm", os.R_OK | os.W_OK),
        "docker": command(["docker", "version", "--format", "{{.Server.Version}}"]),
        "guest_tools": tools,
    }


def main() -> None:
    started = time.monotonic()
    report = inventory()
    report["elapsed_seconds"] = time.monotonic() - started
    output = Path("target/stress-g05/native-preflight.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    # Check annotations remain useful when artifact downloads are unavailable.
    print("::notice title=Native VM inventory::" + json.dumps(report, separators=(",", ":")))


if __name__ == "__main__":
    main()
