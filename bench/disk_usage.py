"""Allocated usage under concurrent version replacement, without masking I/O errors."""
import os
from pathlib import Path
import re
import subprocess

ROOTS={'/data','/storage','/prometheus','/var/lib/postgresql/data'}


def parse(result,root,unit):
    root=str(root).rstrip('/')
    match=re.fullmatch(r'([0-9]+)\s+'+re.escape(root)+r'/?\s*',result.stdout)
    if result.returncode not in (0,1) or match is None:
        raise RuntimeError('Incomplete allocated-disk observation')
    raced=0
    for line in result.stderr.splitlines():
        child=None
        suffix="': No such file or directory"
        for prefix in ["du: cannot access '","du: cannot read directory '","du: can't open '"]:
            if line.startswith(prefix) and line.endswith(suffix):
                child=line[len(prefix):-len(suffix)]
        if line.startswith('du: ') and line.endswith(': No such file or directory') and child is None:
            child=line[len('du: '):-len(': No such file or directory')]
        if child is None or not child.startswith(root+'/') or '..' in Path(child).parts:
            raise RuntimeError('Unsafe disk observation error: '+line[-800:])
        raced+=1
    if result.returncode==1 and not raced:
        raise RuntimeError('Disk observation failed without a known child-removal race')
    return {'value':int(match[1]),'unit':unit,'disappearing_entries':raced,'method':'allocated du total; concurrent child ENOENT counted'}


def container(owned,name,root,unit='m'):
    if root not in ROOTS or unit not in ('m','k'):
        raise ValueError('Disk observation escaped a declared fixture mount')
    result=subprocess.run(['docker','exec','-e','LC_ALL=C',owned.require(name),'du','-s'+unit,root],capture_output=True,text=True,timeout=10)
    return parse(result,root,unit)


def host(root,unit='m'):
    root=Path(root)
    if unit not in ('m','k') or root.is_symlink() or not root.is_dir():
        raise ValueError('Owned fixture directory is missing or changed identity')
    result=subprocess.run(['du','-s'+unit,str(root)],capture_output=True,text=True,timeout=10,env={**os.environ,'LC_ALL':'C'})
    return parse(result,root,unit)
