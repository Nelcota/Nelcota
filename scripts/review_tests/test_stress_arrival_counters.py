"""Scheduler drops remain visible without a VU's dynamic project tag."""
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'bench'))
from metrics import NativeMetrics


class FleetArrivalCounters(unittest.TestCase):
    def setUp(self):
        self.metrics = NativeMetrics('http://127.0.0.1:1')
        # Real labels retained from the ten-project noisy-write campaign.
        # The second project and another phase must never contaminate it.
        self.drops = [
            {'run_id': 'noisy-write', 'scenario': 'project-0', 'project': 'single', 'count': 35226},
            {'run_id': 'noisy-write', 'scenario': 'project-1', 'project': 'single', 'count': 7},
            {'run_id': 'balanced-1', 'scenario': 'project-0', 'project': 'single', 'count': 2},
            {'run_id': 'soak', 'scenario': 'traffic', 'project': 'single', 'count': 3},
            {'run_id': 'soak', 'scenario': 'session-canary', 'project': 'single', 'count': 9},
        ]

    def response(self, url, **kwargs):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['query'][0]
        values = [{'value': [1, '1']}]
        if 'k6_dropped_iterations_total{' in query:
            import re
            labels = dict(re.findall(r'([a-z_]+)="([a-z0-9-]+)"', query))
            selected = [row for row in self.drops if all(row.get(key) == value for key, value in labels.items())]
            values = []
            if selected:
                values = [{'value': [1, str(sum(row['count'] for row in selected))]}]
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps({'status': 'success', 'data': {'result': values}}).encode()
        return response

    def summary(self, phase, project=None):
        with mock.patch('metrics.urllib.request.urlopen', side_effect=self.response):
            return self.metrics.summary(phase, 300, project)['metrics']['dropped_iterations']['count']

    def test_actual_scheduler_labels_reproduce_hidden_drops_and_correct_project_total(self):
        with mock.patch('metrics.urllib.request.urlopen', side_effect=self.response):
            self.assertEqual(self.metrics.value('sum(k6_dropped_iterations_total{run_id="noisy-write",project="project-0"})', True), 0)
        self.assertEqual(self.summary('noisy-write', 'project-0'), 35226)
        self.assertEqual(self.summary('noisy-write', 'project-1'), 7)

    def test_phase_scoping_and_genuine_absence_preserve_zero(self):
        self.assertEqual(self.summary('balanced-1', 'project-0'), 2)
        self.assertEqual(self.summary('balanced-1', 'project-1'), 0)

    def test_single_project_excludes_endurance_session_canary_drops(self):
        self.assertEqual(self.summary('soak'), 3)

    def test_unsafe_project_label_is_rejected_before_network_access(self):
        with mock.patch('metrics.urllib.request.urlopen') as request:
            with self.assertRaises(ValueError):
                self.metrics.summary('noisy-write', 300, 'project-0"}')
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
