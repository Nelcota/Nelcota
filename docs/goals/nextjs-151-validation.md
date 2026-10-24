# Next.js SDK issue 151 validation follow-up

This ledger supplements the historical [execution record](nextjs-sdk-execution.md)
and [publication checkpoint](sdk-release-completion.md). It does not replace the
original results or treat controlled provider endpoints as live provider evidence.

## Scope and closure

On 2026-10-24, the maintainer explicitly requested skipping live Google/GitHub
and AWS S3/R2 HTTPS validation. Those original issue gates remain unchecked.
Issue [#151](https://github.com/Nelcota/Nelcota/issues/151) remains open while
those results are unavailable.

## Confirmed pool starvation

The initial sustained load failed with `Session connection failed`, caused by
`timeout exceeded when trying to connect`. Sixteen concurrent writable contexts
shared a pool of four PostgreSQL connections across two store adapters. An
owner held its session connection while lineage lookups and nested lineage
ownership attempted to borrow another connection. All pool slots could be held
by callers waiting for that extra connection.

The PostgreSQL lease now supports related-record reads and nested ownership on
its existing connection. The integration uses these capabilities when present;
custom stores retain the previous fallback contract. Nested failure poisons the
parent owner; a nested lease inherits parent cancellation. Nested ownership must
finish before the parent continues, and callers must keep a consistent lock
order. SQL writes remain separate durable autocommits.

Regressions cover a one-connection real PostgreSQL pool, nested cleanup,
persistence failure, parent timeout, and refusal of late writes. The load
campaign checks isolated RLS identities on every operation, a connection ceiling,
latency bounds, RSS growth after warmup, empty waiters/idle ownership after drain,
and zero retained advisory locks. It records measurements rather than claiming
an unlimited-duration leak proof.

## Reproduction

Run each suite separately. Start the shared fixture with `scripts/test.sh db`.
Set `NELCOTA_NEXT_TEST_DATABASE_URL` to that disposable loopback fixture.

```sh
npm --prefix sdk/nextjs run check
npm --prefix sdk/nextjs run build
cd sdk/nextjs
NELCOTA_NEXT_TEST_BINARY=/absolute/path/to/target/debug/nelcota \
  NELCOTA_NEXT_SOAK_SECONDS=600 \
  node --conditions=react-server scripts/backend-smoke.mjs > backend-evidence.json
node scripts/compatibility-smoke.mjs
```

The compatibility runner copies the built SDK to a disposable consumer and
installs pinned Next 15.5.28 with a PostCSS 8.5.31 override. The first unmodified
Next 15 install failed the mandatory audit because its pinned PostCSS version
was vulnerable; the override stays within PostCSS major 8 and the audit gate
remains enabled. It adapts the example's Next 16 `proxy.ts` to Next
15 `middleware.ts` with `runtime: 'nodejs'`, then runs type checks, production
server-only rejection/control builds, and the same full browser/framework smoke.
The published 0.1.0 peer range remains Next 16; this fixture is compatibility
validation rather than an assertion that registry metadata already supports 15.
Next 14 and earlier remain outside the declared scope and are listed as
unsupported by the [upstream support policy](https://nextjs.org/support-policy).

## Evidence status

Completed executions are recorded below. The reusable CI
workflow runs all three browser engines for the Next 15 fixture and a shorter
120-second pool contention campaign on the freshly built backend, preserving its
JSON report as an artifact. Live providers skipped above are never substituted
with local fixtures in this ledger.

## Completed local runs

- Next 15.5.28 / React 19.3.1 / Node 24.22.1 / Chromium: audit (zero
  vulnerabilities), type checks, production boundary control/probe/rebuild, and
  the complete framework smoke passed. PostCSS is overridden to 8.5.31; the
  framework harness uses controlled API responses and does not prove RLS.
- Next SDK: 121 tests passed, zero skipped, including three real PostgreSQL
  integration cases. Type checking and production SDK compilation passed.
- The initial core pool correction passed 600.04 seconds with 16 workers,
  two independent adapters and a four-connection pool: 839,156 operations,
  1,398.59 operations/second, p50 6.64 ms, p95 23.53 ms, p99 164.21 ms,
  zero errors and zero retained advisory locks. RSS growth after warmup was
  839,680 bytes. [Full measurements](results/nextjs-151-soak-core.json) include
  every sample and compiled module hashes. This run predates the subsequent
  nested-parent cancellation hardening; its final-revision run is separate.

The server binary SHA-256 is
`992e013d3122dcdcf6ca169223035d4c76dbf170501ee87055e2f36b50a9619a`,
built from the server sources in baseline
`976870c858faed87d2d65b0258e949a0ee5be8c1`. This follow-up changes SDK code and
validation only, with no backend source modifications.

## Adversarial evidence map

| Gate | Evidence source and boundary |
|---|---|
| CSRF and forwarded headers | Final backend fixture: missing/foreign/cross-site origins fail before persisted session mutation, including forged Host/forwarded headers. |
| RLS | Final backend: two users plus anonymous controls; forged owner insertion is rejected, cross-user updates/deletes return no rows, SQL integrity is preserved. |
| Session integrity | Final backend: forged cookie, tampered encrypted envelope and expired row have no RLS access; escaped contexts and component writes are refused. |
| Callback and redirect | Final backend fixture: foreign callback path and malformed state are refused; unsafe OAuth return path becomes `/`. The separate real-backend PKCE contract rejects foreign browsers and callback replay with controlled provider endpoints. |
| Revocation | Backend refresh token is refused after remote logout. Access JWT remains valid until expiry, as documented in `crates/auth/src/sessions.rs`; local logout clears the cookie and fences old browser state. Immediate access-JWT revocation is not claimed. |
| Persistence and outage | Cookie publication error is surfaced after a real accepted metadata update; stopping the actual backend exposes transport failure, offline logout clears local state, and advisory locks drain. Real PostgreSQL regressions terminate a connection and fence late/nested writers. |
| Network/deadline/429/5xx cases | SDK unit tests use explicit transport faults; these are deterministic fault-injection evidence, not claims that live external providers were exercised. |
| Browser caching, secrets and concurrency | Actual Next production builds/browser checks enforce the server-only boundary, private responses, credential-free HTML, and reversed/lost/natural multi-tab replies. The browser transport fixture is controlled; backend authorization comes from the RLS controls above. |

The initial remote-logout probe incorrectly expected an access JWT to become
invalid immediately. That failed assertion was corrected to the documented
stateless-token contract and replaced with direct refresh-revocation and local
cookie-replay checks; no backend revocation behavior was changed.

- Final SDK revision `af64ebe781001abfaa617feb3e19322fd0f7ac1c`: a separate
  120.03-second load passed 180,101 operations (1,500.84/second), p95 23.09 ms,
  p99 161.70 ms, at most four connections, zero errors and zero retained locks.
  RSS growth after warmup was 249,856 bytes. See the
  [final revision load report](results/nextjs-151-final-soak.json).
- The [final negative report](results/nextjs-151-final-negative.json) passed
  all 22 controls, including actual server shutdown, failed cookie publication
  after a real accepted update, callback/redirect constraints and refresh-token
  revocation. Its scenario extension does not change the load path or SDK code.
- External packed consumer: all five exports and strict TypeScript declarations
  passed after the connection-reuse change (27 files, 40,834 packed bytes).

Each JSON report includes the binary SHA-256 and compiled SDK module identities.
The reusable workflow preserves the same final-backend JSON evidence on each
successful run. Hosted checks for the final PR revision are available from
[PR #166](https://github.com/Nelcota/Nelcota/pull/166/checks).

The final Next 15 local rerun also inspected every production client JavaScript
chunk for a build-time random server key, server-session implementation markers
and credential canaries; all chunks passed.
