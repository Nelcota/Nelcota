"""Archive verification must release descriptors on success and failure."""
from contextlib import closing
import hashlib
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from sqlite_evidence import verify_closed_database


class SQLiteArchiveOwnership(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        self.path=self.root/'events.sqlite'
        with closing(sqlite3.connect(self.path)) as database:
            database.execute('CREATE TABLE events(id INTEGER PRIMARY KEY)')
            database.executemany('INSERT INTO events VALUES(?)',[(index,) for index in range(100)])
            database.commit()

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor ownership evidence is unavailable')
    def test_repeated_verification_releases_every_descriptor_and_preserves_bytes(self):
        before=hashlib.sha256(self.path.read_bytes()).hexdigest()
        owners=len(os.listdir('/proc/self/fd'))
        for _ in range(40):verify_closed_database(self.path)
        self.assertEqual(len(os.listdir('/proc/self/fd')),owners)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(),before)
        self.assertEqual(list(self.root.iterdir()),[self.path])

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor ownership evidence is unavailable')
    def test_failed_integrity_query_also_closes_its_connection(self):
        self.path.write_bytes(b'invalid SQLite evidence')
        owners=len(os.listdir('/proc/self/fd'))
        for _ in range(10):
            with self.assertRaises(sqlite3.DatabaseError):verify_closed_database(self.path)
        self.assertEqual(len(os.listdir('/proc/self/fd')),owners)

    def test_existing_sidecar_prevents_treating_a_live_database_as_closed(self):
        sidecar=self.path.with_name(self.path.name+'-wal')
        sidecar.write_bytes(b'owned live journal sentinel')
        with self.assertRaises(ValueError):verify_closed_database(self.path)
        self.assertEqual(sidecar.read_bytes(),b'owned live journal sentinel')

    def test_symlink_cannot_select_another_evidence_database(self):
        alias=self.root/'alias.sqlite'
        alias.symlink_to(self.path)
        before=self.path.read_bytes()
        with self.assertRaises(ValueError):verify_closed_database(alias)
        self.assertEqual(self.path.read_bytes(),before)


if __name__=='__main__':
    unittest.main()
