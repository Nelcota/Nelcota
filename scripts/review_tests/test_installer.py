"""Verify user installation and checksum protection before binary replacement."""

import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts/install.sh"
VERSION = "1.2.3"
BIN = "nelcota-x86_64-unknown-linux-musl"
# Real system commands the tests replace with fakes, or remove to simulate a
# machine without them. Everything else comes from the system folders.
FAKED = {"apt-get", "curl", "debconf-set-selections", "dnf", "docker", "firewall-cmd", "free", "id",
         "mkswap", "sleep", "sudo", "swapon", "systemctl", "ufw", "uname"}

# Records every call, serves the fixtures and answers the latest-release
# redirect like GitHub. FIXTURE_MISSING makes downloads fail like a 404.
FAKE_CURL = """#!/bin/sh
set -eu
printf 'curl %s\\n' "$*" >> "$CALLS"
out=""; write=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w) write=$2; shift ;;
    --proto|--retry|--retry-delay|--connect-timeout|--max-time|--max-filesize) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  */releases/latest)
    printf 'https://github.com/Nelcota/Nelcota/releases/tag/v%s' "$FIXTURE_LATEST"; exit 0 ;;
  https://get.docker.com)
    cp "$FIXTURE_GET_DOCKER" "$out"; exit 0 ;;
esac
[ -z "${FIXTURE_MISSING:-}" ] || exit 22
case "$url" in *.sha256) source_file=$FIXTURE_CHECKSUM ;; *) source_file=$FIXTURE_BINARY ;; esac
cp "$source_file" "$out"
"""


