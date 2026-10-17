"""A stalled Docker stats stream keeps real, owned kernel observations."""
import copy
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from observations import generator_observation
from watchdog import LABEL


class GeneratorNativeFallback(unittest.TestCase):
    def setUp(self):
        self.process=mock.Mock();self.process.poll.return_value=None
        self.context={'process':self.process,'name':'owned-load','container_id':'a'*64,'identity':'this-run','phase':'noisy-login','started':0,'host_pid':123,'pid_starttime':'456'}
        self.state={'Id':'a'*64,'State':{'Running':True,'Pid':123},'Config':{'Labels':{LABEL:'this-run'}}}
        self.cgroup={'memory.current':100,'memory.peak':200,'memory.events':{'oom':0,'oom_kill':0},'cpu.stat':{'usage_usec':42},'pids.current':3}

    def test_timeout_uses_actual_owned_counters_without_synthetic_cpu_percent(self):
        def snapshot(read,name,**kwargs):
            self.assertEqual(name,'a'*64)
            self.assertTrue(kwargs['shell_builtins'])
            self.assertEqual(read('exec',name,'sh','-c','bounded-kernel-reader'),'kernel-evidence')
            with self.assertRaises(RuntimeError):read('exec','foreign','cat','/anything')
            return self.cgroup
        responses=[subprocess.TimeoutExpired(['docker','stats'],10),subprocess.CompletedProcess([],0,'kernel-evidence','')]
        with mock.patch('observations.subprocess.run',side_effect=responses) as run,mock.patch('observations.inspect_container',return_value=self.state),mock.patch('observations.process_identity',return_value='456'),mock.patch('observations.owned_cgroup_snapshot',side_effect=snapshot):
            result=generator_observation(self.context,lambda:self.context)
        self.assertEqual(result['component_cgroup'],self.cgroup)
        self.assertNotIn('CPUPerc',result)
        self.assertEqual(result['container_id'],'a'*64)
        self.assertEqual(run.call_args_list[1].kwargs['timeout'],5)

    def test_foreign_label_pid_reuse_and_changed_container_cannot_supply_evidence(self):
        states=[]
        for mutation in ['label','pid','id']:
            changed=copy.deepcopy(self.state)
            if mutation=='label':changed['Config']['Labels'][LABEL]='foreign'
            if mutation=='pid':changed['State']['Pid']=124
            if mutation=='id':changed['Id']='b'*64
            states.append(changed)
        for state in states:
            with self.subTest(state=state),mock.patch('observations.subprocess.run',side_effect=subprocess.TimeoutExpired([],10)),mock.patch('observations.inspect_container',return_value=state),mock.patch('observations.process_identity',return_value='456'),mock.patch('observations.owned_cgroup_snapshot') as snapshot:
                with self.assertRaisesRegex(RuntimeError,'ownership'):generator_observation(self.context,lambda:self.context)
                snapshot.assert_not_called()
        with mock.patch('observations.subprocess.run',side_effect=subprocess.TimeoutExpired([],10)),mock.patch('observations.inspect_container',return_value=self.state),mock.patch('observations.process_identity',return_value='reused'):
            with self.assertRaisesRegex(RuntimeError,'ownership'):generator_observation(self.context,lambda:self.context)

    def test_oom_and_native_reader_loss_still_stop_the_campaign(self):
        self.cgroup['memory.events']['oom_kill']=1
        for error in [None,subprocess.TimeoutExpired([],5),RuntimeError('reader lost')]:
            snapshot=mock.Mock(return_value=self.cgroup)
            if error is not None:snapshot.side_effect=error
            with self.subTest(error=error),mock.patch('observations.subprocess.run',side_effect=subprocess.TimeoutExpired([],10)),mock.patch('observations.inspect_container',return_value=self.state),mock.patch('observations.process_identity',return_value='456'),mock.patch('observations.owned_cgroup_snapshot',snapshot):
                with self.assertRaises((RuntimeError,subprocess.TimeoutExpired)):generator_observation(self.context,lambda:self.context)

    def test_finished_or_replaced_generation_cannot_be_attributed_to_next_phase(self):
        def timeout(*args,**kwargs):
            self.process.poll.return_value=0
            raise subprocess.TimeoutExpired([],10)
        with mock.patch('observations.subprocess.run',side_effect=timeout),mock.patch('observations.inspect_container') as inspection:
            self.assertIsNone(generator_observation(self.context,lambda:self.context))
            inspection.assert_not_called()


if __name__=='__main__':unittest.main()
