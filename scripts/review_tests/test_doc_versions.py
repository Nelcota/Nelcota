"""Release documentation must not drift from the selected package metadata."""
import importlib.util
import json
import re
import shutil
import tempfile
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("doc_versions", ROOT / "scripts/check-doc-versions.py")
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)
FILES = (
    "README.md", "CHANGELOG.md", "Cargo.toml", "Cargo.lock", "docs/quickstart.md", "docs/onboarding/notes.md",
    "docs/deploy.md", "docs/README.md", "docs/auth-integration.md", "crates/core/README.md",
    "examples/auth-consumer/Cargo.toml",
    "docs/releases/README.md", "docs/goals/README.md",
    "docs/goals/auth-security-review.md", "docs/goals/auth-security-review-execution.md",
    "sdk/typescript/package.json",
    "sdk/typescript/README.md", "sdk/typescript/CHANGELOG.md",
    "sdk/typescript/docs/quickstart.pt-BR.md", "sdk/typescript/docs/contract.md",
    "sdk/nextjs/package.json", "sdk/nextjs/README.md", "sdk/nextjs/docs/quickstart.pt-BR.md",
    "sdk/nextjs/examples/app-router/package.json", "sdk/nextjs/examples/app-router/bun.lock",
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
        path.write_text(re.sub(r"(This guide targets server )\d+\.\d+\.\d+", r"\g<1>0.0.0", text, count=1))
        self.assertTrue(any("docs/quickstart.md" in error for error in CHECKER.check(self.root)))

    def test_stale_deploy_install_target_is_rejected(self):
        path = self.root / "docs/deploy.md"
        path.write_text(re.sub(r"(NELCOTA_VERSION=)\d+\.\d+\.\d+", r"\g<1>0.0.0", path.read_text(), count=1))
        self.assertTrue(any("docs/deploy.md" in error for error in CHECKER.check(self.root)))

    def test_auth_consumer_version_is_checked(self):
        path = self.root / "examples/auth-consumer/Cargo.toml"
        path.write_text(re.sub(r'(nelcota-auth = \{[^}]*version = ")[^"]+', r"\g<1>0.0.0", path.read_text()))
        self.assertTrue(any("auth-consumer" in error for error in CHECKER.check(self.root)))

    def test_source_target_must_match_workspace(self):
        path = self.root / "Cargo.toml"
        version = tomllib.loads(path.read_text())["workspace"]["package"]["version"]
        path.write_text(path.read_text().replace(f'version = "{version}"', 'version = "0.0.0"', 1))
        self.assertTrue(any("differs from workspace" in error for error in CHECKER.check(self.root)))

    def test_server_lock_version_is_checked(self):
        path = self.root / "Cargo.lock"
        path.write_text(re.sub(r'(name = "nelcota-server"\nversion = ")[^"]+', r'\g<1>0.0.0', path.read_text()))
        self.assertTrue(any("Server workspace" in error for error in CHECKER.check(self.root)))

    def test_stale_nextjs_install_target_is_rejected(self):
        path = self.root / "sdk/nextjs/README.md"
        path.write_text(re.sub(r"@nelcota/nextjs@\d+\.\d+\.\d+", "@nelcota/nextjs@0.0.0", path.read_text()))
        self.assertTrue(any("sdk/nextjs/README.md" in error for error in CHECKER.check(self.root)))

    def test_example_cannot_depend_on_a_checkout_link(self):
        path = self.root / "sdk/nextjs/examples/app-router/package.json"
        data = json.loads(path.read_text())
        data["dependencies"]["@nelcota/nextjs"] = "file:../.."
        path.write_text(json.dumps(data))
        self.assertTrue(any("published registry version" in error for error in CHECKER.check(self.root)))

    def test_example_lock_cannot_hide_an_old_package(self):
        path = self.root / "sdk/nextjs/examples/app-router/bun.lock"
        path.write_text(re.sub(r'\["@nelcota/client@\d+\.\d+\.\d+"', '["@nelcota/client@0.0.0"', path.read_text()))
        self.assertTrue(any("lock must match" in error for error in CHECKER.check(self.root)))

    def test_completed_goal_cannot_still_be_planned(self):
        path = self.root / "docs/goals/README.md"
        path.write_text(path.read_text().replace("G06 is finalized", "G06 is planned"))
        self.assertTrue(any("Goals index" in error for error in CHECKER.check(self.root)))


if __name__ == "__main__":
    unittest.main()
