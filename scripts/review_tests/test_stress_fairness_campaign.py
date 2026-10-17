"""Noncritical interference findings retain all cells; integrity stops the run."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from host_campaign import observe_noisy_phases


class FairnessCampaign(unittest.TestCase):
    def baseline(self):
        metrics={'successful_operations':{'rate':8}}
        for operation in ['read','rls','panel','storage','login','refresh','write']:
            metrics['latency_'+operation]={'p(95)':10}
        return {'project-'+str(index):{'metrics':copy.deepcopy(metrics)} for index in range(2)}

    def report(self,baseline):
        value=copy.deepcopy(baseline)
        for row in value.values():
            row['metrics'].update(iterations={'count':2400},dropped_iterations={'count':0},overload_rejections={'count':0})
            for operation in ['read','rls','panel','storage','login','refresh','write']:
                row['metrics']['latency_'+operation]['p(99)']=20
        return value

    def test_a_failed_relative_gate_is_retained_while_all_five_cases_run(self):
        baseline=self.baseline();calls=[]
        def run(phase,rates,hot):
            calls.append((phase,rates,hot));report=self.report(baseline)
            if hot=='login':report['project-1']['metrics']['latency_rls']['p(95)']=13
            return report
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            failures=observe_noisy_phases(run,2,8,300,baseline,root)
            self.assertEqual([call[2] for call in calls],['mixed','login','read','storage','write'])
            self.assertTrue(all(call[1]==[32,8] for call in calls))
            self.assertEqual([row['phase'] for row in failures],['noisy-login'])
            self.assertEqual(json.loads((root/'acceptance-failures.json').read_text()),failures)
            self.assertEqual(len(list(root.glob('noisy-*-gates.json'))),5)

    def test_critical_execution_failure_stops_remaining_cells(self):
        baseline=self.baseline();calls=[]
        def run(phase,rates,hot):
            calls.append(hot)
            if hot=='login':raise RuntimeError('Owned integrity guard stopped traffic')
            return self.report(baseline)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,'integrity guard'):
                observe_noisy_phases(run,2,8,300,baseline,Path(directory))
            self.assertEqual(calls,['mixed','login'])

    def test_missing_healthy_project_evidence_cannot_be_a_fairness_pass(self):
        baseline=self.baseline()
        def run(phase,rates,hot):return {'project-0':self.report(baseline)['project-0']}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):observe_noisy_phases(run,2,8,300,baseline,Path(directory))

    def test_incomplete_balanced_baseline_cannot_hide_a_missing_project(self):
        baseline={'project-0':self.baseline()['project-0']}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):observe_noisy_phases(lambda *args:None,2,8,300,baseline,Path(directory))


if __name__=='__main__':
    unittest.main()
