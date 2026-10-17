"""A sparse drop cannot vanish after the metrics retention window expires."""
import io
import json
import math
from pathlib import Path
import sys
import unittest
from unittest import mock
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'bench'))
from arrival_counters import ArrivalCounter, closed_count
from metrics import NativeMetrics


class ContinuousArrivals(unittest.TestCase):
    def test_an_early_drop_survives_four_hours_without_another_counter_sample(self):
        counter = ArrivalCounter('soak', ['traffic', 'session-canary'], 0)
        counter.observe({}, 0, 0)
        counter.observe({'traffic': 607}, 0, 5)
        for second in range(10, 14401, 5):
            counter.observe({}, 0, second)
        evidence = counter.close()
        self.assertEqual(closed_count(evidence, 'soak', 'traffic', 14400), 607)
        self.assertEqual(evidence['dropped_by_scenario']['session-canary'], 0)
        self.assertLess(len(json.dumps(evidence)), 600)

    def test_intermediate_gap_cannot_hide_behind_a_fresh_final_sample(self):
        counter = ArrivalCounter('soak', ['traffic'], 0)
        counter.observe({}, 0, 0)
        with self.assertRaisesRegex(ValueError, 'gap'):
            counter.observe({'traffic': 1}, 0, 31)

    def test_counter_reset_or_regression_invalidates_evidence(self):
        for values, resets in [({'traffic': 3}, 0), ({}, 1)]:
            counter = ArrivalCounter('soak', ['traffic'], 0)
            counter.observe({'traffic': 4}, 0, 0)
            with self.subTest(values=values), self.assertRaises(ValueError):
                counter.observe(values, resets, 5)

    def test_scenario_isolation_and_late_sparse_updates_remain_exact(self):
        counter = ArrivalCounter('noisy-write', ['project-0', 'project-1'], 0)
        counter.observe({'project-0': 7, 'project-1': 2}, 0, 0)
        counter.observe({}, 0, 5)
        counter.observe({'project-0': 9}, 0, 10)
        evidence = counter.close()
        self.assertEqual(closed_count(evidence, 'noisy-write', 'project-0', 10), 9)
        self.assertEqual(closed_count(evidence, 'noisy-write', 'project-1', 10), 2)
        with self.assertRaises(ValueError):
            counter.observe({'project-1': 3}, 0, 15)

    def test_invalid_numbers_or_unknown_scenarios_cannot_become_zero(self):
        for value in [True, -1, .5, math.nan, math.inf, 10**1000]:
            counter = ArrivalCounter('soak', ['traffic'], 0)
            with self.subTest(value=str(value)[:20]), self.assertRaises(ValueError):
                counter.observe({'traffic': value}, 0, 5)
        counter = ArrivalCounter('soak', ['traffic'], 0)
        with self.assertRaises(ValueError):
            counter.observe({'project-0': 1}, 0, 5)
        with self.assertRaises(ValueError):
            counter.observe({}, 0, math.nan)

    def test_missing_final_coverage_or_inconsistent_persisted_evidence_is_rejected(self):
        counter = ArrivalCounter('soak', ['traffic'], 0)
        counter.observe({}, 0, 0)
        with self.assertRaises(ValueError):
            counter.close()
        counter.observe({}, 0, 5)
        evidence = counter.close()
        with self.assertRaises(ValueError):
            closed_count(evidence, 'soak', 'traffic', 14400)
        evidence['last_monotonic'] = 14400
        with self.assertRaises(ValueError):
            closed_count(evidence, 'soak', 'traffic', 14400)


class MetricsArrivalIntegration(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.rows = []
        self.reset = 0
        self.metrics = NativeMetrics('http://127.0.0.1:1', retain_http_counters=True)

    def response(self, url, **kwargs):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['query'][0]
        rows = [{'value': [1, '1']}]
        if query.startswith('last_over_time(k6_http_reqs_total'):
            rows = [{'metric':{'run_id':'soak','scenario':'traffic','project':'single','status':'200','method':'GET','workload':'read'},'value':[1,'1']}]
        if query.startswith('last_over_time(k6_expected_rejections_total'):
            rows = []
        if 'sum by(scenario)' in query:
            rows = self.rows
        if 'sum(resets(' in query:
            rows = [{'value': [1, str(self.reset)]}]
        return io.BytesIO(json.dumps({'status': 'success', 'data': {'resultType': 'vector', 'result': rows}}).encode())

    def test_final_long_summary_keeps_a_drop_that_disappeared_from_the_server(self):
        with mock.patch('metrics.urllib.request.urlopen', side_effect=self.response), mock.patch('metrics.time.monotonic', side_effect=lambda:self.now):
            self.metrics.begin_phase('soak', ['traffic', 'session-canary'])
            self.rows = [{'metric': {'scenario': 'traffic'}, 'value': [1, '607']}]
            self.now = 5
            self.metrics.observe_arrivals('soak')
            self.rows = []
            for second in range(10, 14401, 5):
                self.now = second
                self.metrics.observe_arrivals('soak')
            self.metrics.finish_phase('soak')
            report = self.metrics.summary('soak', 14400)
        self.assertEqual(report['metrics']['dropped_iterations']['count'], 607)
        self.assertEqual(closed_count(report['arrival_counter_evidence'], 'soak', 'traffic', 14400), 607)

    def test_real_reset_and_ambiguous_remote_scenarios_fail_closed(self):
        with mock.patch('metrics.urllib.request.urlopen', side_effect=self.response), mock.patch('metrics.time.monotonic', side_effect=lambda:self.now):
            self.metrics.begin_phase('soak', ['traffic'])
            self.reset = 1
            self.now = 5
            with self.assertRaisesRegex(ValueError, 'reset'):
                self.metrics.observe_arrivals('soak')
            self.reset = 0
            self.rows = [{'metric': {'scenario': 'traffic'}, 'value': [1, '1']}] * 2
            with self.assertRaisesRegex(ValueError, 'Ambiguous'):
                self.metrics.observe_arrivals('soak')

    def test_duplicate_phase_and_unobserved_long_summary_are_rejected(self):
        with mock.patch('metrics.urllib.request.urlopen', side_effect=self.response), mock.patch('metrics.time.monotonic', side_effect=lambda:self.now):
            self.metrics.begin_phase('soak', ['traffic'])
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                self.metrics.begin_phase('soak', ['traffic'])
            with self.assertRaisesRegex(ValueError, 'require continuous'):
                self.metrics.summary('unobserved', 14400)

    def test_long_summary_without_full_coverage_fails_before_network_io(self):
        with mock.patch('metrics.urllib.request.urlopen') as request:
            with self.assertRaisesRegex(ValueError, 'require continuous'):
                self.metrics.summary('unobserved', 14400)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
