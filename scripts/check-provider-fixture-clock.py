#!/usr/bin/env python3
"""Reproduce the old uptime-sensitive fixture, then exercise its fixed clock.

This runs pure assertions only on a disposable Actions VM. It does not offer
BaaS/provider traffic or earn endurance credit. Production validation stays
unchanged, including rejection of negative observation timestamps.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/review_tests"))
import test_stress_provider_runtime as fixture


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "Clock control requires its disposable Actions VM")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10).strip()
    require(source == os.environ.get("GITHUB_SHA"), "Clock control checkout differs from its source")
    real_clock = time.monotonic
    began = real_clock()
    case = fixture.RuntimePublication("test_missing_stale_or_partial_allocator_evidence_cannot_certify_a_case")
    bound = case.test_missing_stale_or_partial_allocator_evidence_cannot_certify_a_case
    unwrapped = bound.__wrapped__
    before = None
    with patch.object(fixture.runtime.time, "monotonic", return_value=5.0):
        try:
            unwrapped(case, None)
        except AssertionError as error:
            require("Invalid allocator observation time" in str(error), "Clock control observed another assertion failure")
            before = {"uptime_seconds": 5, "synthetic_stale_timestamp": -55,
                      "status": "failed as expected", "category": "negative_synthetic_timestamp"}
    require(before is not None, "The original short-uptime fixture failure was not reproduced")
    with patch.object(fixture.runtime.time, "monotonic", return_value=120.0):
        unwrapped(case, None)
    completed = 0
    with patch.object(fixture.runtime.time, "monotonic", return_value=5.0):
        for _ in range(1000):
            require(real_clock() - began <= 30, "Clock fixture repetition reached its time limit")
            bound()
            completed += 1
    path = ROOT / "scripts/review_tests/test_stress_provider_runtime.py"
    report = {"source_commit": source, "source_test_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
              "before": before, "unchanged_body_at_uptime120": "passed", "fixed_repetitions": completed,
              "fixed_failures": 0, "elapsed_seconds": real_clock() - began,
              "production_timestamp_validation_changed": False, "completed_effective_baas_seconds": 0,
              "scope": "Pure assertion control of the exact unwrapped test body versus its fixed-clock wrapper; not a load campaign."}
    target = ROOT / "target/stress-g05/provider-fixture-clock-public.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x") as stream:
        stream.write(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print("::notice title=Provider fixture clock control::" + json.dumps(report, separators=(",", ":"), allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
