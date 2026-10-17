"""Export bounded structured evidence; raw logs/fixtures remain private."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re

STATIC={'ownership.json','metadata.json','manifest.json','launch-manifest.json','completion.json','cleanup.json','capacity.json','capacity-probes.json','invariants.json','resource-violations.json','watchdog-stop.json','retention.json','checkpoint.json','snapshot.json','restore.json','filesystem-exhaustion.json','declared-oom.json','cross-project-preflight.json','error.json','soak-processes-before.json','soak-processes-after.json','generator-emergency-stop.json','session-canary.json','mutation-boundaries.json','deadlock.json'}
PHASE=re.compile(r'^(?:fresh-|read-|rls-|panel-|storage-|login-|refresh-|mixed-|write-|balanced-|noisy-|capacity-|calibrate-|stress-|overload-|spike-|recovery-|database-|app-|oom-|container-|filesystem-|snapshot-|provider-|baseline|soak)[a-z0-9-]*\.json$')
SENSITIVE=re.compile(r'(?:password|secret|cookie|authorization|access_token|refresh_token|signed_url|token_hash|jwt)$',re.I)
STATIC.add('memory-events-violation.json')
STATIC.add('failure-diagnostics.json')
STATIC.add('resource-plateaus.json')
STATIC.add('lost-commit-replies.json')
STATIC.update({'webhook-invariants.json', 'webhook-cleanup.json'})
STATIC.add('proxy.json')
STATIC.add('proxy-reload-failure.json')
STATIC.add('proxy-reload-gates.json')
STATIC.add('proxy-startup-failure.json')
STATIC.add('native-guards.json')
STATIC.add('native-arrivals.json')
STATIC.add('cpu-allocation.json')
STATIC.add('preflight-budget.json')
STATIC.add('allocation-summary.json')
STATIC.add('acceptance-failures.json')
STATIC.update({'observer-reconnection.json', 'sparse-counter-before-after.json'})
FREEFORM={'message','diagnostic','error','stack','traceback','sql','payload','body'}


def sanitize(value):
    if isinstance(value,list):
        return [sanitize(item) for item in value]
    if isinstance(value,dict):
        result={}
        for key,item in value.items():
            if SENSITIVE.search(key) or key in FREEFORM:
                result[key]='<retained in private raw diagnostics>'
                continue
            if key=='reason' and (not isinstance(item,str) or not re.fullmatch('[a-z0-9_]{1,80}',item)):
                result[key]='<retained in private raw diagnostics>'
                continue
            result[key]=sanitize(item)
        return result
    if isinstance(value,str):
        value=re.sub(r'(?i)((?:x-amz-(?:signature|credential|security-token)|access_token|refresh_token|token)=)[^&\s"\\]+',r'\1<redacted>',value)
        value=re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','<redacted JWT>',value)
        value=re.sub(r'(?i)(postgres(?:ql)?://)[^@\s]+@',r'\1<redacted>@',value)
        return value
    if isinstance(value,float) and not math.isfinite(value):
        raise ValueError('Non-finite evidence cannot be published as valid')
    return value


def export(source,output):
    if output.exists() and any(output.iterdir()):
        raise ValueError('Preserve prior evidence; use a fresh bundle directory')
    output.mkdir(parents=True,exist_ok=True)
    index={'source_run':source.name,'status':'incomplete','certifies_g05':False,'raw_logs_and_fixtures_published':False,'files':[],'invalid_evidence':[]}
    for path in sorted(source.glob('*.json')):
        if path.is_symlink() or (path.name not in STATIC and not PHASE.fullmatch(path.name)) or 'metrics-raw' in path.name:
            continue
        try:
            body=path.read_bytes()
            if len(body)>4*1024*1024:
                raise ValueError('Structured evidence exceeded its byte budget')
            value=sanitize(json.loads(body))
            encoded=json.dumps(value,indent=2,allow_nan=False)+'\n'
            (output/path.name).write_text(encoded)
            index['files'].append({'name':path.name,'raw_sha256':hashlib.sha256(body).hexdigest(),'published_sha256':hashlib.sha256(encoded.encode()).hexdigest()})
            if path.name=='completion.json':
                index['status']=value.get('status','incomplete')
        except (OSError,ValueError,TypeError) as error:
            index['invalid_evidence'].append({'name':path.name,'error_type':type(error).__name__})
    ledger=source/'traffic-ledger.jsonl'
    if ledger.is_file() and not ledger.is_symlink():
        lines=ledger.read_bytes()
        if len(lines)>1024*1024:
            raise ValueError('Traffic evidence exceeded its byte budget')
        records=[sanitize(json.loads(line)) for line in lines.splitlines()]
        (output/'traffic-ledger.json').write_text(json.dumps(records,indent=2,allow_nan=False)+'\n')
    if index['invalid_evidence']:
        index['status']='invalid evidence'
    (output/'bundle-manifest.json').write_text(json.dumps(index,indent=2,allow_nan=False)+'\n')
    return index


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    export(args.source,args.output)


if __name__=='__main__':
    main()
