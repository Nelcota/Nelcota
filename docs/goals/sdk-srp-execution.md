# SDK responsibility organization — execution

Date: 2026-10-19. Baseline: `4fd045bfb1f080eba1bc48ccd32e64c6872268e6`.
Branch: `refactor/sdk-responsibilities`.

Status: implementation and focused local validation complete. Final ordinary CI
and review disposition are recorded in the associated pull request.

## Scope and inventory

Review both SDK source trees, their public facades, tests, consumer packaging,
runtime assumptions and bundle checks. Apply SOLID to concrete responsibilities,
without redesigning the HTTP protocol or introducing speculative abstractions.
The [SDK ownership map](../../sdk/README.md) explains where future code belongs.

| Hotspot | Original size | Decision and result |
| --- | ---: | --- |
| Rust `auth.rs` | 862 lines | Separate models, link values and persistence adapters; keep the manager, lifecycle lock, accepted publication and account operations together in `auth/client.rs` |
| Rust `rest.rs` | 648 lines | Separate validated condition grammar and caller options from the consuming query builder |
| Rust `storage.rs` | 397 lines | Separate wire values/options, MIME inference, bucket administration and object transfer |
| TypeScript `storage/index.ts` | 296 lines | Separate wire contracts and `BucketFiles` transfer ownership from the bucket service/public facade |
| TypeScript auth inputs/options | Mixed into endpoint and lifecycle implementation | Move type-only contracts to `auth/types.ts`, preserving legacy re-exports |
| TypeScript query contracts | Mixed into the immutable builder | Move result/caller option types to `rest/query-types.ts`, preserving legacy re-exports |
| Shared JSON type | Authentication imported a REST-owned type | Move the shared value contract to `core/json-types.ts`, retaining the REST public export |

The existing transport pipelines, JSON precision/finite-value validation,
cancellation, browser journal, PKCE and schema-selection parser already have
cohesive responsibilities. Their algorithms are retained. Existing public
untyped defaults are preserved rather than changing consumer type inference.

## Compatibility evidence

Before extraction, the existing SDK suites passed on the baseline. No assertion,
fixture or threshold in those suites changes in this refactor.

| Check | Before | After |
| --- | ---: | ---: |
| Rust SDK tests | 34 passed | 34 passed |
| Rust documentation examples | 10 compiled | 10 compiled |
| TypeScript unit tests | 234 passed | 234 passed |
| TypeScript type tests | 16 passed, no type errors | 16 passed, no type errors |
| Rust SDK against real PostgreSQL/server | Not separately repeated | 8 passed, including generated models and RLS isolation |
| TypeScript real-server contracts | Not separately repeated | 34 passed, including generated declarations, auth, REST and storage |
| TypeScript package consumer | Not separately repeated | All four runtime/type entry points passed |
| TypeScript Node runtime | Not separately repeated | 8 checks passed |
| TypeScript explicit GC | Not separately repeated | 3 rounds of 1,000 cancelled callers; zero retained signals before completion; completed operations released |

A supplemental read-only comparison checked all **73 Rust items** in the three
extracted capabilities. Their tokens are unchanged except private sibling
visibility (`pub(super)`). All **202 TypeScript top-level declaration and
implementation bodies** retain their tokens. A compiler-symbol comparison and
runtime import check confirm the same exported values/types for all four public
TypeScript entry points. The checks include moved declarations, not only methods
left in their original files.

Strict SDK clippy, Rust formatting, rustdoc with warnings denied, TypeScript
checking and build pass. Native base/import lint reports zero errors/warnings.
Package installation verifies that the new private
modules are actually included and the existing public imports still resolve.

## Bundle evidence

The unchanged size script measures the complete compiled static import closure
before minification, at gzip level 9. No budget, compiler setting or size-check
logic changes.

| TypeScript entry | Before gzip bytes | After gzip bytes | Existing budget |
| --- | ---: | ---: | ---: |
| Root | 17,098 | 17,098 | 17,100 |
| REST | 9,387 | 9,387 | 9,550 |
| Auth | 11,212 | 11,212 | 11,250 |
| Storage | 7,334 | 7,376 | 7,400 |

Storage's independent file-transfer module adds 42 bytes. Other entries retain
their baseline size, including the root's two-byte reserve. There is no new
dependency, package-version change, publication or increase to any budget.

## Decisions and limitations

- Keep Rust child modules private and the existing facade exports explicit.
  Private helpers gain only sibling visibility; public signatures do not change.
- Preserve the lifecycle owner as a unit. Splitting a lock or accepted-session
  persistence between unrelated services would introduce risk without a testability
  benefit. Existing adapter interfaces already support real implementations.
- Do not add mechanical characterization tests that mirror the extraction.
  Existing lifecycle, HTTP, serializer, redaction, encoding and storage tests
  characterize the behavior and pass unchanged before and after the move.
- Reject the initial three-runtime-module TypeScript storage layout: it exceeded
  the root budget. Keep bucket administration with its public composition facade
  and file transfer in a separate owner instead. Remove duplicate root runtime
  re-exports while retaining the same symbols through existing feature facades.
- Initial `cargo check` reported two imports used only by documentation links;
  explicit intra-doc link targets removed those warnings without lint allowances.
- A local comparison helper initially treated import-ending semicolons as new
  Rust items and selected a TypeScript compiler-API path absent from the native
  compiler installation. Correcting the helper preserved the strict item/token
  comparison and used the already-installed panel compiler API. These preparation
  failures were not product regressions.
- An initial server test command selected a nonexistent `types` test target;
  Cargo refused it before running tests. The real SDK/server suite includes the
  type-generator scenario and is run under its actual `sdk_rust` target.

No migrations, backend auth/admin/PITR implementations, workflows, configuration
formats or documented HTTP/SDK contracts are changed. No release or deployment
is part of this work. Browser/platform/provider evidence must come from checks
that actually execute those targets; unit tests alone do not establish it.
Local browser binaries, Bun, Deno and Rust 1.88 are absent; the ordinary CI matrix
provides their separate evidence. Native smoke tests here use Node 24/Rust 1.99.

## Reproduction commands

Run suites sequentially with four Cargo jobs and two Rust/Vitest workers.
Database fixtures are disposable; never select production data for these checks.

```sh
cargo test --locked -p nelcota-client
cargo clippy --locked -p nelcota-client --all-targets -- -D warnings
RUSTDOCFLAGS='-D warnings' cargo doc --locked -p nelcota-client --no-deps
cargo fmt --all --check
scripts/test.sh rust --locked -p nelcota-server --test sdk_rust
cargo build --locked -p nelcota-server
cargo package --locked -p nelcota-client
python3 sdk/rust/scripts/package-test.py
python3 scripts/check-boundaries.py
python3 scripts/run-preset.py base
python3 scripts/run-preset.py performance/imports

cd sdk/typescript
npm run check
npm test -- --maxWorkers=2
npm run test:types -- --maxWorkers=2
npm run build
npm run size
npm run test:package
npm run test:runtime
npm run test:memory
NELCOTA_BIN=/absolute/path/to/nelcota npm run test:contract -- --maxWorkers=2
```

The Rust package and external-consumer check are recorded separately in the PR
after committing the files; uncommitted archive state is not used as final evidence.
