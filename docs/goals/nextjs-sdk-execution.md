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
| N01 | Corrected in candidate (`b09e1a9a`); documented residual | IDs from one browser cookie share a lineage. A sealed head names the one live key and its generation, and every sign-in/sign-up/OAuth/email-link/reset/sign-out becomes the head under the lineage lock. Superseded rows read as signed out (`superseded`) and become credential-free tombstones. A write re-checks the head before setting or clearing the cookie and withholds a stale publication. The proxy issues a credential-free bootstrap ID on `bootstrapPaths` (default login). Tests: memory store, mocked-pool PostgreSQL with two store instances, and real PostgreSQL with two pools. Covered: reordered responses (different/same user), stale publication withheld, delayed sign-out, no stale clearing, proxy bootstrap. **Residual:** requests without any cookie/bootstrap cannot be linked, so both sessions stay valid and the loser keeps encrypted credentials until expiry (pinned by a test). A lost winning response also lives until a later lineage sign-in/out or expiry. Tombstones do not revoke refresh tokens remotely. No real-browser multi-tab run. |
| N02 | Corrected in candidate (`688a9ed3`); provider run pending | Opt-in `storageRedirectOrigins` (validated HTTPS, loopback HTTP only in insecure development). Only GET/HEAD `/storage/v1/object/` requests follow redirects, manually, for at most 3 hops, each to a listed origin. From the first hop off the API origin only accept/range/conditional headers are sent. Unset/other destinations give `storage_redirect_refused`; too many hops give `storage_redirect_limit`. All other requests keep `redirect: 'error'`. Unit tests plus a real loopback HTTP redirect with Node fetch pass. **Not run:** real S3/MinIO with the Nelcota server. |
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
| Concurrency | Partial | PG instance/lock/loss cases pass. N01 reordering cases pass on memory, mocked-pool and real PostgreSQL (2026-10-24). Cookie-less residual documented. Real-browser tab and lost-response runs not done |
| Auth flows | Partial / not run | Password/logout tested in real Next; PKCE/replacement unit cases pass; complete provider/email/recovery flows not run |
| Adversarial | Partial | CSRF/redirect/encryption/key rotation/nonce/storage loss tested; full matrix still pending |
| Backend/RLS | Compatibility passed; final blocked (environment) | Identified older binary passes two-user/anonymous/integrity canaries; disk prevents final-source build |
| Storage/S3 | Partial; provider not run | N02 redirect policy has unit and loopback-HTTP tests; real storage/S3 integration is not certified |
| Packaging | Passed initial consumer | Packed install/exports/strict types and Next production build; registry version/minimum-base release still pending |
| Compatibility | Not run beyond initial versions | Node22, previous supported Next major and other browser engines not certified |
| Operations | Partial | EN/PT docs and npm audits pass; latency/memory/leak/soak measurements and ordinary CI not run |

No completion gate has been lowered to label this candidate finished.

## Correction/review checkpoint — stacked PR preparation

Production prerequisites are now in draft PR143, branch `fix/sdk-open-issues`.
This candidate merges that branch without rewriting history and targets it for
review, so the new package/goals remain separate from production corrections.
Main is unchanged. This checkpoint supersedes earlier disk-blocked server cells.

- Base SDK corrections:362 TS unit tests,20 type tests;46 executable Rust tests
  +10 doctests. Auth library57 passed and final-source server auth28 passed on
  disposable databases. The original32-case issue set produced29 failures before
  correction, plus two failing type regressions. Source size/security checks have
  not been weakened; the base PR remains draft for its explicit failed gates.
- Next58 tests passed, including real shared PostgreSQL and three new regressions:
  accepted-stream deadline ownership and empty URL query/fragment delimiters.
  The new cases failed on the prior candidate before correction. Build/check pass.
- Real Next16.4.3 production build/start and Chromium login/Action redirect,
  cookie merge, cache, credential-absence and logout checks passed again. The
  real negative Client Component import build failed as required; the valid
  application was rebuilt after deleting the owned probe route.
- Packed consumer: actual installation, all five entry points and strict TS
  declarations passed with the corrected local base SDK. Package stays private;
  a released base SDK version/minimum peer dependency is still a release gate.
