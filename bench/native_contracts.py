"""Exercise documented native cwd and machine ownership only inside the guest."""

import hashlib
from contextlib import contextmanager
from pathlib import Path
import subprocess
import time

from native_guest import ROOT, PROJECT, UNIT, binary_identity, cli, command, install_limits, prepare, require, sql, unit_state, versions, write_migration

BACKUP_CONFIG = Path("/etc/pgbackrest/pgbackrest.conf")
MACHINE_OWNER = Path("/var/lib/nelcota-native/owner.json")


@contextmanager
def configuration_fault(path):
    require(not path.is_symlink() and (not path.exists() or path.is_file()), "Refuse a preexisting configuration fault")
    original = None
    mode = None
    if path.exists():
        require(path.stat().st_size <= 65536, "Native backup configuration exceeds the fixture budget")
        original, mode = path.read_bytes(), path.stat().st_mode & 0o777
        path.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir(mode=0o700)
    marker = path / "g05-owned-configuration-fault"
    marker.write_bytes(b"owned disposable VM configuration fault\n")
    marker.chmod(0o600)
    inode = path.stat().st_ino
    try:
        yield
    finally:
        require(not path.is_symlink() and path.is_dir() and path.stat().st_ino == inode
                and sorted(item.name for item in path.iterdir()) == [marker.name]
                and not marker.is_symlink() and marker.read_bytes() == b"owned disposable VM configuration fault\n",
                "Configuration fault ownership changed; refuse broad cleanup")
        marker.unlink()
        path.rmdir()
        if original is not None:
            path.write_bytes(original)
            path.chmod(mode)


def remove_boundary():
    first = prepare()
    sql("CREATE TABLE public.g05_remove_sentinel (id integer PRIMARY KEY); INSERT INTO public.g05_remove_sentinel VALUES (1);\n")
    manifest = ROOT / "nelcota-host.json"
    before_manifest = manifest.read_bytes()
    before_owner = MACHINE_OWNER.read_bytes()
    with configuration_fault(BACKUP_CONFIG):
        removed = cli("-p", PROJECT, "remove", "--no-backup", "--yes", timeout=120, check=False)
        clusters = command(["pg_lsclusters", "--no-header"]).stdout.decode().splitlines()
        present = any(line.split()[:2] == ["17", "main"] for line in clusters)
        rows = None
        if present:
            rows = int(sql("SELECT count(*) FROM public.g05_remove_sentinel;\n"))
        result = {"case": "owned malformed backup configuration must block native removal before destruction",
                  "first_native_init": first, "remove_exit_code": removed.returncode,
                  "specific_rejection": b"unsafe native backup configuration" in removed.stdout + removed.stderr,
                  "machine_owner_preserved": MACHINE_OWNER.is_file() and MACHINE_OWNER.read_bytes() == before_owner,
                  "manifest_preserved": manifest.is_file() and manifest.read_bytes() == before_manifest,
                  "cluster_preserved": present, "sentinel_rows": rows,
                  "app_unit_after": unit_state(UNIT), "configuration_fault_preserved": BACKUP_CONFIG.is_dir(),
                  "scope": "Generated disposable VM only; no-backup is intentional for this owned failure-injection sentinel"}
    result["configuration_fault_removed"] = not BACKUP_CONFIG.is_dir()
    return result


def environment_is_absolute():
    path = Path("/etc/systemd/system") / UNIT
    require(path.is_file() and path.stat().st_size <= 65536, "Missing bounded native unit")
    values = [line.removeprefix("EnvironmentFile=") for line in path.read_text().splitlines()
              if line.startswith("EnvironmentFile=")]
    require(len(values) == 1, "Native unit has ambiguous environment files")
    return Path(values[0].strip('"')).is_absolute()


def migration_census():
    def present(statement):
        raw = sql(statement).strip()
        require(raw in {b"t", b"f"}, "Native migration census returned an invalid SQL boolean")
        return raw == b"t"
    result = {"fixture_table_created": present("SELECT to_regclass('public.native_probe') IS NOT NULL;\n"),
              "migration_journal_present": present("SELECT to_regclass('nelcota.user_migrations') IS NOT NULL;\n"),
              "applied_fixture_migrations": None}
    if result["migration_journal_present"]:
        raw = sql("SELECT count(*) FROM nelcota.user_migrations;\n").strip()
        require(0 < len(raw) <= 16 and raw.isdigit(), "Native migration count is invalid")
        result["applied_fixture_migrations"] = int(raw)
        require(result["applied_fixture_migrations"] <= 1000, "Native fixture migration journal exceeded its bound")
    return result


