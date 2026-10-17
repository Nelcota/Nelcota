"""Failure evidence preserves useful locations without publishing private logs."""
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'bench'))
from browser_diagnostics import collect, log_projection, validate, validate_log


class BrowserFailureDiagnostics(unittest.TestCase):
    def test_only_fixed_categories_and_exact_driver_line_numbers_are_published(self):
        raw=b'File "/private/token.py", line 999\nFile "/driver.py", line 127\nModuleNotFoundError: No module named \'playwright\'\nprivate-token postgres://private-password@host/db'
        value=log_projection(raw,len(raw))
        self.assertEqual(value['driver_lines'],[127])
        self.assertEqual(value['categories']['missing-playwright'],1)
        self.assertNotIn('private',json.dumps(value))
        self.assertNotIn('postgres://',json.dumps(value))

    def test_log_tail_and_locations_have_fixed_bounds(self):
        raw=b'x'*70000+b'File "/driver.py", line 0\nFile "/driver.py", line 10001\n'+b'\n'.join(f'File "/driver.py", line {i}'.encode() for i in range(1,50))
        value=log_projection(raw,len(raw))
        self.assertTrue(value['log_truncated'])
        self.assertEqual(value['observed_log_bytes'],65536)
        self.assertEqual(value['driver_lines'],list(range(1,17)))

    def test_republication_rejects_injected_log_fields_and_nonfinite_counts(self):
        original=log_projection(b'',0)
        for key,value in [('message','private-token'),('driver_lines',[True]),('observed_log_bytes',float('nan')),('available',False)]:
            changed=copy.deepcopy(original);changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):validate_log(changed)

    def test_failed_driver_markers_and_resource_probe_are_collected_before_cleanup(self):
        def call(*args,**kwargs):raise RuntimeError('private-token')
        project=SimpleNamespace(setup_stage='ready',docker=call,app='app',pg='pg')
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder);(output/'untrusted-ca').mkdir()
            (output/'untrusted-ca/driver-ready').touch()
            (output/'untrusted-ca.log').write_text('File "/driver.py", line 127\nprivate-token')
            value=collect(output,project,project,call,'driver',[{'probe':'driver','type':'RuntimeError'}])
        self.assertEqual(value['driver'],{'available':False})
        self.assertTrue(value['drivers']['untrusted-ca']['markers']['driver-ready'])
        self.assertFalse(value['drivers']['untrusted-ca']['markers']['driver-start'])
        self.assertEqual(value['resource_failures'],[{'probe':'driver','type':'RuntimeError','count':1}])
        self.assertNotIn('private-token',json.dumps(value))
        value['drivers']['untrusted-ca']['log']['environment']='private-token'
        with self.assertRaises(ValueError):validate(value)
