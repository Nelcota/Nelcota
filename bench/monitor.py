"""Read-only, bounded progress for an existing stress campaign."""
import argparse
import datetime
import json
from pathlib import Path
import time


def load(path):
    if path.is_file():
        return json.loads(path.read_text())
    return {}


def progress(root):
    point = load(root/'checkpoint.json')
    heartbeat = load(root/'heartbeat.json')
    completion = load(root/'completion.json')
    now = time.monotonic()
    result = {'run':root.name,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase':heartbeat.get('phase','preparation'),'completed_load_seconds':point.get('load_seconds_completed',0),'resource_samples':point.get('resource_observations',0)}
    if point:
        result['last_sample_age_seconds']=round(now-point['monotonic'],1)
    if completion:
        result.update(completion)
    for name in ['watchdog-stop','resource-violations']:
        value = load(root/(name+'.json'))
        if value:
            result[name]=value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path)
    parser.add_argument('--maximum-seconds',type=int,default=21600)
    args = parser.parse_args()
    if not 1 <= args.maximum_seconds <= 21600:
        parser.error('Monitoring duration must be bounded to six hours')
    end = time.monotonic()+args.maximum_seconds
    while time.monotonic()<end:
        result=progress(args.output)
        print(json.dumps(result),flush=True)
        if result.get('status') in ('passed','failed'):
            return
        time.sleep(min(45,max(0,end-time.monotonic())))


if __name__ == '__main__':
    main()
