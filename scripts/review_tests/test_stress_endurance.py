"""Stress evidence must survive endurance, invalid metrics and process failure."""
from pathlib import Path
import importlib.util
import math
import subprocess
import sys
import unittest
import json
import tempfile
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def campaign_module():
    spec = importlib.util.spec_from_file_location('stress_campaign_tests', ROOT / 'bench/campaign.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ExistingDefects(unittest.TestCase):
    def test_endurance_retains_full_resource_coverage(self):
        module = campaign_module()
        coverage = module.ResourceCoverage()
        for elapsed in range(1, 14401, 5):
            coverage.observe(elapsed)
        self.assertEqual(coverage.violations(14405), [])
        self.assertEqual(coverage.count, 2880)

    def test_nonfinite_observation_cannot_certify(self):
        module = campaign_module()
        self.assertTrue(module.resource_evidence_violations([{'elapsed': 1}, {'elapsed': math.nan}], 15))

    def test_secrets_travel_in_environment_not_argv(self):
        module = campaign_module()
        result = subprocess.CompletedProcess([], 0, 'owned-id\n', '')
        with mock.patch.object(module.subprocess, 'run', return_value=result) as run:
            module.docker('run', '-e', 'POSTGRES_PASSWORD', env={'POSTGRES_PASSWORD': 'fixture-only-secret'})
        arguments, keywords = run.call_args
        self.assertNotIn('fixture-only-secret', ' '.join(arguments[0]))
        self.assertEqual(keywords['env']['POSTGRES_PASSWORD'], 'fixture-only-secret')

    def test_duration_is_bounded_and_supports_four_hours(self):
        module = campaign_module()
        self.assertEqual(module.generator_deadline('14400s'), 14520)
        with self.assertRaises(ValueError):
            module.generator_deadline('86401s')

    def test_regressing_resource_clock_fails(self):
        module = campaign_module()
        self.assertTrue(module.resource_evidence_violations([{'elapsed': 3}, {'elapsed': 2}], 5))

    def test_tail_without_observations_fails(self):
        module = campaign_module()
        self.assertTrue(module.resource_evidence_violations([{'elapsed': 1}, {'elapsed': 6}], 45))

    def test_missing_and_nonfinite_nominal_slo_cannot_pass(self):
        module = campaign_module()
        self.assertTrue(module.nominal_violations({'metrics': {}}, 'rls'))
        self.assertTrue(module.nominal_violations({'metrics': {'latency_rls': {'p(95)': math.nan, 'p(99)': 1}}}, 'rls'))
        self.assertTrue(module.nominal_violations({'metrics': {'latency_rls': {'p(95)': 201, 'p(99)': 500}}}, 'rls'))
        self.assertTrue(module.nominal_violations({'metrics': {'latency_rls': {'p(95)': 0, 'p(99)': 0}}}, 'rls'))

    def test_disk_campaign_rejects_memory_filesystems(self):
        module = campaign_module()
        for filesystem in ['tmpfs', 'ramfs']:
            with self.assertRaises(RuntimeError):
                module.validate_storage_filesystem('disk', filesystem)
        module.validate_storage_filesystem('disk', 'overlayfs')

    def test_disk_preflight_reserves_room_for_growth_not_only_current_usage(self):
        module = campaign_module()
        stats = mock.Mock(f_blocks=10000, f_bavail=2500, f_frsize=1024*1024)
        with mock.patch.object(module.os,'statvfs',return_value=stats):
            with self.assertRaisesRegex(RuntimeError,'growth headroom'):
                module.validate_disk_headroom('/fixture',2048)
            stats.f_bavail=6000
            module.validate_disk_headroom('/fixture',2048)

    def test_listener_from_another_process_does_not_authorize_target(self):
        module = campaign_module()
        owned = 'lrwx------ 1 user user 64 socket -> socket:[111]\n'
        foreign = '0: 0100007F:1F90 00000000:0000 0A 0:0 0:0 0 1000 0 222\n'
        with mock.patch.object(module, 'docker', return_value=owned+foreign):
            self.assertFalse(module.owns_listener('fixture', 8080))
        local = foreign.replace('222', '111')
        with mock.patch.object(module, 'docker', return_value=owned+local):
            self.assertTrue(module.owns_listener('fixture', 8080))

    def test_resource_diagnostic_preserves_failure_without_secrets(self):
        module = campaign_module()
        text = module.redacted_diagnostic(RuntimeError('Docker refused fixture-secret-123 during stats'), ['fixture-secret-123'])
        self.assertIn('during stats', text)
        self.assertNotIn('fixture-secret-123', text)


class EvidenceOracles(unittest.TestCase):
    def setUp(self):
        campaign_module()
        from receiver import EventLedger
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.ledger = EventLedger(Path(self.directory.name) / 'events.sqlite')
        self.addCleanup(self.ledger.close)

    def test_duplicate_delivery_preserves_event_identity(self):
        event = {'event_id': 'event-1', 'raw_hash': 'digest'}
        self.ledger.append(event)
        self.ledger.append(event)
        report = self.ledger.validate(['event-1'])
        self.assertEqual(report, {'unique_events': 1, 'deliveries': 2, 'duplicates': 1, 'missing': 0, 'extra': 0})

    def test_event_identity_cannot_change_bytes(self):
        self.ledger.append({'event_id': 'event-1', 'raw_hash': 'digest'})
        with self.assertRaises(ValueError):
            self.ledger.append({'event_id': 'event-1', 'raw_hash': 'changed'})

    def test_different_sets_with_same_counts_do_not_pass(self):
        self.ledger.append({'event_id': 'wrong-event', 'raw_hash': 'digest'})
        report = self.ledger.validate(['expected-event'])
        self.assertEqual(report['missing'], 1)
        self.assertEqual(report['extra'], 1)

    def test_memory_window_does_not_lose_persisted_event_evidence(self):
        for i in range(3000):
            self.ledger.append({'event_id': str(i), 'raw_hash': 'digest'})
        self.assertEqual(len(self.ledger), 2048)
        report = self.ledger.validate(str(i) for i in range(3000))
        self.assertEqual(report['unique_events'], 3000)
        self.assertEqual((report['missing'], report['extra']), (0, 0))

    def test_approved_retention_preserves_expected_committed_identities(self):
        self.ledger.append({'event_id': 'pruned-event', 'raw_hash': 'digest'})
        self.ledger.preserve_expected(['pruned-event'])
        report = self.ledger.validate([])
        self.assertEqual((report['missing'], report['extra']), (0, 0))


class MetricsAndOwnership(unittest.TestCase):
    def generator_context(self):
        process = mock.Mock()
        process.poll.return_value = None
        return {'process': process, 'name': 'generator', 'container_id': 'old-container-id', 'identity': 'this-run', 'phase': 'fixture', 'started': 0}

    def test_completed_generator_eof_is_a_lifecycle_boundary(self):
        campaign_module()
        from observations import generator_observation
        context = self.generator_context()
        results = [subprocess.CompletedProcess([], 1, '', 'EOF'), subprocess.CompletedProcess([], 0, json.dumps([{'State':{'Running':False}}]), '')]
        with mock.patch('observations.subprocess.run', side_effect=results) as run:
            self.assertIsNone(generator_observation(context, lambda: context))
        self.assertEqual(run.call_args_list[0].args[0][-1], 'old-container-id')

    def test_live_generator_eof_still_invalidates_evidence(self):
        campaign_module()
        from observations import generator_observation
        context = self.generator_context()
        results = [subprocess.CompletedProcess([], 1, '', 'EOF'), subprocess.CompletedProcess([], 0, json.dumps([{'State':{'Running':True}}]), '')]
        with mock.patch('observations.subprocess.run', side_effect=results):
            with self.assertRaisesRegex(RuntimeError, 'Live generator'):
                generator_observation(context, lambda: context)

    def test_reused_name_does_not_reassign_an_old_stats_stream(self):
        campaign_module()
        from observations import generator_observation
        context = self.generator_context()
        active = [context]
        def end_generation(*args, **kwargs):
            active[0] = self.generator_context()
            return subprocess.CompletedProcess([], 1, '', 'EOF')
        with mock.patch('observations.subprocess.run', side_effect=end_generation):
            self.assertIsNone(generator_observation(context, lambda: active[0]))

    def test_nonfinite_remote_metrics_fail(self):
        campaign_module()
        from metrics import NativeMetrics
        response = mock.MagicMock()
        response.__enter__.return_value = response
        for value in ['NaN', '+Inf', '-1']:
            response.read.return_value = json.dumps({'status': 'success', 'data': {'result': [{'value': [1, value]}]}}).encode()
            with mock.patch('metrics.urllib.request.urlopen', return_value=response):
                with self.assertRaises(ValueError):
                    NativeMetrics('http://fixture.invalid').value('sum(metric)')

    def test_name_similarity_does_not_grant_cleanup_ownership(self):
        campaign_module()
        from watchdog import owned_container
        result = subprocess.CompletedProcess([], 0, json.dumps({'io.nelcota.stress.run': 'other-run'}), '')
        with mock.patch('watchdog.subprocess.run', return_value=result):
            self.assertFalse(owned_container('same-looking-prefix', 'this-run'))


class HostEvidence(unittest.TestCase):
    def setUp(self):
        campaign_module()
        import host_campaign
        self.module = host_campaign

    def test_incomplete_baselines_cannot_certify_fairness(self):
        for values in [[], [{}], [{},{},{}]]:
            with self.assertRaises(ValueError):
                self.module.median_baseline(values)

    def test_healthy_overload_or_missing_latency_fails_fairness(self):
        metrics = {'successful_operations':{'rate':8},'iterations':{'count':2400},'dropped_iterations':{'count':0},'overload_rejections':{'count':0}}
        for name in ['read','rls','panel','storage','login','refresh','write']:
            metrics['latency_'+name] = {'p(95)':10,'p(99)':20}
        import copy
        baseline = {'project-1':{'metrics':metrics}}
        candidate = copy.deepcopy(baseline)
        self.assertEqual(self.module.fairness_violations(baseline,candidate,8,300),[])
        candidate['project-1']['metrics']['overload_rejections']['count']=1
        self.assertTrue(self.module.fairness_violations(baseline,candidate,8,300))
        candidate = copy.deepcopy(baseline)
        candidate['project-1']['metrics']['latency_read']['p(95)']=math.nan
        self.assertTrue(self.module.fairness_violations(baseline,candidate,8,300))

    def test_project_metrics_do_not_merge_other_tenants(self):
        from metrics import NativeMetrics
        reader = NativeMetrics('http://unused.invalid')
        expressions=[]
        def value(expression, optional=False):
            expressions.append(expression)
            return 1.0
        with mock.patch.object(reader,'value',side_effect=value):
            reader.summary('balanced-1',300,'project-2')
            self.assertTrue(expressions)
            dropped = [expression for expression in expressions if 'k6_dropped_iterations_total' in expression]
            self.assertEqual(dropped, ['sum(last_over_time(k6_dropped_iterations_total{run_id="balanced-1",scenario="project-2"}[420s]))'])
            operations = [expression for expression in expressions if expression not in dropped]
            self.assertTrue(operations)
            self.assertTrue(all('project="project-2"' in expression for expression in operations))
            with self.assertRaises(ValueError):
                reader.summary('balanced-1',300,'project-2"} or vector(1)')


class PhysicalStorageEvidence(unittest.TestCase):
    def setUp(self):
        campaign_module()
        import objects
        self.module=objects

    def test_incomplete_s3_inventory_cannot_certify(self):
        from xml.etree import ElementTree as ET
        import secrets
        reader=self.module.S3Inventory('http://127.0.0.1:9000',secrets.token_urlsafe(24),secrets.token_urlsafe(32),'bucket')
        for xml in ['<ListBucketResult/>','<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>']:
            with mock.patch.object(reader,'query',return_value=ET.fromstring(xml)):
                with self.assertRaises(RuntimeError): reader.inventory()

    def test_multipart_state_and_disk_symlinks_block_approval(self):
        with self.assertRaises(RuntimeError):
            self.module.reconcile({'keys':[],'bytes':0,'multipart_uploads':1},[])
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'link').symlink_to('/etc/passwd')
            with self.assertRaises(RuntimeError):self.module.disk_inventory(directory)
        with self.assertRaises(RuntimeError):
            self.module.reconcile({'keys':['bench/pending#part'],'bytes':7,'multipart_uploads':None},[])

    def test_recent_version_is_reported_separately_from_documented_gc_grace(self):
        key='bench/0199dc00-0000-7000-8000-000000000001'
        import uuid
        created=(uuid.UUID(key.split('/')[1]).int>>80)/1000
        result=self.module.reconcile({'keys':[key],'bytes':17,'multipart_uploads':0},[],now=created+100)
        self.assertEqual(result['unreferenced_keys'],[key])
        self.assertEqual(result['gc_grace_seconds'],86400)
        with self.assertRaises(RuntimeError):
            self.module.reconcile({'keys':[key],'bytes':17,'multipart_uploads':0},[],now=created+86400+3601)


