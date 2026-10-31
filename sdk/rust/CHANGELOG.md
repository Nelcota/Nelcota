# Changelog

Package releases use Semantic Versioning and Keep a Changelog categories.
Dates identify release entries; registry availability requires a successful publish.

## Unreleased

### Added

- `AuthClient::try_start_auto_refresh` returns an error outside a Tokio runtime
  instead of panicking; `start_auto_refresh` (documented to panic there) and the
  `AutoRefresh` handle are `#[must_use]`.
- `Client::try_with_access_token` refuses an invalid explicit token at once.
- `Condition::is_null`, matching `Query::is_null`.

### Changed

- Session reads are lock-free snapshots: requests and `get_session` of a fresh
  session no longer wait behind sign-in, refresh, sign-out or session
  persistence. While a token inside the refresh margin is still valid, requests
  keep sending it and the shared rotation runs in the background; only an
  expired token waits for it. After a transient refresh failure they start
  another rotation only once Retry-After (or 2 s) has elapsed. Mutations still
  serialize on one lifecycle lock.
- Session expiry is tracked on the local monotonic clock from `expires_in`.
  Sessions received from the server have `expires_at` rewritten to the local
  clock plus `expires_in`, so stored copies are not affected by server clock
  skew. The serialized format is unchanged.
- `select` combines with `insert`/`update`/`upsert`/`delete` in either order;
  `select(...).insert(...)` used to fall back to `return=minimal`.
- `escape_like` escapes `*` as `\*` instead of turning it into `_`. Matching a
  literal `*` needs a server that reads `\*` as a literal (newer than 0.5.6);
  older servers still treat each `*` as `%`.
- `FileStorage` runs its filesystem calls on the blocking pool and creates
  missing parent directories with mode 0700 on Unix. On Windows the file keeps
  inheriting its directory's ACL (documented).
- `Error::Network` messages include the transport's cause chain (still without
  request URLs).
- The published crate contains only `src`, `examples`, README, changelog,
  license and manifest. The generator fixture moved to
  `tests/fixtures/generated.rs`; the package check is `scripts/test-package.py`.
- `docs/contract.md` is reorganized into the protocol contract and a short
  upgrade section.

### Fixed

- An expired token is no longer sent after a transient refresh failure: the
  request returns the refresh error (retryable, with Retry-After) instead of a
  401 from the stale token.
- A corrupt or invalid stored session no longer makes every call fail: it
  counts as signed out, emits `SignedOut` and is removed on a best-effort basis;
  `sign_out` always clears storage. Stores report corrupt content with the new
  `Error::SessionInvalid` (`FileStorage` does); any other `load` error, such as
  a sharing violation, is returned and the stored session is kept.
- Background refresh backs off (up to 60 s) instead of waking every second when
  a refreshed session is immediately due again.
- Concurrent refresh callers on a multi-threaded runtime share one rotation;
  the decision to join or start one is atomic.
  A rotation task that panics no longer leaves later callers waiting on it.
- Serializing a bare `Field::Omit` (a hand-written struct without
  `skip_serializing_if = "Field::is_omitted"`) fails with an explanation
  instead of silently writing `null`.
- `Condition` refuses dotted column names, which the server's logic-tree
  grammar rejects.
- `with_access_token` validates its token like `ClientBuilder::access_token`;
  an invalid one fails each request with the same `Error::Usage`.
- `get_session` honors the refresh backoff: after a transient refresh failure
  it returns the still-valid session without starting another rotation until
  Retry-After (or 2 s) has elapsed, so a caller polling it no longer sends a
  refresh on every call.

## 0.1.7 — 2026-10-26

### Fixed

- Run a shared session refresh under the client's timeout instead of the first
  caller's, so a zero (disabled) or very short request timeout can neither hold
  the lifecycle lock indefinitely nor abandon a rotation the server committed.
- Rotate a session that is due even when a user update moved the session epoch
  while the refresh waited, instead of returning the expiring token.
- Retry background refresh after an uncertain failure within 2 seconds, inside
  the server's 10-second window for reusing the previous refresh token.

## 0.1.6 — 2026-10-24

### Fixed

- Preserve the received HTTP error status and Retry-After when its response body
  is interrupted. Discard the unreadable metadata instead of reclassifying a
  definite rejection as a network failure and retrying it. Successful body
  failures, cancellation and buffered deadlines retain their existing behavior.

## 0.1.5 — 2026-10-24

### Fixed

- Renew only expired sessions under the lifecycle owner before logout, revoking a
  still-valid token directly. The renewal only revokes itself and is never saved
  or emitted; local clearing is retained on revocation failure. Keep reserved-column filters inside logic
  groups so modifiers cannot silently discard their predicates.

- Clean up owned FileStorage temporary files when a save is cancelled, preserving
  the previous session and other writers' files; sync its directory on Unix.
- Let explicit query timeouts override scoped client defaults, including zero.
- Refuse explicit MIME types the server cannot preserve, using shared SDK fixtures.

