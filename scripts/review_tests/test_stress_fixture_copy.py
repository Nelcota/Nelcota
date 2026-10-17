"""Fault setup preserves actual bytes and never archives foreign/symlink data."""
from pathlib import Path
import io
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from fixture_copy import copy_to_tmpfs


class ImmutableFaultCopy(unittest.TestCase):
    def test_bytes_reach_container_stdin_under_an_immutable_owned_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            key='bench/'+str(uuid.uuid4())
            (root/'bench').mkdir()
            (root/key).write_bytes(b'published immutable bytes')
            owned=mock.Mock()
            owned.require.return_value='a'*64
            with mock.patch('fixture_copy.subprocess.run',return_value=subprocess.CompletedProcess([],0,b'',b'')) as run:
                result=copy_to_tmpfs(owned,root,'owned-app')
            command=run.call_args.args[0]
            self.assertIn('a'*64,command)
            self.assertNotIn('owned-app',command)
            self.assertEqual(result['objects'],1)
            with tarfile.open(fileobj=io.BytesIO(run.call_args.kwargs['input']),mode='r') as archive:
                self.assertEqual(archive.getnames(),[key])
                self.assertEqual(archive.extractfile(key).read(),b'published immutable bytes')

    def test_symlinks_and_unpublished_names_never_reach_exec(self):
        for kind in ['symlink','unpublished']:
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                (root/'bench').mkdir()
                path=root/'bench/foreign'
                if kind=='symlink':path.symlink_to('/etc/passwd')
                if kind=='unpublished':path.write_bytes(b'invalid key')
                owned=mock.Mock()
                with mock.patch('fixture_copy.subprocess.run') as run:
                    with self.assertRaises((ValueError,RuntimeError)):copy_to_tmpfs(owned,root,'owned-app')
                owned.require.assert_not_called();run.assert_not_called()

    def test_byte_budget_is_checked_before_constructing_or_sending_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'bench').mkdir()
            (root/('bench/'+str(uuid.uuid4()))).write_bytes(b'x'*(1024*1024+1))
            owned=mock.Mock()
            with mock.patch('fixture_copy.subprocess.run') as run:
                with self.assertRaises(ValueError):copy_to_tmpfs(owned,root,'owned-app')
            owned.require.assert_not_called();run.assert_not_called()
