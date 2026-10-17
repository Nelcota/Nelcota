"""Failure annotations expose identities rather than assertion data or commands."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('rust_failure_reporter', ROOT / 'scripts/report-rust-test-failures.py')
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class RustFailureAnnotations(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.log = self.root / 'cargo.log'

    def test_colored_duplicate_failures_do_not_publish_assertion_payloads(self):
        self.log.write_text('test sessions::rotation ... \x1b[31mFAILED\x1b[0m\nassertion payload: private-credential-marker\ntest sessions::rotation ... FAILED\ntest boundaries::denial ... FAILED\n')
        annotations = reporter.annotations(self.log)
        self.assertEqual(annotations, ['::error title=Rust reported a failed test::sessions::rotation', '::error title=Rust reported a failed test::boundaries::denial'])
        self.assertNotIn('private-credential-marker', '\n'.join(annotations))

    def test_embedded_data_and_workflow_commands_are_not_test_identities(self):
        self.log.write_text('body: test sessions::rotation ... FAILED\ntest sessions%0A::error ... FAILED\ntest https://fixture.test/secret ... FAILED\n')
        self.assertEqual(reporter.failed_tests(self.log), [])
        self.assertEqual(len(reporter.annotations(self.log)), 1)

    def test_annotation_cardinality_and_input_bytes_stay_bounded(self):
        self.log.write_text(''.join('test fixture::case_' + str(index) + ' ... FAILED\n' for index in range(100)))
        self.assertEqual(len(reporter.annotations(self.log)), reporter.MAX_FAILURES)
        with self.log.open('wb') as target:
            target.truncate(reporter.MAX_BYTES + 1)
        self.assertEqual(reporter.failed_tests(self.log), [])

    def test_missing_or_redirected_logs_do_not_read_a_foreign_target(self):
        self.assertEqual(reporter.failed_tests(self.log), [])
        foreign = self.root / 'foreign.log'
        foreign.write_text('test fixture::private ... FAILED\n')
        self.log.symlink_to(foreign)
        self.assertEqual(reporter.failed_tests(self.log), [])
        self.assertEqual(foreign.read_text(), 'test fixture::private ... FAILED\n')


if __name__ == '__main__':
    unittest.main()
