"""Bounded real-HTTP admin/catalog/ingress probes during ledger traffic.

The fault campaign owns fixtures, continuous arrivals, resource guards and
teardown. These supplemental probes never retry a mutation or publish bodies,
cookies, tokens or SQL. Public ingress and SMTP/OAuth remain separate targets.
"""
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import math
from pathlib import Path
import re
import secrets
import socket
import threading
import time
import traceback
import urllib.parse

from watchdog import atomic_json

PROFILE = {"scenarios": ["admin-budgets", "admin-cancellation", "catalog-recovery", "hostile-backend", "auth-links"],
           "maximum_requests": 4096, "maximum_body_bytes": 2 * 1024 ** 2,
           "maximum_read_bytes": 2 * 1024 ** 2, "maximum_consumed_bytes": 64 * 1024 ** 2,
           "maximum_unread_export_bytes": 256 * 1024 ** 2,
           "request_timeout_seconds": 5, "query_release_seconds": 3,
           "export_release_seconds": 5, "catalog_recovery_seconds": 5,
           "sql_slots": 4, "export_slots": 2, "pressure_cycles": 5,
           "slow_clients_each_cycle": 2, "slow_client_hold_seconds": 2,
           "export_rows": 8192, "export_payload_bytes_each": 1024,
           "scope": "Owned backend HTTP only; foreground ledger arrivals keep their unchanged SLOs. No public TLS/DNS/SMTP/OAuth or full matrix certification."}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def action_window(started, ended, phase_started, seconds):
    require(all(type(value) in {int, float} and math.isfinite(value)
                for value in [started, ended, phase_started, seconds])
            and 0 <= phase_started <= started <= ended and seconds > 0,
            'Invalid supplemental action timing')
    return {'started_after_seconds': started - phase_started,
            'ended_after_seconds': ended - phase_started,
            'duration_seconds': ended - started,
            'entire_action_within_offered_window': ended <= phase_started + seconds}


def failure_receipt(error, scenario):
    require(scenario in PROFILE["scenarios"], "Unknown failed supplemental scenario")
    locations = []
    for frame in traceback.extract_tb(error.__traceback__):
        name = Path(frame.filename).name
        if name in {"matrix_pressure.py", "fault_campaign.py", "auth_link_pressure.py"} and len(locations) < 8:
            locations.append({"file": name, "line": frame.lineno})
    return {"case": scenario, "type": type(error).__name__, "locations": locations}


def export_matches(label, rows):
    if not isinstance(rows, list) or len(rows) != 1000:
        return False
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"id", "name", "stock"} or type(row["id"]) is not int:
            return False
        identity = row["id"]
        if not 1 <= identity <= 1000 or row["name"] != label + ":" + str(identity):
            return False
        if type(row["stock"]) is not int or row["stock"] != identity % 50:
            return False
    return len({row["id"] for row in rows}) == 1000


