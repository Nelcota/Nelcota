"""Exercise the documented Notes quickstart on an isolated local installation.

Requires Linux, Python 3.11+, Docker and a built or installed Nelcota binary.
No Node, service-role JWT, external credentials or existing database is needed.
"""

import argparse
from datetime import UTC, datetime
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BODY_LIMIT = 1024 * 1024
VOLUME_OWNER_LABEL = "nelcota.onboarding.run"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Api:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

    def request(self, method, path, *, token=None, value=None, raw=None, expected=200):
        headers = {}
        body = raw
        if token:
            headers["Authorization"] = "Bearer " + token
        if value is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(value).encode()
        if raw is not None:
            headers["Content-Type"] = "text/plain"
        if path.startswith("/rest/") and method != "GET":
            headers["Prefer"] = "return=representation"
        if path.startswith("/admin/") and method != "GET":
            headers["Origin"] = self.base
        request = urllib.request.Request(self.base + path, body, headers, method=method)
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            content = response.read(BODY_LIMIT + 1)
            require(len(content) <= BODY_LIMIT, "Response exceeded the diagnostic limit")
            statuses = expected
            if isinstance(expected, int):
                statuses = (expected,)
            require(response.code in statuses,
                    f"Unexpected HTTP {response.code} for {method} {path.split('?')[0]}")
            if "application/json" in response.headers.get("Content-Type", ""):
                return json.loads(content)
            return content


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def stop_process(process):
    if process is None:
        return
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=5)
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def run_process(arguments, *, timeout, **options):
    process = subprocess.Popen(arguments, start_new_session=True, **options)
    try:
        return process.wait(timeout=timeout)
    finally:
        stop_process(process)


def inspect(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, timeout=30)
    if result.returncode:
        require(b"no such" in result.stderr.lower() or b"not found" in result.stderr.lower(),
                "Docker inspection failed; check daemon access")
        return None
    return json.loads(result.stdout)[0]


def state_values(root):
    values = {}
    for line in (root / ".nelcota/dev.env").read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and not key.strip().startswith("#"):
            parts = shlex.split(value)
            require(len(parts) <= 1, "Malformed development environment value")
            values[key.strip()] = parts[0] if parts else ""
    return values


def owned_container(info, state, volume):
    if not info or not state.get("POSTGRES_PASSWORD"):
        return False
    environment = info["Config"]["Env"]
    if "POSTGRES_PASSWORD=" + state["POSTGRES_PASSWORD"] not in environment:
        return False
    return any(mount.get("Name") == volume and mount.get("Destination") ==
               "/var/lib/postgresql/data" for mount in info["Mounts"])


def owned_volume(info, run_id):
    if not info:
        return False
    return (info.get("Labels") or {}).get(VOLUME_OWNER_LABEL) == run_id


