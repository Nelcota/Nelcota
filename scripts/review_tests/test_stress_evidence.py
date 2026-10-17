"""Public bundles preserve failures without raw logs or credential fixtures."""
from pathlib import Path
import json
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from evidence import export,sanitize


class SafeEvidence(unittest.TestCase):
    def test_raw_logs_and_secret_values_are_not_published(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'raw';source.mkdir()
            (source/'app.log').write_text('fixture-private-marker')
            (source/'fixture.json').write_text('{"password":"fixture-private-marker"}')
            (source/'metadata.json').write_text(json.dumps({'secret':'fixture-private-marker','postgres':'postgres://user:fixture-private-marker@127.0.0.1/database','url':'http://127.0.0.1/path?X-Amz-Signature=fixture-private-marker'}))
            (source/'completion.json').write_text('{"status":"failed"}')
            output=root/'public';result=export(source,output)
            self.assertEqual(result['status'],'failed')
            self.assertFalse((output/'app.log').exists())
            self.assertFalse((output/'fixture.json').exists())
            self.assertNotIn('fixture-private-marker',(output/'metadata.json').read_text())

    def test_nonfinite_evidence_is_explicitly_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'raw';source.mkdir()
            (source/'completion.json').write_text('{"status":"passed","value":NaN}')
            result=export(source,root/'public')
            self.assertEqual(result['status'],'invalid evidence')
            self.assertEqual(len(result['invalid_evidence']),1)
