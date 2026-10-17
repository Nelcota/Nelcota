"""Native HTTP-series expiry and generator-observation control."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import urllib.request
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bench'))
from campaign import K6, docker, free_port, effective_cpus, validate_disk_headroom
from metrics import NativeMetrics, PROMETHEUS
from http_counters import closed_counts, PROTOCOL
import observations
from ownership import LABEL, OwnedDocker
from observations import generator_observation
from watchdog import atomic_json, cleanup, host_reserves, process_identity

def run(output):
    root = output.resolve()
    if root.exists():raise SystemExit('Preserve existing control evidence')
    root.mkdir(mode=0o700, parents=True)
    if host_reserves(root):raise SystemExit('Insufficient control reserves')
    cpus=sorted(os.sched_getaffinity(0))
    if effective_cpus(cpus)<.75:raise RuntimeError('Counter control needs .75 effective CPU including reserves')
    validate_disk_headroom(root,128,startup_mib=2048)
    identity='nelcota-http-control-'+secrets.token_hex(16)
    owner=OwnedDocker(identity,docker)
    telemetry,generator=identity+'-metrics',identity+'-load'
    volume=identity+'-metrics-data'
    port=free_port();began=time.monotonic()
    phase='preparation'
    resource_at=began
    manifest={'identity':identity,'output':str(root),'reserve_path':str(root),'pid':os.getpid(),'process_identity':process_identity(os.getpid()),'started_monotonic':began,'maximum_seconds':300,'preparation_seconds':90,'containers':[telemetry,generator],'volumes':[volume]}
    atomic_json(root/'ownership.json',manifest)
    stop=threading.Event()
    def heartbeat():
        while not stop.is_set():
            now=time.monotonic()
            atomic_json(root/'heartbeat.json',{'phase':phase,'monotonic':now,'resource_monotonic':resource_at})
            stop.wait(2)
    thread=threading.Thread(target=heartbeat,daemon=True);thread.start()
    watchdog=subprocess.Popen([sys.executable,str(ROOT/'bench/watchdog.py'),str(root/'ownership.json')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    passed=clean=False
    proof={'scope':'Native HTTP expiry control against an owned loopback responder; no application capacity or endurance certification','certifies_g05':False,'maximum_seconds':300,'cpu_each':.25,'memory_mib_each':128,'traffic_schedule_seconds':136,'offered_requests_per_second':2,'maximum_http_attempts':300,'minimum_counter_observation_seconds':136,'generator_stats_timeout_injection':'one intentional exception; native fallback must supply owned cgroup evidence','counter_protocol':PROTOCOL,'generator_cpu_affinity':cpus[0],'metrics_cpu_affinity':cpus[-1],'startup_disk_mib':2048,'metrics_volume_limit_mib':128,'metrics_retention_mib':16,'metrics_wal_segment_mib':16,'generator_usage_reporting':False,'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'metrics_source_sha256':hashlib.sha256((ROOT/'bench/metrics.py').read_bytes()).hexdigest(),'counter_source_sha256':hashlib.sha256((ROOT/'bench/http_counters.py').read_bytes()).hexdigest()}
    proof['resource_sample_seconds']=5
    proof['maximum_resource_gap_seconds']=30
    proof['control_source_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    atomic_json(root/'profile.json',proof)
    child=None
    server=None
    server_thread=None
    attempts=0
    negative=0
    request_lock=threading.Lock()
    def serve(handler):
        nonlocal attempts,negative
        with request_lock:
            attempts+=1
            status=200
            if attempts<=3:
                status=401;negative+=1
            if attempts>300:status=503
        handler.send_response(status);handler.send_header('Content-Length','0');handler.end_headers()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):serve(self)
        def log_message(self,*args):pass
    try:
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        server_thread=threading.Thread(target=server.serve_forever,daemon=True);server_thread.start()
        proof['http_server_loopback']=True
        server_url='http://127.0.0.1:'+str(server.server_port)

        script=root/'control.js'
        script.write_text("""import http from 'k6/http';
