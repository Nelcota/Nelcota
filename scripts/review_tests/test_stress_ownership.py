"""Owned staging must survive name collisions, process reuse and concurrent receipts."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))


class OwnershipBoundaries(unittest.TestCase):
    def test_fixture_cannot_disable_its_log_disk_budget(self):
        from ownership import OwnedDocker
        raw=mock.Mock()
        owned=OwnedDocker('this-run',raw)
        for flag in ['--log-driver=none','--log-driver','--log-opt=max-size=0']:
            with self.assertRaises(ValueError):owned('run',flag,'image')
        raw.assert_not_called()

    def test_restarted_or_external_publication_cannot_impersonate_the_fixture(self):
        from ports import published_port
        def inspection(mappings):
            return json.dumps([{'NetworkSettings':{'Ports':{'5432/tcp':mappings}}}])
        owned=mock.Mock(return_value=inspection([{'HostIp':'127.0.0.1','HostPort':'32800'}]))
        self.assertEqual(published_port(owned,'owned-db',5432,32800),32800)
        for mappings in [None,[],[{'HostIp':'0.0.0.0','HostPort':'32800'}],[{'HostIp':'127.0.0.1','HostPort':'32801'}],[{'HostIp':'127.0.0.1','HostPort':'32800'},{'HostIp':'127.0.0.1','HostPort':'32800'}]]:
            owned.return_value=inspection(mappings)
            with self.assertRaises(RuntimeError):published_port(owned,'owned-db',5432,32800)

    def test_postgres_child_oom_cannot_hide_behind_a_running_postmaster(self):
        from host_resources import require_no_oom
        require_no_oom({'oom':0,'oom_kill':0})
        for evidence in [{},{'oom':0},{'oom':False,'oom_kill':0}]:
            with self.assertRaises(ValueError):require_no_oom(evidence)
        with self.assertRaises(RuntimeError):require_no_oom({'oom':1,'oom_kill':1})

    def test_foreign_name_is_never_removed(self):
        from ownership import OwnedDocker
        raw=mock.Mock()
        owned=OwnedDocker('this-run',raw)
        with mock.patch('ownership.container_id',return_value=None):
            for command in ['rm','stop','start','kill','pause','unpause','update']:
                with self.assertRaises(RuntimeError):owned(command,'same-reused-name')
        raw.assert_not_called()

    def test_verified_container_is_removed_by_id_after_a_name_reuse(self):
        from ownership import OwnedDocker
        raw=mock.Mock()
        with mock.patch('ownership.container_id',return_value='a'*64):
            OwnedDocker('this-run',raw)('rm','-fv','same-reused-name')
        self.assertEqual(raw.call_args.args,('rm','-fv','a'*64))

    def test_existing_foreign_volume_is_not_relabelled_or_mounted(self):
        from ownership import OwnedDocker
        raw=mock.Mock(return_value=json.dumps([{'Labels':{'io.nelcota.stress.run':'another-run'}}]))
        with self.assertRaises(RuntimeError):
            OwnedDocker('this-run',raw)('volume','create','--label','io.nelcota.stress.run=this-run','colliding-volume')
        self.assertEqual([call.args[:2] for call in raw.call_args_list],[('volume','inspect')])

    def test_atomic_receipts_allow_independent_concurrent_writers(self):
        from watchdog import atomic_json
        original=Path.replace
        barrier=threading.Barrier(4)
        def together(source,target):
            barrier.wait(timeout=5)
            return original(source,target)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'receipt.json'
            with mock.patch.object(Path,'replace',together):
                with ThreadPoolExecutor(max_workers=4) as workers:
                    list(workers.map(lambda value:atomic_json(path,{'writer':value}),range(4)))
            self.assertIn(json.loads(path.read_text())['writer'],range(4))
            self.assertEqual(list(Path(directory).glob('*.writing')),[])


@unittest.skipUnless(hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'),'Linux pidfd is required')
class EmergencyTrafficStop(unittest.TestCase):
    def child(self):
        process=subprocess.Popen([sys.executable,'-c','import time; time.sleep(10)'])
        def finish():
            if process.poll() is None:process.terminate()
            process.wait(timeout=5)
        self.addCleanup(finish)
        return process

    def test_owner_termination_uses_a_bound_pidfd_and_no_numeric_kill(self):
        from watchdog import process_identity, stop_owner
        process = self.child()
        with mock.patch('watchdog.os.kill', side_effect=AssertionError('Numeric PID kill is unsafe')):
            self.assertTrue(stop_owner({'pid': process.pid, 'process_identity': process_identity(process.pid)}))
        self.assertEqual(process.wait(timeout=5), -signal.SIGTERM)

    def test_reused_owner_identity_cannot_signal_the_new_task(self):
        from watchdog import stop_owner
        process = self.child()
        self.assertFalse(stop_owner({'pid': process.pid, 'process_identity': '1'}))
        self.assertIsNone(process.poll())

    def test_pidfd_stops_owned_traffic_without_a_docker_request(self):
        from watchdog import atomic_json,process_identity,stop_generator
        process=self.child()
        identifier='a'*64
        original=Path.read_text
        def read(path,*args,**kwargs):
            if str(path)==f'/proc/{process.pid}/cgroup':
                return '0::/docker/'+identifier+'\n'
            return original(path,*args,**kwargs)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            atomic_json(root/'generator-process.json',{'identity':'this-run','pid':process.pid,'process_identity':process_identity(process.pid),'container_id':identifier})
            with mock.patch.object(Path,'read_text',read),mock.patch('watchdog.subprocess.run',side_effect=AssertionError('Docker must not be needed')):
                self.assertTrue(stop_generator({'identity':'this-run','output':directory}))
            self.assertEqual(process.wait(timeout=5),-signal.SIGKILL)

    def test_other_run_or_reused_pid_is_never_signalled(self):
        from watchdog import atomic_json,process_identity,stop_generator
        process=self.child()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            atomic_json(root/'generator-process.json',{'identity':'other-run','pid':process.pid,'process_identity':process_identity(process.pid),'container_id':'a'*64})
            self.assertFalse(stop_generator({'identity':'this-run','output':directory}))
            atomic_json(root/'generator-process.json',{'identity':'this-run','pid':process.pid,'process_identity':'1','container_id':'a'*64})
            self.assertFalse(stop_generator({'identity':'this-run','output':directory}))
            self.assertIsNone(process.poll())


class HostMemoryEvidence(unittest.TestCase):
    def test_component_cgroup_observation_keeps_peaks_cpu_throttling_and_cache_separate(self):
        from host_resources import owned_cgroup_snapshot,parse_counters
        fields={'memory.current':'100','memory.max':'1000','memory.peak':'150','memory.events':'oom 0\noom_kill 0','memory.stat':'anon 30\nfile 50\nshmem 0','cpu.max':'50000 100000','cpu.stat':'usage_usec 100\nnr_periods 10\nnr_throttled 4\nthrottled_usec 20','pids.current':'8','pids.max':'128'}
        def encoded(values):
            return ''.join('['+key+']\n'+value+'\n' for key,value in values.items())
        owned=mock.Mock(return_value=encoded(fields))
        observed=owned_cgroup_snapshot(owned,'owned-component')
        self.assertEqual(observed['memory.peak'],150)
        self.assertEqual(observed['memory.stat']['file'],50)
        self.assertEqual(observed['cpu.stat']['nr_throttled'],4)
        self.assertEqual(observed['cpu.max']['quota_usec'],50000)
        self.assertEqual(owned.call_args.args[:2],('exec','owned-component'))
        for key,value in [('memory.current','NaN'),('memory.peak','max'),('cpu.max','-1 100000'),('memory.events','oom 0\noom 0')]:
            owned.return_value=encoded({**fields,key:value})
            with self.assertRaises(ValueError):owned_cgroup_snapshot(owned,'owned-component')
        with self.assertRaises(ValueError):parse_counters('oom 0\noom 0')

    def test_clean_page_cache_is_reclaimable_but_tmpfs_is_not(self):
        import host_resources
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'memory.max').write_text('1000')
            stat=root/'memory.stat'
            stat.write_text('anon 100\nfile 900\nshmem 100\nkernel 50\nfile_dirty 0\nfile_writeback 0\n')
            with mock.patch.object(host_resources,'CGROUP',root):
                self.assertFalse(host_resources.memory_reserve_breached())
                stat.write_text('anon 100\nfile 900\nshmem 800\nkernel 50\nfile_dirty 0\nfile_writeback 0\n')
                self.assertTrue(host_resources.memory_reserve_breached())


class FaultTransitionEvidence(unittest.TestCase):
    def test_short_fault_returning_to_none_is_still_a_new_observation_epoch(self):
        from observations import ObservationEpoch
        window=ObservationEpoch()
        epoch,value=window.capture()
        self.assertIsNone(value)
        self.assertFalse(window.changed(epoch))
        window.set({'container':'owned-app','name':'restart'})
        window.set(None)
        self.assertIsNone(window.capture()[1])
        self.assertTrue(window.changed(epoch))
