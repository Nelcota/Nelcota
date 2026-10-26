#!/usr/bin/env python3
"""Run project review presets; stdout is JSON and stderr is a human summary."""

import argparse
import collections
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IGNORED = {"node_modules", "dist", "build", "coverage", ".git", "target", ".tools", "output", ".nelcota", "backups", "__pycache__"}
SOURCE_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".svelte"}


def load_registry(root):
    return json.loads((root / "presets/index.json").read_text())


def select_presets(registry, selector):
    if selector == "base":
        return [{"id": "base", "group": "base", "engine": "oxlint", "config": ".oxlintrc.json", "enabled": True}]
    if selector == "all":
        return registry["presets"]
    selected = [item for item in registry["presets"] if item["id"] == selector or item["group"] == selector]
    if not selected:
        raise ValueError(f"Unknown preset or group: {selector}; use --list")
    return selected


def tool_path(root, name):
    executable = name + {"nt": ".exe"}.get(os.name, "")
    paths = [root / ".tools" / name / executable]
    if name == "semgrep":
        paths.insert(0, root / ".tools/semgrep" / {"nt": "Scripts/semgrep.exe"}.get(os.name, "bin/semgrep"))
    for candidate in paths:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return shutil.which(name)


def availability(root, preset):
    if not preset.get("applicable", True):
        return "not_applicable", preset["reason"]
    if not preset.get("enabled", True):
        return "disabled", preset["reason"]
    engine = preset["engine"]
    binary = {"bun-audit": "bun"}.get(engine, engine)
    if tool_path(root, binary) is None:
        return "unavailable", f"{binary} is not installed; see presets/README.md for project-local setup."
    return "ready", None


def checked_paths(root, paths):
    result = []
    for value in paths:
        path = (root / value).resolve()
        if not path.is_relative_to(root.resolve()) or not path.exists():
            raise ValueError(f"Scan paths must exist inside the checkout: {value}")
        result.append(path.relative_to(root.resolve()).as_posix() or ".")
    return result


def relative_file(name, root, workspace=None):
    if not name:
        return None
    path = Path(name)
    if workspace is not None and not path.is_absolute():
        path = workspace / path
    if path.is_absolute():
        try:
            return path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            return path.as_posix()
    return path.as_posix()


def diagnostic(preset, filename, line, column, rule, message, severity):
    return {"preset": preset["id"], "group": preset["group"], "file": filename,
            "line": line, "column": column, "rule": rule, "message": message, "severity": severity}


def normalize_oxlint(payload, preset, root):
    result = []
    for item in payload.get("diagnostics", []):
        labels = item.get("labels", [])
        span = {}
        if labels:
            span = labels[0].get("span", {})
        code = item.get("code") or "oxlint/parser"
        if "(" in code and code.endswith(")"):
            scope, rule = code[:-1].split("(", 1)
            code = f"{scope}/{rule}"
        severity = {"warning": "warning", "warn": "warning"}.get(item.get("severity"), "error")
        result.append(diagnostic(preset, relative_file(item.get("filename"), root),
                                 span.get("line", 1), span.get("column", 1), code, item["message"], severity))
    return result


def normalize_gitleaks(payload, preset, root):
    return [diagnostic(preset, relative_file(item.get("File"), root), item.get("StartLine", 1),
                       item.get("StartColumn", 1), item.get("RuleID", "gitleaks/secret"),
                       item.get("Description", "Potential secret detected (redacted)"), "error") for item in payload]


def normalize_semgrep(payload, preset, root):
    result = []
    for item in payload.get("results", []):
        start, extra = item.get("start", {}), item.get("extra", {})
        severity = {"ERROR": "error"}.get(extra.get("severity"), "warning")
        result.append(diagnostic(preset, relative_file(item.get("path"), root), start.get("line", 1),
                                 start.get("col", 1), item.get("check_id", "semgrep"),
                                 extra.get("message", "Unsafe pattern detected"), severity))
    return result


def normalize_audit(payload, preset, workspace, root):
    # bun audit --json: {"pacote": [aviso, ...]}, o mesmo formato da API de avisos em lote do npm.
    if not isinstance(payload, dict) or not all(isinstance(value, list) for value in payload.values()):
        raise ValueError("Unsupported bun audit JSON; expected advisories grouped by package")
    result = []
    for name, advisories in payload.items():
        for advisory in advisories:
            severity = {"high": "error", "critical": "error"}.get(advisory.get("severity"), "warning")
            message = f"{name}: {advisory.get('title', 'Vulnerable dependency')} ({advisory.get('severity', 'unknown')})"
            result.append(diagnostic(preset, relative_file(workspace / "bun.lock", root), 1, 1,
                                     f"bun-audit/{advisory.get('id', name)}", message, severity))
    return result


def run_command(command, cwd, timeout):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=timeout)


