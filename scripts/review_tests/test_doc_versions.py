"""Release documentation must not drift from the selected package metadata."""
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("doc_versions", ROOT / "scripts/check-doc-versions.py")
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)
FILES = (
    "README.md", "CHANGELOG.md", "Cargo.lock", "docs/quickstart.md", "docs/onboarding/notes.md",
    "docs/releases/README.md", "docs/goals/README.md",
    "docs/goals/auth-security-review.md", "docs/goals/auth-security-review-execution.md",
    "sdk/typescript/package.json", "sdk/typescript/package-lock.json",
    "sdk/typescript/README.md", "sdk/typescript/CHANGELOG.md",
    "sdk/typescript/docs/quickstart.pt-BR.md", "sdk/typescript/docs/contract.md",
    "sdk/rust/Cargo.toml", "sdk/rust/README.md", "sdk/rust/CHANGELOG.md",
    "sdk/rust/docs/quickstart.pt-BR.md", "sdk/rust/docs/contract.md",
)


class VersionDocumentationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nelcota-doc-versions-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for relative in FILES:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)

    def test_current_documentation_agrees(self):
        self.assertEqual(CHECKER.check(self.root), [])

    def test_stale_install_target_is_rejected(self):
        path = self.root / "docs/quickstart.md"
        text = path.read_text()
        start = text.index("currently ") + len("currently ")
        end = text.index(". To build", start)
        path.write_text(text[:start] + "0.0.0" + text[end:])
        self.assertTrue(any("docs/quickstart.md" in error for error in CHECKER.check(self.root)))

    def test_old_lock_version_is_rejected(self):
        path = self.root / "sdk/typescript/package-lock.json"
        lock = json.loads(path.read_text())
        lock["packages"][""]["version"] = "0.0.0"
        path.write_text(json.dumps(lock))
        self.assertTrue(any("package-lock" in error for error in CHECKER.check(self.root)))

    def test_completed_goal_cannot_still_be_planned(self):
        path = self.root / "docs/goals/README.md"
        path.write_text(path.read_text().replace("G06 is finalized", "G06 is planned"))
        self.assertTrue(any("Goals index" in error for error in CHECKER.check(self.root)))


if __name__ == "__main__":
    unittest.main()
