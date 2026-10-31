"""Real-binary migration, data-preservation and webhook acceptance scenario."""

import hashlib
import json
import logging
import os
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

from upgrade.support import Receiver, digest, free_port, ident, quote

PASSWORD = "upgrade-test-password-123"
JWT = "upgrade-test-jwt-secret-at-least-32-characters"
LOGGER = logging.getLogger(__name__)


@dataclass
class Baseline:
    sessions: list
    files: dict
    rest_rows: list
    tables: list
    functions: list
    schema: dict
    disk_hashes: dict
    dump: Path


class UpgradeScenario:
    def __init__(self, root, old_binary, new_binary, target_version, expected_migrations):
        self.root = root
        self.old_binary = old_binary
        self.new_binary = new_binary
        self.expected_migrations = expected_migrations
        self.container = "nelcota-upgrade-test-" + uuid.uuid4().hex[:12]
        self.database = "upgrade_fixture"
        self.restore_db = "upgrade_restore"
        self.storage_dir = root / "storage"
        self.storage_dir.mkdir()
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.pg_port = None
        self.process = None
        self.server_log = None
        self.admin_hash = None
        self.cookie = None
        self.receiver = None
        self.container_created = False
        self.databases = []
        self.checks = []
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.report = {
            "from": "0.3.1",
            "to": target_version,
            "success": False,
            "checks": self.checks,
            "postgres": "17",
            "auth": "HS256",
            "baseline_sha256": digest(old_binary),
            "target_sha256": digest(new_binary),
        }

    def prepare(self, postgres_image):
        self.container_created = True
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                self.container,
                "--label",
                "nelcota.test=upgrade",
                "--cpus=2",
                "--memory=512m",
                "-e",
                "POSTGRES_PASSWORD=postgres",
                "-p",
                "127.0.0.1::5432",
                "--tmpfs",
                "/var/lib/postgresql/data:size=192m",
                postgres_image,
                "postgres",
                "-c",
                "shared_preload_libraries=pg_stat_statements",
            ],
            check=True,
            timeout=120,
            stdout=subprocess.DEVNULL,
        )

        def ready():
            return (
                subprocess.run(
                    [
                        "docker",
                        "exec",
                        self.container,
                        "pg_isready",
                        "-q",
                        "-h",
                        "127.0.0.1",
                        "-U",
                        "postgres",
                    ],
                    check=False,
                    timeout=15,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                ).returncode
                == 0
            )

        self.wait(ready, "PostgreSQL initialization", seconds=60)
        mapped = subprocess.check_output(
            [
                "docker",
                "port",
                self.container,
                "5432/tcp",
            ],
            text=True,
            timeout=15,
        ).strip()
        assert mapped.startswith("127.0.0.1:")
        self.pg_port = int(mapped.rsplit(":", 1)[1])
        self.receiver = Receiver()

    def close(self):
        errors = []
        for operation in [self.stop, self.close_receiver, self.remove_container]:
            try:
                operation()
            except Exception as error:
                LOGGER.exception("Upgrade fixture cleanup failed")
                errors.append(repr(error))
        if errors:
            self.report["success"] = False
            self.report["cleanup_errors"] = errors
            raise RuntimeError("Upgrade fixture cleanup failed: " + "; ".join(errors))
        self.report["cleanup_succeeded"] = True

    def close_receiver(self):
        if self.receiver:
            self.receiver.close()

    def remove_container(self):
        if not self.container_created:
            return
        subprocess.run(
            [
                "docker",
                "rm",
                "-f",
                self.container,
            ],
            check=True,
            timeout=30,
            stdout=subprocess.DEVNULL,
        )
        self.container_created = False

    def sql(self, statement, database=None, variables=()):
        command = [
            "docker",
            "exec",
            "-i",
            self.container,
            "psql",
            "-X",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            database or self.database,
        ]
        for name, value in variables:
            command.extend(["-v", name + "=" + value])
        result = subprocess.run(
            command,
            check=False,
            input=statement,
            text=True,
            capture_output=True,
            timeout=30,
        )
        if result.returncode:
            raise RuntimeError("Fixture SQL failed: " + result.stderr)
        return result.stdout.strip()

    def fixture(self, alice, bob):
        source = Path(__file__).with_name("fixture.sql").read_text()
        self.sql(source, variables=[("alice", alice), ("bob", bob)])

    def http(
        self,
        method,
        path,
        body=None,
        token=None,
        admin=False,
        expected=200,
        content_type="application/json",
        extra=None,
    ):
        headers = dict(extra or {})
        if token:
            headers["Authorization"] = "Bearer " + token
        if admin:
            headers["Cookie"] = self.cookie
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        if body is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.url + path, data=body, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(1024 * 1024 + 1)
            assert len(data) <= 1024 * 1024, "Unbounded API response"
            status = response.status
            returned = {k.lower(): v for k, v in response.headers.items()}
        if status != expected:
            raise AssertionError(
                f"{method} {path}: expected {expected}, got {status}: "
                + data.decode(errors="replace")[:600]
            )
        if content_type == "raw":
            return data, returned
        if not data:
            return None, returned
        return json.loads(data), returned

    def start(self, binary, name, loopback=False):
        # Do not pass CI credentials, project configuration or proxy variables
        # to either server. The fixture supplies every required setting.
        env = {
            "PATH": os.environ["PATH"],
            "RUST_LOG": "info",
            "TOKIO_WORKER_THREADS": "2",
            "NELCOTA_DATABASE_URL": f"postgres://postgres:postgres@127.0.0.1:{self.pg_port}/{self.database}",
            "NELCOTA_AUTHENTICATOR_PASSWORD": "test-authenticator-password",
            "NELCOTA_JWT_SECRET": JWT,
            "NELCOTA_LISTEN": f"127.0.0.1:{self.port}",
            "NELCOTA_DB_POOL_SIZE": "4",
            "NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE": "100000",
            "NELCOTA_API_CONCURRENCY_PER_CALLER": "0",
            "NELCOTA_API_RATE_LIMIT_PER_MINUTE": "0",
            "NELCOTA_STORAGE_BACKEND": "disk",
            "NELCOTA_STORAGE_DIR": str(self.storage_dir),
            "NELCOTA_STORAGE_MIN_FREE_BYTES": "0",
            "NELCOTA_WEBHOOKS_ALLOW_LOOPBACK": str(loopback).lower(),
        }
        if self.admin_hash:
            env["NELCOTA_ADMIN_EMAIL"] = "admin@example.com"
            env["NELCOTA_ADMIN_PASSWORD_HASH"] = self.admin_hash
        self.server_log = (self.root / (name + ".log")).open("w")
        self.process = subprocess.Popen(
            [str(binary), "serve"],
            cwd=self.root,
            env=env,
            stdout=self.server_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

        def healthy():
            if self.process.poll() is not None:
                raise AssertionError("Server failed to start; see " + name + ".log")
            try:
                self.http("GET", "/health")
                return True
            except (urllib.error.URLError, ConnectionError):
                return False

        self.wait(healthy, name + " health", seconds=60)
        self.cookie = None
        if self.admin_hash:
            _, headers = self.http(
                "POST",
                "/admin/api/login",
                {
                    "email": "admin@example.com",
                    "password": PASSWORD,
                },
            )
            self.cookie = headers["set-cookie"].split(";", 1)[0]

    def stop(self):
        process, self.process = self.process, None
        log, self.server_log = self.server_log, None
        try:
            if process is None:
                return
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
                raise AssertionError("Graceful shutdown exceeded 20 seconds")
            assert process.returncode == 0, f"Server exited with {process.returncode}"
        finally:
            if log:
                log.close()

    def passed(self, name):
        self.checks.append(name)
        print("PASS: " + name, flush=True)

    def query(self, statement, database=None):
        return json.loads(self.sql(statement, database))

    def wait(self, check, description, seconds=35):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(0.2)
        raise AssertionError("Timed out: " + description)

    def file_hashes(self):
        return {
            str(p.relative_to(self.storage_dir)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(self.storage_dir.rglob("*"))
            if p.is_file()
        }

    def expected_file_hashes(self, baseline):
        expected = baseline.disk_hashes.copy()
        if self.report["target_kind"] == "published":
            return expected
        # The checkout adds exactly one control file when adopting this legacy
        # store. Require its correct identity; retain exact comparison of every
        # original byte/path and reject extra files, including quarantine state.
        marker = self.storage_dir / ".nelcota-gc-owner-v1"
        assert marker.is_file() and not marker.is_symlink()
        identity = self.sql(
            "SELECT system_identifier::text || chr(10) || current_database() || chr(10) || "
            "(SELECT oid::text FROM pg_database WHERE datname = current_database()) "
            "FROM pg_control_system();"
        ).strip()
        owner = b"v1:" + hashlib.sha256(identity.encode()).hexdigest().encode()
        expected[marker.name] = hashlib.sha256(owner).hexdigest()
        return expected

    def snapshot(self, tables, functions):
        ids = ",".join(str(t["oid"]) for t in tables)
        fnids = ",".join(str(f) for f in functions)
        items = []
        for t in tables:
            name = t["schema"] + "." + t["table"]
            qualified = ident(t["schema"]) + "." + ident(t["table"])
            items.extend(
                [
                    quote(name),
                    f"(SELECT coalesce(jsonb_agg(to_jsonb(t)::text ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {qualified} t)",
                ]
            )
        sequences = self.query(
            "SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname) ORDER BY n.nspname,c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname IN ('public','auth','storage','nelcota') AND EXISTS (SELECT FROM pg_depend d WHERE d.objid=c.oid AND d.refobjid IN ("
            + ids
            + "));"
        )
        seqitems = []
        for seq in sequences:
            name = seq["schema"] + "." + seq["name"]
            seqitems.extend(
                [
                    quote(name),
                    f"(SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM {ident(seq['schema'])}.{ident(seq['name'])})",
                ]
            )

        def agg(select):
            return f"(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) FROM ({select}) x)"

        catalog = {
            "relations": f"SELECT c.oid,n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid IN ({ids})",
            "columns": f"SELECT attrelid,attnum,attname,format_type(atttypid,atttypmod) AS type,attnotnull,attidentity,attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE attrelid IN ({ids}) AND attnum>0 AND NOT attisdropped",
            "constraints": f"SELECT conrelid,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ({ids})",
            "indexes": f"SELECT indrelid,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid IN ({ids})",
            "triggers": f"SELECT tgrelid,tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid IN ({ids}) AND NOT tgisinternal",
            "policies": f"SELECT * FROM pg_policies WHERE (quote_ident(schemaname)||'.'||quote_ident(tablename))::regclass::oid IN ({ids})",
            "functions": f"SELECT oid,pg_get_functiondef(oid) AS definition,proacl::text FROM pg_proc WHERE oid IN ({fnids})",
        }
        parts = [
            quote("tables"),
            "jsonb_build_object(" + ",".join(items) + ")",
            quote("sequences"),
            "jsonb_build_object(" + ",".join(seqitems) + ")",
        ]
        for key, select in catalog.items():
            parts.extend([quote(key), agg(select)])
        return self.query("SELECT jsonb_build_object(" + ",".join(parts) + ");")

    def capture_baseline(self):
        self.sql(f"CREATE DATABASE {ident(self.database)};", "postgres")
        self.databases.append(self.database)
        assert int(self.sql("SELECT count(*) FROM pg_roles WHERE rolname='nelcota_webhooks';")) == 0
        self.start(self.old_binary, "old-seed")
        users = []
        for email in ["alice-upgrade@example.com", "bob-upgrade@example.com"]:
            session, _ = self.http(
                "POST",
                "/auth/v1/signup",
                {
                    "email": email,
                    "password": PASSWORD,
                    "data": {"purpose": "upgrade fixture", "unicode": "preservação"},
                },
                expected=201,
            )
            users.append(session)
        alice, bob = users
        a, b = (alice["user"]["id"], bob["user"]["id"])
        self.admin_hash = self.sql(
            f"SELECT encrypted_password FROM auth.users WHERE id={quote(a)}::uuid;"
        )
        self.fixture(a, b)
        files = {
            "nested/preservação.txt": "Conteúdo preservado 🐘\n".encode(),
            "all-bytes.bin": bytes(range(256)) * 1024,
            "empty.txt": b"",
        }
        for name, content in files.items():
            path = "/storage/v1/object/upgrade-files/" + urllib.parse.quote(name)
            self.http(
                "POST",
                path,
                content,
                token=alice["access_token"],
                expected=201,
                content_type="application/octet-stream",
            )
        self.stop()
        self.start(self.old_binary, "old-baseline")
        before_rows, _ = self.http(
            "GET", "/rest/v1/upgrade_notes?order=id", token=alice["access_token"]
        )
        assert len(before_rows) == 1 and before_rows[0]["user_id"] == a
        bob_rows, _ = self.http("GET", "/rest/v1/upgrade_notes?order=id", token=bob["access_token"])
        assert len(bob_rows) == 1 and bob_rows[0]["user_id"] == b
        self.stop()
        tables = self.query(
            "SELECT json_agg(json_build_object('schema',n.nspname,'table',c.relname,'oid',c.oid) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','auth','storage','nelcota');"
        )
        functions = self.query(
            "SELECT json_agg(p.oid ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth','storage','nelcota') AND p.prokind IN ('f','p');"
        )
        before = self.snapshot(tables, functions)
        disk_before = self.file_hashes()
        assert len(before["tables"]["nelcota.schema_migrations"]) == 12
        (self.root / "before.json").write_text(json.dumps(before, ensure_ascii=False, indent=2))
        dump = self.root / "pre-upgrade.dump"
        with dump.open("wb") as out:
            subprocess.run(
                [
                    "docker",
                    "exec",
                    self.container,
                    "pg_dump",
                    "-U",
                    "postgres",
                    "-d",
                    self.database,
                    "-Fc",
                ],
                stdout=out,
                check=True,
                timeout=30,
            )
        assert int(self.sql("SELECT count(*) FROM pg_roles WHERE rolname='nelcota_webhooks';")) == 0
        self.passed("Fresh 0.3.1 cluster has no webhook role before migration")
        self.passed("0.3.1 fixture and paired pre-upgrade database/disk baseline captured")
        return Baseline(
            users, files, [before_rows, bob_rows], tables, functions, before, disk_before, dump
        )

    def validate_performance_additions(self, after, baseline):
        """Verify each additive change, then compare all original schema/data."""
        table_oids = {t["schema"] + "." + t["table"]: t["oid"] for t in baseline.tables}
        expected_indexes = []
        if 14 in self.expected_migrations:
            expected_indexes.append({
                "indrelid": table_oids["auth.users"],
                "definition": "CREATE INDEX users_created_id_idx ON auth.users USING btree (created_at DESC, id DESC)",
            })
        if 15 in self.expected_migrations:
            expected_indexes.append({
                "indrelid": table_oids["storage.objects"],
                "definition": "CREATE INDEX objects_directory_idx ON storage.objects USING btree (bucket_id, directory_key)",
            })
            expected_indexes.append({
                "indrelid": table_oids["storage.objects"],
                "definition": "CREATE INDEX objects_directory_files_idx ON storage.objects USING btree (directory_scope, name)",
            })
            originals = [c for c in baseline.schema["columns"] if c["attrelid"] == table_oids["storage.objects"]]
            expected_column = {
                "attrelid": table_oids["storage.objects"], "attnum": max(c["attnum"] for c in originals) + 1,
                "attname": "directory_key", "type": "bytea", "attnotnull": False,
                "attidentity": "", "attgenerated": "s", "default_value": "storage.directory_key(name)",
            }
            expected_scope = {
                "attrelid": table_oids["storage.objects"], "attnum": expected_column["attnum"] + 1,
                "attname": "directory_scope", "type": "integer", "attnotnull": False,
                "attidentity": "", "attgenerated": "s",
                "default_value": "storage.directory_hash(bucket_id, storage.directory_key(name))",
            }
            added_columns = [c for c in after["columns"] if c not in baseline.schema["columns"] and c["attrelid"] == table_oids["storage.objects"]]
            assert added_columns == [expected_column, expected_scope], "Unexpected column addition or generated expression"
            assert int(self.sql("SELECT count(*) FROM storage.objects WHERE directory_key IS DISTINCT FROM storage.directory_key(name);")) == 0
            assert int(self.sql("SELECT count(*) FROM storage.objects WHERE directory_scope IS DISTINCT FROM storage.directory_hash(bucket_id, directory_key);")) == 0
            assert self.sql("SELECT encode(storage.directory_key('a-/nested/file.txt'),'hex');").strip() == "612d006e657374656400"
            after["columns"].remove(expected_column)
            after["columns"].remove(expected_scope)
            # Project only the verified new field away; every original value is
            # still compared byte-for-byte in Postgres' canonical JSON format.
            after["tables"]["storage.objects"] = self.query(
                "SELECT coalesce(jsonb_agg((to_jsonb(t)-'directory_key'-'directory_scope')::text ORDER BY (to_jsonb(t)-'directory_key'-'directory_scope')::text),'[]'::jsonb) FROM storage.objects t;"
            )
        if 22 in self.expected_migrations:
            tokens_oid = table_oids["auth.one_time_tokens"]
            originals = [c for c in baseline.schema["columns"] if c["attrelid"] == tokens_oid]
            expected = {
                "attrelid": tokens_oid, "attnum": max(c["attnum"] for c in originals) + 1,
                "attname": "code_challenge", "type": "text", "attnotnull": False,
                "attidentity": "", "attgenerated": "", "default_value": None,
            }
            added = [c for c in after["columns"] if c not in baseline.schema["columns"] and c["attrelid"] == tokens_oid]
            assert added == [expected], "Unexpected signup-link binding column"
            after["columns"].remove(expected)
            constraints = [c for c in after["constraints"] if c not in baseline.schema["constraints"] and c["conrelid"] == tokens_oid]
            assert len(constraints) == 1 and constraints[0]["conname"] == "one_time_tokens_code_challenge_check"
            after["constraints"].remove(constraints[0])
            for row in after["tables"]["auth.one_time_tokens"]:
                assert json.loads(row)["code_challenge"] is None, "Existing links acquired a binding"
            after["tables"]["auth.one_time_tokens"] = self.query(
                "SELECT coalesce(jsonb_agg((to_jsonb(t)-'code_challenge')::text ORDER BY (to_jsonb(t)-'code_challenge')::text),'[]'::jsonb) FROM auth.one_time_tokens t;"
            )
        if 18 in self.expected_migrations:
            avatar_oid = table_oids["nelcota.admin_avatar"]
            fields = {
                "source_content_type": "text", "source_image": "bytea", "source_digest": "bytea",
                "source_updated_at": "timestamp with time zone", "source_crop_x": "double precision",
                "source_crop_y": "double precision", "source_zoom": "double precision", "source_rotation": "smallint",
            }
            originals = [c for c in baseline.schema["columns"] if c["attrelid"] == avatar_oid]
            last = max(c["attnum"] for c in originals)
            expected = [{
                "attrelid": avatar_oid, "attnum": last + index, "attname": name, "type": kind,
                "attnotnull": False, "attidentity": "", "attgenerated": "", "default_value": None,
            } for index, (name, kind) in enumerate(fields.items(), 1)]
            added = [c for c in after["columns"] if c not in baseline.schema["columns"]]
            assert sorted(added, key=lambda c: c["attnum"]) == expected, "Unexpected avatar source columns"
            for column in expected:
                after["columns"].remove(column)
            constraints = [c for c in after["constraints"] if c not in baseline.schema["constraints"]]
            assert len(constraints) == 1 and constraints[0]["conrelid"] == avatar_oid
            assert constraints[0]["conname"] == "admin_avatar_source_valid"
            assert all(name in constraints[0]["definition"] for name in fields)
            after["constraints"].remove(constraints[0])
            for row in after["tables"]["nelcota.admin_avatar"]:
                assert all(json.loads(row)[name] is None for name in fields), "Existing photos acquired unexpected editor state"
            projection = "to_jsonb(t) - ARRAY[" + ",".join(quote(name) for name in fields) + "]"
            after["tables"]["nelcota.admin_avatar"] = self.query(
                f"SELECT coalesce(jsonb_agg(({projection})::text ORDER BY ({projection})::text),'[]'::jsonb) FROM nelcota.admin_avatar t;"
            )
        added_indexes = [i for i in after["indexes"] if i not in baseline.schema["indexes"]]
        assert sorted(added_indexes, key=lambda i: i["definition"]) == sorted(expected_indexes, key=lambda i: i["definition"]), "Unexpected index addition or missing performance index"
        after["indexes"] = [i for i in after["indexes"] if i not in expected_indexes]

    def validate_migration(self, baseline):
        alice, bob = baseline.sessions
        a, b = (alice["user"]["id"], bob["user"]["id"])
        self.start(self.new_binary, "new-migration")
        role = self.query(
            "SELECT json_build_object('login',rolcanlogin,'inherit',rolinherit) FROM pg_roles WHERE rolname='nelcota_webhooks';"
        )
        assert role == {"login": False, "inherit": False}
        after = self.snapshot(baseline.tables, baseline.functions)
        migration_rows = after["tables"]["nelcota.schema_migrations"]
        assert sorted(json.loads(r)["version"] for r in migration_rows) == self.expected_migrations
        assert (
            json.loads(next(r for r in migration_rows if json.loads(r)["version"] == 13))["name"]
            == "webhooks"
        )
        after["tables"]["nelcota.schema_migrations"] = [
            r for r in migration_rows if json.loads(r)["version"] <= 12
        ]
        self.validate_performance_additions(after, baseline)
        assert after == baseline.schema, "Pre-existing data, sequences or schema changed"
        assert self.file_hashes() == self.expected_file_hashes(baseline)
        assert int(self.sql("SELECT count(*) FROM nelcota.webhook_deliveries;")) == 0
        (self.root / "after.json").write_text(json.dumps(after, ensure_ascii=False, indent=2))
        self.passed(
            "Expected migrations applied; every pre-existing table row, sequence, constraint, index, RLS policy, trigger and function preserved"
        )
        for name, content in baseline.files.items():
            path = "/storage/v1/object/upgrade-files/" + urllib.parse.quote(name)
            downloaded, _ = self.http("GET", path, token=alice["access_token"], content_type="raw")
            assert downloaded == content
            self.http("GET", path, token=bob["access_token"], expected=404)
            self.http("GET", path, expected=404)
        self.passed(
            "All pre-upgrade files downloaded byte-for-byte; private file isolation preserved"
        )
        rows, _ = self.http("GET", "/rest/v1/upgrade_notes?order=id", token=alice["access_token"])
        assert rows == baseline.rest_rows[0]
        rows, _ = self.http("GET", "/rest/v1/upgrade_notes?order=id", token=bob["access_token"])
        assert rows == baseline.rest_rows[1]
        self.http("GET", "/rest/v1/upgrade_notes", expected=401)
        self.http(
            "POST",
            "/rest/v1/upgrade_notes",
            {"user_id": b, "title": "forbidden"},
            token=alice["access_token"],
            expected=403,
        )
        self.passed("Pre-upgrade access tokens and row isolation work after migration")
        refreshed, _ = self.http(
            "POST",
            "/auth/v1/token?grant_type=refresh_token",
            {"refresh_token": alice["refresh_token"]},
        )
        assert refreshed["user"]["id"] == a and refreshed["refresh_token"] != alice["refresh_token"]
        alice = refreshed
        signed_in, _ = self.http(
            "POST",
            "/auth/v1/token?grant_type=password",
            {"email": "bob-upgrade@example.com", "password": PASSWORD},
        )
        assert signed_in["user"]["id"] == b
        self.passed("Pre-upgrade refresh token rotates and existing password login succeeds")
        return alice

    def validate_webhooks(self, baseline, alice):
        a = alice["user"]["id"]
        b = baseline.sessions[1]["user"]["id"]
        hook_body = {
            "name": "Upgrade notes",
            "table": "upgrade_notes",
            "url": f"http://127.0.0.1:{self.receiver.server_port}/hook",
            "events": ["INSERT", "UPDATE", "DELETE"],
            "enabled": True,
            "max_attempts": 6,
        }
        self.http("GET", "/admin/api/webhooks", expected=401)
        self.http("POST", "/admin/api/webhooks", hook_body, admin=True, expected=400)
        assert int(self.sql("SELECT count(*) FROM nelcota.webhook_endpoints;")) == 0
        self.passed("Webhook administration stays private and loopback is blocked by default")
        self.stop()
        self.start(self.new_binary, "new-loopback", loopback=True)
        created, headers = self.http("POST", "/admin/api/webhooks", hook_body, admin=True)
        self.receiver.secret = created["secret"]
        assert headers.get("cache-control") == "no-store"
        endpoint = created["endpoint"]["id"]
        listed, _ = self.http("GET", "/admin/api/webhooks", admin=True)
        assert listed["endpoints"][0]["id"] == endpoint
        assert self.receiver.secret not in json.dumps(
            listed
        ) and "signing_secret" not in json.dumps(listed)
        assert int(self.sql("SELECT count(*) FROM nelcota.webhook_deliveries;")) == 0
        self.passed("Webhook configured on the pre-existing table without replaying old rows")
        inserted, _ = self.http(
            "POST",
            "/rest/v1/upgrade_notes",
            {"title": "post-upgrade REST insert"},
            token=alice["access_token"],
            expected=201,
            extra={"Prefer": "return=representation"},
        )
        note = inserted[0]
        self.http(
            "PATCH",
            f"/rest/v1/upgrade_notes?id=eq.{note['id']}",
            {"title": "post-upgrade REST update"},
            token=alice["access_token"],
            expected=204,
        )
        self.http(
            "DELETE",
            f"/rest/v1/upgrade_notes?id=eq.{note['id']}",
            token=alice["access_token"],
            expected=204,
        )
        self.wait(
            lambda: (
                int(
                    self.sql(
                        "SELECT count(*) FROM nelcota.webhook_deliveries WHERE status='succeeded';"
                    )
                )
                == 3
            ),
            "INSERT/UPDATE/DELETE delivery",
        )
        with self.receiver.lock:
            assert not self.receiver.errors and len(self.receiver.requests) == 3
            events = {r["payload"]["type"]: r["payload"] for r in self.receiver.requests}
        assert set(events) == {"INSERT", "UPDATE", "DELETE"}
        assert events["INSERT"]["old_record"] is None
        assert events["INSERT"]["record"]["title"] == "post-upgrade REST insert"
        assert events["UPDATE"]["old_record"]["title"] == "post-upgrade REST insert"
        assert events["UPDATE"]["record"]["title"] == "post-upgrade REST update"
        assert events["DELETE"]["record"] is None
        assert events["DELETE"]["old_record"]["title"] == "post-upgrade REST update"
        self.passed("INSERT, UPDATE and DELETE deliver exact signed new/old rows after migration")
        self.sql(
            f"BEGIN; INSERT INTO public.upgrade_notes(user_id,title) VALUES({quote(a)}::uuid,'rollback must not deliver'); ROLLBACK;"
        )
        time.sleep(0.7)
        assert int(self.sql("SELECT count(*) FROM nelcota.webhook_deliveries;")) == 3
        assert (
            int(
                self.sql(
                    "SELECT count(*) FROM public.upgrade_notes WHERE title='rollback must not deliver';"
                )
            )
            == 0
        )
        self.http(
            "POST",
            "/rest/v1/upgrade_notes",
            {"user_id": b, "title": "forbidden webhook"},
            token=alice["access_token"],
            expected=403,
        )
        assert int(self.sql("SELECT count(*) FROM nelcota.webhook_deliveries;")) == 3
        self.passed("Rolled-back and RLS-denied writes create neither business rows nor deliveries")
        self.http(
            "POST",
            "/rest/v1/rpc/upgrade_add_note",
            {"title": "post-upgrade RPC insert"},
            token=alice["access_token"],
        )
        self.http(
            "POST",
            "/admin/api/sql",
            {
                "sql": f"INSERT INTO public.upgrade_notes(user_id,title) VALUES({quote(a)}::uuid,'post-upgrade panel insert')"
            },
            admin=True,
        )
        self.sql(
            f"INSERT INTO public.upgrade_notes(user_id,title) VALUES({quote(a)}::uuid,'post-upgrade direct SQL insert');"
        )
        self.wait(
            lambda: (
                int(
                    self.sql(
                        "SELECT count(*) FROM nelcota.webhook_deliveries WHERE status='succeeded';"
                    )
                )
                == 6
            ),
            "RPC/panel/direct SQL delivery",
        )
        self.passed(
            "Existing RPC, panel SQL and direct SQL changes deliver through the migrated capture trigger"
        )
        with self.receiver.lock:
            self.receiver.status = 503
        self.http(
            "POST",
            "/rest/v1/upgrade_notes",
            {"title": "retry across restart"},
            token=alice["access_token"],
            expected=201,
        )
        self.wait(
            lambda: (
                int(
                    self.sql(
                        "SELECT count(*) FROM nelcota.webhook_deliveries WHERE status='pending' AND attempts>=1;"
                    )
                )
                == 1
            ),
            "503 schedules retry",
        )
        self.stop()
        pending = self.query(
            "SELECT json_build_object('id',id::text,'event_id',event_id,'payload',payload,'attempts',attempts) FROM nelcota.webhook_deliveries WHERE status='pending';"
        )
        self.sql(
            "UPDATE nelcota.webhook_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE status='pending';"
        )
        with self.receiver.lock:
            self.receiver.status = 204
        migrations_before_restart = self.sql(
            "SELECT jsonb_agg(to_jsonb(t) ORDER BY version) FROM nelcota.schema_migrations t;"
        )
        self.start(self.new_binary, "new-restart", loopback=True)
        self.wait(
            lambda: (
                int(
                    self.sql(
                        "SELECT count(*) FROM nelcota.webhook_deliveries WHERE status='succeeded';"
                    )
                )
                == 7
            ),
            "durable retry after restart",
        )
        assert (
            self.sql(
                "SELECT jsonb_agg(to_jsonb(t) ORDER BY version) FROM nelcota.schema_migrations t;"
            )
            == migrations_before_restart
        )
        with self.receiver.lock:
            retried = [r for r in self.receiver.requests if r["delivery_id"] == pending["id"]]
            assert len(retried) >= 2 and (not self.receiver.errors)
            assert {r["event_id"] for r in retried} == {pending["event_id"]}
            assert len({r["raw_hash"] for r in retried}) == 1
        detail, _ = self.http("GET", "/admin/api/webhooks/deliveries/" + pending["id"], admin=True)
        assert self.receiver.secret not in json.dumps(detail)
        assert len(detail["attempts"]) >= 2
        self.passed(
            "503 retry, stable event/body/signature and attempt history survive real server restart; V13 is idempotent"
        )
        baseline_notes = baseline.schema["tables"]["public.upgrade_notes"]
        preserved = self.query(
            "SELECT jsonb_agg(to_jsonb(t)::text ORDER BY to_jsonb(t)::text) FROM public.upgrade_notes t WHERE id IN (1,2);"
        )
        assert preserved == baseline_notes
        assert self.file_hashes() == self.expected_file_hashes(baseline)
        assert int(self.sql("SELECT count(*) FROM public.upgrade_audit;")) >= 8
        assert (
            int(
                self.sql(
                    "SELECT count(*) FROM pg_trigger WHERE tgrelid='public.upgrade_notes'::regclass AND tgname='existing_audit';"
                )
            )
            == 1
        )
        assert self.query(
            "SELECT json_build_object('outstanding',outstanding,'retained',retained) FROM nelcota.webhook_queue_usage;"
        ) == {"outstanding": 0, "retained": 7}
        self.passed(
            "Original business rows/files and existing audit trigger remain intact; queue counters reconcile"
        )

    def validate_restore(self, baseline):
        self.stop()
        self.sql(f"CREATE DATABASE {ident(self.restore_db)};", "postgres")
        self.databases.append(self.restore_db)
        with baseline.dump.open("rb") as source:
            subprocess.run(
                [
                    "docker",
                    "exec",
                    "-i",
                    self.container,
                    "pg_restore",
                    "-U",
                    "postgres",
                    "-d",
                    self.restore_db,
                    "--exit-on-error",
                ],
                stdin=source,
                check=True,
                timeout=30,
            )
        self.database = self.restore_db
        restored_tables = self.query(
            "SELECT json_agg(json_build_object('schema',n.nspname,'table',c.relname,'oid',c.oid) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','auth','storage','nelcota');"
        )
        restored_functions = self.query(
            "SELECT json_agg(p.oid ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth','storage','nelcota') AND p.prokind IN ('f','p');"
        )
        restored = self.snapshot(restored_tables, restored_functions)
        assert (
            restored["tables"] == baseline.schema["tables"]
            and restored["sequences"] == baseline.schema["sequences"]
        )
        self.start(self.old_binary, "old-restored-backup")
        me, _ = self.http("GET", "/auth/v1/user", token=baseline.sessions[0]["access_token"])
        assert me["id"] == baseline.sessions[0]["user"]["id"]
        downloaded, _ = self.http(
            "GET",
            "/storage/v1/object/upgrade-files/all-bytes.bin",
            token=baseline.sessions[0]["access_token"],
            content_type="raw",
        )
        assert downloaded == baseline.files["all-bytes.bin"]
        self.passed(
            "Pre-upgrade backup restores all rows/sequences and works with the 0.3.1 binary and original disk files"
        )

    def run(self):
        baseline = self.capture_baseline()
        alice = self.validate_migration(baseline)
        self.validate_webhooks(baseline, alice)
        self.validate_restore(baseline)
        self.report.update(
            {
                "success": True,
                "preserved_tables": len(baseline.tables),
                "preserved_rows": sum(len(r) for r in baseline.schema["tables"].values()),
                "preserved_sequences": len(baseline.schema["sequences"]),
                "preserved_functions": len(baseline.functions),
                "preserved_files": len(baseline.files),
                "preserved_file_bytes": sum(len(v) for v in baseline.files.values()),
                "deliveries_succeeded": 7,
                "verified_http_attempts": len(self.receiver.requests),
                "migration_versions": self.expected_migrations,
                "legacy_migrations_unchanged": True,
                "database_backup": baseline.dump.name,
                "storage_directory": self.storage_dir.name,
                "fresh_cluster": True,
            }
        )