def oxlint_command(root, preset, paths, binary, fix=False):
    command = [binary, "--config", preset["config"], "--ignore-path", ".oxlintignore", "--format", "json", "--threads", "2", "--disable-nested-config"]
    if preset.get("typeAware"):
        command.extend(["--type-aware", "--tsconfig", preset["tsconfig"]])
    if fix:
        command.append("--fix")
    command.extend(paths)
    return command


def run_oxlint(root, preset, paths, binary, timeout, fix=False):
    completed = run_command(oxlint_command(root, preset, paths, binary, fix), root, timeout)
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict) or not isinstance(payload.get("diagnostics"), list):
        raise ValueError("Oxlint returned an unexpected JSON contract")
    diagnostics = normalize_oxlint(payload, preset, root)
    if completed.returncode not in (0, 1) or (completed.returncode == 1 and not diagnostics):
        raise ValueError(f"Oxlint could not complete (exit {completed.returncode})")
    return diagnostics, completed.returncode, payload.get("number_of_files")


def run_external(root, preset, timeout):
    engine = preset["engine"]
    if engine == "bun-audit":
        diagnostics, codes = [], []
        for name in preset["workspaces"]:
            workspace = root / name
            completed = run_command([tool_path(root, "bun"), "audit", "--json"], workspace, timeout)
            if completed.returncode not in (0, 1):
                raise ValueError(f"bun audit could not complete (exit {completed.returncode})")
            payload = json.loads(completed.stdout)
            diagnostics.extend(normalize_audit(payload, preset, workspace, root))
            codes.append(completed.returncode)
        return diagnostics, max(codes, default=0), None
    if engine == "semgrep":
        command = [tool_path(root, "semgrep"), "scan", "--config", preset["ruleset"], "--json", "--metrics=off", "--jobs", "2"]
        for pattern in (root / ".oxlintignore").read_text().splitlines():
            if pattern and not pattern.startswith("#"):
                command.extend(["--exclude", pattern])
        command.append(".")
        completed = run_command(command, root, timeout)
        payload = json.loads(completed.stdout)
        if completed.returncode != 0 or payload.get("errors"):
            raise ValueError(f"Semgrep could not complete (exit {completed.returncode})")
        return normalize_semgrep(payload, preset, root), completed.returncode, None
    if engine == "gitleaks":
        with tempfile.TemporaryDirectory(prefix="nelcota-secret-report-") as temporary:
            report = Path(temporary) / "gitleaks.json"
            command = [tool_path(root, "gitleaks"), "detect", "--source", str(root), "--report-format", "json",
                       "--report-path", str(report), "--redact", "--no-banner", "--exit-code", "1"]
            completed = run_command(command, root, timeout)
            if completed.returncode not in (0, 1) or not report.exists():
                raise ValueError(f"Gitleaks could not complete (exit {completed.returncode})")
            return normalize_gitleaks(json.loads(report.read_text()), preset, root), completed.returncode, None
    raise ValueError(f"Unsupported preset engine: {engine}")


def execute(root, presets, paths, timeout, binary):
    report = {"schemaVersion": 1, "diagnostics": [], "presets": [], "fix": {"requested": False, "changedFiles": []}}
    for preset in presets:
        status, reason = availability(root, preset)
        result = {"preset": preset["id"], "group": preset["group"], "engine": preset["engine"],
                  "status": status, "reason": reason, "durationMs": 0, "count": 0, "exitCode": None}
        if status != "ready":
            report["presets"].append(result)
            continue
        started = time.perf_counter()
        try:
            if preset["engine"] == "oxlint":
                selected_paths = paths or preset.get("paths", ["."])
                diagnostics, code, files = run_oxlint(root, preset, selected_paths, binary, timeout)
                result["filesScanned"] = files
            if preset["engine"] != "oxlint":
                diagnostics, code, _ = run_external(root, preset, timeout)
            result.update(status="completed", count=len(diagnostics), exitCode=code)
            report["diagnostics"].extend(diagnostics)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            result.update(status="failed", reason=str(error))
        result["durationMs"] = round((time.perf_counter() - started) * 1000, 3)
        report["presets"].append(result)
    summarize(report)
    return report


def summarize(report):
    severities = collections.Counter(item["severity"] for item in report["diagnostics"])
    report["summary"] = {"errors": severities["error"], "warnings": severities["warning"],
                         "executionFailures": sum(item["status"] == "failed" or (item["engine"] == "oxlint" and item["status"] == "unavailable") for item in report["presets"]),
                         "byPreset": dict(collections.Counter(item["preset"] for item in report["diagnostics"])),
                         "byFile": dict(collections.Counter(item["file"] or "<project>" for item in report["diagnostics"]))}


def exit_code(report):
    if report["summary"]["executionFailures"]:
        return 2
    if report["summary"]["errors"]:
        return 1
    return 0


