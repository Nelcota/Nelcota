"""Preparation, overlapping drivers and interrupted soak cannot inflate time."""
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from load_time import interval, lower_bound


class ActualLoadAccounting(unittest.TestCase):
    def row(self, began=0, ended=330, requested=300, completed=True):
        return {'started_monotonic':began, 'ended_monotonic':ended, 'elapsed_seconds':ended-began,
                'requested_seconds':requested, 'completed':completed, 'phase':'mixed'}

    def test_long_setup_is_not_counted_as_test_time(self):
        self.assertEqual(lower_bound([interval(self.row(0, 900, 300))]), 300)

    def test_concurrent_driver_windows_do_not_double_count(self):
        values=[interval(self.row(0,330)), interval(self.row(100,430))]
        self.assertEqual(lower_bound(values),300)

    def test_sequential_completed_windows_count_their_measured_duration(self):
        values=[interval(self.row(0,330)), interval(self.row(340,670))]
        self.assertEqual(lower_bound(values),600)

    def test_interrupted_four_hour_run_is_not_a_completed_interval(self):
        self.assertIsNone(interval(self.row(0,12000,14400,False)))

    def test_invalid_or_nonfinite_evidence_cannot_add_time(self):
        for value in [None,True,float('nan'),float('inf'),-1,0,40000]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                interval(self.row(requested=value))


if __name__=='__main__':
    unittest.main()
