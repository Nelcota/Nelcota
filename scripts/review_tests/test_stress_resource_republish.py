"""A public series cannot hide strings, duplicate keys or gzip metadata."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'bench'))
from resource_republish import GAUGES, notices, validate_series


class PublicResourceRecovery(unittest.TestCase):
    def series(self, *, name='resources.jsonl', extra=None, duplicate=False):
        rows=[]
        for now in [1,6]:
            row={'monotonic':now,'phase':'baseline','components':{'app-0':dict.fromkeys(GAUGES,1)}}
            if extra:row.update(extra)
            text=json.dumps(row)
            if duplicate:text=text.replace('"phase": "baseline"','"phase": "private-token", "phase": "baseline"')
            rows.append(text+'\n')
        output=io.BytesIO()
        with gzip.GzipFile(filename=name,fileobj=output,mode='wb',mtime=0) as stream:stream.write(''.join(rows).encode())
        raw=output.getvalue()
        metadata={'samples':2,'maximum_gap_seconds':5,'sha256':hashlib.sha256(raw).hexdigest(),'compressed_bytes':len(raw)}
        return raw,metadata

    def test_original_numeric_gzip_round_trip_preserves_its_checksum(self):
        raw,metadata=self.series()
        self.assertEqual(validate_series(raw,metadata,'matrix'),{'samples':2,'maximum_gap_seconds':5})
        report={'identity':'native-matrix-123-1','source':'a'*40,'binary_sha256':'b'*64,'certifies_g05':False,
                'status':'passed','cleanup_confirmed':True,'checks':{'resource_evidence':metadata}}
        emitted=notices(report,raw,'matrix','123','c'*40)
        self.assertEqual(len(emitted),2)
        self.assertIn(metadata['sha256'],emitted[0])

    def test_private_json_fields_and_duplicate_keys_are_rejected(self):
        for options in [{'extra':{'token':'private-token'}},{'duplicate':True}]:
            raw,metadata=self.series(**options)
            with self.subTest(options=options),self.assertRaises(ValueError):validate_series(raw,metadata,'matrix')

    def test_gzip_filename_cannot_republish_a_private_path(self):
        raw,metadata=self.series(name='private-token')
        with self.assertRaises(ValueError):validate_series(raw,metadata,'matrix')

    def test_corrupt_checksum_missing_samples_and_nonfinite_clock_are_rejected(self):
        raw,original=self.series()
        for field,value in [('sha256','a'*64),('samples',0),('maximum_gap_seconds',float('nan'))]:
            metadata={**original,field:value}
            with self.subTest(field=field),self.assertRaises(ValueError):validate_series(raw,metadata,'matrix')
        raw,metadata=self.series(extra={'monotonic':float('nan')})
        with self.assertRaises(ValueError):validate_series(raw,metadata,'matrix')

    def test_trailing_or_concatenated_gzip_data_is_not_republished(self):
        original,_=self.series()
        for raw in [original+b'private-token',original+original]:
            metadata={'samples':2,'maximum_gap_seconds':5,'sha256':hashlib.sha256(raw).hexdigest(),'compressed_bytes':len(raw)}
            with self.subTest(size=len(raw)),self.assertRaises(ValueError):validate_series(raw,metadata,'matrix')
