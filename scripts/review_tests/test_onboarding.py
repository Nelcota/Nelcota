"""Protect installation verification and disposable quickstart ownership."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("onboarding", ROOT / "scripts/test-onboarding.py")
onboarding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(onboarding)


class Ownership(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = onboarding.Quickstart("/bin/false", Path(self.temporary.name))
        self.info = {"Id": "owned-id", "Config": {"Env": ["POSTGRES_PASSWORD=generated-password"]},
                     "Mounts": [{"Name": self.fixture.volume, "Destination": "/var/lib/postgresql/data"}]}
        self.volume = {"Name": self.fixture.volume,
                       "Labels": {onboarding.VOLUME_OWNER_LABEL: self.fixture.run_id}}

    def test_shell_quoted_development_values_are_decoded_without_expansion(self):
        state = self.fixture.root / ".nelcota/dev.env"
        state.parent.mkdir(exist_ok=True)
        state.write_text("POSTGRES_PASSWORD='literal$hash'\nADMIN_PASSWORD='safe'\n")
        self.assertEqual(onboarding.state_values(self.fixture.root)["POSTGRES_PASSWORD"], "literal$hash")

    def test_matching_password_and_data_volume_establish_ownership(self):
        self.assertTrue(onboarding.owned_container(self.info, {"POSTGRES_PASSWORD": "generated-password"},
                                                  self.fixture.volume))
        self.assertFalse(onboarding.owned_container(self.info, {"POSTGRES_PASSWORD": "other-password"},
                                                   self.fixture.volume))
        self.assertFalse(onboarding.owned_container(self.info, {"POSTGRES_PASSWORD": "generated-password"},
                                                   "another-volume"))

    def test_preexisting_database_is_never_claimed_or_removed(self):
        with mock.patch.object(onboarding, "inspect", return_value=self.info), \
             mock.patch.object(onboarding.subprocess, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "already exists"):
                self.fixture.run()
            self.assertEqual(self.fixture.cleanup(), "no database created")
            command.assert_not_called()

    def test_cleanup_preserves_a_container_with_different_credentials(self):
        self.fixture.claimed = True
        (self.fixture.root / ".nelcota").mkdir()
        (self.fixture.root / ".nelcota/dev.env").write_text("POSTGRES_PASSWORD=other-password\n")
        with mock.patch.object(onboarding, "inspect", side_effect=[self.info, self.volume]), \
             mock.patch.object(onboarding.subprocess, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                self.fixture.cleanup()
            command.assert_not_called()

    def test_cleanup_preserves_an_orphan_volume_without_ownership_proof(self):
        self.fixture.claimed = True
        with mock.patch.object(onboarding, "inspect", side_effect=[None, {"Name": self.fixture.volume}]), \
             mock.patch.object(onboarding.subprocess, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "volume ownership"):
                self.fixture.cleanup()
            command.assert_not_called()

    def test_cleanup_preserves_a_volume_with_another_runs_label(self):
        self.fixture.claimed = True
        self.volume["Labels"][onboarding.VOLUME_OWNER_LABEL] = "another-run"
        with mock.patch.object(onboarding, "inspect", side_effect=[self.info, self.volume]), \
             mock.patch.object(onboarding.subprocess, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "volume ownership"):
                self.fixture.cleanup()
            command.assert_not_called()

    def test_cleanup_removes_only_its_labeled_volume_after_early_start_failure(self):
        self.fixture.claimed = True
        with mock.patch.object(onboarding, "inspect", side_effect=[None, self.volume]), \
             mock.patch.object(onboarding.subprocess, "run") as command:
            self.assertEqual(self.fixture.cleanup(), "owned volume removed; no database container created")
            self.assertEqual(command.call_args.args[0], ["docker", "volume", "rm", self.fixture.volume])

    def test_concurrent_volume_creation_is_rejected_before_starting_the_server(self):
        self.volume["Labels"][onboarding.VOLUME_OWNER_LABEL] = "another-run"
        with mock.patch.object(onboarding, "inspect", side_effect=[None, None, self.volume]), \
             mock.patch.object(onboarding.subprocess, "run") as command, \
             mock.patch.object(self.fixture, "start") as start:
            with self.assertRaisesRegex(RuntimeError, "concurrently created"):
                self.fixture.run()
            start.assert_not_called()
            self.assertEqual(command.call_args.args[0][:3], ["docker", "volume", "create"])

    def test_daemon_failure_is_not_treated_as_missing_database(self):
        result = subprocess.CompletedProcess([], 1, b"", b"Cannot connect to the Docker daemon")
        with mock.patch.object(onboarding.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "daemon"):
                onboarding.inspect("container", "fixture")

    def test_missing_volume_is_a_supported_docker_response(self):
        result = subprocess.CompletedProcess([], 1, b"[]", b"Error response: no such volume")
        with mock.patch.object(onboarding.subprocess, "run", return_value=result):
            self.assertIsNone(onboarding.inspect("volume", "fixture"))

    def test_cleanup_cancellation_cannot_leave_a_passed_report(self):
        self.fixture.run = mock.Mock(return_value="fixture-version")
        self.fixture.cleanup = mock.Mock(side_effect=KeyboardInterrupt)
        with mock.patch.object(onboarding, "Quickstart", return_value=self.fixture), \
             mock.patch.object(onboarding.subprocess, "run"), \
             mock.patch.object(sys, "argv", ["test-onboarding.py", "--binary", "/bin/true"]):
            with self.assertRaises(KeyboardInterrupt):
                onboarding.main()
        import json
        report = json.loads((self.fixture.root / "report.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertIn("failed", report["cleanup"])


class Diagnostics(unittest.TestCase):
    def setUp(self):
        self.requests = []
        requests = self.requests

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                return

            def do_GET(self):
                requests.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/redirect-target")
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"x" * 1025)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.api = onboarding.Api(f"http://127.0.0.1:{self.server.server_port}")

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def test_credentials_are_not_forwarded_on_redirect(self):
        with self.assertRaisesRegex(RuntimeError, "HTTP 302"):
            self.api.request("GET", "/redirect", token="private-session")
        self.assertEqual(self.requests, ["/redirect"])

    def test_oversized_response_is_rejected_without_copying_its_contents(self):
        with mock.patch.object(onboarding, "BODY_LIMIT", 1024):
            with self.assertRaisesRegex(RuntimeError, "diagnostic limit") as failure:
                self.api.request("GET", "/body")
        self.assertNotIn("xxxxx", str(failure.exception))

    def test_timed_out_browser_command_terminates_its_process_group(self):
        process = mock.Mock(pid=12345)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("node", 1), 0]
        with mock.patch.object(onboarding.subprocess, "Popen", return_value=process) as start, \
             mock.patch.object(onboarding.os, "killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                onboarding.run_process(["node", "fixture"], timeout=1)
        self.assertTrue(start.call_args.kwargs["start_new_session"])
        kill.assert_called_once_with(12345, onboarding.signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
