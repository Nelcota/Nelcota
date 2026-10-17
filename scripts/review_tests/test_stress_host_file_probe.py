"""Disposable preflight must retain ownership, resource and publication gates."""
import base64
import copy
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import host_file_probe as probe
import fleet_private_files as private


class HostFilePreflight(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "owned-host-files"
        self.root.mkdir()
        self.identity = "nelcota-fleet-" + "a" * 32

    def manifest(self):
        identity = self.identity
        return {"identity": identity, "output": str(self.root), "reserve_path": str(self.root),
                "pid": 12345, "process_identity": "123", "started_monotonic": 100,
                "maximum_seconds": 7200, "preparation_seconds": 900,
                "containers": [identity + "-metrics", identity + "-load", identity + "-app-0", identity + "-pg-0"],
                "volumes": [identity + "-metrics-data", identity + "-data-0"]}

    def lease(self, value):
        with patch.object(probe, "process_identity", return_value="123"), patch.object(probe.os, "getpgid", return_value=1234):
            return probe.checked_lease(value, self.root, 1, 1234, 101)

    def test_preflight_is_explicitly_short_and_keeps_private_traffic_on_both_topologies(self):
        self.assertEqual(probe.CASES, [(1, 4, "quota"), (5, 1, "shared")])
        for projects, rate, policy in probe.CASES:
            cmd = probe.campaign_arguments(Path("/owned/nelcota"), "owned-host-files", projects, rate, policy)
            self.assertIn("--private-file-isolation", cmd)
            self.assertEqual(cmd[cmd.index("--seconds") + 1], "60")
            self.assertEqual(cmd[cmd.index("--disk-mib") + 1], "1536")
            self.assertNotIn("--capacity", cmd)
        with self.assertRaises(RuntimeError):
            probe.campaign_arguments(Path("/owned/nelcota"), "owned-host-files", 10, 1, "shared")

    def test_insufficient_host_CPU_fails_before_any_Docker_or_artifact_work(self):
        with patch.object(sys, "argv", ["host_file_probe.py", "--artifact", str(self.root)]), \
                patch.object(probe, "inventory", return_value={"cpu_affinity_slots": 4}), \
                patch.object(probe, "effective_cpus", return_value=3.5), patch.object(probe, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "empty disposable Docker VM"):
                probe.main()
        docker.assert_not_called()

    def test_lease_only_tightens_a_fresh_owned_case_deadline(self):
        original = self.manifest()
        actual = self.lease(original)
        self.assertEqual(actual, {**original, "maximum_seconds": 1200})
        self.assertEqual(original["maximum_seconds"], 7200)

    def test_foreign_duplicate_stale_or_reused_owner_cannot_get_a_cleanup_lease(self):
        for change in [{"identity": "foreign"}, {"output": "/foreign"}, {"reserve_path": "/foreign"},
                       {"containers": ["foreign"]}, {"volumes": ["foreign"]},
                       {"containers": self.manifest()["containers"] * 2}, {"started_monotonic": 1},
                       {"started_monotonic": float("nan")}, {"maximum_seconds": 1201},
                       {"process_identity": "reused"}, {"pid": True}]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.lease({**self.manifest(), **change})
        with patch.object(probe, "process_identity", return_value="123"), patch.object(probe.os, "getpgid", return_value=999):
            with self.assertRaisesRegex(RuntimeError, "launcher session"):
                probe.checked_lease(self.manifest(), self.root, 1, 1234, 101)

    def test_watchdog_is_a_separate_bounded_unit_and_rejects_foreign_namespace(self):
        cmd = probe.watch_command("g05-host-files-watch-123-1-5", self.root / "lease.json", 3)
        for flag in ["--unit=g05-host-files-watch-123-1-5", "--property=CPUQuota=5%", "--property=MemoryMax=128M",
                     "--property=MemorySwapMax=0", "--property=RuntimeMaxSec=1500", "--property=CPUAffinity=3"]:
            self.assertIn(flag, cmd)
        self.assertNotIn("--scope", cmd)
        for unit in ["g05-host-files-123-1", "foreign", "g05-host-files-watch-123-1-10"]:
            with self.subTest(unit=unit), self.assertRaises(RuntimeError):
                probe.watch_command(unit, self.root / "lease.json", 3)

    def test_stop_refuses_foreign_unit_description(self):
        with patch.object(probe.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="foreign")) as run:
            with self.assertRaisesRegex(RuntimeError, "another systemd unit"):
                probe.stop_watch("g05-host-files-watch-123-1-5")
        self.assertEqual(run.call_count, 1)

    def test_dead_independent_watchdog_stops_qualification(self):
        with patch.object(probe.subprocess, "run", return_value=SimpleNamespace(returncode=3)):
            with self.assertRaisesRegex(RuntimeError, "exited during foreground"):
                probe.require_watch("g05-host-files-watch-123-1-5")

    def test_kernel_controller_quota_leaves_space_for_telemetry_watchdog_and_OS(self):
        cgroup = self.root / "cgroup"
        unit = cgroup / "g05-host-files-123-1.service"
        unit.mkdir(parents=True)
        for name, value in {"cpu.max": "50000 100000", "memory.max": str(512 * 1024 ** 2),
                            "memory.swap.max": "0", "pids.max": "128"}.items():
            (unit / name).write_text(value)
        proc = self.root / "proc-cgroup"
        proc.write_text("0::/g05-host-files-123-1.service\n")

        def mapped(value):
            if value == "/proc/self/cgroup":
                return proc
            if value == "/sys/fs/cgroup":
                return cgroup
            return Path(value)

        with patch.object(probe, "Path", side_effect=mapped):
            actual = probe.kernel_budget("123-1")
            self.assertEqual(actual["cpu_quota_usec"], 50000)
            policy = actual["CPU_policy"]
            self.assertAlmostEqual(policy["telemetry"] + policy["controller"] + policy["independent_watchdog"] +
                                   policy["telemetry_slot_OS_reserve"], 1)
            (unit / "cpu.max").write_text("100000 100000")
            with self.assertRaisesRegex(RuntimeError, "budget differs"):
                probe.kernel_budget("123-1")

    def rows(self):
        point = {"memory.current": 10, "memory.peak": 20, "memory.stat": {"anon": 5}, "pids.current": 3,
                 "memory.events": {"oom": 0, "oom_kill": 0}, "private": "never publish"}
        roles = {self.identity + "-" + role: copy.deepcopy(point) for role in ["app-0", "pg-0", "metrics"]}
        return [{"monotonic": now, "phase": "balanced-1", "component_cgroups": copy.deepcopy(roles),
                 "private": "never publish"} for now in [1, 6]]

    def export(self, rows):
        source = self.root / "raw.jsonl"
        source.write_text("".join(json.dumps(row) + "\n" for row in rows))
        destination = self.root / "resources.jsonl.gz"
        destination.unlink(missing_ok=True)
        return probe.export_resources(source, destination, 1), destination

    def test_resource_projection_has_complete_roles_and_no_private_fields(self):
        report, destination = self.export(self.rows())
        decoded = gzip.decompress(destination.read_bytes())
        self.assertNotIn(b"private", decoded)
        self.assertNotIn(b"never publish", decoded)
        self.assertEqual(report["samples"], 2)
        self.assertEqual(report["maximum_gap_seconds"], 5)
        self.assertEqual(report["sha256"], hashlib.sha256(destination.read_bytes()).hexdigest())

    def test_incomplete_nonfinite_or_unknown_component_series_cannot_certify(self):
        missing = self.rows(); missing[0]["component_cgroups"].pop(self.identity + "-pg-0")
        foreign = self.rows(); foreign[0]["component_cgroups"]["foreign"] = {}
        nan = self.rows(); nan[0]["monotonic"] = float("nan")
        negative = self.rows(); negative[0]["component_cgroups"][self.identity + "-app-0"]["pids.current"] = -1
        for rows in [missing, foreign, nan, negative, self.rows()[:1], list(reversed(self.rows()))]:
            with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                self.export(rows)

    def failure(self):
        counts = dict.fromkeys(private.COUNTS, 0); counts["projects"] = 1
        return {"status": "failed", "protocol": private.PROTOCOL, "failure_type": "RuntimeError", "counts": counts,
                "requests_total": 1, "logical_HTTP_bytes_total": 10, "run_id": self.root.name, "phase": "before"}

    def test_original_failed_graph_counts_remain_visible(self):
        value = self.failure()
        (self.root / "private-isolation-before.json").write_text(json.dumps(value))
        self.assertEqual(probe.partial_receipts(self.root, 1), [value])
        with self.assertRaises(RuntimeError):
            private.validate_receipt(value, 1, during_load=False)

    def test_private_or_invalid_partial_failure_receipts_are_not_published(self):
        for change in [{"token": "must never publish"}, {"failure_type": "contains private data"},
                       {"requests_total": True}, {"run_id": "another-run"},
                       {"counts": {**self.failure()["counts"], "requests": float("nan")}}]:
            (self.root / "private-isolation-before.json").write_text(json.dumps({**self.failure(), **change}))
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                probe.partial_receipts(self.root, 1)

    def test_notice_transport_round_trip_preserves_the_failed_original_verdict(self):
        original = {"identity": "host-files-123-1", "source": "a" * 40, "binary_sha256": "b" * 64,
                    "certifies_g05": False, "status": "failed", "cleanup_confirmed": True,
                    "checks": {"scope": probe.PROFILE_SCOPE, "cases": [self.failure()]}}
        lines = probe.public_notices(original)
        self.assertTrue(all(line.startswith("::notice title=Host file isolation ") for line in lines))
        parts = [json.loads(line.split("::", 2)[2]) for line in lines[1:]]
        raw = gzip.decompress(base64.b64decode("".join(part["payload"] for part in parts)))
        self.assertEqual(json.loads(raw), original)
        self.assertTrue(all(part["sha256"] == hashlib.sha256(raw).hexdigest() for part in parts))

    def test_invalid_evidence_cannot_prevent_cleanup_of_an_owned_watchdog(self):
        case = {"status": "passed", "cleanup_confirmed": False}
        with patch.object(probe, "partial_receipts", side_effect=RuntimeError("private value must not be published")), \
                patch.object(probe, "read_receipt", return_value={"confirmed": True}), \
                patch.object(probe, "docker", return_value=""), patch.object(probe, "stop_watch") as stop:
            self.assertFalse(probe.close_case(None, None, "g05-host-files-watch-123-1-1", self.root, 1, case))
        stop.assert_called_once_with("g05-host-files-watch-123-1-1")
        self.assertEqual(case["status"], "failed")
        self.assertTrue(case["cleanup_confirmed"])
        self.assertNotIn("private value", json.dumps(case))

    def test_incomplete_cleanup_keeps_the_independent_deadline_guard(self):
        case = {"status": "passed", "cleanup_confirmed": False}
        with patch.object(probe, "partial_receipts", return_value=[self.failure()]), \
                patch.object(probe, "read_receipt", return_value={"confirmed": False}), \
                patch.object(probe, "stop_watch") as stop:
            self.assertFalse(probe.close_case(None, None, "g05-host-files-watch-123-1-1", self.root, 1, case))
        stop.assert_not_called()
        self.assertFalse(case["cleanup_confirmed"])
        self.assertEqual(case["status"], "failed")
        self.assertEqual(case["original_private_file_receipts"], [self.failure()])


if __name__ == "__main__":
    unittest.main()
