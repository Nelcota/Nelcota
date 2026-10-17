"""Force real TSDB head snapshots inside the unchanged metrics disk budget."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.request
from campaign import docker,free_port,effective_cpus,validate_disk_headroom,owns_listener
from metrics import NativeMetrics,PROMETHEUS,STORAGE_PROFILE,storage_arguments
from campaign import K6
from ownership import OwnedDocker,LABEL
from disk_usage import container as container_disk_usage
from host_resources import owned_cgroup_snapshot,require_no_oom
from watchdog import atomic_json,cleanup,host_reserves,process_identity
ROOT=Path(__file__).resolve().parents[1]


def run(output):
    root=output.resolve()
    if root.exists():raise RuntimeError('Preserve previous compaction evidence')
    root.mkdir(mode=0o700,parents=True)
    if host_reserves(root):raise RuntimeError('Insufficient compaction control reserves')
    cpus=sorted(os.sched_getaffinity(0))
    if effective_cpus(cpus)<.75:raise RuntimeError('Compaction control needs .75 effective CPU including reserves')
    validate_disk_headroom(root,512,startup_mib=2048)
    identity='nelcota-tsdb-control-'+secrets.token_hex(16)
    telemetry,generator=identity+'-metrics',identity+'-load';volume=identity+'-data'
    owner=OwnedDocker(identity,docker);began=time.monotonic();resource_at=began
    stop=threading.Event();failures=[];phase='preparation';samples=[]
    manifest={'identity':identity,'output':str(root),'reserve_path':str(root),'pid':os.getpid(),'process_identity':process_identity(os.getpid()),'started_monotonic':began,'maximum_seconds':180,'preparation_seconds':90,'containers':[telemetry,generator],'volumes':[volume]}
    atomic_json(root/'ownership.json',manifest)
    def heartbeat():
        while not stop.is_set():
            atomic_json(root/'heartbeat.json',{'phase':phase,'monotonic':time.monotonic(),'resource_monotonic':resource_at})
            stop.wait(1)
    heart=threading.Thread(target=heartbeat,daemon=True);heart.start()
    watchdog=subprocess.Popen([sys.executable,str(ROOT/'bench/watchdog.py'),str(root/'ownership.json')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    proof={'scope':__doc__+' Synthetic counter traffic; no BaaS capacity or endurance credit. Admin snapshot API is enabled only on this owned loopback control.','certifies_g05':False,'storage_profile':STORAGE_PROFILE.copy(),'receiver_cpus':.25,'receiver_memory_mib':256,'generator_cpus':.25,'generator_memory_mib':128,'maximum_seconds':180,'maximum_synthetic_series':1000,'synthetic_counter_total':2000,'snapshots_requested':4,'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'metrics_source_sha256':hashlib.sha256((ROOT/'bench/metrics.py').read_bytes()).hexdigest(),'control_source_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    atomic_json(root/'profile.json',proof)
    sampler=None;child=None;passed=False;clean=False
    try:
        config=root/'prometheus.yml';config.write_text('global:\n  scrape_interval: 5s\nscrape_configs: []\n');config.chmod(0o444)
        port=free_port();endpoint='http://127.0.0.1:'+str(port)
        owner('volume','create','--label',LABEL+'='+identity,volume)
        owner('run','-d','--name',telemetry,'--label',LABEL+'='+identity,'--network','host','--cpus','.25','--cpuset-cpus',str(cpus[-1]),'--memory','256m','--memory-swap','256m','--pids-limit','64','--user','65534:65534','--cap-drop','ALL','--read-only','--security-opt','no-new-privileges','-v',str(config)+':/etc/prometheus/prometheus.yml:ro','-v',volume+':/prometheus',PROMETHEUS,'--config.file=/etc/prometheus/prometheus.yml','--web.listen-address=127.0.0.1:'+str(port),'--web.enable-remote-write-receiver','--web.enable-admin-api',*storage_arguments())
        ready=False
        for _ in range(100):
            try:
                if not owns_listener(owner.require(telemetry),port):
                    time.sleep(.1)
                    continue
                with urllib.request.urlopen(endpoint+'/-/ready',timeout=1) as response:ready=response.status==200
            except OSError:pass
            if ready:break
            time.sleep(.1)
        if not ready:raise RuntimeError('Compaction receiver readiness failed')
        with urllib.request.urlopen(endpoint+'/api/v1/status/flags',timeout=5) as response:flags=json.load(response)
        configured=flags.get('data',{}).get('storage.tsdb.max-block-chunk-segment-size')
        if flags.get('status')!='success' or configured not in ('16777216','16MB','16MiB'):raise RuntimeError('Actual receiver lacks the 16-MiB block segment limit')
        if flags['data'].get('storage.tsdb.path')!='/prometheus':raise RuntimeError('Actual receiver data path escaped its owned fixture')
        proof['effective_block_chunk_segment_flag']=configured
        phase='synthetic-compaction-control';resource_at=time.monotonic()
        def observe():
            nonlocal resource_at
            while not stop.is_set():
                try:
                    if host_reserves(root) or watchdog.poll() is not None or time.monotonic()-began>150:raise RuntimeError('Compaction resource/duration guard')
                    disk=container_disk_usage(owner,telemetry,'/prometheus')
                    resource_at=time.monotonic();samples.append({'elapsed_seconds':resource_at-began,'disk_mib':disk['value']})
                    if disk['value']>STORAGE_PROFILE['monitored_disk_limit_mib']:raise RuntimeError('Compaction exceeded the unchanged 512-MiB disk bound')
                except Exception as error:
                    failures.append(type(error).__name__)
                    # The independent watchdog also remains armed until final
                    # cleanup. Remove only this control's owned resources.
                    cleanup(manifest)
                    return
                stop.wait(.2)
        sampler=threading.Thread(target=observe,daemon=True);sampler.start()
        script=root/'control.js';script.write_text("""import {Counter} from 'k6/metrics';
