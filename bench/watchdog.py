"""Independent fail-closed cleanup for explicitly labeled stress fixtures."""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
from host_resources import memory_reserve_breached
from ownership import LABEL, container_id


def process_identity(pid):
    try:
        # comm may contain spaces or parentheses; fields after its final ')'.
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def stop_owner(manifest):
    """Bind termination to the original task, even if its numeric PID is reused."""
    descriptor = None
    try:
        pid = manifest['pid']
        start = manifest['process_identity']
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1 or not isinstance(start, str) or not start.isdigit():
            return False
        descriptor = os.pidfd_open(pid)
        if process_identity(pid) != start:
            return False
        uid = next(int(line.split()[1]) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if line.startswith('Uid:'))
        if uid != os.getuid():
            return False
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        return True
    except (OSError, ValueError, KeyError, StopIteration, AttributeError):
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)


def stop_generator(manifest):
    """Stop known owned traffic even when the Docker API is unavailable."""
    path=Path(manifest['output'])/'generator-process.json'
    descriptor=None
    try:
        value=json.loads(path.read_text())
        pid=value['pid']
        start=value.get('process_identity')
        identifier=value.get('container_id')
        if value.get('identity')!=manifest['identity'] or isinstance(pid,bool) or not isinstance(pid,int) or pid<=1 or not isinstance(start,str) or not start.isdigit() or not isinstance(identifier,str) or len(identifier)!=64 or any(char not in '0123456789abcdef' for char in identifier):
            return False
        descriptor=os.pidfd_open(pid)
        if process_identity(pid)!=start or identifier not in Path(f'/proc/{pid}/cgroup').read_text():
            return False
        uid=next(int(line.split()[1]) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if line.startswith('Uid:'))
        if uid!=os.getuid():
            return False
        signal.pidfd_send_signal(descriptor,signal.SIGKILL)
        atomic_json(Path(manifest['output'])/'generator-emergency-stop.json',{'pid':pid,'identity':manifest['identity'],'reason':'stop offered traffic independently of Docker','signal':'SIGKILL'})
        return True
    except (OSError,ValueError,KeyError,StopIteration,AttributeError):
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)


def host_reserves(root):
    stats = os.statvfs(root)
    if stats.f_bavail / max(1, stats.f_blocks) < 0.15:
        return 'host_disk_reserve'
    if stats.f_files and stats.f_favail / stats.f_files < 0.15:
        return 'host_inode_reserve'
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        memory[key] = int(value.split()[0])
    if memory['MemAvailable'] / memory['MemTotal'] < 0.10:
        return 'host_memory_reserve'
    if memory_reserve_breached():
        return 'host_cgroup_memory_reserve'
    return None


def owned_container(name, identity):
    result = subprocess.run(['docker', 'inspect', '--format', '{{json .Config.Labels}}', name], capture_output=True, text=True, timeout=10)
    if result.returncode:
        return False
    return (json.loads(result.stdout) or {}).get(LABEL) == identity


def cleanup(manifest):
    for name in manifest['containers']:
        try:
            identifier=container_id(name,manifest['identity'])
            if identifier is not None:
                subprocess.run(['docker', 'rm', '-fv', identifier], capture_output=True, timeout=15)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    for name in manifest.get('volumes', []):
        try:
            result = subprocess.run(['docker', 'volume', 'inspect', name], capture_output=True, text=True, timeout=10)
            if result.returncode:
                continue
            labels = json.loads(result.stdout)[0].get('Labels') or {}
            if labels.get(LABEL) == manifest['identity']:
                subprocess.run(['docker', 'volume', 'rm', name], capture_output=True, timeout=15)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue


def atomic_json(path, value):
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',dir=path.parent,prefix=path.name+'.',suffix='.writing',delete=False) as target:
            temporary=Path(target.name)
            target.write(json.dumps(value,indent=2,allow_nan=False)+'\n')
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def heartbeat_failure(manifest,state,now):
    preparation = manifest.get('preparation_seconds',180)
    if isinstance(preparation,bool) or not isinstance(preparation,int) or not 30 <= preparation <= 900:
        return 'invalid_preparation_budget'
    clock = state.get('monotonic')
    if isinstance(clock,bool) or not isinstance(clock,(int,float)) or not math.isfinite(clock) or clock > now or now-clock>45:
        return 'resource_heartbeat_lost'
    phase = state.get('phase')
    if phase == 'preparation':
        if now-manifest['started_monotonic']>preparation:
            return 'preparation_deadline'
        return None
    if phase == 'teardown':
        return None
    resource = state.get('resource_monotonic')
    if isinstance(resource,bool) or not isinstance(resource,(int,float)) or not math.isfinite(resource) or resource > now or now-resource>30:
        return 'resource_observation_gap'
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    root = Path(manifest['output'])
    heartbeat = root / 'heartbeat.json'
    disarmed = root / 'watchdog-disarmed'
    while not disarmed.exists():
        reason = host_reserves(manifest['reserve_path'])
        if process_identity(manifest['pid']) != manifest['process_identity']:
            reason = 'owner_process_lost'
        now = time.monotonic()
        if now - manifest['started_monotonic'] > manifest['maximum_seconds']:
            reason = 'campaign_deadline'
        try:
            state = json.loads(heartbeat.read_text())
            failure = heartbeat_failure(manifest,state,now)
            if failure:
                reason = failure
        except (OSError, ValueError, KeyError):
            reason = 'resource_heartbeat_invalid'
        if reason:
            atomic_json(root / 'watchdog-stop.json', {'reason': reason, 'monotonic': now})
            stop_generator(manifest)
            stop_owner(manifest)
            cleanup(manifest)
            return
        time.sleep(2)


if __name__ == '__main__':
    main()
