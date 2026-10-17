"""Native repetitions must consume the same source-bound immutable ELF bytes."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import native_artifact
import native_vm
import native_guest


class NativeArtifactBoundary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = self.root / "release"
        self.binary.write_bytes(b"\x7fELFowned fixture bytes")
        self.directory = self.root / "suite"
        self.source = "1" * 40

    def freeze(self):
        with patch("native_artifact.build_context", return_value={"environment_override_names": []}):
            return native_artifact.freeze(self.binary, self.directory, self.source)

    def test_retained_copy_keeps_exact_bytes_and_rejects_changed_source_or_digest(self):
        result = self.freeze()
        self.assertEqual(native_artifact.artifact(self.directory, self.source), result)
        self.assertEqual((self.directory / "nelcota").stat().st_mode & 0o777, 0o555)
        self.binary.write_bytes(b"different current build")
        self.assertEqual((self.directory / "nelcota").read_bytes(), b"\x7fELFowned fixture bytes")
        with self.assertRaisesRegex(ValueError, "source or digest"):
            native_artifact.artifact(self.directory, "2" * 40)
        retained = self.directory / "nelcota"
        retained.chmod(0o755)
        retained.write_bytes(b"\x7fELFchanged fixture dat")
        with self.assertRaises(ValueError):
            native_artifact.artifact(self.directory, self.source)

    def test_redirected_or_untyped_artifacts_never_run(self):
        self.freeze()
        retained = self.directory / "nelcota"
        retained.unlink()
        retained.symlink_to(self.binary)
        with self.assertRaisesRegex(ValueError, "artifact boundary"):
            native_artifact.artifact(self.directory, self.source)
        manifest = self.directory / "manifest.json"
        manifest.write_text(json.dumps({"schema": True, "source_commit": self.source, "binary_sha256": None,
                                        "size_bytes": 4, "build": {}, "scope": "fixture"}))
        with self.assertRaisesRegex(ValueError, "source or digest"):
            native_artifact.artifact(self.directory, self.source)

    def test_undeclared_compiler_overrides_block_freezing(self):
        with patch("native_artifact.build_context", return_value={"environment_override_names": ["RUSTFLAGS"]}):
            with self.assertRaisesRegex(ValueError, "undeclared"):
                native_artifact.freeze(self.binary, self.directory, self.source)
        self.assertFalse(self.directory.exists())

    def test_both_native_passes_have_distinct_truthful_workflow_identities(self):
        cases = ["runtime", "cluster-routing", "default-root", "host-root", "clock-drift", "remove-boundary"]
        identities = {native_vm.campaign_identity("123", "1", case, index) for case in cases for index in [1, 2]}
        self.assertEqual(len(identities), 12)
        self.assertIn("native-vm-123-1-p2-remove-boundary", identities)
        self.assertEqual(native_vm.campaign_identity("123", "1", "runtime"), "native-vm-123-1")
        for index in [True, 0, 3, float("nan")]:
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                native_vm.campaign_identity("123", "1", "runtime", index)
        with self.assertRaises(RuntimeError):
            native_vm.campaign_identity("123", "1", "runtime;stop", 1)

    def test_actual_running_inode_and_bytes_must_both_match_the_retained_input(self):
        running = self.root / "running"
        running.symlink_to(self.binary)
        provided = self.root / "provided"
        provided.write_bytes(self.binary.read_bytes())
        result = native_guest.running_binary_identity(self.binary, running, provided)
        self.assertTrue(result["same_deployed_inode"])
        self.assertEqual(result["running_binary_sha256"], result["provided_binary_sha256"])
        replacement = self.root / "replacement"
        replacement.write_bytes(self.binary.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "another executable inode"):
            native_guest.running_binary_identity(replacement, running, provided)
        provided.write_bytes(b"different build")
        with self.assertRaisesRegex(RuntimeError, "frozen artifact"):
            native_guest.running_binary_identity(self.binary, running, provided)


if __name__ == "__main__":
    unittest.main()
