"""Disposable, resource-limited release campaign; no Node runtime required.

Usage: python3 bench/campaign.py --binary /absolute/nelcota --output target/campaign
All containers, runtime secrets and storage fixtures are owned by this run.
Diagnostics contain metrics and redacted application logs, not credentials.
"""

import argparse
import base64
import datetime
from concurrent.futures import ThreadPoolExecutor
from collections import deque
import hashlib
import hmac
import json
import math
import os
import re
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/upgrade"))
from support import Receiver
sys.path.insert(0, str(ROOT / "bench"))
from watchdog import LABEL, atomic_json, host_reserves, process_identity, stop_generator
from metrics import NativeMetrics, PROMETHEUS, STORAGE_PROFILE, storage_arguments
from latency import PROTOCOL as LATENCY_PROTOCOL
from arrival_counters import PROTOCOL as ARRIVAL_COUNTER_PROTOCOL
from receiver import EventLedger
from observations import generator_observation, GENERATOR_PROTOCOL
from http_counters import PROTOCOL as HTTP_COUNTER_PROTOCOL
from objects import S3Inventory, disk_inventory, reconcile
from host_resources import snapshot as host_snapshot, owned_cgroup_snapshot, require_no_oom
from ownership import LOG_PROFILE,OwnedDocker
from postgres_evidence import STATISTICS_SQL,retain_failure
from disk_usage import container as container_disk_usage,host as host_disk_usage

K6 = "grafana/k6:1.6.1@sha256:a5ad6bc089a08d77c3ec49f3db8c6fa7a148e4073efcac44c675dbaf3568d8e1"
NOMINAL_SLOS = {"read": (200, 500), "rls": (200, 500), "refresh": (200, 500), "login": (750, 1500), "storage": (500, 2000), "panel": (500, 2000), "write": (500, 1500)}


def nominal_violations(report, workload):
    violations = []
    names = [workload]
    if workload == "mixed":
        names = list(NOMINAL_SLOS)
    for name in names:
        metric = report["metrics"].get("latency_" + name)
        if not metric:
            violations.append({"workload": name, "missing_latency": True})
            continue
        for key, maximum in zip(["p(95)", "p(99)"], NOMINAL_SLOS[name]):
            value = metric.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 or value > maximum:
                violations.append({"workload": name, "metric": key, "observed": str(value), "maximum_ms": maximum})
    return violations


def docker(*arguments, stdin=None, include_stderr=False, env=None):
    try:
        result = subprocess.run(
            ["docker", *map(str, arguments)],
            input=stdin,
            text=True,
            capture_output=True,
            timeout=45,
            env={**os.environ, **(env or {})},
        )
    except subprocess.TimeoutExpired:
        # Docker run arguments contain fixture credentials. Do not propagate a
        # TimeoutExpired whose default representation prints those arguments.
        raise RuntimeError("Docker operation timed out: " + arguments[0]) from None
    if result.returncode:
        raise RuntimeError(
            "Docker operation failed: " + arguments[0] + " " + result.stderr[-800:]
        )
    if include_stderr:
        return (result.stdout + result.stderr).strip()
    return result.stdout.strip()


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def owns_listener(container, port):
    evidence = docker("exec", container, "sh", "-c", "ls -l /proc/1/fd; cat /proc/1/net/tcp /proc/1/net/tcp6")
    owned = set(re.findall(r"socket:\[(\d+)\]", evidence))
    for line in evidence.splitlines():
        fields = line.split()
        if len(fields) < 10 or fields[3] != "0A" or fields[9] not in owned:
            continue
        if int(fields[1].rsplit(":", 1)[1], 16) == port:
            return True
    return False


def validate_storage_filesystem(backend, filesystem):
    if backend == "disk" and filesystem in ("tmpfs", "ramfs"):
        raise RuntimeError("Real disk storage campaign cannot use a memory filesystem")


def validate_disk_headroom(path, fixture_mib, startup_mib=1536):
    stats = os.statvfs(path)
    reserved = stats.f_blocks * .15
    available = (stats.f_bavail - reserved) * stats.f_frsize
    required = (fixture_mib + startup_mib + 512) * 1024 * 1024
    if available < required:
        raise RuntimeError('Insufficient disk growth headroom above the 15% reserve')


def effective_cpus(affinity):
    path = Path('/sys/fs/cgroup/cpu.max')
    if not path.exists():
        return float(len(affinity))
    quota, period = path.read_text().split()
    if quota == 'max':
        return float(len(affinity))
    return min(float(len(affinity)), int(quota) / int(period))


def redacted_diagnostic(error, values):
    message = str(error)
    for value in values:
        if isinstance(value, str) and len(value) > 8:
            message = message.replace(value, '<redacted>')
    return message[-1200:]


def component_identity(value):
    state=value['State']
    if not state['Running'] or state['OOMKilled'] or isinstance(state['Pid'],bool) or not isinstance(state['Pid'],int) or state['Pid']<=0 or not value.get('Id') or not state.get('StartedAt'):
        raise RuntimeError('Component has no valid live process identity')
    return {'container_id':value['Id'],'pid':state['Pid'],'started_at':state['StartedAt']}


def verify_continuity(expected,current):
    if not expected or expected!=current:
        raise RuntimeError('Endurance component process identity changed')


def aged_storage_key():
    milliseconds=int((time.time()-8*86400)*1000)
    bits=(milliseconds<<80)|(7<<76)|(secrets.randbits(76)&~(3<<62))|(2<<62)
    return 'bench/'+str(uuid.UUID(int=bits))


class ResourceCoverage:
    """Constant-space coverage independent of the bounded diagnostic window."""

    def __init__(self):
        self.count = 0
        self.last = 0.0
        self.maximum_gap = 0.0
        self.invalid = False

    def observe(self, elapsed):
        if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)):
            self.invalid = True
            return
        if not math.isfinite(elapsed) or elapsed < self.last:
            self.invalid = True
            return
        self.maximum_gap = max(self.maximum_gap, elapsed - self.last)
        self.last = elapsed
        self.count += 1

    def violations(self, duration_seconds):
        if self.invalid or not math.isfinite(duration_seconds) or duration_seconds < self.last:
            return [{"invalid_resource_clock": True}]
        if self.count < 2:
            return [{"resource_samples": self.count, "minimum": 2}]
        gap = max(self.maximum_gap, duration_seconds - self.last)
        if gap > 30:
            return [{"maximum_sample_gap_seconds": gap, "limit": 30}]
        return []


def resource_evidence_violations(samples, duration_seconds):
    coverage = ResourceCoverage()
    for sample in samples:
        coverage.observe(sample.get("elapsed"))
    return coverage.violations(duration_seconds)


def generator_deadline(duration):
    if not re.fullmatch(r"[1-9][0-9]*s", duration):
        raise ValueError("Generator duration must be positive integer seconds")
    seconds = int(duration[:-1])
    if seconds > 14400:
        raise ValueError("Generator duration exceeds the four-hour budget")
    return seconds + 120


def token(secret, claims):
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
    head = encode(b'{"alg":"HS256","typ":"JWT"}')
    body = encode(json.dumps(claims).encode())
    signing = (head + "." + body).encode()
    return (
        head
        + "."
        + body
        + "."
        + encode(hmac.new(secret.encode(), signing, hashlib.sha256).digest())
    )


def request(base, path, value=None, headers=None, method=None):
    data = None
    if value is not None:
        data = json.dumps(value).encode()
    request = urllib.request.Request(
        base + path,
        data=data,
        headers={"content-type": "application/json", **(headers or {})},
        method=method,
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response), response.headers


