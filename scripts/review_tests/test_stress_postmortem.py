"""Diagnostic retention must not delay a critical stop or replace prior evidence."""
from pathlib import Path
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from postgres_evidence import retain_failure


class PrivatePostmortem(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)

    def test_critical_stop_does_not_start_sql_docker_or_snapshot_io(self):
        owned,sql=mock.Mock(),mock.Mock()
        with mock.patch('postgres_evidence.host_reserves',side_effect=AssertionError('No additional sampling')):
            result=retain_failure(self.root,owned,'owned-pg',sql,unsafe=True)
        self.assertEqual(result['reason'],'critical_resource_stop')
        owned.assert_not_called();sql.assert_not_called()
        self.assertFalse((self.root/'failure-database.dump').exists())

    def test_host_reserve_failure_cannot_start_a_dump(self):
        owned,sql=mock.Mock(),mock.Mock()
        with mock.patch('postgres_evidence.host_reserves',return_value='disk_reserve'):
            retain_failure(self.root,owned,'owned-pg',sql)
        owned.assert_not_called();sql.assert_not_called()

    def test_dump_timeout_is_reported_and_partial_archive_remains_private(self):
        owned=mock.Mock(return_value='private fixture diagnostics')
        owned.require.return_value='a'*64
        with mock.patch('postgres_evidence.host_reserves',return_value=None),mock.patch('postgres_evidence.shutil.which',return_value='/usr/bin/prlimit'),mock.patch('postgres_evidence.subprocess.run',side_effect=subprocess.TimeoutExpired('bounded dump',30)):
            result=retain_failure(self.root,owned,'owned-pg',lambda _:json.dumps({}))
        self.assertEqual(result['status'],'diagnostic_failure')
        self.assertEqual(result['error_type'],'TimeoutExpired')
        self.assertNotIn('snapshot_sha256',result)
        self.assertEqual(stat.S_IMODE((self.root/'failure-database.dump').stat().st_mode),0o600)
        self.assertEqual(json.loads((self.root/'failure-diagnostics.json').read_text())['status'],'diagnostic_failure')

    def test_existing_snapshot_is_preserved(self):
        archive=self.root/'failure-database.dump'
        archive.write_bytes(b'prior retained evidence')
        owned=mock.Mock(return_value='fixture diagnostics')
        owned.require.return_value='a'*64
        with mock.patch('postgres_evidence.host_reserves',return_value=None),mock.patch('postgres_evidence.shutil.which',return_value='/usr/bin/prlimit'),mock.patch('postgres_evidence.subprocess.run') as run:
            result=retain_failure(self.root,owned,'owned-pg',lambda _:json.dumps({}))
        self.assertEqual(result['status'],'diagnostic_failure')
        self.assertEqual(archive.read_bytes(),b'prior retained evidence')
        run.assert_not_called()
