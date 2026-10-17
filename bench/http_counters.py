"""Retain physical HTTP attempts and rare negative probes per native series."""
import re
from arrival_counters import finite, phase_label

PROTOCOL = 'continuous per-series HTTP and expected-rejection counters; 120s lookback; maximum 30s polling gap; bounded phase state'
FAMILIES = ('http_reqs', 'expected_rejections')
MAX_SERIES = 256


def integer(value):
    return finite(value) and 0 <= value <= 2**53 and int(value) == value


def project_for(scenario):
    if scenario in ('traffic', 'session-canary'):
        return 'single'
    if isinstance(scenario, str) and re.fullmatch(r'project-[0-9]', scenario):
        return scenario
    raise ValueError('Unknown HTTP counter scenario')


def closed_counts(value, phase, scenario, duration):
    if not isinstance(value, dict) or value.get('protocol') != PROTOCOL or value.get('phase') != phase_label(phase) or value.get('closed') is not True:
        raise ValueError('Missing closed HTTP counter coverage')
    began, last, gap = [value.get(key) for key in ['began_monotonic', 'last_monotonic', 'maximum_poll_gap_seconds']]
    observations, series = value.get('observations'), value.get('tracked_series_count')
    if not all(finite(item) for item in [began, last, gap, duration]) or not 0 < duration <= 21600 or not 0 <= began <= last or last-began < duration or not 0 <= gap <= 30 or type(observations) is not int or not 2 <= observations <= 1000000 or last-began > gap*observations+1e-6 or type(series) is not int or not 0 <= series <= MAX_SERIES:
        raise ValueError('Incomplete or inconsistent HTTP counter polling coverage')
    groups = value.get('scenarios')
    if not isinstance(groups, dict) or not 1 <= len(groups) <= 11 or scenario not in groups:
        raise ValueError('Missing bounded HTTP scenario counts')
    for name, counts in groups.items():
        expected_project = project_for(name)
        if not isinstance(counts, dict) or counts.get('project') != expected_project or not all(integer(counts.get(key)) for key in FAMILIES):
            raise ValueError('Invalid persisted HTTP counters')
        statuses = counts.get('status_counts')
        if not isinstance(statuses, dict) or len(statuses) > MAX_SERIES or any(not isinstance(status, str) or not re.fullmatch(r'[1-5][0-9]{2}|0', status) or not integer(count) for status, count in statuses.items()) or sum(statuses.values()) != counts['http_reqs']:
            raise ValueError('Incomplete HTTP outcome accounting')
        if counts['expected_rejections'] != statuses.get('401', 0):
            raise ValueError('Expected probes disagree with actual HTTP 401 attempts')
    return groups[scenario]


class HttpCounters:
    def __init__(self, phase, scenarios, now):
        self.phase = phase_label(phase)
        if not isinstance(scenarios, (list, tuple)) or not 1 <= len(scenarios) <= 11 or any(not isinstance(value, str) for value in scenarios) or len(set(scenarios)) != len(scenarios):
            raise ValueError('Invalid HTTP scenario declaration')
        self.projects = {scenario: project_for(scenario) for scenario in scenarios}
        if not finite(now) or now < 0:
            raise ValueError('Invalid HTTP counter clock')
        self.began = self.last = now
        self.maximum_gap = 0
        self.observations = 0
        self.closed = False
        self.series = {}

    def observe(self, families, resets, now):
        if self.closed or not finite(now) or now < self.last or now-self.last > 30:
            raise ValueError('HTTP counter observation gap, closed phase or invalid clock')
        if not finite(resets) or resets != 0:
            raise ValueError('HTTP counter reset invalidates phase evidence')
        if not isinstance(families, dict) or set(families) != set(FAMILIES):
            raise ValueError('Incomplete HTTP counter families')
        pending = {}
        for family, rows in families.items():
            if not isinstance(rows, list) or len(rows) > MAX_SERIES:
                raise ValueError('HTTP counter series budget exceeded')
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get('metric'), dict) or not isinstance(row.get('value'), list) or len(row['value']) != 2 or not isinstance(row['value'][1], str):
                    raise ValueError('Malformed HTTP counter sample')
                labels = row['metric'].copy()
                metric_name = labels.pop('__name__', 'k6_'+family+'_total')
                if metric_name != 'k6_'+family+'_total' or any(not isinstance(key, str) or not isinstance(value, str) or len(value) > 80 for key, value in labels.items()):
                    raise ValueError('Invalid HTTP counter labels')
                scenario = labels.get('scenario')
                if labels.get('run_id') != self.phase or scenario not in self.projects or labels.get('project') != self.projects[scenario]:
                    raise ValueError('HTTP counter escaped its phase/project/scenario')
                allowed = {'run_id', 'scenario', 'project', 'group'}
                if family == 'http_reqs':
                    allowed.update({'method', 'status', 'workload', 'error_code'})
                    if labels.get('method') not in ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS') or not re.fullmatch(r'[1-5][0-9]{2}|0', labels.get('status', '')) or labels.get('workload') not in ('read','rls','panel','storage','login','refresh','write','security','cross-project'):
                        raise ValueError('Unknown bounded HTTP operation or outcome')
                    if 'error_code' in labels and not re.fullmatch(r'[0-9]{1,5}', labels['error_code']):
                        raise ValueError('Invalid HTTP transport error code')
                if not set(labels).issubset(allowed) or labels.get('group', '') != '':
                    raise ValueError('Unknown or sensitive HTTP counter tags')
                count = float(row['value'][1])
                key = (family, tuple(sorted(labels.items())))
                if not integer(count) or key in pending or count < self.series.get(key, 0):
                    raise ValueError('Duplicate, invalid or regressive HTTP counter')
                pending[key] = int(count)
        if len(set(self.series).union(pending)) > MAX_SERIES:
            raise ValueError('HTTP phase exceeded its bounded retained-series budget')
        self.series.update(pending)
        self.maximum_gap = max(self.maximum_gap, now-self.last)
        self.last = now
        self.observations += 1
        return self.snapshot()

    def close(self):
        if self.observations < 2:
            raise ValueError('HTTP counters require beginning and final observations')
        self.closed = True
        return self.snapshot()

    def snapshot(self):
        groups = {scenario: {'project': project, 'http_reqs': 0, 'expected_rejections': 0, 'status_counts': {}} for scenario, project in self.projects.items()}
        for (family, fields), count in self.series.items():
            labels = dict(fields)
            group = groups[labels['scenario']]
            group[family] += count
            if family == 'http_reqs':
                status = labels['status']
                group['status_counts'][status] = group['status_counts'].get(status, 0)+count
        return {'protocol': PROTOCOL, 'phase': self.phase, 'closed': self.closed,
                'began_monotonic': self.began, 'last_monotonic': self.last,
                'maximum_poll_gap_seconds': self.maximum_gap,
                'observations': self.observations, 'tracked_series_count': len(self.series),
                'scenarios': groups}
