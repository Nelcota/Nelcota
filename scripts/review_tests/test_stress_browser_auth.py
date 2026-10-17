"""Incomplete/raw auth telemetry cannot certify a browser stress campaign."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'bench'))
from browser_auth import COUNTS, SUCCESS, complete, cycle, singleflight_control
import browser_auth


def proof(index=0):
    return {'cycle':index,'status':'passed','requests_attempted':112,'requests_completed':112,
            'independent_browser_request_count':112,'maximum_inflight':8,'maximum_arrivals_per_second':16,
            'accounts_created':8,'mutation_retries':0,'response_bytes_consumed':12000,'elapsed_seconds':7.1,
            'counts':dict(COUNTS),'successful_latency':{name:{'samples':count,'p50_ms':10,'p95_ms':20,'p99_ms':30}
                                                     for name,count in SUCCESS.items()}}


class RawBrowserAuthEvidence(unittest.TestCase):
    def test_preparation_failures_never_publish_exception_payloads(self):
        value = browser_auth.failure_receipt('source-create', RuntimeError('Docker operation failed: run secret-password https://private.invalid/token'))
        self.assertEqual(value['kind'], 'docker-operation')
        self.assertNotIn('secret', str(value))
        self.assertNotIn('private', str(value))

    def test_dependency_diagnostics_retain_only_a_bounded_basename(self):
        value = browser_auth.failure_receipt('runtime-prepare', RuntimeError('Native browser dependency closure is incomplete: _dbm.so'))
        self.assertEqual(value['component'], '_dbm.so')
        value = browser_auth.failure_receipt('runtime-prepare', RuntimeError('Native browser dependency closure is incomplete: ../../private-token'))
        self.assertNotIn('component', value)
        self.assertNotIn('private', str(value))

    def test_failure_receipt_rejects_unknown_fields_and_checkpoints(self):
        value = browser_auth.failure_receipt('runtime-prepare', ValueError('private-token'))
        for changed in [{**value, 'payload':'private-token'}, {**value, 'checkpoint':'private-token'},
                        {**value, 'checkpoint':None}, {**value, 'type':[]}, {**value, 'kind':float('nan')},
                        {**value, 'component':'../private-token'}]:
            with self.assertRaises(ValueError):
                browser_auth.validate_failure_receipt(changed)

    def test_complete_five_cycles_preserve_positive_negative_denominators(self):
        values=complete([proof(index) for index in range(5)])
        self.assertEqual(sum(row['requests_completed'] for row in values),560)
        self.assertEqual(sum(row['counts']['signup'] for row in values),40)
        self.assertEqual(sum(row['successful_latency']['refresh']['samples'] for row in values),160)

    def test_missing_duplicate_or_out_of_order_cycle_is_rejected(self):
        for values in [[proof()], [proof(0)]*5, [proof(index) for index in reversed(range(5))]]:
            with self.subTest(cycles=len(values)),self.assertRaises(ValueError):
                complete(values)

    def test_live_wire_count_or_expected_rejection_disagreement_is_rejected(self):
        for key in ['requests_attempted','requests_completed','independent_browser_request_count']:
            value=proof();value[key]=111
            with self.subTest(key=key),self.assertRaises(ValueError):cycle(value,0)
        value=proof();value['counts']['family_revoked']=7
        with self.assertRaises(ValueError):cycle(value,0)

    def test_nonfinite_stale_overbudget_or_boolean_metrics_are_rejected(self):
        for key,bad in [('maximum_inflight',9),('maximum_arrivals_per_second',17),('mutation_retries',1),
                        ('elapsed_seconds',float('nan')),('elapsed_seconds',40),('response_bytes_consumed',True),
                        ('response_bytes_consumed',112*65536+1)]:
            value=proof();value[key]=bad
            with self.subTest(key=key,bad=bad),self.assertRaises(ValueError):cycle(value,0)

    def test_missing_zero_nonfinite_or_rejected_latency_samples_are_rejected(self):
        for transform in [lambda row:row.update(samples=9),lambda row:row.update(p50_ms=0),
                          lambda row:row.update(p99_ms=float('inf')),lambda row:row.update(p95_ms=201,p99_ms=501)]:
            value=proof();transform(value['successful_latency']['refresh'])
            with self.assertRaises(ValueError):cycle(value,0)
        value=proof();value['successful_latency']['invalid_password']={'samples':8,'p50_ms':1,'p95_ms':1,'p99_ms':1}
        with self.assertRaises(ValueError):cycle(value,0)

    def test_secret_bearing_extra_fields_are_not_published(self):
        value=proof();value['access_token']='private-fixture';value['scope']='private fixture content'
        projected=cycle(value,0)
        self.assertNotIn('access_token',projected)
        self.assertNotIn('scope',projected)
        self.assertEqual(projected['counts'],copy.deepcopy(COUNTS))


class BrowserSingleflightEvidence(unittest.TestCase):
    def value(self):
        return {'simultaneous_refresh_callers':48,'actual_refresh_requests':1,
                'shared_access_token_digest_matches':True,'all_tabs_returned_session':True,
                'callers_started_per_tab':[16,16,16],'first_real_response_held_until_late_callers_started':True,
                'held_refresh_locks':1,'queued_refresh_locks':2,'real_auth_consumers':{'0':3,'1':4}}

    def test_failed_coalescing_counts_are_preserved_for_the_original_diagnostic(self):
        value=self.value();value['actual_refresh_requests']=2;value['shared_access_token_digest_matches']=False
        self.assertEqual(singleflight_control(value)['actual_refresh_requests'],2)
        self.assertFalse(singleflight_control(value)['shared_access_token_digest_matches'])

    def test_private_fields_and_nonfinite_or_boolean_counts_are_rejected(self):
        for key,value in [('refresh_token','private-token'),('actual_refresh_requests',True),('queued_refresh_locks',float('nan'))]:
            changed=self.value();changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):singleflight_control(changed)

    def test_all_three_tab_counts_must_match_the_reported_callers(self):
        value=self.value();value['callers_started_per_tab']=[16,16,15]
        with self.assertRaises(ValueError):singleflight_control(value)


class FailedAuthSLOEvidence(unittest.TestCase):
    def measured(self):
        value = proof()
        value['status'] = 'measured'
        value['successful_latency']['refresh'].update(p95_ms=250, p99_ms=350)
        return value

    def test_actual_failure_preserves_latency_and_all_denominators(self):
        value = self.measured()
        measured = browser_auth.measurement(value, 0)
        failed = browser_auth.failed_cycle(measured, 'g05_auth_refresh_slo')
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(failed['failed_SLO_classes'], ['refresh'])
        self.assertEqual(failed['successful_latency']['refresh']['p95_ms'], 250)
        self.assertEqual(failed['requests_completed'], 112)
        self.assertEqual(failed['counts'], COUNTS)
        with self.assertRaises(ValueError):
            cycle({**value, 'status':'passed'}, 0)

    def test_failure_reason_must_match_first_actual_violation(self):
        value = self.measured()
        for reason in ['g05_auth_login_slo', 'g05_auth_user_slo', 'private-token', None, []]:
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                browser_auth.failed_cycle(value, reason)
        value['successful_latency']['refresh'].update(p95_ms=20, p99_ms=30)
        with self.assertRaises(ValueError):
            browser_auth.failed_cycle(value, 'g05_auth_refresh_slo')

    def test_partial_boolean_and_nonfinite_failures_cannot_be_published(self):
        for key, bad in [('requests_completed',111), ('independent_browser_request_count',True),
                         ('elapsed_seconds',float('nan'))]:
            value = self.measured(); value[key] = bad
            with self.subTest(key=key), self.assertRaises(ValueError):
                browser_auth.failed_cycle(value, 'g05_auth_refresh_slo')
        value = self.measured()
        value['successful_latency']['refresh']['p99_ms'] = float('inf')
        with self.assertRaises(ValueError):
            browser_auth.failed_cycle(value, 'g05_auth_refresh_slo')
        value = self.measured()
        value['successful_latency']['refresh']['p99_ms'] = 8000
        with self.assertRaises(ValueError):
            browser_auth.failed_cycle(value, 'g05_auth_refresh_slo')

    def test_failed_projection_never_publishes_private_payloads(self):
        value = self.measured()
        value.update(access_token='private-token', email='private@example.test', scope='private data')
        failed = browser_auth.failed_cycle(value, 'g05_auth_refresh_slo')
        self.assertNotIn('private', str(failed))
        value['successful_latency']['refresh']['payload'] = 'private-token'
        with self.assertRaises(ValueError):
            browser_auth.failed_cycle(value, 'g05_auth_refresh_slo')


if __name__=='__main__':unittest.main()
