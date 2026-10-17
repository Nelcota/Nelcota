"""The repeated unit driver retains failures and rejects zero executed tests."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("repeat_identity", ROOT / "scripts/repeat-native-identity.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class IdentityRepetitionControl(unittest.TestCase):
    @mock.patch.object(driver, "REPETITIONS", 3)
    def test_each_real_test_completion_is_required_and_first_failure_is_retained(self):
        def execute(arguments, **kwargs):
            self.assertEqual(arguments[1:], [driver.NAME, "--exact", "--test-threads=1", "--nocapture"])
            kwargs["stdout"].write(b"running 1 test\n1 passed; 0 failed\n")
            return subprocess.CompletedProcess(arguments, 0)
        with mock.patch.object(subprocess, "run", side_effect=execute) as run:
            result = driver.repeat(Path("/owned/test"), lambda text: [])
        self.assertEqual(run.call_count, 3)
        self.assertEqual((result["status"], result["passed"], result["attempted"]), ("passed", 3, 3))
        def failed(arguments, **kwargs):
            kwargs["stdout"].write(b"running 1 test\nprivate-assertion-data\n0 passed; 1 failed\n")
            return subprocess.CompletedProcess(arguments, 101)
        with mock.patch.object(subprocess, "run", side_effect=failed) as run:
            result = driver.repeat(Path("/owned/test"), lambda text: [{"line": 863}])
        self.assertEqual(run.call_count, 1)
        self.assertEqual((result["status"], result["passed"], result["attempted"]), ("failed", 0, 1))
        self.assertEqual(result["panic_locations"], [{"line": 863}])
        self.assertNotIn("private-assertion-data", str(result))

    def test_zero_selected_tests_cannot_be_reported_as_success(self):
        def empty(arguments, **kwargs):
            kwargs["stdout"].write(b"running 0 tests\n0 passed; 0 failed\n")
            return subprocess.CompletedProcess(arguments, 0)
        with mock.patch.object(subprocess, "run", side_effect=empty), self.assertRaisesRegex(RuntimeError, "did not execute"):
            driver.repeat(Path("/owned/test"), lambda text: [])

    def test_timeout_and_duration_stop_preserve_failed_partial_receipts(self):
        with mock.patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("private-command", 10)):
            result = driver.repeat(Path("/owned/test"), lambda text: [])
        self.assertEqual(result["failure_category"], "unit_timeout")
        self.assertEqual(result["attempted"], 1)
        self.assertNotIn("private-command", str(result))
        with mock.patch.object(driver.time, "monotonic", side_effect=[1, 242, 242]), mock.patch.object(subprocess, "run") as run:
            result = driver.repeat(Path("/owned/test"), lambda text: [])
        run.assert_not_called()
        self.assertEqual(result["failure_category"], "duration_limit")
        self.assertEqual(result["status"], "failed")


if __name__ == "__main__":
    unittest.main()
