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

Results are recorded after the final executions complete. The reusable CI
workflow runs all three browser engines for the Next 15 fixture and a shorter
120-second pool contention campaign on the freshly built backend, preserving its
JSON report as an artifact. Live providers skipped above are never substituted
with local fixtures in this ledger.
