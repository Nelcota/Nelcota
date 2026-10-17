"""Bounded OTLP numeric memory observations, without exporting resource labels.

Decode only the standard Metric/Gauge/Sum/NumberDataPoint wire subset. This
development control does not infer live bytes from cumulative allocation totals.
"""

import math
import re
import struct
import zlib

MAX_BODY = 1024 ** 2
MAX_DECODED = 4 * MAX_BODY
MAX_FIELDS = 20000
MAX_POINTS = 512
PREFIXES = ("rustfs_allocator", "allocator_", "rustfs_memory", "rustfs_process_memory",
            "rustfs_cgroup_memory", "rustfs_object_data_cache", "process_memory")
ATTRIBUTE_KEYS = {"allocator", "backend", "kind", "statistic", "basis", "state"}
ATTRIBUTE_VALUES = {"mimalloc", "jemalloc", "system", "unknown", "current", "peak", "total",
                    "allocated", "reserved", "committed", "resident", "virtual", "used", "free",
                    "available", "unavailable", "host", "cgroup"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def decode_body(body, encoding):
    require(isinstance(body, bytes) and len(body) <= MAX_BODY, "OTLP body exceeded its budget")
    if not encoding:
        return body
    require(encoding == "gzip", "Unsupported OTLP content encoding")
    decoder = zlib.decompressobj(31)
    value = decoder.decompress(body, MAX_DECODED + 1)
    require(len(value) <= MAX_DECODED and decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data,
            "Incomplete, trailing or oversized OTLP gzip")
    return value


def varint(body, offset):
    value = 0
    for shift in range(0, 70, 7):
        require(offset < len(body), "Truncated OTLP varint")
        byte = body[offset]
        offset += 1
        require(shift != 63 or byte <= 1, "OTLP varint exceeds uint64")
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, offset
    raise ValueError("Unterminated OTLP varint")


def fields(body, budget):
    offset = 0
    result = []
    while offset < len(body):
        budget[0] += 1
        require(budget[0] <= MAX_FIELDS, "OTLP field inventory exceeded its budget")
        tag, offset = varint(body, offset)
        identity, wire = tag >> 3, tag & 7
        require(0 < identity < 2 ** 29, "Invalid OTLP field identity")
        if wire == 0:
            value, offset = varint(body, offset)
            result.append((identity, wire, value))
            continue
        if wire == 2:
            length, offset = varint(body, offset)
            require(length <= MAX_DECODED and length <= len(body) - offset, "Truncated OTLP field")
            result.append((identity, wire, body[offset:offset + length]))
            offset += length
            continue
        require(wire in {1, 5}, "Unsupported OTLP wire type")
        length = {1: 8, 5: 4}[wire]
        require(length <= len(body) - offset, "Truncated fixed-width OTLP value")
        result.append((identity, wire, body[offset:offset + length]))
        offset += length
    return result


def messages(values, identity):
    selected = [(wire, value) for key, wire, value in values if key == identity]
    require(all(wire == 2 for wire, _ in selected), "Wrong OTLP message wire type")
    return [value for _, value in selected]


def attributes(values, budget):
    result = {}
    entries = messages(values, 7)
    require(len(entries) <= 32, "OTLP attribute inventory exceeded its budget")
    for entry in entries:
        pairs = fields(entry, budget)
        keys, values = messages(pairs, 1), messages(pairs, 2)
        require(len(keys) == len(values) == 1, "Ambiguous OTLP attribute")
        key = keys[0].decode("utf-8")
        if key not in ATTRIBUTE_KEYS:
            continue
        strings = messages(fields(values[0], budget), 1)
        if len(strings) != 1:
            continue
        value = strings[0].decode("utf-8")
        if value not in ATTRIBUTE_VALUES:
            continue
        require(key not in result, "Duplicate OTLP attribute")
        result[key] = value
    return result


def point(body, budget, name, kind):
    values = fields(body, budget)
    flags = [(wire, value) for key, wire, value in values if key == 8]
    require(len(flags) <= 1 and all(wire == 0 for wire, _ in flags), "Invalid OTLP point flags")
    require(not flags or flags[0][1] in {0, 1}, "Unsupported OTLP point flags")
    unavailable = bool(flags and flags[0][1] & 1)
    numbers = [(key, wire, value) for key, wire, value in values if key in {4, 6}]
    require(len(numbers) <= 1, "Ambiguous OTLP numeric point")
    result = {"name": name, "kind": kind, "attributes": attributes(values, budget), "available": not unavailable}
    if unavailable:
        result["value"] = None
        return result
    require(len(numbers) == 1 and numbers[0][1] == 1, "Missing numeric OTLP point")
    key, _, raw = numbers[0]
    value = struct.unpack({4: "<d", 6: "<q"}[key], raw)[0]
    require(math.isfinite(value) and 0 <= value <= 2 ** 53, "Non-finite, negative or oversized OTLP value")
    result["value"] = value
    return result


def memory_points(body, encoding=""):
    decoded = decode_body(body, encoding)
    budget = [0]
    result = []
    for resource in messages(fields(decoded, budget), 1):
        for scope in messages(fields(resource, budget), 2):
            for metric in messages(fields(scope, budget), 2):
                values = fields(metric, budget)
                names = messages(values, 1)
                require(len(names) == 1 and len(names[0]) <= 128, "Missing or oversized OTLP metric name")
                name = names[0].decode("utf-8")
                require(re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.]{0,127}", name), "Invalid OTLP metric name")
                if not name.startswith(PREFIXES):
                    continue
                data = [(key, wire, value) for key, wire, value in values if key in {5, 7, 9, 10, 11}]
                require(len(data) == 1 and data[0][1] == 2, "Ambiguous OTLP metric data")
                key, _, payload = data[0]
                if key not in {5, 7}:
                    continue
                kind = {5: "gauge", 7: "sum"}[key]
                for value in messages(fields(payload, budget), 1):
                    require(len(result) < MAX_POINTS, "OTLP point inventory exceeded its budget")
                    result.append(point(value, budget, name, kind))
    return result
