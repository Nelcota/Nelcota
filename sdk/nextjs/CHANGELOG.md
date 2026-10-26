# Changelog

Package releases use Semantic Versioning. Registry availability requires a
successful publication; a source version or Git tag alone is insufficient.

## Unreleased

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
