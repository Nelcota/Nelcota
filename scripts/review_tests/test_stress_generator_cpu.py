"""Generator diagnostics cannot expose cgroup paths or private counter fields."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'bench'))
import generator_cpu


class GeneratorCpuEvidence(unittest.TestCase):
    def test_real_observations_keep_numeric_cpu_ownership_and_steal(self):
        cpus = set(generator_cpu.os.sched_getaffinity(0))
        before = generator_cpu.observe(cpus)
        after = generator_cpu.observe(cpus)
        self.assertEqual(before['affinity'], sorted(cpus))
        self.assertGreaterEqual(after['process_user_usec'], before['process_user_usec'])
        self.assertGreaterEqual(after['current_process_cgroup_cpu']['usage_usec'],
                                before['current_process_cgroup_cpu']['usage_usec'])
        self.assertEqual(len(before['host_cpu_ticks']), len(cpus))
        self.assertTrue(all(type(value) is int and value >= 0
                            for cpu in before['host_cpu_ticks'].values() for value in cpu.values()))

    def test_namespace_escape_or_incomplete_counters_prevent_measurement(self):
        with patch.object(Path, 'read_text', return_value='0::/../../private-host\n'):
            with self.assertRaisesRegex(ValueError, 'unambiguous'):
                generator_cpu.observe({0})
        with patch.object(Path, 'read_text', return_value='0::/\n'), \
                patch.object(generator_cpu, 'counters', return_value={'usage_usec': 1}):
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                generator_cpu.observe({0})

    def test_unknown_counter_strings_never_enter_public_cpu_projection(self):
        original = Path.read_text
        def read(path, *args, **kwargs):
            if str(path) == '/proc/self/cgroup':
                return '0::/\n'
            if path.name == 'cpu.max':
                return '100000 100000\n'
            return original(path, *args, **kwargs)
        values = dict.fromkeys(['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'], 1)
        values['private'] = 'private-token'
        with patch.object(Path, 'read_text', read), patch.object(generator_cpu, 'counters', return_value=values), \
                patch.object(generator_cpu, 'snapshot', return_value={'cpu_ticks': {'cpu0': {'total_without_guests': 1, 'steal': 0}}}):
            point = generator_cpu.observe({0})
        self.assertNotIn('private', point['current_process_cgroup_cpu'])
        self.assertNotIn('private-token', str(point))
        self.assertEqual(point['cpu_quota_usec'], point['cpu_period_usec'])


if __name__ == '__main__':
    unittest.main()
