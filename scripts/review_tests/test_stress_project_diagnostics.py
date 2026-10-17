"""Owned setup failures expose fixed state and categories, never private values."""
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'bench'))
from project_diagnostics import component, snapshot, validate


class OwnedProjectDiagnostics(unittest.TestCase):
    def project(self, *, logs='Permission denied private-token postgres://private:private-password@host/db'):
        def call(*args, **kwargs):
            self.assertIn(args[0],{'inspect','logs'})
            if args[0]=='logs':return logs
            return json.dumps([{'Config':{'Env':['PRIVATE_TOKEN=private-token']},'RestartCount':0,
                                'State':{'Running':False,'OOMKilled':False,'ExitCode':1}}])
        return SimpleNamespace(setup_stage='app-starting',docker=call,app='owned-app',pg='owned-pg')

    def test_logs_and_inspected_environment_never_enter_public_diagnostics(self):
        value=snapshot(self.project())
        self.assertEqual(value['app']['categories']['permission'],1)
        self.assertNotIn('private',str(value))
        self.assertNotIn('postgres://',str(value))

    def test_log_projection_remains_bounded_and_reports_truncation(self):
        value=snapshot(self.project(logs='x'*70000+'panic: panicked at private-token'))
        self.assertTrue(value['app']['log_truncated'])
        self.assertEqual(value['app']['observed_log_bytes'],65536)
        self.assertEqual(value['app']['categories']['panic'],1)

    def test_unreadable_component_does_not_infer_a_stopped_process(self):
        def unavailable(*args, **kwargs):raise RuntimeError('private-token')
        self.assertEqual(component(unavailable,'owned-app'),{'available':False})

    def test_unknown_payload_fields_cannot_be_republished(self):
        original=snapshot(self.project())
        for change in ['Config','environment','message']:
            value=copy.deepcopy(original);value['app'][change]='private-token'
            with self.subTest(change=change),self.assertRaises(ValueError):validate(value)

    def test_nonfinite_boolean_or_missing_state_cannot_be_inferred(self):
        original=snapshot(self.project())
        for key,value in [('exit_code',float('nan')),('restart_count',True),('running',1),('observed_log_bytes',None)]:
            changed=copy.deepcopy(original);changed['app'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):validate(changed)
