"""Retained browser metrics must independently enforce existing owner gates."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'bench'))
from browser_owners import PHASES, complete


class BrowserOwnerEvidence(unittest.TestCase):
    def values(self):
        return [{'phase':phase,'seconds_since_auth':index*150,
                 'pages':[{'documents':2,'nodes':100+index,'listeners':10,'heap_bytes':1048576+index} for _ in range(3)]}
                for index,phase in enumerate(PHASES)]

    def test_all_three_tabs_keep_seven_actual_plateaus_and_numeric_deltas(self):
        value=complete(self.values())
        self.assertEqual(len(value['plateaus']),7)
        self.assertEqual(value['final_minus_baseline_per_tab'],[{'documents':0,'heap_bytes':6,'listeners':0,'nodes':6}]*3)

    def test_private_fields_nonfinite_counts_and_incomplete_phases_are_rejected(self):
        for field,value in [('token','private-token'),('heap_bytes',float('nan')),('listeners',True)]:
            values=self.values();values[0]['pages'][0][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):complete(values)
        values=self.values();values.pop(2)
        with self.assertRaises(ValueError):complete(values)

    def test_existing_growth_budgets_cannot_be_hidden_by_a_passed_driver(self):
        for field,growth in [('heap_bytes',8*1024**2+1),('nodes',251),('listeners',33)]:
            values=self.values();values[-1]['pages'][1][field]=values[0]['pages'][1][field]+growth
            with self.subTest(field=field),self.assertRaises(ValueError):complete(values)
