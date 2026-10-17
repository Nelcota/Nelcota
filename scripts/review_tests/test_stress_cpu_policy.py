"""CPU latency experiments must preserve the declared aggregate bandwidth."""
from pathlib import Path
import math
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from projects import cpu_arguments


class ProjectCPUBudget(unittest.TestCase):
    def test_short_period_never_increases_the_independent_host_cpu_budget(self):
        for count in [1,5,10]:
            for period in [10000,100000]:
                arguments=cpu_arguments(count,period)
                bandwidth=float(arguments[1])
                if arguments[0]!='--cpus':
                    bandwidth=int(arguments[3])/int(arguments[1])
                    self.assertGreaterEqual(int(arguments[3]),1000)
                self.assertAlmostEqual(count*bandwidth,1)

    def test_invalid_or_unrepresentable_policy_is_rejected_before_resources(self):
        for count,period in [(0,10000),(True,10000),(11,10000),(3,10000),(math.nan,10000),(1,math.nan),(1,True),(1,1000),(1,10000.0),(1,None)]:
            with self.subTest(count=count,period=period),self.assertRaises(ValueError):
                cpu_arguments(count,period)


if __name__=='__main__':
    unittest.main()
