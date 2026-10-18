"""Compare three valid steady samples from equivalent independent topologies."""
import argparse
import json
import math
from pathlib import Path
import statistics
from campaign import NOMINAL_SLOS
from metrics import STORAGE_PROFILE
from latency import PROTOCOL as LATENCY_PROTOCOL
from arrival_counters import PROTOCOL as ARRIVAL_COUNTER_PROTOCOL, closed_count
from cpu_policy import allocation as cpu_allocation, checked as checked_cpu_allocation, validate_proof as validate_cpu_proof
from fleet_private_files import DISABLED as PRIVATE_FILES_DISABLED, checked_profile as checked_private_profile, validate_run as validate_private_files

FIELDS=['schema','scope','projects','rows_per_project','shared_user_id','cpu_effective','cpu_affinity','metrics_cpu_affinity','app_aggregate_cpus','postgres_aggregate_cpus','generator_cpus','metrics_cpus','app_memory_mib_each','postgres_memory_mib_each','generator_memory_mib','metrics_memory_mib','max_connections_each','pool_each','fixture_disk_mib','storage_filesystem','seconds_per_step','capacity_qualification','provisional_rate_per_project','nominal_rate_per_project','images']
OPERATIONS=['read','rls','panel','storage','login','refresh','write']
FIELDS.append('resource_protocol')
FIELDS.append('container_log_profile')
FIELDS.append('harness_js_sha256')
FIELDS.append('client_initialization')
FIELDS.append('webhooks')
FIELDS.append('ingress')
FIELDS.append('startup_disk_budget')
FIELDS.append('project_cpu_period_micros')
FIELDS.append('resource_probe_workers')
FIELDS.append('arrival_counter_protocol')
FIELDS.append('generator_usage_reporting')
FIELDS.append('generator_observation_protocol')
FIELDS.append('successful_latency_protocol')
FIELDS.append('metrics_storage_profile')
FIELDS.append('project_cpu_allocation')
FIELDS.append('private_file_isolation')
FIELDS.append('private_file_controller_cpu_affinity')


