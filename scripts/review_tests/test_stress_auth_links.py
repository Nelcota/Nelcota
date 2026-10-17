"""Single-use race oracles reject duplicate or foreign successful sessions."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'bench'))
from auth_link_pressure import rejected, winner


class SingleUseLinkOracle(unittest.TestCase):
    def results(self):
        return [(200, {'user': {'id': 'generated-user'}, 'access_token': 'private-access', 'refresh_token': 'private-refresh'}),
                *[(400, {'code': 'invalid_grant'}) for _ in range(3)]]

    def test_exactly_one_valid_session_is_required(self):
        self.assertEqual(winner(self.results(), 'generated-user')['user']['id'], 'generated-user')
        for status in [200, 503, True]:
            values = self.results()
            values[-1] = (status, values[0][1])
            with self.subTest(status=status), self.assertRaises(RuntimeError):
                winner(values, 'generated-user')

    def test_foreign_or_incomplete_winners_never_satisfy_single_use(self):
        for change in [{'user': {'id': 'foreign-user'}}, {'access_token': None}, {'refresh_token': ''}]:
            values = self.results()
            values[0] = (200, {**values[0][1], **change})
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                winner(values, 'generated-user')
        with self.assertRaisesRegex(RuntimeError, 'Incomplete'):
            winner(self.results()[:3], 'generated-user')

    def test_only_the_declared_negative_contract_is_accepted(self):
        for status, body in [(200, {'code': 'invalid_grant'}), (401, {'code': 'invalid_grant'}),
                             (400, {'code': 'internal_error'}), (400, None)]:
            with self.subTest(status=status, body=body), self.assertRaises(RuntimeError):
                rejected(status, body)


if __name__ == '__main__':
    unittest.main()
