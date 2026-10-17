"""Fault measurements reject missing and invalid successful-response evidence."""
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


class FaultLatencyEvidence(unittest.TestCase):
    def test_absent_or_corrupt_success_latency_does_not_become_zero_latency(self):
        from fault_campaign import successful_latency_evidence
        self.assertIsNone(successful_latency_evidence([]))
        self.assertEqual(successful_latency_evidence([10,20])['p95_ms'],20)
        for value in [None,True,0,-1,math.nan,math.inf,'10']:
            with self.assertRaises(ValueError):successful_latency_evidence([value])


class TransferAccounting(unittest.TestCase):
    def test_balanced_totals_do_not_hide_lost_counter_or_wrong_ledger_delta(self):
        from fault_campaign import accounting
        valid={'accounts':2,'total':2000000,'first_balance':1000007,'delta':7,'counter':17,'committed':17}
        project=mock.Mock()
        project.sql.return_value=json.dumps(valid)
        self.assertEqual(accounting(project),valid)
        for field,value in [('counter',16),('first_balance',1000008),('accounts',1),('total',1999999)]:
            project.sql.return_value=json.dumps({**valid,field:value})
            with self.assertRaises(RuntimeError):accounting(project)


class RecoveryBoundaries(unittest.TestCase):
    def test_fault_cause_survives_a_simultaneous_generic_abort(self):
        from fault_campaign import require_running
        abort=mock.Mock()
        abort.is_set.return_value=True
        watchdog=mock.Mock()
        watchdog.poll.return_value=None
        cause=TimeoutError('named injected fault failed')
        with self.assertRaises(TimeoutError) as caught:
            require_running(abort,watchdog,[cause])
        self.assertIs(caught.exception,cause)
        with self.assertRaisesRegex(RuntimeError,'resource guard'):
            require_running(abort,watchdog,[])

    def test_later_good_probe_cannot_hide_a_successful_cross_project_read(self):
        from fault_campaign import recovery_read_matches,require_unauthorized
        self.assertTrue(recovery_read_matches(200,b'[{"name":"project-0:1"}]','project-0:'))
        for body in [b'[]',b'null',b'not JSON',b'[{"name":"project-1:1"}]']:
            with self.assertRaises(RuntimeError):recovery_read_matches(200,body,'project-0:')
        require_unauthorized(401)
        for code in [200,204,403,503]:
            with self.assertRaises(RuntimeError):require_unauthorized(code)

