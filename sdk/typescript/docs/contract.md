# Client contract

`@nelcota/client` 0.2.x targets the Nelcota HTTP protocol implemented by this
repository. The package has its own version; server compatibility is determined
by the endpoints and features below, not by matching package version numbers.

## Version scope

This is the 0.2.1 package contract. It includes queued-auth cancellation, exact
bucket-limit writes, profile ordering and the input/response guards below.
Version 0.2.0 predates these corrections. Registry installation requires
successful publication of 0.2.1; a server update does not install the client.
See the [upgrade notes](#upgrading-from-020). Older packages keep the contract in their
own bundled documentation.

## Upgrading from 0.2.0

Install 0.2.1 explicitly, update the application lockfile and run its type check,
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
| Auth | signUp | `POST /auth/v1/signup`; session or `{user}` awaiting confirmation |
| Auth | password login, refresh, exchangeCode | `POST /auth/v1/token?grant_type=password/refresh_token/pkce` |
| Auth | getUser, signOut | `GET /auth/v1/user`, `POST /auth/v1/logout` |
| Auth links | recover, magic link, resend, verify/reset | `POST /auth/v1/recover`, `/magiclink`, `/resend`, `/verify` |
| OAuth | signInWithOAuth, handleRedirect | `GET /auth/v1/authorize`; S256 PKCE; callback `?code=` exchanged once |
| Storage | upload, replace, open/download, remove | `POST/PUT/GET/DELETE /storage/v1/object/{bucket}/{path}`; raw bytes |
| Storage | list, signed URL, public URL | `POST /storage/v1/object/list/{bucket}`, `/object/sign/{bucket}/{path}`; `/object/public/{bucket}/{path}` |
| Buckets | list, get, create, update, delete | `/storage/v1/bucket` and `/storage/v1/bucket/{id}` |

`schema` selects the generated TypeScript schema; the server's configured
exposed schema determines the HTTP resource. It does not switch database schemas
at runtime. RLS and GRANTs always remain server/Postgres decisions.

## Results and failures

- Auth and storage return `{data,error}`. REST adds `status` and `count`; RPC
  adds `status`. Writes without `.select()` and HEAD responses return null.
  HEAD is typed as null, including chained selects. `single`/`maybeSingle`
  require a row representation and refuse minimal writes or HEAD before HTTP.
  A requested row representation that is empty or not a JSON array returns
  `invalid_response`; it never succeeds with null or another shape.
- HTTP failures preserve server `code`, `message` and status. Network, abort,
  timeout and interrupted buffered bodies return status 0 and client codes.
- HTTP error bodies larger than 64 KiB are discarded; status, a generic code
  and Retry-After remain available.
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
  generated `Views` section, while table rows reference `Tables`.
- Non-finite JSON input (`NaN` and infinities) throws `NelcotaUsageError` before
  authentication or HTTP, instead of silently becoming null. Explicit nulls
  remain valid. Sessions require the complete session/user shape, with
  `expires_at` and `expires_in` as safe, non-negative integers;
  `refreshMargin` must be finite and non-negative.
- Invalid developer configuration and unsafe identifiers/paths throw
  `NelcotaUsageError`. Errors thrown by user-supplied token/storage/fetch
  configuration outside the HTTP operation remain the caller's responsibility.
- GET and HEAD retry network failures, body-read failures, 429 and 503; mutations,
  auth token exchange, storage listing and RPC are not automatically retried.
- Timeout covers each attempt and its buffered body, excluding session refresh
  and the wait between retries. Retry-After up to 30 seconds is respected;
  longer delays return the error immediately with `retryAfter` for the caller.
- `storage.open()` hands the raw response to the caller. Subsequent stream
  errors must be handled by the caller; `download()` buffers into a Blob and
  returns body failures in its result.

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

Blank OAuth codes are rejected before HTTP or verifier consumption. Sessions
need a nonempty user identity. Password-reset, magic-link and confirmation
methods return promises even when email validation fails; handle those errors
with `await`/`catch` or `.catch()`. Synchronous query builders still throw
`NelcotaUsageError` directly for invalid input.

## Sessions and lifecycle

Each client owns its session adapter. Native localStorage uses an IndexedDB
journal as authoritative session state, with localStorage as a compatibility
mirror. Elsewhere the default is a separate in-memory adapter. A custom adapter
can be sync or async. Instantiate a server client per request or supply a per-request token.
The default storage key includes the host and base path, so projects under
different paths cannot overwrite each other's sessions in a shared adapter.

Default server-memory clients use independent coordination queues. A pending
sign-in on another client cannot delay reading an unrelated request's session.

Refresh calls on one auth client share a promise. Clients sharing an adapter
and storage key are serialized with Web Locks, with a module-local queue as a
fallback. Native browser sessions also commit a refresh reservation before HTTP
and read the replacement only after the IndexedDB transaction commits. Web Locks
alone do not order another tab's localStorage visibility. Without Web Locks,
the journal rejects competing owners instead of waiting for their replacement.
Custom shared adapters require Web Locks or external coordination; otherwise use
per-tab sessionStorage. The module-local queue cannot coordinate separate tabs.

Native persistence requires IndexedDB and bounds each database open and
transaction to five seconds. Connections close after every operation. A foreign
unfinished reservation requires a new sign-in, an owning-client retry, or
signOut; it never falls back to the potentially spent token in localStorage.
A committed logout supersedes dirty state in other clients and late refresh
responses cannot overwrite it. Broadcasts carry change notifications, not tokens.

Each native publication has a unique revision. Explicit sign-in captures the
prior receipt before HTTP; failed publication retains the local replacement
or logout while that exact receipt remains current, even with a foreign owner.
A later committed revision supersedes it even when the value is identical.

The journal imports existing localStorage state once per storage key. Reload all
tabs when upgrading to avoid mixing SDK coordination protocols. Use `signOut()`
or clear all site data to remove sessions; editing only localStorage no longer
changes the authoritative session. Custom adapters retain their existing semantics.

The refresh margin is capped at half the token lifetime, so short-lived tokens
and large configured margins do not rotate fresh sessions repeatedly. Background
jitter stays within the scheduled delay. An already expired token waits ten
seconds before a background attempt; explicit session reads still refresh it
immediately.

Auth methods that perform HTTP accept `{signal,timeout}` as the last argument.
Signals also cancel queued authentication before HTTP starts; withdrawing a
wait never cancels another operation's lifecycle ownership. Once a response is
accepted, its session publication can finish after the caller stops waiting.
Concurrent refresh callers share the first caller's timeout. Signals cancel
each caller's wait independently; rotation continues and persists its result
even when a waiter cancels. An already aborted caller does not start rotation.
REST/storage signals also cover waiting for the token source or session
refresh, without aborting an operation shared by other callers. `signOut()` waits
for a pending refresh and clears locally even when server revocation fails.
`dispose()` stops timers, closes channels and clears listeners; it neither
revokes the session nor aborts requests already in flight.

Native PKCE verifiers use the same journal with a separate key. Consumption
commits a tombstone atomically, preventing stale native views from exchanging
with an older or already consumed verifier. Cancellation before consumption
keeps the verifier; once consumption starts, cancellation ends the caller's
wait while the bounded exchange finishes and persists an accepted session.
Custom adapters keep their existing storage API and keyed-lock coordination.

Failed session writes keep the newer state in memory: this client never reloads
a spent refresh token or restores a signed-out session from stale storage.
Storage errors still reject explicit auth methods. Unexpected background
adapter errors are observed through the optional `auth.onBackgroundError`
handler; automatic refresh pauses until a session is written successfully.
Handler exceptions are isolated. Network errors returned in results keep the
existing bounded refresh retry. Native clients block on another owner's
unfinished reservation; an accepted replacement remains with its owner until
it can be persisted or a newer committed session or logout supersedes it.
Custom adapters require repair before sharing state that failed to persist.

An explicit `accessToken` controls REST/storage requests and disables automatic
session refresh in the combined client. Auth methods remain available and may
store a session when called explicitly.

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
before HTTP. Noncanonical decimal strings remain JSON-escaped and quoted.

## Release acceptance

Run `check`, unit/type tests, `build`, `size`, `test:package`, runtime smoke tests
and `test:contract -- --browser`. CI tests Node 22/24/26, Bun, Deno and
Chromium/Firefox/WebKit. Edge hosts may consume the Web API implementation but
are not included in this compatibility guarantee until tested on that host.


## Unreleased hardening

These changes belong to the next SDK package, not the already published 0.2.1.
Updating the server does not update application SDKs.

Table/view representations require an array of non-null objects. `single()`,
`maybeSingle()` and `pages()` return or throw `invalid_response` for null, scalar
or array elements. Empty result arrays and null fields inside rows remain valid.
RPC results may still be scalars or contain scalar/null array elements. Select
inference reports ambiguous relationships in both directions; use a column or
foreign-key constraint hint to choose one.

Auth listeners run in registration order and may return promises. Their completion
is not awaited inside the lifecycle lock, so an async listener can call auth.
Synchronous throws and asynchronous rejections are sent to `onBackgroundError`;
they do not stop refresh or reject an accepted sign-in. Error-handler failures
are isolated. Without a handler, listener errors are observed and discarded.
Background storage errors still pause refresh as documented above.

Serialized errors include `retryAfter` when present, but never include `cause`.
Do not log login bodies, bearer tokens, session objects or signed URLs. Server
error messages and database details can contain application data; redact them
before sending telemetry outside the application's trust boundary.

Explicit upload MIME parts use ASCII letters/digits and `!#$&-^_.+`, with 1–127
characters per part, matching the server's preserved type/subtype grammar.
Parameters after a semicolon and space/tab before it remain valid; header bytes
are sent unchanged. HTTP token characters outside this subset are refused before
upload instead of relying on the server to replace the declaration.

The timeout still covers each HTTP attempt, not token-source/refresh waits or
backoff. For a total caller deadline use `AbortSignal.timeout(ms)` as the request's
signal. This returns `aborted` when the caller deadline expires and withdraws its
wait without cancelling another caller's refresh. Uploads/downloads still have
no transfer deadline by default. Use `open()` and cancel or finish its body for
large files; `download()` deliberately buffers the entire file.
