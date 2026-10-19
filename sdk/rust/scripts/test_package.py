"""Exercise archive selection using Cargo's real metadata without compiling a consumer."""
import os
from pathlib import Path
import runpy
import tempfile
import tomllib
import unittest
from unittest.mock import patch


class ArchiveSelected(Exception):
    """Stop before unpacking the selected test archive."""


class PackageSelectionTests(unittest.TestCase):
    def test_effective_target_directory_selects_the_new_archive(self):
        root = Path(__file__).resolve().parents[3]
        script = root / "sdk/rust/scripts/package-test.py"
        package = tomllib.loads((root / "sdk/rust/Cargo.toml").read_text())["package"]
        target_parent = root / "target"
        target_parent.mkdir(exist_ok=True)
        for relative in [False, True]:
            # Keep relative paths on the repository's drive on Windows too.
            with self.subTest(relative=relative), tempfile.TemporaryDirectory(dir=target_parent, prefix="package test ") as directory:
                target = Path(directory) / "build"
                archive = target / "package" / f"{package['name']}-{package['version']}.crate"
                archive.parent.mkdir(parents=True)
                archive.touch()
                setting = str(target)
                if relative:
                    setting = os.path.relpath(target, root)
                with patch.dict(os.environ, {"CARGO_TARGET_DIR": setting}):
                    with patch("tarfile.open", side_effect=ArchiveSelected) as opening:
                        with self.assertRaises(ArchiveSelected):
                            runpy.run_path(str(script), run_name="__main__")
                        self.assertEqual(Path(opening.call_args.args[0]).resolve(), archive)


if __name__ == "__main__":
    unittest.main()
