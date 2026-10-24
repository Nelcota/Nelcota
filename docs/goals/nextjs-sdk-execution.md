# G11 execution record

Status: **in progress — prototype; not approved for production/publication**.
Checkpoint: 2026-10-24 UTC. Planning baseline:
`84a55c3bb8c7698a0f8d0f6dd1a01153b748b925`.

The requested goal and its initial execution are implemented. This is not a
claim that the complete G11 matrix passed. See [the goal](nextjs-sdk.md),
[English setup](../../sdk/nextjs/README.md) and
[Portuguese setup](../../sdk/nextjs/docs/quickstart.pt-BR.md).

## Branches and artifacts

- Prerequisites: `fix/auth-caller-token-refresh`, through `e531c6e1`.
- Goal/candidate: `feat/nextjs-sdk-g11`, code checkpoint `39e5753a`.
- Updates-panel changes remain separate on `fix/updates-readiness-guidance`.
- Existing private audit work in another worktree was not staged or published.
- Commits are local. No new PR/CI run, publication, merge, release, VPS access
  or deployment was performed by this goal.

| Commit | Purpose |
|---|---|
| `d54d51ee` | #133 refresh error classification and focused Rust/HTTP regressions |
| `0b541ef1` | #132 caller-token identity, regressions, guides and explicit size allowance |
| `e531c6e1` | Rebuilt embedded SDK guides, separate generated-assets commit |
| `4caa2d42` | G11 scope, negative matrix and completion gates |
| `11add769` | Unpublished App Router candidate, provider, examples, tests and EN/PT docs |
| `39e5753a` | Identity-replacement/stream regressions and explicit remaining limitations |

Private local logs: `/workspace/artifacts/sdk-issues-fixes/`. These logs are
supplemental and can expire with the workspace; commands, results and limits
are recorded below. No credentials from the maintainer's VPS were used.

## Decisions and reasons

1. Reuse `@nelcota/client` rather than duplicate HTTP/auth/model logic. Initial
   framework candidates are Next 16.4.3, React 19.3.1 and Node 24.19.0. Other
   versions require evidence, not just a broad engines/peer range.
2. Finish #132/#133 locally first. An explicit caller token must be authoritative
   for user reads/writes as well as REST/storage. A null token must not select
   a stored user's identity. Invalid refresh grants need their terminal error.
3. The minimal #132 correction exceeded former gzip limits by 18 B (root) and
   61 B (auth). Record an explicit **+100 B allowance** in those two entries,
   preserving REST/storage budgets and all functional/security checks. Broad
   experimental parser/lifecycle refactors were reverted to keep the fix narrow.
   This is an actual budget adjustment, not a pass against the former limits.
4. An opaque host-only HttpOnly cookie identifies encrypted server state. Use
   AES-256-GCM with application/API/key binding and up to three rotation keys.
   No access/refresh token is serialized to browser results or forwarded cookies.
5. Production requires authoritative shared storage. PostgreSQL session advisory
   locks serialize owners across instances, while each save autocommits before
   resolving. A transaction spanning the callback would lose accepted publications
   on rollback. Transaction-pooling proxies are unsupported. Memory is explicit,
   bounded development-only storage, refused by default in production.
6. Server Components/proxy are read-only and validate users against auth. Unsafe
   auth contexts require the configured Origin; Host/forwarded headers do not
   establish trust. Only the explicit GET OAuth callback permits code exchange.
7. Drain accepted auth publications before closing a writable context; surface
   persistence errors and abort stale owners. Publish accepted cookies even when
   Next's `redirect()` throws. An accepted response stream remains caller-owned.
8. Use disposable bounded local fixtures only. Rust uses four Cargo jobs/two
   test threads; Vitest uses two workers. Rust, Vitest and audits ran sequentially.
   The full server build stopped below 300 MiB disk reserve. Only identified
   inactive compiler/download caches were removed; sources, binaries and prior
   evidence were preserved. Cleanup manifests remain in the private log folder.
