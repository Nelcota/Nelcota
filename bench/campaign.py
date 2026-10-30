"""Disposable, resource-limited release campaign; no Node runtime required.

Usage: python3 bench/campaign.py --binary /absolute/nelcota --output target/campaign
All containers, runtime secrets and storage fixtures are owned by this run.
Diagnostics contain metrics and redacted application logs, not credentials.
"""

import argparse
import base64
import datetime
from collections import deque
import hashlib
import hmac
import json
import os
import re
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/upgrade"))
from support import Receiver

K6 = "grafana/k6:1.6.1@sha256:a5ad6bc089a08d77c3ec49f3db8c6fa7a148e4073efcac44c675dbaf3568d8e1"


def docker(*arguments, stdin=None, include_stderr=False):
    try:
        result = subprocess.run(
            ["docker", *map(str, arguments)],
            input=stdin,
            text=True,
            capture_output=True,
            timeout=45,
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


def resource_evidence_violations(samples, duration_seconds):
    if len(samples) < 2:
        return [{"resource_samples": len(samples), "minimum": 2}]
    boundaries = [0, *(sample["elapsed"] for sample in samples), duration_seconds]
    gap = max(right - left for left, right in zip(boundaries, boundaries[1:]))
    if gap > 30:
        return [{"maximum_sample_gap_seconds": gap, "limit": 30}]
    return []


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
    identity = "nelcota-bench-" + secrets.token_hex(4)
    cpus = sorted(os.sched_getaffinity(0))
    if len(cpus) < 3:
        raise RuntimeError(
            "Campaign needs three available CPUs for isolated app, DB and generator"
        )
    if arguments.backend == "s3" and len(cpus) < 4:
        raise RuntimeError(
            "S3 campaign needs four CPUs for app, DB, generator and object service"
        )
    pg, app = identity + "-pg", identity + "-app"
    s3 = identity + "-s3"
    volume = identity + "-data"
    generator = identity + "-load"
    receiver = Receiver()
    receiver.requests = deque(maxlen=2048)
    receiver.errors = deque(maxlen=256)
    stop = threading.Event()
    restarting = threading.Event()
    sampling_epoch = 0
    samples = []
    resource_violations = []
    sampler = None
    with tempfile.TemporaryDirectory(prefix="nelcota-bench-") as temporary:
        directory = Path(temporary)
        storage = directory / "storage"
        storage.mkdir()
        try:
            pg_password = secrets.token_urlsafe(32)
            authenticator = secrets.token_urlsafe(32)
            jwt = secrets.token_urlsafe(48)
            password = secrets.token_urlsafe(32)
            docker(
                "run",
                "-d",
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
                "POSTGRES_PASSWORD=" + pg_password,
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
                "max_wal_size=64MB",
                "-c",
                "min_wal_size=32MB",
                "-c",
                "shared_preload_libraries=pg_stat_statements",
            )
            port = int(
                json.loads(docker("inspect", pg))[0]["NetworkSettings"]["Ports"][
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
                "NELCOTA_API_CONCURRENCY_PER_CALLER": "0",
                "NELCOTA_REQUEST_TIMEOUT_SECS": "5",
                "NELCOTA_STATEMENT_TIMEOUT_SECS": "3",
                "NELCOTA_STORAGE_BACKEND": "disk",
                "NELCOTA_STORAGE_DIR": "/storage",
                "NELCOTA_STORAGE_MIN_FREE_BYTES": "0",
                "NELCOTA_WEBHOOKS_ALLOW_LOOPBACK": "true",
            }
            if arguments.backend == "s3":
                access, secret = secrets.token_hex(16), secrets.token_hex(32)
                docker(
                    "run",
                    "-d",
                    "--name",
                    s3,
                    "--cpus",
                    "1",
                    "--cpuset-cpus",
                    str(cpus[3]),
                    "--memory",
                    "512m",
                    "--memory-swap",
                    "512m",
                    "-e",
                    "RUSTFS_ACCESS_KEY=" + access,
                    "-e",
                    "RUSTFS_SECRET_KEY=" + secret,
                    "-p",
                    "127.0.0.1::9000",
                    "rustfs/rustfs:1.0.1",
                )
                s3_port = int(
                    json.loads(docker("inspect", s3))[0]["NetworkSettings"]["Ports"][
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

            def sql(statement):
                return docker(
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
                for key, value in env.items():
                    command.extend(["-e", key + "=" + value])
                command.extend(["ubuntu:24.04", "/usr/local/bin/nelcota", "serve"])
                docker(*command)
                for _ in range(100):
                    try:
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
            docker("rm", "-f", app)
            start()
            _, headers = request(
                base,
                "/admin/api/login",
                {"email": email, "password": password},
                {"Origin": base},
            )
            cookie = headers["Set-Cookie"].split(";", 1)[0]
            service = token(
                jwt, {"role": "service_role", "exp": int(time.time()) + 7200}
            )
            sql(
                (ROOT / "bench/setup.sql")
                .read_text()
                .replace("ANALYZE public.bench_products;", "")
            )
            sql(
                "CREATE TABLE public.bench_private (id integer PRIMARY KEY,user_id uuid NOT NULL,body text);"
                + "INSERT INTO public.bench_private SELECT i, CASE WHEN i%2=0 THEN '"
                + user
                + "'::uuid WHEN i%2=1 THEN gen_random_uuid() END,repeat('x',128) FROM generate_series(1,100000) i;"
                + "CREATE INDEX ON public.bench_private(user_id,id); ALTER TABLE public.bench_private ENABLE ROW LEVEL SECURITY;"
                + "CREATE POLICY own ON public.bench_private TO authenticated USING(user_id=auth.uid());GRANT SELECT ON public.bench_private TO authenticated;"
                + "GRANT SELECT,UPDATE ON public.bench_products TO service_role;"
                + "INSERT INTO storage.buckets(id,public) VALUES('bench',true);"
                + "INSERT INTO storage.objects(bucket_id,name,version,size,mime_type,etag) SELECT 'bench',lpad(i::text,8,'0') || '.txt',gen_random_uuid(),0,'text/plain','' FROM generate_series(1,10000) i;"
                + "ALTER TABLE public.bench_products SET(autovacuum_enabled=false); ALTER TABLE public.bench_private SET(autovacuum_enabled=false); ALTER TABLE storage.objects SET(autovacuum_enabled=false); NOTIFY nelcota,'reload schema';"
            )
            time.sleep(1)
            request(
                base,
                "/storage/v1/object/bench/fixture.txt",
                "benchmark payload",
                {"Authorization": "Bearer " + service},
                method="PUT",
            )
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
                "service": service,
                "cookie": cookie,
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
                "cpu_affinity": cpus[:3],
                "app_cpus": 1,
                "app_memory_mb": 128,
                "pg_cpus": 1,
                "pg_memory_mb": 384,
                "generator_memory_mb": 512,
                "generator_go_memory_limit_mib": 448,
                "pg_data": "disposable disk volume",
                "max_wal_mb": 64,
                "max_fixture_disk_mb": 512,
                "pool": 8,
                "max_connections": 40,
                "k6": K6,
                "storage_backend": arguments.backend,
                "steady_rate": arguments.steady_rate,
                "steady_duration": arguments.steady,
                "workloads": arguments.workloads,
                "postgres_version": sql("SELECT version();"),
                "images": {
                    image: json.loads(docker("image", "inspect", image))[0][
                        "RepoDigests"
                    ]
                    for image in ["ubuntu:24.04", "postgres:17-alpine", K6]
                    + ["rustfs/rustfs:1.0.1"] * (arguments.backend == "s3")
                },
                "dataset": {"products": 100000, "private": 100000, "objects": 10000},
                "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            if arguments.backend == "s3":
                metadata["s3"] = {
                    "cpu_affinity": cpus[3],
                    "cpus": 1,
                    "memory_mb": 512,
                    "ca_bundle_sha256": hashlib.file_digest(
                        Path("/etc/ssl/certs/ca-certificates.crt").open("rb"), "sha256"
                    ).hexdigest(),
                }
            (output / "metadata.json").write_text(json.dumps(metadata, indent=2))

            def sample():
                while not stop.is_set():
                    if restarting.is_set():
                        stop.wait(0.1)
                        continue
                    epoch = sampling_epoch
                    try:
                        stats = docker(
                            "stats", "--no-stream", "--format", "{{json .}}", app, pg
                        )
                        status = docker("exec", app, "cat", "/proc/1/status")
                        rss = next(
                            int(line.split()[1])
                            for line in status.splitlines()
                            if line.startswith("VmRSS:")
                        )
                        activity = sql(
                            "SELECT json_build_object('connections',count(*),'active',count(*) FILTER(WHERE state='active'),'idle_in_transaction',count(*) FILTER(WHERE state='idle in transaction'),'waiting_locks',count(*) FILTER(WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE datname=current_database();"
                        )
                        queue = sql(
                            "SELECT row_to_json(t) FROM (SELECT outstanding,retained FROM nelcota.webhook_queue_usage WHERE singleton) t;"
                        )
                        disk = int(
                            docker(
                                "exec", pg, "du", "-sm", "/var/lib/postgresql/data"
                            ).split()[0]
                        )
                        if disk > 512:
                            resource_violations.append({"pg_disk_mib": disk})
                            raise RuntimeError(
                                "Fixture exceeded its 512-MiB disk budget"
                            )
                        if epoch != sampling_epoch:
                            continue
                        samples.append(
                            {
                                "elapsed": round(time.monotonic() - started, 1),
                                "app_rss_kib": rss,
                                "pg_disk_mib": disk,
                                "containers": [
                                    json.loads(line) for line in stats.splitlines()
                                ],
                                "database": json.loads(activity),
                                "queue": json.loads(queue),
                                "signature_errors": len(receiver.errors),
                            }
                        )
                        # Stream diagnostics: a long campaign does not retain unbounded samples.
                        with (output / "resources.jsonl").open("a") as target:
                            target.write(json.dumps(samples[-1]) + "\n")
                        if len(samples) > 1000:
                            del samples[:500]
                    except Exception as error:
                        # Ignore only observations crossing the explicit restart
                        # window. All other sampler failures invalidate evidence.
                        diagnostic = "sampler-restart-observations.log"
                        if epoch == sampling_epoch and not restarting.is_set():
                            resource_violations.append({"sampler_error": str(error)})
                            diagnostic = "sampler-errors.log"
                        with (output / diagnostic).open("a") as target:
                            target.write(str(error) + "\n")
                    stop.wait(10)

            started = time.monotonic()
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

            def run(label, workload, duration, vus=16, rate=0, overload=False):
                command = [
                    "docker",
                    "run",
                    "--rm",
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
                    str(ROOT / "bench/campaign.js") + ":/campaign.js:ro",
                    "-v",
                    str(output) + ":/reports",
                    "-e",
                    "GOMEMLIMIT=448MiB",
                    "-e",
                    "FIXTURE",
                    "-e",
                    "WORKLOAD=" + workload,
                    "-e",
                    "DURATION=" + duration,
                    "-e",
                    "VUS=" + str(vus),
                    "-e",
                    "RATE=" + str(rate),
                    "-e",
                    "OVERLOAD=" + str(overload).lower(),
                    K6,
                    "run",
                    "--quiet",
                    "--summary-export=/reports/" + label + ".json",
                    "/campaign.js",
                ]
                print("Running", label, workload, duration, flush=True)
                with (output / (label + ".log")).open("w") as target:
                    result = subprocess.run(
                        command,
                        stdout=target,
                        stderr=subprocess.STDOUT,
                        timeout=3900,
                        env={**os.environ, "FIXTURE": json.dumps(fixture)},
                    )
                if result.returncode:
                    state = json.loads(docker("inspect", app))[0]["State"]
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
                    docker("rm", "-f", app)
                    start()
                    relogin()
                report = json.loads((output / (label + ".json")).read_text())
                if result.returncode == 0:
                    metrics = report["metrics"]
                    if (
                        metrics["unexpected"]["value"] != 0
                        or metrics["checks"]["fails"]
                    ):
                        raise RuntimeError("Correctness checks failed: " + label)
                    if rate > 0:
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
                "ANALYZE public.bench_products; ANALYZE public.bench_private; ANALYZE storage.objects;"
            )
            plans("analyzed")
            results = []
            for workload in arguments.workloads:
                for iteration in range(1, 4):
                    results.append(
                        (
                            workload,
                            run(
                                f"{workload}-{iteration}",
                                workload,
                                arguments.steady,
                                16,
                                arguments.steady_rate,
                            ),
                        )
                    )
            capacity_workload = "mixed"
            if "mixed" not in arguments.workloads:
                capacity_workload = arguments.workloads[0]
            throughput = sorted(
                report["metrics"]["http_reqs"]["rate"]
                for kind, report in results
                if kind == capacity_workload
            )[1]
            soak_rate = max(1, int(throughput * 0.8))
            if arguments.soak_rate > 0:
                soak_rate = arguments.soak_rate
            (output / "capacity.json").write_text(
                json.dumps(
                    {
                        "mixed_median_rps": throughput,
                        "soak_rps": soak_rate,
                        "p95_regression_gate": 1.10,
                        "throughput_regression_gate": 0.90,
                    },
                    indent=2,
                )
            )
            for load in [16, 32, 64, 128]:
                if not arguments.no_stress:
                    run("stress-" + str(load), "mixed", "20s", load, overload=True)
            run("recovery-before-restart", "mixed", "20s", 4)
            restarting.set()
            sampling_epoch += 1
            docker("stop", "-t", "10", app)
            docker("rm", app)
            start()
            relogin()
            sampling_epoch += 1
            restarting.clear()
            run("recovery-after-restart", "mixed", "20s", 4)
            if arguments.soak_seconds:
                run("soak", "mixed", str(arguments.soak_seconds) + "s", 16, soak_rate)
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
            file_integrity = {"verified_objects": 0, "maximum_object_bytes": 64}
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
                    expected = b"benchmark payload"
                    if name == "fixture.txt":
                        expected = b'"benchmark payload"'
                    if response.read(64) != expected:
                        raise RuntimeError(
                            "Stored bytes failed their post-load integrity check"
                        )
                file_integrity["verified_objects"] += 1
            states = {
                name: json.loads(docker("inspect", name))[0]["State"]
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
            (output / "invariants.json").write_text(
                json.dumps(
                    {
                        "auth": json.loads(invariant),
                        "outstanding": pending,
                        "database": final_activity,
                        "signature_errors": len(receiver.errors),
                        "received_window": len(receiver.requests),
                        "file_integrity": file_integrity,
                        "pg_state": states[pg],
                        "container_state": json.loads(docker("inspect", app))[0][
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
                resource_evidence_violations(samples, time.monotonic() - started)
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
            print("Campaign passed; reports:", output, flush=True)
        finally:
            stop.set()
            if sampler:
                sampler.join(timeout=50)
            try:
                docker("rm", "-f", generator)
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            names = [app, pg]
            if arguments.backend == "s3":
                names.append(s3)
            for name in names:
                try:
                    (output / (name.rsplit("-", 1)[-1] + "-state.json")).write_text(
                        json.dumps(
                            json.loads(docker("inspect", name))[0]["State"], indent=2
                        )
                    )
                    (output / (name.rsplit("-", 1)[-1] + ".log")).write_text(
                        docker("logs", name, include_stderr=True)
                    )
                except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError):
                    pass
                finally:
                    # Diagnostics must never prevent teardown of owned fixtures.
                    try:
                        docker("rm", "-fv", name)
                    except (RuntimeError, subprocess.TimeoutExpired):
                        pass
            receiver.close()
            try:
                docker("volume", "rm", volume)
            except (RuntimeError, subprocess.TimeoutExpired):
                pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--steady", default="30s")
    parser.add_argument(
        "--steady-rate",
        type=int,
        default=0,
        help="Open-loop nominal requests/second; zero uses closed-loop VUs",
    )
    parser.add_argument("--soak-seconds", type=int, default=1800)
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
    if not arguments.binary.is_file() or not 0 <= arguments.soak_seconds <= 3600:
        parser.error("Invalid binary or soak budget")
    if not 0 <= arguments.steady_rate <= 10000:
        parser.error("Steady rate is outside the request budget")
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
