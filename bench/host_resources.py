"""Linux host-scope evidence, separate from per-container working sets."""
from pathlib import Path

CGROUP=Path('/sys/fs/cgroup')


def counters(path):
    if not path.is_file():
        return None
    return parse_counters(path.read_text())


def parse_counters(text):
    values={}
    for line in text.splitlines():
        key,value=line.split()
        if key in values:
            raise ValueError('Duplicate kernel counter evidence')
        values[key]=int(value)
        if values[key]<0:
            raise ValueError('Negative kernel counter evidence')
    return values


CONTAINER_FIELDS=('memory.current','memory.max','memory.peak','memory.events','memory.stat','cpu.max','cpu.stat','pids.current','pids.max')
CONTAINER_COMMAND='set -eu; for field in '+ ' '.join(CONTAINER_FIELDS)+'; do printf "[%s]\\n" "$field"; cat "/sys/fs/cgroup/$field"; done'
BUILTIN_CONTAINER_COMMAND='set -eu; for field in '+ ' '.join(CONTAINER_FIELDS)+'; do printf "[%s]\\n" "$field"; while IFS= read -r line; do printf "%s\\n" "$line"; done < "/sys/fs/cgroup/$field"; done'


def owned_cgroup_snapshot(owned,name,*,shell_builtins=False):
    """Read the component namespace when its cgroup is outside our mount."""
    command=CONTAINER_COMMAND
    if shell_builtins:command=BUILTIN_CONTAINER_COMMAND
    raw=owned('exec',name,'sh','-c',command)
    sections={}
    current=None
    for line in raw.splitlines():
        if line.startswith('[') and line.endswith(']'):
            current=line[1:-1]
            if current not in CONTAINER_FIELDS or current in sections:
                raise ValueError('Unknown or duplicate component cgroup section')
            sections[current]=[]
            continue
        if current is None:
            raise ValueError('Component cgroup observation has no section')
        sections[current].append(line)
    if set(sections)!=set(CONTAINER_FIELDS) or any(not values for values in sections.values()):
        raise ValueError('Incomplete component cgroup evidence')
    result={name:parse_counters('\n'.join(sections[name])) for name in ['memory.events','memory.stat','cpu.stat']}
    for name in ['memory.current','memory.max','memory.peak','pids.current','pids.max']:
        value='\n'.join(sections[name])
        result[name]=None
        if value!='max':
            result[name]=int(value)
            if result[name]<0:
                raise ValueError('Negative component cgroup gauge')
    if any(result[name] is None for name in ['memory.current','memory.peak','pids.current']):
        raise ValueError('Missing finite component memory or task gauge')
    quota,period=' '.join(sections['cpu.max']).split()
    result['cpu.max']={'quota_usec':None,'period_usec':int(period)}
    if quota!='max':result['cpu.max']['quota_usec']=int(quota)
    if result['cpu.max']['period_usec']<=0 or (quota!='max' and result['cpu.max']['quota_usec']<=0):
        raise ValueError('Invalid component CPU quota')
    if any(key not in result['cpu.stat'] for key in ['usage_usec','nr_periods','nr_throttled','throttled_usec']):
        raise ValueError('Incomplete component CPU throttle evidence')
    if any(key not in result['memory.stat'] for key in ['anon','file','shmem']):
        raise ValueError('Incomplete component cache/working-set evidence')
    return result


def snapshot(cpus):
    ticks={}
    for line in Path('/proc/stat').read_text().splitlines():
        name,*values=line.split()
        if name.startswith('cpu') and name[3:].isdigit() and int(name[3:]) in cpus:
            numbers=list(map(int,values))
            if len(numbers)<8 or any(value<0 for value in numbers):
                raise ValueError('Incomplete CPU counter evidence')
            ticks[name]={'total_without_guests':sum(numbers[:8]),'steal':numbers[7]}
    if len(ticks)!=len(cpus):
        raise ValueError('Incomplete CPU affinity evidence')
    result={'cpu_ticks':ticks,'cpu_cgroup':counters(CGROUP/'cpu.stat'),'memory_events':counters(CGROUP/'memory.events'),'memory_events_local':counters(CGROUP/'memory.events.local'),'memory_stat':counters(CGROUP/'memory.stat')}
    for name in ['memory.current','memory.max','memory.peak']:
        path=CGROUP/name
        if path.is_file():
            text=path.read_text().strip()
            if text=='max':
                result[name]=None
                continue
            result[name]=int(text)
    return result


def container_memory_events(pid):
    lines=Path(f'/proc/{pid}/cgroup').read_text().splitlines()
    for line in lines:
        hierarchy,controllers,relative=line.split(':',2)
        if hierarchy=='0' and not controllers:
            path=(CGROUP/relative.lstrip('/')).resolve()
            if not path.is_relative_to(CGROUP.resolve()):
                return None  # A sibling cgroup may be outside this namespace.
            result=counters(path/'memory.events')
            if result is not None:
                return result
    return None


def require_no_oom(events):
    if not isinstance(events,dict) or any(name not in events for name in ['oom','oom_kill']):
        raise ValueError('Missing per-container OOM evidence')
    if any(isinstance(value,bool) or not isinstance(value,int) or value<0 for value in events.values()):
        raise ValueError('Invalid per-container OOM evidence')
    if events['oom'] or events['oom_kill']:
        raise RuntimeError('A component or PostgreSQL child reached OOM')


def memory_reserve_breached():
    maximum=CGROUP/'memory.max'
    stat=counters(CGROUP/'memory.stat')
    if not maximum.is_file() or stat is None:
        return False
    text=maximum.read_text().strip()
    if text=='max':
        return False
    # Clean file cache can be reclaimed. Include tmpfs/shmem, live anonymous
    # memory and kernel charges rather than interpreting page cache as a leak.
    working=sum(stat.get(name,0) for name in ['anon','shmem','kernel','file_dirty','file_writeback'])
    return working>int(text)*.9
