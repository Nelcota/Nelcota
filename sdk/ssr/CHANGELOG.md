# Changelog

Package releases use Semantic Versioning. Registry availability requires a
successful publication; a source version or Git tag alone is insufficient.

## Unreleased

### Upgrade notes

- Rolling deploys and rollbacks between 0.1.x and this version are safe: both
  lock the same advisory keys (`hashtextextended(key, 0)`), write envelopes with
  the same key id, keep the sealed format, schema and cookie names, and apply the
  same lineage-head check, so a row's liveness reads the same on either version.
  While mixed, a 0.1.x instance still tombstones a rotated-away row immediately and
  skips upstream revocation of replaced sessions; both are safe, only less tidy.
- `PostgresSessionStore` now caps concurrent write leases at the pool's `max`
  minus one by default, so reads always find a connection, and lets a writer
  wait up to `leaseTimeout` (60 s) for a busy session instead of 5 s. Tune with `maxLeases` and `lockTimeout`.
- `privateResponse` sends `Referrer-Policy: same-origin` instead of `no-referrer`.
- App code: the SvelteKit guard's `next` parameter now includes `paths.base`;
  drop any manual prefixing in login/refresh actions in the same deploy (only
  apps with a base path are affected).
- `error.name` of `SessionError` is now `NelcotaSessionError` (was
  `NelcotaNextSessionError`); the exported `SessionError` is unchanged.

### Added

- `PostgresSessionStore(pool, { timeout, leaseTimeout, lockTimeout, maxLeases })`;
  the positional `(pool, timeout, leaseTimeout)` form still works.
- `sql/session-cleanup.sql`: a bounded statement to schedule for expired rows,
  tombstones and lineage heads.
- `Integration.oauthCallback(cookies, request, work)`; `write(..., true)` is
  deprecated.
- `onBackgroundError` option, `legacyEnvelopes` option (default true; v1
  envelopes are deprecated), `DEFAULT_REFRESH_PAGE`/`DEFAULT_REFRESH_ENDPOINT`
  exports, and `handle({ appDir })` plus a `basePath` property for SvelteKit.
- A dedicated `sdk-ssr-check` workflow runs unit and PostgreSQL integration tests
  against a PostgreSQL service. `NELCOTA_SSR_TEST_DATABASE_URL` replaces
  `NELCOTA_NEXT_TEST_DATABASE_URL` (still accepted); without it the integration
  suite is skipped locally and fails in CI.

### Changed

- Write leases no longer starve rendering: at most `maxLeases` writes hold pooled
  connections at once. A write still owns its session for its whole callback,
  which keeps refresh-token rotation serialized across requests and instances.
- A server-cancelled lock wait (SQLSTATE 57014) is an ordinary timeout: the
  statement timeout is restored, any advisory lock is released, and the
  connection returns to the pool instead of being destroyed.
- Sign-in publication is ordered: the new row is written first, then the lineage
  head moves, and the replaced row is tombstoned only when the whole write
  succeeds (both stores). Replaced lineage heads are retired only after success,
  concurrently, with failures reported to `onBackgroundError`. A failure to
  tombstone the replaced row is reported the same way instead of failing the
  write (custom stores receive it through the new `ExclusiveOptions`).
- A sign-in that replaces a signed-in session revokes the replaced upstream
  session (auth logout), best effort and without failing the sign-in.
- SvelteKit `server()` loads set `Cache-Control: private, no-store` and
  `Vary: Cookie` through `event.setHeaders`, once per request.
- Envelopes may carry an HKDF-derived key id, which this version accepts when
  opening. New envelopes still carry the SHA-256-prefix id so 0.1.x can read them;
  a later release will switch writing to the HKDF id once no 0.1.x reader remains. One size bound, derived from the 64 KiB
  plaintext cap, now governs envelopes and stored rows; the deployed SQL CHECK
  (131072) stays as an outer bound.
- `refreshSession()` no longer sends the unused `X-Nelcota-Next` header. The
  guard's refresh page and the browser's refresh endpoint share exported
  defaults.
- Neutral naming for framework-agnostic errors and messages; frozen wire strings
  (`nelcota-next/...`, the `nelcota_next` schema, storage keys) are unchanged and
  marked as such.
- Merged single-function modules and moved the test-only `requiredValue` helper
  out of the package; regrouped tests by subject.
- The core's lineage tests and its real-backend smokes (`backend`, `storage`,
  `auth`, `oauth`) moved here from `@nelcota/nextjs`; `sdk-ssr-check.yml` runs the
  backend matrix and S3 storage smokes.

- Replace Node crypto/Buffer in the session core with standard Web Crypto and
  canonical base64url encoding. Existing v1/v2 rows, cookie names and store/lineage
  hashes remain compatible. Keep authoritative shared storage on Edge; document
  the decision against a stateless token-cookie mode and its replay trade-offs.

### Fixed

- Classify session-store read failures as unavailable in authentication guards,
  producing 503 without clearing cookies or redirecting users to sign in.
- Retiring a rotated-away session row no longer counts against the write's
  `leaseTimeout`: it runs once the new row and lineage head are durable, with
  its own budget of one statement timeout per row, and a failure or timeout
  reaches `onRetireError` (`onBackgroundError` in `Integration`) instead of
  failing the write. The connection is then discarded rather than pooled.

## 0.1.0 — 2026-10-27

### Added

- Framework-agnostic session core extracted unchanged from `@nelcota/nextjs`:
  `Integration` (read/write/forget/callback), sealed session state with
  lineage and tombstones, the PostgreSQL and development stores, the browser
  refresh helper, `safeReturnTo`, `privateResponse`, and `createGuard` for
  authentication routing. Cookie values, sealed rows and the `nelcota_next`
  schema stay compatible with `@nelcota/nextjs` 0.1.x.
- `Integration.create` refuses to run where `document` exists, replacing the
  Next-specific `server-only` import.
- `@nelcota/ssr/sveltekit`: a SvelteKit 3 adapter with `handle` for
  authentication routing, `server` for load functions, `action` for form
  actions, `route` for endpoints and `callback` for OAuth. Pages it marks
  private use `Referrer-Policy: same-origin`, so native form POSTs keep their
  `Origin` header (`no-referrer` makes Chromium send `Origin: null`).
