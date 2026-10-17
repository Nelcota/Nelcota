"""Attribute generator observations to its lifecycle, never a reused name."""
import json
import subprocess
import time
import threading

from watchdog import LABEL, process_identity
from host_resources import owned_cgroup_snapshot, require_no_oom

GENERATOR_PROTOCOL = 'owned Docker stats with verified cgroup-v2 fallback on 10s stream timeout; unchanged 30s observation gate'


class ObservationEpoch:
    """Remember transitions even when a short fault returns to the same state."""
    def __init__(self):
        self._lock=threading.Lock()
        self._value=None
        self._epoch=0

    def set(self,value):
        with self._lock:
            self._value=value
            self._epoch+=1

    def capture(self):
        with self._lock:
            return self._epoch,self._value

    def changed(self,epoch):
        with self._lock:
            return self._epoch!=epoch


def inspect_container(name):
    result = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True, timeout=10)
    if result.returncode:
        if any(message in result.stderr.lower() for message in ['no such object', 'no such container']):
            return None
        raise RuntimeError('Generator inspection failed: '+result.stderr[-600:])
    return json.loads(result.stdout)[0]


def generator_observation(context, current):
    if context is None or context is not current() or context['process'].poll() is not None:
        return None
    container_id = context.get('container_id')
    if container_id is None:
        state = inspect_container(context['name'])
        if context is not current() or context['process'].poll() is not None:
            return None
        if state is None or not state['State']['Running']:
            if time.monotonic()-context['started'] > 30:
                raise RuntimeError('Generator did not become observable within 30 seconds')
            return None
        if (state['Config'].get('Labels') or {}).get(LABEL) != context['identity']:
            raise RuntimeError('Generator ownership changed')
        container_id = state['Id']
        context['container_id'] = container_id
        context['host_pid']=state['State'].get('Pid')
        if isinstance(context['host_pid'],int) and context['host_pid']>0:
            context['pid_starttime']=process_identity(context['host_pid'])
    try:
        result = subprocess.run(['docker', 'stats', '--no-stream', '--format', '{{json .}}', container_id], capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        return native_generator_observation(context, current)
    if context is not current() or context['process'].poll() is not None:
        return None
    if result.returncode or not result.stdout.strip():
        state = inspect_container(container_id)
        if state is None or not state['State']['Running']:
            return None  # The driver validates the completed process's exit code.
        raise RuntimeError('Live generator statistics failed: '+result.stderr[-600:])
    context['last_observed'] = time.monotonic()
    value = json.loads(result.stdout)
    value['phase'] = context['phase']
    value['container_id'] = container_id
    value['host_pid']=context.get('host_pid')
    value['pid_starttime']=context.get('pid_starttime')
    return value


def native_generator_observation(context, current):
    """Keep actual kernel evidence when Docker's streaming stats stalls."""
    if context is not current() or context['process'].poll() is not None:
        return None
    identifier = context['container_id']
    state = inspect_container(identifier)
    if context is not current() or context['process'].poll() is not None:
        return None
    if state is None or not state['State']['Running']:
        raise RuntimeError('Live generator disappeared during native observation')
    pid = context.get('host_pid')
    start = context.get('pid_starttime')
    if state['Id'] != identifier or (state['Config'].get('Labels') or {}).get(LABEL) != context['identity'] or type(pid) is not int or pid <= 0 or state['State'].get('Pid') != pid or not start or process_identity(pid) != start:
        raise RuntimeError('Generator native observation ownership changed')
    def read(*args):
        if args[:2] != ('exec', identifier):
            raise RuntimeError('Native observation escaped its owned container')
        result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=5)
        if result.returncode:
            raise RuntimeError('Live generator native cgroup read failed')
        return result.stdout
    try:
        value = owned_cgroup_snapshot(read, identifier, shell_builtins=True)
    except (RuntimeError, subprocess.TimeoutExpired):
        if context is not current() or context['process'].poll() is not None:
            return None
        raise
    if context is not current() or context['process'].poll() is not None:
        return None
    if process_identity(pid) != start:
        raise RuntimeError('Generator PID changed during native observation')
    require_no_oom(value['memory.events'])
    context['last_observed'] = time.monotonic()
    return {'source':'cgroup-v2 after Docker stats timeout', 'docker_stats_timeout_seconds':10,
            'phase':context['phase'], 'container_id':identifier, 'host_pid':pid,
            'pid_starttime':start, 'component_cgroup':value}
