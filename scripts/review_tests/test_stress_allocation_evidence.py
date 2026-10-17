"""Allocation samples cannot certify another process, missing time or NaN."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from allocation import retain


class AllocationEvidence(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        self.source=self.root/'source'
        self.source.mkdir(mode=0o700)
        self.sample=self.source/'alloc-1-1-0.jsonl'

    def write(self,change=None):
        values=[{'schema':1,'pid':1,'monotonic_seconds':second,'monotonic_nanoseconds':0,
                 'in_use_including_mmap_bytes':2048,'free_arena_bytes':4096,'arena_bytes':5120,'mmap_bytes':1024} for second in [1,6,11]]
        if change is not None:change(values)
        self.sample.write_text(''.join(json.dumps(value)+'\n' for value in values))

    def ledger(self,ended):
        (self.root/'traffic-ledger.jsonl').write_text(json.dumps({'phase':'soak','completed':True,'started_monotonic':1,'ended_monotonic':ended})+'\n')

    def test_samples_cover_the_actual_completed_traffic_window(self):
        self.write();self.ledger(11)
        result=retain(self.source,self.root/'output')
        self.assertEqual(result['completed_traffic_coverage'],[{'phase':'soak','covered':True}])
        self.assertFalse(result['certifies_g05'])

    def test_incomplete_observer_cannot_certify_a_longer_traffic_interval(self):
        self.write();self.ledger(60)
        with self.assertRaises(ValueError):retain(self.source,self.root/'output')
        self.assertFalse((self.root/'allocation-summary.json').exists())

    def test_nonfinite_and_boolean_counters_are_rejected(self):
        for index,value in enumerate([float('nan'),True]):
            self.write(lambda rows:rows[-1].update(arena_bytes=value))
            with self.subTest(value=value),self.assertRaises(ValueError):
                retain(self.source,self.root/('output-'+str(index)))

    def test_process_mismatch_and_clock_regression_are_rejected(self):
        for index,patch in enumerate([{'pid':2},{'monotonic_seconds':5}]):
            self.write(lambda rows:rows[-1].update(patch))
            with self.subTest(patch=patch),self.assertRaises(ValueError):
                retain(self.source,self.root/('output-'+str(index)))

    def test_symlink_cannot_copy_a_foreign_file_into_the_evidence(self):
        foreign=self.root/'foreign'
        foreign.write_text('foreign data must not be copied')
        self.sample.symlink_to(foreign)
        with self.assertRaises(ValueError):retain(self.source,self.root/'output')
        self.assertEqual(list((self.root/'output').iterdir()),[])


if __name__=='__main__':unittest.main()