class Installer(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.tools = self.root / "tools"
        self.tools.mkdir()
        self.log = self.root / "calls.log"
        self.log.touch()
        self.binary = self.root / "binary"
        self.checksum = self.root / "checksum"
        self.write_binary(VERSION)
        self.tool("id", "#!/bin/sh\nprintf '1000\\n'\n")
        self.tool("uname", "#!/bin/sh\ncase \"$1\" in -s) echo Linux;; -m) echo x86_64;; esac\n")
        self.tool("sudo", "#!/bin/sh\necho unexpected-sudo >&2\nexit 99\n")
        self.tool("curl", FAKE_CURL)
        # The official Docker script, faked: it makes `docker` appear.
        self.get_docker = self.root / "get-docker.sh"
        self.get_docker.write_text(
            '#!/bin/sh\nprintf "get-docker\\n" >> "$CALLS"\n'
            f'printf \'#!/bin/sh\\nprintf "docker %%s\\\\n" "$*" >> "$CALLS"\\n\' > "{self.tools}/docker"\n'
            f'chmod +x "{self.tools}/docker"\n')
        self.environment = dict(os.environ, PATH=str(self.tools) + os.pathsep + str(self.system_commands()),
                                PREFIX=str(self.root / "user/bin"), NELCOTA_VERSION=VERSION,
                                NELCOTA_SKIP_DOCKER="1", FIXTURE_BINARY=str(self.binary),
                                FIXTURE_CHECKSUM=str(self.checksum), FIXTURE_LATEST=VERSION,
                                FIXTURE_GET_DOCKER=str(self.get_docker), CALLS=str(self.log),
                                NELCOTA_SWAP_FILE=str(self.root / "swapfile"),
                                NELCOTA_FSTAB=str(self.root / "fstab"))

    def system_commands(self):
        """Links to the system commands, without the ones the tests fake."""
        folder = self.root / "system"
        folder.mkdir()
        for source in ("/usr/local/bin", "/usr/bin", "/bin"):
            if not Path(source).is_dir():
                continue
            for command in Path(source).iterdir():
                link = folder / command.name
                if command.name not in FAKED and not link.exists() and not link.is_symlink():
                    link.symlink_to(command)
        return folder

    def write_binary(self, reported_version):
        """A fake binary that reports a version and logs every other call."""
        self.binary.write_text(
            "#!/bin/sh\n"
            f"[ \"${{1:-}}\" = --version ] && {{ printf 'nelcota {reported_version}\\n'; exit 0; }}\n"
            "printf 'nelcota %s\\n' \"$*\" >> \"$CALLS\"\n")
        self.write_checksum(hashlib.sha256(self.binary.read_bytes()).hexdigest() + "  " + BIN)

    def write_checksum(self, content):
        self.checksum.write_text(content + "\n")

    def tool(self, name, source):
        path = self.tools / name
        path.write_text(source)
        path.chmod(0o755)

    def install(self, *arguments, script=INSTALLER):
        # A new session has no controlling terminal, like `curl | sh` over CI.
        return subprocess.run(["sh", str(script), *arguments],
                              env=self.environment, capture_output=True, text=True,
                              timeout=20, start_new_session=True)

    def logging_tool(self, name, extra=""):
        self.tool(name, f'#!/bin/sh\nprintf \'{name} %s\\n\' "$*" >> "$CALLS"\n{extra}')

    def fake_root(self, docker=True, package_manager="apt-get", ufw=True):
        """A fake root machine with logging package, service and firewall tools.

        FIXTURE_FIREWALLD / FIXTURE_UFW_ACTIVE turn those firewalls on;
        FIXTURE_RAM_MB / FIXTURE_SWAP_MB set what `free` reports."""
        self.tool("id", "#!/bin/sh\nprintf '0\\n'\n")
        self.logging_tool(package_manager)
        self.logging_tool("systemctl", 'case "$*" in *is-active*firewalld*) [ -n "${FIXTURE_FIREWALLD:-}" ] ;; esac\n')
        self.logging_tool("firewall-cmd")
        self.tool("debconf-set-selections", '#!/bin/sh\nprintf \'debconf %s\\n\' "$(cat)" >> "$CALLS"\n')
        # Translated like a pt-BR system unless the caller asks for LC_ALL=C.
        self.tool("free", "#!/bin/sh\nlabel=Mem.; [ \"${LC_ALL:-}\" = C ] && label=Mem\n"
                          "printf '  total\\n%s: %s 0 0\\nSwap: %s 0 0\\n' "
                          "\"$label\" \"${FIXTURE_RAM_MB:-4096}\" \"${FIXTURE_SWAP_MB:-0}\"\n")
        if ufw:
            self.logging_tool("ufw", '[ "$1" = status ] || exit 0\n'
                                     '[ -n "${FIXTURE_UFW_ACTIVE:-}" ] && echo "Status: active" || echo "Status: inactive"\n')
        if docker:
            self.logging_tool("docker")
        self.host = self.root / "host dir"

    def setup_vps(self, *arguments):
        """Runs setup mode on the fake root machine."""
        self.fake_root()
        return self.install("--dir", str(self.host), *arguments)

    def init_call(self):
        return next(c for c in self.calls() if c.startswith("nelcota -C") and " init " in c)

    def calls(self):
        return self.log.read_text().splitlines()

    def downloads(self):
        return [c for c in self.calls() if c.startswith("curl ")]

    def destination(self):
        return Path(self.environment["PREFIX"]) / "nelcota"

    def existing_installation(self):
        destination = self.destination()
        destination.parent.mkdir(parents=True)
        destination.write_text("previous installation")
        return destination

    def assert_rejected(self, result, message, destination):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertEqual(destination.read_text(), "previous installation")
        self.assertEqual([p.name for p in destination.parent.iterdir()], ["nelcota"])

    def test_writable_prefix_needs_no_sudo_and_handles_spaces(self):
        self.environment["PREFIX"] = str(self.root / "user folder/bin")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        destination = self.destination()
        self.assertEqual(destination.read_bytes(), self.binary.read_bytes())
        self.assertEqual(destination.stat().st_mode & 0o777, 0o755)
        # The staged copy is renamed over the destination, never left behind.
        self.assertEqual([p.name for p in destination.parent.iterdir()], ["nelcota"])

    def test_downloads_use_https_only_with_bounded_time(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        downloads = self.downloads()
        self.assertEqual(len(downloads), 2, downloads)
        for call in downloads:
            for option in ("--proto =https", "--tlsv1.2", "--max-time", "--retry", "--max-filesize"):
                self.assertIn(option, call)

    def test_bad_checksum_preserves_existing_installation(self):
        destination = self.existing_installation()
        self.write_checksum("0" * 64 + "  " + BIN)
        self.assert_rejected(self.install(), "checksum does not match", destination)

    def test_checksum_file_for_another_file_is_refused(self):
        # `sha256sum -c` would check only the listed file and pass.
        destination = self.existing_installation()
        other = self.root / "other"
        other.write_text("x")
        self.write_checksum(hashlib.sha256(b"x").hexdigest() + "  " + str(other))
        self.assert_rejected(self.install(), "checksum file is for another file", destination)

    def test_malformed_or_empty_checksum_file_is_refused(self):
        destination = self.existing_installation()
        for content in ("<html>Service unavailable</html>", "", "abc  " + BIN):
            self.checksum.write_text(content)
            with self.subTest(content=content):
                result = self.install()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("checksum file is", result.stderr)
                self.assertEqual(destination.read_text(), "previous installation")

    def test_binary_mode_and_uppercase_checksums_are_accepted(self):
        digest = hashlib.sha256(self.binary.read_bytes()).hexdigest().upper()
        self.checksum.write_text(digest + " *" + BIN + "\r\n")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_reported_version_preserves_existing_installation(self):
        destination = self.existing_installation()
        self.write_binary("9.9.9")
        self.assert_rejected(self.install(), "expected nelcota 1.2.3, but the binary reports: nelcota 9.9.9",
                             destination)

    def test_binary_that_cannot_run_preserves_existing_installation(self):
        destination = self.existing_installation()
        self.binary.write_text("#!/bin/sh\necho 'Exec format error' >&2\nexit 126\n")
        self.write_checksum(hashlib.sha256(self.binary.read_bytes()).hexdigest() + "  " + BIN)
        self.assert_rejected(self.install(), "does not run on this machine", destination)

    def test_latest_is_resolved_once_to_a_fixed_release(self):
        del self.environment["NELCOTA_VERSION"]
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        downloads = self.downloads()
        self.assertTrue(downloads[0].endswith("https://github.com/Nelcota/Nelcota/releases/latest"))
        for call in downloads[1:]:
            self.assertIn("/releases/download/v1.2.3/", call)
        self.assertIn("nelcota 1.2.3 installed", result.stdout)

    def test_version_with_v_prefix_is_accepted(self):
        self.environment["NELCOTA_VERSION"] = "v1.2.3"
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all("/download/v1.2.3/" in c for c in self.downloads()))

    def test_invalid_settings_stop_before_any_download(self):
        cases = [
            ({"NELCOTA_VERSION": "1.2"}, "NELCOTA_VERSION must be a version"),
            ({"NELCOTA_VERSION": "1.2.3/../../x"}, "NELCOTA_VERSION must be a version"),
            ({"NELCOTA_VERSION": "1.2.3\nevil"}, "NELCOTA_VERSION must be a version"),
            ({"NELCOTA_REPO": "evil"}, "NELCOTA_REPO must look like owner/repo"),
            ({"NELCOTA_REPO": "a/b/c"}, "NELCOTA_REPO must look like owner/repo"),
            ({"NELCOTA_SKIP_DOCKER": "yes"}, "NELCOTA_SKIP_DOCKER must be 0 or 1"),
            ({"PREFIX": "relative/bin"}, "PREFIX must be an absolute folder"),
        ]
        for overrides, message in cases:
            with self.subTest(overrides=overrides):
                self.log.write_text("")
                self.environment.update({"NELCOTA_VERSION": VERSION, "NELCOTA_REPO": "Nelcota/Nelcota",
                                         "NELCOTA_SKIP_DOCKER": "1",
                                         "PREFIX": str(self.root / "user/bin")})
                self.environment.update(overrides)
                result = self.install()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(self.downloads(), [])

    def test_missing_release_explains_what_to_check(self):
        self.environment["FIXTURE_MISSING"] = "1"
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not download " + BIN + " for version 1.2.3", result.stderr)
        self.assertIn("releases/tag/v1.2.3", result.stderr)

    def test_truncated_download_runs_nothing(self):
        # `curl | sh` may stop halfway; main is only called on the last line.
        source = INSTALLER.read_text()
        self.assertTrue(source.rstrip().endswith('main "$@"'))
        for cut in (len(source) // 3, len(source) // 2, source.rindex('main "$@"')):
            truncated = self.root / "truncated.sh"
            truncated.write_text(source[:cut])
            with self.subTest(cut=cut):
                self.log.write_text("")
                self.install(script=truncated)
                self.assertEqual(self.calls(), [])
                self.assertFalse(self.destination().exists())

    def test_setup_prepares_the_machine_then_creates_and_starts_the_host(self):
        result = self.setup_vps("api.example.com", "--firewall", "--email", "me@example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn("systemctl enable --now cron.service", calls)
        self.assertTrue(any(c.startswith("apt-get") and "install" in c and " ufw " in c for c in calls), calls)
        self.assertTrue(any(c.startswith("apt-get -o DPkg::Lock::Timeout=") for c in calls), calls)
        nelcota = [c for c in calls if c.startswith("nelcota -C")]
        self.assertEqual(nelcota, [
            f"nelcota -C {self.host} init --yes api.example.com --email me@example.com --firewall",
            f"nelcota -C {self.host} up",
        ])
        self.assertLess(calls.index("systemctl enable --now cron.service"),
                        calls.index(nelcota[0]))

    def test_setup_starts_docker_before_creating_the_host(self):
        self.environment["NELCOTA_SKIP_DOCKER"] = "0"
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn("systemctl enable --now docker.service", calls)
        self.assertIn("docker info", calls)
        init = next(c for c in calls if " init " in c)
        self.assertLess(calls.index("docker info"), calls.index(init))

    def test_setup_installs_and_starts_missing_docker(self):
        self.environment["NELCOTA_SKIP_DOCKER"] = "0"
        self.fake_root(docker=False)
        result = self.install("--dir", str(self.host), "api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertLess(calls.index("get-docker"), calls.index("systemctl enable --now docker.service"))
        self.assertLess(calls.index("docker info"), calls.index(next(c for c in calls if " init " in c)))

    def test_docker_that_never_starts_stops_before_init(self):
        self.environment["NELCOTA_SKIP_DOCKER"] = "0"
        self.fake_root(docker=False)
        self.tool("docker", "#!/bin/sh\nexit 1\n")
        self.tool("sleep", "#!/bin/sh\nexit 0\n")
        result = self.install("--dir", str(self.root / "host dir"), "api.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker did not start", result.stderr)
        self.assertFalse(any(c.startswith("nelcota -C") for c in self.calls()))

    def test_yes_is_passed_to_init_once(self):
        # Without a terminal the installer adds --yes itself; init refuses two.
        for flag in ("--yes", "-y"):
            with self.subTest(flag=flag):
                self.log.write_text("")
                result = self.setup_vps("api.example.com", flag, "--email", "me@example.com")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"nelcota -C {self.host} init --yes api.example.com --email me@example.com --firewall",
                              self.calls())

    def test_setup_skips_init_when_the_host_exists(self):
        self.host = self.root / "host dir"
        self.host.mkdir()
        (self.host / "nelcota-host.json").write_text("{}")
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith("nelcota -C")],
                         [f"nelcota -C {self.host} up"])

    def test_failed_up_says_the_command_can_be_run_again(self):
        self.write_binary(VERSION)
        self.binary.write_text(self.binary.read_text() + '[ "$3" = up ] && exit 1\nexit 0\n')
        self.write_checksum(hashlib.sha256(self.binary.read_bytes()).hexdigest() + "  " + BIN)
        result = self.setup_vps("api.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("nelcota up did not finish", result.stderr)
        self.assertIn(f"nelcota -C {self.host} up", result.stderr)
        self.assertIn("run the same command again", result.stderr)
        self.assertIn("Keep the panel password", result.stderr)

    def test_systemd_runtime_does_not_install_docker(self):
        result = self.setup_vps("api.example.com", "--runtime", "systemd")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn(f"nelcota -C {self.host} init --yes api.example.com --runtime systemd --firewall", calls)
        self.assertNotIn("get-docker", calls)
        self.assertNotIn("systemctl enable --now docker.service", calls)

    def test_setup_requires_root_before_changing_anything(self):
        self.tool("apt-get", "#!/bin/sh\necho unexpected-apt >&2\nexit 99\n")
        result = self.install("api.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("needs root", result.stderr)
        self.assertNotIn("unexpected-apt", result.stderr)

    def test_root_error_does_not_repeat_secret_arguments(self):
        result = self.install("api.example.com", "--s3-secret-key", "very-secret-value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("needs root", result.stderr)
        self.assertNotIn("very-secret-value", result.stderr + result.stdout)

    def test_setup_needs_systemd(self):
        self.tool("id", "#!/bin/sh\nprintf '0\\n'\n")
        self.tool("apt-get", "#!/bin/sh\necho unexpected-apt >&2\nexit 99\n")
        # The isolated PATH has no systemctl unless a test fakes it.
        result = self.install("--dir", str(self.root / "host"), "api.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("needs systemd", result.stderr)
        self.assertNotIn("unexpected-apt", result.stderr)

    def test_invalid_host_folders_are_refused_before_changing_anything(self):
        self.tool("id", "#!/bin/sh\nprintf '0\\n'\n")
        self.tool("apt-get", "#!/bin/sh\necho unexpected-apt >&2\nexit 99\n")
        for folder, message in (("relative/dir", "absolute folder"), ("", "absolute folder"),
                                ("/", "root folder"), ("//", "root folder")):
            with self.subTest(folder=folder):
                result = self.install("--dir", folder, "api.example.com")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertNotIn("unexpected-apt", result.stderr)


    # Firewall, swap and automatic updates in setup mode.

    def apt_install(self):
        return next(c for c in self.calls() if c.startswith("apt-get") and " install " in c)

    def test_firewall_is_on_by_default(self):
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.init_call().endswith(" --firewall"), self.init_call())
        self.assertIn(" ufw ", self.apt_install() + " ")

    def test_no_firewall_leaves_it_off_and_is_not_passed_to_init(self):
        result = self.setup_vps("api.example.com", "--no-firewall")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.init_call(), f"nelcota -C {self.host} init --yes api.example.com")
        self.assertNotIn(" ufw ", self.apt_install() + " ")
        self.assertIn("Firewall left off", result.stdout)

    def test_active_firewalld_gets_http_and_https_instead_of_ufw(self):
        self.environment["FIXTURE_FIREWALLD"] = "1"
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn("firewall-cmd --permanent --add-service=http --add-service=https --add-port=443/udp", calls)
        self.assertIn("firewall-cmd --reload", calls)
        self.assertNotIn("--firewall", self.init_call())
        self.assertLess(calls.index("firewall-cmd --reload"), calls.index(self.init_call()))

    def test_active_firewall_gets_80_and_443_even_with_no_firewall(self):
        # An active firewall would block HTTPS without any error.
        self.environment["FIXTURE_UFW_ACTIVE"] = "1"
        result = self.setup_vps("api.example.com", "--no-firewall")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn("ufw allow 80/tcp", calls)
        self.assertIn("ufw allow 443", calls)
        self.assertNotIn("--firewall", self.init_call())

    def test_local_host_gets_no_firewall(self):
        result = self.setup_vps("--local", "--project", "demo")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.init_call(), f"nelcota -C {self.host} init --yes --local --project demo")

    def test_conflicting_firewall_flags_stop_before_changing_anything(self):
        for arguments, message in ((("--firewall", "--no-firewall"), "cannot be used together"),
                                   (("--local", "--firewall"), "does not apply to a --local host")):
            with self.subTest(arguments=arguments):
                self.log.write_text("")
                result = self.setup_vps("api.example.com", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(self.calls(), [])

    def test_dnf_without_ufw_or_firewalld(self):
        # RHEL-like systems have no ufw: a requested --firewall stops early,
        # the default only leaves a note.
        self.fake_root(package_manager="dnf", ufw=False)
        result = self.install("--dir", str(self.host), "api.example.com", "--firewall")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("enable firewalld", result.stderr)
        self.assertFalse(any(c.startswith("nelcota -C") for c in self.calls()))
        self.log.write_text("")
        result = self.install("--dir", str(self.host), "api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no firewall turned on", result.stdout)
        self.assertEqual(self.init_call(), f"nelcota -C {self.host} init --yes api.example.com")
        self.assertNotIn("ufw", next(c for c in self.calls() if c.startswith("dnf install")))

    def test_automatic_security_updates_are_installed_and_enabled(self):
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("unattended-upgrades", self.apt_install())
        self.assertIn("debconf unattended-upgrades unattended-upgrades/enable_auto_updates boolean true",
                      self.calls())

    def fake_disk(self, filesystem="ext4", free_kb=20 * 1024 * 1024, mkswap_fails=False):
        self.tool("df", "#!/bin/sh\nprintf 'Filesystem Type 1024-blocks Used Available Capacity Mounted\\n"
                        f"/dev/vda1 {filesystem} 1 1 {free_kb} 1%% /\\n'\n")
        self.logging_tool("dd", 'for a in "$@"; do case "$a" in of=*) : > "${a#of=}" ;; esac; done\n')
        self.logging_tool("mkswap", "exit 1\n" if mkswap_fails else "")
        self.logging_tool("swapon")

    def test_swap_is_created_below_2_gb_of_ram(self):
        self.environment["FIXTURE_RAM_MB"] = "1024"
        self.fake_disk()
        swapfile = self.root / "swapfile"
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertTrue(any(c.startswith("dd ") and f"of={swapfile}" in c and "count=2048" in c for c in calls))
        self.assertIn(f"mkswap {swapfile}", calls)
        self.assertIn(f"swapon {swapfile}", calls)
        self.assertEqual((self.root / "fstab").read_text(), f"{swapfile} none swap sw 0 0\n")
        self.assertLess(calls.index(f"swapon {swapfile}"), calls.index(self.init_call()))
        # Running again keeps a single fstab entry and does not recreate it.
        self.environment["FIXTURE_SWAP_MB"] = "2048"
        self.assertEqual(self.setup_vps("api.example.com").returncode, 0)
        self.assertEqual((self.root / "fstab").read_text().count("swapfile"), 1)

    def test_swap_is_left_alone_when_not_needed_or_not_safe(self):
        cases = [
            ({"FIXTURE_RAM_MB": "4096"}, {}, None),
            ({"FIXTURE_RAM_MB": "1024", "FIXTURE_SWAP_MB": "512"}, {}, None),
            ({"FIXTURE_RAM_MB": "1024"}, {"filesystem": "btrfs"}, "create swap by hand on btrfs"),
            ({"FIXTURE_RAM_MB": "1024"}, {"free_kb": 1024 * 1024}, "too little disk"),
        ]
        for environment, disk, note in cases:
            with self.subTest(environment=environment, disk=disk):
                self.log.write_text("")
                self.environment.pop("FIXTURE_SWAP_MB", None)
                self.environment.update(environment)
                self.fake_disk(**disk)
                result = self.setup_vps("api.example.com")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(any(c.startswith(("dd ", "mkswap", "swapon")) for c in self.calls()))
                if note:
                    self.assertIn(note, result.stdout)

    def test_existing_swap_file_is_not_overwritten(self):
        self.environment["FIXTURE_RAM_MB"] = "1024"
        self.fake_disk()
        (self.root / "swapfile").write_text("someone else's file")
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "swapfile").read_text(), "someone else's file")
        self.assertIn("left untouched", result.stdout)

    def test_failed_swap_is_removed_and_setup_continues(self):
        self.environment["FIXTURE_RAM_MB"] = "1024"
        self.fake_disk(mkswap_fails=True)
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("continuing without swap", result.stdout)
        self.assertFalse((self.root / "swapfile").exists())
        self.assertFalse((self.root / "fstab").exists())
        self.assertIn(f"nelcota -C {self.host} up", self.calls())

    def test_done_message_mentions_the_provider_firewall(self):
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("security group", result.stdout)

    def test_translated_system_output_is_parsed(self):
        # `free` prints "Mem.:" on a pt-BR system; the swap check must not break.
        self.environment.update({"LANG": "pt_BR.UTF-8", "FIXTURE_RAM_MB": "1024"})
        self.environment.pop("LC_ALL", None)
        self.fake_disk()
        result = self.setup_vps("api.example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("[:", result.stderr)
        self.assertIn(f"swapon {self.root / 'swapfile'}", self.calls())

    def test_unsupported_distribution_stops_before_changing_anything(self):
        self.fake_root(package_manager="pacman")
        self.environment["FIXTURE_UFW_ACTIVE"] = "1"
        result = self.install("--dir", str(self.host), "api.example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("supports Debian/Ubuntu (apt-get) and Fedora/RHEL (dnf)", result.stderr)
        changes = [c for c in self.calls()
                   if c.startswith(("ufw allow", "systemctl enable", "curl ", "nelcota "))]
        self.assertEqual(changes, [])
        self.assertFalse(self.destination().exists())

if __name__ == "__main__":
    unittest.main()
