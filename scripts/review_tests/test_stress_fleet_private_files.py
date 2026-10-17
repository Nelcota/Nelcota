"""Private-file evidence must fail closed on cross-project data or weak proof."""
import copy
import hashlib
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import fleet_private_files as private


def receipt(projects=5, *, during_load=True):
    value = {"status": "passed", "protocol": private.PROTOCOL, "counts": private.expected_counts(projects),
             "elapsed_seconds": 2.0, "requests_total": 1000, "logical_HTTP_bytes_total": 100000,
             "in_offered_window": during_load, "run_id": "owned-isolation", "phase": "balanced-1",
             "minimum_response_gap_seconds":1/64}
    if during_load:
        value.update(foreground_iterations_observed_before=2,
                     action_window={"started_after_seconds": 5.0, "ended_after_seconds": 7.0,
                                    "duration_seconds": 2.0, "entire_action_within_offered_window": True})
    return value


class PrivateFileBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)/"owned-isolation"
        self.root.mkdir()
        self.projects = [SimpleNamespace(label="project-" + str(index), base="http://127.0.0.1:" + str(18000 + index),
                                        port=18000 + index, app="owned-app-" + str(index),
                                        fixture={"service": secrets.token_urlsafe(32)}, docker=SimpleNamespace(require=Mock(return_value="owned")), sql=Mock())
                         for index in range(5)]
        self.abort, self.guard = Mock(), Mock()
        self.clock = [100.0]
        self.probe = private.PrivateFiles(self.projects, self.root, self.guard, Mock(return_value=True), self.abort,
                                         clock=lambda:self.clock[0],sleep=lambda seconds:self.clock.__setitem__(0,self.clock[0]+seconds))

    def graph_backend(self):
        bodies = {project.label: self.probe.body(project) for project in self.projects}
        self.probe.expected = {project.label: {"version": str(uuid.uuid4()), "size": len(self.probe.body(project)),
                                               "etag": hashlib.sha256(self.probe.body(project)).hexdigest()} for project in self.projects}
        def call(project, method, credential, body=None):
            self.probe.requests += 1
            self.probe.logical_bytes += 100
            self.clock[0] += 1/64+.001
            self.probe.minimum_response_gap = 1/64
            if credential is None:
                return 404, b"{}"
            if credential != project.fixture["service"]:
                return 401, b"{}"
            return 200, bodies[project.label]
        self.probe.call = Mock(side_effect=call)
        self.probe.metadata = Mock(side_effect=lambda project: copy.deepcopy(self.probe.expected[project.label]))
        return bodies, call

    def test_all_directed_pairs_and_owner_bytes_are_required(self):
        self.graph_backend()
        threads = len(threading.enumerate())
        value = self.probe.graph("balanced-1", phase_started=self.clock[0]-1, phase_seconds=300, foreground_iterations=2)
        self.assertEqual(value["counts"], private.expected_counts(5))
        self.assertEqual(value["counts"]["directed_pairs"], 20)
        self.assertEqual(self.probe.call.call_count, 90)
        self.assertEqual(len(threading.enumerate()), threads)
        self.abort.assert_not_called()
        self.assertNotIn(self.projects[0].fixture["service"], json.dumps(value))

    def test_false_401_with_changed_bytes_cannot_pass(self):
        bodies, original = self.graph_backend()
        def changed(project, method, credential, body=None):
            if method == "PUT" and credential != project.fixture["service"]:
                bodies[project.label] = b"changed despite rejection"
            return original(project, method, credential, body)
        self.probe.call.side_effect = changed
        with self.assertRaisesRegex(RuntimeError, "bytes changed"):
            self.probe.graph("noisy-write")
        value = json.loads((self.root / "private-isolation-noisy-write.json").read_text())
        self.assertEqual(value["status"], "failed")
        self.assertNotIn("changed despite", json.dumps(value))
        self.abort.assert_called()

    def test_accepted_foreign_write_stops_traffic_before_further_work(self):
        _, original = self.graph_backend()
        def accepted(project, method, credential, body=None):
            if method == "PUT" and credential != project.fixture["service"]:
                return 200, b"must never publish"
            return original(project, method, credential, body)
        self.probe.call.side_effect = accepted
        with self.assertRaisesRegex(RuntimeError, "Foreign credential wrote"):
            self.probe.graph("noisy-write")
        self.abort.assert_called_once_with()
        self.assertLess(self.probe.call.call_count, 90)
        self.assertNotIn("must never publish", (self.root / "private-isolation-noisy-write.json").read_text())

    def test_metadata_changes_cannot_hide_behind_matching_bytes(self):
        self.graph_backend()
        self.probe.metadata.side_effect = lambda project: {**self.probe.expected[project.label], "version": str(uuid.uuid4())}
        with self.assertRaisesRegex(RuntimeError, "metadata"):
            self.probe.graph("balanced-1")
        self.abort.assert_called()

    def test_expired_graph_aborts_without_leaving_its_watchdog_thread(self):
        self.graph_backend()
        def timer(seconds, function):
            value = Mock()
            value.start.side_effect = function
            value.is_alive.return_value = False
            return value
        with patch.object(private.threading, "Timer", side_effect=timer):
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                self.probe.graph("balanced-1")
        self.abort.assert_called()
        self.probe.call.assert_not_called()

    def test_non_owned_endpoints_are_rejected_before_HTTP_or_SQL(self):
        for base in ["http://example.test:18000", "http://127.0.0.1:18001", "http://user@127.0.0.1:18000",
                     "http://127.0.0.1:18000/private", "http://127.0.0.1:18000?token=private", "https://127.0.0.1:18000"]:
            with self.subTest(base=base):
                changed = copy.copy(self.projects[0]); changed.base = base
                with self.assertRaisesRegex(RuntimeError, "owned loopback"):
                    private.PrivateFiles([changed, *self.projects[1:]], self.root, self.guard, Mock(), self.abort)
                changed.sql.assert_not_called()

    def test_request_and_byte_ceilings_precede_any_new_wire_request(self):
        for key, maximum in [("requests", private.PROFILE["maximum_requests"]),
                             ("logical_bytes", private.PROFILE["maximum_logical_HTTP_bytes"] - 1)]:
            with self.subTest(key=key), patch.object(private, "ledger_opener") as opener:
                self.probe.requests = self.probe.logical_bytes = 0
                setattr(self.probe, key, maximum)
                with self.assertRaises(RuntimeError):
                    self.probe.call(self.projects[0], "GET", self.projects[0].fixture["service"])
                opener.assert_not_called()

    def test_oversized_wire_response_is_closed_and_not_published(self):
        response = SimpleNamespace(headers={}, read=Mock(return_value=b"x" * 2049), close=Mock(), code=200)
        with patch.object(private, "ledger_opener", return_value=SimpleNamespace(open=Mock(return_value=response))):
            with self.assertRaisesRegex(RuntimeError, "body exceeded"):
                self.probe.call(self.projects[0], "GET", self.projects[0].fixture["service"])
        response.close.assert_called_once_with()

    def test_slow_client_setup_cannot_turn_the_next_wire_request_into_a_burst(self):
        wire_times = []
        responses = []

        def opener():
            if not wire_times:
                self.clock[0] += .020

            def opened(request, timeout):
                wire_times.append(self.clock[0])
                response = SimpleNamespace(headers={}, code=200, close=Mock())

                def read(maximum):
                    self.clock[0] += .001
                    return b"owned"

                response.read = read
                responses.append(response)
                return response

            return SimpleNamespace(open=opened)

        with patch.object(private, "ledger_opener", side_effect=opener):
            for _ in range(2):
                self.probe.call(self.projects[0], "GET", self.projects[0].fixture["service"])
        self.assertGreaterEqual(wire_times[1] - wire_times[0] + .000001, 1 / 64)
        self.assertGreaterEqual(self.probe.minimum_response_gap + .000001, 1 / 64)
        for response in responses:
            response.close.assert_called_once_with()

    def test_early_pacing_wakeup_stops_before_another_wire_request(self):
        response = SimpleNamespace(headers={}, read=Mock(return_value=b"owned"), close=Mock(), code=200)
        self.probe.sleep = Mock()
        with patch.object(private, "ledger_opener", return_value=SimpleNamespace(open=Mock(return_value=response))) as opener:
            self.probe.call(self.projects[0], "GET", self.projects[0].fixture["service"])
            with self.assertRaisesRegex(RuntimeError, "woke before its deadline"):
                self.probe.call(self.projects[0], "GET", self.projects[0].fixture["service"])
        self.assertEqual(opener.call_count, 1)
        response.close.assert_called_once_with()

    def test_missing_pairs_nonfinite_timings_or_private_fields_cannot_certify(self):
        self.assertEqual(private.validate_receipt(receipt(), 5, during_load=True), receipt())
        changes = [{"status": "failed"}, {"counts": {**receipt()["counts"], "directed_pairs": 5}},
                   {"counts": {**receipt()["counts"], "foreign_writes_rejected": True}},
                   {"elapsed_seconds": float("nan")}, {"elapsed_seconds": 21},
                   {"foreground_iterations_observed_before": 0}, {"in_offered_window": False},
                   {"private_payload": "do not publish"}, {"requests_total": True},
                   {"minimum_response_gap_seconds": None}, {"minimum_response_gap_seconds": float("nan")},
                   {"minimum_response_gap_seconds": .001}, {"minimum_response_gap_seconds": .1}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                private.validate_receipt({**receipt(), **change}, 5, during_load=True)
        for change in [{"entire_action_within_offered_window": False}, {"duration_seconds": 1},
                       {"ended_after_seconds": float("inf")}, {"private_payload": "must not publish"}]:
            with self.subTest(window=change), self.assertRaises(RuntimeError):
                private.validate_receipt({**receipt(), "action_window": {**receipt()["action_window"], **change}}, 5, during_load=True)

    def test_preflight_evidence_cannot_replace_under_load_graphs(self):
        phases = ['balanced-1','balanced-2','balanced-3','noisy-mixed','noisy-login','noisy-read','noisy-storage','noisy-write']
        for label in ["before", "after"]:
            count = 95
            logical = 1000
            if label == 'after':
                count = 905
                logical = 10000
            (self.root / ("private-isolation-" + label + ".json")).write_text(json.dumps(
                {**receipt(during_load=False),'phase':label,'requests_total':count,'logical_HTTP_bytes_total':logical}))
        profile = {"projects": 5, "private_file_isolation": private.PROFILE.copy(),
                   'capacity_qualification':False,'ingress':{'kind':'direct loopback HTTP'},
                   'private_file_controller_cpu_affinity':3,'metrics_cpu_affinity':3,'cpu_affinity':[0,1,2]}
        ledger = [{"phase": label, "requested_seconds": 300, "completed": True} for label in phases]
        with self.assertRaises(RuntimeError):
            private.validate_run(self.root, profile, ledger)
        for label in phases:
            (self.root/('private-isolation-'+label+'.json')).write_text(json.dumps({**receipt(during_load=False),'phase':label}))
        with self.assertRaises(RuntimeError):
            private.validate_run(self.root, profile, ledger)
        for index, label in enumerate(phases, 1):
            value = {**receipt(),'phase':label,'requests_total':95+index*90,'logical_HTTP_bytes_total':1000+index*1000}
            (self.root/('private-isolation-'+label+'.json')).write_text(json.dumps(value))
        private.validate_run(self.root, profile, ledger)
        for cpu in [0,1,2,None,True]:
            with self.subTest(cpu=cpu), self.assertRaisesRegex(RuntimeError, 'shares a target'):
                private.validate_run(self.root,{**profile,'private_file_controller_cpu_affinity':cpu},ledger)
        with self.assertRaisesRegex(RuntimeError, 'missing'):
            private.validate_run(self.root, profile, ledger[:-1])
        first = self.root/'private-isolation-balanced-1.json'
        second = self.root/'private-isolation-balanced-2.json'
        second.write_bytes(first.read_bytes())
        with self.assertRaisesRegex(RuntimeError, 'another run or phase'):
            private.validate_run(self.root, profile, ledger)

    def test_null_nonfinite_or_duplicate_private_metadata_is_rejected(self):
        project = self.projects[0]
        good = {'version':str(uuid.uuid4()),'size':len(self.probe.body(project)),
                'etag':hashlib.sha256(self.probe.body(project)).hexdigest()}
        for rows in [[],[good,good],[{**good,'version':None}],[{**good,'size':True}],
                     [{**good,'size':float('nan')}],[{**good,'etag':None}]]:
            project.sql.return_value = json.dumps(rows)
            with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                self.probe.metadata(project)

    def test_invalid_credentials_never_reach_the_opener(self):
        for credential in ['',True,'private\r\nheader','x'*4097]:
            self.probe.next_request = 0
            with self.subTest(credential_type=type(credential).__name__), patch.object(private, 'ledger_opener') as opener:
                with self.assertRaisesRegex(RuntimeError, 'credential boundary'):
                    self.probe.call(self.projects[0],'GET',credential)
                opener.assert_not_called()

    def test_nonfinite_or_unobserved_foreground_is_rejected_before_any_HTTP(self):
        self.graph_backend()
        for positive in [0,None,True,float('nan'),float('inf')]:
            with self.subTest(positive=positive), self.assertRaisesRegex(RuntimeError, 'before HTTP'):
                self.probe.graph('balanced-1',phase_started=self.clock[0]-1,phase_seconds=300,
                                 foreground_iterations=positive)
            self.probe.call.assert_not_called()

    def test_weaker_or_untyped_profiles_cannot_certify(self):
        for value in [None, {}, {"enabled": 0, "protocol": None},
                      {**private.PROFILE, "maximum_graph_seconds": 40},
                      {**private.PROFILE, "minimum_foreground_seconds": True}]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                private.checked_profile(value)
        self.assertEqual(private.checked_profile(private.DISABLED.copy()), private.DISABLED)


if __name__ == "__main__":
    unittest.main()
