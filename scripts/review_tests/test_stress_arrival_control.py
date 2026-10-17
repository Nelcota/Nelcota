"""Unsafe or reused control destinations cannot start a native generator."""
from pathlib import Path
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
import arrival_check
from arrival_counters import ArrivalCounter


class ArrivalControlPreflight(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)

    def test_existing_evidence_is_preserved_without_docker_calls(self):
        output=self.root/'prior';output.mkdir()
        evidence=output/'proof.json';evidence.write_text('retained failure')
        with mock.patch('arrival_check.docker') as docker, self.assertRaises(SystemExit):
            arrival_check.run(output)
        docker.assert_not_called()
        self.assertEqual(evidence.read_text(),'retained failure')

    def test_critical_host_reserve_stops_before_provisioning_and_creates_parents(self):
        output=self.root/'fresh'/'control'
        with mock.patch('arrival_check.host_reserves',return_value='host_disk_reserve'), mock.patch('arrival_check.docker') as docker, self.assertRaises(SystemExit):
            arrival_check.run(output)
        docker.assert_not_called()
        self.assertTrue(output.is_dir())
        self.assertFalse((output/'ownership.json').exists())

    def test_insufficient_cpu_cannot_start_unbudgeted_containers(self):
        with mock.patch('arrival_check.host_reserves',return_value=None), mock.patch('arrival_check.effective_cpus',return_value=.5), mock.patch('arrival_check.docker') as docker, self.assertRaises(RuntimeError):
            arrival_check.run(self.root/'cpu-blocked')
        docker.assert_not_called()

    def test_generator_exit_does_not_skip_sparse_counter_expiry(self):
        output=self.root/'generator-already-finished'
        clock=[1000.0]
        sleeps=[]
        tracker=ArrivalCounter('scheduler-sparse',['traffic'],clock[0])
        def advance(seconds):
            sleeps.append(seconds)
            clock[0]+=seconds
        def observe(phase):
            values={}
            if clock[0]<1005:values={'traffic':484}
            return tracker.observe(values,0,clock[0])
        def begin(phase,scenarios):
            return tracker.observe({},0,clock[0])
        def finish(phase):
            observe(phase)
            return tracker.close()
        def owned(*args,**kwargs):
            if args[0]=='exec':return '1 /prometheus'
            return ''
        watchdog=mock.Mock()
        watchdog.poll.return_value=None
        child=mock.Mock()
        child.poll.return_value=0
        child.returncode=0
        thread=mock.Mock()
        thread.is_alive.return_value=False
        receiver=mock.MagicMock()
        receiver.__enter__.return_value.status=200
        metrics=mock.Mock()
        metrics.begin_phase.side_effect=begin
        metrics.observe_arrivals.side_effect=observe
        metrics.finish_phase.side_effect=finish
        metrics.value.return_value=0
        metrics.snapshot.return_value={'status':'success','data':{}}
        with mock.patch('arrival_check.host_reserves',return_value=None), mock.patch('arrival_check.effective_cpus',return_value=1), mock.patch('arrival_check.validate_disk_headroom'), mock.patch('arrival_check.OwnedDocker',return_value=mock.Mock(side_effect=owned)), mock.patch('arrival_check.cleanup'), mock.patch('arrival_check.subprocess.Popen',side_effect=[watchdog,child]), mock.patch('arrival_check.subprocess.check_output',return_value='fixture-source'), mock.patch('arrival_check.threading.Thread',return_value=thread), mock.patch('arrival_check.urllib.request.urlopen',return_value=receiver), mock.patch('arrival_check.NativeMetrics',return_value=metrics), mock.patch('arrival_check.time.monotonic',side_effect=lambda:clock[0]), mock.patch('arrival_check.time.sleep',side_effect=advance), contextlib.redirect_stdout(io.StringIO()):
            arrival_check.run(output)
        result=json.loads((output/'native-arrivals.json').read_text())
        self.assertEqual(result['status'],'passed')
        self.assertGreaterEqual(result['closed_evidence']['last_monotonic']-result['closed_evidence']['began_monotonic'],136)
        self.assertEqual(result['retained_dropped_iterations'],484)
        self.assertGreaterEqual(result['post_generator_observed_idle_seconds'],130)
        self.assertTrue(all(0<=seconds<=5 for seconds in sleeps))
        self.assertTrue(result['cleanup_confirmed'])

    def test_uncertain_cleanup_preserves_the_original_probe_failure(self):
        output=self.root/'probe-failure'
        def owned(*args,**kwargs):
            if args[0]=='ps':return 'still-owned'
            return ''
        owner=mock.Mock(side_effect=owned)
        watchdog=mock.Mock()
        watchdog.wait.side_effect=subprocess.TimeoutExpired('guardian',15)
        receiver=mock.MagicMock()
        receiver.__enter__.return_value.status=200
        metrics=mock.Mock()
        metrics.begin_phase.side_effect=ValueError('original probe failure')
        with mock.patch('arrival_check.host_reserves',return_value=None), mock.patch('arrival_check.effective_cpus',return_value=1), mock.patch('arrival_check.validate_disk_headroom'), mock.patch('arrival_check.OwnedDocker',return_value=owner), mock.patch('arrival_check.cleanup'), mock.patch('arrival_check.subprocess.Popen',return_value=watchdog), mock.patch('arrival_check.subprocess.check_output',return_value='fixture-source'), mock.patch('arrival_check.urllib.request.urlopen',return_value=receiver), mock.patch('arrival_check.NativeMetrics',return_value=metrics):
            with self.assertRaisesRegex(ValueError,'original probe failure'):
                arrival_check.run(output)
        watchdog.wait.assert_not_called()
        completion=json.loads((output/'completion.json').read_text())
        self.assertEqual(completion['status'],'failed')
        self.assertFalse(completion['cleanup_confirmed'])
        self.assertEqual(json.loads((output/'native-arrivals.json').read_text())['error_type'],'ValueError')


if __name__=='__main__':
    unittest.main()
