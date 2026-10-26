# SDK input and asynchronous error review

Date: 2026-10-19 (America/Sao_Paulo).
Baseline: `b4bfb972380ff474fd4b4e7e5eaaf919fe49873d`.
Working branch: `fix/sdk-input-async-guards`.
Status: local validation complete; maintainer authorized the PR/CI/merge follow-up.

## Scope and decisions

The requested null/empty, early-return and async review targets the Rust and
TypeScript SDKs, following the preceding SDK work. Changes address reproduced
boundary failures and flatten existing control flow. Pure query builders remain
synchronous; no dependency, package version, migration, workflow, server handler
or HTTP route changed.

Null is still valid in nullable data fields. Empty collections, explicit
zero-byte uploads, empty strings in row fields and empty objects requesting
database defaults remain supported. Existing finite-number/JSON checks remain
in place; their regression suites passed. Rust types already exclude absent
string/body arguments, so the added Rust checks concern blank OAuth codes and
malformed MIME components rather than speculative Option handling.

## Reproductions and corrections

The initial TypeScript characterization file ran against unchanged production
code: **34 failed, 7 passed** out of 41 cases. Two later positive/error-handling
cases bring that file to 43 passing cases after the correction. Both new Rust
regressions failed independently against unchanged production code.

| Boundary | Observed before | Correction and retained behavior |
| --- | --- | --- |
| Insert/upsert rows | Arrays containing null, primitives, nested arrays or sparse positions passed the initial boundary | Require each row to be a record before constructing a write; preserve valid empty objects and nullable fields |
| Referenced relation | Explicit empty/null/zero targets silently used the parent relation | Only an omitted target selects the parent; invalid explicit targets are rejected before HTTP |
| OAuth exchange | Blank codes reached HTTP; TypeScript consumed the stored verifier | Reject blank codes before lifecycle/verifier work; a subsequent valid exchange still succeeds |
| Session identity | An empty user ID could be stored | Require a nonempty user ID before publication |
| Upload body | TypeScript accepted an absent body | Reject null/undefined before HTTP; preserve explicit empty files |
| Storage responses | Missing items and malformed collection containers could be returned as successful typed data | Check minimum item identity and collection shape; return `invalid_response` with the original HTTP status and cause, without retrying |
| Email actions | Three Promise-returning methods threw synchronously on invalid email | Make password reset, magic-link and confirmation methods async so validation rejects the returned Promise |
| Rust MIME | `/`, `/plain`, `text/` and malformed token components passed the slash-only check | Require nonempty token type/subtype; retain valid parameters and zero-byte uploads |

The storage checks deliberately validate minimum representations, not every
typed response field. Nullable owner, metadata and bucket limits remain valid.
Server validation remains authoritative. A shared internal record predicate
replaces duplicated checks. The optional HTTP response validator stays internal;
the four supported package entrypoints retain all exported names and symbol
kinds, and their existing auth/REST/storage declarations are unchanged.

Early returns flatten Rust session loading, Rust retry handling and TypeScript
authentication publication. Existing retry limits, cancellation ownership,
timeouts and publication ordering remain covered by the unchanged suites.

## Approved bundle-budget change

Initial candidates exceeded the original gzip budgets; they were not recorded
as passing. Sharing the record check and response validation reduced the cost.
Further import-layout trials and alternative wrappers were rejected; they are
absent from the final source. The maintainer explicitly selected:

> Manter todas as proteções e ampliar os tetos em até 300 B gzip (recomendado)

Only the budget constants and their explanation changed in `scripts/size.mjs`
(now `scripts/size.ts`).
The static import-closure calculation, compiler settings and gzip level are
unchanged. The baseline was rebuilt separately from the recorded commit with
the same installed toolchain.

| Entrypoint | Baseline bytes | Final bytes | Increase | Original budget | Approved final budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| Root | 17,100 | 17,325 | 225 | 17,100 | 17,400 |
| REST | 9,393 | 9,441 | 48 | 9,550 | 9,550 |
| Auth | 11,246 | 11,271 | 25 | 11,250 | 11,300 |
| Storage | 7,390 | 7,602 | 212 | 7,400 | 7,700 |

The final source exceeds the original root/auth/storage budgets and passes the
explicitly approved budgets. No other test threshold, lint or security check
was reduced.

## Final local validation

Rust 1.99.0 and Node 24 were used. Cargo used at most four jobs and two test
threads; Rust tests, Vitest and audit operations were kept sequential. All
real-server fixtures were disposable and used the shared PostgreSQL container.

