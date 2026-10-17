"""Fleet sampling must progress concurrently and drain every probe owner."""
import os
import json
from pathlib import Path
import subprocess
import sys
import threading
import tempfile
import unittest
import urllib.error
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from fleet_observer import collect,retain_metrics_snapshot
from host_resources import owned_cgroup_snapshot


class FleetObservation(unittest.TestCase):
    def test_lost_metric_server_cannot_mask_the_original_resource_stop(self):
        class MissingMetrics:
            def snapshot(self,label):raise urllib.error.URLError('Owned metrics unavailable')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            def original_failure():
                try:raise RuntimeError('resource_observation_gap')
                finally:retain_metrics_snapshot(MissingMetrics(),'capacity-100',root,failure_in_progress=sys.exception() is not None)
            with self.assertRaisesRegex(RuntimeError,'resource_observation_gap'):original_failure()
            self.assertEqual(json.loads((root/'capacity-100-metrics-error.json').read_text()),{'error_type':'URLError'})

    def test_missing_metric_snapshot_alone_still_fails_the_campaign(self):
        class MissingMetrics:
            def snapshot(self,label):raise urllib.error.URLError('Owned metrics unavailable')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(urllib.error.URLError):retain_metrics_snapshot(MissingMetrics(),'balanced-1',Path(directory))

    def test_four_independent_probes_progress_with_a_hard_concurrency_bound(self):
        lock=threading.Lock();ready=threading.Event();release=threading.Event()
        state={'active':0,'maximum':0};results=[];failures=[]
        def probe(index):
            with lock:
                state['active']+=1;state['maximum']=max(state['maximum'],state['active'])
                if state['active']==4:ready.set()
            try:
                if not release.wait(3):raise RuntimeError('Independent observation did not progress')
                return index
            finally:
                with lock:state['active']-=1
        def observe():
            try:results.append(collect({str(index):lambda value=index:probe(value) for index in range(12)},lambda:failures.append(True)))
            except Exception as error:failures.append(type(error).__name__)
        owner=threading.Thread(target=observe)
        owner.start()
        try:self.assertTrue(ready.wait(2))
        finally:release.set();owner.join(timeout=4)
        self.assertFalse(owner.is_alive());self.assertEqual(failures,[])
        self.assertEqual(state['maximum'],4);self.assertEqual(state['active'],0)
        self.assertEqual(results[0]['values'],{str(index):index for index in range(12)})
        self.assertEqual(set(results[0]['durations_seconds']),set(results[0]['values']))

    def test_one_failed_probe_signals_traffic_stop_before_waiting_for_other_owners(self):
        blocked=threading.Event();release=threading.Event();critical=threading.Event();errors=[]
        def slow():
            blocked.set()
            if not release.wait(3):raise RuntimeError('Test owner did not release')
            return 1
        def fail():
            if not blocked.wait(2):raise RuntimeError('Slow owner did not start')
            raise ValueError('Missing component evidence')
        def observe():
            try:collect({'slow':slow,'failed':fail},critical.set)
            except Exception as error:errors.append(type(error).__name__)
        owner=threading.Thread(target=observe);owner.start()
        try:
            self.assertTrue(critical.wait(2))
            self.assertTrue(owner.is_alive())
        finally:release.set();owner.join(timeout=4)
        self.assertFalse(owner.is_alive());self.assertEqual(errors,['ValueError'])

    def test_repeated_complete_batches_leave_no_probe_threads(self):
        for _ in range(10):
            collect({str(index):lambda value=index:value for index in range(12)},self.fail)
            self.assertFalse(any(thread.name.startswith('g05-probe') for thread in threading.enumerate()))

    @unittest.skipUnless(Path('/sys/fs/cgroup/memory.current').exists() and Path('/bin/sh').exists(),'Native cgroup v2 shell observation unavailable')
    def test_native_shell_observation_needs_no_cat_or_other_path_executable(self):
        def owned(*arguments):
            self.assertEqual(arguments[:2],('exec','owned-component'))
            return subprocess.check_output(['/bin/sh',*arguments[3:]],text=True,env={**os.environ,'PATH':'/nonexistent-g05-path'},timeout=5)
        observed=owned_cgroup_snapshot(owned,'owned-component',shell_builtins=True)
        self.assertGreaterEqual(observed['memory.current'],0)
        self.assertGreater(observed['cpu.max']['period_usec'],0)
        self.assertIn('nr_throttled',observed['cpu.stat'])
        self.assertIn('oom_kill',observed['memory.events'])


if __name__=='__main__':
    unittest.main()
