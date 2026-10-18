#!/usr/bin/env python3
"""Native runtime probes confined to a uniquely identified disposable VM."""

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

ROOT = Path("/opt/g05-native")
PROJECT = "stress"
UNIT = "nelcota-stress.service"
ENV = ROOT / "projects/stress/.env"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def owned(identity):
    require(re.fullmatch(r"[a-z0-9-]{1,64}", identity), "Invalid VM identity")
    require(os.geteuid() == 0, "Guest probes require root inside the disposable VM")
    marker = Path("/etc/g05-native-owner")
    require(marker.is_file() and not marker.is_symlink(), "Missing VM ownership marker")
    require(marker.stat().st_uid == 0, "VM marker has an unexpected owner")
    require(marker.read_text().strip() == identity, "VM identity mismatch")
    require(Path("/proc/1/comm").read_text().strip() == "systemd", "Not a systemd VM")


def command(arguments, *, value=None, timeout=60, check=True, cwd=None):
    result = subprocess.run(arguments, input=value, capture_output=True, timeout=timeout, cwd=cwd)
    if check and result.returncode:
        # Never publish command output: init and token output contain credentials.
        log = Path("/opt/g05-native-private.log")
        with log.open("ab") as stream:
            os.chmod(log, 0o600)
            stream.write(result.stdout[-524288:] + result.stderr[-524288:])
        raise RuntimeError("Command failed: " + Path(arguments[0]).name + " exit " + str(result.returncode))
    return result


def cli(*arguments, timeout=60, check=True):
    return command(["/usr/local/bin/nelcota", "-C", str(ROOT), *arguments], timeout=timeout, check=check)


def sql(value):
    return command(["runuser", "-u", "postgres", "--", "psql", "--cluster", "17/main", "-XqAt",
                    "-v", "ON_ERROR_STOP=1", "-d", "postgres"], value=value.encode()).stdout


def versions():
    def first(arguments):
        return command(arguments).stdout.decode().splitlines()[0][:256]
    return {"kernel": platform.release(), "architecture": platform.machine(),
            "libc": list(platform.libc_ver()), "python": platform.python_version(),
            "postgres_server": sql("SHOW server_version;\n").decode().strip(),
            "postgres_client": first(["psql", "--cluster", "17/main", "--version"]),
            "caddy": first(["caddy", "version"]), "systemd": first(["systemctl", "--version"])}


def unit_state(name):
    fields = ["LoadState", "ActiveState", "SubState", "MainPID", "MemoryCurrent", "MemoryPeak", "MemoryMax",
              "TasksCurrent", "TasksMax", "NRestarts", "CPUUsageNSec", "ControlGroup", "Result",
              "ExecMainCode", "ExecMainStatus", "StatusErrno"]
    result = command(["systemctl", "show", name, "--property=" + ",".join(fields)], check=False)
    state = {}
    for line in result.stdout.decode().splitlines():
        key, separator, value = line.partition("=")
        if not separator or key not in fields:
            continue
        if value.isdecimal():
            value = int(value)
        state[key] = value
    group = state.get("ControlGroup")
    if isinstance(group, str) and (group == "/g05native.slice" or group.startswith("/g05native.slice/")):
        path = Path("/sys/fs/cgroup") / group.lstrip("/")
        events = path / "memory.events"
        if events.is_file():
            state["memory_events"] = {line.split()[0]: int(line.split()[1]) for line in events.read_text().splitlines()}
        cpu = (path / "cpu.max").read_text().split()
        require(len(cpu) == 2 and all(value.isdecimal() for value in cpu), "Native CPU quota is unbounded")
        state["kernel_budget"] = {"cpu_quota_usec": int(cpu[0]), "cpu_period_usec": int(cpu[1]),
                                  "memory_bytes": int((path / "memory.max").read_text()),
                                  "swap_bytes": int((path / "memory.swap.max").read_text()),
                                  "pids": int((path / "pids.max").read_text())}
        state["cpu_stat"] = {line.split()[0]: int(line.split()[1]) for line in (path / "cpu.stat").read_text().splitlines()}
    pid = state.get("MainPID", 0)
    if isinstance(pid, int) and pid > 0:
        process = Path("/proc") / str(pid)
        try:
            links = list((process / "fd").iterdir())
            sockets = 0
            for link in links:
                try:
                    sockets += int(os.readlink(link).startswith("socket:["))
                except FileNotFoundError:
                    continue
            state["fd_count"] = len(links)
            state["socket_count"] = sockets
            state["task_count"] = len(list((process / "task").iterdir()))
        except FileNotFoundError:
            state["process_exited_during_sample"] = True
    return state


