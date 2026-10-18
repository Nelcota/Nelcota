"""Reproduce native cluster selection using only two owned guest clusters."""

import shutil

from native_guest import ROOT, PROJECT, command, cli, install_limits, require, unit_state


def query(cluster, statement):
    require(cluster in {"17/main", "17/sentinel"}, "Unknown guest cluster")
    return command(["runuser", "-u", "postgres", "--", "psql", "--cluster", cluster,
                    "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", "postgres"],
                   value=statement.encode()).stdout.decode().strip()


def run():
    require(not ROOT.exists(), "Collision probe requires a fresh project root")
    if shutil.which("pg_lsclusters") is not None:
        clusters = command(["pg_lsclusters", "--no-header"])
        require(not clusters.stdout.strip(), "Collision probe requires an empty disposable guest")
    install_limits(sentinel=True)
    # Same signed PGDG package source used by native provisioning, inside the VM.
    script = """set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg postgresql-common
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
apt-get install -y -q postgresql-17
"""
    command(["sh", "-c", script], timeout=600)
    command(["pg_ctlcluster", "17", "main", "stop"])
    command(["pg_conftool", "17", "main", "set", "port", "5433"])
    command(["pg_createcluster", "17", "sentinel", "--port", "5432", "--start"], timeout=60)
    query("17/sentinel", "CREATE TABLE public.g05_cluster_sentinel (id integer PRIMARY KEY); INSERT INTO public.g05_cluster_sentinel VALUES (1);\n")
    before = query("17/sentinel", "SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname='postgres';\n")
    require(before == "f", "Fresh sentinel unexpectedly already has a password")
    require(query("17/sentinel", "SHOW port;\n") == "5432", "Sentinel is not on its declared port")
    # Start the named target as well, so both before/after probes use explicit
    # cluster-qualified sessions and never infer identity from a default port.
    command(["pg_ctlcluster", "17", "main", "start"])
    require(query("17/main", "SHOW port;\n") == "5433", "Target is not on its declared alternate port")
    result = cli("init", "--local", "--project", PROJECT, "--runtime", "systemd", "--profile", "1gb", "--yes",
                 timeout=650, check=False)
    layout_rejection = any(message in result.stderr for message in [
        b"native PostgreSQL requires 17/main on port 5432",
        b"port 5432 belongs to another PostgreSQL cluster",
    ])
    after = query("17/sentinel", "SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname='postgres';\n")
    require(after in {"t", "f"}, "Missing sentinel password-presence evidence")
    count = int(query("17/sentinel", "SELECT count(*) FROM public.g05_cluster_sentinel;\n"))
    configuration = "/etc/postgresql/17/main/conf.d/nelcota.conf"
    from pathlib import Path
    return {"case": "17/main at 5433; owned unrelated 17/sentinel at 5432 before native init",
            "init_exit_code": result.returncode,
            "layout_rejection_reported": layout_rejection,
            "named_target_port": 5433, "unrelated_sentinel_port": 5432,
            "sentinel_password_present_before": False, "sentinel_password_present_after": after == "t",
            "sentinel_password_changed": before != after,
            "sentinel_rows": count,
            "host_root_created": ROOT.exists(), "native_postgres_configuration_written": Path(configuration).exists(),
            "units": {name: unit_state(name) for name in ["postgresql@17-main.service", "postgresql@17-sentinel.service"]},
            "scope": "Both clusters are generated fixtures in the uniquely owned VM. No existing host data or production resources were used."}