def default_root():
    require(not ROOT.exists(), "Default-root probe requires a fresh guest root")
    install_limits()
    ROOT.mkdir(mode=0o700)
    initial = command(["env", "-u", "NELCOTA_ROOT", "/usr/local/bin/nelcota", "init", "--local", "--project", PROJECT,
                       "--runtime", "systemd", "--profile", "1gb", "--yes"], cwd=ROOT, timeout=650, check=False)
    result = {"case": "documented init from the application directory without -C or NELCOTA_ROOT",
              "init_exit_code": initial.returncode, "environment_file_absolute": environment_is_absolute(),
              "versions": versions()}
    verify = command(["systemd-analyze", "verify", "/etc/systemd/system/" + UNIT], check=False, timeout=30)
    result["systemd_verify_exit_code"] = verify.returncode
    try:
        up = cli("up", timeout=30, check=False)
        result["up_exit_code"] = up.returncode
        result["up_timed_out"] = False
    except subprocess.TimeoutExpired:
        result["up_exit_code"] = None
        result["up_timed_out"] = True
    time.sleep(3)
    result["app_unit"] = unit_state(UNIT)
    if result["up_exit_code"] == 0 and result["app_unit"].get("ActiveState") == "active":
        result["running_binary_identity"] = binary_identity()
    write_migration()
    for label, environment in [("cwd", ["env", "-u", "NELCOTA_ROOT"]),
                               ("root_environment", ["env", "NELCOTA_ROOT=" + str(ROOT)])]:
        migrated = command([*environment, "/usr/local/bin/nelcota", "-p", PROJECT, "migrate"],
                           cwd=ROOT, check=False, timeout=60)
        result[label + "_migration_exit_code"] = migrated.returncode
        result[label + "_migration_lease_busy"] = b"deployment_busy" in migrated.stdout + migrated.stderr
    result.update(migration_census())
    return result


def host_root():
    first = prepare()
    other = Path("/opt/g05-native-other")
    require(not other.exists(), "Second host probe requires an unused owned root")
    sql("CREATE TABLE public.g05_host_sentinel (id integer PRIMARY KEY); INSERT INTO public.g05_host_sentinel VALUES (1);\n")
    # Credential verifiers stay only in private controller memory. Only whether
    # they changed is published, never their bytes or a derivative fingerprint.
    before = sql("SELECT rolpassword FROM pg_authid WHERE rolname='postgres';\n")
    caddy = Path("/etc/caddy/Caddyfile")
    before_caddy = hashlib.sha256(caddy.read_bytes()).digest()
    second = command(["/usr/local/bin/nelcota", "-C", str(other), "init", "--local", "--project", "other",
                      "--runtime", "systemd", "--profile", "1gb", "--skip-checks", "--yes"], timeout=650, check=False)
    after = sql("SELECT rolpassword FROM pg_authid WHERE rolname='postgres';\n")
    count = int(sql("SELECT count(*) FROM public.g05_host_sentinel;\n"))
    return {"case": "second native init in another owned directory with network checks skipped",
            "first_native_init": first,
            "second_init_exit_code": second.returncode,
            "owner_rejection_reported": b"native runtime already belongs to another host directory" in second.stdout + second.stderr,
            "first_database_password_changed": before != after,
            "first_caddy_configuration_changed": before_caddy != hashlib.sha256(caddy.read_bytes()).digest(),
            "first_sentinel_rows": count,
            "second_host_created": (other / "nelcota-host.json").is_file(),
            "second_root_directory_created": other.exists(),
            "second_unit_created": Path("/etc/systemd/system/nelcota-other.service").exists(),
            "first_app_after": unit_state(UNIT),
            "scope": "Both roots, the database, credentials and sentinels are generated disposable VM fixtures"}


def run(case):
    if case == "remove-boundary":
        return remove_boundary()
    if case == "default-root":
        return default_root()
    require(case == "host-root", "Unknown native installation contract")
    return host_root()