9. Keep `private: true`, no registry install recommendation, and no publication.
   The public base SDK 0.2.1 does not contain #132; a new base SDK release/minimum
   dependency is a required later gate. Do not silently advertise the prototype
   as complete because its small initial tests pass.

## Reproduction and results

### Prerequisites

- #132: all 18 new caller-token regressions failed against the baseline and
  passed after correction. Both combined/standalone clients, sync/async/null
  sources, stored-identity coexistence, cancellation and source failure covered.
- #133: pure boundary regression failed before correction (422 instead of400).
  A real Axum TCP HTTP regression also failed with **422 vs expected400** when
  restoring the old classification, then passed with the correction. Missing
  and empty tokens remain422; oversized ASCII/multi-byte grants return400
  `invalid_grant` and `Cache-Control: no-store` before any database access.
- Final `cargo test --locked -p nelcota-auth --lib`: **57 passed, zero failed**.
- Base SDK: **328 unit tests +18 type tests passed**. Check, build and external
  packed JS/TS consumer passed. No public package version was published.
- Gzip: root **17418/17500 B**, auth **11361/11400 B**, REST **9523/9550 B**,
  storage **7683/7700 B**. Only root/auth limits changed as recorded above.
- Guide translations/check: passed. **37 guide tests passed**; panel build and
  `cargo fmt --all --check` passed. Embedded assets were committed separately.
- Added full-server auth integration regression: **not run — blocked
  (environment: disk reserve)**. The library HTTP test is separate evidence;
  it does not replace a final-source full-server integration run.

### Next candidate

- `npm --prefix sdk/nextjs run check` and `run build`: passed.
- Final `NELCOTA_NEXT_TEST_DATABASE_URL=... npm --prefix sdk/nextjs test`:
  **55 passed, zero failed, zero skipped** when the disposable database is set.
  Without it the real PostgreSQL case is explicitly skipped, not passed.
- Real PostgreSQL: two independent pool/store instances; durable read during
  an owner's lock; same-key serialization; unrelated-key progress; forced
  connection loss and subsequent owner recovery. Database removed in `finally`.
- Real Next **production webpack build/start** + Chromium: Route Handler cookie
  merge; private cache headers; verified Server Component; Server Action login
  + `redirect()` retaining cookie; no session credentials in HTML; logout.
  Cross-origin login was refused before the fixture API was called. This is a
  transport fixture, **not RLS evidence**.
- Real framework negative build: importing `/server` from a Client Component
  failed with the server-only boundary error, as required. Probe source removed
  and the valid production app rebuilt successfully afterwards.
- Packed external consumer: actual tarball installation, all five entry points
  imported, strict TypeScript declarations and negative type assertions passed.
  The consumer omits optional native packages; the real framework build above
  separately used the installed build toolchain. No files from node_modules,
  tests, local env or build-cache directories entered the SDK tarball.
- Real backend compatibility: supplied frozen Nelcota0.5.3 binary SHA-256
  `d71e24e7d3756cdcecaa9f2462859257140bb7e41a1c5e5edfe9b0ac532a1e9d`.
  Two real signups/verified users, isolated reads, anonymous empty result,
  cross-user update empty, and SQL integrity passed on a disposable database.
  **This binary predates the local #133 fix.** This is compatibility evidence,
  not a claim of final-source backend acceptance. Storage was off; no storage
  disk threshold was reduced to force the test through.
- npm audits: **zero known alerts** for both Next candidate and base TypeScript
  package locks at this checkpoint. This does not certify absence of defects.

### Failed attempts and corrections during this checkpoint

- Initial new Rust HTTP fixture failed to compile because reqwest JSON helpers
  were not enabled; it then exposed an uninstalled TLS provider in the fixture.
  Used existing dependencies/body decoding and the project's provider pattern.
  Both were test-fixture defects; final before/after evidence is the actual
  status assertion failure/pass, not those setup errors.
