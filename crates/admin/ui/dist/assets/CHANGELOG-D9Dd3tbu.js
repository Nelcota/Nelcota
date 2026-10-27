var e=`# Changelog

Package releases use Semantic Versioning and Keep a Changelog categories.
Dates identify release entries; registry availability requires a successful publish.

## Unreleased

### Changed

- Parse JSON in large responses about 8 to 12 times faster: the pass that
  keeps unsafe integers and long decimals exact is skipped when no number in
  the response can lose digits.

## 0.2.4 — 2026-10-26

### Fixed

- Retry a background refresh with an uncertain outcome after 2 seconds, inside
  the server's 10-second window for reusing the previous refresh token, so a
  lost refresh response no longer signs the user out.
- Reject an invalid \`Date\` or a \`bigint\` in a JSON request body with
  \`NelcotaUsageError\`, instead of writing \`null\` or throwing a raw \`TypeError\`.
- Keep query strings on engines without \`URLSearchParams.size\` (Safari before
  17), which previously sent requests without their filters.

## 0.2.3 — 2026-10-24

### Fixed

- Scope PKCE coordination to each server storage adapter and key, so an unrelated
  request's stalled verifier write cannot block OAuth setup or logout. Clients
  sharing an adapter still serialize verifier writes, exchanges and cleanup;
  browsers and caller-supplied worker storage retain cross-context Web Locks.

## 0.2.2 — 2026-10-24

### Fixed

- Renew only expired sessions before logout and revoke any still-valid token;
  never persist or announce that renewal. Isolate server auth locks by
  adapter/key while caller storage in workers keeps Web Locks, label cross-tab
  account/profile changes and ignore unchanged per-tab state.
- Release browser refresh reservations after rate limiting and every other
  definite 4xx rejection other than \`invalid_grant\`, while retaining uncertain-outcome fences for network and gateway failures.
- Stop raw-response attempt timers at headers; preserve caller cancellation and
  buffered deadlines, HTTP error status after failed body reads, strict HTTP
  Retry-After parsing and usage errors for malformed URLs/headers.
- Keep reserved-column filters separate from modifiers, align cardinality error
  status/query strings, and accept embedded columns in logic callbacks.
- Return structured errors for empty OAuth callback values and include current
  backend auth error codes in the TypeScript union.

- Honor caller-provided tokens in \`getUser()\` and \`updateUser()\` without selecting
  or modifying another stored session; disable automatic refresh consistently
  for standalone and combined caller-token clients.

- Decode large JSON strings without regex stack exhaustion, preserving exact numbers.
- Observe synchronous and asynchronous auth listener failures through
  \`onBackgroundError\`, without stopping refresh or blocking reentrant callbacks.
- Reject non-object REST rows and report ambiguous inverse relationships in
  generated-schema select inference; scalar RPC results remain supported.
- Preserve \`retryAfter\` in serialized errors and align explicit MIME validation
  with the server's supported type/subtype characters and 127-byte parts.


## 0.2.1 — 2026-10-19

### Changed

- Separate authentication/query contracts and storage transfers into their own
  modules, preserving all package entry points and existing client behavior.

### Fixed

- Reject malformed insert/upsert rows, missing upload bodies and explicit empty
  referenced tables before HTTP, preserving valid null fields and empty files.
- Refuse blank OAuth codes before consuming the stored verifier, and reject
  sessions whose user identity is empty.
- Reject missing storage representations and malformed collection containers
  with \`invalid_response\`, preserving empty collections and nullable metadata.
- Return email validation failures as rejected promises from password-reset,
  magic-link and confirmation requests.
- Preserve newer cached user data when older profile responses arrive, including
  session replacements and native journal revisions.
- Preserve \`single\`/\`maybeSingle\` result types through another \`select\`, and
  ignore malformed or unsafe \`Content-Range\` totals.
- Release cancelled queued authentication payloads before the lifecycle owner
  finishes, preserving accepted publications and independent caller cancellation.
- Cancel queued sign-up, password login, verification and OAuth exchange waits
  without interrupting another caller's refresh or an accepted publication.
- Type bucket size limits as \`number | string | null\` and send exact decimal
  strings as JSON integers, so reading then updating a large int64 limit does
  not change its value or send a quoted number. Existing server validation
  still rejects invalid settings. Use strings before JavaScript rounds a value.
- Keep usage diagnostics concise without changing error codes or statuses.

## 0.2.0 — 2026-10-19

Published independently of the server. Consult the registry entry for the
selected version; source version metadata does not publish a package.

### Fixed

- Clear pending OAuth verification state on sign-out, including the native
  journal and storage mirror, absent sessions and failed server revocation.

- Keep default server-memory clients' coordination queues independent so
  one pending sign-in cannot block another request's cached session read.
  Shared adapters and browser sessions retain their existing coordination scope.

- Coalesce native browser refresh calls that arrive while another tab is
  rotating, preserving the original comparison snapshot before waiting on
  Web Locks. Authoritative journal checks still guard every accepted rotation;
  later explicit refreshes remain independent.

- Release cancelled shared-operation waiters immediately while accepted rotation
  finishes and persists its result; prevent retained AbortSignal/listener graphs.

- Coordinate native browser sessions through committed IndexedDB receipts,
  preventing queued tabs from rotating a token from a stale localStorage view.
  Reserve rotations before HTTP and prevent late responses from undoing logout.
  Native persistence now requires IndexedDB; reload all tabs when upgrading.
  Interrupted rotations require the owning client to retry or a new sign-in.
- Preserve failed sign-in/logout state over an unchanged foreign receipt;
  unique committed revisions distinguish old state from later decisions.
- Journal native PKCE verifiers and consume them atomically. An already
  cancelled exchange leaves the verifier available; a claimed exchange keeps
  ownership until its accepted session is persisted even if a waiter cancels.
- Preserve unsafe integers and decimal digits in JSON responses as strings,
  including nested values and RPC results. Ordinary numbers remain numeric.
  Regenerate schema types: Postgres numeric types that may exceed JavaScript
  precision now use \`number | string\`. Use strings for exact filters and writes.
- Generated arrays allow null elements independently of column nullability,
  including enum arrays and RPC arguments and results.

## 0.1.2 — 2026-10-11

### Fixed

- Bound HTTP error bodies to 64 KiB while preserving status and \`Retry-After\`.
- Preserve newer in-memory sessions when storage writes or removal fail; stale
  storage and cross-tab reloads cannot restore a spent token or signed-out state.
- Expose the optional \`auth.onBackgroundError\` handler for background adapter
  failures. Automatic refresh pauses until persistence succeeds; handler
  exceptions are isolated.
- Ignore coordination messages after disposal and keep cancellation cleanup
  bounded when transport cancellation does not settle.
- Verify the package and real-server contract against Nelcota 0.4.0. The minimum
  supported server remains 0.3.0; no webhook-management SDK API is introduced.

## 0.1.1 — 2026-10-11

### Changed

- Update repository and documentation links to \`Nelcota/Nelcota\` after the
  organization transfer. The client API and server compatibility are unchanged.
- Publish from the organization with GitHub Actions trusted publishing (OIDC).

## 0.1.0 — 2026-10-10

### Added

First npm release. Changes since the release candidate:

- Add \`auth.updateUser({ password?, currentPassword?, data? })\` for the new
  \`PUT /auth/v1/user\`: change the password (other sessions end) or merge
  \`user_metadata\`. Needs a server with that endpoint.
- Know the server's newer codes: \`invalid_email\`, \`weak_password\`,
  \`bad_request\`, \`method_not_allowed\`, \`payload_too_large\`,
  \`unsupported_media_type\`, \`range_not_satisfiable\` and a server \`timeout\`.
- Expose the optional Postgres fields of server errors (\`sqlstate\`, \`details\`,
  \`hint\`, \`constraint\`) on \`NelcotaError\`, and export \`NelcotaErrorCode\` and
  \`ServerErrorCode\` for autocompletion of known codes.
- Bodyless error responses (HEAD counts) keep a meaningful code:
  \`unauthorized\`, \`forbidden\`, \`not_found\`, \`rate_limited\` or \`unavailable\`
  instead of \`http_<status>\`.
- Add \`offset(n)\` (parity with the Rust client), a \`range\` field on query
  results (the returned rows, from \`Content-Range\`) so a server row cap is
  visible, and a \`pages(size)\` async iterator that walks every row.
- Add \`.throwOnError()\` on queries and an exported \`unwrap(result)\` helper
  for code that prefers exceptions; the examples use them instead of a local
  helper.

- Cancel auth/request waits independently while accepted refresh rotation
  completes and persists the replacement token.
- Type HEAD data as null and require row representation for single/maybeSingle;
  reject malformed REST row representations with invalid_response.
- Require complete bucket settings on update, with explicit null to clear
  limits. Existing partial updateBucket calls must supply all three fields.
- Add regressions for cancellation, result types, cardinality and bucket limits
  against both mock transports and the production HTTP/Postgres contract.

## 0.1.0 release candidate

- JavaScript ESM and TypeScript declarations with no runtime dependencies.
- REST queries, writes, upserts, filters, embeds, pagination, counts and RPC.
- Password, email-link and OAuth PKCE authentication; persistent browser
  sessions and coordinated refresh rotation.
- Storage uploads, downloads, streaming responses, ranges, ETags and URLs.
- Independent \`createRestClient\`, \`createAuthClient\` and \`createStorageClient\`
  factories, with a caller-supplied token source for sharing auth.
- Buffered response failures return structured errors; read retries include
  interrupted bodies and never retry earlier than \`Retry-After\`.
- Auth request cancellation, logout/refresh coordination and client disposal.
- Session keys isolate projects served under different URL base paths.
- Packed-package checks in clean JavaScript and TypeScript consumers, contract
  tests against Postgres and Nelcota, and browser/runtime checks.
- Runnable browser, Node and per-request server examples; Portuguese quickstart.

The candidate becomes a public release only after a successful npm publish.

Historical candidate note: the 0.2.0 changes were absent from registry 0.1.2.
The package was subsequently published independently of the server; use the
version-specific changelog and bundled documentation for installed clients.
`;export{e as default};