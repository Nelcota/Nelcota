"""Bounded numeric scheduling evidence for the in-process ledger generator."""
import os
from pathlib import Path
import resource

from host_resources import counters, snapshot


def observe(cpus):
    root = Path('/sys/fs/cgroup').resolve(strict=True)
    rows = [line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines()
            if line.startswith('0::')]
    if len(rows) != 1 or '..' in Path(rows[0]).parts:
        raise ValueError('Missing unambiguous generator cgroup')
    group = (root / rows[0].lstrip('/')).resolve(strict=True)
    if not group.is_relative_to(root):
        raise ValueError('Generator cgroup escaped its namespace')
    cpu = counters(group / 'cpu.stat')
    fields = ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec']
    if not isinstance(cpu, dict) or any(name not in cpu for name in fields):
        raise ValueError('Incomplete generator cgroup CPU evidence')
    quota, period = (group / 'cpu.max').read_text().split()
    maximum = None
    if quota != 'max':
        maximum = int(quota)
        if maximum <= 0:
            raise ValueError('Invalid generator CPU quota')
    period = int(period)
    if period <= 0:
        raise ValueError('Invalid generator CPU period')
    usage = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {'process_user_usec': int(usage.ru_utime * 1000000),
            'process_system_usec': int(usage.ru_stime * 1000000),
            'terminated_children_cpu_usec': int((children.ru_utime + children.ru_stime) * 1000000),
            'current_process_cgroup_cpu': {name: cpu[name] for name in fields},
            'cpu_quota_usec': maximum, 'cpu_period_usec': period,
            'affinity': sorted(os.sched_getaffinity(0)),
            'host_cpu_ticks': snapshot(cpus)['cpu_ticks']}


def evidence(before, after):
    """Keep original endpoints; do not infer that their CPU use proves a cause."""
    return {'before': before, 'after': after,
            'scope': 'Ledger generator process (all threads), its current cgroup and terminated children; '
                     'host CPU steal is cumulative. The sampler shares the generator cgroup. '
                     'This is diagnostic evidence, not an assertion that generator saturation caused a failure.'}
