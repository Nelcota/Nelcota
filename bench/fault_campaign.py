"""Owned fault/cancellation ledger and live snapshot restore, without public ingress.

Without --capacity this is a functional smoke. Full mode first qualifies four
five-minute arrival steps, then injects faults at 80% of the qualified bound.
The workload is explicit ledger mutations plus negative JWT probes; native
controller/public deployment acceptance remains separate.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from campaign import ResourceCoverage, docker, effective_cpus, free_port, redacted_diagnostic, request, validate_disk_headroom
from observations import ObservationEpoch, inspect_container
from projects import Project
from watchdog import LABEL, atomic_json, cleanup, host_reserves, process_identity
from host_resources import snapshot as host_snapshot, owned_cgroup_snapshot, require_no_oom
from ownership import OwnedDocker
from objects import S3Inventory
from ports import published_port
from postgres_evidence import retain_failure
from http_boundary import ledger_opener as opener
from fixture_copy import copy_to_tmpfs
from disk_usage import container as container_disk_usage
from lost_reply import discard_reply
from ledger_capacity import DEFAULT_PROVISIONAL_RATE, STEP_SECONDS, STEP_PERCENTAGES, offered_rates

ROOT = Path(__file__).resolve().parents[1]
MUTATION_PATH='/rest/v1/rpc/stress_transfer'
MUTATION_FIXTURE="""
CREATE TABLE public.stress_operations(id uuid PRIMARY KEY,digest text NOT NULL,delta smallint NOT NULL CHECK(delta IN(-1,1)));
CREATE TABLE public.stress_accounts(id integer PRIMARY KEY,balance bigint NOT NULL CHECK(balance>=0));
INSERT INTO public.stress_accounts VALUES(1,1000000),(2,1000000);
CREATE TABLE public.stress_counts(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),value bigint NOT NULL);
INSERT INTO public.stress_counts VALUES(true,0);
CREATE FUNCTION public.stress_transfer(operation_id uuid,operation_digest text,delta integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF delta IS NULL OR delta NOT IN(-1,1) OR operation_digest IS NULL OR operation_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid fixture operation' USING ERRCODE='22023';
  END IF;
  PERFORM id FROM public.stress_accounts ORDER BY id FOR UPDATE;
  INSERT INTO public.stress_operations VALUES(operation_id,operation_digest,delta);
  UPDATE public.stress_accounts SET balance=balance+CASE id WHEN 1 THEN delta ELSE -delta END;
  UPDATE public.stress_counts SET value=value+1 WHERE singleton;
  RETURN jsonb_build_object('accepted',operation_id);
END $$;
REVOKE ALL ON FUNCTION public.stress_transfer(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stress_transfer(uuid,text,integer) TO service_role;
GRANT SELECT ON public.stress_operations,public.stress_accounts,public.stress_counts TO service_role;
NOTIFY nelcota,'reload schema';
"""


def accounting(project):
    value=json.loads(project.sql("SELECT json_build_object('accounts',(SELECT count(*) FROM public.stress_accounts),'total',(SELECT sum(balance) FROM public.stress_accounts),'first_balance',(SELECT balance FROM public.stress_accounts WHERE id=1),'committed',(SELECT count(*) FROM public.stress_operations),'delta',(SELECT coalesce(sum(delta),0) FROM public.stress_operations),'counter',(SELECT value FROM public.stress_counts WHERE singleton))"))
    if value['accounts']!=2 or value['total']!=2000000 or value['first_balance']!=1000000+value['delta'] or value['counter']!=value['committed']:
        raise RuntimeError('Atomic transfer, rollback or hot counter accounting failed')
    return value


def successful_latency_evidence(values):
    if not values:
        return None
    if any(isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<=0 for value in values):
        raise ValueError('Invalid successful-response latency evidence')
    ordered=sorted(values)
    return {'p95_ms':ordered[max(0,math.ceil(len(ordered)*.95)-1)],'p99_ms':ordered[max(0,math.ceil(len(ordered)*.99)-1)],'successful_post_responses':len(ordered),'method':'nearest rank, successful POST only'}


def recovery_read_matches(code,body,marker):
    if code!=200:
        return False
    try:
        rows=json.loads(body)
    except (ValueError,TypeError):
        raise RuntimeError('Successful recovery response was malformed') from None
    if not isinstance(rows,list) or not rows or any(not isinstance(row,dict) or not isinstance(row.get('name'),str) or not row['name'].startswith(marker) for row in rows):
        raise RuntimeError('Successful recovery response crossed its data boundary')
    return True


def require_unauthorized(status):
    if status!=401:
        raise RuntimeError('Invalid credential received an unexpected authorization result')


def require_running(critical,watchdog,action_errors):
    if action_errors:
        raise action_errors[0]
    if critical.is_set() or watchdog.poll() is not None:
        raise RuntimeError('Fault resource guard stopped traffic')


def raw(project,method,path,value=None,token=None,s3_endpoint=None):
    body = None
    if value is not None:
        body=json.dumps(value).encode()
    headers={'Content-Type':'application/json','Authorization':'Bearer '+(token or project.fixture['service'])}
    query=urllib.request.Request(project.base+path,data=body,method=method,headers=headers)
    try:
        response=opener(s3_endpoint).open(query,timeout=8)
    except urllib.error.HTTPError as error:
        response=error
    with response:
        payload=response.read(1024*1024+1)
        if len(payload)>1024*1024:
            raise RuntimeError('Canary response exceeded its byte budget')
        return response.status,payload


def run(args):
    output=args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise RuntimeError('Preserve previous evidence; use a fresh output directory')
    output.mkdir(parents=True,exist_ok=True)
    cpus=sorted(os.sched_getaffinity(0))
    if len(cpus)<4 or effective_cpus(cpus)<3.5 or host_reserves(output):
        raise RuntimeError('Insufficient host resource reserves')
    validate_disk_headroom(output,1024+512*int(args.s3_faults),startup_mib=1600+512*int(args.s3_faults))
    os.sched_setaffinity(0,{cpus[2]})
    identity='nelcota-fault-'+secrets.token_hex(16)
    owned=OwnedDocker(identity,docker)
    directory=Path(tempfile.mkdtemp(prefix='fixture-',dir=output))
    projects=[Project(identity,index,2,args.binary.resolve(),directory,cpus) for index in range(2)]
    source,target=projects
    provider=identity+'-s3'
    provider_volume=identity+'-s3-data'
    provider_started=False
    began=time.monotonic()
    phase='preparation'
    resource_at=began
    load_seconds=0
    fault_window=ObservationEpoch()
    stop=threading.Event()
    critical=threading.Event()
    coverage=ResourceCoverage()
    violations=[]
    observations_started=None
    sampler=watchdog=None
    status='failed'
    attempts={}
    attempt_lock=threading.RLock()
    initialized=[]
    manifest={'identity':identity,'output':str(output),'reserve_path':str(output),'pid':os.getpid(),'process_identity':process_identity(os.getpid()),'started_monotonic':began,'maximum_seconds':2400,'containers':[provider,*[item for project in projects for item in [project.app,project.pg]]],'volumes':[provider_volume,*[project.volume for project in projects]]}
    atomic_json(output/'ownership.json',manifest)
    atomic_json(output/'heartbeat.json',{'monotonic':began,'phase':phase,'resource_monotonic':began})
    previous=signal.getsignal(signal.SIGTERM)

    def terminate(signum,frame):
        critical.set()
        raise RuntimeError('Fault campaign stopped by watchdog or owner')

    def heartbeat():
        while not stop.is_set():
            atomic_json(output/'heartbeat.json',{'monotonic':time.monotonic(),'phase':phase,'resource_monotonic':resource_at,'load_seconds_completed':load_seconds})
            stop.wait(2)

    signal.signal(signal.SIGTERM,terminate)
    heart=threading.Thread(target=heartbeat,daemon=True)
    heart.start()
    try:
        watchdog=subprocess.Popen([sys.executable,str(ROOT/'bench/watchdog.py'),str(output/'ownership.json')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        atomic_json(output/'manifest.json',{'scope':'local ledger mutations and negative JWT probes; no public proxy/controller acceptance','capacity_qualification':args.capacity,'real_s3_faults':args.s3_faults,'binary_sha256':hashlib.file_digest(args.binary.open('rb'),'sha256').hexdigest(),'initial_iterations_per_second':args.rate,'maximum_inflight':8,'maximum_attempts':100000,'parent_rss_limit_mib':512,'app_cpu_each':.5,'postgres_cpu_each':.5,'app_memory_mib_each':128,'postgres_memory_mib_each':256,'provider_cpu':.5,'provider_memory_mib':512,'owned_filesystem_exhaustion_mib':16,'recovery_deadline_seconds':35,'snapshot':'pg_dump snapshot under controlled database writers, immutable file fixture','storage':'disk, with explicitly temporary tmpfs ENOSPC scenarios and optional real RustFS faults'})
        source.create()
        scope=json.loads((output/'manifest.json').read_text())
        scope['focus']=args.focus
        scope['dropped_replies']={'pre_response_percent':5,'after_upstream_commit_reply_percent':5,'maximum_intermediary_tasks':8,'downstream':'owned private HTTP socketpair','upstream':'real project HTTP','automatic_retries':0}
        atomic_json(output/'manifest.json',scope)
        initialized.append(source)
        source.sql(MUTATION_FIXTURE)
        time.sleep(1)
        observations_started=time.monotonic()
        resource_at=observations_started

        def sample():
            nonlocal resource_at
            while not stop.is_set():
                cycle=time.monotonic()
                epoch,fault=fault_window.capture()
                try:
                    reason=host_reserves(output)
                    if reason:
                        raise RuntimeError(reason)
                    parent_rss=next(int(line.split()[1]) for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('VmRSS:'))
                    if parent_rss>512*1024:
                        raise RuntimeError('Fault ledger exceeded the parent 512-MiB RSS budget')
                    states={}
                    running=[]
                    disks={}
                    disk_observations={}
                    cgroups={}
                    for project in list(initialized):
                        for name in [project.app,project.pg]:
                            state=inspect_container(name)
                            states[name]=None
                            if state is not None:
                                states[name]=state['State']
                            allowed=fault is not None and name==fault['container'] and time.monotonic()<=fault['expires']
                            if (state is None or not state['State']['Running'] or state['State']['OOMKilled']) and not allowed:
                                raise RuntimeError('Unexpected component stop or OOM: '+name)
                            if state is not None and state['RestartCount']:
                                raise RuntimeError('Unexpected automatic container restart')
                            if state is not None and state['State']['Running'] and not allowed:
                                cgroups[name]=owned_cgroup_snapshot(owned,name)
                                events=cgroups[name]['memory.events']
                                require_no_oom(events)
                                running.append(name)
                        if project.pg in running:
                            disk_observations[project.label]=container_disk_usage(owned,project.pg,'/var/lib/postgresql/data')
                            disks[project.label]=disk_observations[project.label]['value']
                            if disks[project.label]>512:
                                raise RuntimeError('Owned fault database exceeded its 512-MiB budget')
                    if provider_started:
                        state=inspect_container(provider)
                        allowed=fault is not None and fault['container']==provider and time.monotonic()<=fault['expires']
                        states[provider]=None
                        if state is not None:
                            states[provider]=state['State']
                        if (state is None or not state['State']['Running'] or state['State']['OOMKilled']) and not allowed:
                            raise RuntimeError('Unexpected real provider stop or OOM')
                        if state is not None and state['State']['Running'] and not allowed:
                            cgroups[provider]=owned_cgroup_snapshot(owned,provider)
                            events=cgroups[provider]['memory.events']
                            require_no_oom(events)
                            disk_observations[provider]=container_disk_usage(owned,provider,'/data')
                            if disk_observations[provider]['value']>512:
                                raise RuntimeError('Owned S3 fault provider exceeded its 512-MiB disk budget')
                            running.append(provider)
                    stats=[json.loads(line) for line in owned('stats','--no-stream','--format','{{json .}}',*running).splitlines()]
                    if not running or len(stats)!=len(running):
                        raise RuntimeError('Incomplete fault resource evidence')
                    if fault_window.changed(epoch):
                        continue
                    resource_at=time.monotonic()
                    coverage.observe(resource_at-observations_started)
                    with (output/'resources.jsonl').open('a') as target_file:
                        target_file.write(json.dumps({'monotonic':resource_at,'phase':phase,'states':states,'containers':stats,'database_disk_mib':disks,'fault':fault,'host':host_snapshot(cpus),'parent_rss_kib':parent_rss,'component_cgroups':cgroups,'disk_observations':disk_observations})+'\n')
                    atomic_json(output/'checkpoint.json',{'phase':phase,'monotonic':resource_at,'load_seconds_completed':load_seconds,'resource_observations':coverage.count})
                except Exception as error:
                    if fault_window.changed(epoch):
                        continue
                    violations.append({'phase':phase,'type':type(error).__name__,'reason':redacted_diagnostic(error,[*source.environment.values(),*target.environment.values()])})
                    critical.set()
                    return
                stop.wait(max(0,5-(time.monotonic()-cycle)))

        phase='ready'
        sampler=threading.Thread(target=sample,daemon=True)
        sampler.start()

        def operation(label,index,allow_unavailable):
            operation_id=str(uuid.uuid4())
            delta=1
            if index%2:
                delta=-1
            digest=hashlib.sha256((operation_id+':'+str(delta)).encode()).hexdigest()
            mutation={'operation_id':operation_id,'operation_digest':digest,'delta':delta}
            with attempt_lock:
                if len(attempts)>=100000:
                    raise RuntimeError('Operation ledger exceeded its admission budget')
                attempts[operation_id]={'digest':digest,'delta':delta,'acknowledged':False,'phase':label,'ambiguous':False}
                with (output/'operation-ledger.jsonl').open('a') as ledger:
                    ledger.write(json.dumps({'event':'attempt','id':operation_id,'digest':digest,'delta':delta,'phase':label})+'\n')
            post_ms=None
            try:
                if index%20==19:
                    with attempt_lock:
                        attempts[operation_id]['ambiguous']=True
                    observation=discard_reply(lambda:raw(source,'POST',MUTATION_PATH,mutation),MUTATION_PATH,json.dumps(mutation).encode(),'Bearer '+source.fixture['service'])
                    code=observation.pop('status')
                    body=observation.pop('body')
                    with attempt_lock:
                        attempts[operation_id]['reply_lost_after_commit']=observation['commit_response_observed']
                        with (output/'operation-ledger.jsonl').open('a') as ledger:
                            ledger.write(json.dumps({'event':'discarded-upstream-reply','id':operation_id,'server_status':code,**observation})+'\n')
                    if 200<=code<300:return 'deliberately-lost-committed-reply',0,None
                    if allow_unavailable and code in (503,504) and json.loads(body).get('code') in ('unavailable','db_error','request_timeout'):
                        return str(code),0,None
                    raise RuntimeError('Unexpected upstream result before reply loss: '+str(code))
                if index%20==9:
                    parsed=urllib.parse.urlsplit(source.base)
                    connection=http.client.HTTPConnection(parsed.hostname,parsed.port,timeout=5)
                    try:
                        connection.request('POST',MUTATION_PATH,body=json.dumps(mutation),headers={'Authorization':'Bearer '+source.fixture['service'],'Content-Type':'application/json'})
                    finally:
                        connection.close()
                    with attempt_lock:
                        attempts[operation_id]['ambiguous']=True
                        with (output/'operation-ledger.jsonl').open('a') as ledger:
                            ledger.write(json.dumps({'event':'ambiguous','id':operation_id})+'\n')
                    return 'deliberately-dropped-reply',0,None
                post_began=time.monotonic()
                code,body=raw(source,'POST',MUTATION_PATH,mutation)
                post_ms=(time.monotonic()-post_began)*1000
                if 200<=code<300:
                    with attempt_lock:
                        attempts[operation_id]['acknowledged']=True
                        with (output/'operation-ledger.jsonl').open('a') as ledger:
                            ledger.write(json.dumps({'event':'acknowledged','id':operation_id,'monotonic':time.monotonic()})+'\n')
                    foreign_code,_=raw(source,'GET','/rest/v1/bench_products?limit=1',token=source.fixture['invalid_access'])
                    if foreign_code!=401:
                        raise RuntimeError('Unauthorized probe was not rejected before database access')
                    return str(code),1,post_ms
                if allow_unavailable and code in (503,504):
                    value=json.loads(body)
                    if value.get('code') not in ('unavailable','db_error','request_timeout'):
                        raise RuntimeError('Unexpected database failure code: '+str(value.get('code'))[:80])
                    return str(code),0,post_ms
                raise RuntimeError('Unexpected mutation status: '+str(code))
            except (urllib.error.URLError,TimeoutError,ConnectionError,http.client.HTTPException):
                with attempt_lock:
                    acknowledged=attempts[operation_id]['acknowledged']
                    if not acknowledged:
                        attempts[operation_id]['ambiguous']=True
                        with (output/'operation-ledger.jsonl').open('a') as ledger:
                            ledger.write(json.dumps({'event':'ambiguous','id':operation_id})+'\n')
                if allow_unavailable:
                    return 'connection-unavailable',int(acknowledged),post_ms
                raise

        def traffic(label,seconds,action=None,allow_unavailable=False,rate=None,exploratory=False):
            from ledger_arrivals import collect_ready, has_capacity
            nonlocal phase,load_seconds
            phase=label
            if rate is None:
                rate=args.rate
            scheduling_before=None
            if args.focus=='matrix':
                from generator_cpu import observe
                scheduling_before=observe(cpus)
            print('Running',label,rate,'iterations/s for',seconds,'seconds',flush=True)
            start=time.monotonic()
            counts=Counter()
            success_latencies=[]
            in_flight=set()
            action_error=[]
            action_times={}
            action_thread=None
            if action is not None:
                def invoke():
                    try:
                        time.sleep(2)
                        action_times['started']=time.monotonic()
                        try:
                            action()
                        finally:
                            action_times['ended']=time.monotonic()
                    except Exception as error:
                        action_error.append(error)
                        atomic_json(output/(label+'-action-error.json'),{'type':type(error).__name__,'diagnostic':redacted_diagnostic(error,[*source.environment.values(),*target.environment.values()])})
                        critical.set()
                action_thread=threading.Thread(target=invoke,daemon=True)
                action_thread.start()
            with ThreadPoolExecutor(max_workers=8) as workers:
                for index in range(seconds*rate):
                    require_running(critical,watchdog,action_error)
                    collect_ready(in_flight,counts,success_latencies)
                    delay=start+index/rate-time.monotonic()
                    if delay < -1/rate:
                        counts['late_arrivals']+=1
                        counts['dropped_arrivals']+=1
                        continue
                    if delay>0:
                        time.sleep(delay)
                    if not has_capacity(in_flight,counts,success_latencies):
                        counts['dropped_arrivals']+=1
                        continue
                    in_flight.add(workers.submit(operation,label,index,allow_unavailable))
                for future in in_flight:
                    outcome,ack,latency=future.result()
                    counts[outcome]+=1;counts['acknowledged']+=ack
                    if ack:
                        success_latencies.append(latency)
            if action_thread is not None:
                action_thread.join(timeout=40)
                if action_thread.is_alive():
                    raise RuntimeError('Fault injection did not finish within its deadline')
            if action_error:
                raise action_error[0]
            elapsed=time.monotonic()-start
            if elapsed<seconds:
                time.sleep(seconds-elapsed)
                elapsed=time.monotonic()-start
            latency=successful_latency_evidence(success_latencies)
            qualified=latency is not None and latency['p95_ms']<=500 and latency['p99_ms']<=1500 and counts['dropped_arrivals']<=seconds*rate*.01 and not counts['503'] and not counts['504'] and not counts['connection-unavailable']
            report={'counts':dict(counts),'requested_seconds':seconds,'elapsed_seconds':elapsed,'offered_iterations':seconds*rate,'rate':rate,'fault_injected':action is not None,'exploratory':exploratory,'success_latency':latency,'nominal_qualified':qualified}
            if args.focus=='matrix' and action is not None:
                from matrix_pressure import action_window
                report['supplemental_action']=action_window(action_times['started'],action_times['ended'],start,seconds)
            if scheduling_before is not None:
                from generator_cpu import evidence, observe
                report['generator_cpu']=evidence(scheduling_before,observe(cpus))
            atomic_json(output/(label+'.json'),report)
            with (output/'traffic-ledger.jsonl').open('a') as ledger:
                ledger.write(json.dumps({'phase':label,'requested_seconds':seconds,'elapsed_seconds':elapsed,'completed':True,'started_monotonic':start,'ended_monotonic':time.monotonic()})+'\n')
            load_seconds+=min(seconds,elapsed)
            if not allow_unavailable and not exploratory and not qualified:
                raise RuntimeError('Nominal ledger delivery or latency SLO failed')
            return report

        def recover(label,began_recovery):
            nonlocal phase
            phase=label
            while time.monotonic()-began_recovery<=35:
                try:
                    code,body=raw(source,'GET','/rest/v1/bench_products?limit=1')
                    invalid,_=raw(source,'GET','/rest/v1/bench_products?limit=1',token=source.fixture['invalid_access'])
                    require_unauthorized(invalid)
                    if recovery_read_matches(code,body,source.label+':'):
                        atomic_json(output/(label+'.json'),{'status':'passed','recovery_seconds':time.monotonic()-began_recovery,'positive_status':code,'unauthorized_status':invalid})
                        return
                except (OSError,ValueError):
                    pass
                time.sleep(.25)
            raise RuntimeError('Authorized and unauthorized recovery probes exceeded 35 seconds')

        traffic('baseline',30)
        invalid_id=str(uuid.uuid4())
        invalid_status,_=raw(source,'POST',MUTATION_PATH,{'operation_id':invalid_id,'operation_digest':hashlib.sha256(invalid_id.encode()).hexdigest(),'delta':0})
        if invalid_status!=400 or source.sql("SELECT count(*) FROM public.stress_operations WHERE id='"+invalid_id+"'")!='0':
            raise RuntimeError('Invalid transfer published partial fixture state')
        session,_=request(source.base,'/auth/v1/token?grant_type=password',{'email':source.email,'password':source.password})
        forbidden,_=raw(source,'POST',MUTATION_PATH,{'operation_id':str(uuid.uuid4()),'operation_digest':hashlib.sha256(invalid_id.encode()).hexdigest(),'delta':1},token=session['access_token'])
        if forbidden!=403:
            raise RuntimeError('Authenticated user reached the privileged fixture mutation')
        atomic_json(output/'mutation-boundaries.json',{'invalid_delta_status':invalid_status,'authenticated_without_execute_status':forbidden,'partial_invalid_rows':0})
        if args.capacity:
            probes=[]
            qualified=0
            for percent, offered in zip(STEP_PERCENTAGES, offered_rates(args.provisional_rate)):
                result=traffic('capacity-'+str(percent),STEP_SECONDS,rate=offered,allow_unavailable=True,exploratory=True)
                probes.append(result)
                atomic_json(output/'capacity-probes.json',probes)
                if result['nominal_qualified']:
                    qualified=max(qualified,offered)
            if not qualified:
                raise RuntimeError('No ledger workload rate qualified for faults')
            args.rate=max(1,int(qualified*.8))
            atomic_json(output/'capacity.json',{'qualified_lower_bound_iterations_per_second':qualified,'fault_rate':args.rate,'ratio':args.rate/qualified,'workload':'90% acknowledged atomic-transfer RPC plus negative JWT probe, 5% pre-response disconnects, 5% discarded real upstream commit replies; ambiguous outcomes reconciled without retries'})
        if args.focus=='matrix':
            from matrix_pressure import Probes, PROFILE, failure_receipt
            scope['supplemental_matrix']={**PROFILE,'seconds_per_scenario':args.matrix_step_seconds,
                                         'full_duration':args.matrix_step_seconds==120}
            atomic_json(output/'manifest.json',scope)
            probes=Probes(source,output,lambda:require_running(critical,watchdog,[]))
            for label,action in [('admin-budgets',probes.admin_budgets),('admin-cancellation',probes.admin_cancellation),
                                 ('catalog-recovery',probes.catalog_recovery),('hostile-backend',probes.hostile_backend),
                                 ('auth-links',probes.auth_links)]:
                try:
                    traffic('matrix-'+label,args.matrix_step_seconds,action)
                except Exception as error:
                    atomic_json(output/'matrix-failure.json',failure_receipt(error,label))
                    raise
        def database_stop():
            fault_window.set({'name':'database-unavailable','container':source.pg,'expires':time.monotonic()+20})
            try:
                owned('stop','-t','1',source.pg)
                time.sleep(5)
            finally:
                recovery_began=time.monotonic()
                owned('start',source.pg)
                published_port(owned,source.pg,5432,source.pg_port)
            recover('database-recovery',recovery_began)
            fault_window.set(None)
        if args.focus=='all':traffic('database-unavailable',20,database_stop,allow_unavailable=True)
        if args.focus=='all':traffic('database-recovered',20)
        def deadlock():
            before=int(source.sql("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()"))
            statement="BEGIN; SET LOCAL lock_timeout='10s'; SELECT id FROM public.stress_accounts WHERE id=2 FOR UPDATE; SELECT pg_sleep(2); SELECT id FROM public.stress_accounts WHERE id=1 FOR UPDATE; COMMIT;"
            try:
                source.sql(statement)
            except RuntimeError as error:
                if 'deadlock detected' not in str(error):
                    raise
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                after=int(source.sql("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()"))
                if after>before:
                    atomic_json(output/'deadlock.json',{'observed':after-before,'status':'passed','direct_locker_mutations':False})
                    return
                time.sleep(.2)
            raise RuntimeError('Controlled deadlock did not occur')
        if args.focus=='all':traffic('deadlock-under-writers',20,deadlock,allow_unavailable=True)
        if args.focus=='all':traffic('deadlock-recovered',20)
        def application_kill():
            fault_window.set({'name':'app-kill','container':source.app,'expires':time.monotonic()+30})
            recovery_began=time.monotonic()
            try:
                owned('kill','--signal','KILL',source.app)
                owned('rm',source.app)
                source.start_app()
                recover('app-recovery',recovery_began)
            finally:
                fault_window.set(None)
        if args.focus=='all':traffic('app-kill',20,application_kill,allow_unavailable=True)
        if args.focus=='all':traffic('app-recovered',20)
        def application_oom():
            fault_window.set({'name':'declared-container-oom','container':source.app,'expires':time.monotonic()+60})
            source.extra_labels={'io.nelcota.stress.fault':'oom'}
            try:
                owned('rm','-f',source.app)
                source.start_app()
                atomic_json(output/'declared-oom-before.json',{'state':inspect_container(source.app)['State'],'cgroup':owned_cgroup_snapshot(owned,source.app)})
                owned('update','--memory','8m','--memory-swap','8m',source.app)
                # Idle anonymous memory can fit in 8 MiB even with higher RSS.
                # One unchanged Argon2 verification touches more than that cap.
                try:
                    raw(source,'POST','/auth/v1/token?grant_type=password',{'email':source.email,'password':source.password})
                except (urllib.error.URLError,TimeoutError,ConnectionError,http.client.HTTPException):
                    pass
                deadline=time.monotonic()+10
                while time.monotonic()<deadline:
                    state=inspect_container(source.app)
                    if state is not None and state['State']['OOMKilled']:
                        atomic_json(output/'declared-oom.json',{'status':'observed','state':state['State'],'limit_mib':8,'tag':'io.nelcota.stress.fault=oom','scope':'only the owned source app','trigger':'one normal password verification with unchanged Argon2 parameters'})
                        break
                    time.sleep(.1)
                if state is None or not state['State']['OOMKilled']:
                    observed={'state':None}
                    if state is not None:
                        observed.update({'state':state['State'],'memory_limit_bytes':state['HostConfig']['Memory'],'memory_swap_bytes':state['HostConfig']['MemorySwap']})
                    atomic_json(output/'declared-oom-unobserved.json',observed)
                    raise RuntimeError('The declared OOM did not occur')
                recovery_began=time.monotonic()
            finally:
                owned('rm','-f',source.app)
                source.extra_labels={}
                source.start_app()
            recover('oom-recovery',recovery_began)
            fault_window.set(None)
        if args.focus=='all':traffic('container-oom',30,application_oom,allow_unavailable=True)
        if args.focus=='all':traffic('oom-recovered',20)
        phase='snapshot'
        # pg_dump obtains one consistent MVCC snapshot while writers continue.
        # Object bytes are immutable in this declared workload.
        def snapshot():
            archive=directory/'database.dump'
            snapshot_began=time.monotonic()
            with archive.open('wb') as destination:
                result=subprocess.run(['docker','exec',source.docker.require(source.pg),'pg_dump','-U','postgres','-Fc','--no-owner'],stdout=destination,stderr=subprocess.PIPE,timeout=60)
            archive.chmod(0o600)
            if result.returncode or archive.stat().st_size>128*1024*1024:
                raise RuntimeError('Database snapshot failed or exceeded its size budget')
            shutil.copytree(source.storage,directory/'snapshot-files')
            atomic_json(output/'snapshot.json',{'bytes':archive.stat().st_size,'sha256':hashlib.file_digest(archive.open('rb'),'sha256').hexdigest(),'writers_active':True,'object_fixture_mutations':False,'started_monotonic':snapshot_began,'ended_monotonic':time.monotonic()})
        traffic('snapshot-under-writers',20,snapshot)
        writers_stopped=time.monotonic()
        phase='restore-preparation'
        target.create()
        initialized.append(target)
        fault_window.set({'name':'restore','container':target.app,'expires':time.monotonic()+90})
        restored_at=time.monotonic()
        try:
            owned('rm','-f',target.app)
            with (directory/'database.dump').open('rb') as archive:
                result=subprocess.run(['docker','exec','-i',target.docker.require(target.pg),'pg_restore','-U','postgres','-d','postgres','--clean','--if-exists','--no-owner','--exit-on-error'],stdin=archive,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=60)
            if result.returncode:
                raise RuntimeError('Snapshot restore failed')
            shutil.rmtree(target.storage)
            shutil.copytree(directory/'snapshot-files',target.storage)
            target.start_app()
            restored_session,_=request(target.base,'/auth/v1/token?grant_type=password',{'email':source.email,'password':source.password})
            if restored_session['user']['id']!=source.fixture['user']:
                raise RuntimeError('Restored authentication identity changed')
            target.assert_foreign_denied(source.fixture)
            restored_accounting=accounting(target)
            file_status,file_bytes=raw(target,'GET','/storage/v1/object/bench/fixture.txt')
            if file_status!=200 or file_bytes!=json.dumps(source.label+': payload').encode():
                raise RuntimeError('Restored physical bytes differ from the snapshot')
            source_rows=json.loads(source.sql("SELECT coalesce(json_object_agg(id,digest),'{}'::json) FROM public.stress_operations"))
            restored_rows=json.loads(target.sql("SELECT coalesce(json_object_agg(id,digest),'{}'::json) FROM public.stress_operations"))
            if not restored_rows or any(source_rows.get(key)!=value for key,value in restored_rows.items()):
                raise RuntimeError('Restored ledger is corrupt')
            snapshot_info=json.loads((output/'snapshot.json').read_text())
            atomic_json(output/'restore.json',{'status':'passed','rto_seconds':time.monotonic()-restored_at,'rpo_upper_bound_seconds':writers_stopped-snapshot_info['started_monotonic'],'restored_rows':len(restored_rows),'source_rows':len(source_rows),'restored_accounting':restored_accounting,'intentional_snapshot_rewind_rows':len(set(source_rows)-set(restored_rows)),'cross_project_token_status':401,'restored_user_matches':True,'physical_bytes_match':True,'scope':'local DB snapshot plus immutable files, no off-host/PITR/systemd certification'})
        finally:
            fault_window.set(None)
        def filesystem_exhaustion(kind):
            nonlocal phase
            phase='owned-filesystem-'+kind
            fault_window.set({'name':'owned-tmpfs-'+kind,'container':source.app,'expires':time.monotonic()+90})
            source.ephemeral_storage_mib=16
            source.ephemeral_storage_inodes=None
            if kind=='inodes':
                source.ephemeral_storage_inodes=64
            try:
                owned('rm','-f',source.app)
                source.start_app()
                atomic_json(output/('filesystem-'+kind+'-fixture-copy.json'),copy_to_tmpfs(owned,source.storage,source.app))
                before_status,before_bytes=raw(source,'GET','/storage/v1/object/bench/fixture.txt')
                atomic_json(output/('filesystem-'+kind+'-fixture-before.json'),{'status':before_status,'bytes':len(before_bytes),'sha256':hashlib.sha256(before_bytes).hexdigest(),'physical_files':owned('exec',source.app,'find','/storage','-maxdepth','3','-type','f','-printf','%P %s %U %G %m\n')})
                if before_status!=200 or before_bytes!=json.dumps(source.label+': payload').encode():
                    raise RuntimeError('Copied fixture is unreadable before filesystem pressure')
                committed_before=int(source.sql('SELECT count(*) FROM public.stress_operations'))
                fill_command=['dd','if=/dev/zero','of=/storage/.g05-quota-fill','bs=1048576','count=17']
                if kind=='inodes':
                    fill_command=['sh','-c','counter=0; while [ "$counter" -lt 128 ]; do : > "/storage/.g05-inode-$counter" || exit 17; counter=$((counter+1)); done']
                fill=subprocess.run(['docker','exec',source.docker.require(source.app),*fill_command],capture_output=True,text=True,timeout=15)
                if fill.returncode==0 or 'No space left on device' not in fill.stderr:
                    raise RuntimeError('The owned filesystem did not reach its declared quota')
                code,body=raw(source,'PUT','/storage/v1/object/bench/fault-exhausted.txt','bounded quota probe')
                failure_code=json.loads(body).get('code')
                atomic_json(output/('filesystem-'+kind+'-response.json'),{'status':code,'code':failure_code})
                expected={'bytes':(507,'storage_full'),'inodes':(500,'internal')}[kind]
                if (code,failure_code)!=expected:
                    raise RuntimeError('Unexpected real ENOSPC response contract')
                if source.sql("SELECT count(*) FROM storage.objects WHERE bucket_id='bench' AND name='fault-exhausted.txt'")!='0':
                    raise RuntimeError('Failed upload published metadata')
                existing_status,existing_bytes=raw(source,'GET','/storage/v1/object/bench/fixture.txt')
                atomic_json(output/('filesystem-'+kind+'-fixture-after.json'),{'status':existing_status,'bytes':len(existing_bytes),'sha256':hashlib.sha256(existing_bytes).hexdigest(),'physical_files':owned('exec',source.app,'find','/storage','-maxdepth','3','-type','f','-printf','%P %s %U %G %m\n')})
                if existing_status!=200 or existing_bytes!=json.dumps(source.label+': payload').encode():
                    raise RuntimeError('Existing bytes changed during the owned quota fault')
                time.sleep(2)
                committed_during=int(source.sql('SELECT count(*) FROM public.stress_operations'))-committed_before
                if committed_during<=0:
                    raise RuntimeError('Ordinary database traffic did not progress during the filesystem fault')
                if kind=='bytes':
                    owned('exec',source.app,'rm','/storage/.g05-quota-fill')
                if kind=='inodes':
                    owned('exec',source.app,'sh','-c','rm -f /storage/.g05-inode-*')
                code,_=raw(source,'PUT','/storage/v1/object/bench/fault-recovery.txt','bounded quota probe')
                if not 200<=code<300:
                    raise RuntimeError('Upload admission did not recover after filesystem pressure')
                code,body=raw(source,'GET','/storage/v1/object/bench/fault-recovery.txt')
                if code!=200 or body!=json.dumps('bounded quota probe').encode():
                    raise RuntimeError('Post-ENOSPC upload bytes differ')
                code,_=raw(source,'DELETE','/storage/v1/object/bench/fault-recovery.txt')
                if not 200<=code<300:
                    raise RuntimeError('Post-ENOSPC object cleanup failed')
                atomic_json(output/('filesystem-'+kind+'.json'),{'status':'passed','filesystem':'owned 16-MiB tmpfs','host_disk_filled':False,'observed_enospc':True,'inodes':source.ephemeral_storage_inodes,'database_commits_during_fault':committed_during,'failure_http_status':expected[0],'failure_code':expected[1],'failed_metadata_rows':0,'subsequent_upload_and_bytes_verified':True})
            finally:
                owned('rm','-f',source.app)
                source.ephemeral_storage_mib=None
                source.ephemeral_storage_inodes=None
                source.start_app()
                fault_window.set(None)
        for kind in ['bytes','inodes']:
            if args.focus in ('all','filesystem'):traffic('filesystem-'+kind+'-under-writers',30,lambda:filesystem_exhaustion(kind),allow_unavailable=True)
        if args.focus in ('all','filesystem'):traffic('filesystem-recovered',20)
        if args.s3_faults and args.focus!='filesystem':
            phase='provider-preparation'
            access,secret=secrets.token_hex(16),secrets.token_hex(32)
            provider_port=free_port()
            owned('volume','create','--label',LABEL+'='+identity,provider_volume)
            owned('run','-d','--name',provider,'--label',LABEL+'='+identity,'--pids-limit','128','--cpus','.5','--cpuset-cpus',str(cpus[3]),'--memory','512m','--memory-swap','512m','-e','RUSTFS_ACCESS_KEY','-e','RUSTFS_SECRET_KEY','-p',f'127.0.0.1:{provider_port}:9000','--mount',f'type=volume,source={provider_volume},destination=/data','rustfs/rustfs:1.0.1',env={'RUSTFS_ACCESS_KEY':access,'RUSTFS_SECRET_KEY':secret})
            provider_started=True
            published_port(owned,provider,9000,provider_port)
            endpoint='http://127.0.0.1:'+str(provider_port)
            inventory_client=S3Inventory(endpoint,access,secret,'benchmark-files')
            ready_deadline=time.monotonic()+30
            while True:
                try:
                    inventory_client.send({},method='PUT',body=b'')
                    break
                except urllib.error.HTTPError as error:
                    if error.code==409:
                        break
                    if time.monotonic()>=ready_deadline:
                        raise RuntimeError('Real S3 fault provider did not become ready') from None
                except (urllib.error.URLError,TimeoutError):
                    if time.monotonic()>=ready_deadline:
                        raise RuntimeError('Real S3 fault provider did not become ready') from None
                time.sleep(.2)
            fixture_key=source.sql("SELECT bucket_id||'/'||version::text FROM storage.objects WHERE name='fixture.txt' AND bucket_id='bench'")
            fixture_bytes=json.dumps(source.label+': payload').encode()
            inventory_client.write_key(fixture_key,body=fixture_bytes)
            source.environment.update({'NELCOTA_STORAGE_BACKEND':'s3','NELCOTA_STORAGE_S3_ENDPOINT':endpoint,'NELCOTA_STORAGE_S3_BUCKET':'benchmark-files','NELCOTA_STORAGE_S3_REGION':'us-east-1','NELCOTA_STORAGE_S3_ACCESS_KEY_ID':access,'NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY':secret})
            fault_window.set({'name':'s3-backend-switch','container':source.app,'expires':time.monotonic()+60})
            try:
                owned('rm','-f',source.app)
                source.start_app()
            finally:
                fault_window.set(None)

            def provider_fault(kind):
                nonlocal phase
                phase='provider-'+kind
                failures=[]
                counters=Counter()
                counter_lock=threading.Lock()
                probe_stop=threading.Event()
                expected=threading.Event()
                probe_body='provider fault probe'
                probe_bytes=json.dumps(probe_body).encode()
                recovery_name='provider-recovery-'+kind+'.txt'
                def probe(write):
                    while not probe_stop.is_set():
                        began_request=time.monotonic()
                        may_fail=expected.is_set()
                        try:
                            method='GET'
                            path='/storage/v1/object/bench/fixture.txt'
                            body=None
                            if write:
                                method='PUT';path='/storage/v1/object/bench/provider-probe.txt';body=probe_body
                            code,payload=raw(source,method,path,body,s3_endpoint=endpoint)
                            if 200<=code<300:
                                if not write and payload!=fixture_bytes:
                                    raise RuntimeError('Provider restart changed published fixture bytes')
                            if not 200<=code<300:
                                if not (may_fail or expected.is_set()) or code not in (500,503,504):
                                    raise RuntimeError('Unexpected provider probe status: '+str(code))
                                if code==500 and json.loads(payload).get('code')!='internal':
                                    raise RuntimeError('Unexpected provider error contract')
                            with counter_lock:
                                counters[str(code)]+=1
                        except (urllib.error.URLError,TimeoutError,ConnectionError,http.client.HTTPException):
                            if not (may_fail or expected.is_set()):
                                failures.append('unexpected provider connection failure')
                                critical.set()
                                return
                            with counter_lock:
                                counters['connection-unavailable']+=1
                        except Exception as error:
                            failures.append(type(error).__name__)
                            critical.set()
                            return
                        probe_stop.wait(max(0,.1-(time.monotonic()-began_request)))
                threads=[threading.Thread(target=probe,args=(value,),daemon=True) for value in [False,True]]
                for thread in threads:thread.start()
                try:
                    time.sleep(1)
                    expected.set()
                    fault_window.set({'name':'provider-'+kind,'container':provider,'expires':time.monotonic()+45})
                    try:
                        if kind=='restart':
                            owned('stop','-t','1',provider)
                        if kind=='pause':
                            owned('pause',provider)
                        time.sleep(5)
                    finally:
                        recovery_began=time.monotonic()
                        if kind=='restart':
                            owned('start',provider)
                            published_port(owned,provider,9000,provider_port)
                        if kind=='pause':
                            owned('unpause',provider)
                    code,payload,invalid=0,b'',0
                    recovered_seconds=None
                    while time.monotonic()-recovery_began<=35:
                        try:
                            code,payload=raw(source,'GET','/storage/v1/object/bench/fixture.txt',s3_endpoint=endpoint)
                            invalid,_=raw(source,'GET','/rest/v1/bench_products?limit=1',token=source.fixture['invalid_access'])
                            require_unauthorized(invalid)
                            if code==200 and payload!=fixture_bytes:
                                raise RuntimeError('Successful recovery read returned corrupt object bytes')
                            if code==200:
                                put_status,_=raw(source,'PUT','/storage/v1/object/bench/'+recovery_name,probe_body)
                                if 200<=put_status<300:
                                    read_status,read_bytes=raw(source,'GET','/storage/v1/object/bench/'+recovery_name,s3_endpoint=endpoint)
                                    if read_status==200 and read_bytes!=probe_bytes:
                                        raise RuntimeError('Successful recovered write returned corrupt bytes')
                                    if read_status==200:
                                        recovered_seconds=time.monotonic()-recovery_began
                                        break
                        except (OSError,ValueError):
                            pass
                        time.sleep(.25)
                    if recovered_seconds is None or recovered_seconds>35:
                        raise RuntimeError('Storage provider did not recover within 35 seconds')
                    time.sleep(1)
                    expected.clear()
                    fault_window.set(None)
                finally:
                    probe_stop.set()
                    for thread in threads:thread.join(timeout=10)
                if failures or any(thread.is_alive() for thread in threads):
                    raise RuntimeError('Provider probe failed or retained a task')
                code,payload=raw(source,'GET','/storage/v1/object/bench/provider-probe.txt',s3_endpoint=endpoint)
                if code!=200 or payload!=probe_bytes:
                    raise RuntimeError('Acknowledged provider object did not survive recovery')
                deleted,_=raw(source,'DELETE','/storage/v1/object/bench/'+recovery_name)
                if not 200<=deleted<300:
                    raise RuntimeError('Recovered provider probe did not clean up')
                atomic_json(output/('provider-'+kind+'.json'),{'status':'passed','responses':dict(counters),'recovery_seconds':recovered_seconds,'positive_bytes_verified':True,'unauthorized_status':401,'real_provider':'RustFS'})
            for kind in ['restart','pause']:
                traffic('provider-'+kind+'-under-writers',30,lambda:provider_fault(kind))
            code,_=raw(source,'DELETE','/storage/v1/object/bench/provider-probe.txt')
            if not 200<=code<300 or inventory_client.inventory()['multipart_uploads']:
                raise RuntimeError('Provider state did not drain after faults')
            source.environment['NELCOTA_STORAGE_BACKEND']='disk'
            for key in list(source.environment):
                if key.startswith('NELCOTA_STORAGE_S3_'):
                    del source.environment[key]
            fault_window.set({'name':'disk-backend-recovery','container':source.app,'expires':time.monotonic()+60})
            try:
                owned('rm','-f',source.app)
                source.start_app()
            finally:
                fault_window.set(None)
            traffic('provider-recovered',20)
        phase='reconciliation'
        rows=json.loads(source.sql("SELECT coalesce(json_object_agg(id,digest),'{}'::json) FROM public.stress_operations"))
        missing=[key for key,value in attempts.items() if value['acknowledged'] and rows.get(key)!=value['digest']]
        committed_reply_losses=[key for key,value in attempts.items() if value.get('reply_lost_after_commit')]
        lost_commit_missing=[key for key in committed_reply_losses if rows.get(key)!=attempts[key]['digest']]
        atomic_json(output/'lost-commit-replies.json',{'confirmed_backend_commit_replies_discarded':len(committed_reply_losses),'lost_commits_missing_or_corrupt':len(lost_commit_missing),'downstream_transport':'owned HTTP socketpair','upstream':'real project HTTP','automatic_retries':0})
        if not committed_reply_losses or lost_commit_missing:
            raise RuntimeError('A real lost post-COMMIT reply was not durably reconciled')
        extra=[key for key,value in rows.items() if key not in attempts or attempts[key]['digest']!=value]
        ambiguous={key:value for key,value in attempts.items() if value['ambiguous']}
        acknowledged=[key for key,value in attempts.items() if value['acknowledged']]
        if not acknowledged:
            raise RuntimeError('No positively acknowledged operation for reconciliation')
        duplicate_id=acknowledged[0]
        duplicate_status,_=raw(source,'POST',MUTATION_PATH,{'operation_id':duplicate_id,'operation_digest':attempts[duplicate_id]['digest'],'delta':attempts[duplicate_id]['delta']})
        if duplicate_status!=409:
            raise RuntimeError('Explicit operation primary key did not reject a duplicate')
        atomic_json(output/'invariants.json',{'attempted':len(attempts),'acknowledged':sum(item['acknowledged'] for item in attempts.values()),'committed':len(rows),'acknowledged_missing':len(missing),'unknown_or_corrupt':len(extra),'ambiguous_attempts':len(ambiguous),'ambiguous_committed':sum(key in rows for key in ambiguous),'automatic_mutation_retries':0,'explicit_primary_key_duplicate_status':duplicate_status,'accounting':accounting(source)})
        if missing or extra:
            raise RuntimeError('Acknowledged operation ledger did not reconcile')
        for project in initialized:
            count=project.sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (state='idle in transaction' OR wait_event_type='Lock')")
            if count!='0':
                raise RuntimeError('Transaction or lock remained after faults')
        stop.set()
        sampler.join(timeout=30)
        violations.extend(coverage.violations(time.monotonic()-observations_started))
        if sampler.is_alive() or critical.is_set() or violations:
            raise RuntimeError('Fault resource evidence failed')
        status='passed'
    except Exception:
        if phase=='preparation':
            from project_diagnostics import snapshot as project_setup_snapshot
            try:
                atomic_json(output/'preparation-failure.json', {'phase':'preparation',
                    'source':project_setup_snapshot(source), 'target':project_setup_snapshot(target)})
            except Exception:
                atomic_json(output/'preparation-failure-diagnostic-unavailable.json', {'available':False})
        raise
    finally:
        phase='teardown'
        stop.set()
        if sampler is not None:
            sampler.join(timeout=30)
        if initialized and sys.exception() is not None:
            retain_failure(output,owned,source.pg,source.sql,unsafe=critical.is_set())
        atomic_json(output/'resource-violations.json',violations)
        if sys.exception() is not None:
            atomic_json(output/'error.json',{'type':type(sys.exception()).__name__})
        cleanup(manifest)
        remaining=owned('ps','-aq','--filter','label='+LABEL+'='+identity)
        volumes=owned('volume','ls','-q','--filter','label='+LABEL+'='+identity)
        shutil.rmtree(directory)
        clean=not remaining and not volumes and not directory.exists()
        atomic_json(output/'cleanup.json',{'confirmed':clean,'containers':remaining.splitlines(),'volumes':volumes.splitlines(),'directory_removed':not directory.exists()})
        if clean:
            (output/'watchdog-disarmed').touch()
        if not clean:
            status='failed'
        heart.join(timeout=5)
        if watchdog is not None:
            watchdog.wait(timeout=20)
        signal.signal(signal.SIGTERM,previous)
        atomic_json(output/'completion.json',{'status':status,'load_seconds':load_seconds,'resource_observations':coverage.count,'cleanup_confirmed':clean,'error_type':type(sys.exception()).__name__})
        if status!='passed' and sys.exception() is None:
            raise RuntimeError('Fault final cleanup failed')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--rate',type=int,default=8)
    parser.add_argument('--capacity',action='store_true')
    parser.add_argument('--provisional-rate',type=int,default=DEFAULT_PROVISIONAL_RATE)
    parser.add_argument('--s3-faults',action='store_true')
    parser.add_argument('--focus',choices=['all','filesystem','provider','matrix'],default='all',help='A named subset is diagnostic only and cannot certify the complete fault matrix')
    parser.add_argument('--matrix-step-seconds',type=int,choices=[20,120],default=120,help='Twenty seconds is an explicit supplemental smoke; full matrix steps use120')
    args=parser.parse_args()
    if not 1<=args.rate<=64 or not 4<=args.provisional_rate<=64:
        parser.error('Functional canary rate must be 1..64 iterations/second')
    if args.s3_faults and effective_cpus(sorted(os.sched_getaffinity(0)))<4:
        parser.error('S3 fault profile requires four effective CPUs')
    if args.focus=='provider' and not args.s3_faults:
        parser.error('Provider focus requires --s3-faults')
    if args.focus=='matrix' and args.s3_faults:
        parser.error('Supplemental backend matrix is a separate disk profile, not the real-S3 fault campaign')
    run(args)


if __name__=='__main__':
    main()
