"""Supplemental network probes stay bounded and release failed HTTP owners."""
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import matrix_pressure as matrix
import matrix_probe as runner


class SupplementalProbeGuards(unittest.TestCase):
    def test_completed_action_after_foreground_drain_is_not_full_overlap(self):
        self.assertTrue(matrix.action_window(12, 129, 10, 120)['entire_action_within_offered_window'])
        value = matrix.action_window(12, 131, 10, 120)
        self.assertFalse(value['entire_action_within_offered_window'])
        self.assertEqual(value['duration_seconds'], 119)

    def test_invalid_or_reversed_action_clocks_cannot_approve_overlap(self):
        for started, ended, phase, seconds in [(12, float('nan'), 10, 120), (12, 13, 10, True),
                                               (12, 11, 10, 120), (9, 12, 10, 120)]:
            with self.subTest(started=started, ended=ended), self.assertRaises(RuntimeError):
                matrix.action_window(started, ended, phase, seconds)

    def project(self, base="http://127.0.0.1:19000"):
        return SimpleNamespace(base=base, fixture={"cookie": "private-cookie", "service": "private-token"})

    def test_foreign_targets_are_rejected_before_any_network(self):
        for base in ["https://127.0.0.1:19000", "http://example.test", "http://127.0.0.1:19000/path",
                     "http://private-cookie@127.0.0.1:19000", "http://127.0.0.1:19000?token=private-token"]:
            with self.subTest(base=base), patch.object(matrix.http.client, "HTTPConnection") as transport:
                with self.assertRaisesRegex(RuntimeError, "owned loopback"):
                    matrix.Probes(self.project(base), Path("."), Mock())
                transport.assert_not_called()

    def test_admission_is_shared_across_concurrent_secondary_probes(self):
        probes = matrix.Probes(self.project(), Path("."), Mock())
        probes.requests = matrix.PROFILE["maximum_requests"] - 1
        def attempt(_):
            try:
                probes.open("GET", "/rest/v1/bench_products")
                return True
            except RuntimeError:
                return False
        with patch.object(matrix.http.client, "HTTPConnection") as transport:
            with ThreadPoolExecutor(max_workers=4) as pool:
                self.assertEqual(sum(pool.map(attempt, range(16))), 1)
            self.assertEqual(transport.call_count, 1)
        self.assertEqual(probes.requests, matrix.PROFILE["maximum_requests"])

    def test_failed_or_oversized_reads_close_their_connection(self):
        probes = matrix.Probes(self.project(), Path("."), Mock())
        connection = Mock()
        connection.getresponse.return_value.read.return_value = b"x" * (matrix.PROFILE["maximum_read_bytes"] + 1)
        with patch.object(probes, "open", return_value=connection):
            with self.assertRaisesRegex(RuntimeError, "response exceeded"):
                probes.read("GET", "/owned")
        connection.close.assert_called_once()
        connection.getresponse.return_value.close.assert_called_once()
        connection.reset_mock()
        connection.getresponse.side_effect = TimeoutError("private transport detail")
        with patch.object(probes, "open", return_value=connection):
            with self.assertRaises(TimeoutError):
                probes.read("GET", "/owned")
        connection.close.assert_called_once()

    def test_stopped_traffic_or_invalid_paths_never_open_a_socket(self):
        guard = Mock(side_effect=RuntimeError("guard stopped"))
        probes = matrix.Probes(self.project(), Path("."), guard)
        with patch.object(matrix.http.client, "HTTPConnection") as transport:
            with self.assertRaisesRegex(RuntimeError, "guard stopped"):
                probes.open("POST", "/admin/api/sql", {})
            transport.assert_not_called()
        guard.side_effect = None
        for path in ["//example.test/", "/owned\r\nAuthorization: private", "https://example.test/"]:
            with self.subTest(path=path), patch.object(matrix.http.client, "HTTPConnection") as transport:
                with self.assertRaisesRegex(RuntimeError, "Invalid bounded"):
                    probes.open("GET", path)
                transport.assert_not_called()

    def test_failure_receipts_retain_case_and_location_without_exception_payloads(self):
        try:
            matrix.require(False, "private-cookie must stay private")
        except RuntimeError as error:
            value = matrix.failure_receipt(error, "admin-cancellation")
        self.assertEqual(value["case"], "admin-cancellation")
        self.assertEqual(value["type"], "RuntimeError")
        self.assertTrue(any(row["file"] == "matrix_pressure.py" for row in value["locations"]))
        self.assertNotIn("private-cookie", str(value))

    def test_a_guard_stop_closes_both_partial_header_and_body_sockets(self):
        guard = Mock(side_effect=[None, None, RuntimeError("guard stopped")])
        probes = matrix.Probes(self.project(), Path("."), guard)
        first, second = Mock(), Mock()
        with patch.object(matrix.socket, "create_connection", side_effect=[first, second]):
            with self.assertRaisesRegex(RuntimeError, "guard stopped"):
                probes.slow_header_body_pair()
        for connection in [first, second]:
            connection.sendall.assert_called_once()
            connection.close.assert_called_once()
        self.assertEqual(probes.requests, 2)

    def test_changed_product_trees_or_wrong_retained_bytes_prevent_fixture_start(self):
        source, digest = "a" * 40, "b" * 64
        provenance = {"source_commit": source, "product_tree_objects": {name: "c" * 40 for name in runner.PRODUCT_PATHS}}
        native = {"source_commit": source, "status": "passed", "total_cases": 12,
                  "common_elf_verified": True, "binary_sha256": digest, "common_executable_size_bytes": 100,
                  "workflow_run_id": 123}
        artifact = {"source_commit": source, "binary_sha256": digest, "size_bytes": 100}
        def git_value(arguments, **_):
            if arguments[1] == "status":
                return ""
            return "d" * 40
        with patch.object(runner, "artifact", return_value=artifact), patch.object(runner.subprocess, "check_output", side_effect=git_value):
            with self.assertRaisesRegex(RuntimeError, "Product sources changed"):
                runner.input_artifact(Path("."), provenance, native)
        with patch.object(runner, "artifact", return_value={**artifact, "binary_sha256": "e" * 64}), \
                patch.object(runner.subprocess, "check_output") as git:
            with self.assertRaisesRegex(RuntimeError, "differs from retained"):
                runner.input_artifact(Path("."), provenance, native)
            git.assert_not_called()

    def test_public_resource_projection_omits_private_fields_and_keeps_actual_gauges(self):
        values = {"memory.current": 100, "memory.peak": 200, "memory.stat": {"anon": 50},
                  "pids.current": 4, "memory.events": {"oom": 0, "oom_kill": 0}, "cpu.stat": {"throttled_usec": 10}}
        row = {"monotonic": 10, "phase": "matrix-admin-budgets", "private": "must-stay-private",
               "component_cgroups": {"owned-app-0": values}}
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "source.jsonl"
            source.write_text(json.dumps(row) + "\n" + json.dumps({**row, "monotonic": 15}) + "\n")
            result = runner.export_resources(source, root)
            body = gzip.decompress((root / result["public_file"]).read_bytes()).decode()
        self.assertEqual((result["samples"], result["maximum_gap_seconds"]), (2, 5))
        self.assertEqual(result["component_peaks"]["app-0"]["anonymous_bytes"], 50)
        self.assertNotIn("must-stay-private", body)

    def test_dirty_product_checkout_is_refused_even_when_head_objects_match(self):
        source, digest = "a" * 40, "b" * 64
        provenance = {"source_commit": source, "product_tree_objects": {name: "c" * 40 for name in runner.PRODUCT_PATHS}}
        native = {"source_commit": source, "status": "passed", "total_cases": 12,
                  "common_elf_verified": True, "binary_sha256": digest, "common_executable_size_bytes": 100,
                  "workflow_run_id": 123}
        with patch.object(runner, "artifact", return_value={"binary_sha256": digest, "size_bytes": 100}), \
                patch.object(runner.subprocess, "check_output", return_value=" M crates/admin/src/sql/executor.rs\n") as git:
            with self.assertRaisesRegex(RuntimeError, "working tree"):
                runner.input_artifact(Path("."), provenance, native)
            self.assertEqual(git.call_count, 1)
            self.assertEqual(git.call_args.args[0][:4], ["git", "status", "--porcelain", "--"])

    def test_explicit_browser_resource_roles_cannot_publish_a_foreign_component(self):
        values = {"memory.current": 100, "memory.peak": 200, "memory.stat": {"anon": 50},
                  "pids.current": 4, "memory.events": {"oom": 0, "oom_kill": 0}, "cpu.stat": {"throttled_usec": 10}}
        row = {"monotonic": 10, "phase": "live-panel-SDK", "component_cgroups": {"foreign-app-0": values}}
        with tempfile.TemporaryDirectory() as root:
            root = Path(root);source = root / "source.jsonl"
            source.write_text(json.dumps(row) + "\n")
            with self.assertRaisesRegex(RuntimeError, "owned browser component"):
                runner.export_resources(source, root, {"owned-app-0": "app-0"})

    def test_browser_phase_alias_preserves_numeric_owners_without_private_fields(self):
        values = {"memory.current": 100, "memory.peak": 200, "memory.stat": {"anon": 50},
                  "pids.current": 4, "memory.events": {"oom": 0, "oom_kill": 0}, "cpu.stat": {"throttled_usec": 10}}
        row = {"monotonic": 10, "phase": "live-panel-SDK", "private": "must-stay-private",
               "component_cgroups": {"owned-proxy": values, "browser": values}}
        with tempfile.TemporaryDirectory() as root:
            root = Path(root);source = root / "source.jsonl"
            source.write_text(json.dumps(row) + "\n" + json.dumps({**row, "monotonic": 15}) + "\n")
            result = runner.export_resources(source, root, {"owned-proxy": "proxy", "browser": "browser"})
            body = gzip.decompress((root / result["public_file"]).read_bytes()).decode()
        self.assertEqual(result["samples"], 2)
        self.assertEqual(set(result["component_peaks"]), {"proxy", "browser"})
        self.assertEqual(json.loads(body.splitlines()[0])["phase"], "live-panel-sdk")
        self.assertNotIn("must-stay-private", body)

    def test_invalid_resource_times_cannot_create_a_passing_summary(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "source.jsonl"
            source.write_text(json.dumps({"monotonic": float("nan"), "phase": "baseline"}) + "\n")
            with self.assertRaisesRegex(RuntimeError, "Invalid supplemental observation"):
                runner.export_resources(source, root)

    def test_late_successful_censuses_cannot_bypass_the_declared_deadline(self):
        project = self.project()
        project.sql = Mock(return_value="0")
        probes = matrix.Probes(project, Path("."), Mock())
        with patch.object(matrix.time, "monotonic", side_effect=[10, 14]):
            with self.assertRaisesRegex(RuntimeError, "deadline exceeded"):
                probes.wait_connections("nelcota-admin-sql", 0, 3)
        table = "matrix_catalog_" + "a" * 16
        with patch.object(probes, "json", return_value=(200, {"tables": [{"name": table}]})), \
                patch.object(matrix.time, "monotonic", side_effect=[10, 16]):
            with self.assertRaisesRegex(RuntimeError, "did not discover"):
                probes.wait_table(table)

    def test_complete_export_rejects_duplicate_foreign_or_changed_rows(self):
        rows = [{"id": i, "name": "project-0:" + str(i), "stock": i % 50} for i in range(1, 1001)]
        self.assertTrue(matrix.export_matches("project-0", rows))
        self.assertFalse(matrix.export_matches("project-0", rows[:-1]))
        self.assertFalse(matrix.export_matches("project-0", [rows[0], *rows[:-1]]))
        for changed in [{**rows[0], "name": "project-1:1"}, {**rows[0], "stock": 2},
                        {**rows[0], "id": float("nan")}, {**rows[0], "private": "must stay private"}]:
            with self.subTest(changed=changed):
                self.assertFalse(matrix.export_matches("project-0", [changed, *rows[1:]]))


if __name__ == "__main__":
    unittest.main()
