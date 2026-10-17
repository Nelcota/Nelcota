"""Strict witnesses for a VM cut with one blocked, unacknowledged write."""
import math
import time

MAXIMUM_OBSERVATION_AGE_SECONDS = 2
BLOCKED_ID = 999


def capture(read_status):
    # Conservatively include SSH, SQL and response transport in witness age.
    started = time.monotonic()
    return read_status(), started


def witness(value, age, completed):
    if (not isinstance(value, dict) or value != {"lockers": 1, "waiting_writes": 1, "helper_active": True}
            or any(type(value.get(key)) is not int for key in ["lockers", "waiting_writes"])
            or type(value.get("helper_active")) is not bool or completed is not False
            or type(age) not in {int, float} or not math.isfinite(age)
            or not 0 <= age <= MAXIMUM_OBSERVATION_AGE_SECONDS):
        raise RuntimeError("No fresh in-flight write witness before the owned VM cut")
    return {"lockers": 1, "waiting_writes": 1, "helper_active": True,
            "observation_age_before_signal_request_seconds": age,
            "maximum_observation_age_seconds": MAXIMUM_OBSERVATION_AGE_SECONDS,
            "scope": "Request blocked on an owned table lock before COMMIT; no commit-flush or physical host power-loss claim"}


def reconcile(rows, acknowledged):
    if (not isinstance(acknowledged, list) or acknowledged != list(range(100, 130))
            or any(type(value) is not int for value in acknowledged)):
        raise RuntimeError("Missing original thirty externally durable acknowledgements")
    expected = [1, *acknowledged]
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise RuntimeError("Cut lost acknowledged rows or retained an uncommitted/unknown row")
    for row, identity in zip(rows, expected):
        if (not isinstance(row, dict) or set(row) != {"id", "value"}
                or any(type(row.get(key)) is not int for key in ["id", "value"])
                or row["id"] != identity or row["value"] != identity):
            raise RuntimeError("Cut changed, duplicated, reordered or exposed an unknown row")
    return {"acknowledged": len(acknowledged), "verified_row_values": len(rows),
            "missing": 0, "duplicate": 0, "extra": 0,
            "blocked_unacknowledged_writes": 1, "blocked_write_visible_after_recovery": False}
