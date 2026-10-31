# Changelog

Package releases use Semantic Versioning. Registry availability requires a
successful publication; a source version or Git tag alone is insufficient.

## Unreleased

The next release is a minor, 0.2.0 (unreleased): the core now ships as a
dependency and the integration gains new properties.

### Added

- Sign-up confirmation from the browser that signed up keeps the chosen
  password: the sign-up's PKCE verifier lives in the sealed session (through
  `@nelcota/ssr`).
- `NextIntegration` exposes its validated `origin` and `basePath` (read-only),
  for absolute redirects that never depend on raw environment values or headers.

### Changed

- Tests and smokes that exercised only the session core moved to `@nelcota/ssr`
  (`sdk/ssr/test/lineage.test.ts`, `sdk/ssr/scripts/*-smoke.mjs`); the proxy
  bootstrap tests stay here and use only public `@nelcota/ssr` exports.

### Fixed

- Private proxy responses send `Referrer-Policy: same-origin` instead of
  `no-referrer`, under which Chromium sends `Origin: null` with native
  same-origin form POSTs and the CSRF check refuses them.
- The authentication proxy returns 503 when its session store is unavailable,
  retaining the browser cookie and the existing session.
- `dist/memory-store.js` (`/testing`) is listed in `sideEffects`, like the other
  `server-only` entry points.
- The App Router example honors the proxy's `next` return path after sign-in and
  session renewal, shows a generic message for invalid credentials, maps refused
  and unavailable session errors to generic pages, does not cache a failed
  configuration, enables `allowInsecureDevelopment` only for a plain-HTTP
  loopback origin, loads the development store only when it is selected, and
  no longer redirects with an unvalidated `APP_ORIGIN`.

### Changed

- The session core moved to the new framework-agnostic `@nelcota/ssr` package,
  installed automatically as a regular dependency (`~0.1.0`); applications do
  not install or import it. The package entry points, options and behavior are
  unchanged, and existing cookies and session rows remain valid.
  `sql/session-store.sql` now ships in `@nelcota/ssr`.
- The documented singleton creates the integration on first use and retries
  after a failed configuration instead of rejecting at module load.
- Test evidence and publication receipts moved to `docs/verification.md`; the
  README documents the proxy's per-request auth check, including prefetches.
- The pinned Next 15 compatibility consumer was removed from CI; the peer range
  has always been Next 16.

### Removed

- The internal `dist/required-value.js` helper, which was not an entry point.

## 0.1.2 — 2026-10-26

### Fixed

- The authentication proxy no longer clears a stale cookie that has no stored
  row (a bootstrap or pre-login ID). A sign-in response still in flight may have
  replaced it, and clearing it signed the user out.

## 0.1.1 — 2026-10-24

### Fixed

- Reuse the PostgreSQL session owner's connection for lineage reads and nested
  lineage locks, preventing pool starvation under concurrent writable requests.
- Queue cross-instance advisory-lock waiters on PostgreSQL with a server-side
  acquisition timeout, preventing starvation by a hot polling instance.
- Inherit parent cancellation for nested owners and destroy failed connections.

### Added

- A pinned Next 15 compatibility consumer and sustained final-backend pool
  measurements, with adversarial RLS/session controls and CI evidence artifacts.

## 0.1.0 — 2026-10-24

### Added

- Request-scoped App Router integration for Server Components, Route Handlers,
  Server Actions, OAuth callbacks, navigation proxies and browser refresh.
- Opaque HttpOnly host-only cookies, encrypted server session envelopes, key
  rotation, CSRF/origin checks, safe return paths and explicit lifecycle errors.
- Shared PostgreSQL session ownership with bounded locks, deadlines and stale
  identity fencing across tabs and app processes. An explicit loopback-only
  development store is available separately.
- Password, signup/confirmation, recovery, magic-link and S256 PKCE operations
  composed over `@nelcota/client` 0.2.2 or later, without exposing session tokens
  through auth results or Server Component props.
- Explicit storage redirect origins with bounded hops, stripped credentials
  and preserved byte-range headers.
- Packed consumer checks and automated real Next/browser, PostgreSQL, backend,
  STARTTLS email and S3-compatible provider contracts.

### Limits

- App Router on Node is supported. Pages Router, Edge, previous Next majors
  and arbitrary S3 provider configurations require separate validation.
- Applications must bootstrap the browser cookie before concurrent first
  sign-ins. Cookie-less requests have no shared browser lineage. Reversed or
  lost login replies fail closed; the browser may need to sign in again.
- PostgreSQL session locks require direct connections or session pooling.
  Transaction pooling is unsupported. Applications own pool shutdown and
  expiration cleanup.
