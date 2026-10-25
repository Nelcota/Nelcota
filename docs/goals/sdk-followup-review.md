# TypeScript and Rust SDK follow-up

This follow-up reviews the remaining supported SDKs after Next.js 0.1.1.
Live Google/GitHub providers and AWS S3/R2 HTTPS validation remain explicitly
excluded at the user's request. Issue #151 stays open for those two items.

## Confirmed defects

- TypeScript: PKCE used a process-wide key even for independent server storage
  adapters. Holding one adapter's verifier write blocked another request's OAuth
  setup and logout. The regression failed before the fix. Verifier creation,
  consumption and logout now share an adapter/key queue on servers. Shared
  adapters still serialize; browser/worker Web Lock names remain compatible.
- Rust: a truncated HTTP error body changed a definite 401 into a network error
  and retried it. The real TCP regression failed before the fix. Error metadata
  reads now discard interrupted bodies, preserving HTTP status and Retry-After.
  A stalled error body still obeys its deadline and cancellation. A truncated
  successful response remains a network failure.

## Patch candidates and compatibility

- `@nelcota/client` 0.2.3: upgrade the application lockfile and rebuild server
  consumers. Public exports and server requirements are unchanged. Next.js
  0.1.1 already accepts this patch through its `^0.2.2` peer requirement.
- `nelcota-client` 0.1.6: update Cargo.lock and rebuild. Public imports, native
  Tokio support, Rust 1.88 and the existing server protocol remain unchanged.

Publication requires successful tagged workflows and fresh registry consumers;
source version numbers alone are not evidence of registry availability.

## Local evidence

- TypeScript: 374 unit tests, 20 type assertions, compiler, build, all four
  entrypoint size budgets and installed-package checks passed. Node 26 runtime
  smoke and memory/cancellation retention checks passed.
- Rust 1.99: 52 executable tests and 10 doctests passed; the transport suite
  includes 19 passing cases.
  SDK Clippy passes with warnings denied. The new socket cases cover 401, 503
  with Retry-After 90, and truncated successful responses.
- The new server PKCE regression covers both available and absent Web Locks,
  independent adapters and shared-adapter logout cleanup. The worker regression
  verifies the retained PKCE Web Lock name without contacting a provider.

These are bounded local regressions, not live-provider or soak evidence.

The bundled guide rebuild keeps version references aligned. Existing localized
prose only changes version identifiers; the new changelog fragment retains
canonical English to honor the repository language preference.
