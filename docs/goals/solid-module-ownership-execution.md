# SOLID and module ownership — execution

Date: 2026-10-19. Baseline: `135c640f404471dd191a5cb6824a5f850e2e9e00`.
Branch: `refactor/solid-module-ownership`.

Status: implemented and locally validated. Ordinary CI and the final review
disposition are recorded in the associated pull request; local results below
are not a claim that a new GitHub head passed CI.

## Result and scope

Retain the modular monolith, existing crate dependency graph and public
interfaces. Organize code where responsibilities actually differed, using
Rust modules/structs and the existing TypeScript classes and functions.
No additional trait hierarchy, repository wrapper, service framework or
dependency is introduced.

| Area | Previous maintenance cost | Result | Behavior retained |
| --- | --- | --- | --- |
| Catalog introspection | One operation assembled four queries and decoded all metadata | A 27-line coordinator calls private relation, column, constraint and function readers | Same four queries, read order, role privileges, complete-snapshot publication and errors |
| Table DDL | An 858-line file mixed wire specifications, column rendering, planning and tests | A 22-line facade exposes `spec`, `column`, `create` and `alter`; tests live alongside them | Same public facade, ordered working-schema transitions, validation priority and SQL |
| Panel shared modules | Thirty root files/tests mixed transport, state, browser effects and formatting | Named owners with adjacent tests; the shared session object moves from the login feature to resources | Same singleton, cache epochs, cancellation, authentication sequencing, markup and output |
| Shared dependencies | Infrastructure imported login-feature state; upload imported the API coordinator for errors; shared DDL imported a policy feature | Shared session, transport errors and SQL identifier rendering live below the features that consume them | Existing API exports and helper semantics remain available |
| Browser export and persistence | Pure encoding shared a module with DOM downloads; identifier generation lived with persistence | Formatting owns CSV/JSON; browser modules own downloads, identifiers and local storage separately | Same encoding, formula protection, object-URL cleanup and identifier fallback |

