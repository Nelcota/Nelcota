# Rust SDK contract

`nelcota-client` 0.1.7 supports Nelcota server 0.3.0 or later; its release
checks run against the server source in the same checkout (currently 0.5.6).
The released v0.2.0 tag is a legacy baseline without the newer OAuth routes and
generators; see the README compatibility matrix. Package and server versions are
independent: a server upgrade never changes a client already compiled into an
application. Native Tokio on Linux, Windows and macOS is the supported target;
blocking and WASM interfaces are not part of 0.1. Minimum Rust: 1.88.

## HTTP surface

| Module | HTTP contract |
|---|---|
| REST read | GET/HEAD `/rest/v1/{table}`; select/filter/order/paging, Prefer count, Content-Range |
| REST write | POST/PATCH/DELETE `/rest/v1/{table}`; minimal/representation, upsert resolution/on_conflict |
| RPC | POST `/rest/v1/rpc/{name}` with named JSON arguments |
| Auth | POST signup with an S256 challenge; token grants password/refresh_token/pkce; GET/PUT user; POST logout |
| Email | POST recover/magiclink/resend/verify; signup verification with its `code_verifier` |
| OAuth | Authorization URL with S256 PKCE; one-use code exchange |
| Objects | POST/PUT/GET/DELETE `/storage/v1/object/{bucket}/{path}`, raw bytes |
| Sharing/listing | POST object/list and object/sign; local object/public URL construction |
| Buckets | GET/POST bucket; GET/PUT/DELETE bucket/{id} |

The query grammar and server capabilities match the TypeScript contract.
Responses become Rust `Result` values; empty bodies become JSON null (decode to
unit or an appropriate `Option`). `Response<T>` carries status, count and
headers. Auth/storage convenience methods return the decoded model or a
structured error.

## Queries

- Invalid input (identifiers, select syntax, non-finite floats at any depth,
  empty groups, a bare `Field::Omit`) fails with `Error::Usage` before HTTP.
- Writes send `Prefer: return=minimal` unless `select` was called, before or
  after the write method; then `return=representation`. `single` and
  `maybe_single` are refused before HTTP for HEAD and minimal writes;
  array-returning RPC calls are allowed.
- Update/delete require a parent filter; insert/upsert refuse filters.
- Reserved column names (`limit`, `order`...) used as filters are sent inside a
  logic group so they stay predicates.
- `Condition` columns are plain identifiers of the filtered table; the server's
  logic-tree grammar has no dotted columns.