| Check | Result |
| --- | --- |
| Rust SDK runtime tests | 39 passed, including both reproduced regressions |
| Rust doctests | 10 compiled successfully |
| Rust/server/PostgreSQL contracts | 8 passed |
| SDK clippy, all targets, `-D warnings` | Passed |
| Workspace formatting | Passed |
| Rust package | Archive verified; external consumer built and ran |
| TypeScript check and build | Passed |
| TypeScript unit tests | 297 passed, including 43 boundary cases |
| TypeScript type tests | 17 passed |
| TypeScript/server/PostgreSQL contracts | 34 passed |
| Node 24 runtime smoke | 8 checks passed |
| Shared-cancellation memory checks | Three rounds of 1,000 cancelled callers; zero retained signals before completion |
| Queued-authentication memory checks | 200 callers in each local/simulated Web Locks mode; zero retained signals before owner completion |
| npm archive | 62 files; installed JavaScript and type entrypoints passed |
| Public export inventory | Same names and symbol kinds in all four supported entrypoints |
| Guide catalogs and panel check | Passed; zero panel errors/warnings |
| Guide tests | 37 passed |
| Embedded guide assets and server rebuild | Passed |
| Native base/import presets and source boundaries | Passed |
| Source whitespace check | Passed; generated minified assets excluded |

The runtime upload fixture now includes the actual object identity/shape; its
assertions are unchanged. English SDK references and changelogs have matching
Portuguese panel translations. Embedded panel assets were regenerated and the
server rebuilt afterward; keep those assets in a separate build commit if the
maintainer requests commits.

After matching generated asset names, 212 of 213 panel files match the baseline;
only the guide chunk contains new prose. The first local comparison collapsed
same-named vendor chunks and failed its assertion; the corrected comparison
matches identical paths first, and both diagnostic reports are retained. The
owned shared PostgreSQL container was removed after the contract tests; no
running Docker containers remained.

## Commands and evidence

From the repository root, with the configured toolchain:

```sh
cargo test --locked -p nelcota-client
cargo clippy --locked -p nelcota-client --all-targets -- -D warnings
cargo fmt --all --check
scripts/test.sh rust --locked -p nelcota-server --test sdk_rust
cargo package --locked -p nelcota-client --allow-dirty
python3 sdk/rust/scripts/package-test.py
python3 scripts/run-preset.py base
python3 scripts/run-preset.py performance/imports
python3 scripts/check-boundaries.py
```

Sequentially from `sdk/typescript`:

```sh
npm run check
npm test -- --maxWorkers=2
npm run test:types -- --maxWorkers=2
npm run build
npm run size
npm run test:runtime
npm run test:memory
npm run test:package
NELCOTA_BIN=/absolute/path/to/nelcota npm run test:contract -- --maxWorkers=2
```

From `crates/admin/ui`, guide checks, `npm run check`, the targeted guide
Vitest suite and `npm run build` passed. The server was then rebuilt with
`cargo build --locked -p nelcota-server` before its TypeScript contracts ran.

Local evidence is in `/workspace/artifacts/sdk-guards-2026-10-19/`: baseline
failure logs, final suite/packaging logs, baseline/final size reports, rejected
size candidates and declaration/export inventories. These paths are local
workspace evidence, not a durable remote archive.

No browser-engine, Bun/Deno, Node 22/26 or Rust 1.88 matrix was rerun locally.
No fresh dependency audit, hosted CI or production acceptance was run during the
local validation phase; no dependencies changed. These checks must not be
reported as passed by the local results above. No commit, push, PR, merge,
release or deployment was performed during that phase.

## Authorized follow-up

The maintainer subsequently requested commits, push, a pull request, a review
after opening, any necessary corrections, then merge and branch cleanup.
Generated panel assets are committed separately. Merge requires the current
base and all applicable ordinary CI checks passing on the exact PR head;
the PR records hosted results and the completed review. Cleanup is restricted
to this task's branch. No tags, releases, package publications or deployment
are part of this follow-up.

### Post-opening review: MIME parameter whitespace

Review of [PR #113](https://github.com/Nelcota/Nelcota/pull/113), initially at
`a0641ffd3a812450d9388c47a90fdc843772e93f`, found that the new Rust MIME check
rejected valid optional whitespace before a parameter delimiter. The expanded
storage regression failed with `text/plain ; charset=utf-8` before the correction
(`mime-ows-before.log`). The media type check now removes trailing space/tab
for validation only; the outgoing header remains unchanged. The regression
covers space and tab, checks the exact received header and still refuses all
six malformed inputs before HTTP.

After the correction, all 39 Rust runtime tests and 10 compiled doctests passed
again, together with formatting, strict SDK clippy, verified crate packaging
and the external archive consumer. These follow-up results are recorded in
`pr-rust-after.log`, `pr-fmt.log`, `pr-clippy.log`, `pr-rust-package.log` and
`pr-rust-consumer.log` in the same evidence directory. TypeScript source, bundle
measurements and embedded guides are unchanged by this correction. Hosted CI
must validate the new head before merge.
