"""Fleet evidence needs real signed deliveries and committed identity matches."""
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'bench'))
import fleet_webhooks


class FleetWebhookEvidence(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.fleet = fleet_webhooks.FleetWebhooks(Path(directory.name))
        self.addCleanup(self.fleet.close)
        self.project = mock.Mock(label='project-0', base='http://127.0.0.1:1',
                                 environment={'NELCOTA_WEBHOOKS_ALLOW_LOOPBACK': 'true'},
                                 fixture={'cookie': 'fixture-cookie'})
        self.secret = secrets.token_urlsafe(32)
        self.expected = []
        def sql(statement):
            if statement.startswith('SELECT outstanding'):
                return '0'
            if statement.startswith('SELECT event_id'):
                return '\n'.join(self.expected)
            return ''
        self.project.sql.side_effect = sql

    def attach(self):
        with mock.patch.object(fleet_webhooks, 'request', return_value=({'secret': self.secret}, {})):
            self.fleet.attach(self.project)
        return self.fleet.items[-1][1]

    def deliver(self, receiver, event, secret=None, payload=None):
        body = json.dumps({'id': event}).encode()
        if payload is not None:
            body = payload
        timestamp = str(int(time.time()))
        key = self.secret
        if secret is not None:
            key = secret
        signature = 'v1=' + hmac.new(key.encode(), (event + '.' + timestamp + '.').encode() + body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(f'http://127.0.0.1:{receiver.server_address[1]}/', data=body,
                                         headers={'x-nelcota-event-id': event, 'x-nelcota-delivery-id': str(uuid.uuid4()),
                                                  'x-nelcota-timestamp': timestamp, 'x-nelcota-signature': signature})
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status

    def test_absent_positive_traffic_cannot_certify(self):
        with self.assertRaisesRegex(RuntimeError, 'No fleet'):
            self.fleet.reconcile()
        self.attach()
        with self.assertRaisesRegex(RuntimeError, 'positive traffic'):
            self.fleet.reconcile()

    def test_committed_and_delivered_ids_match_with_documented_duplicates(self):
        receiver = self.attach()
        event = str(uuid.uuid4())
        self.expected.append(event)
        self.assertEqual(self.deliver(receiver, event), 204)
        self.assertEqual(self.deliver(receiver, event), 204)
        result = self.fleet.reconcile()['project-0']
        self.assertEqual((result['missing'], result['extra'], result['duplicates']), (0, 0, 1))
        self.assertEqual(self.fleet.observe()['signature_errors'], 0)

    def test_matching_counts_with_wrong_committed_identity_cannot_pass(self):
        receiver = self.attach()
        self.expected.append(str(uuid.uuid4()))
        self.deliver(receiver, str(uuid.uuid4()))
        with self.assertRaisesRegex(RuntimeError, 'identities did not reconcile'):
            self.fleet.reconcile()

    def test_other_projects_signature_is_fatal(self):
        receiver = self.attach()
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.deliver(receiver, str(uuid.uuid4()), secret=secrets.token_urlsafe(32))
        self.assertEqual(failure.exception.code, 400)
        with self.assertRaisesRegex(RuntimeError, 'signature'):
            self.fleet.observe()

    def test_changed_signed_bytes_for_one_event_are_fatal(self):
        receiver = self.attach()
        event = str(uuid.uuid4())
        self.deliver(receiver, event)
        with self.assertRaises(urllib.error.HTTPError):
            self.deliver(receiver, event, payload=json.dumps({'id': event, 'changed': True}).encode())
        with self.assertRaisesRegex(RuntimeError, 'receiver invariant'):
            self.fleet.observe()

    def test_unconfigured_private_destination_is_refused_before_binding(self):
        self.project.environment = {}
        with mock.patch.object(fleet_webhooks, 'FleetReceiver') as receiver:
            with self.assertRaisesRegex(RuntimeError, 'declared before'):
                self.fleet.attach(self.project)
            receiver.assert_not_called()

    def test_drain_cannot_pass_after_deadline_even_if_last_queue_becomes_empty(self):
        self.attach()
        with mock.patch.object(fleet_webhooks.time, 'monotonic', side_effect=[0, 31]):
            with self.assertRaisesRegex(RuntimeError, 'deadline'):
                self.fleet.reconcile()

    def test_one_close_failure_does_not_skip_other_owners(self):
        receiver, ledger = mock.Mock(), mock.Mock()
        receiver.close.side_effect = OSError('fixture only')
        self.fleet.items.append((self.project, receiver, ledger))
        errors = self.fleet.close()
        self.assertEqual(errors[0]['error_type'], 'OSError')
        ledger.close.assert_called_once()
        self.fleet.items.clear()


if __name__ == '__main__':
    unittest.main()