### Changed

- Separate private auth persistence, OAuth and refresh-task ownership, and REST
  request preparation and response decoding, preserving public imports and APIs.
- Decode single-row representations by ownership instead of copying their JSON.


## 0.1.4 — 2026-10-19

### Changed

- Organize private authentication, REST and storage modules by responsibility,
  preserving public imports, serialization, HTTP behavior and lifecycle ownership.

### Fixed

- Refuse blank OAuth codes and empty or malformed MIME type/subtype components
  before HTTP, preserving valid zero-byte uploads and content-type parameters.
- Keep delayed profile responses from replacing newer cached user data after
  an update, refresh or explicit session replacement, including identical tokens.
- Reject `single`/`maybe_single` on HEAD and minimal writes before HTTP, so a
  missing row representation cannot report an error after committing a write.
  Explicit write representations and array-returning RPC calls remain supported.
- Cancel queued authentication requests and session reads while preserving
  accepted refresh rotation and session publication ownership.
- Resolve package verification archives through Cargo metadata, honoring
  `CARGO_TARGET_DIR` and Cargo configuration instead of selecting a stale archive.

## 0.1.3 — 2026-10-19

Published independently of the server. Consult the registry entry for the
selected version; source version metadata does not publish a package.

### Fixed

- Reject nested NaN/infinite write/RPC input before serialization can turn it
  into null; preserve explicit null and omitted-field semantics.

- Verify that cancelled refresh waiters and dropped auto-refresh handles release
  their owned resources while accepted rotation remains shared.

- Cap foreground and background refresh margins at half the token lifetime,
  avoiding unnecessary rotation of fresh short-lived sessions or sessions with
  oversized configured margins.

## 0.1.2 — 2026-10-11

### Fixed

- Bound HTTP error bodies to 64 KiB while preserving status and `Retry-After`.
- Share one background refresh worker across concurrent callers. Cancelling
  waiters does not create a task per waiter or stop an accepted token rotation.
- Fence refresh results across logout and client disposal so a stale completion
  cannot replace the current session.
- Verify packaging, native platform support and the real-server contract against
  Nelcota 0.4.0. The minimum supported server remains 0.3.0 and Rust remains 1.88.

## 0.1.1 — 2026-10-11

### Changed

- Update repository and documentation links to `Nelcota/Nelcota` after the
  organization transfer. The client API and server compatibility are unchanged.
- Publish from the organization with GitHub Actions trusted publishing (OIDC).

## 0.1.0 — 2026-10-10

### Added

- `AuthClient::update_user(UserUpdate)` for the new `PUT /auth/v1/user`:
  change the password (other sessions end) or merge `user_metadata`. Needs a
  server with that endpoint.

- Minimum supported Rust version lowered from 1.99 to 1.88, the oldest
  release the dependency tree supports; CI tests it.

- `auth::FileStorage` persists the session in a JSON file, replaced
  atomically and created with mode 0600 on Unix.

- `ClientBuilder::header(name, value)` sends a header with every request.

- **Breaking:** `UploadOptions::content_type` is an `Option<String>`. `None`
  (the default) guesses the type from the object name's extension for common
  types (`storage::guess_content_type`) instead of always sending
  `application/octet-stream`, which made browsers download SVGs and PDFs
  rather than display them.

- **Breaking:** `StorageClient::update_bucket` takes a `BucketUpdate` instead
  of `BucketSettings`. `BucketSettings { public: true, ..Default::default() }`
  silently cleared the size and MIME limits, because the PUT replaces every
  setting. `BucketUpdate` has no `Default`; build it from the current bucket
  (`BucketUpdate { public: true, ..bucket.into() }`) or spell out each field.
  This matches the TypeScript client, which requires all three fields.

- `Error::Http` gains a `db` field with the optional Postgres fields the server
  may send (`sqlstate`, `details`, `hint`, `constraint`), read through
  `Error::sqlstate()` and friends. Code that builds `Error::Http` by hand must
  add `db: None`. New helpers: `is_not_found`, `is_conflict`,
  `is_unique_violation`, `is_rate_limited`, `is_unauthorized`, `is_forbidden`,
  `is_retryable`.
- Error responses without a JSON body use `unauthorized`, `forbidden`,
  `not_found`, `rate_limited` or `unavailable` instead of `http_<status>`.

- Correct negated leaf condition encoding and double negation for leaves and
  groups, with production HTTP/Postgres regressions.

- Native Tokio client with standalone rustls/ring HTTPS, structured errors,
  request cancellation, bounded read retries and deadlines.
- REST reads/writes, groups, embeds, count, cardinality, upsert and RPC.
- In-memory/custom session stores, coordinated refresh, auth events,
  optional background refresh, email links and OAuth PKCE.
- Streaming storage, ranges/ETags, signed/public URLs and bucket management.
- Rust catalog models through `nelcota types --lang rust`, with precise numeric
  values and explicit omitted/null write fields.
