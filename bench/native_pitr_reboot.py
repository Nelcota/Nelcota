"""Check boot-time fencing after a marker-only failed native restore."""
import math
import http.client
import json
import time

from native_pitr_failure import PG_UNIT, UNIT, fenced, helper_name
from native_guest import require

PROFILE = {"minimum_observation_seconds": 20, "maximum_observation_seconds": 50,
           "minimum_sample_gap_seconds": 1, "maximum_samples": 22,
           "maximum_guest_resource_request_seconds": 12,
           "maximum_authenticated_HTTP_seconds": 5,
           "scope": "Owned guest RAM loss after marker-only restore failure; no physical host, real PITR or corruption claim"}


def recover(guest, helper_command, control):
    # Keep a failed transient unit available for Result/MemoryPeak inspection.
    # --collect would discard the only evidence when the helper dies before JSON.
    arguments = [value for value in helper_command if value != "--collect"]
    result = guest.ssh([*arguments, "--recover-fixture", control["fixture_rows_before_sha256"]],
                       timeout=145, check=False)
    control["post_boot_fixture_helper_exit_code"] = result.returncode
    control["post_boot_fixture_helper_stdout_bytes"] = len(result.stdout)
    guest.assert_safe()
    if result.returncode:
        control["post_boot_fixture_helper_unit"] = failed_helper(guest)
    require(0 < len(result.stdout) <= 65536, "Missing bounded post-boot recovery observation")
    observed = json.loads(result.stdout)
    require(isinstance(observed, dict) and not set(control).intersection(observed),
            "Recovery observation cannot replace earlier restore or boot evidence")
    control.update(observed)
    require(result.returncode == 0 and observed.get("explicit_fixture_recovery_successful") is True,
            "Post-boot fixture recovery failed; numeric observation retained")


def failed_helper(guest):
    name = helper_name(guest.identity)
    fields = "Id,Description,LoadState,ActiveState,Result,MainPID,ExecMainCode,ExecMainStatus,MemoryPeak"
    result = guest.ssh(["sudo", "-n", "systemctl", "show", name, "--property=" + fields], timeout=15, check=False)
    guest.assert_safe()
    require(result.returncode in {0, 1} and 0 < len(result.stdout) <= 4096,
            "Missing bounded failed fixture-helper state")
    rows = result.stdout.decode().splitlines()
    value = dict(row.split("=", 1) for row in rows if "=" in row)
    require(len(value) == len(rows) and set(value) == set(fields.split(",")) and value["Id"] == name,
            "Failed fixture-helper identity is ambiguous")
    if value["LoadState"] == "not-found":
        return {"load_state": "not-found"}
    require(value["LoadState"] == "loaded" and value["Description"] == "g05-pitr-error:" + guest.identity,
            "Failed fixture-helper belongs to another owner")
    observed = {"load_state": "loaded", "identity_verified": True}
    for key in ["MainPID", "ExecMainCode", "ExecMainStatus", "MemoryPeak"]:
        observed[key] = None
        if value[key].isdecimal():
            observed[key] = int(value[key])
    for key, allowed in [("ActiveState", {"active", "inactive", "failed", "activating", "deactivating"}),
                         ("Result", {"success", "exit-code", "signal", "core-dump", "watchdog", "timeout",
                                     "oom-kill", "resources", "start-limit-hit", "protocol", "condition", "assert"})]:
        observed[key] = None
        if value[key] in allowed:
            observed[key] = value[key]
    return observed


def snapshot(resources):
    units = resources.get("units", {})
    result = {}
    for role, name in [("app", UNIT), ("postgres", PG_UNIT)]:
        value = units.get(name, {})
        require(value.get("LoadState") in {"loaded", "masked"} and type(value.get("MainPID")) is int
                and value["MainPID"] >= 0, "Missing post-boot native unit state")
        result[role] = {"MainPID": value["MainPID"], "ActiveState": value.get("ActiveState")}
    fenced(result)
    return result


def verdict(samples, elapsed):
    require(isinstance(samples, list) and 0 < len(samples) <= PROFILE["maximum_samples"]
            and type(elapsed) in {int, float} and math.isfinite(elapsed) and elapsed >= 0,
            "Missing bounded post-boot observation")
    for row in samples:
        require(isinstance(row, dict) and set(row) == {"units", "authenticated_API_reopened"}
                and type(row["authenticated_API_reopened"]) is bool, "Invalid post-boot observation")
        if (not fenced(row["units"]) or row["authenticated_API_reopened"]
                or any(unit["ActiveState"] != "inactive" for unit in row["units"].values())):
            return False
    return len(samples) >= 2 and PROFILE["minimum_observation_seconds"] <= elapsed <= PROFILE["maximum_observation_seconds"]


def observe(guest, api, token):
    began = time.monotonic()
    samples = []
    while time.monotonic() - began < PROFILE["minimum_observation_seconds"]:
        guest.assert_safe()
        require(len(samples) < PROFILE["maximum_samples"], "Post-boot sample ceiling reached")
        units = snapshot(guest.action("resources", timeout=PROFILE["maximum_guest_resource_request_seconds"]))
        reopened = False
        try:
            api.request("GET", "/rest/v1/native_probe?select=id", token=token)
            reopened = True
        except (OSError, RuntimeError, http.client.HTTPException):
            # A safety failure cannot be mistaken for successful fencing.
            guest.assert_safe()
        samples.append({"units": units, "authenticated_API_reopened": reopened})
        if not fenced(units) or reopened:
            break
        time.sleep(PROFILE["minimum_sample_gap_seconds"])
    elapsed = time.monotonic() - began
    return {"profile": PROFILE, "samples": samples, "elapsed_seconds": elapsed,
            "unknown_state_kept_stopped_after_boot": verdict(samples, elapsed)}
