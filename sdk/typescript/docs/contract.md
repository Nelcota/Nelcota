# Client contract

`@nelcota/client` 0.2.x targets the Nelcota HTTP protocol implemented by this
repository. The package has its own version; server compatibility is determined
by the endpoints and features below, not by matching package version numbers.

## Version scope

This is the 0.2.5 package contract. It includes queued-auth cancellation, exact
bucket-limit writes, profile ordering and the input/response guards below.
Version 0.2.0 predates these corrections, and 0.2.1 predates the
[0.2.2 hardening](../CHANGELOG.md#022--2026-10-24). Registry installation requires
successful publication of 0.2.5, now confirmed in the
[registry receipts](https://github.com/Nelcota/Nelcota/pull/202#issuecomment-6445288705);
a server update does not install the client.
See the [upgrade notes](#upgrading-from-020). Older packages keep the contract in their
own bundled documentation.

Browsers need Chrome or Edge 116, Firefox 124 or Safari 17.4 and later: request
timeouts combine with a caller's `signal` through `AbortSignal.any`. Server
runtimes are Node 22 and later, Bun and Deno.

## Unreleased changes

The next release changes these contracts; 0.2.5 keeps the earlier ones.

- REST builders require `.execute()`; awaiting a builder rejects with
  `NelcotaUsageError`. `single()`/`maybeSingle()` on `update`/`delete`, and
  modifiers or filters the server rejects on writes, throw before HTTP.
  `not_single` has error status 0 instead of 406. `pages()` keeps an existing
  `limit` as its total.
- `getSession()`, `refreshSession()` and requests return session storage
  failures as `session_unavailable` instead of rejecting. A transient refresh
  failure keeps a still-valid access token.
- A foreign refresh reservation no longer requires a new sign-in: it blocks
  rotation for 10 seconds (`refresh_pending`) and is then taken over. Removing
  the `localStorage` mirror signs the session out.
- A body-read failure after a success status is `response_body_error`, not
  `network_error`.
- OAuth: the verifier survives an uncertain exchange; `handleRedirect()`
  ignores URLs without a pending sign-in; unknown redirect errors become
  `oauth_error`.
- `escapeLike` sends a typed `*` as `\*`, which needs a server that supports it.

## Upgrading from 0.2.4

Install `@nelcota/client@0.2.5` and update the application lockfile. Public
entrypoints, types and parsed values are unchanged; JSON parsing of large
responses is faster.

## Upgrading from 0.2.3

Install `@nelcota/client@0.2.5` and update the application lockfile. Public
entrypoints and types are unchanged. A background refresh with an uncertain
outcome is retried after 2 seconds instead of 10, inside the server's reuse
window. JSON bodies containing an invalid `Date` or a `bigint` now fail with
`NelcotaUsageError` before the request instead of sending `null` or rejecting
with a `TypeError`; convert such values (for example a `bigint` to a string).

## Upgrading from 0.2.2

Install `@nelcota/client@0.2.5` and update the application lockfile. Public
entrypoints and types are unchanged. PKCE work on one server storage adapter
no longer blocks clients using independent adapters. Clients sharing an adapter
and key still serialize, and browser/worker Web Lock names remain compatible.
Rebuild server consumers and exercise login, callback exchange and logout.

## Upgrading from 0.2.0

Install 0.2.5 explicitly, update the application lockfile and run its type check,
build and tests. Server and SDK versions remain independent. Existing package
entrypoints, result/error codes, timeouts and HTTP routes are preserved.

- `Bucket.file_size_limit` is now correctly `number | string | null`. Preserve
  exact decimal strings when reading/updating large limits; converting them to
  `number` can lose precision. Use explicit null to clear a limit.
- `single()`/`maybeSingle()` keep their corrected result types through a chained
  `select()`. Code relying on the previous inaccurate type may need adjustment.
- Handle password-reset, magic-link and confirmation validation with
  `await`/`catch` or `.catch()`: invalid arguments reject the Promise. HTTP and
  network failures still use the existing result's `error` field.
- Malformed write rows, blank OAuth codes and absent upload bodies are usage
  errors before HTTP. Missing storage representations return `invalid_response`.
  Valid null fields, default row objects, empty collections and zero-byte files
  remain supported. Storage response checks are minimum shape guards.
- Cancelled queued auth callers leave the queue without cancelling another
  refresh owner or an already accepted session publication. Older profile reads
  cannot overwrite newer cached user data. Writes are never automatically replayed.

Reload open browser tabs after updating so they use the same installed SDK.
Verify login/refresh/sign-out, a typed read/write and storage against staging;
update HTTP mocks to return the documented response representation.

## Interface

| Module | Methods | HTTP contract |
|---|---|---|
| REST | `from().select()`, filters, order, limit, range, single, maybeSingle | `GET/HEAD /rest/v1/{table}`; encoded query; optional `Prefer: count=exact`; `Content-Range` |
| REST writes | insert, update, delete, upsert, optional select | `POST/PATCH/DELETE /rest/v1/{table}`; JSON body; `Prefer: return=minimal/representation`; upsert resolution and `on_conflict` |
| RPC | `rpc(name, args)` | `POST /rest/v1/rpc/{name}`; named JSON arguments; caller's role |
| Auth | signUp | `POST /auth/v1/signup` with an S256 `code_challenge`; session or `{user}` awaiting confirmation |
| Auth | password login, refresh, exchangeCode | `POST /auth/v1/token?grant_type=password/refresh_token/pkce` |
| Auth | getUser, updateUser, signOut | `GET`/`PUT /auth/v1/user`, `POST /auth/v1/logout` |
| Auth links | recover, magic link, resend, verify/reset | `POST /auth/v1/recover`, `/magiclink`, `/resend`, `/verify` |
| OAuth | signInWithOAuth, handleRedirect | `GET /auth/v1/authorize`; S256 PKCE; callback `?code=` exchanged once |
| Storage | upload, replace, open/download, remove | `POST/PUT/GET/DELETE /storage/v1/object/{bucket}/{path}`; raw bytes |
| Storage | list, signed URL, public URL | `POST /storage/v1/object/list/{bucket}`, `/object/sign/{bucket}/{path}`; `/object/public/{bucket}/{path}` |
| Buckets | list, get, create, update, delete | `/storage/v1/bucket` and `/storage/v1/bucket/{id}` |

`schema` selects the generated TypeScript schema; the server's configured
exposed schema determines the HTTP resource. It does not switch database schemas
at runtime. RLS and GRANTs always remain server/Postgres decisions.

## Results and failures

- Auth and storage return `{data,error}`. REST adds `status`, `count` and `range`; RPC
  adds `status`. Writes without `.select()` and HEAD responses return null.
  HEAD is typed as null, including chained selects.
- A requested row representation that has no body or is not an array of
  non-null objects returns `invalid_response`; it never succeeds with null or
  another shape. Empty arrays and null fields inside rows remain valid. RPC
  results may be scalars or contain scalar/null array elements.
- HTTP failures preserve server `code`, `message` and status. Client codes
  carry status 0: `network_error` (no response), `response_body_error` (a
  success status arrived but its body could not be read, so a write may have
  committed), `timeout`, `aborted`, `not_single`, `session_missing`,
  `session_unavailable`, `refresh_pending`, `pkce_missing` and `oauth_error`.
- HTTP error bodies larger than 64 KiB are discarded; status, a generic code
  and Retry-After remain available. An unreadable error body keeps its HTTP status.
- Invalid JSON returns `invalid_response` with the response's HTTP status.
- JSON numbers stay numeric when their decimal digits survive JavaScript
  conversion. Unsafe integers and decimals that would lose digits become
  strings, including nested JSON values and RPC results. Generated `bigint`,
  `numeric`, `real` and `double precision` fields use `number | string`; regenerate
  schema types after upgrading. Pass exact values as strings in filters and
  writes. PostgreSQL array elements may be null independently of column
  nullability; generated arrays therefore use `(T | null)[]`.
- Scalar RPC result sets also allow null elements and group numeric unions as
  `(number | string | null)[]`. Functions returning view rows reference the
  generated `Views` section, while table rows reference `Tables`. Select
  inference reports ambiguous relationships in both directions; use a column or
  foreign-key constraint hint to choose one.
- Non-finite JSON input (`NaN` and infinities), invalid `Date` values and
  `bigint` values throw `NelcotaUsageError` before authentication or HTTP.
  Explicit nulls remain valid. Sessions require the complete session/user
  shape, with `expires_at` and `expires_in` as safe, non-negative integers;
  `refreshMargin` must be finite and non-negative.
- Invalid developer configuration, unsafe identifiers/paths and invalid HTTP
  header values throw `NelcotaUsageError`.
- Thrown versus returned: `getSession()`, `refreshSession()` and every request
  return session storage and coordination failures as `session_unavailable`
  (the original error is `cause`). `accessToken()` throws the `NelcotaError`
  of its session read. `setSession()`, the sign-in methods and `signOut()`
  reject when session storage fails. Errors thrown by a caller-supplied token
  function or `fetch` outside the HTTP operation remain the caller's.
- Serialized errors include `retryAfter` when present, but never include `cause`.
  Do not log login bodies, bearer tokens, session objects or signed URLs. Server
  error messages and database details can contain application data; redact them
  before sending telemetry outside the application's trust boundary.

## Retries, timeouts and cancellation

- GET and HEAD retry network failures, body-read failures, 429 and 503;
  mutations, auth token exchange, storage listing and RPC are not automatically
  retried. Retry-After accepts integer seconds or HTTP dates; delays up to 30
  seconds are respected, longer ones return the error with `retryAfter`.
- The timeout covers each attempt and its buffered body, excluding session
  refresh, token-source waits and the wait between retries. It defaults to 30
  seconds, except `upload`, `download` and `open`, which default to none so a
  large transfer is not cut off; pass `{ timeout }` or a signal to bound them.
- A raw response (`open()`) stops its attempt deadline when headers arrive;
  caller cancellation still owns the accepted stream, and later stream errors
  belong to the caller. `download()` buffers the whole file and returns body
  failures in its result.
- For a total caller deadline use `AbortSignal.timeout(ms)` as the request's
  signal. It returns `aborted` when it expires and withdraws only that
  caller's wait, never another caller's refresh. REST/storage signals also
  cover waiting for the token source or a session refresh.

## REST queries

- Builders are immutable and send one request per `.execute()`. They are not
  promises: awaiting a builder, returning it from an async function or passing
  it to `Promise.all` rejects with `NelcotaUsageError`, and the awaited type is
  `never`.
- `single()`/`maybeSingle()` require a row representation and refuse minimal
  writes, HEAD, `update` and `delete` before HTTP: the server has no singular
  write and would change every matching row before the client could count
  them. Reads send `limit=2` (also shown by `toString`). A wrong row count
  returns `not_single` with error status 0; the result keeps the real HTTP status.
- `update`/`delete` refuse `order`, `limit`, `offset` and `range`, and
  `insert`/`upsert` refuse filters and those modifiers, before HTTP, because
  the server rejects them. Modifiers and filters on an embed of the returned
  representation (`referencedTable`, `orders.total`) remain allowed.
- `pages(size)` reads from the current offset until an empty page. An existing
  `limit` or `range` caps the total rows read; it is never replaced by `size`.
- Reserved modifier column names used as filters (`limit`, `order`...) are sent
  as logic groups, including embedded paths.
- `escapeLike` escapes `\`, `%`, `_` and `*` with a backslash. An unescaped `*`
  means any text; `\*` is a literal `*` on servers that support it. Older
  servers read `\*` as a literal `%`.

## Input and response guards

Insert/upsert arrays require object rows, including at sparse array positions.
An empty object can request database defaults; empty strings and explicit null
field values remain valid. An omitted `referencedTable` targets the parent;
an explicitly empty or null target is refused rather than changing the parent.

Storage uploads require a body. Use an empty string, Blob or byte buffer for a
zero-byte file; null or undefined is a usage error. Item responses require a
nonempty string identity; bucket collections and object listings require their
array containers and item identities. These are minimum representation guards,
not exhaustive field-by-field schemas. Missing/invalid representations return
`invalid_response` with the HTTP status and are not retried. Empty collections
and nullable owner, metadata and bucket limits remain valid.

Explicit upload MIME parts use ASCII letters/digits and `!#$&-^_.+`, with 1–127
characters per part, matching the server's preserved type/subtype grammar.
Parameters after a semicolon and space/tab before it remain valid; header bytes
are sent unchanged. Other HTTP token characters are refused before upload.
Bucket methods take only `signal` and `timeout` from their options.

Blank OAuth codes are rejected before HTTP or verifier consumption. Sessions
need a nonempty user identity. Password-reset, magic-link and confirmation
methods return promises even when email validation fails; handle those errors
with `await`/`catch` or `.catch()`. Synchronous query builders still throw
`NelcotaUsageError` directly for invalid input.

## Sessions and lifecycle

### Storage

Each client owns its session adapter. A custom adapter can be sync or async.
Elsewhere than in browsers the default is a separate in-memory adapter; on a
server, instantiate a client per request or supply a per-request token. The
default storage key includes the host and base path, so projects under
different paths cannot overwrite each other's sessions in a shared adapter.

Native browser `localStorage` sessions use an IndexedDB journal as the
authoritative state and `localStorage` as a mirror. The journal requires
IndexedDB, bounds each database open and transaction to five seconds and
closes its connection after every operation. It imports an existing
`localStorage` session once per storage key. Each publication commits a
receipt with a unique revision and its time; a later committed revision
supersedes an earlier one even when the value is identical. Reload all tabs
when upgrading so they use the same coordination protocol.

A ready session whose `localStorage` mirror has been removed is signed out
once its receipt is more than five seconds old (younger receipts may be
between the journal commit and the mirror write); the journal is cleared in
the same transaction. A receipt from an SDK without receipt times is timed
from when this client first sees it. Other `localStorage` edits do not change
the session. `sessionStorage` and custom adapters keep their own semantics.

### Refresh

The refresh margin is capped at half the token lifetime, so short-lived tokens
and large configured margins do not rotate fresh sessions repeatedly. Background
jitter stays within the scheduled delay. An already expired token waits ten
seconds before a background attempt; explicit session reads refresh it
immediately. Background retries after a failure wait 2 seconds, then 10.

Refresh calls on one auth client share a promise and the first caller's
timeout; rotation continues and persists its result even when a waiter
cancels, and an already aborted caller does not start it. Clients sharing an
adapter and storage key are serialized with Web Locks (in browsers, and for
caller storage in Web and Service Workers), with a module-local queue as a
fallback. Separate server adapters use independent queues. Browsers expose Web
Locks only in secure contexts; on a plain `http://` origin tabs can refresh at
once, and the server's 10-second retry window decides whether the second
refresh is accepted or ends the session. Serve multi-tab apps over HTTPS.

A session read (`getSession()`, a request) refreshes a session within the
margin. When that refresh fails transiently (network, 429, 5xx,
`refresh_pending`) and the access token is still valid, the read succeeds with
the current session and foreground attempts pause for `Retry-After` or two
seconds. An expired token is never sent; the read returns the failure.
`invalid_grant` signs out; other definite 4xx rejections leave the session.

### Reservations

Native browser sessions commit a reservation of the refresh token before
sending it and read the replacement only after the IndexedDB transaction
commits; Web Locks alone do not order another tab's `localStorage`
visibility. The reservation's owner publishes the replacement, or gives the
reservation back after a definite 4xx rejection; `invalid_grant` clears the
session. A 5xx or a lost response keeps the reservation, because the rotation
may have committed: the owner retries with the same token inside the server's
retry window and never rotates an uncertain token a second time to clear it.

Another client can always read a reserved session and use its access token.
For 10 seconds after the reservation (the server's retry window) it cannot
rotate it: refreshing returns `refresh_pending`. The owner renews the
reservation every few seconds while its refresh request is in flight, so a slow
request keeps it, for at most the request timeout or two minutes, whichever is
shorter (two minutes with `timeout: 0`). Once renewals stop for 10 seconds the
reservation is abandoned (its tab closed or crashed, or its request never
settled) and the next refresh takes it over, retrying the stored token. The
server then either rotates it, or answers `invalid_grant` when the lost
rotation had committed, which signs out. A late response from a superseded
owner cannot overwrite the newer state: its publication is refused and the
authoritative state is adopted. A reservation from an SDK without receipt
times is timed from when this client first sees it.

### Publication and events

Explicit sign-in captures the prior receipt before HTTP. Failed publication
of a sign-in, refresh replacement or logout keeps the newer local state (this
client never reloads a spent refresh token or restores a signed-out session)
while that exact prior receipt remains current, even with a foreign owner. A
committed logout supersedes dirty state in other clients.

Each change is broadcast as one message carrying its event and revision,
never tokens, followed by the legacy `"changed"` signal for tabs running SDK
0.2.1 or older; current receivers skip that copy. A change without a
committed revision sends only the legacy signal, which receivers still accept
from older SDKs. Receivers reload under the lifecycle lock; unchanged reloads
emit nothing, and a revision that no longer matches the journal is not
trusted for its event kind. Explicit `sessionStorage` does not broadcast.

Auth listeners run in registration order and may return promises. Each
subscription first receives one asynchronous `initial_session`, ordered before
later events. Listener completion is not awaited inside the lifecycle lock, so
a listener can call auth. Listener throws and rejections go to
`onBackgroundError` without stopping refresh. Background storage failures go
there too and pause automatic refresh until a session is written successfully.
Handler failures are isolated.

### Sign-out

`signOut()` waits for a pending refresh and clears locally even when server
revocation fails. Under its lifecycle owner it renews only an expired access
token (allowing five seconds of clock skew), and only to revoke the renewal: it
is never persisted, broadcast or emitted as `refreshed`, and logout emits one
`signed_out`. A still-valid token is revoked directly, even after a failed
renewal; a reserved session is revoked with its current token. Signing out also
consumes the pending PKCE verifier. `dispose()` stops timers, closes channels
and clears listeners; it neither revokes the session nor aborts requests.

### Caller-owned tokens

An explicit `accessToken` controls REST/storage and `getUser()`/`updateUser()`
identity. Those user operations do not consult or update stored sessions; null
returns `session_missing` without HTTP. Automatic refresh is disabled for both
combined and standalone auth clients. Other explicit auth methods may still
store sessions; separate managed-login clients from caller-forwarding clients.

### OAuth with PKCE

Each storage key holds one pending verifier; native verifiers use the journal
under a separate key. Publication, navigation, the code exchange and
consumption share one lock. The verifier is consumed, as a committed tombstone,
only after a definite answer (a session or a 4xx refusal); after a network
failure, timeout or 5xx it stays for a retry of the same callback.
Cancellation before the exchange keeps it; once the exchange starts it
persists an accepted session even if the caller stops waiting.

`handleRedirect()` acts only while a verifier is pending; otherwise it returns
null data and leaves the URL untouched. It removes `code` and `error` from the
address bar. Known server error codes (`access_denied`, `provider_error`,
`provider_disabled`, `email_required`, `email_conflict`, `signup_disabled`,
`invalid_state`) are kept as the error code; any other value becomes
`oauth_error` with at most 64 sanitized characters in `details`. An error
redirect consumes the verifier.

### Sign-up confirmation

`signUp()` stores a second verifier under `<storageKey>.signup` before its
request and sends its S256 challenge. A sign-up that returns a session
removes it. `verifyEmailLink()` for a `signup` link sends it as
`code_verifier` under the verifier lock and removes it only after the server
returns a session; any failure keeps it for a retry. Magic links and recovery
never read it, and `handleRedirect()` ignores it. Without the verifier (another
browser, a resent link) the server still confirms the email and signs in but
clears the password chosen at sign-up. A storage adapter that cannot
hold the verifier (one that refuses the key) signs up and confirms without it,
and a failed removal never discards the confirmed session.

## Bucket settings

Creation accepts `BucketSettings` with optional fields. Updating uses
`BucketUpdateSettings`, requires `public`, `file_size_limit` and
`allowed_mime_types`, and replaces the entire settings object with PUT.
Use explicit null to clear a limit. Missing fields throw `NelcotaUsageError`
before any HTTP request, including in JavaScript consumers.

`Bucket.file_size_limit` is `number | string | null`. Limits beyond JavaScript's
safe integer range are returned as exact decimal strings, and bucket settings
accept those strings for read-modify-write. Pass a positive canonical decimal
string for large int64 limits; the SDK sends it as an unquoted JSON integer.
Do not first convert an exact string to `number`: JavaScript rounding cannot
be recovered. The server retains its positive-int64 range and settings validation;
invalid values return their existing HTTP errors. Non-finite numbers still throw
before HTTP. Noncanonical decimal strings remain JSON-escaped and quoted. Only
the known settings fields are sent.

## Release acceptance

Run `check`, unit/type tests, `build`, `size`, `test:package`, runtime smoke tests
and `test:contract -- --browser`. CI tests Node 22/24/26, Bun, Deno and
Chromium/Firefox/WebKit. Edge hosts may consume the Web API implementation but
are not included in this compatibility guarantee until tested on that host.