def stage_sources(root, destination):
    originals = {}
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in IGNORED and not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            source = Path(directory) / name
            if source.is_symlink() or (source.suffix not in SOURCE_SUFFIXES | {".json"} and name not in {".gitignore", ".eslintignore", ".oxlintignore"}):
                continue
            relative = source.relative_to(root)
            contents = source.read_bytes()
            copied = destination / relative
            copied.parent.mkdir(parents=True, exist_ok=True)
            copied.write_bytes(contents)
            if source.suffix in SOURCE_SUFFIXES:
                originals[relative.as_posix()] = contents
    return originals


def apply_fixes(root, presets, paths, binary, timeout):
    # Oxlint has no dry-run fix flag. Compute actual safe edits in a temporary
    # copy, print the exact file list, then publish only changed source files.
    with tempfile.TemporaryDirectory(prefix="nelcota-oxlint-fix-") as temporary:
        stage = Path(temporary)
        originals = stage_sources(root, stage)
        for preset in presets:
            if preset["engine"] != "oxlint" or availability(root, preset)[0] != "ready":
                continue
            run_oxlint(stage, preset, paths or preset.get("paths", ["."]), binary, timeout, fix=True)
        changed = {name: (stage / name).read_bytes() for name, original in originals.items() if (stage / name).read_bytes() != original}
        for name in changed:
            if (root / name).read_bytes() != originals[name]:
                raise ValueError(f"File changed during fix preview; no fixes applied: {name}")
        print("Automatic fixes will change: " + (", ".join(sorted(changed)) or "no files"), file=sys.stderr, flush=True)
        for name, contents in changed.items():
            path = root / name
            descriptor, temporary_file = tempfile.mkstemp(prefix=".oxlint-fix-", dir=path.parent)
            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(contents)
                os.chmod(temporary_file, path.stat().st_mode & 0o777)
                os.replace(temporary_file, path)
            finally:
                Path(temporary_file).unlink(missing_ok=True)
        return sorted(changed)


def print_summary(report):
    print("Review presets:", file=sys.stderr)
    for item in report["presets"]:
        print(f"  {item['preset']}: {item['status']}, {item['count']} findings, {item['durationMs']:.3f} ms", file=sys.stderr)
        if item.get("reason"):
            print("    " + item["reason"], file=sys.stderr)
    print("Findings by file:", file=sys.stderr)
    for name, count in sorted(report["summary"]["byFile"].items()):
        print(f"  {name}: {count}", file=sys.stderr)
    totals = report["summary"]
    print(f"Total: {totals['errors']} errors, {totals['warnings']} warnings, {totals['executionFailures']} execution failures", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("selector", nargs="?", default="all", help="A preset, group, all, or base")
    parser.add_argument("--list", action="store_true", help="List preset availability as JSON")
    parser.add_argument("--fix", action="store_true", help="Preview and apply safe Oxlint fixes; external tools never fix")
    parser.add_argument("--paths", nargs="+", help="Limit Oxlint to files/directories inside the checkout")
    parser.add_argument("--timeout", type=int, default=120, help="Timeout per tool invocation, in seconds")
    args = parser.parse_args(argv)
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    if args.list and args.fix:
        parser.error("--list and --fix cannot be combined")
    registry = load_registry(ROOT)
    presets = select_presets(registry, args.selector)
    if args.list:
        items = [{**item, "status": availability(ROOT, item)[0], "statusReason": availability(ROOT, item)[1]} for item in presets]
        print(json.dumps({"schemaVersion": 1, "presets": items}, indent=2, allow_nan=False))
        return 0
    paths = None
    if args.paths:
        paths = checked_paths(ROOT, args.paths)
    binary = tool_path(ROOT, "oxlint")
    if any(item["engine"] == "oxlint" and availability(ROOT, item)[0] == "ready" for item in presets):
        expected = json.loads((ROOT / "presets/oxlint.lock.json").read_text())["version"]
        version = run_command([binary, "--version"], ROOT, 10)
        if version.returncode != 0 or version.stdout.strip() != f"Version: {expected}":
            raise ValueError("Oxlint version does not match the lockfile; run scripts/install-oxlint.py")
    report = execute(ROOT, presets, paths, args.timeout, binary)
    if args.fix:
        if report["summary"]["executionFailures"]:
            raise ValueError("Fix preflight failed; no source files changed")
        if not any(item["engine"] == "oxlint" and availability(ROOT, item)[0] == "ready" for item in presets):
            raise ValueError("The selected presets do not support automatic Oxlint fixes")
        changes = apply_fixes(ROOT, presets, paths, binary, args.timeout)
        report = execute(ROOT, presets, paths, args.timeout, binary)
        report["fix"] = {"requested": True, "changedFiles": changes}
    print(json.dumps(report, indent=2, allow_nan=False))
    print_summary(report)
    return exit_code(report)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report = {"schemaVersion": 1, "diagnostics": [], "presets": [],
                  "fix": {"requested": False, "changedFiles": []}, "executionErrors": [str(error)]}
        summarize(report)
        report["summary"]["executionFailures"] = 1
        print(json.dumps(report, indent=2, allow_nan=False))
        print(f"Review execution failed: {error}", file=sys.stderr)
        raise SystemExit(2)
