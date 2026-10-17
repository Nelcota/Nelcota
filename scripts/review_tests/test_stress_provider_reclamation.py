"""Actual provider namespaces need neither zero directory blocks nor one entry per object."""
import math
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from provider_reclamation import verify


class ProviderReclamation(unittest.TestCase):
    def setUp(self):
        self.before={'elapsed_seconds':2,'disk_mib':1,'trash_kib':4,'trash_entries':0}
        self.deleted={'elapsed_seconds':7,'disk_mib':17,'trash_kib':16732,'trash_entries':51}
        self.final={'elapsed_seconds':332,'disk_mib':1,'trash_kib':4,'trash_entries':0}
        self.empty={'objects':0,'bytes':0,'multipart_uploads':0}

    def check(self):return verify(self.before,self.deleted,self.final,self.empty,self.empty)

    def test_empty_directory_blocks_and_multiple_entries_per_logical_object_are_valid(self):
        result=self.check()
        self.assertEqual(result['reclaimed_physical_entries'],51)
        self.assertEqual(result['reclaimed_trash_kib'],16728)
        self.assertEqual(result['empty_directory_allocation_kib'],4)

    def test_provider_startup_garbage_is_also_released_with_the_deleted_payload(self):
        self.before.update(trash_kib=12,trash_entries=1)
        self.deleted.update(trash_kib=16716,trash_entries=49)
        result=self.check()
        self.assertEqual(result['reclaimed_physical_entries'],49)
        self.assertEqual(result['reclaimed_trash_kib'],16712)

    def test_returned_rss_or_disk_without_namespace_release_cannot_approve(self):
        self.final['trash_entries']=1
        with self.assertRaises(ValueError):self.check()

    def test_empty_namespace_with_unreleased_allocated_data_cannot_approve(self):
        for key,value in [('trash_kib',16732),('disk_mib',17)]:
            with self.subTest(key=key):
                original=self.final.copy();self.final[key]=value
                with self.assertRaises(ValueError):self.check()
                self.final=original

    def test_no_positive_delete_probe_or_cleanup_window_cannot_approve(self):
        for key,value in [('trash_entries',0),('trash_kib',4),('disk_mib',1),('elapsed_seconds',330)]:
            with self.subTest(key=key):
                original=self.deleted.copy();self.deleted[key]=value
                with self.assertRaises(ValueError):self.check()
                self.deleted=original

    def test_api_objects_or_multipart_uploads_still_block_physical_approval(self):
        for key in self.empty:
            inventory={**self.empty,key:1}
            with self.assertRaises(ValueError):verify(self.before,self.deleted,self.final,self.empty,inventory)

    def test_missing_boolean_negative_and_nonfinite_evidence_is_rejected(self):
        for key,value in [('trash_entries',True),('trash_entries',-1),('elapsed_seconds',math.nan),('elapsed_seconds',math.inf)]:
            original=self.final.copy();self.final[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.check()
            self.final=original
        self.final.pop('trash_entries')
        with self.assertRaises(ValueError):self.check()


if __name__=='__main__':unittest.main()