class Quickstart:
    def __init__(self, binary, report_dir):
        self.binary = binary
        self.root = Path(tempfile.mkdtemp(prefix="notes-", dir=report_dir))
        self.api_port = free_port()
        self.db_port = free_port()
        while self.db_port == self.api_port:
            self.db_port = free_port()
        folder_hash = hashlib.sha256(os.fsencode(self.root.resolve())).hexdigest()[:24]
        self.container = f"nelcota-dev-postgres-{folder_hash}-{self.db_port}"
        self.volume = self.container + "-data"
        self.run_id = secrets.token_hex(16)
        self.api = Api(f"http://127.0.0.1:{self.api_port}")
        self.process = None
        self.environment = {key: value for key, value in os.environ.items()
                            if not key.startswith("NELCOTA_")}
        self.environment["RUST_LOG"] = "warn"
        self.checks = []
        self.metadata = {}
        self.claimed = False

    def passed(self, message):
        self.checks.append(message)
        print("PASS: " + message, flush=True)

    def command(self, *arguments):
        with (self.root / "cli.log").open("ab") as log:
            code = run_process([self.binary, *arguments], cwd=self.root,
                               env=self.environment, stdout=log, stderr=log, timeout=60)
        require(code == 0, f"Nelcota {arguments[0]} failed; inspect private cli.log")

    def start(self):
        with (self.root / "server.log").open("ab") as log:
            self.process = subprocess.Popen(
                [self.binary, "dev", "--listen", f"127.0.0.1:{self.api_port}",
                 "--db-port", str(self.db_port)], cwd=self.root, env=self.environment,
                stdout=log, stderr=log, start_new_session=True,
            )
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            require(self.process.poll() is None, "Development server exited; inspect private server.log")
            try:
                health = self.api.request("GET", "/health")
                require(health["status"] == "ok", "Database health check failed")
                return health["version"]
            except (OSError, ValueError, RuntimeError):
                time.sleep(0.25)
        raise RuntimeError("Development server readiness timed out; inspect private server.log")

    def stop(self):
        stop_process(self.process)
        self.process = None

    def cleanup(self):
        self.stop()
        if not self.claimed:
            return "no database created"
        info = inspect("container", self.container)
        volume = inspect("volume", self.volume)
        if not info and not volume:
            return "no database created"
        require(owned_volume(volume, self.run_id),
                "Cleanup refused: database volume ownership could not be verified")
        state = {}
        if (self.root / ".nelcota/dev.env").exists():
            state = state_values(self.root)
        if not info:
            subprocess.run(["docker", "volume", "rm", self.volume], check=True,
                           stdout=subprocess.DEVNULL, timeout=30)
            return "owned volume removed; no database container created"
        require(owned_container(info, state, self.volume),
                "Cleanup refused: database ownership could not be verified")
        subprocess.run(["docker", "rm", "-f", info["Id"]], check=True,
                       stdout=subprocess.DEVNULL, timeout=30)
        subprocess.run(["docker", "volume", "rm", self.volume], check=True,
                       stdout=subprocess.DEVNULL, timeout=30)
        return "owned database container and volume removed"

    def browser(self):
        sdk = ROOT / "sdk/typescript"
        require((sdk / "dist/index.js").is_file(), "Build the TypeScript SDK before --browser")
        port = free_port()
        server = None
        with (self.root / "browser.log").open("ab") as log:
            try:
                server = subprocess.Popen(
                    [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
                     "--directory", str(sdk)], stdout=log, stderr=log,
                    start_new_session=True,
                )
                base = f"http://127.0.0.1:{port}"
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    require(server.poll() is None, "Browser example server exited")
                    try:
                        Api(base).request("GET", "/examples/browser.html")
                        break
                    except OSError:
                        time.sleep(0.1)
                code = run_process(
                    ["node", str(sdk / "test/browser/notes.mjs"), self.api.base,
                     base + "/examples/browser.html"], stdout=log, stderr=log,
                    env=self.environment, timeout=90,
                )
                require(code == 0, "Notes browser acceptance failed; inspect private browser.log")
            finally:
                stop_process(server)
        self.passed("existing Notes browser example: signup, login, save, list, upload, RLS and logout")

    def session(self, email, password, signup=False):
        path = "/auth/v1/token?grant_type=password"
        status = 200
        if signup:
            path = "/auth/v1/signup"
            status = 201
        session = self.api.request("POST", path, value={"email": email, "password": password}, expected=status)
        require(session.get("access_token") and session.get("refresh_token"),
                "Expected a session; email confirmation must be disabled in this local fixture")
        return session

    def run(self):
        require(inspect("container", self.container) is None,
                "Selected database container already exists; refusing to reuse it")
        require(inspect("volume", self.volume) is None,
                "Selected database volume already exists; refusing to reuse it")
        self.claimed = True
        subprocess.run(["docker", "volume", "create", "--label",
                        VOLUME_OWNER_LABEL + "=" + self.run_id, self.volume], check=True,
                       stdout=subprocess.DEVNULL, timeout=30)
        require(owned_volume(inspect("volume", self.volume), self.run_id),
                "Selected volume was concurrently created by another run; refusing to reuse it")
        version = self.start()
        state = state_values(self.root)
        database = inspect("container", self.container)
        require(owned_container(database, state, self.volume),
                "Development database ownership mismatch")
        self.metadata["postgres_image_id"] = database["Image"]
        require((self.root / ".nelcota/dev.env").stat().st_mode & 0o777 == 0o600,
                "Development credentials must be private")
        require(b"<html" in self.api.request("GET", "/admin/"), "Embedded panel missing")
        self.api.request("POST", "/admin/api/login", value={
            "email": state["ADMIN_EMAIL"], "password": state["ADMIN_PASSWORD"],
        })
        database_version = self.api.request("POST", "/admin/api/sql", value={
            "sql": "SELECT current_setting('server_version_num')::integer",
        })["results"][0]["rows"][0][0]
        require(170000 <= int(database_version) < 180000, "Expected PostgreSQL 17")
        self.metadata["postgres_version_num"] = int(database_version)
        self.passed("native server, healthy database, private credentials and panel login")

        (self.root / "migrations").mkdir()
        shutil.copyfile(ROOT / "examples/notes.sql", self.root / "migrations/V1__notes.sql")
        self.command("migrate")
        self.command("migrate")
        self.command("types", "-o", "database.ts")
        self.command("types", "--lang", "rust", "-o", "database.rs")
        require("notes" in (self.root / "database.ts").read_text(), "TypeScript Notes types missing")
        require("pub mod notes" in (self.root / "database.rs").read_text(), "Rust Notes types missing")
        self.passed("Notes migration, repeat migration and both generated type formats")

        suffix = secrets.token_hex(8)
        password = secrets.token_urlsafe(32)
        email_a = f"notes-a-{suffix}@example.com"
        email_b = f"notes-b-{suffix}@example.com"
        a = self.session(email_a, password, signup=True)
        b = self.session(email_b, password, signup=True)
        require(self.session(email_a, password)["user"]["id"] == a["user"]["id"], "Login identity mismatch")
        require(self.session(email_b, password)["user"]["id"] == b["user"]["id"], "Login identity mismatch")
        token_a, token_b = a["access_token"], b["access_token"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if "/notes" in self.api.request("GET", "/rest/v1/", token=token_a)["paths"]:
                break
            time.sleep(0.1)
        require("/notes" in self.api.request("GET", "/rest/v1/", token=token_a)["paths"],
                "Authenticated Notes catalog did not reload")
        note = self.api.request("POST", "/rest/v1/notes", token=token_a,
                                value={"body": "My first private note"}, expected=201)[0]
        other_note = self.api.request("POST", "/rest/v1/notes", token=token_b,
                                      value={"body": "Another user's note"}, expected=201)[0]
        self.api.request("GET", "/rest/v1/notes", expected=401)
        visible = self.api.request("GET", "/rest/v1/notes", token=token_a)
        require(len(visible) == 1 and visible[0]["id"] == note["id"], "RLS leaked another user's note")
        self.api.request("POST", "/rest/v1/notes", token=token_b,
                         value={"body": "Forged owner", "owner": a["user"]["id"]}, expected=403)
        other = self.api.request("PATCH", f"/rest/v1/notes?id=eq.{note['id']}", token=token_b,
                                 value={"body": "Unauthorized update"})
        require(other == [], "RLS allowed an unauthorized update")
        require(self.api.request("DELETE", f"/rest/v1/notes?id=eq.{note['id']}", token=token_b) == [],
                "RLS allowed an unauthorized delete")
        updated = self.api.request("PATCH", f"/rest/v1/notes?id=eq.{note['id']}", token=token_a,
                                   value={"body": "My updated private note"})
        require(len(updated) == 1 and updated[0]["body"] == "My updated private note",
                "Owner could not update a note")
        note = updated[0]
        removed = self.api.request("DELETE", f"/rest/v1/notes?id=eq.{other_note['id']}", token=token_b)
        require(len(removed) == 1 and removed[0]["id"] == other_note["id"], "Owner could not delete a note")
        self.passed("signup, password login, Notes CRUD and isolation against reads, writes and forged owners")

        path = "/storage/v1/object/files/" + a["user"]["id"] + "/hello.txt"
        content = b"Hello from the documented Notes example\n"
        self.api.request("POST", path, token=token_a, raw=content, expected=201)
        require(self.api.request("GET", path, token=token_a) == content, "Uploaded bytes changed")
        self.api.request("GET", path, token=token_b, expected=404)
        self.api.request("GET", path, expected=404)
        self.api.request("PUT", path, token=token_b, raw=b"Unauthorized overwrite", expected=(403, 404))
        require(self.api.request("GET", path, token=token_a) == content, "Unauthorized overwrite changed bytes")
        self.passed("file upload, exact download and private file isolation")

        self.api.request("POST", "/auth/v1/logout", token=token_b, value={}, expected=(200, 204))
        self.api.request("POST", "/auth/v1/token?grant_type=refresh_token",
                         value={"refresh_token": b["refresh_token"]}, expected=(400, 401))
        self.passed("logout rejects reuse of the retired refresh token")

        state_digest = hashlib.sha256((self.root / ".nelcota/dev.env").read_bytes()).digest()
        jwks = self.api.request("GET", "/auth/v1/.well-known/jwks.json")
        self.stop()
        subprocess.run(["docker", "stop", self.container], check=True,
                       stdout=subprocess.DEVNULL, timeout=30)
        require(self.start() == version, "Restart changed the server version")
        require(hashlib.sha256((self.root / ".nelcota/dev.env").read_bytes()).digest() == state_digest,
                "Restart changed saved credentials")
        require(self.api.request("GET", "/auth/v1/.well-known/jwks.json") == jwks, "Restart changed signing keys")
        restored = self.session(email_a, password)
        require(restored["user"]["id"] == a["user"]["id"], "Restart lost the account")
        require(self.api.request("GET", path, token=restored["access_token"]) == content, "Restart lost file bytes")
        require(self.api.request("GET", "/rest/v1/notes", token=restored["access_token"])[0]["body"] ==
                note["body"], "Restart lost or changed the note")
        self.command("migrate")
        self.passed("server and database restart preserve accounts, notes, file bytes and signing keys")
        return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="target/debug/nelcota")
    parser.add_argument("--browser", action="store_true", help="Also exercise the built SDK's browser example")
    parser.add_argument("--report-dir", type=Path, default=ROOT / ".tools/reports/onboarding")
    arguments = parser.parse_args()
    require(sys.platform == "linux", "This disposable runner requires Linux")
    candidate = shutil.which(arguments.binary)
    if candidate is None:
        candidate = str(Path(arguments.binary).resolve())
    binary = Path(candidate).resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), "Build or install the Nelcota binary first")
    subprocess.run(["docker", "info"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=30)
    os.umask(0o077)
    arguments.report_dir.mkdir(parents=True, exist_ok=True)
    fixture = Quickstart(str(binary), arguments.report_dir)
    with binary.open("rb") as artifact:
        digest = hashlib.file_digest(artifact, "sha256").hexdigest()
    report = {"status": "failed", "checks": fixture.checks, "binary_sha256": digest,
              "started_at": datetime.now(UTC).isoformat(), "browser_requested": arguments.browser}
    try:
        report["version"] = fixture.run()
        if arguments.browser:
            fixture.browser()
        report["status"] = "passed"
    except BaseException as failure:
        report["error"] = type(failure).__name__
        if isinstance(failure, RuntimeError):
            report["error"] = str(failure)
        raise
    finally:
        try:
            report["cleanup"] = fixture.cleanup()
        except BaseException:
            report["status"] = "failed"
            report["cleanup"] = "failed; inspect the owned disposable fixture"
            raise
        finally:
            report.update(fixture.metadata)
            report["completed_at"] = datetime.now(UTC).isoformat()
            (fixture.root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            print("Report: " + str(fixture.root / "report.json"), flush=True)


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit("Cancelled; disposable cleanup attempted") from None
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as failure:
        # HTTP response bodies, child output and command arguments can contain secrets.
        message = type(failure).__name__
        if isinstance(failure, RuntimeError):
            message = str(failure)
        raise SystemExit("FAIL: " + message) from None
