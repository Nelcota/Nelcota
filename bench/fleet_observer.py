"""Bound independent owned probes; never certify a partial observation."""
from concurrent.futures import ThreadPoolExecutor,as_completed
import time
from watchdog import atomic_json

WORKERS=4


def retain_metrics_snapshot(metrics,label,output,*,failure_in_progress=False):
    try:
        atomic_json(output/(label+'-metrics-raw.json'),metrics.snapshot(label))
    except Exception as error:
        try:
            atomic_json(output/(label+'-metrics-error.json'),{'error_type':type(error).__name__})
        except OSError:
            if not failure_in_progress:raise
        if failure_in_progress:return
        raise


def collect(probes,on_failure):
    if not isinstance(probes,dict) or not 1<=len(probes)<=64 or any(not callable(probe) for probe in probes.values()) or not callable(on_failure):
        raise ValueError('Invalid bounded fleet observation batch')
    def observe(probe):
        began=time.monotonic()
        return probe(),time.monotonic()-began
    values,durations={},{}
    with ThreadPoolExecutor(max_workers=WORKERS,thread_name_prefix='g05-probe') as pool:
        futures={}
        try:
            for label,probe in probes.items():
                futures[pool.submit(observe,probe)]=label
            for future in as_completed(futures):
                label=futures[future]
                values[label],durations[label]=future.result()
        except Exception:
            on_failure()
            for future in futures:future.cancel()
            raise
    if set(values)!=set(probes):
        on_failure()
        raise RuntimeError('Incomplete fleet resource observation')
    return {'values':values,'durations_seconds':durations}
