"""Only disappearing children may accompany a complete allocated-size total."""
from pathlib import Path
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from disk_usage import parse


class AllocatedUsage(unittest.TestCase):
    def test_disappearing_child_is_counted_without_discarding_the_total(self):
        result=subprocess.CompletedProcess([],1,'17\t/data\n',"du: cannot access '/data/bucket/old-version': No such file or directory\n")
        self.assertEqual(parse(result,'/data','m')['value'],17)
        self.assertEqual(parse(result,'/data','m')['disappearing_entries'],1)
        for text in ["du: cannot read directory '/data/old': No such file or directory\n",'du: /data/old: No such file or directory\n']:
            self.assertEqual(parse(subprocess.CompletedProcess([],1,'17\t/data\n',text),'/data','m')['disappearing_entries'],1)

    def test_missing_root_permission_and_io_errors_still_fail(self):
        for error in ["du: cannot access '/data': No such file or directory\n","du: cannot access '/foreign/file': No such file or directory\n","du: cannot access '/data/file': Permission denied\n","du: cannot access '/data/file': Input/output error\n",'']:
            with self.assertRaises(RuntimeError):parse(subprocess.CompletedProcess([],1,'0\t/data\n',error),'/data','m')

    def test_missing_nonfinite_or_ambiguous_totals_cannot_certify(self):
        for text in ['', 'NaN\t/data\n','-1\t/data\n','1\t/foreign\n','1\t/data\n2\t/data\n']:
            with self.assertRaises(RuntimeError):parse(subprocess.CompletedProcess([],0,text,''),'/data','m')
