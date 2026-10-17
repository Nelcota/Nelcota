"""VFS preparation must not consume the reserve before measured traffic starts."""
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'bench'))
from campaign import validate_disk_headroom
from host_campaign import startup_disk_budget


class StartupHeadroom(unittest.TestCase):
    def images(self, driver='vfs'):
        return [{'Size':size*1024**2, 'GraphDriver':{'Name':driver}} for size in [80, 200]]

    def test_vfs_copy_cost_rejects_a_profile_the_old_guard_admitted(self):
        filesystem = mock.Mock(f_blocks=10000, f_bavail=6500, f_frsize=1024**2)
        with mock.patch('campaign.os.statvfs', return_value=filesystem):
            validate_disk_headroom(ROOT, 1024, startup_mib=5*400+512)
            budget = startup_disk_budget(self.images(), 5, True)
            with self.assertRaises(RuntimeError):
                validate_disk_headroom(ROOT, 1024, startup_mib=budget['total_startup_mib'])

    def test_unknown_or_invalid_image_evidence_cannot_invent_headroom(self):
        for size in [None, True, -1, 0, float('nan'), float('inf'), 3*1024**3]:
            images = self.images()
            images[0]['Size'] = size
            with self.subTest(size=size), self.assertRaises(ValueError):
                startup_disk_budget(images, 10)
        with self.assertRaises(ValueError):
            startup_disk_budget(self.images('unmeasured-storage'), 10)


if __name__ == '__main__':
    unittest.main()
