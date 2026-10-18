"""Owned, bounded P12 Docker entrypoint/restart-policy acceptance (no load)."""
import argparse,datetime,hashlib,json,os,secrets,shutil,socket,subprocess,time,urllib.request
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--binary',required=True,type=Path);p.add_argument('--output',required=True,type=Path);p.add_argument('--allow-disposable-daemon-restart',action='store_true')
a=p.parse_args();binary=a.binary.resolve(strict=True);output=a.output.resolve();output.mkdir(mode=0o700)
if a.allow_disposable_daemon_restart:
 assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
 assert not subprocess.check_output(['docker','ps','-aq']).strip(), 'Never restart a shared/nonempty Docker host'
start=time.monotonic();manifest={'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'binary_sha256':hashlib.file_digest(binary.open('rb'),'sha256').hexdigest(),'scope':('P12 owned disposable GitHub runner Docker daemon restart; no host reboot claim' if a.allow_disposable_daemon_restart else 'P12 owned Docker fixtures; process/container restart only, no daemon/host reboot claim'),'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cases':[]}
manifest['production_source_commit']=json.loads(Path('target/p12-fixes-input/manifest.json').read_text())['source_commit']
log=(output/'commands.private.log').open('xb');(output/'commands.private.log').chmod(0o600)
def run(args,*,check=True,timeout=120,cwd=None,cleanup=False):
 if not cleanup and time.monotonic()-start>600:raise TimeoutError('P12 Docker probe duration ceiling')
 if not cleanup and shutil.disk_usage(output).free<5*1024**3:raise RuntimeError('P12 disk reserve ceiling')
 r=subprocess.run([str(x) for x in args],capture_output=True,cwd=cwd,timeout=timeout)
 if len(r.stdout)+len(r.stderr)>1024**2:raise RuntimeError('P12 private output ceiling')
 log.write(r.stdout+r.stderr);log.flush()
 if check and r.returncode:raise RuntimeError('P12 command failed: '+Path(str(args[0])).name+' exit '+str(r.returncode))
 return r

def wait(test,seconds=40):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  if test():return
  time.sleep(.25)
 raise TimeoutError('P12 fixture did not reach required state')

def health(url):
 try:
  with urllib.request.urlopen(url,timeout=1) as r:return r.status==200
 except Exception:return False

image='nelcota-p12-probe:'+secrets.token_hex(5);ctx=output/'image';ctx.mkdir();shutil.copyfile(binary,ctx/'nelcota')
(ctx/'Dockerfile').write_text('FROM debian:trixie-slim\nCOPY --chmod=0555 nelcota /usr/local/bin/nelcota\nUSER 65532:65532\nENTRYPOINT ["/usr/local/bin/nelcota"]\nCMD ["serve"]\n')
try:
 run(['docker','build','--tag',image,ctx],timeout=180)
 for policy in ['unless-stopped','always']:
  name='p12-'+secrets.token_hex(4);root=output/name;project=root/'projects'/name;project.mkdir(parents=True)
  key=run([binary,'keygen']).stdout.decode().strip();password=secrets.token_hex(20)
  (root/'nelcota-host.json').write_text(json.dumps({'version':1,'panel_login':'per-project','base_domain':None,'local':True,'runtime':'docker','image':image,'projects':[{'name':name,'domain':name+'.localhost'}]}))
  (project/'.env').write_text('NELCOTA_DATABASE_URL=postgres://postgres:'+password+'@postgres:5432/postgres\nNELCOTA_AUTHENTICATOR_PASSWORD='+secrets.token_hex(20)+'\nNELCOTA_JWT_PRIVATE_KEY='+key+'\nNELCOTA_JWT_ISSUER=https://p12.invalid\nNELCOTA_LISTEN=0.0.0.0:8000\nNELCOTA_DB_POOL_SIZE=2\nNELCOTA_STORAGE_BACKEND=disk\nNELCOTA_STORAGE_DIR=/storage\n')
  (project/'.env').chmod(0o600);(project/'pgbackrest.env').write_text('# P12 inert marker control; no credentials\n');(project/'pgbackrest.env').chmod(0o600)
  adapter=project/'pgbackrest';adapter.write_text('#!/bin/sh\nset -eu\nif [ "$*" != "--stanza=main --delta restore" ]; then exit 74; fi\nprintf \'%s\\n\' \'p12 owned inert marker\' > /var/lib/postgresql/data/p12-marker\nexit 72\n');adapter.chmod(0o755)
  with socket.socket() as port_probe:
   port_probe.bind(('127.0.0.1',0));fixed_port=port_probe.getsockname()[1]
  config={'name':name,'services':{'postgres':{'image':'postgres:17-alpine','restart':policy,'cpus':.5,'mem_limit':'256m','memswap_limit':'256m','pids_limit':128,'environment':{'POSTGRES_PASSWORD':password},'command':['postgres','-c','shared_preload_libraries=pg_stat_statements','-c','shared_buffers=16MB','-c','max_connections=32'],'volumes':['data:/var/lib/postgresql/data',str(adapter)+':/usr/local/bin/pgbackrest:ro'],'healthcheck':{'test':['CMD-SHELL','pg_isready -U postgres -h 127.0.0.1'],'interval':'1s','timeout':'1s','retries':30}},'app':{'image':image,'restart':policy,'cpus':.25,'mem_limit':'128m','memswap_limit':'128m','pids_limit':64,'env_file':'.env','ports':['127.0.0.1:'+str(fixed_port)+':8000'],'tmpfs':['/storage:rw,uid=65532,gid=65532,mode=0700,size=8m'],'depends_on':{'postgres':{'condition':'service_healthy'}}}},'volumes':{'data':{}}}
  original=json.dumps(config,indent=2).encode();(project/'docker-compose.yml').write_bytes(original)
  compose=['docker','compose','--project-directory',str(project),'-f',str(project/'docker-compose.yml')]
  case={'policy':policy,'status':'running','cleanup_confirmed':False};manifest['cases'].append(case)
  try:
   run([*compose,'up','-d'],timeout=120)
   def ids():return {n:run([*compose,'ps','-a','-q',n]).stdout.decode().strip() for n in ['app','postgres']}
   old=ids();port=json.loads(run(['docker','inspect',old['app']]).stdout)[0]['NetworkSettings']['Ports']['8000/tcp'][0]['HostPort'];url='http://127.0.0.1:'+port+'/health'
   wait(lambda:health(url));case['unfenced_app_healthy']=True
   run([*compose,'exec','-T','-u','postgres','postgres','psql','-Xq','-v','ON_ERROR_STOP=1','-c','CREATE TABLE p12_kept(id integer PRIMARY KEY); INSERT INTO p12_kept VALUES(42);'])
   result=run([binary,'-C',root,'-p',name,'pitr','restore','--yes'],check=False)
   case['restore_exit_code']=result.returncode
   assert result.returncode!=0 and (project/'pitr-fence/active.json').is_file()
   assert b'data directory may have changed' in result.stderr
   for container in old.values():assert run(['docker','inspect',container],check=False).returncode!=0
   case['old_unguarded_containers_removed']=True
   guarded=json.loads((project/'docker-compose.yml').read_text());assert all(guarded['services'][s]['restart']=='no' for s in ['app','postgres'])
   result=run([binary,'-C',root,'-p',name,'up'],check=False)
   assert result.returncode!=0 and b'active.json' in result.stderr and b'pitr recover --yes' in result.stderr
   case['CLI_up_refused']=True
   run([*compose,'create','--no-build','app','postgres']);new=ids()
   for role,container in new.items():
    run(['docker','start',container])
    def stopped():return json.loads(run(['docker','inspect',container]).stdout)[0]['State']['Running'] is False
    wait(stopped,10)
    info=json.loads(run(['docker','inspect',container]).stdout)[0]
    assert info['State']['ExitCode']!=0
    logs=run(['docker','logs',container]).stdout+run(['docker','logs',container]).stderr
    assert b'active.json' in logs and b'pitr recover --yes' in logs
    case[role+'_guard_exit_code']=info['State']['ExitCode']
   # A policy override still cannot execute PostgreSQL or the application.
   for role,container in new.items():
    run(['docker','update','--restart='+policy,container]);run(['docker','start',container])
   time.sleep(2)
   assert not health(url)
   case['manual_policy_override_did_not_reopen_API']=True
   if a.allow_disposable_daemon_restart:
    all_ids=set(run(['docker','ps','-aq','--no-trunc']).stdout.decode().split())
    assert all_ids==set(new.values()), 'Only owned fixture containers may exist before daemon restart'
    before_logs={role:(run(['docker','logs',cid]).stdout+run(['docker','logs',cid]).stderr).count(b'PITR fence') for role,cid in new.items()}
    run(['sudo','-n','systemctl','restart','docker'],timeout=60)
    wait(lambda:run(['docker','info','--format','{{.ServerVersion}}'],check=False,timeout=5).returncode==0,30)
    observed=[]
    for sample in range(20):
     states={role:json.loads(run(['docker','inspect',cid]).stdout)[0]['State'] for role,cid in new.items()}
     api_reopened=health(url)
     assert not api_reopened and all(v.get('Health',{}).get('Status')!='healthy' for v in states.values())
     observed.append({'API_reopened':api_reopened,'postgres_exit_code':states['postgres']['ExitCode'],'app_exit_code':states['app']['ExitCode']})
     time.sleep(1)
    after_logs={role:(run(['docker','logs',cid]).stdout+run(['docker','logs',cid]).stderr).count(b'PITR fence') for role,cid in new.items()}
    assert all(after_logs[role]>before_logs[role] for role in new), 'Daemon must actually reattempt both guarded containers'
    case['daemon_restart']={'samples':observed,'actual_guarded_restart_attempts':True,'guard_log_count_before':before_logs,'guard_log_count_after':after_logs,'no_API_reopened':True}
   run([*compose,'rm','--stop','--force','app','postgres'])
   # Remove only the inert owned marker through an explicit offline adapter.
   run([*compose,'run','--rm','--no-deps','-T','-u','postgres','--entrypoint','/bin/sh','postgres','-ec','test "$(cat /var/lib/postgresql/data/p12-marker)" = "p12 owned inert marker"; rm /var/lib/postgresql/data/p12-marker'])
   result=run([binary,'-C',root,'-p',name,'pitr','recover','--yes'],check=False,timeout=145);case['explicit_recovery_exit_code']=result.returncode
   assert result.returncode==0
   assert not (project/'pitr-fence/active.json').exists() and not (project/'pitr-fence/recovery.json').exists()
   assert (project/'docker-compose.yml').read_bytes()==original
   run([*compose,'up','-d'],timeout=120);new=ids();port=json.loads(run(['docker','inspect',new['app']]).stdout)[0]['NetworkSettings']['Ports']['8000/tcp'][0]['HostPort'];url='http://127.0.0.1:'+port+'/health';wait(lambda:health(url))
   rows=run([*compose,'exec','-T','-u','postgres','postgres','psql','-AtXc','SELECT id FROM p12_kept;']).stdout.strip();assert rows==b'42'
   for container in new.values():assert json.loads(run(['docker','inspect',container]).stdout)[0]['HostConfig']['RestartPolicy']['Name']==policy
   case.update(status='passed',fence_cleared_explicitly=True,original_compose_and_restart_policy_restored=True,fixture_row_preserved=True,post_recovery_app_healthy=True)
  finally:
   result=run([*compose,'down','--volumes','--remove-orphans'],check=False,cleanup=True)
   case['cleanup_confirmed']=result.returncode==0
   (output/'report.json').write_text(json.dumps(manifest,indent=2)+'\n')
 manifest['status']='passed'
except Exception as error:
 manifest.update(status='failed',failure_type=type(error).__name__,failure=str(error)[:180])
 raise
finally:
 run(['docker','image','rm',image],check=False,cleanup=True)
 manifest['elapsed_seconds']=time.monotonic()-start
 (output/'report.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(json.dumps(manifest,indent=2),flush=True)
 log.close()
