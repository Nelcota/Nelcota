"""Bounded, fixed-vocabulary browser failure evidence; never private log text."""
from collections import Counter
import re

from project_diagnostics import component, snapshot, validate as validate_project
from project_diagnostics import validate_component

PATTERNS = {'python-import':['modulenotfounderror','no module named'],
            'missing-playwright':["no module named 'playwright'"],
            'python-encodings':["no module named 'encodings'"],
            'native-loader':['error while loading shared libraries','libpython'],
            'browser-launch':['browsertype.launch','targetclosederror'],
            'browser-sandbox':['no usable sandbox'],
            'permission':['permission denied'],
            'disk-full':['no space left on device']}
PROBES = {'host-reserves','components','cgroups','driver','database','disk','append'}
ERRORS = {'RuntimeError','ValueError','OSError','TimeoutError','KeyError','TypeError','other'}
MARKERS = {'driver-ready','driver-start','driver-finished','driver-release'}
LABELS = {'untrusted-ca','live-panel-SDK'}


def require(condition):
    if not condition:
        raise ValueError('Invalid fixed browser failure diagnostic')


def log_projection(raw, total_bytes):
    require(isinstance(raw,bytes) and type(total_bytes) is int and total_bytes>=len(raw))
    raw=raw[-65536:]
    text=raw.decode('utf-8',errors='replace')
    folded=text.casefold()
    value={'observed_log_bytes':len(raw),'log_truncated':total_bytes>len(raw),
           'categories':{key:sum(folded.count(pattern) for pattern in patterns) for key,patterns in PATTERNS.items()},
           'driver_lines':sorted({int(line) for line in re.findall(r'File "/driver\.py", line ([0-9]{1,5})\b',text) if 1<=int(line)<=10000})[:16]}
    validate_log(value)
    return value


def validate_log(value):
    require(isinstance(value,dict) and set(value)=={'observed_log_bytes','log_truncated','categories','driver_lines'})
    require(type(value['observed_log_bytes']) is int and 0<=value['observed_log_bytes']<=65536
            and type(value['log_truncated']) is bool and isinstance(value['categories'],dict)
            and set(value['categories'])==set(PATTERNS)
            and all(type(count) is int and 0<=count<=65536 for count in value['categories'].values()))
    lines=value['driver_lines']
    require(isinstance(lines,list) and len(lines)<=16 and all(type(line) is int and 1<=line<=10000 for line in lines)
            and lines==sorted(set(lines)))


def collect(output, source, consumer, owned, generator, violations):
    drivers={}
    for label in sorted(LABELS):
        folder=output/label
        log=output/(label+'.log')
        value={'markers':{marker:(folder/marker).is_file() for marker in sorted(MARKERS)}}
        if log.is_file() and not log.is_symlink():
            with log.open('rb') as stream:
                size=stream.seek(0,2)
                stream.seek(max(0,size-65536))
                value['log']=log_projection(stream.read(65536),size)
        drivers[label]=value
    counts=Counter()
    for row in violations:
        probe,kind=row.get('probe','other'),row.get('type','other')
        if probe not in PROBES:probe='other'
        if kind not in ERRORS:kind='other'
        counts[(probe,kind)]+=1
    failures=[{'probe':probe,'type':kind,'count':count} for (probe,kind),count in sorted(counts.items())]
    value={'source':snapshot(source),'consumer':component(owned,consumer.app),
           'driver':component(owned,generator),'drivers':drivers,'resource_failures':failures}
    return validate(value)


def validate(value):
    require(isinstance(value,dict) and set(value)=={'source','consumer','driver','drivers','resource_failures'})
    validate_project(value['source'])
    validate_component(value['consumer']);validate_component(value['driver'])
    require(isinstance(value['drivers'],dict) and set(value['drivers'])==LABELS)
    for driver in value['drivers'].values():
        require(isinstance(driver,dict) and set(driver) in ({'markers'},{'markers','log'}))
        require(isinstance(driver['markers'],dict) and set(driver['markers'])==MARKERS
                and all(type(state) is bool for state in driver['markers'].values()))
        if 'log' in driver:
            validate_log(driver['log'])
    failures=value['resource_failures']
    require(isinstance(failures,list) and len(failures)<=64)
    for row in failures:
        require(isinstance(row,dict) and set(row)=={'probe','type','count'}
                and isinstance(row['probe'],str) and row['probe'] in PROBES|{'other'}
                and isinstance(row['type'],str) and row['type'] in ERRORS
                and type(row['count']) is int and 1<=row['count']<=10000)
    return value
