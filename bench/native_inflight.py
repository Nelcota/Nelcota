"""A bounded table-lock witness for one interrupted write in an owned VM.

This control demonstrates rollback of a write blocked before COMMIT. It does
not simulate physical host power loss or a cut during a commit flush.
"""
import json
import re
import time

from native_guest import command, owned, require, sql, unit_state

APPLICATION = "g05-native-inflight-lock"
HOLD_SECONDS = 30
RUNTIME_SECONDS = 40
OBSERVATION_SECONDS = 3


def identity(value):
    require(isinstance(value, str) and re.fullmatch(r"native-vm-[a-z0-9-]{1,64}", value) is not None,
            "Invalid interrupted-write VM identity")
    return "g05-inflight-" + value + ".service"


def census():
    value = sql("SELECT json_build_object('lockers',count(*) FILTER(WHERE a.application_name='"
                + APPLICATION + "' AND l.mode='ShareLock' AND l.granted),"
                "'waiting_writes',count(*) FILTER(WHERE l.mode='RowExclusiveLock' AND NOT l.granted)) "
                "FROM pg_locks l JOIN pg_stat_activity a USING(pid) "
                "WHERE a.datname=current_database() AND l.relation='public.native_probe'::regclass;\n")
    result = json.loads(value)
    require(isinstance(result, dict) and set(result) == {"lockers", "waiting_writes"}
            and all(type(count) is int and 0 <= count <= 1 for count in result.values()),
            "Interrupted-write lock census is ambiguous")
    return result


def checked_unit(value, *, active=False):
    name = identity(value)
    state = unit_state(name)
    # An inactive transient unit may already have been collected by systemd.
    if state.get("LoadState") == "not-found":
        require(not active, "Interrupted-write helper disappeared")
        return state
    description = command(["systemctl", "show", name, "--property=Description", "--value"]).stdout.decode().strip()
    require(description == "g05-inflight:" + value, "Refusing a foreign interrupted-write helper")
    if active:
        require(state.get("ActiveState") == "active", "Interrupted-write helper is not active")
        budget = state.get("kernel_budget", {})
        require(all(type(budget.get(key)) is int for key in
                    ["cpu_quota_usec", "cpu_period_usec", "memory_bytes", "swap_bytes", "pids"])
                and budget.get("cpu_quota_usec") == 5000 and budget.get("cpu_period_usec") == 100000
                and budget.get("memory_bytes") == 48 * 1024 ** 2
                and budget.get("swap_bytes") == 0 and budget.get("pids") == 16,
                "Interrupted-write helper escaped its kernel budget")
        require(state.get("memory_events", {}).get("oom_kill") == 0,
                "Interrupted-write helper was OOM killed")
    return state


def disarm(value):
    owned(value)
    state = checked_unit(value)
    if state.get("LoadState") != "not-found":
        command(["systemctl", "stop", identity(value)], timeout=8)
    # A disconnected psql can leave pg_sleep running until its statement
    # deadline. Cancel only this owned marker/table's one lock holder.
    sql("SELECT pg_cancel_backend(a.pid) FROM pg_stat_activity a JOIN pg_locks l USING(pid) "
        "WHERE a.datname=current_database() AND a.application_name='" + APPLICATION
        + "' AND l.relation='public.native_probe'::regclass AND l.mode='ShareLock' AND l.granted;\n")
    began = time.monotonic()
    while time.monotonic() - began <= OBSERVATION_SECONDS:
        result = census()
        if result == {"lockers": 0, "waiting_writes": 0}:
            return {"status": "passed", **result}
        time.sleep(.025)
    raise RuntimeError("Interrupted-write helper or request did not drain")


def hold(value):
    owned(value)
    sql("SET application_name='" + APPLICATION + "'; BEGIN; "
        "SET LOCAL statement_timeout='35s'; SET LOCAL lock_timeout='2s'; "
        "LOCK TABLE public.native_probe IN SHARE MODE; SELECT pg_sleep("
        + str(HOLD_SECONDS) + "); ROLLBACK;\n")
    return {"status": "expired normally"}


def arm(value):
    owned(value)
    name = identity(value)
    require(unit_state(name).get("LoadState") == "not-found", "Interrupted-write helper already exists")
    require(census() == {"lockers": 0, "waiting_writes": 0}, "Table already has interrupted-write owners")
    try:
        command(["systemd-run", "--unit=" + name, "--description=g05-inflight:" + value,
                 "--collect", "--slice=g05native.slice", "--property=CPUQuota=5%",
                 "--property=CPUQuotaPeriodSec=100ms", "--property=MemoryMax=48M",
                 "--property=MemorySwapMax=0", "--property=TasksMax=16",
                 "--property=Nice=19", "--property=IOSchedulingClass=idle",
                 "--property=RuntimeMaxSec=" + str(RUNTIME_SECONDS), "--property=KillMode=control-group",
                 "--property=TimeoutStopSec=5", "--", "/usr/bin/python3", "/opt/g05-tools/native_guest.py",
                 value, "inflight-hold"], timeout=8)
        began = time.monotonic()
        while time.monotonic() - began <= OBSERVATION_SECONDS:
            state = checked_unit(value, active=True)
            result = census()
            if result == {"lockers": 1, "waiting_writes": 0}:
                return {"status": "armed", **result, "maximum_hold_seconds": HOLD_SECONDS,
                        "runtime_maximum_seconds": RUNTIME_SECONDS, "kernel_budget": state["kernel_budget"]}
            time.sleep(.025)
        raise RuntimeError("Interrupted-write helper did not acquire its bounded table lock")
    except BaseException:
        disarm(value)
        raise


def status(value):
    owned(value)
    state = checked_unit(value)
    result = census()
    if result["lockers"]:
        checked_unit(value, active=True)
    return {**result, "helper_active": state.get("ActiveState") == "active"}


def run(value, action):
    handlers = {"inflight-arm": arm, "inflight-hold": hold,
                "inflight-status": status, "inflight-disarm": disarm}
    require(action in handlers, "Unknown interrupted-write action")
    return handlers[action](value)
