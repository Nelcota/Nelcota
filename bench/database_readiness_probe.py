#!/usr/bin/env python3
"""Reproduce Unix-socket early readiness on one disposable Actions PostgreSQL."""
import json
import os
from pathlib import Path
import secrets
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

from campaign import docker
from native_preflight import inventory
from ownership import LABEL
from projects import Project
from watchdog import atomic_json, cleanup, host_reserves, process_identity


def require(condition):
    if not condition:
        raise RuntimeError('Owned PostgreSQL readiness regression failed')


def main():
    available=inventory()
    require(available['cpu_affinity_slots']>=4 and os.getuid()!=0
            and not docker('ps','-aq') and not docker('volume','ls','-q'))
    root=Path('target/stress-g05').resolve();root.mkdir(parents=True,exist_ok=True)
    output=Path(tempfile.mkdtemp(prefix='database-readiness-',dir=root))
    identity='nelcota-readiness-'+secrets.token_hex(16)
    project=Project(identity,0,1,Path('/unused-readiness-artifact'),output,sorted(os.sched_getaffinity(0)))
    password=secrets.token_urlsafe(32)
    fixture=output/'hold.sql';fixture.write_text('SELECT pg_sleep(10);\n');fixture.chmod(0o444)
    began=time.monotonic()
    manifest={'identity':identity,'output':str(output),'reserve_path':str(output),
              'pid':os.getpid(),'process_identity':process_identity(os.getpid()),
              'started_monotonic':began,'maximum_seconds':120,'preparation_seconds':90,
              'containers':[project.pg],'volumes':[]}
    atomic_json(output/'ownership.json',manifest)
    atomic_json(output/'heartbeat.json',{'phase':'preparation','monotonic':began,'resource_monotonic':began})
    stop=threading.Event();critical=threading.Event();samples=[]
    def heartbeat():
        while not stop.is_set():
            now=time.monotonic()
            if host_reserves(output):critical.set()
            atomic_json(output/'heartbeat.json',{'phase':'preparation','monotonic':now,'resource_monotonic':now})
            stop.wait(2)
    heart=threading.Thread(target=heartbeat,daemon=True);heart.start()
    def terminate(signum,frame):raise RuntimeError('Owned readiness watchdog interrupted the probe')
    previous=signal.signal(signal.SIGTERM,terminate)
    watchdog=subprocess.Popen([sys.executable,str(Path(__file__).with_name('watchdog.py')),str(output/'ownership.json')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    report={'source':available['source'],'status':'failed','cleanup_confirmed':False,
            'scope':'Real PostgreSQL entrypoint regression only; no backend load or G05 capacity certification',
            'effective_backend_load_seconds':0,'budgets':{'cpu':.5,'memory_mib':256,'disk_tmpfs_mib':192,'pids':64,'maximum_seconds':120,'SQL_probes_per_second_maximum':8,'network':'none; no host port'},
            'unix_socket_admitted_temporary_server':False,'temporary_server_TCP_listening_disabled':False,
            'TCP_rejected_temporary_server':False,'final_authenticated_TCP_ready':False}
    try:
        relative=next(line.split(':',2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
        cgroup=(Path('/sys/fs/cgroup')/relative.lstrip('/')).resolve(strict=True)
        require(cgroup.is_relative_to(Path('/sys/fs/cgroup').resolve())
                and any(re.fullmatch(r'g05-readiness-[0-9]{1,20}-[0-9]{1,4}\.service',part) for part in cgroup.parts))
        quota,period=(cgroup/'cpu.max').read_text().split()
        memory,swap,tasks=[(cgroup/name).read_text().strip() for name in ['memory.max','memory.swap.max','pids.max']]
        require(quota.isdigit() and quota==period and memory==str(256*1024**2) and swap=='0' and tasks=='64')
        report['controller_kernel_budget']={'cpu_quota_usec':int(quota),'cpu_period_usec':int(period),
                                             'memory_bytes':int(memory),'swap_bytes':int(swap),'pids':int(tasks)}
        project.docker('run','-d','--name',project.pg,'--label',LABEL+'='+identity,
                       '--network','none','--cpus','.5','--memory','256m','--memory-swap','256m','--pids-limit','64',
                       '--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=192m',
                       '--mount',f'type=bind,source={fixture},target=/docker-entrypoint-initdb.d/hold.sql,readonly',
                       '-e','POSTGRES_PASSWORD','postgres:17-alpine','postgres',
                       '-c','shared_buffers=32MB','-c','max_connections=16','-c','max_wal_size=64MB','-c','min_wal_size=32MB',env={'POSTGRES_PASSWORD':password})
        while time.monotonic()-began<60:
            require(not critical.is_set())
            state=json.loads(project.docker('inspect',project.pg))[0]
            require(state['State']['Running'] and not state['State']['OOMKilled'] and state['RestartCount']==0)
            samples.append({'elapsed_seconds':time.monotonic()-began,'running':True,'oom_killed':False,'restart_count':0})
            try:
                report['unix_socket_admitted_temporary_server']=project.sql('SELECT 1')=='1'
            except RuntimeError:
                pass
            if report['unix_socket_admitted_temporary_server']:
                break
            time.sleep(.25)
        require(report['unix_socket_admitted_temporary_server'])
        report['temporary_server_TCP_listening_disabled']=project.sql("SELECT current_setting('listen_addresses')='' ")=='t'
        require(report['temporary_server_TCP_listening_disabled'])
        try:
            report['TCP_rejected_temporary_server']=not project.database_ready(password)
        except RuntimeError:
            report['TCP_rejected_temporary_server']=True
        require(report['TCP_rejected_temporary_server'])
        while time.monotonic()-began<80:
            require(not critical.is_set())
            state=json.loads(project.docker('inspect',project.pg))[0]
            require(state['State']['Running'] and not state['State']['OOMKilled'] and state['RestartCount']==0)
            try:
                report['final_authenticated_TCP_ready']=project.database_ready(password)
            except RuntimeError:
                pass
            if report['final_authenticated_TCP_ready']:
                break
            time.sleep(.25)
        require(report['final_authenticated_TCP_ready'])
        report['status']='passed'
    except Exception as error:
        report['failure_type']=type(error).__name__
    finally:
        stop.set();heart.join(timeout=5)
        cleanup(manifest)
        report['cleanup_confirmed']=not docker('ps','-aq','--filter','label='+LABEL+'='+identity) and not docker('volume','ls','-q','--filter','label='+LABEL+'='+identity)
        if report['cleanup_confirmed']:
            project.storage.rmdir();fixture.unlink()
            (output/'watchdog-disarmed').touch()
        watchdog.wait(timeout=15);signal.signal(signal.SIGTERM,previous)
        report['resource_guard_breached']=critical.is_set()
        report['state_samples']=len(samples)
        report['elapsed_seconds_including_preparation']=time.monotonic()-began
        if not report['cleanup_confirmed'] or critical.is_set():report['status']='failed'
        atomic_json(output/'probe.json',report)
        print('::notice title=Database readiness regression::'+json.dumps(report,separators=(',',':'),allow_nan=False),flush=True)
    require(report['status']=='passed')


if __name__=='__main__':main()