The [architecture ownership map](../architecture.md#source-organization) names
each panel directory and the SOLID principles applied. Components stay with
their feature or shared component owner. Generator aliases follow the same
map, so future shadcn utilities/hooks do not recreate loose root modules.

Existing public Rust/SDK APIs, HTTP contracts, migrations, configuration
formats, CLI flags, dependencies, budgets and lint settings are unchanged.
Only the internal panel generator aliases and memory-test script path change.
No SDK runtime, auth implementation, SQL/export ownership, CLI lifecycle or
PITR fencing/recovery implementation is refactored in this pass.

## Enforced boundaries

The existing `scripts/check-boundaries.py` CI gate continues checking exact
crate dependencies and packaged migration bytes. It now also rejects:

- Source files loose at the panel library root and unregistered library owners.
- Literal static/dynamic imports from shared infrastructure into features or shell.
- Direct browser-probe source URLs whose target was removed or renamed.

Four new test cases exercise valid dependency direction, misplaced modules,
alias/relative/type/dynamic reverse imports and missing browser targets.
The existing native import preset continues checking dependency cycles.
No workflow, dependency or existing threshold is changed.

## Before/after evidence

The new PostgreSQL characterization was executed before production extraction.
Its first commit, `ac996eed`, contains only that test against the original
implementation. The same test file remains unchanged after extraction:

`5dc73d449ac790358acf4a22bdc87173a34ba8e3549ba39eba9f06789d377c42` (SHA-256).

It covers column and composite-key ordering, generated/identity flags, enum
arrays, comments, view kinds, RLS flags, each role's privileges, defaulted and
OUT arguments, unnamed-argument exclusion, set/void returns and function grants.

| Verification | Before locally | After locally |
| --- | ---: | ---: |
| New real-PostgreSQL metadata characterization | 1 passed | 1 passed |
| Existing table DDL golden tests | 10 passed | Same 10 passed within 64 admin library tests |
| Panel unit tests | 406 passed, 1 GC-only case skipped | Same names/results: 406 passed, 1 GC-only case skipped |
| Explicit GC/memory invocation | 7 passed | Same 7 passed, including the GC-only case |
| API library tests | Not separately rerun | 44 passed |
| Real-server REST/RPC/catalog tests | Not separately rerun | 24 passed |
| Real-server panel table operations | Not separately rerun | 6 passed; other integration modules filtered |
| Real panel wire-contract scenario | Not separately rerun | 1 passed; other architecture scenarios filtered |
| Python review/checker tests | Not separately rerun | 46 passed |

The final Rust total is **140 distinct tests**. The GC invocation repeats six
ordinary panel cases; its seven results are not added to 406 as unique tests.

Additional checks:

- Clippy with `-D warnings` for API/admin all targets and the new server test;
  workspace formatting and diff whitespace passed.
- Svelte/TypeScript reported zero errors and warnings. Guide validation and
  translation synchronization passed; embedded assets were rebuilt.
- Exporting Rust wire contracts produced no generated type/schema changes.
- Native base/import presets reported zero errors and warnings.
- All 214 table-DDL string literals and all original catalog SELECT literals
  remain byte-identical when collected across their new modules.
- A read-only TypeScript AST comparison verified executable/type bodies in
  230 changed/moved panel source/test files and all their Svelte markup.
  Only module references and the seven explicitly relocated declarations
  differ in location; the relocated declarations retain their tokens.
- Current source/module references and direct Vite URLs were updated together.
  The browser runner collected **77 tests in 17 files** successfully.

These are equivalence and regression checks, not a new performance/stress
measurement. Historical G05/G06/G07 evidence remains unchanged.

## Commands and limits

Use the pinned toolchains and AGENTS.md limits: four Cargo jobs, two Rust test
threads and at most two Vitest workers. Final Rust/Vitest runs are sequential.
Database integration uses the disposable shared PostgreSQL fixture, with
isolated databases cleaned by the runner. The fixture was stopped afterward.

```sh
scripts/test.sh rust --locked -p nelcota-server --test catalog --test api
cargo test --locked -p nelcota-admin --lib
cargo test --locked -p nelcota-api --lib
scripts/test.sh rust --locked -p nelcota-server --test admin tables::
scripts/test.sh rust --locked -p nelcota-server --test architecture \
  real_panel_responses_satisfy_the_exported_contracts
cargo run --locked -p nelcota-admin --example export_contracts
git diff --exit-code -- crates/admin/ui/src/lib/generated
cargo clippy --locked -p nelcota-api -p nelcota-admin --all-targets -- -D warnings
cargo clippy --locked -p nelcota-server --test catalog -- -D warnings
cargo fmt --all --check
python3 scripts/check-boundaries.py
python3 -m unittest discover -s scripts/review_tests -v
python3 scripts/run-preset.py base
python3 scripts/run-preset.py performance/imports

cd crates/admin/ui
npm run check
npx vitest run src --maxWorkers=2
npm run test:memory
npx playwright test --list
npm run build
```

Local Chromium/Firefox/WebKit binaries are absent. Collection/type checking is
not real-browser execution; ordinary PR CI supplies that separate evidence.
No local browser, platform matrix, S3, endurance or recovery campaign is counted
as passed here. SDK source and lockfiles are unchanged; their ordinary CI gates
remain required when this branch is reviewed.

During preparation, an incorrect panel working directory caused transform
failures; rerunning from the documented UI directory passed. The first Rust
extraction compile missed a test-only import, and the first ownership draft
omitted its transport registration; both were corrected without changing
assertions or product behavior. That initial Rust compilation overlapped the
GC run and stopped before executing Rust tests; subsequent test invocations
were fully sequential. A supplemental comparison initially used an unsuitable
flat tokenizer for template literals; replacing it with AST token traversal
preserved the strict comparison and verified the actual source bodies.

## Remaining work and review policy

Large update/host orchestration, config validation, auth, SDK transport and
PITR remain owned by their existing capabilities. Size alone is not a reason
to change their reviewed lifecycle or compatibility behavior. Further
extractions there require their own characterization and targeted review.

This pass establishes concrete ownership and dependency rules; it does not
claim that every function is an ideal SOLID abstraction or that every future
maintenance issue has been eliminated. Review the refactor independently
before merging. No release, package publication or deployment is part of it.
