# Changelog

Package releases use Semantic Versioning and Keep a Changelog categories.
Dates identify release entries; registry availability requires a successful publish.

## Unreleased

### Fixed

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
