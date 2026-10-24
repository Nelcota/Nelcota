# Changelog

Package releases use Semantic Versioning. Registry availability requires a
successful publication; a source version or Git tag alone is insufficient.

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
