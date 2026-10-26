# Changelog

Package releases use Semantic Versioning. Registry availability requires a
successful publication; a source version or Git tag alone is insufficient.

## Unreleased

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