def positive(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<=0:
        raise ValueError('Missing, non-finite or non-positive performance evidence')
    return value


def nonnegative(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:
        raise ValueError('Missing, non-finite or negative count evidence')
    return value


def read_run(root):
    profile=json.loads((root/'manifest.json').read_text())
    if 'private_file_isolation' not in profile:
        profile['private_file_isolation'] = PRIVATE_FILES_DISABLED.copy()
    if 'private_file_controller_cpu_affinity' not in profile:
        profile['private_file_controller_cpu_affinity'] = None
    checked_private_profile(profile['private_file_isolation'])
    completion=json.loads((root/'completion.json').read_text())
    cleanup=json.loads((root/'cleanup.json').read_text())
    violations=json.loads((root/'resource-violations.json').read_text())
    acceptance=json.loads((root/'acceptance-failures.json').read_text())
    if not isinstance(acceptance,list) or acceptance:
        raise ValueError('Failed interference gates cannot certify host regressions')
    if completion.get('status')!='passed' or completion.get('cleanup_confirmed') is not True or cleanup.get('confirmed') is not True or violations:
        raise ValueError('Failed or incomplete run cannot certify host regressions')
    projects=profile.get('projects')
    period=profile.get('project_cpu_period_micros')
    if isinstance(period,bool) or not isinstance(period,int) or period not in (10000,100000):
        raise ValueError('Missing declared project CPU period')
    if not isinstance(profile.get('resource_probe_workers'),int) or profile['resource_probe_workers']!=4:
        raise ValueError('Missing bounded fleet observation worker policy')
    if profile.get('arrival_counter_protocol') != ARRIVAL_COUNTER_PROTOCOL:
        raise ValueError('Missing continuous scheduler counter protocol')
    if profile.get('successful_latency_protocol')!=LATENCY_PROTOCOL:
        raise ValueError('Missing monotonic logical-request timing protocol')
    if profile.get('metrics_storage_profile')!=STORAGE_PROFILE:
        raise ValueError('Missing bounded metrics compaction storage profile')
    declared=profile.get('project_cpu_allocation')
    legacy_one=declared is None and projects==1
    # With one project, the legacy 1/N quota is exactly one CPU. Normalize that
    # explicit old geometry only; missing multi-project policy remains invalid.
    if legacy_one:
        declared=cpu_allocation(1,profile.get('cpu_affinity'),period,'quota')
        profile['project_cpu_allocation']=declared
    checked_cpu_allocation(declared,projects,profile.get('cpu_affinity'),period)
    for field in ['app_aggregate_cpus','postgres_aggregate_cpus']:
        value=profile.get(field)
        if isinstance(value,bool) or not isinstance(value,(int,float)) or value!=declared['hard_cpu_ceiling_per_role']:
            raise ValueError('Role CPU budget contradicts the declared hard affinity ceiling')
    if not legacy_one:
        validate_cpu_proof(json.loads((root/'cpu-allocation.json').read_text()),declared)
    if isinstance(projects,bool) or not isinstance(projects,int) or projects not in (1,5,10) or positive(profile.get('seconds_per_step'))<300 or profile.get('certifies_five_minute_steps') is not True or any(field not in profile for field in FIELDS):
        raise ValueError('Missing equivalent profile or full-duration evidence')
    positive(profile['nominal_rate_per_project'])
    ledger=[json.loads(line) for line in (root/'traffic-ledger.jsonl').read_text().splitlines()]
    validate_private_files(root, profile, ledger)
    labels={'project-'+str(index) for index in range(profile['projects'])}
    reports=[]
    for index in range(1,4):
        report=json.loads((root/('balanced-'+str(index)+'.json')).read_text())
        gates=json.loads((root/('balanced-'+str(index)+'-gates.json')).read_text())
        intervals=[item for item in ledger if item.get('phase')=='balanced-'+str(index)]
        if len(intervals)!=1 or intervals[0].get('completed') is not True or intervals[0].get('requested_seconds')!=profile['seconds_per_step'] or positive(intervals[0].get('elapsed_seconds'))<profile['seconds_per_step']:
            raise ValueError('Missing completed five-minute traffic interval')
        if set(report)!=labels or gates:
            raise ValueError('Balanced samples are missing, failed or use another topology')
        for label, value in report.items():
            metrics=value['metrics']
            dropped=closed_count(value.get('arrival_counter_evidence'),'balanced-'+str(index),label,value.get('duration_seconds'))
            if dropped != metrics['dropped_iterations']['count']:
                raise ValueError('Reported host drops disagree with retained scheduler counters')
            if value.get('schema')!=2 or nonnegative(metrics['unexpected']['value'])!=0 or nonnegative(metrics['checks']['fails'])!=0 or nonnegative(metrics['overload_rejections']['count'])!=0:
                raise ValueError('Unexpected or overloaded traffic cannot certify a nominal baseline')
            if nonnegative(metrics['http_reqs']['count']) != positive(metrics['successful_operations']['count']) + nonnegative(metrics['expected_rejections']['count']):
                raise ValueError('Disk host HTTP attempts disagree with successful work and expected rejections')
            expected=profile['nominal_rate_per_project']*profile['seconds_per_step']
            if positive(metrics['iterations']['count'])<expected*.99 or nonnegative(metrics['dropped_iterations']['count'])>expected*.01:
                raise ValueError('Under-delivered arrivals cannot certify regressions')
            for operation in OPERATIONS:
                latency=metrics['latency_'+operation]
                p95,p99=positive(latency['p(95)']),positive(latency['p(99)'])
                if p95>p99 or p95>NOMINAL_SLOS[operation][0] or p99>NOMINAL_SLOS[operation][1]:
                    raise ValueError('Invalid quantiles or absolute nominal SLO violation')
                positive(metrics['throughput_'+operation]['rate'])
        reports.append(report)
    return profile,reports


def compare(baseline,candidate):
    before,left=read_run(baseline)
    after,right=read_run(candidate)
    differences=[field for field in FIELDS if before[field]!=after[field]]
    rows=[]
    for label in left[0]:
        for operation in OPERATIONS:
            latencies=[statistics.median(sample[label]['metrics']['latency_'+operation]['p(95)'] for sample in samples) for samples in [left,right]]
            rates=[statistics.median(sample[label]['metrics']['throughput_'+operation]['rate'] for sample in samples) for samples in [left,right]]
            latency_ratio=latencies[1]/latencies[0]
            throughput_ratio=rates[1]/rates[0]
            rows.append({'project':label,'operation':operation,'baseline_p95_ms':latencies[0],'candidate_p95_ms':latencies[1],'baseline_successful_operations_per_second':rates[0],'candidate_successful_operations_per_second':rates[1],'p95_ratio':latency_ratio,'throughput_ratio':throughput_ratio,'gate_passed':not differences and latency_ratio<=1.1 and throughput_ratio>=.9})
    return {'kind':'independent-project steady regression','fixture_differences':differences,'rows':rows,'gate_passed':bool(rows) and all(row['gate_passed'] for row in rows)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline',type=Path)
    parser.add_argument('candidate',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:
        result=compare(args.baseline,args.candidate)
    except (OSError,ValueError,KeyError,TypeError,RuntimeError) as error:
        result={'gate_passed':False,'invalid_evidence':type(error).__name__,'reason':str(error)[-600:]}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    if not result['gate_passed']:
        raise SystemExit('Host regression envelope was not established')


if __name__=='__main__':
    main()
