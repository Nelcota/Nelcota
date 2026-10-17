"""Installed package metadata must not redirect writes outside owned staging."""
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'bench'))
from browser_runtime import runtime_target, runtime_library, runtime_dependencies


class BrowserRuntimeOwnership(unittest.TestCase):
    def test_parent_traversal_from_package_metadata_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'runtime'
            root.mkdir()
            with self.assertRaises(ValueError):
                runtime_target(root, root/'../../../foreign.dist-info/METADATA')

    def test_symlink_alias_cannot_escape_to_another_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, other = Path(temporary)/'runtime', Path(temporary)/'foreign'
            root.mkdir();other.mkdir()
            (root/'package').symlink_to(other, target_is_directory=True)
            with self.assertRaises(ValueError):
                runtime_target(root, root/'package/METADATA')
            self.assertEqual(list(other.iterdir()), [])

    def test_fresh_nested_owned_asset_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'runtime'
            root.mkdir()
            target = root/'python/lib/site-packages/package.dist-info/METADATA'
            self.assertEqual(runtime_target(root, target), target)

    def test_standard_loader_alias_resolves_into_a_trusted_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trusted = root/'usr/lib'
            trusted.mkdir(parents=True)
            loader = trusted/'ld-linux.so'
            loader.write_bytes(b'owned ELF fixture')
            (root/'lib64').symlink_to(trusted, target_is_directory=True)
            alias = root/'lib64/ld-linux.so'
            self.assertFalse(alias.is_relative_to(trusted))
            self.assertEqual(runtime_library(alias, [trusted]), loader)

    def test_library_symlink_cannot_disclose_an_untrusted_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trusted = root/'lib'
            trusted.mkdir()
            foreign = root/'private'
            foreign.write_bytes(b'foreign data must not be staged')
            alias = trusted/'libexample.so'
            alias.symlink_to(foreign)
            self.assertTrue(alias.is_relative_to(trusted))
            with self.assertRaises(ValueError):
                runtime_library(alias, [trusted])

    def test_missing_native_dependency_cannot_be_approved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(FileNotFoundError):
                runtime_library(root/'missing.so', [root])

    @unittest.skipUnless(Path('/usr/lib/x86_64-linux-gnu/libsoftokn3.so').is_file(), 'Native Linux NSS module is not installed')
    def test_real_NSS_module_includes_its_dynamically_loaded_SQLite_dependency(self):
        modules = runtime_dependencies([Path('/usr/lib/x86_64-linux-gnu/libsoftokn3.so')], [Path('/lib'), Path('/usr/lib')])
        self.assertTrue(any(path.name=='libsqlite3.so.0' for path in modules))
        self.assertTrue(all(path.resolve().is_file() for path in modules))


if __name__ == '__main__':
    unittest.main()