def campaign(arguments):
    output = arguments.output.resolve()
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise RuntimeError(
            "Use a new empty output directory; previous reports must not be overwritten"
        )
    output.mkdir(parents=True, exist_ok=True)
    if host_reserves(output):
        raise RuntimeError("Host resource reserves do not permit a campaign")
    validate_disk_headroom(output, arguments.fixture_disk_mib+arguments.storage_fixture_disk_mib)
    identity = "nelcota-bench-" + secrets.token_hex(16)
    allocation_profile = None
    allocation_directory = None
    allocation_error = None
    if getattr(arguments, 'allocation_probe', None) is not None:
        from allocation import validate_library
        allocation_profile = validate_library(arguments.allocation_probe)
    owned=OwnedDocker(identity,docker)
    cpus = sorted(os.sched_getaffinity(0))
    if len(cpus) < 4:
        raise RuntimeError(
            "Campaign needs four CPU slots for app, DB, generator and telemetry"
        )
    if arguments.backend == "s3" and len(cpus) < 4:
        raise RuntimeError(
            "S3 campaign needs four CPUs for app, DB, generator and object service"
        )
    required_cpus = 3.5
    if arguments.backend == "s3":
        required_cpus = 4.0
    if effective_cpus(cpus) < required_cpus:
        raise RuntimeError("Effective CPU quota cannot cover the declared fixture and observer budgets")
    pg, app = identity + "-pg", identity + "-app"
    s3 = identity + "-s3"
    volume = identity + "-data"
    generator = identity + "-load"
    telemetry = identity + "-metrics"
    telemetry_volume = identity + "-metrics-data"
    s3_volume=identity+'-s3-data'
    receiver = Receiver()
    event_ledger = EventLedger(output / "event-identities.sqlite")
    receiver.requests = event_ledger
    receiver.errors = deque(maxlen=256)
    stop = threading.Event()
    restarting = threading.Event()
    sampling_epoch = 0
    samples = []
    coverage = ResourceCoverage()
    critical = threading.Event()
    resource_violations = []
    sampler = None
    watchdog = None
    heartbeat_stop = threading.Event()
    heartbeat_thread = None
    resource_monotonic = time.monotonic()
    phase = "preparation"
    load_seconds = 0.0
    validated = False
    metadata = {}
    soak_started = None
    retention = []
    active_generator = None
    soak_processes = None
    js_snapshot = output / "campaign.js"
    shutil.copyfile(ROOT / "bench/campaign.js", js_snapshot)
    labels = ["--label", LABEL + "=" + identity, "--pids-limit", "256"]
    previous_handler = signal.getsignal(signal.SIGTERM)

    def terminate(signum, frame):
        critical.set()
        stop_generator({'identity':identity,'output':str(output)})
        raise RuntimeError("Campaign stopped by independent watchdog or termination")

    signal.signal(signal.SIGTERM, terminate)
    temporary_directory = tempfile.TemporaryDirectory(prefix="fixture-", dir=output)
    with temporary_directory as temporary:
        directory = Path(temporary)
        storage = directory / "storage"
        storage.mkdir()
        storage_filesystem = subprocess.check_output(["stat", "-f", "-c", "%T", str(storage)], text=True).strip()
        validate_storage_filesystem(arguments.backend, storage_filesystem)
        try:
            manifest = {"identity": identity, "output": str(output), "reserve_path": str(output), "pid": os.getpid(), "process_identity": process_identity(os.getpid()), "started_monotonic": time.monotonic(), "maximum_seconds": 21600, "preparation_seconds":900,"containers": [generator, app, pg, s3, telemetry], "volumes": [volume, telemetry_volume,s3_volume]}
            atomic_json(output / "ownership.json", manifest)

            def heartbeat():
                while not heartbeat_stop.is_set():
                    atomic_json(output / "heartbeat.json", {"monotonic": time.monotonic(), "phase": phase, "resource_monotonic": resource_monotonic, "load_seconds_completed": load_seconds, "resource_observations": coverage.count})
                    heartbeat_stop.wait(2)

            heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
            atomic_json(output / "heartbeat.json", {"monotonic": time.monotonic(), "phase": phase, "resource_monotonic": resource_monotonic, "load_seconds_completed": 0})
            heartbeat_thread.start()
            watchdog = subprocess.Popen([sys.executable, str(ROOT / "bench/watchdog.py"), str(output / "ownership.json")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            metrics_port = free_port()
            metrics_url = f"http://127.0.0.1:{metrics_port}"
            config = directory / "prometheus.yml"
            config.write_text("global:\n  scrape_interval: 15s\nscrape_configs: []\n")
            config.chmod(0o444)
            owned("volume", "create", "--label", LABEL + "=" + identity, telemetry_volume)
            owned("run", "-d", *labels, "--name", telemetry, "--network", "host", "--cpus", "0.25", "--cpuset-cpus", str(cpus[-1]), "--memory", "512m", "--memory-swap", "512m", "--user", "65534:65534", "--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges", "--mount", f"type=volume,source={telemetry_volume},destination=/prometheus", "-v", str(config) + ":/etc/prometheus/prometheus.yml:ro", PROMETHEUS, "--config.file=/etc/prometheus/prometheus.yml", "--web.listen-address=127.0.0.1:" + str(metrics_port), "--web.enable-remote-write-receiver", "--enable-feature=native-histograms", *storage_arguments())
            metrics_ready = False
            for attempt in range(100):
                try:
                    if not owns_listener(owned.require(telemetry), metrics_port):
                        time.sleep(.1)
                        continue
                    with urllib.request.urlopen(metrics_url + '/-/ready', timeout=2):
                        metrics_ready = True
                        break
                except (urllib.error.URLError, TimeoutError):
                    if attempt == 99:
                        raise RuntimeError("Metrics receiver readiness deadline")
                    time.sleep(.1)
            if not metrics_ready:
                raise RuntimeError("Metrics listener ownership could not be confirmed")
            native_metrics = NativeMetrics(metrics_url, retain_http_counters=True)
            pg_password = secrets.token_urlsafe(32)
            authenticator = secrets.token_urlsafe(32)
            jwt = secrets.token_urlsafe(48)
            password = secrets.token_urlsafe(32)
            owned("volume", "create", "--label", LABEL + "=" + identity, volume)
            owned(
                "run",
                "-d",
                *labels,
                "--name",
                pg,
                "--cpus",
                "1",
                "--cpuset-cpus",
                str(cpus[1]),
                "--memory",
                "384m",
                "--memory-swap",
                "384m",
                "-e",
                "POSTGRES_PASSWORD",
                "-p",
                "127.0.0.1::5432",
                "--mount",
                f"type=volume,source={volume},destination=/var/lib/postgresql/data",
                "postgres:17-alpine",
                "postgres",
                "-c",
                "max_connections=40",
                "-c",
                "shared_buffers=64MB",
                "-c",
                "max_wal_size="+str(arguments.wal_mib)+"MB",
                "-c",
                "min_wal_size=32MB",
                "-c",
                "shared_preload_libraries=pg_stat_statements",
                '-c','track_io_timing=on',
                '-c','track_wal_io_timing=on',
                '-c','log_lock_waits=on',
                '-c','deadlock_timeout=100ms',
                '-c','log_min_duration_statement=1000',
                env={"POSTGRES_PASSWORD": pg_password},
            )
            port = int(
                json.loads(owned("inspect", pg))[0]["NetworkSettings"]["Ports"][
                    "5432/tcp"
                ][0]["HostPort"]
            )
            for _ in range(100):
                result = subprocess.run(
                    [
                        "docker",
                        "exec",
                        pg,
                        "pg_isready",
                        "-h",
                        "127.0.0.1",
                        "-U",
                        "postgres",
                    ],
                    capture_output=True,
                )
                if result.returncode == 0:
                    break
                time.sleep(0.1)
            app_port = free_port()
            base = f"http://127.0.0.1:{app_port}"
            env = {
                "TOKIO_WORKER_THREADS": "2",
                "RUST_LOG": "warn",
                "NELCOTA_DATABASE_URL": f"postgres://postgres:{pg_password}@127.0.0.1:{port}/postgres",
                "NELCOTA_AUTHENTICATOR_PASSWORD": authenticator,
                "NELCOTA_JWT_SECRET": jwt,
                "NELCOTA_LISTEN": f"127.0.0.1:{app_port}",
                "NELCOTA_DB_POOL_SIZE": "8",
                "NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE": "100000",
                "NELCOTA_REQUEST_TIMEOUT_SECS": "5",
                "NELCOTA_STATEMENT_TIMEOUT_SECS": "3",
                "NELCOTA_STORAGE_BACKEND": "disk",
                "NELCOTA_STORAGE_DIR": "/storage",
                "NELCOTA_STORAGE_MIN_FREE_BYTES": "0",
                "NELCOTA_WEBHOOKS_ALLOW_LOOPBACK": "true",
            }
            if arguments.backend == "s3":
                access, secret = secrets.token_hex(16), secrets.token_hex(32)
                owned('volume','create','--label',LABEL+'='+identity,s3_volume)
                owned(
                    "run",
                    "-d",
                    *labels,
                    "--name",
                    s3,
                    "--cpus",
                    "0.5",
                    "--cpuset-cpus",
                    str(cpus[3]),
                    "--memory",
                    str(arguments.s3_memory_mib)+'m',
                    "--memory-swap",
                    str(arguments.s3_memory_mib)+'m',
                    '--mount',
                    f'type=volume,source={s3_volume},destination=/data',
                    "-e",
                    "RUSTFS_ACCESS_KEY",
                    "-e",
                    "RUSTFS_SECRET_KEY",
                    "-p",
                    "127.0.0.1::9000",
                    "rustfs/rustfs:1.0.1",
                    env={"RUSTFS_ACCESS_KEY": access, "RUSTFS_SECRET_KEY": secret},
                )
                s3_port = int(
                    json.loads(owned("inspect", s3))[0]["NetworkSettings"]["Ports"][
                        "9000/tcp"
                    ][0]["HostPort"]
                )
                endpoint = f"http://127.0.0.1:{s3_port}"
                for attempt in range(100):
                    moment = datetime.datetime.now(datetime.timezone.utc)
                    day, stamp = (
                        moment.strftime("%Y%m%d"),
                        moment.strftime("%Y%m%dT%H%M%SZ"),
                    )
                    digest = hashlib.sha256(b"").hexdigest()
                    host = f"127.0.0.1:{s3_port}"
                    headers = f"host:{host}\nx-amz-content-sha256:{digest}\nx-amz-date:{stamp}\n"
                    scope = f"{day}/us-east-1/s3/aws4_request"
                    canonical = f"PUT\n/benchmark-files\n\n{headers}\nhost;x-amz-content-sha256;x-amz-date\n{digest}"
                    message = f"AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
                    key = ("AWS4" + secret).encode()
                    for value in [day, "us-east-1", "s3", "aws4_request"]:
                        key = hmac.new(key, value.encode(), hashlib.sha256).digest()
                    authorization = f"AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={hmac.new(key, message.encode(), hashlib.sha256).hexdigest()}"
                    bucket = urllib.request.Request(
                        endpoint + "/benchmark-files",
                        data=b"",
                        method="PUT",
                        headers={
                            "Authorization": authorization,
                            "x-amz-date": stamp,
                            "x-amz-content-sha256": digest,
                        },
                    )
                    try:
                        with urllib.request.urlopen(bucket, timeout=2):
                            break
                    except (urllib.error.URLError, TimeoutError):
                        if attempt == 99:
                            raise RuntimeError("S3 fixture did not become ready")
                        time.sleep(0.2)
                env.update(
                    {
                        "NELCOTA_STORAGE_BACKEND": "s3",
                        "NELCOTA_STORAGE_S3_ENDPOINT": endpoint,
                        "NELCOTA_STORAGE_S3_BUCKET": "benchmark-files",
                        "NELCOTA_STORAGE_S3_REGION": "us-east-1",
                        "NELCOTA_STORAGE_S3_ACCESS_KEY_ID": access,
                        "NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY": secret,
                    }
                )

            if allocation_profile is not None:
                allocation_directory = directory/'allocator'
                allocation_directory.mkdir(mode=0o700)
                env.update({'LD_PRELOAD':'/g05-probe.so','NELCOTA_G05_ALLOC_DIR':'/g05-alloc','NELCOTA_G05_ALLOC_PERIOD_MS':'5000'})

            def sql(statement):
                return owned(
                    "exec",
                    "-i",
                    pg,
                    "psql",
                    "-Atq",
                    "-U",
                    "postgres",
                    "-v",
                    "ON_ERROR_STOP=1",
                    stdin=statement,
                )

            def start():
                command = [
                    "run",
                    "-d",
                    *labels,
                    "--name",
                    app,
                    "--network",
                    "host",
                    "--user",
                    f"{os.getuid()}:{os.getgid()}",
                    "--cpus",
                    "1",
                    "--cpuset-cpus",
                    str(cpus[0]),
                    "--memory",
                    "128m",
                    "--memory-swap",
                    "128m",
                    "-v",
                    str(arguments.binary.resolve()) + ":/usr/local/bin/nelcota:ro",
                    "-v",
                    str(storage) + ":/storage",
                ]
                if allocation_profile is not None:
                    command.extend(['--mount',f'type=bind,source={arguments.allocation_probe.resolve()},target=/g05-probe.so,readonly',
                                    '--mount',f'type=bind,source={allocation_directory},target=/g05-alloc'])
                if arguments.backend == "s3":
                    # The minimal Ubuntu fixture lacks ca-certificates. Keep
                    # TLS verification intact and supply the host trust bundle.
                    trust = Path("/etc/ssl/certs/ca-certificates.crt")
                    if not trust.is_file() or trust.stat().st_size == 0:
                        raise RuntimeError(
                            "S3 fixture needs the system CA trust bundle"
                        )
                    command.extend(
                        ["-v", str(trust) + ":/etc/ssl/certs/ca-certificates.crt:ro"]
                    )
                for key in env:
                    command.extend(["-e", key])
                command.extend(["ubuntu:24.04", "/usr/local/bin/nelcota", "serve"])
                created=owned(*command, env=env)
                for _ in range(100):
                    try:
                        if not owns_listener(created, app_port):
                            time.sleep(.1)
                            continue
                        request(base, "/auth/v1/.well-known/jwks.json")
                        return
                    except urllib.error.URLError:
                        time.sleep(0.1)
                raise RuntimeError("Application startup exceeded its budget")

            start()
            email = secrets.token_hex(8) + "@example.com"
            session, _ = request(
                base, "/auth/v1/signup", {"email": email, "password": password}
            )
            user = session["user"]["id"]
            env["NELCOTA_ADMIN_EMAIL"] = email
            env["NELCOTA_ADMIN_PASSWORD_HASH"] = sql(
                "SELECT encrypted_password FROM auth.users LIMIT 1"
            )
            owned("rm", "-f", app)
            start()
            _, headers = request(
                base,
                "/admin/api/login",
                {"email": email, "password": password},
                {"Origin": base},
            )
            cookie = headers["Set-Cookie"].split(";", 1)[0]
            service = token(
                jwt, {"role": "service_role", "exp": int(time.time()) + 21900}
            )
            sql(
                (ROOT / "bench/setup.sql")
                .read_text()
                .replace("ANALYZE public.bench_products;", "")
                .replace('100000',str(arguments.rows))
            )
            sql(
                "CREATE TABLE public.bench_private (id integer PRIMARY KEY,user_id uuid NOT NULL,body text);"
                + "INSERT INTO public.bench_private SELECT i, CASE WHEN i%2=0 THEN '"
                + user
                + "'::uuid WHEN i%2=1 THEN gen_random_uuid() END,repeat('x',128) FROM generate_series(1,"+str(arguments.rows)+") i;"
                + "CREATE INDEX ON public.bench_private(user_id,id); ALTER TABLE public.bench_private ENABLE ROW LEVEL SECURITY;"
                + "CREATE POLICY own ON public.bench_private TO authenticated USING(user_id=auth.uid());GRANT SELECT ON public.bench_private TO authenticated;"
                + "GRANT SELECT,UPDATE ON public.bench_products TO service_role;"
                + "INSERT INTO storage.buckets(id,public) VALUES('bench',true);"
                + "INSERT INTO storage.objects(bucket_id,name,version,size,mime_type,etag) SELECT 'bench',lpad(i::text,8,'0') || '.txt',gen_random_uuid(),0,'text/plain','"+hashlib.sha256(b'').hexdigest()+"' FROM generate_series(1,10000) i;"
                + "ALTER TABLE public.bench_products SET(autovacuum_enabled=false); ALTER TABLE public.bench_private SET(autovacuum_enabled=false); ALTER TABLE storage.objects SET(autovacuum_enabled=false); NOTIFY nelcota,'reload schema';"
            )
            seeded_keys=sql("SELECT bucket_id||'/'||version::text FROM storage.objects WHERE bucket_id='bench' ORDER BY version").splitlines()
            if not arguments.metadata_only_seed:
                if len(seeded_keys)!=10000:
                    raise RuntimeError('Physical fixture seed is incomplete')
                if arguments.backend=='disk':
                    (storage/'bench').mkdir(exist_ok=True)
                    for key in seeded_keys:
                        (storage/key).write_bytes(b'')
                if arguments.backend=='s3':
                    inventory_client=S3Inventory(endpoint,access,secret,'benchmark-files')
                    def seed_object(key):
                        inventory_client.write_key(key,body=b'')
                    with ThreadPoolExecutor(max_workers=8) as workers:
                        for offset in range(0,len(seeded_keys),32):
                            list(workers.map(seed_object,seeded_keys[offset:offset+32]))
                            atomic_json(output/'storage-seed-progress.json',{'completed':min(offset+32,len(seeded_keys)),'required':10000,'preparation':True})
                            if offset%1024==0:
                                allocation=container_disk_usage(owned,s3,'/data')
                                with (output/'storage-seed-disk.jsonl').open('a') as record:
                                    record.write(json.dumps({'completed_objects':min(offset+32,len(seeded_keys)),'allocation':allocation})+'\n')
                                if allocation['value']>arguments.storage_fixture_disk_mib:
                                    raise RuntimeError('S3 physical seed exceeded its declared disk budget')
            time.sleep(1)
            object_payload=b'benchmark payload'
            fixture_payload=b'"benchmark payload"'
            if arguments.object_bytes!=17:
                object_payload=b'x'*arguments.object_bytes
                fixture_payload=object_payload
            upload=urllib.request.Request(base+'/storage/v1/object/bench/fixture.txt',data=fixture_payload,headers={'Authorization':'Bearer '+service,'Content-Type':'text/plain'},method='PUT')
            with urllib.request.urlopen(upload,timeout=15) as response:
                json.load(response)
            hook, _ = request(
                base,
                "/admin/api/webhooks",
                {
                    "name": "Benchmark",
                    "table": "bench_products",
                    "url": f"http://127.0.0.1:{receiver.server_address[1]}/",
                    "events": ["UPDATE"],
                    "enabled": True,
                    "max_attempts": 3,
                },
                {"Cookie": cookie, "Origin": base},
            )
            receiver.secret = hook["secret"]
            sql("CREATE TABLE public.bench_expected_events(event_id uuid PRIMARY KEY); CREATE FUNCTION public.bench_record_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN INSERT INTO public.bench_expected_events VALUES(NEW.event_id) ON CONFLICT DO NOTHING; RETURN NEW; END $$; REVOKE ALL ON FUNCTION public.bench_record_event() FROM PUBLIC; CREATE TRIGGER bench_record_event AFTER INSERT ON nelcota.webhook_deliveries FOR EACH ROW EXECUTE FUNCTION public.bench_record_event();")
            # Runtime credentials stay in memory. Docker inherits this payload
            # from the child environment, without a plaintext fixture file or
            # credential-bearing command arguments.
            fixture = {
                "base": base,
                "email": email,
                "password": password,
                "access": token(
                    jwt,
                    {
                        "role": "authenticated",
                        "sub": user,
                        "exp": int(time.time()) + 7200,
                    },
                ),
                "user": user,
                "invalid_access": token(secrets.token_urlsafe(48), {"role": "authenticated", "sub": user, "exp": int(time.time()) + 21900}),
                "service": service,
                "cookie": cookie,
                "object_bytes":arguments.object_bytes,
            }
            metadata = {
                "binary_sha256": hashlib.file_digest(
                    arguments.binary.open("rb"), "sha256"
                ).hexdigest(),
                "git": subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
                ).strip(),
                "dirty": bool(
                    subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)
                ),
                "cpu_count": os.cpu_count(),
                "effective_cpu_quota": effective_cpus(cpus),
                "cpu_affinity": cpus[:3],
                "app_cpus": 1,
                "app_memory_mb": 128,
                "pg_cpus": 1,
                "pg_memory_mb": 384,
                "generator_memory_mb": 512,
                "generator_go_memory_limit_mib": 448,
                "generator_usage_reporting": False,
                "generator_observation_protocol": GENERATOR_PROTOCOL,
                "pg_data": "disposable disk volume",
                "max_wal_mb": arguments.wal_mib,
                "max_fixture_disk_mb": arguments.fixture_disk_mib,
                "pool": 8,
                "max_connections": 40,
                "k6": K6,
                "storage_backend": arguments.backend,
                "storage_filesystem": storage_filesystem,
                "physical_seeded_objects":10000*int(not arguments.metadata_only_seed),
                "object_payload_bytes":arguments.object_bytes,
                "max_storage_fixture_disk_mib":arguments.storage_fixture_disk_mib,
                "steady_rate": arguments.steady_rate,
                "calibration_ceiling_iterations_per_second":arguments.calibration_ceiling,
                "steady_duration": arguments.steady,
                "workloads": arguments.workloads,
                "harness_sha256": hashlib.file_digest(js_snapshot.open("rb"), "sha256").hexdigest(),
                "schema": 2,
                "offered_rate_unit": "iterations_per_second",
                "soak_seconds": arguments.soak_seconds,
                "maximum_campaign_seconds": 21600,
                "resource_sample_seconds": 5,
                "resource_protocol":"component cgroup v2, PostgreSQL IO/WAL/checkpointer/locks, process owners; allocated du totals count only disappearing child entries",
                "postgres_observation_settings":{"track_io_timing":True,"track_wal_io_timing":True,"log_lock_waits":True,"deadlock_timeout_ms":100,"log_min_duration_statement_ms":1000},
                "soak_fraction":arguments.soak_fraction,
                "container_log_profile":LOG_PROFILE,
                "pressure_rest_seconds":15,
                "final_idle_seconds":arguments.final_idle_seconds,
                "write_steady_rate":arguments.write_steady_rate,
                "client_initialization":{"maximum_sessions_per_project":128,"bootstrap_concurrency":4,"setup_timeout_seconds":120,"fully_preallocated_arrival_VUs":True,"mix_schedule":"global scenario arrival ordinal","bootstrap_excluded_from_nominal_metrics":True},
                "metrics_backend": "native Prometheus histogram; k6 raw TrendSink disabled",
                "arrival_counter_protocol": ARRIVAL_COUNTER_PROTOCOL,
                "http_counter_protocol": HTTP_COUNTER_PROTOCOL,
                "successful_latency_protocol": LATENCY_PROTOCOL,
                "metrics_memory_mb": 512,
                "metrics_storage_profile": STORAGE_PROFILE.copy(),
                "metrics_cpus": 0.25,
                "metrics_cpu_affinity": cpus[-1],
                "nominal_slos_ms": NOMINAL_SLOS,
                "auth_rate_limit_per_minute": 100000,
                "autovacuum": "enabled after fresh-statistics phase",
                "service_fixture_ttl_seconds": 21900,
                "retention_probe": "two safely aged fixture cohorts during long endurance",
                "session_canary_observation": "last regular counter sample within 3600 seconds; reject observed resets; require continuous iterations and existing renewal count gate",
                "webhook_history_maintenance": "explicit admin clear at 5000 terminal records; committed identities retained by fixture audit trigger",
                "postgres_version": sql("SELECT version();"),
                "images": {
                    image: json.loads(owned("image", "inspect", image))[0][
                        "RepoDigests"
                    ]
                    for image in ["ubuntu:24.04", "postgres:17-alpine", K6, PROMETHEUS]
                    + ["rustfs/rustfs:1.0.1"] * (arguments.backend == "s3")
                },
                "dataset": {"products": arguments.rows, "private": arguments.rows, "objects": 10000},
                "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            if arguments.backend == "s3":
                metadata["s3"] = {
                    "cpu_affinity": cpus[3],
                    "cpus": 0.5,
                    "memory_mb": arguments.s3_memory_mib,
                    "ca_bundle_sha256": hashlib.file_digest(
                        Path("/etc/ssl/certs/ca-certificates.crt").open("rb"), "sha256"
                    ).hexdigest(),
                }
            if allocation_profile is not None:
                metadata['allocator_observer']=allocation_profile
            (output / "metadata.json").write_text(json.dumps(metadata, indent=2))

            def sample():
                nonlocal resource_monotonic
                while not stop.is_set():
                    observation_started = time.monotonic()
                    if restarting.is_set():
                        stop.wait(0.1)
                        continue
                    epoch = sampling_epoch
                    sample_step = "container_stats"
                    try:
                        names = [app, pg, telemetry]
                        if arguments.backend == "s3":
                            names.append(s3)
                        stats = owned("stats", "--no-stream", "--format", "{{json .}}", *names)
                        generator_stats = None
                        sample_step = "generator_stats"
                        generator_stats = generator_observation(active_generator, lambda: active_generator)
                        if generator_stats and generator_stats.get('host_pid') and generator_stats.get('pid_starttime'):
                            atomic_json(output/'generator-process.json',{'identity':identity,'pid':generator_stats['host_pid'],'process_identity':generator_stats['pid_starttime'],'container_id':generator_stats['container_id']})
                        sample_step = "process_ownership"
                        status = owned("exec", app, "cat", "/proc/1/status")
                        rss = next(
                            int(line.split()[1])
                            for line in status.splitlines()
                            if line.startswith("VmRSS:")
                        )
                        sample_step = "database_activity"
                        activity = sql(
                            "SELECT json_build_object('connections',count(*),'active',count(*) FILTER(WHERE state='active'),'idle_in_transaction',count(*) FILTER(WHERE state='idle in transaction'),'waiting_locks',count(*) FILTER(WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE datname=current_database();"
                        )
                        sample_step = "queue_usage"
                        queue = sql(
                            "SELECT row_to_json(t) FROM (SELECT outstanding,retained FROM nelcota.webhook_queue_usage WHERE singleton) t;"
                        )
                        database_statistics=json.loads(sql(STATISTICS_SQL))
                        sample_step = "disk_budget"
                        disk_observations={'postgres':container_disk_usage(owned,pg,'/var/lib/postgresql/data'),'metrics':container_disk_usage(owned,telemetry,'/prometheus')}
                        disk=disk_observations['postgres']['value']
                        metrics_disk=disk_observations['metrics']['value']
                        storage_disk=0
                        if arguments.backend=='disk':
                            disk_observations['storage']=host_disk_usage(storage)
                            storage_disk=disk_observations['storage']['value']
                        if arguments.backend=='s3':
                            disk_observations['storage']=container_disk_usage(owned,s3,'/data')
                            storage_disk=disk_observations['storage']['value']
                        if storage_disk>arguments.storage_fixture_disk_mib:
                            resource_violations.append({'phase':phase,'component':'storage','observed_mib':storage_disk,'limit_mib':arguments.storage_fixture_disk_mib,'observed_monotonic':time.monotonic()})
                            raise RuntimeError('Storage fixture exceeded its declared disk budget')
                        if metrics_disk > 512:
                            resource_violations.append({'phase':phase,'component':'metrics','observed_mib':metrics_disk,'limit_mib':512,'observed_monotonic':time.monotonic()})
                            raise RuntimeError("Metrics fixture exceeded its 512-MiB disk budget")
                        if disk > arguments.fixture_disk_mib:
                            resource_violations.append({"pg_disk_mib": disk,"limit_mib":arguments.fixture_disk_mib,"phase":phase,"observed_monotonic":time.monotonic()})
                            raise RuntimeError(
                                "Fixture exceeded its declared disk budget"
                            )
                        inspected = {name:json.loads(owned("inspect", name))[0] for name in names}
                        states = [value['State'] for value in inspected.values()]
                        if any(not state["Running"] or state["OOMKilled"] for state in states):
                            raise RuntimeError("Unexpected fixture stop or OOM")
                        memory_events={}
                        cgroups={}
                        for name,value in inspected.items():
                            cgroups[name]=owned_cgroup_snapshot(owned,name)
                            events=cgroups[name]['memory.events']
                            memory_events[name]=events
                            try:
                                require_no_oom(events)
                            except (ValueError,RuntimeError):
                                atomic_json(output/'memory-events-violation.json',memory_events)
                                raise
                        if phase=='soak' and soak_processes is not None:
                            verify_continuity(soak_processes,{name:component_identity(inspected[name]) for name in [app,pg]})
                        if receiver.errors:
                            raise RuntimeError("Webhook signature invariant failed")
                        reserve = host_reserves(output)
                        if reserve:
                            raise RuntimeError(reserve)
                        if epoch != sampling_epoch:
                            continue
                        if arguments.soak_seconds >= 7200 and phase == "soak" and soak_started is not None:
                            sample_step = "retention_cohorts"
                            age = time.monotonic() - soak_started
                            for cohort, due in [(1, 60), (2, 3660)]:
                                if age < due or any(item["cohort"] == cohort for item in retention):
                                    continue
                                session_id = str(uuid.uuid4())
                                digest = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
                                identities = [str(uuid.UUID(item)) for item in sql("SELECT event_id::text FROM nelcota.webhook_deliveries WHERE status='succeeded' AND finished_at>clock_timestamp()-interval '1 day' ORDER BY id DESC LIMIT 8").splitlines()]
                                if len(identities)<8:
                                    continue
                                event_ledger.preserve_expected(identities)
                                ids = ','.join("'" + item + "'" for item in identities)
                                sql("BEGIN; INSERT INTO auth.sessions(id,user_id,revoked_at) VALUES('" + session_id + "','" + user + "',clock_timestamp()-interval '8 days'); INSERT INTO auth.refresh_tokens(session_id,token_hash,expires_at) VALUES('" + session_id + "',decode('" + digest + "','hex'),clock_timestamp()-interval '2 days'); UPDATE nelcota.webhook_deliveries SET finished_at=clock_timestamp()-interval '8 days' WHERE event_id=ANY(ARRAY[" + ids + "]::uuid[]); COMMIT;")
                                storage_key=aged_storage_key()
                                if arguments.backend=='disk':
                                    (storage/storage_key).write_bytes(b'gc-owned-probe')
                                if arguments.backend=='s3':
                                    S3Inventory(endpoint,access,secret,'benchmark-files').write_key(storage_key)
                                retention.append({"cohort": cohort, "session_id": session_id, "events": identities, "storage_key":storage_key,"seeded_elapsed": age, "auth_pruned": False, "events_pruned": False,"storage_pruned":False})
                            for item in retention:
                                if item["auth_pruned"] and item["events_pruned"] and item['storage_pruned']:
                                    continue
                                item["auth_pruned"] = sql("SELECT count(*) FROM auth.sessions WHERE id='" + item["session_id"] + "'") == "0"
                                ids = ','.join("'" + event + "'" for event in item["events"])
                                item["events_pruned"] = sql("SELECT count(*) FROM nelcota.webhook_deliveries WHERE event_id=ANY(ARRAY[" + ids + "]::uuid[])") == "0"
                                if arguments.backend=='disk':
                                    item['storage_pruned']=not (storage/item['storage_key']).exists()
                                if arguments.backend=='s3':
                                    item['storage_pruned']=not S3Inventory(endpoint,access,secret,'benchmark-files').contains(item['storage_key'])
                                item["observed_elapsed"] = age
                            atomic_json(output / "retention.json", retention)
                        if json.loads(queue)["retained"] >= 5000 and all(item["events_pruned"] for item in retention):
                            sample_step = "explicit_history_maintenance"
                            cleared, _ = request(base, "/admin/api/webhooks/deliveries", headers={"Cookie": fixture["cookie"], "Origin": base}, method="DELETE")
                            with (output / "history-maintenance.jsonl").open("a") as target:
                                target.write(json.dumps({"elapsed": time.monotonic() - started, "deleted": cleared["deleted"], "phase": phase}) + "\n")
                        sample_step = 'sparse_arrival_counters'
                        arrival_observation = native_metrics.observe_arrivals(phase)
                        elapsed = round(time.monotonic() - started, 1)
                        coverage.observe(elapsed)
                        ownership = owned("exec", app, "sh", "-c", "printf 'fds '; ls /proc/1/fd | wc -l; printf 'tasks '; ls /proc/1/task | wc -l; printf 'sockets '; ls -l /proc/1/fd | grep -c 'socket:'")
                        samples.append(
                            {
                                "elapsed": elapsed,
                                "app_rss_kib": rss,
                                "pg_disk_mib": disk,
                                "metrics_disk_mib": metrics_disk,
                                "storage_disk_mib":storage_disk,
                                "disk_observations":disk_observations,
                                "memory_events":memory_events,
                                "component_cgroups":cgroups,
                                "containers": [
                                    json.loads(line) for line in stats.splitlines()
                                ],
                                "generator": generator_stats,
                                "arrival_counters": arrival_observation,
                                "database": json.loads(activity),
                                "postgres_statistics":database_statistics,
                                "queue": json.loads(queue),
                                "signature_errors": len(receiver.errors),
                                "ownership": ownership,
                                "phase": phase,
                                "host": host_snapshot(cpus),
                            }
                        )
                        # Stream diagnostics: a long campaign does not retain unbounded samples.
                        with (output / "resources.jsonl").open("a") as target:
                            target.write(json.dumps(samples[-1]) + "\n")
                        if len(samples) > 1000:
                            del samples[:500]
                        resource_monotonic = time.monotonic()
                        atomic_json(output / "checkpoint.json", {"monotonic": resource_monotonic, "phase": phase, "load_seconds_completed": load_seconds, "resource_observations": coverage.count})
                    except Exception as error:
                        # Ignore only observations crossing the explicit restart
                        # window. All other sampler failures invalidate evidence.
                        if epoch == sampling_epoch and not restarting.is_set():
                            private_values = [pg_password, authenticator, jwt, password, *env.values(), *fixture.values()]
                            private_values.extend(value for key, value in os.environ.items() if any(word in key.upper() for word in ['TOKEN', 'PASSWORD', 'SECRET', 'KEY']))
                            resource_violations.append({"sampler_error": type(error).__name__, "diagnostic": redacted_diagnostic(error, private_values), "phase": phase, "step": sample_step, "http_status": getattr(error, "code", None)})
                            critical.set()
                        with (output / "sampler-errors.log").open("a") as target:
                            target.write(type(error).__name__ + "\n")
                    stop.wait(max(0, 5 - (time.monotonic() - observation_started)))

            started = time.monotonic()
            resource_monotonic = started
            sampler = threading.Thread(target=sample, daemon=True)
            sampler.start()
            failures = []

            def relogin():
                _, headers = request(
                    base,
                    "/admin/api/login",
                    {"email": email, "password": password},
                    {"Origin": base},
                )
                fixture["cookie"] = headers["Set-Cookie"].split(";", 1)[0]

            plateaus=[]
            def idle(label,seconds=15):
                nonlocal phase
                phase=label
                began_idle=time.monotonic()
                while int(sql('SELECT outstanding FROM nelcota.webhook_queue_usage WHERE singleton')):
                    if critical.is_set() or watchdog.poll() is not None:
                        raise RuntimeError('Resource guard stopped the idle recovery phase')
                    if time.monotonic()-began_idle>30:
                        raise RuntimeError('Webhook queue did not drain before idle recovery')
                    time.sleep(.5)
                drained=time.monotonic()
                while time.monotonic()-drained<seconds:
                    if critical.wait(min(.5,max(0,seconds-(time.monotonic()-drained)))) or watchdog.poll() is not None:
                        raise RuntimeError('Resource guard stopped the idle recovery phase')
                components=[app,pg,telemetry]
                if arguments.backend=='s3':components.append(s3)
                cgroups={name:owned_cgroup_snapshot(owned,name) for name in components}
                for value in cgroups.values():require_no_oom(value['memory.events'])
                owners=owned('exec',app,'sh','-c',"printf 'fds '; ls /proc/1/fd | wc -l; printf 'tasks '; ls /proc/1/task | wc -l; printf 'sockets '; ls -l /proc/1/fd | grep -c 'socket:'")
                database=json.loads(sql("SELECT json_build_object('connections',count(*),'stuck_idle_transactions',count(*) FILTER(WHERE state='idle in transaction' AND clock_timestamp()-state_change>interval '5 seconds'),'waiting_locks',count(*) FILTER(WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE datname=current_database()"))
                plateaus.append({'phase':label,'idle_seconds':seconds,'queue_drain_seconds':drained-began_idle,'observed_monotonic':time.monotonic(),'app_owners':owners,'app_process':component_identity(json.loads(owned('inspect',app))[0]),'database':database,'component_cgroups':cgroups})
                atomic_json(output/'resource-plateaus.json',plateaus)
                if database['stuck_idle_transactions'] or database['waiting_locks']:
                    raise RuntimeError('Database resource owners did not recover during rest')

            def run(label, workload, duration, vus=16, rate=0, overload=False):
                nonlocal phase, load_seconds, soak_started, active_generator, soak_processes
                if critical.is_set():
                    raise RuntimeError("Campaign resource guard stopped traffic")
                native_metrics.begin_phase(label, ['traffic', 'session-canary'])
                phase = label
                command = [
                    "docker",
                    "run",
                    "--rm",
                    *labels,
                    "--name",
                    generator,
                    "--network",
                    "host",
                    "--cpus",
                    "1",
                    "--cpuset-cpus",
                    str(cpus[2]),
                    "--memory",
                    "512m",
                    "--memory-swap",
                    "512m",
                    "--user",
                    f"{os.getuid()}:{os.getgid()}",
                    "-v",
                    str(js_snapshot) + ":/campaign.js:ro",
                    "-v",
                    str(output) + ":/reports",
                    "-e",
                    "GOMEMLIMIT=448MiB",
                    "-e",
                    "K6_NO_USAGE_REPORT=true",
                    "-e",
                    "FIXTURE",
                    "-e",
                    "WORKLOAD=" + workload,
                    "-e",
                    "SESSION_CANARY="+str(label=="soak" and arguments.soak_seconds>=7200).lower(),
                    "-e",
                    "DURATION=" + duration,
                    "-e",
                    "VUS=" + str(vus),
                    "-e",
                    "RATE=" + str(rate),
                    "-e",
                    "OVERLOAD=" + str(overload).lower(),
                    "-e",
                    "RUN_ID=" + label,
                    "-e",
                    "K6_PROMETHEUS_RW_SERVER_URL=" + metrics_url + "/api/v1/write",
                    "-e",
                    "K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true",
                    "-e",
                    "K6_PROMETHEUS_RW_PUSH_INTERVAL=2s",
                    K6,
                    "run",
                    "--quiet",
                    "--summary-mode=disabled",
                    "--no-thresholds",
                    "--out=experimental-prometheus-rw",
                    "/campaign.js",
                ]
                print("Running", label, workload, duration, flush=True)
                load_started = time.monotonic()
                if label == "soak":
                    soak_started = load_started
                    soak_processes={name:component_identity(json.loads(owned('inspect',name))[0]) for name in [app,pg]}
                    atomic_json(output/'soak-processes-before.json',soak_processes)
                with (output / (label + ".log")).open("w") as target:
                    result = subprocess.Popen(
                        command,
                        stdout=target,
                        stderr=subprocess.STDOUT,
                        env={**os.environ, "FIXTURE": json.dumps(fixture)},
                    )
                    generator_context = {"process": result, "name": generator, "identity": identity, "phase": label, "started": load_started}
                    active_generator = generator_context
                    try:
                        while result.poll() is None:
                            if watchdog.poll() is not None:
                                raise RuntimeError("Independent watchdog exited unexpectedly")
                            if critical.wait(0.25):
                                stop_generator(manifest)
                                raise RuntimeError("Resource guard aborted generator: " + label)
                            if time.monotonic() - load_started > generator_deadline(duration):
                                raise RuntimeError("Generator exceeded its deadline: " + label)
                        result.wait()
                    finally:
                        elapsed = time.monotonic() - load_started
                        with (output / "traffic-ledger.jsonl").open("a") as ledger:
                            ledger.write(json.dumps({"phase": label, "workload": workload, "requested_seconds": int(duration[:-1]), "elapsed_seconds": elapsed, "completed": result.returncode == 0, "exit_code": result.returncode, "started_monotonic": load_started, "ended_monotonic": time.monotonic()}) + "\n")
                        if result.poll() is None:
                            stop_generator(manifest)
                            result.terminate()
                            try:
                                owned("rm", "-f", generator)
                            except (RuntimeError,subprocess.TimeoutExpired):
                                atomic_json(output/(label+'-generator-cleanup-warning.json'),{'reason':'concurrent_or_unavailable_docker_removal','final_cleanup_required':True})
                            try:
                                result.wait(timeout=20)
                            except subprocess.TimeoutExpired:
                                result.kill()
                                result.wait(timeout=5)
                        if active_generator is generator_context:
                            active_generator = None
                        try:
                            atomic_json(output / (label + "-metrics-raw.json"), native_metrics.snapshot(label))
                        except Exception as error:
                            atomic_json(output / (label + "-metrics-error.json"), {"error_type": type(error).__name__})
                if result.returncode:
                    state = json.loads(owned("inspect", app))[0]["State"]
                    failures.append(
                        {
                            "label": label,
                            "exit_code": result.returncode,
                            "app_state": state,
                        }
                    )
                    (output / "failures.json").write_text(
                        json.dumps(failures, indent=2)
                    )
                    retain_failure(output,owned,pg,sql,unsafe=critical.is_set())
                    if not arguments.allow_baseline_failures:
                        raise RuntimeError(
                            "k6 failed: " + label + "; inspect its report"
                        )
                    print(
                        "Recorded baseline failure:",
                        label,
                        "OOM:",
                        state["OOMKilled"],
                        flush=True,
                    )
                    owned("rm", "-f", app)
                    start()
                    relogin()
                native_metrics.finish_phase(label)
                report = native_metrics.summary(label, int(duration[:-1]))
                if label=='soak':
                    final_processes={name:component_identity(json.loads(owned('inspect',name))[0]) for name in [app,pg]}
                    atomic_json(output/'soak-processes-after.json',final_processes)
                    verify_continuity(soak_processes,final_processes)
                    if arguments.soak_seconds>=7200:
                        selector='{run_id="soak",scenario="session-canary"}'
                        renewals=native_metrics.sparse_counter('access_renewals','soak','session-canary')
                        canary_iterations=native_metrics.value('sum(k6_iterations_total'+selector+')')
                        atomic_json(output/'session-canary.json',{'access_renewals':renewals,'iterations':canary_iterations,'minimum_renewals':max(1,arguments.soak_seconds//3600-1),'counter_observation':'last regular sample within retained 3600 seconds, no observed reset','scope':'one continuous VU reuses its session and renews near actual access-token expiry'})
                        if renewals<max(1,arguments.soak_seconds//3600-1) or canary_iterations<arguments.soak_seconds*.8:
                            raise RuntimeError('Continuous session did not demonstrate supported expiry renewal')

                atomic_json(output / (label + ".json"), report)
                if result.returncode == 0:
                    metrics = report["metrics"]
                    if (
                        metrics["unexpected"]["value"] != 0
                        or metrics["checks"]["fails"]
                    ):
                        raise RuntimeError("Correctness checks failed: " + label)
                    if metrics.get("iterations", {}).get("count", 0) <= 0 or elapsed < int(duration[:-1]):
                        raise RuntimeError("No complete measured traffic interval: " + label)
                    load_seconds += int(duration[:-1])
                    if not overload and (label == "soak" or re.fullmatch(r"(?:read|rls|panel|storage|login|refresh|mixed|write)-[123]", label) or label.startswith("capacity-")):
                        violations = nominal_violations(report, workload)
                        if violations:
                            atomic_json(output / (label + "-slo-failures.json"), violations)
                            raise RuntimeError("Nominal latency SLO failed: " + label)
                    if rate > 0 and not overload:
                        expected = rate * int(duration.removesuffix("s"))
                        completed = metrics["iterations"]["count"]
                        dropped = metrics.get("dropped_iterations", {}).get("count", 0)
                        if completed < expected * 0.99 or dropped > expected * 0.01:
                            raise RuntimeError(
                                "Generator failed its 99% arrival/delivery budget: "
                                + label
                            )
                return report

            run("warmup", "mixed", "15s", 4)

            def plans(label):
                queries = {
                    "owner": "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM public.bench_private ORDER BY id LIMIT 20;",
                    "service": "BEGIN; SET LOCAL ROLE service_role; EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM public.bench_products WHERE stock=10 ORDER BY id LIMIT 20; ROLLBACK;",
                    "rls": 'BEGIN; SET LOCAL ROLE authenticated; SELECT set_config(\'request.jwt.claims\',\'{"role":"authenticated","sub":"'
                    + user
                    + "\"}',true); EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM public.bench_private ORDER BY id LIMIT 20; ROLLBACK;",
                }
                for role, query in queries.items():
                    (output / ("plan-" + label + "-" + role + ".log")).write_text(
                        sql(query)
                    )

            plans("fresh")
            for workload in [
                name
                for name in ["read", "rls", "storage"]
                if name in arguments.workloads
            ]:
                for iteration in range(1, 4):
                    run(f"fresh-{workload}-{iteration}", workload, "10s", 16)
            sql(
                "ALTER TABLE public.bench_products RESET(autovacuum_enabled); ALTER TABLE public.bench_private RESET(autovacuum_enabled); ALTER TABLE storage.objects RESET(autovacuum_enabled); ANALYZE public.bench_products; ANALYZE public.bench_private; ANALYZE storage.objects;"
            )
            plans("analyzed")
            results = []
            for workload in arguments.workloads:
                steady_rate = arguments.steady_rate
                if workload == 'write' and arguments.write_steady_rate:
                    steady_rate = arguments.write_steady_rate
                for iteration in range(1, 4):
                    results.append(
                        (
                            workload,
                            run(
                                f"{workload}-{iteration}",
                                workload,
                                arguments.steady,
                                16,
                                steady_rate,
                            ),
                        )
                    )
            capacity_workload = "mixed"
            if "mixed" not in arguments.workloads:
                capacity_workload = arguments.workloads[0]
            throughput = sorted(
                report["metrics"]["iterations"]["rate"]
                for kind, report in results
                if kind == capacity_workload
            )[1]
            measured_provisional_throughput=throughput
            if arguments.calibration_ceiling:
                throughput=min(throughput,arguments.calibration_ceiling)
            provisional_throughput=throughput
            qualification = []
            sustainable = 0
            lower, upper = 0, max(1, int(throughput))
            for percent in [25, 50, 75, 100]:
                rate = max(1, int(throughput * percent / 100))
                report = run("calibrate-" + str(percent), "mixed", str(arguments.capacity_step_seconds) + "s", 16, rate, overload=True)
                violations = nominal_violations(report, "mixed")
                metrics = report["metrics"]
                expected = rate * arguments.capacity_step_seconds
                qualified = not violations and metrics["overload_rejections"]["count"] == 0 and metrics["iterations"]["count"] >= expected * .99 and metrics["dropped_iterations"]["count"] <= expected * .01
                qualification.append({"label": "calibrate-" + str(percent), "rate": rate, "qualified": qualified, "latency_violations": violations, "completed_iterations": metrics["iterations"]["count"], "dropped_iterations": metrics["dropped_iterations"]["count"], "overload_rejections": metrics["overload_rejections"]["count"]})
                atomic_json(output / "capacity-probes.json", qualification)
                if qualified:
                    lower = max(lower, rate)
                    sustainable = max(sustainable, rate)
                if not qualified:
                    upper = min(upper, rate)
            if sustainable == 0:
                raise RuntimeError("No independently qualified sustainable arrival rate")
            for iteration in range(1, 4):
                if upper <= lower + max(1, int(lower * .05)):
                    break
                rate = (lower + upper) // 2
                report = run("calibrate-refine-" + str(iteration), "mixed", str(arguments.capacity_step_seconds) + "s", 16, rate, overload=True)
                violations = nominal_violations(report, "mixed")
                metrics = report["metrics"]
                expected = rate * arguments.capacity_step_seconds
                qualified = not violations and metrics["overload_rejections"]["count"] == 0 and metrics["iterations"]["count"] >= expected * .99 and metrics["dropped_iterations"]["count"] <= expected * .01
                qualification.append({"label": "calibrate-refine-" + str(iteration), "rate": rate, "qualified": qualified, "latency_violations": violations, "completed_iterations": metrics["iterations"]["count"], "dropped_iterations": metrics["dropped_iterations"]["count"], "overload_rejections": metrics["overload_rejections"]["count"]})
                atomic_json(output / "capacity-probes.json", qualification)
                if qualified:
                    lower, sustainable = rate, rate
                if not qualified:
                    upper = rate
            throughput = sustainable
            soak_rate = max(1, int(throughput * arguments.soak_fraction))
            if arguments.soak_rate > 0:
                soak_rate = arguments.soak_rate
            (output / "capacity.json").write_text(
                json.dumps(
                    {
                        "provisional_median_iterations_per_second":provisional_throughput,
                        "measured_closed_loop_median_iterations_per_second":measured_provisional_throughput,
                        "calibration_ceiling_iterations_per_second":arguments.calibration_ceiling,
                        "provisional_workload":capacity_workload,
                        "qualified_lower_bound_iterations_per_second":throughput,
                        "qualification_step_seconds":arguments.capacity_step_seconds,
                        "five_minute_qualification":arguments.capacity_step_seconds>=300,
                        "soak_iterations_per_second":soak_rate,
                        "soak_fraction":arguments.soak_fraction,
                        "soak_rps": soak_rate,
                        "p95_regression_gate": 1.10,
                        "throughput_regression_gate": 0.90,
                    },
                    indent=2,
                )
            )
            if arguments.capacity:
                for percent in [25, 50, 75, 100]:
                    rate = max(1, int(throughput * percent / 100))
                    run("capacity-" + str(percent), "mixed", str(arguments.capacity_step_seconds) + "s", 16, rate)
                for percent in [125, 150, 200]:
                    rate = max(1, int(throughput * percent / 100))
                    if rate > 10000:
                        raise RuntimeError("Required overload exceeds the traffic ceiling")
                    run("overload-" + str(percent), "mixed", "30s", 16, rate, overload=True)
            for load in [16, 32, 64, 128]:
                if not arguments.no_stress:
                    run("stress-" + str(load), "mixed", "20s", load, overload=True)
            if arguments.spikes:
                for iteration in range(1, 6):
                    spike_rate = max(1, int(throughput * 3))
                    if spike_rate > 10000:
                        raise RuntimeError("Required 3x spike exceeds the declared traffic ceiling")
                    run("spike-" + str(iteration), "mixed", "10s", 16, spike_rate, overload=True)
                    run("spike-recovery-" + str(iteration), "mixed", "20s", 16, soak_rate)
                    idle('spike-idle-'+str(iteration))
            run("recovery-before-restart", "mixed", "20s", 4)
            restarting.set()
            sampling_epoch += 1
            owned("stop", "-t", "10", app)
            owned("rm", app)
            start()
            relogin()
            sampling_epoch += 1
            restarting.clear()
            run("recovery-after-restart", "mixed", "20s", 4)
            if arguments.soak_seconds:
                run("soak", "mixed", str(arguments.soak_seconds) + "s", 16, soak_rate)
            idle('post-load-idle',arguments.final_idle_seconds)
            deadline = time.monotonic() + 30
            while True:
                pending = int(
                    sql(
                        "SELECT outstanding FROM nelcota.webhook_queue_usage WHERE singleton;"
                    )
                )
                if pending == 0:
                    break
                if time.monotonic() >= deadline:
                    failures.append({"label": "queue-recovery", "outstanding": pending})
                    (output / "failures.json").write_text(
                        json.dumps(failures, indent=2)
                    )
                    if not arguments.allow_baseline_failures:
                        raise RuntimeError(
                            "Webhook queue did not recover within 30 seconds"
                        )
                    break
                time.sleep(0.5)
            time.sleep(2)
            file_integrity = {"verified_objects": 0, "maximum_object_bytes": max(64,arguments.object_bytes+2)}
            objects = [
                "fixture.txt",
                *sql(
                    "SELECT name FROM storage.objects WHERE bucket_id='bench' AND name LIKE 'probe-%' ORDER BY name;"
                ).splitlines(),
            ]
            if len(objects) > 129:
                raise RuntimeError(
                    "Storage writes escaped their bounded per-VU fixture set"
                )
            for name in objects:
                read = urllib.request.Request(
                    base + "/storage/v1/object/bench/" + name,
                    headers={"Authorization": "Bearer " + service},
                )
                with urllib.request.urlopen(read, timeout=5) as response:
                    expected = object_payload
                    if name == "fixture.txt":
                        expected = fixture_payload
                    if response.read(file_integrity['maximum_object_bytes']+1) != expected:
                        raise RuntimeError(
                            "Stored bytes failed their post-load integrity check"
                        )
                file_integrity["verified_objects"] += 1
            inventory = None
            if arguments.backend == 'disk':
                inventory = disk_inventory(storage)
            if arguments.backend == 's3':
                inventory = S3Inventory(endpoint,access,secret,'benchmark-files').inventory()
            known_rows=json.loads(sql("SELECT json_agg(t) FROM (SELECT bucket_id||'/'||version::text AS key,name,size,etag FROM storage.objects ORDER BY bucket_id,version LIMIT 20001)t"))
            known={row['key']:row['size'] for row in known_rows}
            if len(known)>20000:
                raise RuntimeError('Metadata inventory exceeded its evidence budget')
            required=sql("SELECT bucket_id||'/'||version::text FROM storage.objects WHERE bucket_id='bench' AND (name='fixture.txt' OR name LIKE 'probe-%') ORDER BY version").splitlines()
            if len(required)!=len(objects):
                raise RuntimeError('Verified object metadata evidence is incomplete')
            for row in known_rows:
                if row['name']=='fixture.txt' or row['name'].startswith('probe-'):
                    expected_payload=object_payload
                    if row['name']=='fixture.txt':
                        expected_payload=fixture_payload
                    if row['size']!=len(expected_payload) or row['etag']!=hashlib.sha256(expected_payload).hexdigest():
                        raise RuntimeError('Acknowledged object metadata differs from its verified bytes')
                if re.fullmatch(r'[0-9]{8}\.txt',row['name']) and (row['size']!=0 or row['etag']!=hashlib.sha256(b'').hexdigest()):
                    raise RuntimeError('Seeded empty object metadata is corrupt')
            if not arguments.metadata_only_seed:
                required=list(known)
            file_integrity['physical_inventory'] = reconcile(inventory,known,required=required)
            states = {
                name: json.loads(owned("inspect", name))[0]["State"]
                for name in [app, pg]
            }
            if any(
                not state["Running"] or state["OOMKilled"] for state in states.values()
            ):
                raise RuntimeError(
                    "Application or PostgreSQL failed its final container invariant"
                )
            invariant = sql(
                "SELECT json_build_object('users',count(*),'password_hashes',count(*) FILTER(WHERE encrypted_password LIKE '$argon2id$%')) FROM auth.users;"
            )
            final_activity = json.loads(
                sql(
                    "SELECT json_build_object('connections',count(*),'idle_in_transaction',count(*) FILTER(WHERE state='idle in transaction'),'waiting_locks',count(*) FILTER(WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE datname=current_database();"
                )
            )
            hook_id = str(uuid.UUID(hook["endpoint"]["id"]))
            expected_process = subprocess.Popen(["docker", "exec", "-e", "PGOPTIONS=-cstatement_timeout=30000", pg, "psql", "-Atq", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "SELECT event_id::text FROM public.bench_expected_events ORDER BY event_id"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            with expected_process.stdout as expected_stream:
                event_evidence = event_ledger.validate(str(uuid.UUID(line.strip())) for line in expected_stream)
            if expected_process.wait(timeout=30) or event_evidence["missing"] or event_evidence["extra"]:
                raise RuntimeError("Committed webhook event identities did not reconcile")
            (output / "invariants.json").write_text(
                json.dumps(
                    {
                        "auth": json.loads(invariant),
                        "outstanding": pending,
                        "database": final_activity,
                        "signature_errors": len(receiver.errors),
                        "received_window": len(receiver.requests),
                        "file_integrity": file_integrity,
                        "event_identities": event_evidence,
                        "pg_state": states[pg],
                        "container_state": json.loads(owned("inspect", app))[0][
                            "State"
                        ],
                    },
                    indent=2,
                )
            )
            if final_activity["idle_in_transaction"] or final_activity["waiting_locks"]:
                raise RuntimeError("Database work remained after traffic stopped")
            if receiver.errors:
                raise RuntimeError("Webhook signature invariants failed")
            stop.set()
            sampler.join(timeout=50)
            if sampler.is_alive():
                resource_violations.append({"sampler_shutdown": "timed out"})
            resource_violations.extend(
                coverage.violations(time.monotonic() - started)
            )
            if resource_violations:
                (output / "resource-violations.json").write_text(
                    json.dumps(resource_violations, indent=2)
                )
                raise RuntimeError(
                    "Resource budgets were exceeded; inspect resource-violations.json"
                )
            if failures:
                print(
                    "Baseline campaign finished with recorded failures; reports:",
                    output,
                    flush=True,
                )
                return
            if arguments.soak_seconds >= 7200 and (len(retention) != 2 or not all(item["auth_pruned"] and item["events_pruned"] and item['storage_pruned'] and item["events"] for item in retention)):
                raise RuntimeError("Two real retention cycles were not demonstrated")
            validated = True
        finally:
            phase = "teardown"
            if critical.is_set():
                stop_generator(manifest)
            signal.signal(signal.SIGTERM, previous_handler)
            stop.set()
            if sampler:
                sampler.join(timeout=50)
            try:
                owned("rm", "-f", generator)
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            names = [app, pg, telemetry]
            if arguments.backend == "s3":
                names.append(s3)
            for name in names:
                try:
                    (output / (name.rsplit("-", 1)[-1] + "-state.json")).write_text(
                        json.dumps(
                            json.loads(owned("inspect", name))[0]["State"], indent=2
                        )
                    )
                    (output / (name.rsplit("-", 1)[-1] + ".log")).write_text(
                        owned("logs", '--tail', '2000', name, include_stderr=True)
                    )
                except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError):
                    pass
                finally:
                    # Diagnostics must never prevent teardown of owned fixtures.
                    try:
                        owned("rm", "-fv", name)
                    except (RuntimeError, subprocess.TimeoutExpired):
                        pass
            receiver.close()
            event_ledger.close()
            try:
                owned("volume", "rm", volume)
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            try:
                owned("volume", "rm", telemetry_volume)
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            try:
                owned('volume','rm',s3_volume)
            except (RuntimeError,subprocess.TimeoutExpired):
                pass
            cleanup = {"containers": None, "volumes": None}
            try:
                cleanup["containers"] = owned("ps", "-a", "--filter", "label=" + LABEL + "=" + identity, "--format", "{{.Names}}").splitlines()
                cleanup["volumes"] = owned("volume", "ls", "--filter", "label=" + LABEL + "=" + identity, "--format", "{{.Name}}").splitlines()
            except RuntimeError:
                pass
            if allocation_directory is not None:
                try:
                    from allocation import retain
                    retain(allocation_directory, output/'allocator-diagnostics')
                except (OSError, ValueError, TypeError) as error:
                    allocation_error = type(error).__name__
                    resource_violations.append({'allocation_observer':allocation_error})
            directory_clean = False
            try:
                temporary_directory.cleanup()
                directory_clean = True
            except OSError:
                pass
            cleanup["directory_removed"] = directory_clean
            atomic_json(output / "cleanup.json", cleanup)
            if resource_violations:
                atomic_json(output / "resource-violations.json", resource_violations)
            clean = cleanup["containers"] == [] and cleanup["volumes"] == [] and directory_clean
            if clean:
                (output / "watchdog-disarmed").touch()
            heartbeat_stop.set()
            if heartbeat_thread:
                heartbeat_thread.join(timeout=5)
            if watchdog:
                if clean:
                    try:
                        watchdog.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        watchdog.terminate()
            status = "failed"
            if validated and clean and not critical.is_set() and not resource_violations:
                status = "passed"
            atomic_json(output / "completion.json", {"status": status, "load_seconds": load_seconds, "resource_observations": coverage.count, "soak_seconds": arguments.soak_seconds, "binary_sha256": metadata.get("binary_sha256"), "cleanup_confirmed": clean, "error_type": type(sys.exception()).__name__})
            if status == "passed":
                print("Campaign passed; reports:", output, flush=True)
            if not clean and sys.exception() is None:
                raise RuntimeError("Owned fixture cleanup could not be confirmed")
            if allocation_error is not None and sys.exception() is None:
                raise RuntimeError('Allocation observer evidence was incomplete')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument('--allocation-probe',type=Path,help='Optional built glibc diagnostic preload; instrumented runs cannot certify performance')
    parser.add_argument("--steady", default="30s")
    parser.add_argument(
        "--steady-rate",
        type=int,
        default=0,
        help="Open-loop nominal iterations/second; zero uses closed-loop VUs",
    )
    parser.add_argument("--soak-seconds", type=int, default=1800)
    parser.add_argument('--final-idle-seconds',type=int,default=30,help='Bounded post-load owner/cache reclamation observation; excluded from load time')
    parser.add_argument('--write-steady-rate',type=int,default=0,help='Optional declared open-loop rate for the three pure-write samples; zero retains the general steady profile')
    parser.add_argument("--fixture-disk-mib", type=int, default=512)
    parser.add_argument('--wal-mib',type=int,choices=[64,128,256,512],default=64)
    parser.add_argument('--soak-fraction',type=float,choices=[.7,.75,.8],default=.8)
    parser.add_argument('--calibration-ceiling',type=int,default=0,help='Predeclared cap for provisional capacity iterations/second; zero uses the measured median')
    parser.add_argument('--s3-memory-mib',type=int,choices=[512,1024],default=512)
    parser.add_argument('--storage-fixture-disk-mib',type=int,default=1024)
    parser.add_argument('--rows',type=int,choices=[100000,1000000],default=100000)
    parser.add_argument('--object-bytes',type=int,default=17)
    parser.add_argument('--metadata-only-seed',action='store_true',help='Functional listing investigation only; does not certify full seeded-object integrity')
    parser.add_argument("--capacity", action="store_true")
    parser.add_argument("--capacity-step-seconds", type=int, default=300)
    parser.add_argument("--spikes", action="store_true")
    parser.add_argument(
        "--soak-rate",
        type=int,
        default=0,
        help="Repeat a previously measured sustainable rate; zero uses calibration",
    )
    parser.add_argument(
        "--workloads",
        type=lambda value: value.split(","),
        default=["read", "rls", "panel", "storage", "login", "refresh", "mixed"],
    )
    parser.add_argument("--no-stress", action="store_true")
    parser.add_argument("--backend", choices=["disk", "s3"], default="disk")
    parser.add_argument(
        "--allow-baseline-failures",
        action="store_true",
        help="Collect failures of the old binary, without marking the campaign as passed",
    )
    arguments = parser.parse_args()
    if not arguments.binary.is_file() or not 0 <= arguments.soak_seconds <= 14400:
        parser.error("Invalid binary or soak budget")
    if not 30<=arguments.final_idle_seconds<=300:
        parser.error('Final idle observation must be 30..300 seconds')
    if not 512 <= arguments.fixture_disk_mib <= 4096:
        parser.error("Fixture disk budget must be 512 through 4096 MiB")
    if arguments.fixture_disk_mib<arguments.wal_mib*3:
        parser.error('Database disk budget must cover three WAL budgets plus its fixture')
    if not 64<=arguments.storage_fixture_disk_mib<=4096 or not 1<=arguments.object_bytes<=1048576:
        parser.error('Storage budget must be 64..4096 MiB; object bytes 1..1048576')
    if not 5 <= arguments.capacity_step_seconds <= 300:
        parser.error("Capacity steps must be 5 through 300 seconds")
    if not 0 <= arguments.steady_rate <= 10000:
        parser.error("Steady rate is outside the request budget")
    if not 0<=arguments.write_steady_rate<=10000:
        parser.error('Write steady rate is outside the request budget')
    if not 0<=arguments.calibration_ceiling<=10000:
        parser.error('Calibration ceiling must be 0..10000 iterations/second')
    if not 0 <= arguments.soak_rate <= 10000:
        parser.error("Soak rate is outside the request budget")
    duration = re.fullmatch(r"([1-9][0-9]{0,2})s", arguments.steady)
    if duration is None or int(duration[1]) > 120:
        parser.error("Steady duration must be 1s through 120s")
    if not arguments.workloads or any(
        name
        not in ["read", "rls", "panel", "storage", "login", "refresh", "write", "mixed"]
        for name in arguments.workloads
    ):
        parser.error("Invalid workload list")
    campaign(arguments)