- Scoped real backend/RLS and reserved-filter checks passed on a newly compiled
  current-source binary, SHA-256
  `2f2e8299d6f1bc26fc42e0e7dcb771a104494bd42850f42f2254018921cb550d`.
  The original REST filter implementation failed the actual backend assertion;
  the correction passed. Two users, anonymous isolation, forbidden cross-user
  update and SQL integrity checks passed. Storage stayed off; no disk SLO changed.
- A provider-fixture run initially passed its assertions but failed during forced
  database cleanup with an unhandled idle-pool termination event. The fixture now
  observes pool errors with stable codes, permits only its own expected cleanup
  termination, and prints success after cleanup. Other background errors set a
  failing exit code. Both before/after runs were repeated with the corrected
  fixture; the recorded pass is the zero-exit rerun, not the failed attempt.

Open gates remain: first-login intent/cookie ordering (N01), safe S3 redirect
policy/provider support (N02), full email/provider/auth/resource/runtime matrix,
base bundle caps and dependency audit blockers. Ordinary CI does not currently
run the new package's whole matrix; local framework/provider checks are separate
and cannot make a green inherited job into Next production approval.

The prior exploratory +100B base bundle allowance was reverted in the correction
branch. Main's budgets are retained and currently fail; earlier measurements are
historical, not current acceptance. Admin UI npm audit also has existing undici
advisories in main's unchanged lockfile. The workspace crypto-bigint advisory is
backend-only; no ignore rule or blind incompatible upgrade was introduced.

Final stacked update: PR145 is open against `fix/sdk-open-issues` (PR143).
The last base correction makes obsolete HTTP-date parsing UTC-independent; its
Sao Paulo timezone regression failed before correction and now passes. Final
base totals are363 unit tests and20 type tests. A CodeQL finding on a literal
server-test password was replaced with a runtime random password; the focused
server regression passed again. No suppression was added. The base size gate
remains failed at18302/17400B root,12102/11300B auth,9878/9550B REST and7896/7700B
storage gzip. Rebuilt current candidate:58 tests, check/build, real Next/Chromium
and packed external consumer pass. All earlier unresolved production gates remain.

## PR145 review corrections

Nine review findings were addressed on `feat/nextjs-sdk-g11` as separate commits:
same-key PostgreSQL owners queue in-process and poll `pg_try_advisory_lock`
within the store timeout, so waiters hold no pooled connection and no backend
stays blocked. The example now reads bodies before the lease. Unreadable,
mismatched or just-expired rows read as signed out, and writes replace them; the
proxy clears the stale cookie. Writes rotate to a fresh ID for unknown cookies
and identity changes (`lease.rotate`). A 429/5xx pre-refresh no longer fails a
write. Auth deadlines derive from the lease budget (`leaseTimeout >= 2 *
timeout`). There is a validated `basePath` with path-only callback matching.
Public `%25` paths pass the proxy. Sealing v2 uses HKDF per-message keys and v1
still opens. The Server Action method/Origin reliance is documented.

Results: the Next package has 90 passed tests, with `check` and `build` passing.
The real PostgreSQL integration case was **not run**: Docker and a local
PostgreSQL were unavailable, so it stayed skipped and is not counted as passing.
Real Next/Chromium, packed-consumer and backend smoke checks were not rerun for
these corrections. Open gates N01/N02 are unchanged.

## N01/N02 corrections — 2026-10-24

`b09e1a9a` resolves N01 within the limits recorded above, and `688a9ed3`
resolves N02 apart from the provider run. Both are local commits on
`feat/nextjs-sdk-g11` and have not been pushed. Behaviour changes: a row-less
well-formed cookie is no longer cleared by a write that publishes nothing (it
may be a bootstrap ID). A login now replaces the old row with a tombstone
instead of deleting it. `SessionLease.rotate` accepts an optional retained row.
Session-bearing reads perform one more store read (the lineage head).

Results: `NELCOTA_NEXT_TEST_DATABASE_URL=<disposable PostgreSQL on 127.0.0.1>
npm test` gave **116 passed, zero skipped**, including both real PostgreSQL
cases. `npm run check` and `npm run build` pass. The temporary cluster was
stopped and deleted. The new N01/N02 tests failed when the head check, the
publication check, header stripping or the hop limit was disabled. Real
Next/Chromium, the packed consumer, backend smoke and S3/MinIO provider runs
were not repeated or performed for these corrections.
