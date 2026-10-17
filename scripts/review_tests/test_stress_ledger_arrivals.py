"""Completed work during pacing cannot create false generator saturation."""
from collections import Counter
from concurrent.futures import Future
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'bench'))
from ledger_arrivals import collect_ready, has_capacity


class LedgerArrivalOwners(unittest.TestCase):
    def test_work_finishing_during_pacing_releases_capacity_and_counts_once(self):
        pending = {Future() for _ in range(8)}
        counts, latencies = Counter(), []
        collect_ready(pending, counts, latencies)
        self.assertFalse(has_capacity(pending, counts, latencies))
        # Model completion after the previous poll, during the pacing sleep.
        for future in pending:
            future.set_result(('200', 1, 25))
        self.assertTrue(has_capacity(pending, counts, latencies))
        self.assertEqual(len(pending), 0)
        self.assertEqual(counts, {'200': 8, 'acknowledged': 8})
        self.assertEqual(latencies, [25] * 8)
        self.assertTrue(has_capacity(pending, counts, latencies))
        self.assertEqual(counts['acknowledged'], 8)

    def test_rejections_and_intentional_reply_loss_are_not_successful_latency(self):
        pending = {Future() for _ in range(3)}
        for future, value in zip(pending, [('503', 0, 10), ('deliberately-dropped-reply', 0, None), ('200', 1, 50)]):
            future.set_result(value)
        counts, latencies = Counter(), []
        self.assertTrue(has_capacity(pending, counts, latencies))
        self.assertEqual(counts['acknowledged'], 1)
        self.assertEqual(latencies, [50])

    def test_worker_failure_remains_fatal_and_invalid_limits_are_rejected(self):
        future = Future()
        future.set_exception(RuntimeError('confirmed invariant failure'))
        with self.assertRaisesRegex(RuntimeError, 'invariant'):
            has_capacity({future}, Counter(), [])
        for maximum in [0, -1, True, float('nan')]:
            with self.subTest(maximum=maximum), self.assertRaises(ValueError):
                has_capacity(set(), Counter(), [], maximum)


if __name__ == '__main__':
    unittest.main()
