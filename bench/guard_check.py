"""Native ownership and emergency-stop acceptance on disposable local fixtures."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time

from campaign import docker
from ownership import LABEL, OwnedDocker
from watchdog import atomic_json, cleanup, host_reserves, process_identity


def run(output):
    output = output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError('Preserve previous guard evidence')
    output.mkdir(parents=True, exist_ok=True)
    if host_reserves(output):
        raise RuntimeError('Host reserves do not permit the native guard check')
    foreign = output/'foreign-sentinel'
    foreign.mkdir()
    fault = output/'expired-resource-observer'
    fault.mkdir()
    identities = ['nelcota-guard-'+secrets.token_hex(16) for _ in range(2)]
    owners = [OwnedDocker(identity, docker) for identity in identities]
    names = [identity+'-sentinel' for identity in identities]
    volume = identities[1]+'-volume'
    manifests = []
    began = time.monotonic()
    for index, directory in enumerate([output, foreign]):
        manifest = {'identity':identities[index], 'output':str(directory), 'reserve_path':str(output),
                    'pid':os.getpid(), 'process_identity':process_identity(os.getpid()),
                    'started_monotonic':began, 'maximum_seconds':180, 'preparation_seconds':180,
                    'containers':[names[index]], 'volumes':[]}
        if index == 1:
            manifest['volumes'] = [volume]
        atomic_json(directory/'ownership.json', manifest)
        manifests.append(manifest)
    stop = threading.Event()
    def heart():
        while not stop.is_set():
            now = time.monotonic()
            for directory in [output, foreign]:
                atomic_json(directory/'heartbeat.json', {'phase':'guard-check', 'monotonic':now, 'resource_monotonic':now})
            stop.wait(1)
    heartbeat = threading.Thread(target=heart, daemon=True)
    heartbeat.start()
    watchdogs = []
    child = None
    passed = clean = False
    proof = {'scope':'native staging guard acceptance only', 'certifies_g05':False,
             'cpu_quota_each':.02, 'memory_mib_each':32, 'maximum_seconds':180}
    try:
        for directory in [output, foreign]:
            watchdogs.append(subprocess.Popen([sys.executable, str(Path(__file__).with_name('watchdog.py')), str(directory/'ownership.json')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
        owners[1]('volume', 'create', '--label', LABEL+'='+identities[1], volume)
        for owner, name in zip(owners, names):
            owner('run', '-d', '--name', name, '--label', LABEL+'='+owner.identity,
                  '--network', 'none', '--cpus', '.02', '--cpuset-cpus', str(max(os.sched_getaffinity(0))),
                  '--memory', '32m', '--memory-swap', '32m', '--pids-limit', '8',
                  '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop', 'ALL',
                  '--read-only', '--security-opt', 'no-new-privileges',
                  '--entrypoint', '/bin/sleep', 'postgres:17-alpine', '180')
        protected_id = owners[1].require(names[1])
        rejections = []
        for command in ['stop', 'rm', 'kill']:
            try:
                owners[0](command, names[1])
            except RuntimeError:
                rejections.append(command)
        try:
            owners[0]('volume', 'create', '--label', LABEL+'='+identities[0], volume)
        except RuntimeError:
            rejections.append('foreign_volume_create')
        if len(rejections) != 4 or owners[1].require(names[1]) != protected_id or not owners[1].volume(volume):
            raise RuntimeError('Native foreign-resource protection failed')
        proof['foreign_operations_rejected'] = rejections
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(180)'])
        state = json.loads(owners[0]('inspect', names[0]))[0]
        pid = state['State']['Pid']
        atomic_json(fault/'generator-process.json', {'identity':identities[0], 'pid':pid,
                    'process_identity':process_identity(pid), 'container_id':state['Id']})
        manifest = {**manifests[0], 'output':str(fault), 'pid':child.pid, 'process_identity':process_identity(child.pid)}
        atomic_json(fault/'ownership.json', manifest)
        now = time.monotonic()
        atomic_json(fault/'heartbeat.json', {'phase':'native-observer-gap', 'monotonic':now, 'resource_monotonic':now-31})
        with (fault/'watchdog.log').open('w') as target:
            observer = subprocess.Popen([sys.executable, str(Path(__file__).with_name('watchdog.py')), str(fault/'ownership.json')], stdout=target, stderr=subprocess.STDOUT)
            try:
                if observer.wait(timeout=30) != 0:
                    raise RuntimeError('Native emergency watchdog failed')
            finally:
                if observer.poll() is None:
                    observer.terminate()
                    observer.wait(timeout=10)
        receipt = json.loads((fault/'watchdog-stop.json').read_text())
        emergency = json.loads((fault/'generator-emergency-stop.json').read_text())
        if receipt['reason'] != 'resource_observation_gap' or emergency['signal'] != 'SIGKILL' or child.wait(timeout=5) != -signal.SIGTERM:
            raise RuntimeError('Native independent traffic/owner termination was not demonstrated')
        if owners[1].require(names[1]) != protected_id or not owners[1].volume(volume):
            raise RuntimeError('Emergency cleanup affected the foreign sentinel')
        if not json.loads(owners[1]('inspect', names[1]))[0]['State']['Running'] or any(watchdog.poll() is not None for watchdog in watchdogs):
            raise RuntimeError('Foreign sentinel or independent safety watchdog stopped unexpectedly')
        proof.update({'resource_gap_stopped_traffic':True, 'actual_container_pidfd_kill':True,
                      'owner_pidfd_SIGTERM':True, 'foreign_sentinel_preserved':True,
                      'stop_reason':receipt['reason'], 'elapsed_seconds':time.monotonic()-began})
        passed = True
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        for manifest in manifests:
            cleanup(manifest)
        clean = all(not owner('ps', '-aq', '--filter', 'label='+LABEL+'='+owner.identity) and
                    not owner('volume', 'ls', '-q', '--filter', 'label='+LABEL+'='+owner.identity) for owner in owners)
        if clean:
            for directory in [output, foreign]:
                (directory/'watchdog-disarmed').touch()
        stop.set()
        heartbeat.join(timeout=3)
        for watchdog in watchdogs:
            watchdog.wait(timeout=15)
        atomic_json(output/'native-guards.json', proof)
        status = 'failed'
        if passed and clean:
            status = 'passed'
        atomic_json(output/'completion.json', {'status':status,
                    'certifies_g05':False, 'scope':'native guard acceptance only', 'cleanup_confirmed':clean})
    if not passed or not clean:
        raise RuntimeError('Native guard acceptance or owned cleanup failed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    run(parser.parse_args().output)
