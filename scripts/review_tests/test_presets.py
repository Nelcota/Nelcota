"""Native review-tool boundary tests. Actual Oxlint --fix is never executed."""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("review_presets", ROOT / "scripts/run-preset.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
BIN = runner.tool_path(ROOT, "oxlint")


class ReviewBoundaries(unittest.TestCase):
    def setUp(self):
        self.preset = {"id": "bugs/nan", "group": "bugs", "engine": "oxlint", "enabled": True,
                       "config": "presets/bugs/nan/.oxlintrc.json"}

    def test_normalizes_native_locations_rule_and_severity(self):
        payload = {"diagnostics": [{"filename": "file.ts", "message": "bad NaN comparison",
                                  "severity": "warning", "code": "eslint(use-isnan)",
                                  "labels": [{"span": {"line": 7, "column": 9}}]}]}
        result = runner.normalize_oxlint(payload, self.preset, ROOT)
        self.assertEqual(result, [{"preset": "bugs/nan", "group": "bugs", "file": "file.ts", "line": 7,
                                   "column": 9, "rule": "eslint/use-isnan", "message": "bad NaN comparison", "severity": "warning"}])

    def test_secret_normalization_never_includes_the_secret_or_match(self):
        payload = [{"File": "config.txt", "StartLine": 8, "RuleID": "generic-api-key", "Description": "API key",
                    "Secret": "do-not-expose-this", "Match": "token=do-not-expose-this"}]
        result = runner.normalize_gitleaks(payload, self.preset, ROOT)
        self.assertNotIn("do-not-expose-this", json.dumps(result))
        self.assertEqual(result[0]["severity"], "error")

    def test_dependency_severity_and_workspace_file_are_preserved(self):
        payload = {"vulnerabilities": {"critical-lib": {"severity": "critical", "via": [{"source": 42, "title": "Injection"}]},
                                       "moderate-lib": {"severity": "moderate", "via": ["critical-lib"]}}}
        result = runner.normalize_audit(payload, self.preset, ROOT / "sdk/typescript", ROOT)
        self.assertEqual([item["severity"] for item in result], ["error", "warning"])
        self.assertEqual(result[0]["file"], "sdk/typescript/package-lock.json")
        with self.assertRaises(ValueError):
            runner.normalize_audit({"error": {"code": "ENOLOCK"}}, self.preset, ROOT, ROOT)

    def test_semgrep_messages_and_positions_are_normalized(self):
        payload = {"results": [{"path": "src/code.ts", "check_id": "unsafe-eval", "start": {"line": 4, "col": 2},
                                "extra": {"message": "Avoid eval", "severity": "ERROR"}}]}
        result = runner.normalize_semgrep(payload, self.preset, ROOT)[0]
        self.assertEqual((result["rule"], result["line"], result["column"], result["severity"]), ("unsafe-eval", 4, 2, "error"))

    def test_exit_status_distinguishes_warnings_errors_and_failed_execution(self):
        report = {"diagnostics": [{"preset": "x", "file": "a.ts", "severity": "warning"}], "presets": []}
        runner.summarize(report)
        self.assertEqual(runner.exit_code(report), 0)
        report["diagnostics"][0]["severity"] = "error"
        runner.summarize(report)
        self.assertEqual(runner.exit_code(report), 1)
        report["presets"] = [{"status": "failed", "engine": "oxlint"}]
        runner.summarize(report)
        self.assertEqual(runner.exit_code(report), 2)

    def test_missing_optional_tools_are_not_reported_as_completed(self):
        with mock.patch.object(runner, "tool_path", return_value=None):
            self.assertEqual(runner.availability(ROOT, {"engine": "gitleaks"})[0], "unavailable")
            self.assertEqual(runner.availability(ROOT, {"engine": "semgrep"})[0], "unavailable")
            report = runner.execute(ROOT, [self.preset], None, 10, None)
            self.assertEqual(runner.exit_code(report), 2)

    def test_scan_paths_cannot_escape_the_checkout(self):
        with self.assertRaises(ValueError):
            runner.checked_paths(ROOT, ["../"])
        self.assertEqual(runner.checked_paths(ROOT, ["sdk/typescript"]), ["sdk/typescript"])

    def test_preview_prints_exact_changes_before_publication_with_mocked_fixes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.ts"
            source.write_text("const before = 1;\n")
            def staged_fix(stage, *_args, **_kwargs):
                self.assertEqual(source.read_text(), "const before = 1;\n")
                (stage / "source.ts").write_text("const after = 1;\n")
                return [], 0, 1
            output = io.StringIO()
            with mock.patch.object(runner, "availability", return_value=("ready", None)), mock.patch.object(runner, "run_oxlint", side_effect=staged_fix), contextlib.redirect_stderr(output):
                changed = runner.apply_fixes(root, [self.preset], None, "mocked-engine", 10)
            self.assertEqual(changed, ["source.ts"])
            self.assertIn("Automatic fixes will change: source.ts", output.getvalue())
            self.assertEqual(source.read_text(), "const after = 1;\n")

    def test_preview_cannot_overwrite_a_concurrent_edit_with_mocked_fixes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.ts"
            source.write_text("const before = 1;\n")
            def staged_fix(stage, *_args, **_kwargs):
                (stage / "source.ts").write_text("const after = 1;\n")
                source.write_text("const concurrent = 1;\n")
                return [], 0, 1
            with mock.patch.object(runner, "availability", return_value=("ready", None)), mock.patch.object(runner, "run_oxlint", side_effect=staged_fix):
                with self.assertRaisesRegex(ValueError, "File changed during fix preview"):
                    runner.apply_fixes(root, [self.preset], None, "mocked-engine", 10)
            self.assertEqual(source.read_text(), "const concurrent = 1;\n")


@unittest.skipUnless(BIN, "Run python3 scripts/install-oxlint.py first")
class NativeIntegration(unittest.TestCase):
    def test_every_preset_config_is_accepted_by_the_pinned_native_engine(self):
        registered = runner.load_registry(ROOT)
        rules_result = subprocess.run([BIN, "--rules", "--format", "json"], capture_output=True, text=True, check=True)
        registered_names = {f"{rule['scope']}/{rule['value']}" for rule in json.loads(rules_result.stdout)}
        for preset in registered["presets"]:
            if "config" not in preset:
                continue
            config = json.loads((ROOT / preset["config"]).read_text())
            self.assertLessEqual(set(config.get("rules", {})), registered_names)
            completed = subprocess.run([BIN, "--config", preset["config"], "--print-config"], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, f"{preset['id']}: {completed.stderr}")
            self.assertIsInstance(json.loads(completed.stdout), dict)

    def test_nested_presets_ignore_builds_dependencies_and_generated_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copyfile(ROOT / ".oxlintrc.json", root / ".oxlintrc.json")
            shutil.copyfile(ROOT / ".oxlintignore", root / ".oxlintignore")
            preset = {"id": "bugs/nan", "group": "bugs", "config": "presets/bugs/nan/.oxlintrc.json"}
            config = root / preset["config"]
            config.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / preset["config"], config)
            for name in ["src/check.ts", "dist/output.ts", "node_modules/pkg/index.ts", "crates/admin/ui/src/lib/generated/validators.js"]:
                source = root / name
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text("const value = NaN;\n")
            diagnostics, code, count = runner.run_oxlint(root, preset, ["."], BIN, 10)
            self.assertEqual(code, 1)
            self.assertEqual(count, 1)
            self.assertEqual([item["file"] for item in diagnostics], ["src/check.ts"])

    def test_native_engine_runs_with_no_node_or_npm_on_path(self):
        result = subprocess.run([BIN, "--version"], env={**os.environ, "PATH": ""}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Version: 1.89.0")
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "native.ts"
            source.write_text("const value = NaN;\n")
            result = subprocess.run([BIN, "-A", "all", "-D", "unicorn/prefer-number-properties", "--threads", "2",
                                     "--format", "json", str(source)], cwd=temporary,
                                    env={**os.environ, "PATH": ""}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(len(json.loads(result.stdout)["diagnostics"]), 1)

    def test_json_stdout_and_summary_stderr_remain_separate(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/run-preset.py"), "base"], cwd=ROOT,
                                capture_output=True, text=True, env={**os.environ, "PATH": ""})
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["summary"]["executionFailures"], 0)
        self.assertIn("Review presets:", result.stderr)


if __name__ == "__main__":
    unittest.main()
