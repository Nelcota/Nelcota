"""Bounded-memory, secret-free signed-event evidence for long campaigns."""
from collections import deque
from pathlib import Path
import sqlite3
import threading


class EventLedger:
    def __init__(self, path: Path):
        self.recent = deque(maxlen=2048)
        self.lock = threading.RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.execute('PRAGMA journal_mode=WAL')
        self.connection.execute('PRAGMA cache_size=-2048')
        self.connection.execute('CREATE TABLE observed(event_id TEXT PRIMARY KEY, raw_hash TEXT NOT NULL, deliveries INTEGER NOT NULL)')
        self.connection.execute('CREATE TABLE expected(event_id TEXT PRIMARY KEY)')
        self.connection.commit()

    def append(self, value):
        with self.lock:
            self._append(value)

    def _append(self, value):
        try:
            event, digest = value['event_id'], value['raw_hash']
            row = self.connection.execute('SELECT raw_hash FROM observed WHERE event_id=?', (event,)).fetchone()
            if row and row[0] != digest:
                raise ValueError('Same event identity changed signed bytes')
            self.connection.execute('INSERT INTO observed VALUES(?,?,1) ON CONFLICT(event_id) DO UPDATE SET deliveries=deliveries+1', (event, digest))
            self.connection.commit()
            self.recent.append(value)
        except sqlite3.Error:
            raise ValueError('Observer ledger could not persist event evidence') from None

    def __len__(self):
        return len(self.recent)

    def validate(self, expected_ids):
        with self.lock:
            return self._validate(expected_ids)

    def preserve_expected(self, identities):
        with self.lock:
            self.connection.executemany('INSERT OR IGNORE INTO expected VALUES(?)', [(identity,) for identity in identities])
            self.connection.commit()

    def _validate(self, expected_ids):
        # Load expected identities in bounded batches rather than retaining a set.
        batch = []
        for identity in expected_ids:
            batch.append((identity,))
            if len(batch) == 1000:
                self.connection.executemany('INSERT OR IGNORE INTO expected VALUES(?)', batch)
                batch.clear()
        self.connection.executemany('INSERT OR IGNORE INTO expected VALUES(?)', batch)
        self.connection.commit()
        missing = self.connection.execute('SELECT count(*) FROM expected LEFT JOIN observed USING(event_id) WHERE observed.event_id IS NULL').fetchone()[0]
        extra = self.connection.execute('SELECT count(*) FROM observed LEFT JOIN expected USING(event_id) WHERE expected.event_id IS NULL').fetchone()[0]
        unique, deliveries = self.connection.execute('SELECT count(*), coalesce(sum(deliveries),0) FROM observed').fetchone()
        return {'unique_events': unique, 'deliveries': deliveries, 'duplicates': deliveries-unique, 'missing': missing, 'extra': extra}

    def close(self):
        self.connection.close()
