"""Retain sparse scheduler counters across bounded telemetry retention."""
import math
import re

PROTOCOL = 'continuous sparse scheduler counters; 120s lookback; maximum 30s polling gap; bounded phase state'


def phase_label(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', value):
        raise ValueError('Invalid arrival-counter phase')
    return value


def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, int):
        return True
    return math.isfinite(value)


def closed_count(value, phase, scenario, duration):
    """Require complete typed polling evidence before comparing measurements."""
    phase_label(phase)
    if not isinstance(value, dict) or value.get('protocol') != PROTOCOL or value.get('phase') != phase or value.get('closed') is not True:
        raise ValueError('Missing closed continuous arrival evidence')
    began, last, gap = [value.get(key) for key in ['began_monotonic', 'last_monotonic', 'maximum_poll_gap_seconds']]
    observations = value.get('observations')
    if not all(finite(item) for item in [began, last, gap, duration]) or not 0 < duration <= 21600 or not 0 <= began <= last or last - began < duration or not 0 <= gap <= 30 or isinstance(observations, bool) or not isinstance(observations, int) or not 2 <= observations <= 1000000 or last - began > gap * observations + 1e-6:
        raise ValueError('Incomplete or inconsistent arrival polling coverage')
    counts = value.get('dropped_by_scenario')
    if not isinstance(counts, dict) or not 1 <= len(counts) <= 11 or scenario not in counts:
        raise ValueError('Missing bounded scheduler scenario counters')
    for name, count in counts.items():
        if not isinstance(name, str) or not re.fullmatch(r'traffic|session-canary|project-[0-9]', name) or not finite(count) or not 0 <= count <= 2**53 or int(count) != count:
            raise ValueError('Invalid persisted scheduler counter')
    return counts[scenario]


class ArrivalCounter:
    def __init__(self, phase, scenarios, now):
        self.phase = phase_label(phase)
        if not isinstance(scenarios, (list, tuple)) or not 1 <= len(scenarios) <= 11 or any(not isinstance(value, str) or not re.fullmatch(r'traffic|session-canary|project-[0-9]', value) for value in scenarios) or len(set(scenarios)) != len(scenarios):
            raise ValueError('Invalid bounded arrival scenarios')
        if not finite(now) or now < 0:
            raise ValueError('Invalid arrival-counter clock')
        self.counts = dict.fromkeys(scenarios, 0)
        self.began = self.last = now
        self.maximum_gap = 0
        self.observations = 0
        self.closed = False

    def observe(self, values, resets, now):
        if self.closed:
            raise ValueError('Closed arrival counters cannot accept new samples')
        if not finite(now) or now < self.last or now - self.last > 30:
            raise ValueError('Arrival-counter observation gap or clock failure')
        if not finite(resets) or resets != 0:
            raise ValueError('Arrival-counter reset invalidates phase evidence')
        if not isinstance(values, dict) or not set(values).issubset(self.counts):
            raise ValueError('Unknown or incomplete scheduler scenario evidence')
        for scenario, value in values.items():
            if not finite(value) or not 0 <= value <= 2**53 or int(value) != value or value < self.counts[scenario]:
                raise ValueError('Invalid or regressive scheduler counter')
        # Absence after a sparse sample expires must preserve its earlier value.
        self.counts.update({key: int(value) for key, value in values.items()})
        self.maximum_gap = max(self.maximum_gap, now - self.last)
        self.last = now
        self.observations += 1
        return self.snapshot()

    def close(self):
        if self.observations < 2:
            raise ValueError('Arrival counters need beginning and final observations')
        self.closed = True
        return self.snapshot()

    def snapshot(self):
        return {'phase': self.phase, 'protocol': PROTOCOL, 'began_monotonic': self.began,
                'last_monotonic': self.last, 'maximum_poll_gap_seconds': self.maximum_gap,
                'observations': self.observations, 'closed': self.closed,
                'dropped_by_scenario': dict(self.counts)}