class Probes:
    def __init__(self, project, output, guard):
        address = urllib.parse.urlsplit(project.base)
        require(address.scheme == "http" and address.hostname == "127.0.0.1" and address.port is not None
                and address.username is None and address.password is None and not address.path
                and not address.query and not address.fragment, "Probe requires the owned loopback backend")
        self.project, self.output, self.guard = project, output, guard
        self.host, self.port = address.hostname, address.port
        self.lock = threading.Lock()
        self.requests = self.consumed_bytes = self.unread_export_bytes = 0

    def admit(self):
        self.guard()
        with self.lock:
            require(self.requests < PROFILE["maximum_requests"], "Probe request count exceeded its ceiling")
            self.requests += 1

    def open(self, method, path, body=None, *, panel=False, service=False, headers=None):
        self.guard()
        require(method in {"GET", "POST"} and path.startswith("/") and not path.startswith("//")
                and path.isascii() and not any(char in path for char in "\r\n"), "Invalid bounded probe request")
        data = body
        if body is not None and not isinstance(body, bytes):
            data = json.dumps(body, allow_nan=False).encode()
        require(data is None or len(data) <= PROFILE["maximum_body_bytes"], "Probe request body exceeded its ceiling")
        self.admit()
        values = {"Content-Type": "application/json", **(headers or {})}
        if panel:
            values.update(Cookie=self.project.fixture["cookie"], Origin=self.project.base)
        if service:
            values["Authorization"] = "Bearer " + self.project.fixture["service"]
        connection = http.client.HTTPConnection(self.host, self.port, timeout=PROFILE["request_timeout_seconds"])
        try:
            connection.request(method, path, body=data, headers=values)
        except BaseException:
            connection.close()
            raise
        return connection

    def read(self, method, path, body=None, **options):
        connection = self.open(method, path, body, **options)
        response = None
        try:
            response = connection.getresponse()
            payload = response.read(PROFILE["maximum_read_bytes"] + 1)
            require(len(payload) <= PROFILE["maximum_read_bytes"], "Probe response exceeded its ceiling")
            with self.lock:
                self.consumed_bytes += len(payload)
                require(self.consumed_bytes <= PROFILE["maximum_consumed_bytes"], "Probe consumed-byte ceiling reached")
            return response.status, payload
        finally:
            if response is not None:
                response.close()
            connection.close()

    def json(self, method, path, body=None, **options):
        status, payload = self.read(method, path, body, **options)
        return status, json.loads(payload)

    def sql(self, statement):
        status, value = self.json("POST", "/admin/api/sql", {"sql": statement}, panel=True)
        require(status == 200 and "results" in value and "error" not in value, "Administrative SQL did not complete")
        return value

    def wait_connections(self, application, count, seconds):
        require(application in {"nelcota-admin-sql", "nelcota-admin-export"} and type(count) is int
                and 0 <= count <= 4, "Invalid owned connection census")
        began = time.monotonic()
        while True:
            self.guard()
            actual = int(self.project.sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='" + application + "'"))
            elapsed = time.monotonic() - began
            require(elapsed <= seconds, "Administrative connection release/admission deadline exceeded")
            if actual == count:
                return elapsed
            time.sleep(.025)

    def retain(self, name, values):
        self.guard()
        atomic_json(self.output / ("matrix-" + name + "-probes.json"),
                    {"status": "passed", "requests_so_far": self.requests,
                     "consumed_bytes_so_far": self.consumed_bytes,
                     "unread_export_upper_bound_bytes": self.unread_export_bytes, **values})

    def auth_links(self):
        from auth_link_pressure import run
        run(self)

    def admin_budgets(self):
        value = self.sql("SELECT i FROM generate_series(1,10000)i")
        first = value["results"][0]
        require(len(first["rows"]) == 1000 and first["count"] == 10000 and first["truncated"] is True,
                "SQL row truncation did not retain its actual count")
        table = "matrix_batch_" + secrets.token_hex(8)
        value = self.sql("SELECT 1;" * 35 + "CREATE TABLE public." + table + "(id int PRIMARY KEY); INSERT INTO public." + table + " VALUES(7)")
        require(len(value["results"]) == 32 and value["results_truncated"] is True
                and self.project.sql("SELECT count(*) FROM public." + table + " WHERE id=7") == "1",
                "SQL batch response truncation changed committed work")
        rejected = 0
        for _ in range(PROFILE["pressure_cycles"]):
            with ThreadPoolExecutor(max_workers=4) as pool:
                pending = [pool.submit(self.sql, "SELECT pg_sleep(1)") for _ in range(PROFILE["sql_slots"])]
                self.wait_connections("nelcota-admin-sql", 4, 3)
                status, response = self.json("POST", "/admin/api/sql", {"sql": "SELECT 1"}, panel=True)
                require(status == 503 and response.get("code") == "sql_busy", "SQL admission did not reject the fifth query")
                rejected += 1
                for future in pending:
                    future.result(timeout=5)
            self.wait_connections("nelcota-admin-sql", 0, PROFILE["query_release_seconds"])
        self.retain("admin-budgets", {"row_count": 10000, "returned_rows": 1000,
                    "batch_results": 32, "later_mutation_count": 1, "sql_busy_rejections": rejected})

    def admin_cancellation(self):
        cancelled, queries, exports = 0, [], []
        table = "matrix_export_" + secrets.token_hex(8)
        self.sql("CREATE TABLE public." + table + "(id integer PRIMARY KEY,payload text); INSERT INTO public." + table
                 + " SELECT i,repeat('x',1024) FROM generate_series(1,8192)i; NOTIFY nelcota,'reload schema'")
        self.wait_table(table)
        for _ in range(PROFILE["pressure_cycles"]):
            connection = self.open("POST", "/admin/api/sql", {"sql": "SELECT pg_sleep(20)"}, panel=True)
            try:
                self.wait_connections("nelcota-admin-sql", 1, 3)
            finally:
                connection.close()
            cancelled += 1
            queries.append(self.wait_connections("nelcota-admin-sql", 0, PROFILE["query_release_seconds"]))
            opened, responses = [], []
            try:
                for _ in range(PROFILE["export_slots"]):
                    with self.lock:
                        self.unread_export_bytes += PROFILE["export_rows"] * (PROFILE["export_payload_bytes_each"] + 128)
                        require(self.unread_export_bytes <= PROFILE["maximum_unread_export_bytes"], "Unread export traffic bound reached")
                    connection = self.open("GET", "/admin/api/tables/" + table + "/export?format=json", panel=True)
                    opened.append(connection)
                    response = connection.getresponse()
                    responses.append(response)
                    require(response.status == 200, "Owned unpolled export did not start")
                self.wait_connections("nelcota-admin-export", 2, 3)
                status, response = self.json("GET", "/admin/api/tables/" + table + "/export?format=json", panel=True)
                require(status == 503 and response.get("code") == "export_busy", "Export admission did not reject its third consumer")
            finally:
                for response in responses:
                    response.close()
                for connection in opened:
                    connection.close()
            exports.append(self.wait_connections("nelcota-admin-export", 0, PROFILE["export_release_seconds"]))
        status, value = self.json("GET", "/admin/api/tables/bench_products/export?format=json", panel=True)
        require(status == 200 and export_matches(self.project.label, value), "Complete export has missing, repeated or changed rows")
        self.retain("admin-cancellation", {"cancelled_queries": cancelled, "intentionally_unconsumed_exports": len(exports) * 2,
                    "query_release_seconds": queries, "export_release_seconds": exports,
                    "complete_export_rows": len(value), "complete_export_exact_fixture_match": True,
                    "interrupted_exports_claimed_complete": 0})

    def wait_table(self, table):
        require(re.fullmatch(r"matrix_[a-z]+_[0-9a-f]{16}", table) is not None, "Invalid owned catalog fixture name")
        began = time.monotonic()
        while True:
            status, value = self.json("GET", "/admin/api/tables", panel=True)
            require(status == 200, "Catalog introspection failed")
            elapsed = time.monotonic() - began
            require(elapsed <= PROFILE["catalog_recovery_seconds"], "Catalog did not discover committed DDL")
            if any(row["name"] == table for row in value["tables"]):
                return elapsed
            time.sleep(.1)

    def catalog_recovery(self):
        recovered = []
        for index in range(20):
            table = "matrix_catalog_" + secrets.token_hex(8)
            self.sql("CREATE TABLE public." + table + "(id integer PRIMARY KEY); INSERT INTO public." + table
                     + " VALUES(" + str(index) + "); GRANT SELECT ON public." + table + " TO service_role; NOTIFY nelcota,'reload schema'")
            with ThreadPoolExecutor(max_workers=4) as pool:
                pending = [pool.submit(self.json, "GET", "/admin/api/tables", panel=True) for _ in range(4)]
                recovered.append(self.wait_table(table))
                for future in pending:
                    require(future.result(timeout=5)[0] == 200, "Concurrent catalog introspection failed")
            status, value = self.json("GET", "/rest/v1/" + table, service=True)
            require(status == 200 and value == [{"id": index}] and self.project.sql("SELECT count(*) FROM public." + table) == "1",
                    "Committed catalog mutation was missing or repeated")
        self.retain("catalog-recovery", {"committed_tables": len(recovered), "mutation_retries": 0,
                    "catalog_discovery_seconds": recovered, "scope": "Concurrent introspection and committed DDL discovery; forced refresh failure remains covered only by its functional regression."})

    def slow_header_body_pair(self):
        slow = []
        try:
            for prefix in [b"GET /rest/v1/bench_products HTTP/1.1\r\nHost: 127.0.0.1\r\n",
                           b"POST /auth/v1/signup HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 512\r\n\r\n{\"email\""]:
                self.admit()
                connection = socket.create_connection((self.host, self.port), timeout=2)
                slow.append(connection)
                connection.sendall(prefix)
            held_at = time.monotonic()
            while time.monotonic() - held_at < PROFILE["slow_client_hold_seconds"]:
                self.guard()
                time.sleep(.1)
        finally:
            for connection in slow:
                connection.close()

    def hostile_backend(self):
        rejections = {}
        for label, body, expected in [("malformed", b'{"email":', {400}),
                                      ("nonfinite", b'{"email":NaN,"password":null}', {400, 422}),
                                      ("null", b'{"email":null,"password":null}', {422}),
                                      ("deep", b'[' * 256 + b'0' + b']' * 256, {400, 422})]:
            status, _ = self.read("POST", "/auth/v1/signup", body)
            require(status in expected, "Malformed authentication body was not rejected as declared")
            rejections[label] = status
        for label, headers in [("missing-cookie", {"Origin": self.project.base}),
                               ("wrong-origin", {"Cookie": self.project.fixture["cookie"], "Origin": "https://untrusted.example.test"})]:
            status, _ = self.read("POST", "/admin/api/sql", {"sql": "SELECT 1"}, headers=headers)
            require(status in {401, 403}, "Unauthorized administrative mutation was accepted")
            rejections[label] = status
        for _ in range(PROFILE["pressure_cycles"]):
            self.slow_header_body_pair()
            status, body = self.read("GET", "/rest/v1/bench_products?limit=1", headers={"Authorization": "Bearer " + self.project.fixture["invalid_access"]})
            require(status == 401 and b"postgres://" not in body and self.project.password.encode() not in body,
                    "Invalid JWT exposed data or failed authorization")
            status, value = self.json("GET", "/rest/v1/bench_products?limit=1", service=True)
            require(status == 200 and len(value) == 1 and value[0]["name"].startswith(self.project.label + ":"),
                    "Positive API canary failed after hostile input")
        self.retain("hostile-backend", {"rejections": rejections, "positive_negative_canary_pairs": PROFILE["pressure_cycles"],
                    "closed_slow_header_body_clients": PROFILE["pressure_cycles"] * PROFILE["slow_clients_each_cycle"],
                    "scope": "Bounded malformed JSON, nonfinite/null/deep bodies, two-second partial headers/bodies, admin cookie/origin and JWT rejection; no public-ingress or complete adversarial-matrix certification."})
