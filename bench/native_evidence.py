#!/usr/bin/env python3
"""Publish bounded, lossless Actions notices for an already-public VM report."""

import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re

FIELDS = {"identity", "source", "binary_sha256", "scenario", "cluster_routing", "native_contract", "clock_drift", "certifies_g05", "checks", "image", "image_checksum_manifest",
          "native_init", "tls_ca_sha256", "status", "failure", "guest_diagnostics",
          "diagnostic_failure_type", "elapsed_seconds_including_preparation", "resource_samples",
          "cleanup_confirmed", "cleanup_scope", "safety_guard_failure", "backup",
          "restore_elapsed_seconds", "completed_effective_load_seconds", "power_cut_unit_state",
          "guest_power_cut_recovery_seconds", "power_cut_reconciliation", "in_flight_cut_control", "idle_resources", "native_remove"}


def notices(report):
    if not isinstance(report, dict) or set(report) - FIELDS:
        raise ValueError("Unknown native report fields; refusing publication")
    if report.get("certifies_g05") is not False or report.get("status") not in {"passed", "failed"}:
        raise ValueError("Invalid native report verdict")
    if not isinstance(report.get("cleanup_confirmed"), bool):
        raise ValueError("Missing native cleanup receipt")
    if not isinstance(report.get("source"), str) or re.fullmatch(r"[0-9a-f]{40}", report["source"]) is None:
        raise ValueError("Missing immutable native report source")
    if "binary_sha256" in report:
        if not isinstance(report["binary_sha256"], str) or re.fullmatch(r"[0-9a-f]{64}", report["binary_sha256"]) is None:
            raise ValueError("Invalid native artifact digest")
    text = json.dumps(report, separators=(",", ":"), allow_nan=False)
    if len(text.encode()) > 64 * 1024:
        raise ValueError("Native report exceeds the notice boundary")
    digest = hashlib.sha256(text.encode()).hexdigest()
    transport = base64.b64encode(gzip.compress(text.encode(), mtime=0)).decode("ascii")
    fragments = [transport[index:index + 3000] for index in range(0, len(transport), 3000)]
    # Actions also limits annotations per step. Reserve one of ten for summary.
    if len(fragments) > 9:
        raise ValueError("Native report exceeds the per-step annotation count")
    output = []
    summary = {key: report.get(key) for key in ["identity", "source", "status", "failure", "cleanup_confirmed",
                                               "resource_samples", "elapsed_seconds_including_preparation"]}
    summary["report_sha256"] = digest
    output.append(("Native VM summary", summary))
    for index, fragment in enumerate(fragments, 1):
        output.append(("Native VM evidence", {"part": index, "parts": len(fragments), "sha256": digest,
                                              "encoding": "gzip+base64", "payload": fragment}))
    values = []
    for title, value in output:
        encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
        encoded = encoded.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        line = "::notice title=" + title + "::" + encoded
        if len(line.encode()) > 4000:
            raise ValueError("Native notice exceeds the Actions annotation limit")
        values.append(line)
    return values


def publish(report):
    for line in notices(report):
        print(line, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--profile", action="store_true")
    args = parser.parse_args()
    if args.report.is_symlink() or not args.report.is_file() or args.report.stat().st_size > 128 * 1024:
        raise SystemExit("Native public report is missing or exceeds its file boundary")
    raw = args.report.read_bytes()
    value = json.loads(raw)
    if args.profile:
        if not isinstance(value.get("source"), str) or re.fullmatch(r"[0-9a-f]{40}", value["source"]) is None:
            raise SystemExit("Invalid prior native profile source")
        if not isinstance(value.get("binary_sha256"), str) or re.fullmatch(r"[0-9a-f]{64}", value["binary_sha256"]) is None:
            raise SystemExit("Invalid prior native profile artifact")
        projection = {"source": value["source"], "binary_sha256": value["binary_sha256"],
                      "profile_file_sha256": hashlib.sha256(raw).hexdigest(),
                      "scenario": value.get("scenario", "runtime"),
                      "scope": "Artifact identity from the original public predeclared native profile; no verdict is changed"}
        if projection["scenario"] not in {"runtime", "runtime-inflight", "runtime-pitr-error", "runtime-pitr-reboot", "cluster-routing", "default-root", "host-root", "clock-drift", "remove-boundary"}:
            raise SystemExit("Invalid prior native scenario")
        print("::notice title=Native VM profile::" + json.dumps(projection, separators=(",", ":")), flush=True)
        raise SystemExit(0)
    publish(value)
