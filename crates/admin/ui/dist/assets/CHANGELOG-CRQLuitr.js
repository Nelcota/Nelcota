var e=`# Changelog

Package releases use Semantic Versioning and Keep a Changelog categories.
Dates identify release entries; registry availability requires a successful publish.

## Unreleased

### Changed

- Breaking: REST query builders require \`.execute()\` and are not \`PromiseLike\`.
  Awaiting a builder, returning it from an async function or passing it to
  \`Promise.all\` rejects with \`NelcotaUsageError\` (instead of silently resolving
  to the builder), and its awaited type is \`never\`. Add \`.execute()\`.
  Authentication, storage and RPC methods remain promises.
- Breaking: clients without generated database types expose dynamic row fields
  as \`unknown\`. Validate a field before using it, or supply the generated type.
- Breaking: \`single()\`/\`maybeSingle()\` throw \`NelcotaUsageError\` on
  \`update\`/\`delete\`: the server has no singular write and changed every
  matching row before the count was checked. Filter on a unique key and check
  the returned rows. \`insert\`/\`upsert\` and reads keep them.
- Breaking: \`order\`, \`limit\`, \`offset\` and \`range\` throw on \`update\`/\`delete\`,
  and filters and those modifiers throw on \`insert\`/\`upsert\`, before HTTP (the
  server rejected them). Modifiers aimed at an embed of \`.select()\` remain.
- \`not_single\` is a client error with \`status: 0\`; the query result keeps the
  real HTTP status instead of a fabricated 406.
- \`pages(size)\` keeps an existing \`limit\`/\`range\` as the total number of rows
  instead of replacing it with the page size.
- \`getSession()\`, \`refreshSession()\` and requests return session storage or
  coordination failures as the new \`session_unavailable\` code (original error
  in \`cause\`) instead of rejecting. \`accessToken()\`, \`setSession()\`, sign-in and
  sign-out keep throwing/rejecting; the README documents the split.
- A transient refresh failure (network, 429, 5xx, \`refresh_pending\`) while the
  access token is still valid keeps the session: reads and requests succeed,
  and further foreground attempts wait for \`Retry-After\` or 2 seconds.
- \`escapeLike\` sends a typed \`*\` as \`\\*\` (a literal \`*\`) instead of \`_\` (any
  single character). This needs a server whose \`like\`/\`ilike\` parser reads \`\\*\`
  as a literal \`*\`; older servers read it as a literal \`%\`.
- A failure while reading the body of a success response is the new
  \`response_body_error\` code ("The response could not be read") instead of
  \`network_error\`: the request reached the server and a write may have committed.
- Cross-tab broadcasts send one message per change (the structured event, or
  the legacy \`"changed"\` signal when there is no committed revision). Receivers
  still accept \`"changed"\` from older tabs.
- \`handleRedirect()\` only acts while a sign-in started here is pending (a stored
  PKCE verifier); otherwise it returns \`null\` data and leaves \`?code=\`/\`?error=\`
  in the URL. An error redirect consumes the verifier.

### Added

- Client error codes \`session_unavailable\`, \`refresh_pending\`,
  \`response_body_error\` and \`oauth_error\` (see Changed and Fixed).
- The README documents that \`upload\`, \`download\` and \`open\` have no timeout by
  default, unlike every other call (30 seconds), and which calls throw instead
  of returning a result.

- The standalone \`@nelcota/client/testing\` export supplies rollback scenarios,
  API-role impersonation, fixture identities and SQLSTATE assertions for pg/Bun SQL.

- All table writes accept \`count: 'exact'\` and return the number of affected rows,
  including zero, without requiring a row representation.

- Auth listeners receive one asynchronous \`initial_session\` baseline per subscription,
  ordered before subsequent sign-in, refresh and user-update events.

### Fixed

- Refuse \`service_role\` tokens in Web Workers and Service Workers as well as pages.
- Preserve transient refresh errors for data requests instead of sending an expired
  access token and replacing the original failure with a later authorization error.
- \`ServerErrorCode\` no longer lists \`invalid_credentials\` and
  \`bad_verification_code\`, which the server never sends. A wrong email or
  password is \`invalid_grant\`, now documented on \`signInWithPassword\`. Code
  comparing against those strings still compiles.
- A browser tab that closed or crashed mid-refresh no longer locks every tab
  out with "Browser session refresh was interrupted; sign in again". Refresh
  reservations carry their time: other tabs keep reading the session, get
  \`refresh_pending\` from a refresh within 10 seconds (the server's retry
  window), and then take the reservation over and retry the stored token. The
  owner renews its reservation while a slow refresh request is in flight.
  Reservations written by older SDKs are taken over 10 seconds after a tab
  first sees them.
- Removing the \`localStorage\` copy of a native browser session (clearing site
  data or the key) signs it out and clears the IndexedDB journal, once the
  stored receipt is older than five seconds.
- \`exchangeCode()\` consumes the PKCE verifier only after a definite server
  answer (a session or a 4xx), so a network failure, timeout or 5xx can be
  retried with the same callback.
- OAuth redirect errors outside the server's known codes become \`oauth_error\`,
  with a truncated, sanitized copy of the raw value in \`details\`, instead of
  copying any URL value into \`NelcotaError.code\`.
- Bucket settings are serialized field by field, and bucket methods take only
  \`signal\`/\`timeout\` from their options, so untyped options cannot replace
  headers, authentication or response validation.
- A browser refresh request that never settles (with \`timeout: 0\`) no longer
  holds its refresh reservation for as long as the tab stays open. The owner
  renews it for at most the request timeout or two minutes, whichever is
  shorter; other tabs then take it over once the 10-second lease lapses.
- Tabs running SDK 0.2.1 or older hear sign-outs and refreshes from newer tabs
  again: each change is broadcast as the structured message followed by the
  legacy \`"changed"\` signal those tabs understand. Current tabs skip the
  duplicate instead of handling the change twice.
- A tab no longer signs the user out when it reads a session that a tab
  running an older SDK has committed to IndexedDB but not yet copied to
  \`localStorage\`. Such untimed receipts settle five seconds after this tab
  first sees them, like untimed refresh reservations.

## 0.2.5 — 2026-10-27

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