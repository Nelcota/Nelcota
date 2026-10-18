#!/usr/bin/env python3
"""Recover only a checksummed numeric series from an existing public artifact."""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import zlib

GAUGES={'memory_current_bytes','memory_peak_bytes','anonymous_bytes','tasks','oom_events','oom_kills','cpu_throttled_usec'}
MATRIX_PHASES={'preparation','ready','baseline','snapshot','snapshot-under-writers','restore-preparation','reconciliation','teardown',
               *{'capacity-'+str(percent) for percent in [25,50,75,100]},
               *{'matrix-'+name for name in ['admin-budgets','admin-cancellation','catalog-recovery','hostile-backend','auth-links']}}
BROWSER_PHASES={'preparation','untrusted-ca','live-panel-sdk','teardown'}


def require(condition):
    if not condition:
        raise ValueError('Invalid bounded public resource evidence')


def pairs(items):
    value={}
    for key,item in items:
        require(key not in value)
        value[key]=item
    return value


def read_json(raw):
    return json.loads(raw,object_pairs_hook=pairs)


def validate_series(raw, metadata, kind):
    require(kind in {'matrix','browser-auth'} and isinstance(raw,bytes) and 18<=len(raw)<=18432
            and hashlib.sha256(raw).hexdigest()==metadata['sha256'] and len(raw)==metadata['compressed_bytes'])
    require(raw[:3]==b'\x1f\x8b\x08' and raw[3] in {0,8} and raw[4:8]==bytes(4))
    if raw[3]==8:
        require(raw[10:].split(b'\0',1)[0]==b'resources.jsonl')
    decoder=zlib.decompressobj(31)
    decoded=decoder.decompress(raw,4*1024**2+1)
    require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail and len(decoded)<=4*1024**2)
    phases=MATRIX_PHASES;roles={'app-0','app-1','pg-0','pg-1'}
    if kind=='browser-auth':
        phases=BROWSER_PHASES;roles={'app-0','app-1','pg-0','proxy','browser'}
    lines=decoded.splitlines(keepends=True)
    require(2<=len(lines)<=600)
    previous=None;maximum_gap=0
    for line in lines:
        require(line.endswith(b'\n') and len(line)<=16384)
        value=read_json(line)
        require(isinstance(value,dict) and set(value)=={'monotonic','phase','components'}
                and isinstance(value['phase'],str) and value['phase'] in phases)
        now=value['monotonic'];components=value['components']
        require(type(now) in {int,float} and math.isfinite(now) and now>=0
                and isinstance(components,dict) and bool(components) and set(components)<=roles)
        if previous is not None:
            require(now>=previous);maximum_gap=max(maximum_gap,now-previous)
        previous=now
        for gauges in components.values():
            require(isinstance(gauges,dict) and set(gauges)==GAUGES
                    and all(type(number) is int and 0<=number<2**63 for number in gauges.values()))
    require(type(metadata['samples']) is int and metadata['samples']==len(lines)
            and type(metadata['maximum_gap_seconds']) in {int,float} and math.isfinite(metadata['maximum_gap_seconds'])
            and math.isclose(metadata['maximum_gap_seconds'],maximum_gap,abs_tol=1e-6,rel_tol=0))
    return {'samples':len(lines),'maximum_gap_seconds':maximum_gap}


def notices(report, raw, kind, run, publisher):
    require(isinstance(run,str) and re.fullmatch('[1-9][0-9]{0,19}',run) is not None
            and isinstance(publisher,str) and re.fullmatch('[0-9a-f]{40}',publisher) is not None)
    prefix='native-matrix-'
    if kind=='browser-auth':prefix='native-browser-auth-'
    require(re.fullmatch(prefix+run+'-[0-9]{1,4}',report['identity']) is not None
            and re.fullmatch('[0-9a-f]{40}',report['source']) is not None
            and re.fullmatch('[0-9a-f]{64}',report['binary_sha256']) is not None
            and report['certifies_g05'] is False and report['status'] in {'passed','failed'}
            and type(report['cleanup_confirmed']) is bool)
    metadata=report['checks']['resource_evidence']
    observed=validate_series(raw,metadata,kind)
    encoded=base64.b64encode(raw).decode('ascii')
    parts=[encoded[index:index+3000] for index in range(0,len(encoded),3000)]
    require(1<=len(parts)<=9)
    proof={'original_identity':report['identity'],'original_source':report['source'],'binary_sha256':report['binary_sha256'],
           'original_report_sha256':hashlib.sha256(json.dumps(report,separators=(',',':'),allow_nan=False).encode()).hexdigest(),
           'publisher_source':publisher,'sha256':metadata['sha256'],'compressed_bytes':len(raw),'parts':len(parts),
           'original_status':report['status'],'original_cleanup_confirmed':report['cleanup_confirmed'],
           'encoding':'original-gzip+base64','kind':kind,'local_effective_load_credit_seconds':0,**observed}
    result=[('Resource evidence summary',proof)]
    result += [('Resource evidence payload',{'part':index,'parts':len(parts),'sha256':metadata['sha256'],'payload':part}) for index,part in enumerate(parts,1)]
    output=[]
    for title,value in result:
        content=json.dumps(value,separators=(',',':'),allow_nan=False).replace('%','%25').replace('\r','%0D').replace('\n','%0A')
        line='::notice title='+title+'::'+content
        require(len(line.encode())<=4000);output.append(line)
    return output


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('--kind',choices=['matrix','browser-auth'],required=True)
    parser.add_argument('--run',required=True)
    args=parser.parse_args()
    root=args.directory.resolve(strict=True)
    filename='matrix.json'
    if args.kind=='browser-auth':filename='browser-auth.json'
    reports=list(root.rglob(filename));require(len(reports)==1)
    path=reports[0]
    require(path.resolve(strict=True).is_relative_to(root) and not path.is_symlink() and path.stat().st_size<=65536)
    report=read_json(path.read_bytes())
    resource=path.with_name('resources.jsonl.gz')
    require(not resource.is_symlink() and resource.is_file() and 0<resource.stat().st_size<=18432)
    for line in notices(report,resource.read_bytes(),args.kind,args.run,os.environ.get('GITHUB_SHA','')):
        print(line,flush=True)


if __name__=='__main__':main()
