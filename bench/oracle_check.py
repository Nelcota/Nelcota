"""Native k6 regression for the byte oracle; this is not product load evidence."""
import argparse
from http.server import BaseHTTPRequestHandler,HTTPServer
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
import urllib.parse

from campaign import K6,docker
from ownership import OwnedDocker
from watchdog import LABEL,atomic_json,cleanup,host_reserves,process_identity


class Fixture(HTTPServer):
    def get_request(self):
        connection,address=super().get_request()
        connection.settimeout(1)
        return connection,address


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass

    def respond(self,status,body):
        time.sleep(.005)  # One worker, at most 200 fixture responses/second.
        self.server.counts[str(status)]=self.server.counts.get(str(status),0)+1
        self.send_response(status)
        size=len(body)
        if self.server.mode=='truncated' and self.command=='GET' and status==200:size=19
        self.send_header('Content-Length',str(size))
        self.send_header('Connection','close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection=True

    def product(self,identity,text=False):
        value={'id':identity,'name':'product '+str(identity),'stock':identity%50,'price':float(str(identity%500)+'.99'),'created_at':'2026-10-15T00:00:00Z'}
        if text:value={key:str(item) for key,item in value.items()}
        return value

    def listing(self):
        return {'folders':[],'objects':[{'id':str(uuid.uuid4()),'name':str(index).zfill(8)+'.txt','size':0,'etag':hashlib.sha256(b'').hexdigest()} for index in range(1,21)]}

    def do_GET(self):
        if self.server.mode=='redirect-latency' and self.path=='/storage/v1/object/public/bench/fixture.txt':
            self.server.redirects+=1
            time.sleep(.25)
            self.server.counts['302']=self.server.counts.get('302',0)+1
            self.send_response(302)
            self.send_header('Location','/latency-control-final')
            self.send_header('Content-Length','0')
            self.end_headers()
            self.close_connection=True
            return
        if self.server.mode=='redirect-latency' and self.path=='/latency-control-final':
            self.server.reads+=1
            self.server.operations['storage']+=1
            self.respond(200,b'"benchmark payload"')
            return
        if self.path.startswith('/rest/v1/bench_private'):
            if self.headers.get('Authorization')=='Bearer '+self.server.fixture['invalid_access']:
                self.respond(401,b'{}')
                return
            self.server.operations['rls']+=1
            rows=[{'id':index*2,'user_id':self.server.fixture['user'],'body':'x'*128} for index in range(1,21)]
            if self.server.mode=='empty-rls':rows=[]
            self.respond(200,json.dumps(rows).encode())
            return
        if self.path.startswith('/rest/v1/bench_products'):
            self.server.runtime_started=True
            self.server.operations['read']+=1
            stock=int(urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)['stock'][0].removeprefix('eq.'))
            first=stock
            if first==0:first=50
            rows=[self.product(first+index*50) for index in range(20)]
            if self.server.mode=='empty-read':rows=[]
            if self.server.mode=='wrong-read-filter':rows[0]['stock']=(stock+1)%50
            if self.server.mode=='wrong-read-order':rows.reverse()
            if self.server.mode=='malformed-read':
                self.respond(200,b'not JSON')
                return
            if self.server.mode=='unexpected-read-status':
                self.respond(204,b'')
                return
            self.respond(200,json.dumps(rows).encode())
            return
        if self.path.startswith('/admin/api/tables/bench_products'):
            self.server.operations['panel']+=1
            size=int(urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('size',['50'])[0])
            value={'table':{'name':'bench_products'},'rows':[self.product(index,True) for index in range(1,size+1)],'size':size,'page':0,'has_next':True}
            if self.server.mode=='bad-panel':value={}
            self.respond(200,json.dumps(value).encode())
            return
        if self.path!='/storage/v1/object/public/bench/fixture.txt':
            self.respond(404,b'{}')
            return
        self.server.reads+=1
        self.server.operations['storage']+=1
        body=b'"benchmark payload"'
        if self.server.mode=='corrupt':body=b'!'*len(body)
        if self.server.mode=='truncated':body=body[:10]
        self.respond(200,body)

    def write_request(self):
        size=int(self.headers.get('Content-Length','0'))
        if not 0<=size<=1024:
            self.respond(413,b'{}')
            return
        body=self.rfile.read(size)
        if self.path.startswith('/auth/v1/token'):
            value=json.loads(body)
            if 'grant_type=password' in self.path:
                if value.get('email')!=self.server.fixture['email'] or value.get('password')!=self.server.fixture['password']:
                    self.respond(401,b'{}')
                    return
                if not self.server.runtime_started:
                    self.server.bootstrap_logins+=1
                if self.server.runtime_started:self.server.operations['login']+=1
            if 'grant_type=refresh_token' in self.path:self.server.operations['refresh']+=1
            session={'access_token':secrets.token_urlsafe(32),'refresh_token':secrets.token_urlsafe(32),'expires_in':3600,'user':{'id':self.server.fixture['user']}}
            if self.server.runtime_started and self.server.mode=='wrong-login-user' and 'grant_type=password' in self.path:session['user']['id']=str(uuid.uuid4())
            if self.server.mode=='invalid-refresh-expiry' and 'grant_type=refresh_token' in self.path:session['expires_in']=1e308
            self.respond(200,json.dumps(session).encode())
            return
        self.server.runtime_started=True
        self.server.operations['storage']+=1
        if self.path.startswith('/storage/v1/object/list/bench'):
            value=self.listing()
            if self.server.mode=='empty-list':value['objects']=[]
            self.respond(200,json.dumps(value).encode())
            return
        name=urllib.parse.urlsplit(self.path).path.rsplit('/',1)[-1]
        status=201
        if name in self.server.uploaded:status=200
        self.server.uploaded.add(name)
        value={'id':str(uuid.uuid4()),'bucket':'bench','name':name,'size':len(body),'etag':hashlib.sha256(body).hexdigest()}
        if self.server.mode=='bad-upload':value['etag']='0'*64
        self.respond(status,json.dumps(value).encode())

    do_POST=write_request
    do_PUT=write_request

    def do_PATCH(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        self.server.operations['write']+=1
        if self.server.mode=='empty-write':
            self.respond(200,b'[]')
            return
        if self.headers.get('Prefer')=='return=representation':
            identity=int(urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)['id'][0].removeprefix('eq.'))
            value=self.product(identity);value['name']=body['name']
            self.respond(200,json.dumps([value]).encode())
            return
        self.respond(204,b'')


