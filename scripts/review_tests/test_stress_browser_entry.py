"""Isolated browser staging must work without system site-layout assumptions."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from browser_entry import staged_site


class IsolatedBrowserEntry(unittest.TestCase):
    def test_unseen_staged_package_loads_without_weakening_isolation(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);runtime=root/'runtime'
            site=runtime/'python/lib'/f'python{sys.version_info.major}.{sys.version_info.minor}'/'site-packages'
            site.mkdir(parents=True)
            (site/'g05_owned_fixture.py').write_text('value=42\n')
            foreign=root/'foreign';foreign.mkdir()
            (foreign/'g05_foreign_fixture.py').write_text('raise RuntimeError("untrusted import")\n')
            driver=root/'driver.py'
            driver.write_text('import sys,importlib.util\nassert sys.flags.isolated\nassert importlib.util.find_spec("g05_foreign_fixture") is None\nimport g05_owned_fixture\nassert g05_owned_fixture.value==42\n')
            env={**os.environ,'PYTHONPATH':str(foreign)}
            before=subprocess.run([sys.executable,'-I',str(driver)],capture_output=True,text=True,timeout=5,env=env)
            self.assertNotEqual(before.returncode,0)
            self.assertIn('ModuleNotFoundError',before.stderr)
            code='import runpy; entry=runpy.run_path('+repr(str(ROOT/'bench/browser_entry.py'))+'); entry["launch"]('+repr(str(runtime))+','+repr(str(driver))+')'
            after=subprocess.run([sys.executable,'-I','-c',code],capture_output=True,text=True,timeout=5,env=env)
            self.assertEqual(after.returncode,0,after.stderr)

    def test_package_symlink_cannot_escape_to_another_runtime(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);foreign=root/'foreign';foreign.mkdir()
            parent=root/'runtime/python/lib'/f'python{sys.version_info.major}.{sys.version_info.minor}'
            parent.mkdir(parents=True);(parent/'site-packages').symlink_to(foreign,target_is_directory=True)
            with self.assertRaises(ValueError):staged_site(root/'runtime')

    def test_missing_packages_do_not_fall_back_to_installed_host_packages(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):staged_site(folder)
