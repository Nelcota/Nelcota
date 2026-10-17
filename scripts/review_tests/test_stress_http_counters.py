"""Physical attempts and rare 401 probes survive actual series expiry."""
import copy
import io
import json
import math
from pathlib import Path
import sys
import unittest
from unittest import mock
import urllib.parse

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from http_counters import HttpCounters, closed_counts
from metrics import NativeMetrics


def row(count, status='200', scenario='traffic', family='http_reqs', **tags):
    labels={'run_id':'soak','scenario':scenario,'project':'single'}
    if scenario.startswith('project-'):
        labels['project']=scenario
    if family=='http_reqs':
        labels.update(status=status,method='GET',workload='read')
    labels.update(tags)
    return {'metric':labels,'value':[1,str(count)]}


class RetainedHttpCounters(unittest.TestCase):
    def test_four_hour_expiry_keeps_physical_redirects_and_negative_probes(self):
        counter=HttpCounters('soak',['traffic','session-canary'],0)
        counter.observe({'http_reqs':[],'expected_rejections':[]},0,0)
        counter.observe({'http_reqs':[row(1),row(3,'401'),row(80,'302')], 'expected_rejections':[row(3,family='expected_rejections')]},0,5)
        for now in range(10,14401,5):
            counter.observe({'http_reqs':[row(now)],'expected_rejections':[]},0,now)
        evidence=counter.close()
        counts=closed_counts(evidence,'soak','traffic',14400)
        self.assertEqual(counts['http_reqs'],14483)
        self.assertEqual(counts['expected_rejections'],3)
        self.assertEqual(counts['status_counts'],{'200':14400,'401':3,'302':80})
        self.assertEqual(closed_counts(evidence,'soak','session-canary',14400)['http_reqs'],0)
        self.assertLess(len(json.dumps(evidence)),1200)

    def test_projects_methods_and_workloads_keep_separate_native_series(self):
        counter=HttpCounters('soak',['project-0','project-1'],0)
        counter.observe({'http_reqs':[row(7,scenario='project-0'),row(3,scenario='project-0',method='POST'),row(2,scenario='project-1')],'expected_rejections':[]},0,0)
        counter.observe({'http_reqs':[],'expected_rejections':[]},0,5)
        proof=counter.close()
        self.assertEqual(closed_counts(proof,'soak','project-0',5)['http_reqs'],10)
        self.assertEqual(closed_counts(proof,'soak','project-1',5)['http_reqs'],2)

    def test_failed_observation_does_not_partially_update_a_phase(self):
        counter=HttpCounters('soak',['traffic'],0)
        counter.observe({'http_reqs':[row(10)],'expected_rejections':[]},0,0)
        original=counter.snapshot()
        for rows,resets,now in [([row(9)],0,5),([row(11),row(11)],0,5),([row(11)],1,5),([row(11)],0,31),([row(11,password='secret')],0,5),([row(11,project='project-0')],0,5),([row(11,scenario='project-0')],0,5)]:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                counter.observe({'http_reqs':rows,'expected_rejections':[]},resets,now)
            self.assertEqual(counter.snapshot(),original)

    def test_nonfinite_fractional_negative_and_large_counts_are_rejected(self):
        for count in ['NaN','+Inf','-1','1.5',str(2**54)]:
            counter=HttpCounters('soak',['traffic'],0)
            with self.subTest(count=count), self.assertRaises(ValueError):
                counter.observe({'http_reqs':[row(count)],'expected_rejections':[]},0,0)

    def test_missing_polls_and_disagreeing_final_statuses_cannot_certify(self):
        counter=HttpCounters('soak',['traffic'],0)
        counter.observe({'http_reqs':[row(1,'401')],'expected_rejections':[]},0,0)
        with self.assertRaises(ValueError):counter.close()
        counter.observe({'http_reqs':[],'expected_rejections':[]},0,5)
        proof=counter.close()
        with self.assertRaisesRegex(ValueError,'401'):closed_counts(proof,'soak','traffic',5)
        proof['scenarios']['traffic']['expected_rejections']=1
        closed_counts(proof,'soak','traffic',5)
        for field,value in [('closed',False),('observations',True),('last_monotonic',14400),('maximum_poll_gap_seconds',31),('tracked_series_count',257)]:
            changed=copy.deepcopy(proof);changed[field]=value
            with self.subTest(field=field), self.assertRaises(ValueError):closed_counts(changed,'soak','traffic',5)
        with self.assertRaises(ValueError):counter.observe({'http_reqs':[],'expected_rejections':[]},0,10)

    def test_unbounded_series_and_invalid_declarations_fail_closed(self):
        for scenarios in [[],[['traffic']],['traffic','traffic'],['other']]:
            with self.assertRaises(ValueError):HttpCounters('soak',scenarios,0)
        counter=HttpCounters('soak',['traffic'],0)
        with self.assertRaises(ValueError):counter.observe({'http_reqs':[row(1,error_code=str(index)) for index in range(257)],'expected_rejections':[]},0,0)


class HttpMetricIntegration(unittest.TestCase):
    def test_summary_preserves_expired_401_and_checks_independent_assertions(self):
        reader=NativeMetrics('http://127.0.0.1:1',retain_http_counters=True)
        now=[0];expired=[False];bad_assertions=[False]
        def response(url,**kwargs):
            query=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['query'][0]
            rows=[]
            if query.startswith('last_over_time(k6_http_reqs_total'):
                rows=[row(10)]
                if not expired[0]:rows.extend([row(3,'401'),row(8,'302')])
            if query.startswith('last_over_time(k6_expected_rejections_total') and not expired[0]:rows=[row(3,family='expected_rejections')]
            if query.startswith('sum(') or query.startswith('max(') or query.startswith('histogram_quantile('):
                value=0
                if 'k6_http_reqs_total' in query:value=10
                if 'k6_successful_operations_total' in query or 'k6_iterations_total' in query:value=10
                if 'k6_assertions_passed_total' in query:
                    value=23
                    if bad_assertions[0]:value=24
                if 'histogram_count(k6_latency_read_' in query:value=10
                if query.startswith('histogram_quantile('):value=.01
                if 'sum(resets(' in query:value=0
                rows=[{'value':[1,str(value)]}]
            return io.BytesIO(json.dumps({'status':'success','data':{'resultType':'vector','result':rows}}).encode())
        with mock.patch('metrics.urllib.request.urlopen',side_effect=response),mock.patch('metrics.time.monotonic',side_effect=lambda:now[0]):
            reader.begin_phase('soak',['traffic'])
            expired[0]=True
            for value in range(5,601,5):
                now[0]=value;reader.observe_arrivals('soak')
            reader.finish_phase('soak')
            summary=reader.summary('soak',600)
            self.assertEqual(summary['metrics']['http_reqs']['count'],21)
            self.assertEqual(summary['metrics']['expected_rejections']['count'],3)
            bad_assertions[0]=True
            with self.assertRaisesRegex(ValueError,'independent'):reader.summary('soak',600)

    def test_long_drop_only_coverage_cannot_approve_stale_http_counts(self):
        from arrival_counters import ArrivalCounter
        reader=NativeMetrics('http://127.0.0.1:1')
        counter=ArrivalCounter('soak',['traffic'],0)
        for now in range(0,601,5):counter.observe({},0,now)
        counter.close();reader.arrivals['soak']=counter
        with mock.patch('metrics.urllib.request.urlopen') as request:
            with self.assertRaisesRegex(ValueError,'continuous HTTP'):reader.summary('soak',600)
            request.assert_not_called()


if __name__=='__main__':unittest.main()
