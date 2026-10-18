"""Build and retain an optional glibc allocation observer, never a capacity proof."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def validate_library(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size>1024*1024:
        raise ValueError('Invalid owned allocation observer library')
    manifest=path.with_suffix('.json')
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size>16384:
        raise ValueError('Missing bounded allocation observer build provenance')
    value=json.loads(manifest.read_text())
    if not isinstance(value,dict) or isinstance(value.get('schema'),bool) or value.get('schema')!=1 or value.get('kind')!='owned glibc mallinfo2 diagnostic' or value.get('library_sha256')!=digest(path) or value.get('machine')!=platform.machine():
        raise ValueError('Allocation observer build identity does not match')
    source=Path(__file__).with_name('allocation_probe.c')
    if value.get('source_sha256')!=digest(source):
        raise ValueError('Allocation observer source is not this frozen revision')
    with path.open('rb') as stream:
        if stream.read(4)!=b'\x7fELF':
            raise ValueError('Allocation observer is not a native ELF library')
    return {'kind':value['kind'],'library_sha256':value['library_sha256'],'source_sha256':value['source_sha256'],
            'sample_period_ms':5000,'expected_extra_threads':1,'expected_extra_descriptors':1,'maximum_bytes_per_process':1024*1024,
            'scope':'instrumented ownership diagnostic; cannot certify ordinary performance or G05',
            'in_use_scope':'glibc accounting includes allocator thread caches, not an exact application-object census'}


def retain(source,output):
    """Call after the observed container is removed, before fixture cleanup."""
    source,output=Path(source),Path(output)
    if source.is_symlink() or not source.is_dir() or source.stat().st_uid!=os.getuid():
        raise ValueError('Allocation evidence directory changed ownership')
    files=sorted(source.iterdir())
    if not 1<=len(files)<=8:
        raise ValueError('Unexpected allocation observer process count')
    output.mkdir(mode=0o700)
    summaries=[]
    fields={'schema','pid','monotonic_seconds','monotonic_nanoseconds','in_use_including_mmap_bytes','free_arena_bytes','arena_bytes','mmap_bytes'}
    for path in files:
        name=re.fullmatch(r'alloc-([1-9][0-9]*)-[0-9]+-[0-9]+\.jsonl',path.name)
        if path.is_symlink() or not path.is_file() or name is None or path.stat().st_size>1024*1024:
            raise ValueError('Invalid bounded allocation observation file')
        target=output/path.name
        shutil.copyfile(path,target)
        target.chmod(0o600)
        values=[]
        for line in target.read_text().splitlines(keepends=True):
            if not line.endswith('\n'):
                raise ValueError('Incomplete allocation observation')
            row=json.loads(line)
            if not isinstance(row,dict) or set(row)!=fields or any(isinstance(value,bool) or not isinstance(value,int) or not 0<=value<=2**64-1 for value in row.values()) or row['schema']!=1 or row['pid']!=int(name[1]) or row['monotonic_nanoseconds']>=1000000000:
                raise ValueError('Invalid numeric allocation observation')
            if row['arena_bytes']<row['free_arena_bytes'] or row['in_use_including_mmap_bytes']<row['mmap_bytes']:
                raise ValueError('Inconsistent allocator accounting')
            row['monotonic']=row['monotonic_seconds']+row['monotonic_nanoseconds']/1e9
            if values and (row['monotonic']<=values[-1]['monotonic'] or row['pid']!=values[0]['pid']):
                raise ValueError('Allocation observer process or clock changed')
            values.append(row)
        item={'file':path.name,'bytes':target.stat().st_size,'sha256':digest(target),'samples':len(values)}
        if values:
            item.update({'first':values[0],'last':values[-1],
                         'maximum_in_use_including_mmap_bytes':max(row['in_use_including_mmap_bytes'] for row in values),
                         'maximum_free_arena_bytes':max(row['free_arena_bytes'] for row in values),
                         'maximum_observation_gap_seconds':max([b['monotonic']-a['monotonic'] for a,b in zip(values,values[1:])],default=0)})
        summaries.append(item)
    result={'scope':'allocation ownership diagnostic only; correlate the current process with load/idle intervals before interpretation',
            'certifies_g05':False,'files':summaries,'raw_samples_published':False}
    if not any(item['samples']>=3 for item in summaries):
        raise ValueError('No usable allocation observation sequence')
    ledger=output.parent/'traffic-ledger.jsonl'
    if ledger.is_file():
        completed=[row for row in map(json.loads,ledger.read_text().splitlines()) if row.get('completed') is True]
        coverage=[]
        for row in completed:
            began,ended=row.get('started_monotonic'),row.get('ended_monotonic')
            if any(isinstance(value,bool) or not isinstance(value,(int,float)) for value in [began,ended]) or not 0<=began<ended:
                raise ValueError('Missing allocation/load time correlation')
            covered=any(item['samples']>=3 and item['first']['monotonic']<=began+5 and item['last']['monotonic']>=ended-5 and item['maximum_observation_gap_seconds']<=30 for item in summaries)
            coverage.append({'phase':row['phase'],'covered':covered})
        result['completed_traffic_coverage']=coverage
        if not coverage or not all(row['covered'] for row in coverage):
            raise ValueError('Allocation evidence did not cover completed traffic')
    (output.parent/'allocation-summary.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    return result


def build(output):
    if output.exists() or output.with_suffix('.json').exists() or platform.system()!='Linux' or platform.libc_ver()[0]!='glibc' or shutil.which('cc') is None:
        raise ValueError('A fresh owned build and native Linux glibc/cc are required')
    output.parent.mkdir(parents=True,exist_ok=True)
    source=Path(__file__).with_name('allocation_probe.c')
    flags=['-std=c11','-O2','-Wall','-Wextra','-Werror','-shared','-fPIC','-pthread']
    subprocess.run(['cc',*flags,str(source),'-o',str(output)],check=True,capture_output=True,timeout=20)
    output.chmod(0o555)
    version=subprocess.check_output(['cc','--version'],text=True,timeout=5).splitlines()[0]
    profile={'schema':1,'kind':'owned glibc mallinfo2 diagnostic','source_sha256':digest(source),'library_sha256':digest(output),
             'machine':platform.machine(),'compiler':version,'flags':flags,'scope':'optional development diagnostic; no production runtime dependency'}
    output.with_suffix('.json').write_text(json.dumps(profile,indent=2)+'\n')
    return validate_library(output)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(build(args.build),indent=2))
