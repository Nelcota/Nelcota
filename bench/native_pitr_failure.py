#!/usr/bin/env python3
"""Observe an actual native CLI restore error on an explicitly owned guest.

The substituted pgBackRest adapter writes one inert marker, then fails. It does
not rewrite PostgreSQL files or establish real PITR/S3/data-corruption evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat

from native_guest import ROOT, PROJECT, UNIT, cli, command, owned, require, sql, unit_state

PG_UNIT = "postgresql@17-main.service"
DATA = Path("/var/lib/postgresql/17/main")
MARKER = DATA / "g05-restore-adapter-failure-marker"
MARKER_BYTES = b"g05 controlled adapter failure\n"
BINARY = Path("/usr/bin/pgbackrest")
SAVED = Path("/opt/g05-tools/pgbackrest-before-error-control")
FLAG = ROOT / "projects/stress/pgbackrest.env"
LOG = Path("/opt/g05-tools/pitr-error-control.private.log")
PROFILE = {"helper_CPU_percent": 10, "helper_memory_mib": 96, "helper_swap_bytes": 0,
           "helper_tasks": 32, "helper_maximum_seconds": 120, "CLI_failure_timeout_seconds": 35,
           "explicit_recovery_timeout_seconds": 60, "maximum_private_command_bytes": 65536,
           "adapter_exit_status": 72, "real_PG_files_modified": False,
           "scope": "Controlled adapter error after an inert owned marker; no real PITR, S3 or data-corruption claim"}


def digest(path):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 64 * 1024 ** 2,
            "Missing bounded owned executable")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def snapshot():
    result = {}
    for role, name in [("app", UNIT), ("postgres", PG_UNIT)]:
        value = unit_state(name)
        require(value.get("LoadState") == "loaded" and type(value.get("MainPID")) is int
                and value["MainPID"] >= 0 and value.get("ActiveState") in {"active", "inactive", "failed", "activating", "deactivating"},
                "Missing owned native unit state")
        result[role] = {"MainPID": value["MainPID"], "ActiveState": value["ActiveState"]}
    return result


def helper_name(identity):
    require(isinstance(identity, str) and re.fullmatch(r"native-vm-[a-z0-9-]{1,64}", identity) is not None,
            "Invalid owned PITR control identity")
    return "g05-pitr-error-" + identity + ".service"


def helper_budget(identity, *, observations=None):
    name = helper_name(identity)
    value = unit_state(name)
    description = command(["systemctl", "show", name, "--property=Description", "--value"]).stdout.decode().strip()
    expected = {"cpu_quota_usec": 10000, "cpu_period_usec": 100000, "memory_bytes": 96 * 1024 ** 2,
                "swap_bytes": 0, "pids": 32}
    if observations is not None:
        require(isinstance(observations, dict), "Invalid recovery observation owner")
        budget = value.get("kernel_budget", {})
        actual = {}
        for key in expected:
            number = budget.get(key)
            actual[key] = None
            if type(number) is int and number >= 0:
                actual[key] = number
        observations["helper_budget_observation"] = {
            "MainPID_matches_helper": value.get("MainPID") == os.getpid(),
            "active": value.get("ActiveState") == "active",
            "description_matches": description == "g05-pitr-error:" + identity,
            "kernel_budget": actual,
            "zero_oom_kills": value.get("memory_events", {}).get("oom_kill") == 0,
        }
    require(description == "g05-pitr-error:" + identity and value.get("MainPID") == os.getpid()
            and value.get("ActiveState") == "active" and value.get("kernel_budget") == expected
            and all(type(value["kernel_budget"].get(key)) is int for key in expected)
            and value.get("memory_events", {}).get("oom_kill") == 0,
            "PITR error helper escaped its owned kernel budget")
    return expected


def fixture_digest():
    value = sql("SELECT coalesce(json_agg(t ORDER BY id),'[]'::json) "
                "FROM (SELECT id,owner,value FROM public.native_probe)t;")
    require(0 < len(value) <= 65536, "Unexpected owned PITR fixture size")
    return hashlib.sha256(value).hexdigest()


def fenced(value):
    require(isinstance(value, dict) and set(value) == {"app", "postgres"}, "Incomplete post-error unit census")
    for unit in value.values():
        require(isinstance(unit, dict) and set(unit) == {"MainPID", "ActiveState"}
                and type(unit["MainPID"]) is int and unit["MainPID"] >= 0,
                "Invalid post-error unit census")
        if unit["MainPID"] != 0 or unit["ActiveState"] not in {"inactive", "failed"}:
            return False
    return True


def adapter_source():
    # The adapter receives no credentials. Refuse every command except this one
    # controlled restore, and never overwrite an existing marker or PG file.
    return ("#!/usr/bin/python3\nimport os,sys\n"
            "if sys.argv[1:] != ['--stanza=main','--delta','restore']:raise SystemExit(74)\n"
            "path=" + repr(str(MARKER)) + "\n"
            "descriptor=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)\n"
            "try:\n os.write(descriptor," + repr(MARKER_BYTES) + ");os.fsync(descriptor)\n"
            "finally:os.close(descriptor)\nraise SystemExit(72)\n").encode()


def marker_written(postgres_uid):
    if not MARKER.exists() and not MARKER.is_symlink():
        return False
    metadata = MARKER.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == postgres_uid
            and metadata.st_size == len(MARKER_BYTES) and MARKER.read_bytes() == MARKER_BYTES,
            "Refusing another marker or a modified fixture")
    return True


def sync_parent(path):
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def recover_fixture(identity, expected_rows, *, observations=None):
    result = {}
    if observations is not None:
        require(isinstance(observations, dict), "Invalid recovery observation owner")
        result = observations
    result["fixture_recovery_stage"] = "guest-ownership"
    owned(identity)
    result["fixture_recovery_stage"] = "helper-budget"
    helper_budget(identity, observations=result)
    result["fixture_recovery_stage"] = "digest-validation"
    require(isinstance(expected_rows, str) and re.fullmatch(r"[0-9a-f]{64}", expected_rows) is not None,
            "Missing owned pre-fault row digest")
    result["fixture_recovery_stage"] = "CLI-up"
    recovery = cli("-p", PROJECT, "up", timeout=PROFILE["explicit_recovery_timeout_seconds"], check=False)
    result["explicit_fixture_recovery_exit_code"] = recovery.returncode
    result["fixture_recovery_stage"] = "unit-snapshot"
    result["after_explicit_fixture_recovery"] = snapshot()
    require(recovery.returncode == 0 and all(point["MainPID"] > 1 and point["ActiveState"] == "active"
                                            for point in result["after_explicit_fixture_recovery"].values()),
            "Explicit owned fixture recovery failed")
    result["fixture_recovery_stage"] = "row-digest"
    result["fixture_rows_preserved"] = fixture_digest() == expected_rows
    require(result["fixture_rows_preserved"], "Controlled fixture rows changed")
    result["fixture_recovery_stage"] = "complete"
    result["explicit_fixture_recovery_successful"] = True
    return result


def recovery_observation(identity, expected_rows):
    result = {}
    try:
        recover_fixture(identity, expected_rows, observations=result)
    except Exception as error:
        # Stages, booleans and numeric statuses survive failure. Command output
        # and exception messages can contain private data and are never emitted.
        result["explicit_fixture_recovery_successful"] = False
        result["fixture_recovery_failure_type"] = type(error).__name__
    return result


def observe(identity, *, defer_recovery=False):
    require(type(defer_recovery) is bool, "Unknown fixture recovery mode")
    owned(identity)
    budget = helper_budget(identity)
    postgres_uid = pwd.getpwnam("postgres").pw_uid
    require(DATA.is_dir() and not DATA.is_symlink() and DATA.resolve() == DATA
            and DATA.stat().st_uid == postgres_uid, "Not the owned native PG17/main data directory")
    require(sql("SHOW archive_mode;").decode().strip() == "off", "Existing WAL archiving must not be replaced")
    require(not FLAG.exists() and not FLAG.is_symlink() and not SAVED.exists() and not SAVED.is_symlink()
            and not MARKER.exists() and not MARKER.is_symlink() and not LOG.exists(),
            "Preserve previous PITR configuration or fault evidence")
    metadata = BINARY.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and not metadata.st_mode & 0o022,
            "pgBackRest is not the root-owned installed package executable")
    before_digest = digest(BINARY)
    before_rows = fixture_digest()
    before = snapshot()
    require(all(point["MainPID"] > 1 and point["ActiveState"] == "active" for point in before.values()),
            "Restore error control needs the initially active owned project")
    code = adapter_source()
    code_digest = hashlib.sha256(code).hexdigest()
    flag_inode = None
    binary_moved = False
    result = {"profile": PROFILE, "before": before, "original_adapter_sha256": before_digest,
              "injected_adapter_sha256": code_digest, "real_PG_files_modified": False, "helper_kernel_budget": budget}
    try:
        descriptor = os.open(FLAG, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        flag_inode = os.fstat(descriptor).st_ino
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(b"# Owned G05 restore error control; no credentials\n")
            stream.flush()
            os.fsync(stream.fileno())
        BINARY.replace(SAVED)
        binary_moved = True
        descriptor = os.open(BINARY, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(code)
            stream.flush()
            os.fsync(stream.fileno())
        BINARY.chmod(0o755)
        failure = cli("-p", PROJECT, "pitr", "restore", "--yes",
                      timeout=PROFILE["CLI_failure_timeout_seconds"], check=False)
        require(len(failure.stdout) + len(failure.stderr) <= PROFILE["maximum_private_command_bytes"],
                "Restore error command exceeded its private evidence bound")
        descriptor = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(failure.stdout + failure.stderr)
            stream.flush()
            os.fsync(stream.fileno())
        result["restore_exit_code"] = failure.returncode
        result["owned_marker_written_before_adapter_failure"] = marker_written(postgres_uid)
        result["after_unknown_restore_error_before_explicit_recovery"] = snapshot()
        result["unknown_state_kept_stopped"] = fenced(result["after_unknown_restore_error_before_explicit_recovery"])
        require(failure.returncode != 0 and result["owned_marker_written_before_adapter_failure"],
                "The controlled potentially modifying adapter error was not reached")
    finally:
        if binary_moved:
            if BINARY.exists() or BINARY.is_symlink():
                require(digest(BINARY) == code_digest, "Injected adapter changed; refuse to replace an unknown file")
            require(digest(SAVED) == before_digest, "Saved package executable changed")
            SAVED.replace(BINARY)
            require(digest(BINARY) == before_digest, "Original pgBackRest package was not restored")
            sync_parent(BINARY)
            sync_parent(SAVED)
        if flag_inode is not None:
            current = FLAG.lstat()
            require(stat.S_ISREG(current.st_mode) and current.st_ino == flag_inode and current.st_uid == 0,
                    "Owned PITR flag changed; refuse unrelated cleanup")
            FLAG.unlink()
            sync_parent(FLAG)
        if marker_written(postgres_uid):
            MARKER.unlink()
            sync_parent(MARKER)
        result["controlled_adapter_and_flag_removed"] = not SAVED.exists() and not FLAG.exists() and not MARKER.exists()
        # The injected adapter can change only the checked inert marker. This
        # explicit fixture recovery is independent of the error-path observation.
        if not defer_recovery:
            result.update(recover_fixture(identity, before_rows))
        if defer_recovery:
            result["explicit_fixture_recovery_deferred"] = True
            result["fixture_rows_before_sha256"] = before_rows
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("identity")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--defer-recovery", action="store_true")
    mode.add_argument("--recover-fixture")
    args = parser.parse_args()
    if args.recover_fixture is not None:
        result = recovery_observation(args.identity, args.recover_fixture)
        print(json.dumps(result, allow_nan=False))
        raise SystemExit(int(result.get("explicit_fixture_recovery_successful") is not True))
    print(json.dumps(observe(args.identity, defer_recovery=args.defer_recovery), allow_nan=False))