class WatchdogClocks(unittest.TestCase):
    def test_corrupt_or_future_heartbeat_cannot_disable_watchdog(self):
        campaign_module()
        from watchdog import heartbeat_failure
        manifest={'started_monotonic':0,'preparation_seconds':180}
        valid={'monotonic':99,'resource_monotonic':98,'phase':'soak'}
        self.assertIsNone(heartbeat_failure(manifest,valid,100))
        for key in ['monotonic','resource_monotonic']:
            for value in [math.nan,math.inf,True,None,101,'99']:
                self.assertIsNotNone(heartbeat_failure(manifest,{**valid,key:value},100))
        for value in [None,'180',False,math.nan,1000]:
            self.assertEqual(heartbeat_failure({**manifest,'preparation_seconds':value},valid,100),'invalid_preparation_budget')


class ProcessContinuityEvidence(unittest.TestCase):
    def test_restart_with_reused_pid_cannot_certify_continuous_endurance(self):
        module=campaign_module()
        expected={'app':{'container_id':'owned','pid':42,'started_at':'first'}}
        module.verify_continuity(expected,expected.copy())
        for changed in [{'container_id':'owned','pid':42,'started_at':'second'}, {'container_id':'replacement','pid':42,'started_at':'first'}]:
            with self.assertRaises(RuntimeError):
                module.verify_continuity(expected,{'app':changed})
        with self.assertRaises(RuntimeError):module.verify_continuity({}, {})








class PhysicalInventoryCompleteness(unittest.TestCase):
    def test_empty_physical_inventory_cannot_certify_published_objects(self):
        campaign_module()
        from objects import reconcile
        with self.assertRaisesRegex(RuntimeError,'missing'):
            reconcile({'keys':[],'bytes':0,'multipart_uploads':0},[],required=['bench/required'])


if __name__ == '__main__':
    unittest.main()