def running_binary_identity(installed, running, provided):
    expected, observed = installed.stat(), running.stat()
    require((expected.st_dev, expected.st_ino) == (observed.st_dev, observed.st_ino),
            "Native app runs another executable inode")
    values = []
    for path in [running, provided]:
        require(path.stat().st_size <= 64 * 1024 ** 2, "Native executable exceeds its hash budget")
        with path.open("rb") as stream:
            values.append(hashlib.file_digest(stream, "sha256").hexdigest())
    require(values[0] == values[1], "Native app differs from the provided frozen artifact")
    return {"running_binary_sha256": values[0], "provided_binary_sha256": values[1], "same_deployed_inode": True}


def binary_identity():
    state = unit_state(UNIT)
    pid = state.get("MainPID")
    require(type(pid) is int and pid > 0 and state.get("ActiveState") == "active"
            and state.get("ControlGroup", "").startswith("/g05native.slice/"), "Native identity requires the active owned app")
    return running_binary_identity(Path("/usr/local/lib/nelcota/nelcota"), Path("/proc") / str(pid) / "exe", Path("/usr/local/bin/nelcota"))


def resource_report():
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        fields = line.split()
        if fields[0] in {"MemTotal:", "MemAvailable:"}:
            memory[fields[0].removesuffix(":")] = int(fields[1]) * 1024
    fs = os.statvfs("/")
    disks = {}
    for role, path in {"postgres": Path("/var/lib/postgresql/17/main"),
                       "postgres_sentinel": Path("/var/lib/postgresql/17/sentinel"),
                       "storage": Path("/var/lib/nelcota-stress")}.items():
        if path.exists():
            resolved = path.resolve(strict=True)
            require(resolved in {Path("/var/lib/postgresql/17/main"), Path("/var/lib/postgresql/17/sentinel"), Path("/var/lib/nelcota-stress"),
                                 Path("/var/lib/private/nelcota-stress")}, "Guest disk owner path changed")
            result = command(["du", "-sxk", str(resolved)])
            disks[role] = int(result.stdout.split()[0]) * 1024
    return {"memory_bytes": memory, "disk_bytes": disks,
            "free_filesystem_fraction": fs.f_bavail / fs.f_blocks,
            "free_inode_fraction": fs.f_favail / fs.f_files,
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "units": {name: unit_state(name) for name in [UNIT, "postgresql@17-main.service", "postgresql@17-sentinel.service", "caddy.service"]},
            "target_slice": unit_state("g05native.slice")}


def journal_categories(content):
    """Publish fixed categories only, never log messages or interpolated values."""
    patterns = {
        "exec_failure": ["failed to execute", "failed at step exec", "exec format error", "status=203/exec"],
        "environment_failure": ["failed to load environment", "environment file"],
        "permission_failure": ["permission denied", "status=217/user", "status=216/group"],
        "namespace_failure": ["failed to set up mount", "status=226/namespace", "failed at step namespace"],
        "database_authentication_failure": ["password authentication failed"],
        "database_unavailable": ["connection refused", "could not connect", "database unavailable"],
        "missing_file": ["no such file or directory", "not a directory"],
        "readonly_filesystem": ["read-only file system"],
        "configuration_failure": ["invalid configuration", "configuration error", "failed to parse", "invalid value"],
        "panic": ["panicked at"],
        "oom": ["out of memory", "oom-kill"],
    }
    value = content.casefold()
    return {name: sum(value.count(pattern) for pattern in phrases) for name, phrases in patterns.items()}


