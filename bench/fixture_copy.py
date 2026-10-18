"""Populate an owned tmpfs through its actual container mount namespace."""
import io
import os
from pathlib import Path
import subprocess
import tarfile
import uuid

from objects import disk_inventory


def copy_to_tmpfs(owned,source,container):
    source=Path(source)
    inventory=disk_inventory(source)
    if not inventory['keys'] or len(inventory['keys'])>64 or inventory['bytes']>1024*1024:
        raise ValueError('Immutable fault fixture must contain 1..64 files and at most 1 MiB')
    archive=io.BytesIO()
    with tarfile.open(fileobj=archive,mode='w') as bundle:
        for key in sorted(inventory['keys']):
            parts=key.split('/')
            if len(parts)!=2 or parts[0]!='bench' or str(uuid.UUID(parts[1]))!=parts[1]:
                raise ValueError('Fault fixture escaped its immutable object prefix')
            entry=tarfile.TarInfo(key)
            entry.mode=0o600
            entry.size=inventory['objects'][key]
            with (source/key).open('rb') as data:
                bundle.addfile(entry,data)
    command=['docker','exec','-i','--user',str(os.getuid())+':'+str(os.getgid()),owned.require(container),'tar','-xf','-','-C','/storage','--no-same-owner']
    completed=subprocess.run(command,input=archive.getvalue(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    if completed.returncode:
        raise RuntimeError('Owned tmpfs fixture copy failed')
    return {'objects':len(inventory['keys']),'bytes':inventory['bytes'],'transport':'bounded tar over owned docker exec stdin','destination':'owned /storage tmpfs'}