- The first real PostgreSQL run had passing assertions but **an unhandled
  connection error**, so the run failed. The new adapter now observes checked-out
  connection errors, aborts the owner, refuses later writes, destroys lost
  connections, reports unlock failures and removes its event listener. Dedicated
  regressions and the real provider case subsequently passed without that error.
- Initial external consumer failed on an invalidated local npm cache; it now
  owns a fresh disposable cache. Its type-check script initially used the wrong
  compiler launcher for the repository alias; corrected to `tsc6`, then passed.
- The stream test initially selected reserved bucket name `public`; changed
  only the fixture name to `assets`. Final stream assertion passed unchanged.
- Vite's existing large-chunk warning remains a warning; no limit was changed.

## Finding ledger and next execution order

| ID | Status | Evidence / required action |
|---|---|---|
| N01 | Open — publication blocking | Two first logins without a pre-existing SID get separate store keys; response cookie ordering can select an older identity. Define bootstrap/ownership and reject stale identity publication, then test tabs/processes/response reordering. Existing stable-SID tests do not prove this case. |
| N02 | Open — completion blocking | `Integration.#client()` enforces `redirect: error`; storage redirects to presigned S3 URLs therefore fail. Add an explicit destination policy and credential stripping with provider/redirect tests; never enable unrestricted credential-bearing redirects. |
| N03 | Corrected in candidate | A killed PostgreSQL connection previously emitted an unhandled error; final provider and event/late-writer regressions pass. |
| N04 | Corrected in candidate | Inspection found redirect exceptions could skip cookie publication and plain decoded paths could normalize to `//...`; finally publication and canonical-path checks are covered by tests. |
| N05 | Corrected in candidate | Bind callback to random browser state; wrong state leaves verifier intact, valid exchange consumes it, duplicate callback rejected. Successful replacement login clears pending OAuth and receives a new absolute lifetime; stream consumers retain their accepted transfer. |

Continue in this order: resolve N01, resolve N02, complete the auth-flow and
adversarial matrix against final-source backend, run compatibility/resource
checks, integrate candidate CI and review. Do not broaden into unrelated panel,
backend or audit work. Keep unrelated worktrees intact.

## Completion matrix at this checkpoint

| Cell | Verdict | Evidence/remaining work |
|---|---|---|
| Base prerequisites | Partial; blocked (environment) | Focused regressions/unit/package checks passed; full-server auth build stopped by disk, local fixes not reviewed/merged |
| Next read-only | Passed for initial fixture | Actual production Server Component + runtime mutation guard; final-source backend integration still needed |
| Next writable | Passed for initial fixture | Real Route Handler/Server Action cookie publication, redirect and CSRF checks |
| Browser boundary | Passed for initial fixture | Real invalid Client Component build refused; HTML credential checks; full client bundle canary/resource matrix remains |
| Concurrency | Failed completion gate | PG instance/lock/loss cases pass, but N01 and full tab/process/lost-response matrix remain |
| Auth flows | Partial / not run | Password/logout tested in real Next; PKCE/replacement unit cases pass; complete provider/email/recovery flows not run |
| Adversarial | Partial | CSRF/redirect/encryption/key rotation/nonce/storage loss tested; full matrix still pending |
| Backend/RLS | Compatibility passed; final blocked (environment) | Identified older binary passes two-user/anonymous/integrity canaries; disk prevents final-source build |
| Storage/S3 | Not run; N02 open | Streaming unit case passes; real storage/S3 integration is not certified |
| Packaging | Passed initial consumer | Packed install/exports/strict types and Next production build; registry version/minimum-base release still pending |
| Compatibility | Not run beyond initial versions | Node22, previous supported Next major and other browser engines not certified |
| Operations | Partial | EN/PT docs and npm audits pass; latency/memory/leak/soak measurements and ordinary CI not run |

No completion gate has been lowered to label this candidate finished.
