# Native code review presets

Oxlint 1.89.0 runs as a native executable. The runner and installer use Python
3.11+ and its standard library. Neither requires Node, Bun, a Rust build, or a
global tool installation. This tooling does not change Nelcota's single-binary
distribution or its committed panel assets.

The project uses Svelte 5 and TypeScript. Native presets inspect script blocks
and TS/JS; Svelte template/type/accessibility coverage remains with svelte-check.
React/JSX presets are not applicable. Optional scanners and type-aware coverage
have explicit availability states.

## Install and inspect

From the repository root:

```sh
python3 scripts/install-oxlint.py
python3 scripts/run-preset.py --list
```

The installer downloads the official release into `.tools/oxlint/`, verifies the
size and SHA-256 recorded in `oxlint.lock.json`, checks the executable version,
and installs it atomically. Supported pinned targets: Linux x64/ARM64 (GNU and
musl), macOS x64/ARM64 and Windows x64/ARM64. `.tools/` is ignored by Git.

The engine can also be invoked directly, without Python after installation:

```sh
.tools/oxlint/oxlint --version
.tools/oxlint/oxlint --rules --format json
```

On Windows the binary is `.tools/oxlint/oxlint.exe`; run the Python commands with
your Python 3.11+ interpreter. The installer does not change PATH or shell config.

## Run one preset, a group, or everything

```sh
python3 scripts/run-preset.py bugs/nan
python3 scripts/run-preset.py complexidade/early-return
python3 scripts/run-preset.py bugs
python3 scripts/run-preset.py seguranca
python3 scripts/run-preset.py performance
python3 scripts/run-preset.py limpeza
python3 scripts/run-preset.py complexidade
python3 scripts/run-preset.py acessibilidade
python3 scripts/run-preset.py all
```

`presets/index.json` lists every preset ID, engine, applicability and description.
Use any listed ID as the positional argument. Disabled and unavailable presets
produce explicit statuses and reasons, rather than a successful empty scan.

The native equivalents of the requested `lint`, `lint:json` and `lint:fix` scripts
are:

```sh
python3 scripts/run-preset.py base
python3 scripts/run-preset.py base > report.json
# Only run this when you explicitly want automatic corrections:
python3 scripts/run-preset.py base --fix
```

The base config enables no lint categories; parser errors still surface. Select
a thematic preset for its rules. Each preset extends that base and enables only
its theme. The correctness preset enables the entire native correctness category
for the non-React plugins. The promises preset enables the promise plugin's
correctness and suspicious rules. Rules requiring types have separate disabled
presets.

Limit Oxlint to selected project files when needed:

```sh
python3 scripts/run-preset.py bugs/nan --paths sdk/typescript/src
```

External scanners keep their documented scope: bun audit checks the panel and TypeScript SDK lockfiles,
Gitleaks scans Git history, and Semgrep scans the checkout. `--paths` limits only
Oxlint. The runner uses two Oxlint/Semgrep workers and executes presets sequentially.

## JSON contract

Stdout contains exactly one JSON document. Human counts per preset and file go
to stderr, so an interface can consume stdout directly:

```sh
python3 scripts/run-preset.py all > report.json 2> summary.log
```

The report contains `schemaVersion`, `diagnostics`, `presets`, `summary` and `fix`.
Every diagnostic has the same shape, including external tools:

```json
{
  "preset": "bugs/nan",
  "group": "bugs",
  "file": "src/example.ts",
  "line": 7,
  "column": 9,
  "rule": "eslint/use-isnan",
  "message": "Use Number.isNaN to test a value",
  "severity": "error"
}
```

File names are relative to the checkout when possible; positions are one-based.
Project-level diagnostics can have a null file. Dependency advisories point to
the relevant bun.lock at line/column 1 because bun audit does not give source
positions. Gitleaks secret and match fields are discarded; its command also uses
`--redact`. High/critical dependency advisories are errors; low/moderate advisories are
warnings. A shared finding can occur in several presets and is counted per preset.

Preset statuses are `completed`, `failed`, `unavailable`, `disabled`, or
`not_applicable`. `completed` means the scan ran successfully, even when it found
lint errors. Per-preset metadata includes count, durationMs and exitCode; summary
includes errors, warnings, executionFailures, byPreset and byFile.

Exit codes:

- 0: no error-severity findings or execution failures.
- 1: error-severity findings exist.
- 2: invalid invocation, engine failure, or the required native Oxlint is missing.

Unavailable optional external tools and disabled presets are shown in the report
without making the entire native scan fail. Consumers should inspect preset
statuses before treating a group as fully checked.

