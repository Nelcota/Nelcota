# SDK review fixes execution

Date: 2026-10-19. Baseline: `afe0877b0082d8c47cf243d06a46c294e7ea49e7`.
Branch: `fix/sdk-review-regressions`. This record describes local validation
completed before committing; hosted CI results belong to the subsequent pull
request. Package versions remain TypeScript 0.2.0 and Rust 0.1.3; changes are
recorded under Unreleased.

## Scope and decisions

Fix the four reproduced findings from the SDK review. Keep lifecycle ownership,
HTTP behavior, dependencies, migration SQL, package exports, size budgets and
configuration unchanged. The intentional public type correction makes
`Query.select()` describe its existing singular/nullable runtime result.

Use existing locks, the Rust lifecycle epoch and the native browser journal;
do not introduce another coordination layer. Preserve accepted authentication
publication when a caller cancels its own wait. Keep the FIFO control slot,
but release a cancelled queued request's callback and payload immediately.

The review's Rust/TypeScript timeout retry difference remains a policy
observation, not a confirmed defect. No retry policy was changed.

## Findings and regression evidence

| Finding | Reproduction before the fix | Final behavior |
| --- | --- | --- |
| R01: delayed user responses overwrite newer cached profiles | All three new Rust regressions failed. TypeScript cache regressions also failed on the baseline. | Capture a publication revision before HTTP and publish only if that revision and observed session remain current. Cover update, refresh with identical access tokens, same-value replacements and native cross-client journal changes. |
| R02: reselect loses singular result types | The new type-test case failed; existing runtime already returned an object or null. | Preserve single/maybe-single cardinality through `select()`, including typed/untyped clients and rejecting pagination of singular results. Existing HEAD and write types pass unchanged. |
| R03: cancelled authentication retains queued payloads | With the lifecycle owner held, all 200 cancelled callers' signals remained reachable. | Withdraw the queued callback on cancellation. With both local locks and simulated Web Locks, zero of 200 signals remain reachable before the owner completes, and only the owner's HTTP request runs. |
| R04: malformed totals become valid counts | Seven of the nine added malformed-header cases failed on the baseline. | Accept decimal, non-negative safe-integer totals with the expected range syntax; otherwise retain the unknown-count result (`null`). |

The baseline TypeScript unit run with the first regressions had 239 passed and
11 failed tests (four cache cases and seven malformed totals). The baseline
type run had 16 passed and one failed case. Baseline GC and Rust failures were
preserved independently; they were not treated as passing checks.

Additional self-review coverage:

- Preserve sessions implemented with class accessors and explicit `toJSON`;
  do not clone an explicit session merely to obtain identity-based versioning.
- Track both the TypeScript local publication counter and native journal
  revision. A candidate using only the journal receipt failed the added
  failed-publication regression: two accepted local replacements whose journal
  writes fail can leave the receipt unchanged. That regression passes with
  the combined guard, retaining local state until journal reconciliation.
- Explicit replacements advance the local revision even when values match.
  Rejected profile publication still returns the request's response to its
  caller, preserving the HTTP contract, without regressing cache or events.
- Cancellation of an already active operation retains its accepted publication
  lifetime. Cancellation releases only the caller's observation and queued
  payload; it does not promise to remove every FIFO promise node immediately.

## Final local validation

All test runs were sequential: Rust, Vitest and audits were never run together.
Cargo used four jobs and two test threads; Vitest used at most two workers.
Fixtures were disposable PostgreSQL, Mailpit or controlled local responses.
No production resources were accessed.

| Check | Result |
| --- | --- |
| Rust SDK tests | 37 passed, including the three new publication regressions |
| Rust doctests | 10 examples compiled |
| Rust/server/PostgreSQL contracts | 8 passed |
| SDK clippy, all targets, `-D warnings` | Passed |
| Workspace formatting | Passed |
| SDK rustdoc, `-D warnings` | Passed |
| Rust package verification | 39 files; archive verified; external consumer built and ran |
| TypeScript check/build | Passed |
| TypeScript unit tests | 254 passed |
| TypeScript type tests | 17 passed; no type errors |
| TypeScript/server/PostgreSQL contracts | 34 passed, including generated-type compilation |
| Node 24 runtime | 8 checks passed |
| Existing shared-cancellation GC checks | 3 rounds of 1,000 cancelled callers; zero retained signals |
| Queued-authentication GC checks | 200 callers per lock mode; zero retained signals before owner completion |
| npm package verification | 60 files; all four installed JS/type entrypoints passed |
| Public export inventory | All four entrypoints retain their exported names and symbol kinds |
| Panel check | Zero errors and warnings |
| Guide tests | 37 passed |
| Panel build and guide catalogs | Passed; English/Portuguese changelog fragments included |
| Native lint base/import presets and source boundaries | Passed |

Final gzip bundle measurements, with the original budgets and size script:

| Entrypoint | Bytes | Budget |
| --- | ---: | ---: |
| Root | 17,100 | 17,100 |
| REST | 9,393 | 9,550 |
| Auth | 11,246 | 11,250 |
| Storage | 7,390 | 7,400 |

The initial implementation exceeded the root/auth budgets (17,337/11,435
bytes). Those candidates were rejected. Shared profile handling, removing
redundant internal wrappers/state, and import ordering kept the final fixes
within the existing limits. No threshold, compiler configuration, dependency
or size-check implementation was changed. The root has no remaining headroom;
future source changes must remeasure it.

The embedded panel assets were rebuilt after the bundled changelog and
Portuguese catalog changed. After resolving generated asset-name references,
212 non-guide files match the baseline byte-for-byte; only the guide JS body
contains new prose. Generated assets belong in a separate build commit if
these working-tree changes are committed.

## Commands and evidence

Run from the repository root with the configured Rust 1.99 / Node 24 toolchain:

```sh
cargo test --locked -p nelcota-client
cargo clippy --locked -p nelcota-client --all-targets -- -D warnings
cargo fmt --all --check
RUSTDOCFLAGS='-D warnings' cargo doc --locked -p nelcota-client --no-deps
scripts/test.sh rust --locked -p nelcota-server --test sdk_rust
cargo package --locked -p nelcota-client --allow-dirty
python3 sdk/rust/scripts/package-test.py
python3 scripts/run-preset.py base
python3 scripts/run-preset.py performance/imports
python3 scripts/check-boundaries.py
```

Then, sequentially from `sdk/typescript`:

```sh
npm run check
npm test -- --maxWorkers=2
npm run test:types -- --maxWorkers=2
npm run build
npm run size
npm run test:memory
npm run test:runtime
npm run test:package
NELCOTA_BIN=/absolute/path/to/nelcota npm run test:contract -- --maxWorkers=2
```

Local logs, including baseline failures and rejected bundle candidates, are in
`/workspace/artifacts/sdk-fixes-2026-10-19/`. The original read-only review and
independent reproductions remain in
`/workspace/artifacts/sdk-review-2026-10-19/`. These workspace paths are not
durable remote evidence. No commit, push, PR, publication or merge was performed
during the local correction/validation phase. The maintainer subsequently
authorized committing, pushing, opening a PR and merging after its checks pass;
that follow-up keeps generated assets in a separate build commit.

## Limits

Chromium/Firefox/WebKit, Bun, Deno, Node 22/26 and Rust 1.88 were unavailable
locally; their matrix was not repeated. No hosted CI result is claimed by this
local validation record. Real S3, prolonged stress and dependency audits were
not repeated: no storage transport, dependency or manifest changed. The targeted
results above do not establish those unrun gates or the absence of all future
concurrency defects.