import {Counter} from 'k6/metrics';
const expected = new Counter('expected_rejections');
export const options = {
 scenarios:{traffic:{executor:'constant-arrival-rate',rate:2,timeUnit:'1s',duration:'136s',preAllocatedVUs:2,maxVUs:2}},
 tags:{run_id:'http-sparse',project:'single'},systemTags:['scenario','status','method','group','error_code']
};
export default function () {
 const r=http.get('"""+server_url+"""/',{timeout:'2s',tags:{workload:'security'}});
 if(r.status===401)expected.add(1);
 if(r.status!==200 && r.status!==401)throw new Error('Unexpected control outcome');
}
""")
        config=root/'prometheus.yml';config.write_text('global:\n  scrape_interval: 5s\nscrape_configs: []\n')
        script.chmod(0o444);config.chmod(0o444)
        cpus=sorted(os.sched_getaffinity(0))
        owner('volume','create','--label',LABEL+'='+identity,volume)
        common=['--network','host','--cpus','.25','--memory','128m','--memory-swap','128m','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only']
        owner('run','-d','--name',telemetry,'--label',LABEL+'='+identity,*common,'--cpuset-cpus',str(cpus[-1]),'-v',str(config)+':/etc/prometheus/prometheus.yml:ro','-v',volume+':/prometheus',PROMETHEUS,'--config.file=/etc/prometheus/prometheus.yml','--storage.tsdb.path=/prometheus','--storage.tsdb.retention.time=10m','--storage.tsdb.retention.size=16MB','--storage.tsdb.wal-segment-size=16MB','--query.lookback-delta=2s','--web.listen-address=127.0.0.1:'+str(port),'--web.enable-remote-write-receiver')
        endpoint='http://127.0.0.1:'+str(port)
        ready=False
        for _ in range(40):
            try:
                with urllib.request.urlopen(endpoint+'/-/ready',timeout=1) as response:
                    ready=response.status==200
            except OSError:
                pass
            if ready:break
            time.sleep(.25)
        if not ready:raise RuntimeError('Metrics control did not become ready')
        metrics=NativeMetrics(endpoint,retain_http_counters=True)
        metrics.begin_phase('http-sparse',['traffic'])
        observation_began=time.monotonic()
        phase='http-counter-control'
        resource_at=time.monotonic()
        command=['docker','run','--rm','--name',generator,'--label',LABEL+'='+identity,*common,'--cpuset-cpus',str(cpus[0]),'--user',str(os.getuid())+':'+str(os.getgid()),'-v',str(script)+':/control.js:ro','-e','GOMEMLIMIT=96MiB','-e','K6_NO_USAGE_REPORT=true','-e','K6_PROMETHEUS_RW_SERVER_URL='+endpoint+'/api/v1/write','-e','K6_PROMETHEUS_RW_PUSH_INTERVAL=1s',K6,'run','--quiet','--summary-mode=disabled','--no-thresholds','--out=experimental-prometheus-rw','/control.js']
        with (root/'k6.log').open('w') as target:
            child=subprocess.Popen(command,stdout=target,stderr=subprocess.STDOUT)
            context={'process':child,'name':generator,'identity':identity,'phase':phase,'started':time.monotonic()}
            positive=False
            generator_finished=None
            while True:
                cycle=time.monotonic()
                returned=child.poll()
                if returned is not None:
                    if returned!=0:raise RuntimeError('Native generator failed')
                    if generator_finished is None:generator_finished=cycle
                    # k6 can finish as soon as the arrival rate reaches zero.
                    # The observer owns the expiry interval after the final flush.
                    if cycle>=observation_began+136:break
                    phase='http-counter-final-observation'
                if cycle-began>210 or host_reserves(root) or watchdog.poll() is not None:
                    raise RuntimeError('Native control resource/duration stop')
                observed=None
                if returned is None:
                    if not proof.get('native_generator_fallback') and cycle-observation_began>10:
                        original_run=subprocess.run
                        def injected(*args,**kwargs):
                            if args[0][:2]==['docker','stats']:
                                raise subprocess.TimeoutExpired(args[0],10)
                            return original_run(*args,**kwargs)
                        with mock.patch.object(observations.subprocess,'run',side_effect=injected):
                            observed=generator_observation(context,lambda:context)
                        if observed is None or observed.get('source')!='cgroup-v2 after Docker stats timeout':raise RuntimeError('Native fallback was not exercised')
                        value=observed['component_cgroup']
                        if value['memory.current']<=0 or value['cpu.stat']['usage_usec']<=0 or value['pids.current']<=0:raise RuntimeError('Missing live native generator counters')
                        proof['native_generator_fallback']=observed
                    if 'native_generator_fallback' in proof or observed is None:
                        observed=generator_observation(context,lambda:context)
                if observed and observed.get('host_pid') and observed.get('pid_starttime'):
                    atomic_json(root/'generator-process.json',{'identity':identity,'pid':observed['host_pid'],'process_identity':observed['pid_starttime'],'container_id':observed['container_id']})
                metrics_disk=int(owner('exec',telemetry,'du','-sm','/prometheus').split()[0])
                if metrics_disk>128:raise RuntimeError('Native counter metrics volume exceeded its 128 MiB limit')
                evidence=metrics.observe_arrivals('http-sparse')
                resource_at=time.monotonic()
                atomic_json(root/'progress.json',evidence)
                if not positive and evidence['http_counters']['scenarios']['traffic']['expected_rejections']>0:
                    atomic_json(root/'early-positive-metrics.json',metrics.snapshot('http-sparse'))
                    positive=True
                time.sleep(max(0,5-(time.monotonic()-cycle)))
            if child.returncode!=0:raise RuntimeError('Native generator failed')
        evidence=metrics.finish_phase('http-sparse')
        http_evidence=metrics.http_counters['http-sparse'].snapshot()
        retained=closed_counts(http_evidence,'http-sparse','traffic',136)
        metric='k6_expected_rejections_total{run_id="http-sparse",scenario="traffic"}'
        instant=metrics.value('sum('+metric+')',True)
        expired_range=metrics.value('sum(last_over_time('+metric+'[120s]))',True)
        http_instant=metrics.value('sum(k6_http_reqs_total{run_id="http-sparse",scenario="traffic"})',True)
        http_range=metrics.value('sum(last_over_time(k6_http_reqs_total{run_id="http-sparse",scenario="traffic"}[120s]))',True)
        http_401_instant=metrics.value('sum(k6_http_reqs_total{run_id="http-sparse",scenario="traffic",status="401"})',True)
        http_401_range=metrics.value('sum(last_over_time(k6_http_reqs_total{run_id="http-sparse",scenario="traffic",status="401"}[120s]))',True)
        proof.update(retained_http=retained,server_attempts=attempts,server_expected_rejections=negative,end_instant_expected_rejections=instant,end_120s_expected_rejections=expired_range,end_instant_http_attempts=http_instant,end_120s_http_attempts=http_range,end_instant_http_401=http_401_instant,end_120s_http_401=http_401_range,closed_http_evidence=http_evidence,final_sample_scope='The 2s instant lookback may also expire the final 200 series after generator exit. The 120s range must preserve every 200 and exclude all initial 401 attempts.')
        atomic_json(root/'final-metrics-raw.json',metrics.snapshot('http-sparse'))
        atomic_json(root/'native-http.json',proof)
        if not positive or negative!=3 or retained['expected_rejections']!=negative or retained['http_reqs']!=attempts or instant!=0 or expired_range!=0 or not 0<=http_instant<=attempts-negative or http_range!=attempts-negative or http_401_instant!=0 or http_401_range!=0 or not proof.get('native_generator_fallback'):
            raise RuntimeError('Actual sparse HTTP expiry, server accounting or native fallback disagreed')
        for path,key in [(ROOT/'bench/metrics.py','metrics_source_sha256'),(ROOT/'bench/http_counters.py','counter_source_sha256'),(Path(__file__),'control_source_sha256')]:
            if hashlib.sha256(path.read_bytes()).hexdigest()!=proof[key]:raise RuntimeError('Counter implementation changed during native control')
        proof.update(status='passed',retained_http=retained,server_attempts=attempts,server_expected_rejections=negative,end_instant_expected_rejections=instant,end_120s_expected_rejections=expired_range,end_instant_http_attempts=http_instant,end_120s_http_attempts=http_range,closed_http_evidence=http_evidence,early_positive_snapshot_sha256=hashlib.sha256((root/'early-positive-metrics.json').read_bytes()).hexdigest(),control_js_sha256=hashlib.sha256(script.read_bytes()).hexdigest(),k6_image=K6,prometheus_image=PROMETHEUS,elapsed_seconds=time.monotonic()-began)
        passed=True
    finally:
        original_error=sys.exception()
        if server is not None:
            server.shutdown();server.server_close()
        if server_thread is not None:server_thread.join(timeout=5)
        phase='teardown'
        cleanup_errors=[]
        if child is not None and child.poll() is None:
            try:
                cleanup(manifest)
                if child.poll() is None:child.terminate()
                child.wait(timeout=20)
            except Exception as error:
                cleanup_errors.append(type(error).__name__)
                if child.poll() is None:
                    child.kill()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        cleanup_errors.append('DriverKillTimeout')
        try:
            cleanup(manifest)
            clean=not owner('ps','-aq','--filter','label='+LABEL+'='+identity) and not owner('volume','ls','-q','--filter','label='+LABEL+'='+identity)
        except Exception as error:
            cleanup_errors.append(type(error).__name__)
            clean=False
        stop.set();thread.join(timeout=5)
        if thread.is_alive():cleanup_errors.append('HeartbeatThreadDidNotExit')
        if clean:
            (root/'watchdog-disarmed').touch()
            try:
                watchdog.wait(timeout=15)
            except subprocess.TimeoutExpired:
                cleanup_errors.append('WatchdogExitTimeout')
        # Uncertain cleanup leaves the independent guardian armed. Waiting for
        # its future deadline here would replace the original probe failure.
        proof.update(cleanup_confirmed=clean)
        status='failed'
        if passed and clean and not cleanup_errors:status='passed'
        proof['status']=status
        if original_error is not None:proof['error_type']=type(original_error).__name__
        if cleanup_errors:proof['cleanup_errors']=cleanup_errors
        atomic_json(root/'native-http.json',proof)
        atomic_json(root/'completion.json',{'status':status,'cleanup_confirmed':clean})
    if status!='passed':raise RuntimeError('Native HTTP-counter control failed')
    print(json.dumps(proof))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    run(parser.parse_args().output)