def diagnostic_file(path, *, binary=False, environment=False):
    """Metadata for fixed owned paths; environment contents are never published."""
    if not path.exists() and not path.is_symlink():
        return {"exists": False}
    info = path.lstat()
    value = {"exists": True, "regular": stat.S_ISREG(info.st_mode), "symlink": path.is_symlink(),
             "size_bytes": info.st_size, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
    if binary and value["regular"] and 4 <= info.st_size <= 64 * 1024 ** 2:
        with path.open("rb") as stream:
            value["ELF_header"] = stream.read(4) == b"\x7fELF"
        if value["ELF_header"]:
            with path.open("rb") as stream:
                value["sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    if environment and value["regular"] and info.st_size <= 65536:
        with path.open("rb") as stream:
            data = stream.read(65537)
        value["content_shape_available"] = len(data) <= 65536
        if value["content_shape_available"]:
            value["contains_NUL"] = b"\x00" in data
            value["UTF8_valid"] = False
            try:
                text = data.decode("utf-8")
                value["UTF8_valid"] = True
                value["declared_keys"] = {key: any(line.lstrip().startswith(key + "=") for line in text.splitlines())
                                          for key in ["NELCOTA_DATABASE_URL", "NELCOTA_AUTHENTICATOR_PASSWORD", "NELCOTA_STORAGE_DIR"]}
            except UnicodeDecodeError:
                pass
    return value


def install_limits(*, sentinel=False):
    slice_path = Path("/etc/systemd/system/g05native.slice")
    require(not slice_path.exists(), "Native slice already exists")
    slice_path.write_text("[Slice]\nCPUQuota=150%\nMemoryMax=2G\nMemorySwapMax=0\nTasksMax=768\n")
    limits = {UNIT: ("100%", "128M", 128), "postgresql@17-main.service": ("100%", "512M", 256),
              "caddy.service": ("25%", "128M", 128)}
    if sentinel:
        limits["postgresql@17-sentinel.service"] = ("100%", "384M", 256)
    for name, (cpu, memory, tasks) in limits.items():
        directory = Path("/etc/systemd/system") / (name + ".d")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "90-g05-budgets.conf").write_text(
            "[Service]\nSlice=g05native.slice\nCPUQuota=" + cpu + "\nMemoryMax=" + memory +
            "\nMemorySwapMax=0\nTasksMax=" + str(tasks) + "\n")
    command(["systemctl", "daemon-reload"])
    return limits


def write_migration():
    migrations = ROOT / "projects/stress/migrations"
    (migrations / "V1__native_probe.sql").write_text(
        "CREATE TABLE public.native_probe (id bigint PRIMARY KEY, owner uuid NOT NULL DEFAULT auth.uid(), value integer NOT NULL);\n"
        "ALTER TABLE public.native_probe ENABLE ROW LEVEL SECURITY;\n"
        "CREATE POLICY owner ON public.native_probe FOR ALL TO authenticated USING (owner=auth.uid()) WITH CHECK (owner=auth.uid());\n"
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.native_probe TO authenticated, service_role;\n")


def prepare():
    require(not ROOT.exists(), "Native project root already exists")
    if shutil.which("pg_lsclusters") is not None:
        clusters = command(["pg_lsclusters", "--no-header"], check=False)
        require(clusters.returncode == 0, "Cannot inventory existing guest PostgreSQL clusters")
        require(not clusters.stdout.strip(), "Guest image already contains PostgreSQL clusters")
    limits = install_limits()
    cli("init", "--local", "--project", PROJECT, "--runtime", "systemd", "--profile", "1gb", "--yes", timeout=600)
    write_migration()
    cli("up", timeout=90)
    cli("-p", PROJECT, "migrate", timeout=60)
    cli("-p", PROJECT, "migrate", timeout=60)
    sql("INSERT INTO storage.buckets (id,public) VALUES ('native',false);\n")
    units = {name: unit_state(name) for name in limits}
    require(all(value.get("ActiveState") == "active" for value in units.values()), "A native unit is not active")
    require(all(value.get("ControlGroup", "").startswith("/g05native.slice/") for value in units.values()), "A native unit escaped its slice")
    budgets = {UNIT: (1, 128 * 1024 ** 2, 128), "postgresql@17-main.service": (1, 512 * 1024 ** 2, 256),
               "caddy.service": (0.25, 128 * 1024 ** 2, 128)}
    for name, (cpu, memory, pids) in budgets.items():
        actual = units[name]["kernel_budget"]
        require(actual["cpu_quota_usec"] == cpu * actual["cpu_period_usec"] and
                actual["memory_bytes"] == memory and actual["swap_bytes"] == 0 and actual["pids"] == pids,
                "Native unit kernel limits differ from its declared budget")
    parent = unit_state("g05native.slice")
    actual = parent["kernel_budget"]
    require(actual["cpu_quota_usec"] == 1.5 * actual["cpu_period_usec"] and
            actual["memory_bytes"] == 2 * 1024 ** 3 and actual["swap_bytes"] == 0 and actual["pids"] == 768,
            "Native aggregate kernel limits differ from the declared OS reserve")
    identity = binary_identity()
    return {"checks": ["native init", "native systemd up", "repeatable application migration", "native unit budgets", "actual running ELF identity"],
            "units": units, "target_slice": parent, "versions": versions(),
            "binary_sha256": identity["provided_binary_sha256"], "running_binary_identity": identity}


def backup():
    cli("-p", PROJECT, "backup", "--keep", "3", timeout=120)
    dumps = list((ROOT / "projects/stress/backups").glob("*.dump"))
    require(bool(dumps), "No native backup produced")
    dump = max(dumps, key=lambda path: path.stat().st_mtime_ns)
    manifest = dump.with_name(dump.name + ".files") / "manifest.json"
    require(manifest.is_file(), "Native backup has no file manifest")
    return {"dump": str(dump), "bytes": dump.stat().st_size,
            "sha256": hashlib.file_digest(dump.open('rb'), 'sha256').hexdigest(),
            "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("identity")
    parser.add_argument("action", choices=["prepare", "resources", "identity", "token", "backup", "restore", "remove", "diagnostics", "cluster-routing", "default-root", "host-root", "remove-boundary",
                                        "inflight-arm", "inflight-hold", "inflight-status", "inflight-disarm"])
    parser.add_argument("--dump")
    args = parser.parse_args()
    owned(args.identity)
    if args.action.startswith("inflight-"):
        from native_inflight import run
        print(json.dumps(run(args.identity, args.action), allow_nan=False))
        return
    if args.action in {"default-root", "host-root", "remove-boundary"}:
        from native_contracts import run
        print(json.dumps(run(args.action), allow_nan=False))
        return
    if args.action == "cluster-routing":
        from native_cluster import run
        print(json.dumps(run(), allow_nan=False))
        return
    if args.action == "prepare":
        print(json.dumps(prepare(), allow_nan=False))
        return
    if args.action == "resources":
        print(json.dumps(resource_report(), allow_nan=False))
        return
    if args.action == "identity":
        print(json.dumps(binary_identity(), allow_nan=False))
        return
    if args.action == "token":
        # This output travels only over authenticated SSH into controller memory.
        print(cli("-p", PROJECT, "token", "service-role").stdout.decode().strip())
        return
    if args.action == "backup":
        print(json.dumps(backup(), allow_nan=False))
        return
    if args.action == "restore":
        require(args.dump is not None, "Missing backup path")
        dump = Path(args.dump).resolve(strict=True)
        require(dump.is_relative_to(ROOT / "projects/stress/backups"), "Unowned native backup path")
        cli("-p", PROJECT, "restore", str(dump), "--files", "--yes", timeout=180)
        print(json.dumps({"checks": ["native database and file restore"]}))
        return
    if args.action == "remove":
        cli("-p", PROJECT, "remove", "--yes", timeout=180)
        require(not Path("/etc/systemd/system/" + UNIT).exists(), "Native unit remained after remove")
        clusters = command(["pg_lsclusters", "--no-header"]).stdout.decode().splitlines()
        require(not any(line.split()[:2] == ["17", "main"] for line in clusters), "Native cluster remained after remove")
        require(not Path("/var/lib/nelcota-native/owner.json").exists(), "Native machine owner remained after complete removal")
        empty_up = cli("up", timeout=20, check=False)
        require(empty_up.returncode != 0 and b"no single native project" in empty_up.stderr + empty_up.stdout,
                "Empty native host was allowed to mutate machine resources")
        require(not Path("/var/lib/nelcota-native/owner.json").exists(), "Empty native host reclaimed machine ownership")
        print(json.dumps({"checks": ["native remove", "native unit and cluster teardown", "machine ownership released after complete removal", "empty old host cannot reclaim machine resources"]}))
        return
    # Fixed categories preserve useful failure evidence without publishing logs,
    # generated panel credentials, SQL, tokens or request/response bodies.
    categories = ["password authentication failed", "Permission denied", "address already in use",
                  "Failed to set up mount", "Failed at step", "Out of memory", "could not connect",
                  "could not open", "checksum", "not found", "Error:"]
    log = Path("/opt/g05-native-private.log")
    content = ""
    if log.is_file():
        content = log.read_bytes()[-1048576:].decode(errors="replace")
    journal = command(["journalctl", "--quiet", "--no-pager", "--boot", "--unit", UNIT,
                       "--lines", "96", "--output=cat"], check=False, timeout=10)
    text = journal.stdout[-1048576:].decode(errors="replace")
    print(json.dumps({"error_categories": {value: content.count(value) for value in categories},
                      "CLI_category_scope": "Failed CLI command output only; zero does not establish an error-free service journal",
                      "journal_read_exit": journal.returncode, "journal_bytes_observed": len(journal.stdout),
                      "journal_tail_truncated": len(journal.stdout) > 1048576,
                      "journal_error_categories": journal_categories(text),
                      "files": {"deployed_binary": diagnostic_file(Path("/usr/local/lib/nelcota/nelcota"), binary=True),
                                "provided_binary": diagnostic_file(Path("/usr/local/bin/nelcota"), binary=True),
                                "environment": diagnostic_file(ENV, environment=True),
                                "unit": diagnostic_file(Path("/etc/systemd/system") / UNIT)},
                      "resources": resource_report()}, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"failure_type": type(error).__name__, "reason": str(error)[:512]}))
        raise SystemExit(1)
