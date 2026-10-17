"""Close read-only SQLite evidence before compression and space accounting."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3


def verify_closed_database(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_uid!=os.getuid():
        raise ValueError('SQLite evidence is not an owned regular file')
    if any(path.with_name(path.name+suffix).exists() for suffix in ['-wal','-shm','-journal']):
        raise ValueError('SQLite evidence still has a journal or shared-memory owner')
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro&immutable=1',uri=True,timeout=5)) as database:
        if database.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:
            raise ValueError('Retained SQLite evidence failed integrity verification')
