"""Bounded private-file fences for fresh independent project campaigns.

Auxiliary HTTP is counted separately from k6 useful work. Only owned loopback
backends are contacted; no bearer, body, object version or SQL is published.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from http_boundary import ledger_opener
from watchdog import atomic_json

PROTOCOL = "g05-private-project-files-v1"
BUCKET = "g05-isolation"
PATH = "/storage/v1/object/" + BUCKET + "/fixture.bin"
PROFILE = {"enabled": True, "protocol": PROTOCOL, "maximum_requests": 8192,
           "maximum_requests_per_second": 64, "request_timeout_seconds": 2,
           "maximum_body_bytes": 128, "maximum_read_bytes": 2048,
           "maximum_header_bytes": 16384, "maximum_logical_HTTP_bytes": 128 * 1024 ** 2,
           "maximum_graph_seconds": 20,
           "extra_controller_threads_during_graph": 1,
           "minimum_foreground_seconds": 60,
           "controller_affinity_policy": "one telemetry/OS slot, disjoint from app/PostgreSQL/k6",
           "transport": "owned direct loopback HTTP; main k6 ingress unchanged",
           "units": "auxiliary requests excluded from k6 useful throughput and latency"}
DISABLED = {"enabled": False, "protocol": None}
COUNTS = ("projects", "directed_pairs", "foreign_reads_rejected", "foreign_writes_rejected",
          "owner_bytes_verified", "anonymous_private_reads_rejected", "metadata_objects_unchanged", "requests")
FIELDS = {"status", "protocol", "counts", "elapsed_seconds", "requests_total", "logical_HTTP_bytes_total",
          "in_offered_window", "foreground_iterations_observed_before", "action_window", "run_id", "phase",
          "minimum_response_gap_seconds"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def checked_profile(value):
    if value == DISABLED and value.get("enabled") is False and set(value) == set(DISABLED):
        return value
    require(isinstance(value, dict) and value.get("enabled") is True and value == PROFILE
            and all(type(value.get(key)) is int for key in PROFILE if type(PROFILE[key]) is int),
            "Invalid private-file isolation profile")
    return value


def expected_counts(projects):
    require(type(projects) is int and projects in {1, 5, 10}, "Unknown private-file topology")
    pairs = projects * (projects - 1)
    return {"projects": projects, "directed_pairs": pairs,
            "foreign_reads_rejected": pairs, "foreign_writes_rejected": pairs,
            "owner_bytes_verified": projects + pairs, "anonymous_private_reads_rejected": projects + pairs,
            "metadata_objects_unchanged": projects, "requests": 2 * projects + 4 * pairs}


def validate_receipt(value, projects, *, during_load, run_id=None, phase=None):
    fields = FIELDS
    if not during_load:
        fields = FIELDS - {"foreground_iterations_observed_before", "action_window"}
    require(isinstance(value, dict) and set(value) == fields and value.get("status") == "passed"
            and value.get("protocol") == PROTOCOL, "Missing private-file isolation receipt")
    for key, expected in [("run_id", run_id), ("phase", phase)]:
        require(isinstance(value.get(key), str) and re.fullmatch(r"[a-z][a-z0-9-]{0,79}", value[key]) is not None
                and (expected is None or value[key] == expected), "Private-file receipt belongs to another run or phase")
    counts = value.get("counts")
    require(isinstance(counts, dict) and counts == expected_counts(projects)
            and all(type(counts.get(key)) is int for key in COUNTS), "Incomplete directed private-file graph")
    elapsed = value.get("elapsed_seconds")
    gap = value.get("minimum_response_gap_seconds")
    require(type(elapsed) in {int, float} and math.isfinite(elapsed)
            and 0 < elapsed <= PROFILE["maximum_graph_seconds"], "Private-file graph exceeded its deadline")
    require(type(gap) in {int, float} and math.isfinite(gap)
            and gap + .000001 >= 1 / PROFILE["maximum_requests_per_second"]
            and elapsed + .001 >= (counts["requests"] - 1) * gap,
            "Private-file traffic lacks a consistent bounded inter-request gap")
    for key, limit in [("requests_total", PROFILE["maximum_requests"]),
                       ("logical_HTTP_bytes_total", PROFILE["maximum_logical_HTTP_bytes"])]:
        require(type(value.get(key)) is int and 0 < value[key] <= limit,
                "Missing bounded private-file accounting")
    require(value["requests_total"] >= counts["requests"] and type(value.get("in_offered_window")) is bool,
            "Private-file request accounting is inconsistent")
    if during_load:
        positive = value.get("foreground_iterations_observed_before")
        window = value.get("action_window")
        require(value["in_offered_window"] is True and type(positive) in {int, float}
                and math.isfinite(positive) and positive > 0 and isinstance(window, dict),
                "Private-file graph was not preceded by actual foreground work")
        require(set(window) == {"started_after_seconds", "ended_after_seconds", "duration_seconds", "entire_action_within_offered_window"},
                "Unexpected private-file action fields")
        times = [window.get(key) for key in ["started_after_seconds", "ended_after_seconds", "duration_seconds"]]
        require(all(type(item) in {int, float} and math.isfinite(item) and item >= 0 for item in times)
                and times[0] <= times[1] and abs(times[1] - times[0] - times[2]) <= .001
                and abs(times[2] - elapsed) <= .001
                and window.get("entire_action_within_offered_window") is True,
                "Private-file graph escaped its foreground interval")
    if not during_load:
        require(value["in_offered_window"] is False, "Preparation cannot substitute for offered traffic")
    return value


def read_receipt(path):
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 65536,
            "Missing bounded private-file evidence")
    return json.loads(path.read_text())


def validate_run(root, profile, ledger):
    value = checked_profile(profile.get("private_file_isolation", DISABLED))
    if value["enabled"] is False:
        return
    count = profile["projects"]
    expected_counts(count)
    cpu = profile.get("private_file_controller_cpu_affinity")
    require(type(cpu) is int and cpu == profile.get("metrics_cpu_affinity")
            and isinstance(profile.get("cpu_affinity"), list) and cpu not in profile["cpu_affinity"],
            "Private-file auxiliary traffic shares a target or k6 CPU slot")
    require(type(profile.get("capacity_qualification")) is bool and isinstance(profile.get("ingress"), dict),
            "Private-file profile lacks declared phase geometry")
    required = {"balanced-1", "balanced-2", "balanced-3"}
    if count > 1:
        required.update({"noisy-mixed", "noisy-login", "noisy-read", "noisy-storage", "noisy-write"})
    if profile["capacity_qualification"]:
        required.update({"capacity-25", "capacity-50", "capacity-75", "capacity-100"})
    ingress = profile["ingress"].get("kind")
    require(ingress in {"direct loopback HTTP", "real Caddy with verified internal CA on loopback"},
            "Unknown private-file ingress geometry")
    if ingress == "real Caddy with verified internal CA on loopback":
        required.add("proxy-reload")
    receipts = [validate_receipt(read_receipt(root / "private-isolation-before.json"), count,
                                 during_load=False, run_id=root.name, phase="before")]
    observed = set()
    for interval in ledger:
        seconds = interval.get("requested_seconds")
        require(type(seconds) is int and seconds > 0, "Invalid private-file traffic interval")
        if seconds < PROFILE["minimum_foreground_seconds"]:
            continue
        label = interval.get("phase")
        require(isinstance(label, str) and re.fullmatch(r"[a-z0-9-]{1,80}", label) is not None
                and interval.get("completed") is True and label in required and label not in observed,
                "Invalid, duplicate or unexpected private-file phase identity")
        observed.add(label)
        receipt = validate_receipt(read_receipt(root / ("private-isolation-" + label + ".json")), count,
                                   during_load=True, run_id=root.name, phase=label)
        require(receipt["action_window"]["ended_after_seconds"] <= seconds,
                "Private-file graph finished beyond its conservative offered window")
        receipts.append(receipt)
    require(observed == required, "Required private-file pressure phases are missing")
    receipts.append(validate_receipt(read_receipt(root / "private-isolation-after.json"), count,
                                      during_load=False, run_id=root.name, phase="after"))
    requests, logical_bytes = count, 0
    for receipt in receipts:
        requests += expected_counts(count)["requests"]
        require(receipt["requests_total"] == requests and receipt["logical_HTTP_bytes_total"] > logical_bytes,
                "Private-file cumulative evidence was reused, reset or reordered")
        logical_bytes = receipt["logical_HTTP_bytes_total"]


class PrivateFiles:
    def __init__(self, projects, output, guard, owns_listener, abort, *, clock=time.monotonic, sleep=time.sleep):
        expected_counts(len(projects))
        require([project.label for project in projects] == ["project-" + str(index) for index in range(len(projects))],
                "Private-file owners do not match the independent topology")
        require(re.fullmatch(r"[a-z][a-z0-9-]{0,79}", output.name) is not None, "Private-file run ID is not a bounded label")
        for project in projects:
            address = urllib.parse.urlsplit(project.base)
            require(address.scheme == "http" and address.hostname == "127.0.0.1" and address.port == project.port
                    and address.username is None and address.password is None and not address.path
                    and not address.query and not address.fragment, "Private-file target is not an owned loopback backend")
        self.projects, self.output, self.guard, self.listener = projects, output, guard, owns_listener
        require(callable(abort), "Private-file graph requires an owned traffic stop callback")
        self.abort = abort
        self.clock, self.sleep = clock, sleep
        self.requests = self.logical_bytes = 0
        self.next_request = 0
        self.last_response_at = self.minimum_response_gap = None
        self.expected = {}

    def body(self, project):
        return (project.label + ": private fixture").encode()

    def call(self, project, method, credential, body=None):
        self.guard()
        require(method in {"GET", "PUT"} and (body is None or type(body) is bytes and len(body) <= PROFILE["maximum_body_bytes"]),
                "Unbounded private-file request")
        require(self.requests < PROFILE["maximum_requests"], "Private-file request ceiling reached")
        delay = self.next_request - self.clock()
        if delay > 0:
            self.sleep(delay)
        self.guard()
        started = self.clock()
        if self.last_response_at is not None:
            gap = started - self.last_response_at
            require(gap + .000001 >= 1 / PROFILE["maximum_requests_per_second"],
                    "Private-file request pacing woke before its deadline")
            if self.minimum_response_gap is None or gap < self.minimum_response_gap:
                self.minimum_response_gap = gap
        self.requests += 1
        headers = {"Content-Type": "application/octet-stream", "Accept-Encoding": "identity"}
        if credential is not None:
            require(isinstance(credential, str) and 0 < len(credential) <= 4096
                    and not any(char in credential for char in "\r\n"), "Invalid private-file credential boundary")
            headers["Authorization"] = "Bearer " + credential
        outgoing = len(PATH) + len(body or b"") + sum(len(key) + len(value) + 4 for key, value in headers.items())
        maximum_response = PROFILE["maximum_header_bytes"] + PROFILE["maximum_read_bytes"]
        require(self.logical_bytes + outgoing + maximum_response <= PROFILE["maximum_logical_HTTP_bytes"],
                "Private-file logical byte reserve exhausted")
        self.logical_bytes += outgoing
        request = urllib.request.Request(project.base + PATH, data=body, headers=headers, method=method)
        response = None
        try:
            try:
                response = ledger_opener().open(request, timeout=PROFILE["request_timeout_seconds"])
            except urllib.error.HTTPError as rejected:
                response = rejected
            header_bytes = sum(len(key) + len(value) + 4 for key, value in response.headers.items())
            require(header_bytes <= PROFILE["maximum_header_bytes"], "Private-file response headers exceeded their ceiling")
            payload = response.read(PROFILE["maximum_read_bytes"] + 1)
            require(len(payload) <= PROFILE["maximum_read_bytes"], "Private-file response body exceeded its ceiling")
            self.logical_bytes += header_bytes + len(payload)
            require(self.logical_bytes <= PROFILE["maximum_logical_HTTP_bytes"], "Private-file logical byte ceiling reached")
            return response.code, payload
        finally:
            if response is not None:
                response.close()
            # Cool down after closing the actual response. Context creation or
            # another slow client step cannot turn the next request into a burst.
            self.last_response_at = self.clock()
            self.next_request = self.last_response_at + 1 / PROFILE["maximum_requests_per_second"]

    def metadata(self, project):
        rows = json.loads(project.sql("SELECT coalesce(json_agg(t),'[]'::json) FROM "
                          "(SELECT version::text,size,etag FROM storage.objects "
                          "WHERE bucket_id='g05-isolation' AND name='fixture.bin')t;"))
        require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict)
                and set(rows[0]) == {"version", "size", "etag"}, "Private-file metadata is missing or duplicated")
        row = rows[0]
        require(isinstance(row["version"], str) and str(uuid.UUID(row["version"])) == row["version"]
                and type(row["size"]) is int and row["size"] == len(self.body(project))
                and row["etag"] == hashlib.sha256(self.body(project)).hexdigest(), "Private-file metadata differs from owned bytes")
        return row

    def seed(self):
        for project in self.projects:
            self.guard()
            require(self.listener(project.docker.require(project.app), project.port), "Private-file listener ownership changed")
            require(project.sql("SELECT count(*) FROM storage.buckets WHERE id='g05-isolation';") == "0",
                    "Private-file fixture bucket already exists")
            project.sql("INSERT INTO storage.buckets(id,public) VALUES('g05-isolation',false);")
            status, _ = self.call(project, "PUT", project.fixture["service"], self.body(project))
            require(status == 201, "Private-file fixture was not created exactly once")
            self.expected[project.label] = self.metadata(project)

    def graph(self, label, *, phase_started=None, phase_seconds=None, foreground_iterations=None):
        require(isinstance(label, str) and re.fullmatch(r"[a-z0-9-]{1,80}", label) is not None,
                "Invalid private-file receipt label")
        began = self.clock()
        counts = {key: 0 for key in COUNTS}
        counts["projects"] = len(self.projects)
        before_requests = self.requests
        expired = threading.Event()

        def expire():
            expired.set()
            self.abort()

        timer = threading.Timer(PROFILE["maximum_graph_seconds"], expire)
        timer.daemon = True
        timer.start()

        def guard():
            self.guard()
            require(not expired.is_set() and self.clock() - began <= PROFILE["maximum_graph_seconds"],
                    "Private-file graph deadline reached")

        def owner_and_anonymous(project):
            guard()
            status, payload = self.call(project, "GET", project.fixture["service"])
            require(status == 200 and payload == self.body(project), "Private-file owner bytes changed or became inaccessible")
            counts["owner_bytes_verified"] += 1
            status, _ = self.call(project, "GET", None)
            require(status == 404, "Anonymous read exposed a private project file")
            counts["anonymous_private_reads_rejected"] += 1

        try:
            if phase_started is not None:
                require(type(phase_started) in {int, float} and math.isfinite(phase_started)
                        and 0 <= phase_started <= began and type(phase_seconds) is int
                        and PROFILE["minimum_foreground_seconds"] <= phase_seconds <= 300
                        and type(foreground_iterations) in {int, float} and math.isfinite(foreground_iterations)
                        and foreground_iterations > 0, "Invalid private-file foreground evidence before HTTP")
            if phase_started is None:
                require(phase_seconds is None and foreground_iterations is None,
                        "Preparation cannot carry unbound foreground evidence")
            for project in self.projects:
                guard()
                require(self.listener(project.docker.require(project.app), project.port), "Private-file listener ownership changed")
                owner_and_anonymous(project)
            for source in self.projects:
                for target in self.projects:
                    if source.label == target.label:
                        continue
                    guard()
                    status, _ = self.call(target, "GET", source.fixture["service"])
                    require(status == 401, "Foreign credential read a private project file")
                    counts["foreign_reads_rejected"] += 1
                    status, _ = self.call(target, "PUT", source.fixture["service"], b"foreign write must be rejected")
                    require(status == 401, "Foreign credential wrote a private project file")
                    counts["foreign_writes_rejected"] += 1
                    owner_and_anonymous(target)
                    counts["directed_pairs"] += 1
            for project in self.projects:
                guard()
                require(self.metadata(project) == self.expected.get(project.label), "Foreign work changed private-file metadata")
                counts["metadata_objects_unchanged"] += 1
            guard()
            ended = self.clock()
            counts["requests"] = self.requests - before_requests
            value = {"status": "passed", "protocol": PROTOCOL, "counts": counts, "elapsed_seconds": ended - began,
                     "requests_total": self.requests, "logical_HTTP_bytes_total": self.logical_bytes,
                     "in_offered_window": False, "run_id": self.output.name, "phase": label,
                     "minimum_response_gap_seconds": self.minimum_response_gap}
            if phase_started is not None:
                from matrix_pressure import action_window
                value.update(in_offered_window=True, foreground_iterations_observed_before=foreground_iterations,
                             action_window=action_window(began, ended, phase_started, phase_seconds))
                require(value["action_window"]["entire_action_within_offered_window"] is True,
                        "Private-file graph escaped its offered interval")
            validate_receipt(value, len(self.projects), during_load=phase_started is not None,
                             run_id=self.output.name, phase=label)
            atomic_json(self.output / ("private-isolation-" + label + ".json"), value)
            return value
        except BaseException as error:
            self.abort()
            atomic_json(self.output / ("private-isolation-" + label + ".json"),
                        {"status": "failed", "protocol": PROTOCOL, "failure_type": type(error).__name__,
                         "counts": counts, "requests_total": self.requests,
                         "logical_HTTP_bytes_total": self.logical_bytes, "run_id": self.output.name, "phase": label})
            raise
        finally:
            timer.cancel()
            timer.join(timeout=2)
            require(not timer.is_alive(), "Private-file graph watchdog did not release its thread")
