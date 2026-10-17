"""Ingress fixture must never bind public/privileged or overlapping endpoints."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'bench'))
from ingress import configuration


class IngressBoundaries(unittest.TestCase):
    def test_unprivileged_owned_loopback_routes_with_internal_trust(self):
        content = configuration([31001, 31002], [32001, 32002])
        self.assertEqual(content.count('bind 127.0.0.1'), 2)
        self.assertEqual(content.count('tls internal'), 2)
        self.assertIn('admin unix//config/admin.sock', content)
        self.assertIn('https://localhost:31001', content)
        self.assertIn('reverse_proxy 127.0.0.1:32002', content)
        self.assertNotIn('0.0.0.0', content)

    def test_privileged_and_non_integer_ports_are_rejected(self):
        for port in [0, 80, 443, 65536, True, 32000.0, '32000\n reverse_proxy attacker.invalid']:
            with self.subTest(port=port):
                with self.assertRaises(ValueError):
                    configuration([port], [33000])
                with self.assertRaises(ValueError):
                    configuration([33000], [port])

    def test_endpoint_aliases_and_proxy_loops_are_rejected(self):
        for frontends, upstreams in [([31001, 31001], [32001, 32002]),
                                    ([31001, 31002], [32001, 32001]),
                                    ([31001, 31002], [32001, 31001])]:
            with self.assertRaises(ValueError):
                configuration(frontends, upstreams)

    def test_invalid_topology_is_rejected(self):
        for frontends, upstreams in [([], []), ([31001], []), (list(range(31001, 31012)), list(range(32001, 32012)))]:
            with self.assertRaises(ValueError):
                configuration(frontends, upstreams)


if __name__ == '__main__':
    unittest.main()
