# SDK documentation and example alignment

Review checkpoint: 2026-10-24, after the published SDK corrections in #166/#167.
The current application dependencies are `@nelcota/client` 0.2.3,
`nelcota-client` 0.1.6 and `@nelcota/nextjs` 0.1.1. Registry availability was
queried again for this review. Existing dated release/soak evidence is retained.

## Corrections

- Update the root/SDK/example indexes, current-status and upgrade guides to the
  published packages. Remove obsolete claims that Next.js 0.1.1 is unavailable.
- Add current TypeScript/Rust patch upgrade steps. Align refresh-reservation
  documentation with every definite 4xx rejection except `invalid_grant`.
- Align the Next quickstart's lock queue with the published fair PostgreSQL
  queue and connection reuse. Distinguish the Next 16 peer range from the pinned
  Next 15 compatibility consumer, without expanding the supported peer range.
- Make the App Router example a standalone, locked registry consumer with its
  own dependencies, setup guide and application-local output tracing. Checkout
  smokes retain explicit source linking; an external example override exercises
  installed registry packages without linking SDK source.
- Keep Rust REST example identities separate: an explicit caller token takes
  precedence over password credentials. Password-only runs require both fields
  and revoke their own session after removing their demo row. The Todo demo now
  checks logout failures and documents installation beside the copied script.
- Extend the existing documentation checker to Next.js install instructions and
  example manifest/lock consistency, rejecting local checkout SDK dependencies.
- Maintain bundled guide catalogs and rebuild their embedded assets separately.
  New prose remains English under the repository language preference.

## Validation

[Bounded example results](results/sdk-docs-registry-example.json) include exact
registry tarball integrity and the Rust registry checksum.

- Fresh copied App Router directory: `npm ci`, production Next build, strict
  TypeScript and dependency resolution passed. Both SDKs resolve from npm;
  Next.js uses one deduplicated base client 0.2.3.
- Chromium 156 / Node 26 / Next 16.4.3 / React 19.3.1: full existing framework
  smoke passed against that copied registry consumer, with two Next processes
  and a shared disposable PostgreSQL session store. Its controlled auth transport
  is not backend RLS evidence. All ten auth flow groups, cross-origin controls,
  replay checks and multi-tab identity controls passed. One hundred repeated
  reads retained zero advisory locks. These are bounded checks, not a new soak.
- Real loopback backend/PostgreSQL: both focused TypeScript example contracts,
  the copied Todo script using public npm 0.2.3, and both Rust REST credential
  modes using an exact registry 0.1.6 consumer passed. The Rust consumer was
  compiled on 1.88; its explicit-token run received an invalid password to prove
  it did not also perform password login.
- Rust checkout examples: all build on 1.99 and check on 1.88. SDK example Clippy
  passes with warnings denied. No live OAuth example was executed.
- Source build boundary: valid app builds; importing the server entry from a
  Client Component fails; the valid app rebuilds after removal of that probe.
- Eleven documentation-version regressions and 38 focused guide tests pass.
  Guide catalogs, production UI build and 119 changed-guide relative Markdown
  targets were checked. Package versions and release tags remain unchanged.

Live Google/GitHub and AWS S3/R2 HTTPS remain explicitly skipped, unchecked and
outside scope. Issue #151 must stay open for those two original acceptance gates.
This documentation/example update does not publish another SDK or deploy a server.
