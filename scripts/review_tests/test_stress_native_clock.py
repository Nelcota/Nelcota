"""Owned guest clocks restore even when the auth oracle fails."""

import base64
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import native_vm


class NativeClockBoundaries(unittest.TestCase):
    def clock_token(self, expiration):
        value = base64.urlsafe_b64encode(json.dumps({"exp": expiration}).encode()).decode().rstrip("=")
        return "fixture." + value + ".fixture"

    def test_clock_probe_restores_guest_clock_and_ntp_after_an_oracle_failure(self):
        clock = {"epoch": 1800000000}
        def execute(arguments, **keywords):
            for argument in arguments:
                if argument.startswith("--set=@"):
                    clock["epoch"] = int(argument.removeprefix("--set=@"))
            if arguments[0] == "date":
                return SimpleNamespace(stdout=str(clock["epoch"]).encode(), returncode=0)
            return SimpleNamespace(stdout=b"yes\n", returncode=0)
        guest = SimpleNamespace(ssh=Mock(side_effect=execute), assert_safe=Mock())
        api = SimpleNamespace(request=Mock(side_effect=[b'[{"id":1}]', RuntimeError("controlled oracle failure")]))
        result = {}
        with patch("native_vm.time.time", return_value=1800000000):
            with self.assertRaisesRegex(RuntimeError, "controlled oracle failure"):
                native_vm.clock_probe(guest, api, self.clock_token(1800000900), "fixture-service", result)
        arguments = [call.args[0] for call in guest.ssh.call_args_list]
        self.assertIn(["sudo", "-n", "date", "--utc", "--set=@1800000000", "+%s"], arguments)
        self.assertIn(["sudo", "-n", "timedatectl", "set-ntp", "true"], arguments)
        self.assertEqual(result["wall_clock_restore_exit_code"], 0)
        self.assertEqual(result["ntp_state_restore_exit_code"], 0)
        self.assertEqual(result["status"], "failed")

    def test_invalid_clock_steps_are_rejected_before_any_guest_command(self):
        for expiration in [None, True, float("nan"), 1800000000, 1800004000]:
            guest = SimpleNamespace(ssh=Mock(), assert_safe=Mock())
            with self.subTest(expiration=expiration), patch("native_vm.time.time", return_value=1800000000):
                with self.assertRaisesRegex(RuntimeError, "fresh bounded"):
                    native_vm.clock_probe(guest, Mock(), self.clock_token(expiration), "fixture-service", {})
                guest.ssh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
