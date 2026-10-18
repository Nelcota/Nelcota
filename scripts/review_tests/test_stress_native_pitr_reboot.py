"""Immediate restore fencing must not substitute for post-boot evidence."""
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import native_pitr_reboot as reboot


class NativePitrBootControl(unittest.TestCase):
    identity = "native-vm-pitr-recovery-test-1"

    def helper_state(self, *, owner=None):
        description = "g05-pitr-error:" + self.identity
        if owner is not None:
            description = owner
        values = {"Id": reboot.helper_name(self.identity), "Description": description,
                  "LoadState": "loaded", "ActiveState": "failed", "Result": "oom-kill",
                  "MainPID": "0", "ExecMainCode": "2", "ExecMainStatus": "9", "MemoryPeak": "100663296"}
        return SimpleNamespace(stdout="".join(key + "=" + value + "\n" for key, value in values.items()).encode(), returncode=0)

    def stopped(self):
        return {role: {"MainPID": 0, "ActiveState": "inactive"} for role in ["app", "postgres"]}

    def samples(self):
        return [{"units": self.stopped(), "authenticated_API_reopened": False} for _ in range(2)]

    def test_complete_stopped_window_passes_and_single_or_short_observation_cannot(self):
        self.assertTrue(reboot.verdict(self.samples(), 20))
        self.assertFalse(reboot.verdict(self.samples()[:1], 20))
        self.assertFalse(reboot.verdict(self.samples(), 0.1))
        self.assertFalse(reboot.verdict(self.samples(), 51))

    def test_running_failed_or_activating_service_after_boot_cannot_certify(self):
        for role in ["app", "postgres"]:
            for state, pid in [("active", 123), ("activating", 0), ("failed", 0)]:
                values = self.samples()
                values[1]["units"][role] = {"MainPID": pid, "ActiveState": state}
                with self.subTest(role=role, state=state):
                    self.assertFalse(reboot.verdict(values, 20))

    def test_authenticated_response_cannot_be_hidden_by_inactive_PID_snapshot(self):
        values = self.samples(); values[1]["authenticated_API_reopened"] = True
        self.assertFalse(reboot.verdict(values, 20))

    def test_missing_nonfinite_boolean_or_unbounded_observations_are_rejected(self):
        for values, elapsed in [([], 20), (None, 20), (self.samples() * 12, 20),
                                (self.samples(), float("nan")), (self.samples(), None), (self.samples(), True)]:
            with self.subTest(elapsed=elapsed), self.assertRaises(RuntimeError):
                reboot.verdict(values, elapsed)
        values = self.samples(); values[0]["units"]["app"]["MainPID"] = True
        with self.assertRaises(RuntimeError):
            reboot.verdict(values, 20)

    def test_resource_projection_requires_exact_roles_and_omits_private_fields(self):
        point = {"LoadState": "loaded", "MainPID": 0, "ActiveState": "inactive", "private": "never publish"}
        resources = {"units": {unit: copy.deepcopy(point) for unit in [reboot.UNIT, reboot.PG_UNIT]}}
        actual = reboot.snapshot(resources)
        self.assertEqual(actual, self.stopped())
        self.assertNotIn("private", json.dumps(actual))
        resources["units"][reboot.PG_UNIT]["LoadState"] = "masked"
        self.assertEqual(reboot.snapshot(resources), self.stopped())
        resources["units"].pop(reboot.PG_UNIT)
        with self.assertRaises(RuntimeError):
            reboot.snapshot(resources)

    def test_safety_guard_failure_is_never_swallowed_as_a_fenced_connection(self):
        guest = SimpleNamespace(assert_safe=Mock(side_effect=RuntimeError("critical guard")), action=Mock())
        api = SimpleNamespace(request=Mock())
        with self.assertRaisesRegex(RuntimeError, "critical guard"):
            reboot.observe(guest, api, object())
        guest.action.assert_not_called(); api.request.assert_not_called()

    def test_failed_recovery_transports_numeric_evidence_before_rejecting_the_case(self):
        observed = {"explicit_fixture_recovery_successful": False,
                    "fixture_recovery_stage": "CLI-up", "explicit_fixture_recovery_exit_code": 1}
        guest = SimpleNamespace(identity=self.identity,
                                ssh=Mock(side_effect=[SimpleNamespace(stdout=json.dumps(observed).encode(), returncode=1), self.helper_state()]),
                                assert_safe=Mock())
        original = {"fixture_rows_before_sha256": "a" * 64, "boot_observation": {"failed": True}}
        with self.assertRaisesRegex(RuntimeError, "numeric observation retained"):
            reboot.recover(guest, ["owned-helper"], original)
        self.assertEqual(original["explicit_fixture_recovery_exit_code"], 1)
        self.assertEqual(original["post_boot_fixture_helper_exit_code"], 1)
        self.assertEqual(original["boot_observation"], {"failed": True})
        guest.ssh.assert_any_call(["owned-helper", "--recover-fixture", "a" * 64], timeout=145, check=False)
        self.assertEqual(original["post_boot_fixture_helper_unit"]["Result"], "oom-kill")

    def test_recovery_cannot_replace_earlier_boot_verdict(self):
        observed = {"boot_observation": {"failed": False}, "explicit_fixture_recovery_successful": True}
        guest = SimpleNamespace(ssh=Mock(return_value=SimpleNamespace(stdout=json.dumps(observed).encode(), returncode=0)),
                                assert_safe=Mock())
        original = {"fixture_rows_before_sha256": "a" * 64, "boot_observation": {"failed": True}}
        with self.assertRaisesRegex(RuntimeError, "cannot replace"):
            reboot.recover(guest, ["owned-helper"], original)
        self.assertEqual(original["boot_observation"], {"failed": True})

    def test_recovery_transport_cannot_swallow_a_critical_guard_or_certify_empty_output(self):
        guest = SimpleNamespace(identity=self.identity, ssh=Mock(return_value=SimpleNamespace(stdout=b"", returncode=1)),
                                assert_safe=Mock(side_effect=RuntimeError("critical guard")))
        original = {"fixture_rows_before_sha256": "a" * 64}
        with self.assertRaisesRegex(RuntimeError, "critical guard"):
            reboot.recover(guest, ["owned-helper"], original)
        guest.assert_safe = Mock()
        guest.ssh = Mock(side_effect=[SimpleNamespace(stdout=b"", returncode=1), self.helper_state()])
        with self.assertRaisesRegex(RuntimeError, "Missing bounded"):
            reboot.recover(guest, ["owned-helper", "--collect"], original)
        guest.ssh.assert_any_call(["owned-helper", "--recover-fixture", "a" * 64], timeout=145, check=False)
        self.assertEqual(original["post_boot_fixture_helper_unit"]["MemoryPeak"], 100663296)

    def test_failed_helper_metadata_refuses_foreign_description(self):
        guest = SimpleNamespace(identity=self.identity, ssh=Mock(return_value=self.helper_state(owner="foreign private detail")),
                                assert_safe=Mock())
        with self.assertRaisesRegex(RuntimeError, "another owner"):
            reboot.failed_helper(guest)


if __name__ == "__main__":
    unittest.main()
