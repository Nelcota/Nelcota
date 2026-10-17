"""Controlled native restore errors need a fail-closed, secret-safe oracle."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import native_pitr_failure as control


class NativePitrErrorControl(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.identity = "native-vm-runtime-pitr-error-123-1"

    def stopped(self):
        return {role: {"MainPID": 0, "ActiveState": "inactive"} for role in ["app", "postgres"]}

    def test_restarting_either_service_after_unknown_error_cannot_certify(self):
        self.assertTrue(control.fenced(self.stopped()))
        for role in ["app", "postgres"]:
            value = self.stopped(); value[role] = {"MainPID": 123, "ActiveState": "active"}
            self.assertFalse(control.fenced(value))
            value[role] = {"MainPID": 0, "ActiveState": "activating"}
            self.assertFalse(control.fenced(value))

    def test_missing_null_boolean_or_nonfinite_owner_counts_cannot_certify(self):
        for value in [None, {}, {"app": self.stopped()["app"]}]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                control.fenced(value)
        for pid in [None, True, float("nan"), -1]:
            value = self.stopped(); value["postgres"]["MainPID"] = pid
            with self.subTest(pid=pid), self.assertRaises(RuntimeError):
                control.fenced(value)

    def test_snapshot_excludes_private_or_unrelated_fields(self):
        raw = {"LoadState": "loaded", "MainPID": 123, "ActiveState": "active", "private": "do not publish"}
        with patch.object(control, "unit_state", return_value=raw):
            value = control.snapshot()
        self.assertEqual(value, {role: {"MainPID": 123, "ActiveState": "active"} for role in ["app", "postgres"]})
        self.assertNotIn("private", str(value))

    def unit(self):
        return {"MainPID": os.getpid(), "ActiveState": "active", "memory_events": {"oom_kill": 0},
                "kernel_budget": {"cpu_quota_usec": 10000, "cpu_period_usec": 100000,
                                  "memory_bytes": 96 * 1024 ** 2, "swap_bytes": 0, "pids": 32}}

    def test_foreign_helpers_wrong_PID_or_weakened_budgets_are_rejected(self):
        description = SimpleNamespace(stdout=("g05-pitr-error:" + self.identity).encode())
        with patch.object(control, "unit_state", return_value=self.unit()), patch.object(control, "command", return_value=description):
            self.assertEqual(control.helper_budget(self.identity), self.unit()["kernel_budget"])
        values = [{**self.unit(), "MainPID": os.getpid() + 1},
                  {**self.unit(), "kernel_budget": {**self.unit()["kernel_budget"], "memory_bytes": 128 * 1024 ** 2}},
                  {**self.unit(), "memory_events": {"oom_kill": 1}}]
        for value in values:
            with self.subTest(value=value), patch.object(control, "unit_state", return_value=value), \
                    patch.object(control, "command", return_value=description), self.assertRaises(RuntimeError):
                control.helper_budget(self.identity)
        with patch.object(control, "unit_state", return_value=self.unit()), \
                patch.object(control, "command", return_value=SimpleNamespace(stdout=b"foreign")), self.assertRaises(RuntimeError):
            control.helper_budget(self.identity)

    def run_adapter(self, *arguments):
        script = self.root / "adapter.py"
        script.write_bytes(control.adapter_source())
        return subprocess.run([sys.executable, "-I", str(script), *arguments], capture_output=True, timeout=3)

    def test_real_adapter_process_writes_only_inert_marker_then_fails(self):
        marker = self.root / "owned-marker"
        with patch.object(control, "MARKER", marker):
            result = self.run_adapter("--stanza=main", "--delta", "restore")
            self.assertEqual(result.returncode, 72)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(marker.read_bytes(), control.MARKER_BYTES)
            self.assertTrue(control.marker_written(os.getuid()))
        self.assertEqual({p.name for p in self.root.iterdir()}, {"adapter.py", "owned-marker"})

    def test_wrong_commands_and_existing_markers_are_never_modified(self):
        marker = self.root / "owned-marker"
        with patch.object(control, "MARKER", marker):
            self.assertEqual(self.run_adapter("info").returncode, 74)
            self.assertFalse(marker.exists())
            marker.write_bytes(b"preserve fixture")
            self.assertNotEqual(self.run_adapter("--stanza=main", "--delta", "restore").returncode, 72)
            self.assertEqual(marker.read_bytes(), b"preserve fixture")

    def test_marker_symlink_never_rewrites_its_target_or_certifies_injection(self):
        target = self.root / "protected"; target.write_bytes(b"preserve fixture")
        marker = self.root / "owned-marker"; marker.symlink_to(target)
        with patch.object(control, "MARKER", marker):
            self.assertNotEqual(self.run_adapter("--stanza=main", "--delta", "restore").returncode, 72)
            self.assertEqual(target.read_bytes(), b"preserve fixture")
            with self.assertRaises(RuntimeError):
                control.marker_written(os.getuid())

    def test_unowned_guest_is_refused_before_database_or_service_operations(self):
        with patch.object(control, "owned", side_effect=RuntimeError("Unowned guest")), \
                patch.object(control, "helper_budget") as budget, patch.object(control, "sql") as sql, \
                patch.object(control, "cli") as cli:
            with self.assertRaisesRegex(RuntimeError, "Unowned guest"):
                control.observe("foreign")
        budget.assert_not_called(); sql.assert_not_called(); cli.assert_not_called()

    def test_executable_digest_rejects_symlinks_without_changing_bytes(self):
        binary = self.root / "package"; binary.write_bytes(b"owned package")
        self.assertEqual(control.digest(binary), hashlib.sha256(b"owned package").hexdigest())
        link = self.root / "link"; link.symlink_to(binary)
        with self.assertRaises(RuntimeError):
            control.digest(link)
        self.assertEqual(binary.read_bytes(), b"owned package")

    def test_unknown_deferred_recovery_mode_is_rejected_before_guest_access(self):
        for value in [None, 1, "yes", float("nan")]:
            with self.subTest(value=value), patch.object(control, "owned") as owned, self.assertRaises(RuntimeError):
                control.observe(self.identity, defer_recovery=value)
            owned.assert_not_called()

    def test_post_boot_recovery_requires_owned_helper_and_bounded_digest(self):
        for value in [None, True, "invalid", "a" * 65]:
            with self.subTest(value=value), patch.object(control, "owned"), patch.object(control, "helper_budget"), \
                    patch.object(control, "cli") as cli, self.assertRaises(RuntimeError):
                control.recover_fixture(self.identity, value)
            cli.assert_not_called()

    def test_failed_recovery_retains_cli_status_and_units_without_private_output(self):
        observed = {}
        result = SimpleNamespace(returncode=1, stdout=b"private payload", stderr=b"private secret")
        with patch.object(control, "owned"), patch.object(control, "helper_budget"), \
                patch.object(control, "cli", return_value=result), \
                patch.object(control, "snapshot", return_value=self.stopped()), \
                patch.object(control, "fixture_digest") as digest:
            with self.assertRaisesRegex(RuntimeError, "Explicit owned fixture recovery failed"):
                control.recover_fixture(self.identity, "a" * 64, observations=observed)
        self.assertEqual(observed["explicit_fixture_recovery_exit_code"], 1)
        self.assertEqual(observed["after_explicit_fixture_recovery"], self.stopped())
        self.assertEqual(observed["fixture_recovery_stage"], "unit-snapshot")
        self.assertNotIn("private", json.dumps(observed))
        digest.assert_not_called()

    def test_unowned_recovery_emits_only_stage_and_failure_type_without_cli_work(self):
        with patch.object(control, "owned", side_effect=RuntimeError("private identity detail")), \
                patch.object(control, "helper_budget") as budget, patch.object(control, "cli") as cli:
            actual = control.recovery_observation(self.identity, "a" * 64)
        self.assertEqual(actual, {"fixture_recovery_stage": "guest-ownership",
                                  "explicit_fixture_recovery_successful": False,
                                  "fixture_recovery_failure_type": "RuntimeError"})
        budget.assert_not_called(); cli.assert_not_called()

    def test_budget_failure_preserves_actual_numeric_limits_and_rejects_private_fields(self):
        observed = {}
        raw = {**self.unit(), "kernel_budget": {**self.unit()["kernel_budget"], "memory_bytes": None},
               "private": "never publish"}
        description = SimpleNamespace(stdout=("g05-pitr-error:" + self.identity).encode())
        with patch.object(control, "unit_state", return_value=raw), \
                patch.object(control, "command", return_value=description), self.assertRaises(RuntimeError):
            control.helper_budget(self.identity, observations=observed)
        self.assertIsNone(observed["helper_budget_observation"]["kernel_budget"]["memory_bytes"])
        self.assertTrue(observed["helper_budget_observation"]["MainPID_matches_helper"])
        self.assertNotIn("private", json.dumps(observed))

    def test_parent_sync_closes_its_descriptor_even_when_sync_fails(self):
        with patch.object(control.os, "open", return_value=123), patch.object(control.os, "fsync", side_effect=OSError), \
                patch.object(control.os, "close") as close, self.assertRaises(OSError):
            control.sync_parent(self.root / "owned-marker")
        close.assert_called_once_with(123)


if __name__ == "__main__":
    unittest.main()
