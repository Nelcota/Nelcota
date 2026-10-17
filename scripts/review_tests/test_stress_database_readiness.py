"""Owned project readiness must exercise the final authenticated TCP server."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'bench'))
from projects import Project


class ProjectDatabaseReadiness(unittest.TestCase):
    def project(self, result='1'):
        project=Project.__new__(Project)
        project.pg='owned-postgres'
        project.docker=Mock(return_value=result)
        return project

    def test_final_tcp_path_and_generated_credential_are_both_required(self):
        project=self.project()
        self.assertTrue(project.database_ready('private-generated-password'))
        args,kwargs=project.docker.call_args
        self.assertIn('-h',args)
        self.assertEqual(args[args.index('-h')+1],'127.0.0.1')
        self.assertIn('PGCONNECT_TIMEOUT=2',args)
        self.assertEqual(kwargs['env'],{'PGPASSWORD':'private-generated-password'})
        self.assertNotIn('private-generated-password',str(args))

    def test_missing_credential_never_falls_back_to_local_trust(self):
        for credential in ['',None,False]:
            project=self.project()
            with self.subTest(credential=credential),self.assertRaises(ValueError):
                project.database_ready(credential)
            project.docker.assert_not_called()

    def test_unexpected_query_output_is_not_readiness(self):
        for result in ['', '0','1\nprivate',None]:
            with self.subTest(result=result):
                self.assertFalse(self.project(result).database_ready('generated-password'))
