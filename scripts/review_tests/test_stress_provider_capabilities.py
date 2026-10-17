"""The private provider receiver rejects foreign senders before retaining data."""

import http.client
import base64
from contextlib import redirect_stdout
import gzip
import hashlib
import io
import json
from pathlib import Path
import secrets
import sys
import threading
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
from provider_capabilities import Receiver, allocator_capabilities, publish, write_public_report
from test_stress_otlp_metrics import attribute, export


class PrivateProviderReceiver(unittest.TestCase):
    def setUp(self):
        self.token = secrets.token_hex(32)
        self.server = Receiver(("127.0.0.1", 0), self.token)
        self.server.peer = "127.0.0.1"
        self.worker = threading.Thread(target=self.server.serve_forever)
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=2)
        self.assertFalse(self.worker.is_alive())

    def send(self, body, token):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        try:
            connection.request("POST", "/v1/metrics", body=body, headers={
                "X-G05-Probe": token, "Content-Type": "application/x-protobuf"})
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    def test_wrong_nonce_and_foreign_peer_cannot_change_evidence(self):
        self.assertEqual(self.send(export(1024), secrets.token_hex(32)), 403)
        self.assertEqual(self.send(export(1024), "\xff"), 403)
        self.server.peer = "127.0.0.2"
        self.assertEqual(self.send(export(1024), self.token), 403)
        self.assertEqual(self.server.exports, 0)
        self.assertIsNone(self.server.first)
        self.assertIsNone(self.server.failure)

    def test_typed_export_is_retained_without_private_labels_and_bad_wire_fails(self):
        body = export(4096, fields=attribute("Authorization", "must-not-publish"))
        self.assertEqual(self.send(body, self.token), 200)
        self.assertEqual(self.server.exports, 1)
        self.assertEqual(self.server.last["points"][0]["value"], 4096)
        self.assertNotIn("must-not-publish", json.dumps(self.server.last))
        self.assertEqual(self.send(b"\x0a\x7f", self.token), 400)
        self.assertEqual(self.server.exports, 1)
        self.assertEqual(self.server.failure, {"type": "ValueError", "reason": "Truncated OTLP field"})


class ProviderPublication(unittest.TestCase):
    def test_root_controller_publishes_only_validated_runner_readable_evidence(self):
        report = {"identity": "native-provider-123-1", "source": "1" * 40, "status": "blocked",
                  "certifies_g05": False, "cleanup_confirmed": True}
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "public"
            write_public_report(directory, report)
            path = directory / "provider-capabilities.json"
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
            self.assertEqual(json.loads(path.read_text()), report)
            denied = Path(root) / "denied"
            with self.assertRaisesRegex(RuntimeError, "Unknown provider"):
                write_public_report(denied, {"private_environment": "must-not-publish"})
            self.assertFalse(denied.exists())

    def test_real_provider_metric_prefix_and_availability_are_distinct(self):
        def point(name, value, *, available=True):
            return {"name": name, "value": value, "available": available, "kind": "gauge"}
        points = [point("rustfs_memory_allocator_committed_bytes", 150601728),
                  point("rustfs_memory_allocator_malloc_requested_bytes_available", 0),
                  point("rustfs_memory_allocator_malloc_requested_total_bytes", 87361616),
                  point("rustfs_memory_allocator_reserved_bytes", None, available=False)]
        result = allocator_capabilities(points)
        self.assertEqual(result["numeric_points"], 3)
        self.assertEqual(result["memory_gauges_observed"], ["rustfs_memory_allocator_committed_bytes"])
        self.assertIs(result["requested_bytes_available"], False)
        self.assertEqual(result["live_owner_release"], "not verified")
        self.assertIsNone(allocator_capabilities([])["requested_bytes_available"])

    def test_lossless_compressed_notices_stay_within_both_actions_limits(self):
        report = {"identity": "native-provider-123-1", "source": "1" * 40, "status": "blocked",
                  "certifies_g05": False, "cleanup_confirmed": True,
                  "scope": "\n".join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(300))}
        output = io.StringIO()
        with redirect_stdout(output):
            publish(report)
        lines = output.getvalue().splitlines()
        self.assertLessEqual(len(lines), 10)
        parts = []
        for line in lines:
            self.assertLessEqual(len(line.encode()), 4000)
            value = json.loads(line.split("::", 2)[2].replace("%0A", "\n").replace("%0D", "\r").replace("%25", "%"))
            if "payload" in value:
                parts.append(value)
        content = gzip.decompress(base64.b64decode("".join(value["payload"] for value in parts), validate=True))
        self.assertEqual(hashlib.sha256(content).hexdigest(), parts[0]["sha256"])
        self.assertEqual(json.loads(content), report)

    def test_unknown_private_fields_are_rejected_before_publication(self):
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(RuntimeError, "Unknown provider"):
            publish({"private_environment": "must-not-publish"})
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
