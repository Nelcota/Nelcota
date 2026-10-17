"""Actual socket closure follows the upstream reply and leaves no live owners."""
from pathlib import Path
import secrets
import sys
import threading
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from lost_reply import discard_reply


class LostReplies(unittest.TestCase):
    def test_commit_reply_is_dropped_without_a_downstream_ack_or_socket_leak(self):
        body=b'{"operation_id":"synthetic"}'
        authorization='Bearer '+secrets.token_urlsafe(32)
        before=len(list(Path('/proc/self/fd').iterdir()))
        for _ in range(4):
            with mock.patch('socket.create_connection',side_effect=AssertionError('A downstream network dial must not occur')):
                evidence=discard_reply(lambda:(200,b'{"accepted":true}'),'/rest/v1/rpc/stress_transfer',body,authorization)
            self.assertTrue(evidence['commit_response_observed'])
            self.assertFalse(evidence['client_saw_response'])
            self.assertTrue(evidence['intermediary_task_stopped'])
        self.assertEqual(len(list(Path('/proc/self/fd').iterdir())),before)
        self.assertFalse(any(thread.name=='stress-lost-reply' for thread in threading.enumerate()))

    def test_unavailable_reply_is_not_reported_as_a_commit(self):
        evidence=discard_reply(lambda:(503,b'{"code":"unavailable"}'),'/rest/v1/rpc/stress_transfer',b'{}','Bearer '+secrets.token_urlsafe(32))
        self.assertFalse(evidence['commit_response_observed'])
        self.assertFalse(evidence['client_saw_response'])

    def test_upstream_failure_preserves_the_cause_and_releases_the_intermediary(self):
        def failed():raise TimeoutError('upstream timeout before commit evidence')
        with self.assertRaises(TimeoutError):discard_reply(failed,'/rest/v1/rpc/stress_transfer',b'{}','Bearer '+secrets.token_urlsafe(32))
        self.assertFalse(any(thread.name=='stress-lost-reply' for thread in threading.enumerate()))