- `like`/`ilike` patterns use `*` as the wildcard. `escape_like` backslash-escapes
  `\`, `%`, `_` and `*`; servers after 0.5.6 read `\*` as a literal `*`, older
  ones turn every `*` into `%`.

## Transport

- Timeout precedence: explicit query timeout, scoped `RequestOptions.timeout`,
  then the client default. Zero disables the deadline. File transfers keep their
  unbounded default unless `RequestOptions.timeout` is set. Wrap the whole
  operation in `tokio::time::timeout` for a total deadline.
- Only GET/HEAD are retried (network errors, 429, 503, bounded by Retry-After
  ≤ 30 s); mutations are never replayed.
- Oversized or interrupted error bodies are discarded; status, a generic error
  code and Retry-After remain. Cancellation covers retries and buffered bodies.
- An explicit token (`ClientBuilder::access_token`, `with_access_token`) that is
  not a valid header value fails with the same `Error::Usage` everywhere.

## Sessions

- One `Client` and its clones share one session. Explicit-token and anonymous
  clones control REST/storage, `get_user` and `update_user` only; other auth
  methods manage the shared login session.
- Reads (requests, `get_session` of a fresh session) are lock-free snapshots.
  Sign-in, rotation, user updates and sign-out serialize on one lifecycle lock
  together with their HTTP and persistence.
- A token inside the refresh margin (capped at half its lifetime) is still sent
  while one shared, detached rotation runs; only an expired token waits for it.
  Cancelling waiters neither stops an accepted rotation nor leaves a task each.
  After a transient failure, requests and `get_session` with a still-valid
  token start the next rotation only once Retry-After (or 2 s) has elapsed;
  until then `get_session` returns the current session.
  The rotation uses the client's timeout, not a caller's.
- If refresh fails transiently and the token has expired, the request returns
  that error (retryable, with Retry-After). `invalid_grant` clears the session.
- Expiry is tracked on the local monotonic clock from `expires_in`. Sessions
  received from the server get `expires_at` rewritten to local time plus
  `expires_in`, so a persisted copy is also skew-free; `set_session` and stored
  sessions use `expires_at` against the local wall clock.
- A stored session the store reports as `Error::SessionInvalid`, or one that
  fails validation, counts as signed out: a `SignedOut` event is emitted and the
  store is asked to remove it. Any other `load` error is returned and the store
  is left untouched; the next call loads again.
- Sign-out renews only an expired token (5 s skew) for revocation, never
  publishes that renewal, and always clears locally.
- `try_start_auto_refresh` returns an error outside a Tokio runtime;
  `start_auto_refresh` panics there. Dropping the handle stops the task. When a
  refreshed session is immediately due again, wake-ups back off up to 60 s.
- `FileStorage` writes atomically (temporary file + rename), owner-only on Unix
  (0600 file, 0700 created directories) with directory sync; on Windows the
  file inherits the directory ACL. A dropped save removes only its own
  temporary file. Independent clients/processes sharing a store must coordinate
  rotation themselves.

## Models

Generated models provide serde shapes, not compile-time verification of string
queries. Missing required selected columns fail decoding. Numeric precision is
preserved by `arbitrary_precision`. `Field::Omit` and `Field::Value(None)`
differ; every `Field` needs `skip_serializing_if = "Field::is_omitted"`, which
generated models always carry.

## Acceptance checks

SDK tests/doctests/examples, server HTTP contract tests, Rust generator snapshot
(`tests/fixtures/generated.rs`) and generated-model serialization tests,
Clippy/rustfmt, docs, package verification (`scripts/test-package.py`) and an
external consumer smoke test.

## Upgrading

Set the new version in `Cargo.toml`, run
`cargo update -p nelcota-client --precise <version>`, then rebuild and exercise
login/refresh/sign-out, a write with representation and a file transfer in
staging. Public imports, Rust 1.88+ and the server protocol are unchanged unless
noted below; the [changelog](../CHANGELOG.md) lists every change.

### Unreleased

- `select` before `insert`/`update`/`delete` now returns rows; previously the
  write method reset it to minimal.
- Serializing a bare `Field::Omit` (a hand-written struct without
  `skip_serializing_if`) is an error instead of writing null.
- `Condition` refuses dotted columns, which the server rejected anyway.
- `escape_like` escapes `*` as `\*` (was `_`); upgrade the server past 0.5.6 for
  literal-star matching.
- Requests no longer wait behind a slow refresh while the token is valid, and
  an expired token is no longer sent after a failed refresh.
- `Session::expires_at` from the server is rewritten to the local clock.

### Upgrading from 0.1.6

A shared session refresh uses the client's timeout, so a zero or very short
per-request timeout no longer applies to it; a due session is rotated even when
a user update ran meanwhile; background refresh retries within 2 seconds after
an uncertain failure.

### Older baselines

- 0.1.5 → 0.1.6: interrupted HTTP error bodies keep status and Retry-After, so a
  definite rejection is not retried as a network failure.
- 0.1.4 → 0.1.5: logout revokes a still-valid token without refreshing it;
  reserved-column filters stay predicates; cancelled file saves remove only
  their own temporary file; an explicit query timeout (including zero) beats a
  scoped default; explicit MIME types follow the server's rules (ASCII letters,
  digits and `!#$&-^_.+`, 1–127 characters per part).
- 0.1.3 → 0.1.4: `single`/`maybe_single` need `.select(...)` on writes; blank
  OAuth codes and malformed MIME types fail with `Error::Usage`; cancellation
  releases queued auth callers without interrupting an accepted refresh.