const counter=new Counter('compaction_probe');
export const options={scenarios:{traffic:{executor:'per-vu-iterations',vus:1,iterations:2,maxDuration:'10s'}},tags:{run_id:'tsdb-compaction'},systemTags:[]};
export default function(){for(let i=0;i<1000;i++)counter.add(1,{series:String(i)});}
""");script.chmod(0o444)
        command=['docker','run','--rm','--name',generator,'--label',LABEL+'='+identity,'--network','host','--cpus','.25','--cpuset-cpus',str(cpus[0]),'--memory','128m','--memory-swap','128m','--pids-limit','64','--user',str(os.getuid())+':'+str(os.getgid()),'--cap-drop','ALL','--read-only','--security-opt','no-new-privileges','-v',str(script)+':/control.js:ro','-e','GOMEMLIMIT=96MiB','-e','K6_NO_USAGE_REPORT=true','-e','K6_PROMETHEUS_RW_SERVER_URL='+endpoint+'/api/v1/write','-e','K6_PROMETHEUS_RW_PUSH_INTERVAL=1s',K6,'run','--quiet','--summary-mode=disabled','--no-thresholds','--out=experimental-prometheus-rw','/control.js']
        with (root/'k6.log').open('w') as target:
            child=subprocess.Popen(command,stdout=target,stderr=subprocess.STDOUT)
            if child.wait(timeout=30)!=0:raise RuntimeError('Compaction synthetic generator failed')
        reader=NativeMetrics(endpoint)
        total=reader.value('sum(k6_compaction_probe_total{run_id="tsdb-compaction"})')
        if total!=2000:raise RuntimeError('Native counter evidence disagreed before compaction')
        snapshots=[]
        for _ in range(4):
            if failures:raise RuntimeError('Compaction resource sampler failed')
            if not owns_listener(owner.require(telemetry),port):raise RuntimeError('Compaction listener ownership changed')
            request=urllib.request.Request(endpoint+'/api/v1/admin/tsdb/snapshot',method='POST',data=b'')
            with urllib.request.urlopen(request,timeout=20) as response:
                body=response.read(4097)
            if len(body)>4096:raise RuntimeError('Snapshot receipt exceeded byte budget')
            receipt=json.loads(body);name=receipt.get('data',{}).get('name')
            if receipt.get('status')!='success' or not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}',name):raise RuntimeError('Invalid owned snapshot receipt')
            raw=owner('exec',telemetry,'sh','-c','for file in /prometheus/snapshots/"$1"/*/meta.json; do cat "$file"; done','sh',name)
            if len(raw)>65536:raise RuntimeError('Snapshot metadata byte budget exceeded')
            block=json.loads(raw);stats=block.get('stats',{})
            if any(type(stats.get(key)) is not int or stats[key]<1000 for key in ['numSamples','numSeries','numChunks']):raise RuntimeError('Actual compacted block lacks the synthetic series')
            snapshots.append({key:stats[key] for key in ['numSamples','numSeries','numChunks']})
            cgroup=owned_cgroup_snapshot(owner,telemetry,shell_builtins=True);require_no_oom(cgroup['memory.events'])
            time.sleep(.3)
        if failures or reader.value('sum(k6_compaction_probe_total{run_id="tsdb-compaction"})')!=2000:raise RuntimeError('Counter or resource evidence changed during compaction')
        if len(samples)<5:raise RuntimeError('Missing continuous compaction disk observations')
        for path,key in [(ROOT/'bench/metrics.py','metrics_source_sha256'),(Path(__file__),'control_source_sha256')]:
            if hashlib.sha256(path.read_bytes()).hexdigest()!=proof[key]:raise RuntimeError('Compaction control source changed')
        proof.update(native_counter_total=total,snapshots=snapshots,disk_observations=samples,maximum_observed_disk_mib=max(row['disk_mib'] for row in samples),elapsed_seconds=time.monotonic()-began)
        passed=True
    finally:
        original_error=sys.exception();phase='teardown';stop.set()
        if sampler is not None:sampler.join(timeout=10)
        if child is not None and child.poll() is None:
            child.terminate();child.wait(timeout=10)
        cleanup(manifest)
        clean=not owner('ps','-aq','--filter','label='+LABEL+'='+identity) and not owner('volume','ls','-q','--filter','label='+LABEL+'='+identity)
        heart.join(timeout=5)
        if clean:(root/'watchdog-disarmed').touch()
        watchdog.wait(timeout=15)
        status='failed'
        if passed and clean and not failures:status='passed'
        proof.update(status=status,cleanup_confirmed=clean,resource_errors=failures)
        if original_error is not None:proof['error_type']=type(original_error).__name__
        proof['disk_observations']=samples
        if samples:proof['maximum_observed_disk_mib']=max(row['disk_mib'] for row in samples)
        atomic_json(root/'native-compaction.json',proof);atomic_json(root/'completion.json',{'status':status,'cleanup_confirmed':clean})
    if status!='passed':raise RuntimeError('Native compaction control failed')
    print(json.dumps(proof))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    run(parser.parse_args().output)