## Automatic fixes

Automatic source edits are opt-in. Request a fix explicitly and review the
changed-file list and remaining diagnostics:

```sh
python3 scripts/run-preset.py limpeza/consistencia --fix
```

Oxlint has no dry-run fix flag. The runner first performs a read-only scan,
computes safe fixes in a disposable copy, and prints the exact changed-file list
to stderr before publishing edits. It checks for concurrent changes before any
publication and atomically replaces each changed source file. External tools
never apply fixes. Suggestions and dangerous fixes are not enabled. The final
JSON reports changedFiles and remaining diagnostics; some rules have no safe fix.
Staging skips symlinks and generated/dependency/build directories. Fix previews
require enough temporary disk space for the source/configuration copy.

## Ignore paths and Svelte coverage

`.oxlintrc.json` has the base ignorePatterns. `.oxlintignore` repeats the same
root-level patterns and is passed explicitly with `--ignore-path`; this is
necessary because inherited ignorePatterns in nested preset configs are scoped
to the nested config directory. Generated validators, dist, node_modules, target,
coverage, build, Git data and local tool output are excluded.

For a direct native preset invocation, preserve that root-level ignore file:

```sh
.tools/oxlint/oxlint -c presets/bugs/nan/.oxlintrc.json --ignore-path .oxlintignore --disable-nested-config --threads 2 --format json .
```

Oxlint parses the script blocks in `.svelte` files and regular TS/JS sources.
It does not replace Svelte template or accessibility checking. The existing
svelte-check remains responsible for those checks. React security/performance
and JSX accessibility presets are marked not applicable.

`bugs/nulls` permits intentional `value == null` checks that cover both null and
undefined, and requires strict equality otherwise. Type-aware conditions and
floating promises are not checked until the typed presets are enabled.

## Optional tools and disabled typed rules

- `bugs/nulls-tipados` and `bugs/promises-tipadas` exist but are disabled because
  `oxlint-tsgolint` is missing. The SDK tsconfig is valid. To activate later,
  supply a compatible native tsgolint, set `OXLINT_TSGOLINT_PATH` to it, validate
  it with this Oxlint version, and change enabled to true in index.json. These
  presets target the TypeScript SDK; Svelte template typing needs its existing
  compiler tooling. See the pinned upstream type-aware implementation and rules
  linked in verified-rules.json. No companion was installed during setup.
- `seguranca/segredos` is unavailable until Gitleaks is supplied locally or on
  PATH. For example, install the official Linux x64 release in this checkout:

  ```sh
  mkdir -p .tools/gitleaks
  curl -fL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz -o .tools/gitleaks/release.tar.gz
  printf '%s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  .tools/gitleaks/release.tar.gz' | sha256sum -c -
  tar -xzf .tools/gitleaks/release.tar.gz -C .tools/gitleaks
  python3 scripts/run-preset.py seguranca/segredos
  ```

  Use the matching platform archive/checksum from the official release on other
  systems. The runner normalizes the JSON report and keeps secret values redacted.
- `seguranca/padroes-inseguros` is unavailable until Semgrep is supplied. A local
  Python environment avoids global installation:

  ```sh
  python3 -m venv .tools/semgrep
  .tools/semgrep/bin/python -m pip install --no-cache-dir semgrep==1.180.0
  python3 scripts/run-preset.py seguranca/padroes-inseguros
  ```

  The adapter uses p/javascript, JSON output, two jobs, the root exclusions and
  metrics disabled. It needs network access to obtain that ruleset.
- `seguranca/dependencias` runs bun audit for the panel and TypeScript SDK. This
  optional preset requires Bun; it is unavailable when Bun is absent.
  That dependency does not affect the native Oxlint presets.

## Validation and CI

The rule names and plugin scopes were checked against `oxlint --rules --format
json` for the installed version. verified-rules.json records their categories,
type requirements, fix capabilities and documentation URLs. No suggested rule
was missing. The observed baseline, timings, statuses and tuning suggestions are
in [validation.md](validation.md). Full local output is `.tools/reports/all.json`.

```sh
python3 -m unittest discover -s scripts/review_tests -v
```

The tests cover native config acceptance, ignored generated files, Node-free
execution, JSON/summary separation, diagnostic adapters, redaction, exit statuses
and fix/concurrent-edit boundaries. Fixes are mocked in those tests: they never
execute Oxlint --fix. The workflow review-presets.yml validates this tooling and
the base syntax scan without installing Node. Project-wide thematic findings
remain review reports until their existing-code findings are triaged.
