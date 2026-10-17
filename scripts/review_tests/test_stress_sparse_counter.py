"""Sparse real refreshes cannot disappear behind the Prometheus lookback."""
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'bench'))
from metrics import NativeMetrics


class SparseCounterEvidence(unittest.TestCase):
    def setUp(self):
        self.metrics = NativeMetrics('http://127.0.0.1:1')
        self.queries = []

    def response(self, request, **kwargs):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(request).query)['query'][0]
        self.queries.append(query)
        rows = []
        if 'resets(' in query:
            rows = [{'value': [1, '0']}]
        if 'last_over_time(' in query:
            rows = [{'value': [1, '5']}]
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps({'status': 'success', 'data': {'result': rows}}).encode()
        return response

    def test_old_instant_query_misses_five_genuine_renewals_but_last_sample_retains_them(self):
        with mock.patch('metrics.urllib.request.urlopen', side_effect=self.response):
            with self.assertRaisesRegex(ValueError, 'Missing'):
                self.metrics.value('sum(k6_access_renewals_total{run_id="soak",scenario="session-canary"})')
            self.assertEqual(self.metrics.sparse_counter('access_renewals', 'soak', 'session-canary'), 5)
        self.assertIn('last_over_time(', self.queries[-1])
        self.assertIn('[3600s]', self.queries[-1])

    def test_counter_reset_cannot_be_hidden_by_an_earlier_high_value(self):
        with mock.patch.object(self.metrics, 'value', return_value=1) as value:
            with self.assertRaisesRegex(ValueError, 'reset'):
                self.metrics.sparse_counter('access_renewals', 'soak', 'session-canary')
        self.assertEqual(value.call_count, 1)

    def test_missing_range_is_an_error_not_an_invented_zero(self):
        with mock.patch.object(self.metrics, 'value', side_effect=[0, ValueError('Missing range')]):
            with self.assertRaisesRegex(ValueError, 'Missing range'):
                self.metrics.sparse_counter('access_renewals', 'soak', 'session-canary')

    def test_nonfinite_retained_sample_is_rejected(self):
        def invalid(request, **kwargs):
            response = self.response(request, **kwargs)
            if 'last_over_time' in self.queries[-1]:
                response.read.return_value = json.dumps({'status': 'success', 'data': {'result': [{'value': [1, 'NaN']}]}}).encode()
            return response
        with mock.patch('metrics.urllib.request.urlopen', side_effect=invalid):
            with self.assertRaisesRegex(ValueError, 'Non-finite'):
                self.metrics.sparse_counter('access_renewals', 'soak', 'session-canary')

    def test_selector_injection_and_unretained_windows_are_rejected_before_io(self):
        with mock.patch('metrics.urllib.request.urlopen') as request:
            for value in ['', 'soak"}', True, '../metric']:
                with self.assertRaises(ValueError):
                    self.metrics.sparse_counter('access_renewals', value, 'session-canary')
            for window in [0, 59, 3601, True, 3600.0]:
                with self.assertRaises(ValueError):
                    self.metrics.sparse_counter('access_renewals', 'soak', 'session-canary', window)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
