"""The emitted full workload and its evidence must use the same capacity rates."""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'bench'))
import matrix_probe as runner
import fault_campaign as workload


def probes():
    return [{'rate':rate, 'requested_seconds':300, 'elapsed_seconds':300.01,
             'nominal_qualified':rate<=32} for rate in [16,32,48,64]]


class MatrixCapacityContract(unittest.TestCase):
    def test_actual_emitted_rate_and_complete_probe_evidence_agree(self):
        command = runner.campaign_arguments(Path('/owned/nelcota'), 'owned-matrix', True)
        offered = int(command[command.index('--provisional-rate')+1])
        self.assertEqual(offered, 64)
        arguments = ['fault_campaign.py', '--output', '/owned/output', *command[command.index('--binary'):]]
        with patch.object(sys, 'argv', arguments), patch.object(workload, 'run') as launch:
            workload.main()
        parsed = launch.call_args.args[0]
        self.assertEqual(parsed.provisional_rate, offered)
        self.assertEqual(workload.STEP_SECONDS, 300)
        self.assertEqual(workload.offered_rates(parsed.provisional_rate),
                         [value['rate'] for value in runner.capacity_probe_evidence(probes())])
        self.assertFalse(runner.capacity_probe_evidence(probes())[-1]['nominal_qualified'])
        self.assertEqual(command[command.index('--matrix-step-seconds')+1], '120')
        smoke = runner.campaign_arguments(Path('/owned/nelcota'), 'owned-smoke', False)
        self.assertNotIn('--capacity', smoke)
        self.assertEqual(smoke[smoke.index('--matrix-step-seconds')+1], '20')

    def test_half_rate_missing_duplicate_or_reordered_steps_are_rejected(self):
        half = probes()
        for row in half:
            row['rate'] //= 2
        for value in [half, probes()[:-1], [probes()[0]]*4, list(reversed(probes()))]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                runner.capacity_probe_evidence(value)
        for bad in [True, None, 3, 65, 32.0]:
            with self.subTest(provisional=bad), self.assertRaises(ValueError):
                workload.offered_rates(bad)

    def test_nonfinite_short_or_untyped_measurements_cannot_certify_a_step(self):
        for key, bad in [('rate',16.0), ('rate',True), ('requested_seconds',299),
                         ('elapsed_seconds',299.99), ('elapsed_seconds',float('nan')),
                         ('elapsed_seconds',float('inf')), ('nominal_qualified',1)]:
            value = copy.deepcopy(probes()); value[0][key] = bad
            with self.subTest(key=key, bad=bad), self.assertRaises(RuntimeError):
                runner.capacity_probe_evidence(value)


if __name__=='__main__':
    unittest.main()
