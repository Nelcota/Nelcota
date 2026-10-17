"""A burst policy cannot expand the physical CPU slots or hide profile changes."""
from pathlib import Path
from types import SimpleNamespace
import math
import sys
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from cpu_policy import allocation, checked, verify, validate_proof
from projects import cpu_arguments


class SharedProjectCPUs(unittest.TestCase):
    def projects(self,count):
        return [SimpleNamespace(label='project-'+str(index),app='owned-app-'+str(index),pg='owned-pg-'+str(index)) for index in range(count)]

    def test_burst_quotas_still_have_one_distinct_physical_slot_per_role(self):
        for count in [1,5,10]:
            for period in [10000,100000]:
                profile=allocation(count,[3,7,11,15,19],period,'shared')
                self.assertEqual(profile['quota_usec_each'],period)
                self.assertEqual(profile['configured_quota_sum_per_role'],count)
                self.assertEqual(profile['hard_cpu_ceiling_per_role'],1)
                self.assertEqual(len(set(profile['affinity_slots'].values())),3)
                arguments=cpu_arguments(count,period,'shared')
                if period==100000:self.assertEqual(float(arguments[1]),1)
                if period==10000:self.assertEqual(int(arguments[3])/int(arguments[1]),1)

    def test_missing_or_overlapping_generator_affinity_cannot_provision(self):
        for cpus in [None,[0,1],[0,0,2],[0,1,1],[0,True,2],[0,math.nan,2],[0,-1,2]]:
            with self.subTest(cpus=cpus),self.assertRaises(ValueError):allocation(5,cpus,100000,'shared')
        for policy in [None,True,1,{},'unknown']:
            with self.subTest(policy=policy),self.assertRaises(ValueError):cpu_arguments(5,100000,policy)

    def test_native_single_slot_and_quota_are_required_for_every_project(self):
        declared=allocation(5,[0,1,2],100000,'shared')
        projects=self.projects(5)
        def read(*args):
            slot=0
            if '-pg-' in args[1]:slot=1
            return str(slot)+'\n100000 100000\n'
        owner=mock.Mock(side_effect=read)
        result=verify(owner,projects,declared)
        self.assertEqual(len(result['containers']),10)
        self.assertEqual(owner.call_count,10)
        self.assertEqual(result['status'],'passed')
        for malformed in ['0-1\n100000 100000\n','2\n100000 100000\n','0\n200000 100000\n','0\nmax 100000\n','0\n100000 10000\n','0\n100000 100000\nextra\n']:
            with self.subTest(kernel=malformed),self.assertRaises(ValueError):verify(mock.Mock(return_value=malformed),projects,declared)

    def test_reused_owner_or_false_budget_cannot_certify_a_role_ceiling(self):
        declared=allocation(5,[0,1,2],100000,'shared')
        projects=self.projects(5);projects[1].app=projects[0].app
        owner=mock.Mock()
        with self.assertRaises(ValueError):verify(owner,projects,declared)
        owner.assert_not_called()
        with self.assertRaises(ValueError):verify(owner,self.projects(5),{**declared,'hard_cpu_ceiling_per_role':2})
        owner.assert_not_called()

    def test_boolean_counts_and_incomplete_kernel_census_cannot_certify(self):
        declared=allocation(1,[0,1,2],100000,'shared')
        for change in [{'hard_cpu_ceiling_per_role':True},{'configured_quota_sum_per_role':True},{'quota_oversubscription_within_one_slot':0},{'affinity_slots':{'app':0,'postgres':True,'generator':2}}]:
            with self.subTest(change=change),self.assertRaises(ValueError):checked({**declared,**change},1,[0,1,2],100000)
        proof=verify(mock.Mock(side_effect=['0\n100000 100000\n','1\n100000 100000\n']),self.projects(1),declared)
        for rows in [proof['containers'][:1],[proof['containers'][0]]*2,[{**proof['containers'][0],'quota_usec':100000.0},proof['containers'][1]]]:
            with self.subTest(rows=rows),self.assertRaises(ValueError):validate_proof({**proof,'containers':rows},declared)


if __name__=='__main__':
    unittest.main()
