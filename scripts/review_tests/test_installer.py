"""Verify user installation and checksum protection before binary replacement."""

import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class Installer(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.tools = self.root / "tools"
        self.tools.mkdir()
        self.binary = self.root / "binary"
        self.binary.write_text("#!/bin/sh\nprintf 'nelcota fixture-version\\n'\n")
        self.checksum = self.root / "checksum"
        self.checksum.write_text(hashlib.sha256(self.binary.read_bytes()).hexdigest() +
                                 "  nelcota-x86_64-unknown-linux-musl\n")
        self.tool("id", "#!/bin/sh\nprintf '1000\\n'\n")
        self.tool("uname", "#!/bin/sh\ncase \"$1\" in -s) echo Linux;; -m) echo x86_64;; esac\n")
        self.tool("sudo", "#!/bin/sh\necho unexpected-sudo >&2\nexit 99\n")
        self.tool("curl", """#!/bin/sh
set -eu
case "$2" in *.sha256) source_file=$FIXTURE_CHECKSUM;; *) source_file=$FIXTURE_BINARY;; esac
cp "$source_file" "$4"
""")
        self.environment = dict(os.environ, PATH=str(self.tools) + os.pathsep + os.environ["PATH"],
                                PREFIX=str(self.root / "user/bin"), NELCOTA_VERSION="fixture",
                                NELCOTA_SKIP_DOCKER="1", FIXTURE_BINARY=str(self.binary),
                                FIXTURE_CHECKSUM=str(self.checksum))

    def tool(self, name, source):
        path = self.tools / name
        path.write_text(source)
        path.chmod(0o755)

    def install(self, *arguments):
        # A new session has no controlling terminal, like `curl | sh` over CI.
        return subprocess.run(["sh", str(ROOT / "scripts/install.sh"), *arguments],
                              env=self.environment, capture_output=True, text=True,
                              timeout=10, start_new_session=True)

    def setup_vps(self, *arguments):
        """Runs setup mode as a fake root with logging package/service tools."""
        self.log = self.root / "calls.log"
        self.environment["CALLS"] = str(self.log)
        self.binary.write_text('#!/bin/sh\nprintf \'nelcota %s\\n\' "$*" >> "$CALLS"\n')
        self.checksum.write_text(hashlib.sha256(self.binary.read_bytes()).hexdigest() +
                                 "  nelcota-x86_64-unknown-linux-musl\n")
        self.tool("id", "#!/bin/sh\nprintf '0\\n'\n")
        for name in ("apt-get", "systemctl", "ufw", "docker"):
            self.tool(name, f'#!/bin/sh\nprintf \'{name} %s\\n\' "$*" >> "$CALLS"\n')
        self.host = self.root / "host dir"
        return self.install("--dir", str(self.host), *arguments)

    def calls(self):
        return self.log.read_text().splitlines()

    def test_writable_prefix_needs_no_sudo_and_handles_spaces(self):
        self.environment["PREFIX"] = str(self.root / "user folder/bin")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        destination = Path(self.environment["PREFIX"]) / "nelcota"
        self.assertEqual(destination.read_bytes(), self.binary.read_bytes())
        self.assertEqual(destination.stat().st_mode & 0o777, 0o755)

    def test_bad_checksum_preserves_existing_installation(self):
        destination = Path(self.environment["PREFIX"]) / "nelcota"
        destination.parent.mkdir(parents=True)
        destination.write_text("previous installation")
        self.checksum.write_text("0" * 64 + "  nelcota-x86_64-unknown-linux-musl\n")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum does not match", result.stderr)
        self.assertEqual(destination.read_text(), "previous installation")


    def test_setup_prepares_the_machine_then_creates_and_starts_the_host(self):
        self.environment["SSH_CONNECTION"] = "203.0.113.9 51000 198.51.100.4 2222"
        result = self.setup_vps("api.example.com", "--firewall", "--email", "me@example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn("systemctl enable --now cron.service", calls)
        self.assertTrue(any(c.startswith("apt-get install") and " ufw " in c for c in calls), calls)
        self.assertIn("ufw allow 2222/tcp", calls)
        nelcota = [c for c in calls if c.startswith("nelcota -C")]
        self.assertEqual(nelcota, [
            f"nelcota -C {self.host} init --yes api.example.com --firewall --email me@example.com",
            f"nelcota -C {self.host} up",
        ])
        self.assertLess(calls.index("systemctl enable --now cron.service"),
                        calls.index(nelcota[0]))

    def test_setup_skips_init_when_the_host_exists(self):
        self.host = self.root / "host dir"
        self.host.mkdir()
        (self.host / "nelcota-host.json").write_text("{}")
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith("nelcota -C")],
                         [f"nelcota -C {self.host} up"])

    def test_systemd_runtime_does_not_install_docker(self):
        result = self.setup_vps("api.example.com", "--runtime", "systemd")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"nelcota -C {self.host} init --yes api.example.com --runtime systemd",
                      self.calls())
        self.assertNotIn("get.docker.com", result.stdout)

    def test_setup_requires_root_before_changing_anything(self):
        self.tool("apt-get", "#!/bin/sh\necho unexpected-apt >&2\nexit 99\n")
        result = self.install("api.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("needs root", result.stderr)
        self.assertNotIn("unexpected-apt", result.stderr)


if __name__ == "__main__":
    unittest.main()