SEMANTIC_CASES=['empty-read','wrong-read-filter','wrong-read-order','malformed-read','unexpected-read-status','empty-rls','bad-panel','empty-list','bad-upload','wrong-login-user','invalid-refresh-expiry','empty-write']


def run(output,baseline=None,semantic_baseline=None,latency_baseline=None):
    output=output.resolve()
    if output.exists() and any(output.iterdir()):raise ValueError('Preserve previous evidence')
    output.mkdir(parents=True,exist_ok=True)
    sources=[Path(__file__).with_name('campaign.js')]
    if baseline is not None:sources.append(baseline)
    if semantic_baseline is not None:sources.append(semantic_baseline)
    if latency_baseline is not None:sources.append(latency_baseline)
    for source in sources:
        if not source.is_file() or not 0<source.stat().st_size<=128*1024:
            raise ValueError('Oracle script must be a bounded local JavaScript file')
    if host_reserves(output):raise RuntimeError('Host reserves do not allow the oracle check')
    identity='nelcota-oracle-'+secrets.token_hex(16)
    owned=OwnedDocker(identity,docker)
    cases=[('candidate-valid','valid',0,'storage','storage'),('candidate-corrupt','corrupt',108,'storage','storage'),('candidate-truncated','truncated',108,'storage','storage'),('candidate-mixed','mixed',0,'mixed','read')]
    cases.append(('candidate-redirect-latency','redirect-latency',0,'storage','storage'))
    if latency_baseline is not None:cases.append(('baseline-redirect-latency','redirect-latency',0,'storage','storage'))
    target={'empty-read':'read','wrong-read-filter':'read','wrong-read-order':'read','malformed-read':'read','unexpected-read-status':'read','empty-rls':'rls','bad-panel':'panel','empty-list':'storage','bad-upload':'storage','wrong-login-user':'login','invalid-refresh-expiry':'refresh','empty-write':'write'}
    for mode in SEMANTIC_CASES:
        workload='mixed'
        if mode in ('empty-list','bad-upload'):workload='storage'
        cases.append(('candidate-'+mode,mode,108,workload,target[mode]))
    if baseline is not None:cases.append(('baseline-corrupt','corrupt',0,'storage','storage'))
    if semantic_baseline is not None:
        for mode in SEMANTIC_CASES:
            expected=0
            if mode=='empty-rls':expected=108
            workload='mixed'
            if mode in ('empty-list','bad-upload'):workload='storage'
            cases.append(('baseline-semantic-'+mode,mode,expected,workload,target[mode]))
    began=time.monotonic()
    observed=began
    phase='preparation'
    stop=threading.Event()
    manifest={'identity':identity,'output':str(output),'reserve_path':str(output),'pid':os.getpid(),'process_identity':process_identity(os.getpid()),'started_monotonic':began,'maximum_seconds':180,'preparation_seconds':180,'containers':[identity+'-'+item[0] for item in cases],'volumes':[]}
    atomic_json(output/'ownership.json',manifest)
    def heart():
        while not stop.is_set():
            atomic_json(output/'heartbeat.json',{'phase':phase,'monotonic':time.monotonic(),'resource_monotonic':observed})
            stop.wait(1)
    heartbeat=threading.Thread(target=heart,daemon=True)
    heartbeat.start()
    watchdog=subprocess.Popen([sys.executable,str(Path(__file__).with_name('watchdog.py')),str(output/'ownership.json')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    server=Fixture(('127.0.0.1',0),Handler)
    server.mode='valid';server.reads=0;server.counts={}
    thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.05},daemon=True)
    thread.start()
    reports=[]
    passed=False
    try:
        current=output/'candidate.js'
        shutil.copyfile(Path(__file__).with_name('campaign.js'),current)
        def with_timing_summary(path):
            with path.open('a') as target:
                target.write('\nexport function handleSummary(data) { return {stdout:"\\nNELCOTA_ORACLE_TIMING:"+JSON.stringify(data.metrics.latency_storage.values)+"\\n"}; }\n')
        with_timing_summary(current)
        fixture={'base':'http://127.0.0.1:'+str(server.server_port),'object_bytes':17,'service':secrets.token_urlsafe(32),'invalid_access':secrets.token_urlsafe(32),'user':str(uuid.uuid4()),'email':'oracle@example.test','password':secrets.token_urlsafe(32),'cookie':'fixture='+secrets.token_urlsafe(32)}
        server.fixture=fixture
        for label,mode,expected,workload,target_operation in cases:
            phase='preparation'
            source=current
            if label=='baseline-corrupt':
                source=output/'baseline.js'
                shutil.copyfile(baseline,source)
            if label.startswith('baseline-semantic-'):
                source=output/'semantic-baseline.js'
                shutil.copyfile(semantic_baseline,source)
            if label=='baseline-redirect-latency':
                source=output/'latency-baseline.js'
                shutil.copyfile(latency_baseline,source)
                with_timing_summary(source)
            server.mode=mode;server.reads=0;server.counts={}
            server.redirects=0
            server.bootstrap_logins=0;server.runtime_started=False
            server.uploaded=set()
            server.operations={key:0 for key in ['read','rls','panel','storage','login','refresh','write']}
            name=identity+'-'+label
            summary=['--summary-mode=disabled']
            if mode=='redirect-latency':summary=[]
            owned('run','-d','--name',name,'--label',LABEL+'='+identity,'--network','host','--cpus','.25','--cpuset-cpus',str(sorted(os.sched_getaffinity(0))[-1]),'--memory','128m','--memory-swap','128m','--pids-limit','64','--user',str(os.getuid())+':'+str(os.getgid()),'-v',str(source)+':/campaign.js:ro','-e','K6_NO_USAGE_REPORT=true','-e','FIXTURE','-e','WORKLOAD='+workload,'-e','DURATION=2s','-e','VUS=1',K6,'run','--quiet',*summary,'--no-thresholds','/campaign.js',env={'FIXTURE':json.dumps(fixture)})
            deadline=time.monotonic()+15
            phase='oracle'
            while True:
                state=json.loads(owned('inspect',name))[0]['State']
                observed=time.monotonic()
                if not state['Running']:break
                if time.monotonic()>deadline or watchdog.poll() is not None or host_reserves(output):raise RuntimeError('Oracle safety deadline or reserve breach')
                time.sleep(.1)
            logs=owned('logs','--tail','50',name,include_stderr=True)
            (output/(label+'.log')).write_text(logs)
            result={'case':label,'mode':mode,'expected_exit_code':expected,'actual_exit_code':state['ExitCode'],'positive_object_reads':server.reads,'responses':dict(server.counts),'oom_killed':state['OOMKilled'],'script_sha256':hashlib.sha256(source.read_bytes()).hexdigest()}
            result['operations']=dict(server.operations)
            result['passed']=state['ExitCode']==expected and server.operations[target_operation]>0 and not state['OOMKilled']
            if mode=='redirect-latency':
                summaries=[line.removeprefix('NELCOTA_ORACLE_TIMING:') for line in logs.splitlines() if line.startswith('NELCOTA_ORACLE_TIMING:')]
                if len(summaries)!=1:raise RuntimeError('Missing bounded redirect timing summary')
                values=json.loads(summaries[0])
                p95=values.get('p(95)')
                if isinstance(p95,bool) or not isinstance(p95,(int,float)) or not 0<p95<15000:raise RuntimeError('Invalid redirect timing evidence')
                result.update(storage_p95_ms=p95,redirect_delay_ms=250,redirects=server.redirects)
                result['passed']=result['passed'] and server.redirects>=3 and p95>=250
                if label=='baseline-redirect-latency':result['passed']=state['ExitCode']==0 and not state['OOMKilled'] and server.redirects>=3 and p95<125
            if mode in ('valid','corrupt','truncated'):result['passed']=result['passed'] and server.reads>0
            if mode=='mixed':
                result['operations']=dict(server.operations)
                result['bootstrap_logins']=server.bootstrap_logins
                iterations=sum(server.operations.values())
                shares={'read':.5,'rls':.2,'panel':.1,'storage':.05,'login':.05,'refresh':.05,'write':.05}
                prefix_bounds={'read':5,'rls':3,'panel':2,'storage':1,'login':1,'refresh':1,'write':1}
                result['mix_preserved']=all(abs(server.operations[key]-iterations*share)<=prefix_bounds[key] for key,share in shares.items())
                result['passed']=state['ExitCode']==0 and server.bootstrap_logins==1 and all(server.operations.values()) and result['mix_preserved'] and not state['OOMKilled']
            reports.append(result)
            atomic_json(output/'oracle-results.json',{'scope':'native k6 oracle regression against a controlled HTTP fixture; no product or endurance certification','cases':reports})
            if not result['passed']:raise RuntimeError('Native response-oracle control failed: '+label)
        passed=True
    finally:
        cleanup(manifest)
        server.shutdown();server.server_close();thread.join(timeout=5)
        clean=not owned('ps','-aq','--filter','label='+LABEL+'='+identity) and not thread.is_alive()
        atomic_json(output/'cleanup.json',{'confirmed':clean})
        if clean:(output/'watchdog-disarmed').touch()
        stop.set();heartbeat.join(timeout=3);watchdog.wait(timeout=15)
        atomic_json(output/'completion.json',{'status':'failed','certifies_g05':False,'scope':'oracle regression only','cleanup_confirmed':clean})
        if passed and clean:atomic_json(output/'completion.json',{'status':'passed','certifies_g05':False,'scope':'oracle regression only','cleanup_confirmed':True})
    if not clean:raise RuntimeError('Native oracle fixture cleanup failed')
    return reports


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--baseline-script',type=Path)
    parser.add_argument('--semantic-baseline-script',type=Path)
    parser.add_argument('--latency-baseline-script',type=Path)
    args=parser.parse_args()
    print(json.dumps(run(args.output,args.baseline_script,args.semantic_baseline_script,args.latency_baseline_script),indent=2))
