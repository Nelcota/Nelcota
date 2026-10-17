"""Bounded provider observations never invent zero or publish private labels."""

import gzip
import json
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
import otlp_metrics


def integer(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def message(identity, value):
    return integer(identity * 8 + 2) + integer(len(value)) + value


def attribute(key, value):
    return message(7, message(1, key.encode()) + message(2, message(1, value.encode())))


def export(number, *, fields=b"", value_kind=4, metric=b"rustfs_allocator_requested_bytes", metric_kind=5):
    point = integer(value_kind * 8 + 1) + struct.pack({4: "<d", 6: "<q"}[value_kind], number) + fields
    return message(1, message(2, message(2, message(1, metric) + message(metric_kind, message(1, point)))))


class OTLPProviderEvidence(unittest.TestCase):
    def test_actual_wire_subset_retains_typed_values_without_private_attributes(self):
        body = export(1024, fields=attribute("backend", "mimalloc") + attribute("Authorization", "must-never-publish"))
        values = otlp_metrics.memory_points(gzip.compress(body), "gzip")
        self.assertEqual(values, [{"name": "rustfs_allocator_requested_bytes", "kind": "gauge",
                                   "attributes": {"backend": "mimalloc"}, "available": True, "value": 1024}])
        self.assertNotIn("must-never-publish", json.dumps(values))

    def test_signed_integer_and_sum_stay_distinct_from_a_live_gauge(self):
        values = otlp_metrics.memory_points(export(64, value_kind=6, metric_kind=7))
        self.assertEqual(values[0]["value"], 64)
        self.assertEqual(values[0]["kind"], "sum")

    def test_unavailable_values_are_null_instead_of_fabricated_zero(self):
        values = otlp_metrics.memory_points(export(0, fields=integer(8 * 8) + integer(1)))
        self.assertFalse(values[0]["available"])
        self.assertIsNone(values[0]["value"])
        self.assertEqual(otlp_metrics.memory_points(b""), [])

    def test_nonfinite_negative_and_ambiguous_values_are_rejected(self):
        for value in [float("nan"), float("inf"), -1, 2 ** 54]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                otlp_metrics.memory_points(export(value))
        duplicate = integer(6 * 8 + 1) + struct.pack("<q", 128)
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            otlp_metrics.memory_points(export(64, fields=duplicate))

    def test_compressed_and_wire_budgets_reject_trailing_or_truncated_input(self):
        body = gzip.compress(export(1))
        for value in [body[:-1], body + b"trailing", gzip.compress(b"x" * (otlp_metrics.MAX_DECODED + 1))]:
            with self.subTest(size=len(value)), self.assertRaises(ValueError):
                otlp_metrics.memory_points(value, "gzip")
        for value in [b"\x80", b"\x0a\x7f", b"\x0b", b"\x00"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                otlp_metrics.memory_points(value)

    def test_unrelated_metrics_do_not_expand_the_published_inventory(self):
        self.assertEqual(otlp_metrics.memory_points(export(1, metric=b"unrelated_requests")), [])
        with self.assertRaisesRegex(ValueError, "point inventory"):
            point = message(1, integer(4 * 8 + 1) + struct.pack("<d", 1))
            gauge = point * (otlp_metrics.MAX_POINTS + 1)
            metric = message(1, b"rustfs_allocator_requested_bytes") + message(5, gauge)
            otlp_metrics.memory_points(message(1, message(2, message(2, metric))))


if __name__ == "__main__":
    unittest.main()
