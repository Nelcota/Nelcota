"""CI diagnostics bound downloads and never forward tokens or panic payloads."""
import importlib.util
import io
import os
from pathlib import Path
import unittest
from unittest import mock
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ci_diagnostics", ROOT / "scripts/report-ci-diagnostics.py")
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


class BoundedCIDiagnostics(unittest.TestCase):
    def test_signed_redirect_never_carries_api_authorization(self):
        request = urllib.request.Request("https://api.github.com/repos/Nelcota/Nelcota/actions/jobs/1/logs")
        request.add_unredirected_header("Authorization", "Bearer private-marker")
        redirect = diagnostics.BoundedRedirect()
        target = redirect.redirect_request(request, None, 302, "Found", {}, "https://fixture.blob.core.windows.net/log?sig=private-marker")
        self.assertIsNone(target.get_header("Authorization"))
        for address in ["http://fixture.blob.core.windows.net/log", "https://api.github.com.attacker.test/log",
                        "https://private-marker@api.github.com/log", "https://api.github.com:444/log"]:
            with self.subTest(address=address), self.assertRaises(RuntimeError):
                diagnostics.BoundedRedirect().redirect_request(request, None, 302, "Found", {}, address)

    def test_redirect_cardinality_is_bounded(self):
        request = urllib.request.Request("https://api.github.com/log")
        redirect = diagnostics.BoundedRedirect()
        for _ in range(3):
            redirect.redirect_request(request, None, 302, "Found", {}, "https://fixture.blob.core.windows.net/log")
        with self.assertRaises(RuntimeError):
            redirect.redirect_request(request, None, 302, "Found", {}, "https://fixture.blob.core.windows.net/log")

    def test_panic_location_and_fixed_category_do_not_publish_assertion_data(self):
        text = "2026-10-16T22:05:01.123Z thread 'updates::runtime::tests::fixture' (1234) panicked at crates/cli/src/updates/runtime.rs:860:69:\n"
        text += '2026-10-16T22:05:01.124Z called unwrap on Err: Os { code: 26, kind: ExecutableFileBusy, message: "Text file busy", private: "must-never-publish" }\n'
        self.assertEqual(diagnostics.panic_locations(text), [{"test": "updates::runtime::tests::fixture",
                         "file": "crates/cli/src/updates/runtime.rs", "line": 860, "column": 69, "category": "exec_text_file_busy"}])
        self.assertNotIn("must-never-publish", str(diagnostics.panic_locations(text)))
        self.assertEqual(diagnostics.panic_locations("thread 'fixture' panicked at crates/../private.rs:1:1:\n"), [])
        self.assertEqual(diagnostics.panic_locations("thread 'fixture%0A::error' panicked at crates/x.rs:1:1:\n"), [])

    @mock.patch.dict(os.environ, {"GH_TOKEN": "unit-test-token"})
    def test_input_byte_budget_and_error_body_privacy(self):
        opener = mock.Mock()
        with mock.patch.object(urllib.request, "build_opener", return_value=opener), mock.patch.object(diagnostics, "MAX_BYTES", 16):
            opener.open.return_value = io.BytesIO(b"x" * 17)
            with self.assertRaisesRegex(RuntimeError, "file budget"):
                diagnostics.api("actions/jobs/1/logs", logs=True)
            body = io.BytesIO(b"private-error-body")
            opener.open.side_effect = urllib.error.HTTPError("https://private.invalid/?secret", 403, "private-marker", {}, body)
            with self.assertRaisesRegex(RuntimeError, "HTTP 403") as error:
                diagnostics.api("actions/jobs/1/logs", logs=True)
            self.assertTrue(body.closed)
            self.assertNotIn("private-marker", str(error.exception))
            self.assertNotIn("secret", str(error.exception))
            self.assertNotIn("private-error-body", str(error.exception))

    def test_arbitrary_api_paths_are_rejected_before_network(self):
        with mock.patch.object(urllib.request, "build_opener") as opener:
            with self.assertRaisesRegex(RuntimeError, "Unexpected"):
                diagnostics.api("actions/jobs/1/../../secrets")
            opener.assert_not_called()

    def test_focused_python_failure_keeps_locations_without_assertion_payloads(self):
        text = "2026-10-17T04:45:01.123Z FAIL: test_fixture (test_stress_provider_runtime.RuntimeBoundaries.test_fixture)\n"
        text += '2026-10-17T04:45:01.124Z   File "/home/runner/work/Nelcota/Nelcota/scripts/review_tests/test_stress_provider_runtime.py", line 250, in test_fixture\n'
        text += "2026-10-17T04:45:01.125Z AssertionError: private-token-must-stay-private\n"
        expected = [{"test": "test_stress_provider_runtime.RuntimeBoundaries.test_fixture",
                     "locations": [{"file": "test_stress_provider_runtime.py", "line": 250, "function": "test_fixture"}],
                     "category": "AssertionError"}]
        self.assertEqual(diagnostics.focused_python_failures(text), expected)
        self.assertNotIn("private-token", str(diagnostics.focused_python_failures(text)))
        self.assertEqual(diagnostics.focused_python_failures("FAIL: test_fixture (unrelated_module.test_fixture)\n"), [])
        general = text.replace("test_stress_provider_runtime", "test_stress_matrix_pressure")
        self.assertEqual(diagnostics.focused_python_failures(general)[0]["locations"][0]["file"],
                         "test_stress_matrix_pressure.py")
        relative = text.replace('/home/runner/work/Nelcota/Nelcota/scripts/', 'scripts/').replace('in test_fixture', 'in RuntimeBoundaries.test_fixture')
        relative = relative.replace('AssertionError: private-token-must-stay-private', 'RuntimeError: Invalid allocator observation time')
        projected = diagnostics.focused_python_failures(relative)[0]
        self.assertEqual(projected["category"], "invalid_allocator_observation_time")
        self.assertEqual(projected["locations"][0]["function"], "RuntimeBoundaries.test_fixture")
        self.assertEqual(diagnostics.python_unit_summaries("2026-10-17T04:45:02.000Z Ran 15 tests in 1.137s\n"),
                         [{"tests": 15, "elapsed_seconds": 1.137}])
        self.assertEqual(diagnostics.python_unit_summaries("private payload: Ran 15 tests in 1.137s\nRan 15 tests in NaNs\n"), [])


if __name__ == "__main__":
    unittest.main()
