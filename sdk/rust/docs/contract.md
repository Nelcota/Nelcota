# Rust SDK contract

`nelcota-client` 0.1.4 supports Nelcota server 0.3.0 or later; its release
checks run against this repository’s server 0.5.0 source. The released v0.2.0 tag is a legacy baseline
without the newer OAuth routes and generators; see the README compatibility
matrix. Package and server versions are independent. Native Tokio on Linux,
Windows and macOS is the supported target; blocking and WASM interfaces are
not part of 0.1.

| Module | HTTP contract |
|---|---|
| REST read | GET/HEAD `/rest/v1/{table}`; select/filter/order/paging, Prefer count, Content-Range |
| REST write | POST/PATCH/DELETE `/rest/v1/{table}`; minimal/representation, upsert resolution/on_conflict |
| RPC | POST `/rest/v1/rpc/{name}` with named JSON arguments |
| Auth | POST signup; token grants password/refresh_token/pkce; GET user; POST logout |
| Email | POST recover/magiclink/resend/verify |
| OAuth | Authorization URL with S256 PKCE; one-use code exchange |
| Objects | POST/PUT/GET/DELETE `/storage/v1/object/{bucket}/{path}`, raw bytes |
| Sharing/listing | POST object/list and object/sign; local object/public URL construction |
| Buckets | GET/POST bucket; GET/PUT/DELETE bucket/{id} |

The query grammar and server capabilities match the TypeScript contract.
Responses become Rust Result values; empty bodies become JSON null (decode to
unit or an appropriate Option). `Response<T>` carries status, count and headers.
Auth/storage convenience methods return the decoded model or structured error.

Version 0.1.4 cardinality preflight rejects HEAD and minimal writes with
`single`/`maybe_single` before HTTP. Request write rows with `.select(...)`;
array-returning RPC calls remain supported. Version 0.1.3 predates this guard.

HTTP error bodies larger than 64 KiB are discarded; status, a generic error
code and Retry-After remain available. Successful responses keep their existing
buffering or streaming contract.

One Client and its clones share lifecycle coordination. Explicit token clones
control REST/storage and get_user only; other auth methods manage the shared
login session. Refresh waiters share one background rotation task; cancelling
or dropping them does not leave a task per waiter or stop an accepted rotation.
Default sessions never persist outside memory. Shared stores across independently
constructed clients/processes require their own coordination.

Version 0.1.4 token cancellation also covers authentication waiting for the lifecycle
gate and session reads. It does not interrupt persistence of an accepted session;
detached refresh rotation keeps its existing owner. Logout still waits for that
owner and clears locally even if revocation fails.
These changes require a new client package; server installation does not add them.

On-demand and background refresh cap the configured margin at half the token
lifetime. Short-lived fresh sessions and oversized margins do not cause a
rotation on every request or timer tick; explicit refresh remains available.

Generated models provide serde shapes, not compile-time verification of string
queries. Missing required selected columns fail decoding. Numeric precision is
preserved by arbitrary_precision; write null and omitted fields differ.

REST writes and RPC reject non-finite floating-point input, including nested
fields, before HTTP. Serde must not silently turn NaN or infinity into JSON
null. Explicit null and omitted fields retain their existing semantics, and
serialization runs once without adding dependencies.

Acceptance checks: SDK tests/doctests/examples, server HTTP contract tests,
Rust generator snapshot and generated model compile/serialization tests,
Clippy/rustfmt, docs, package verification and an external consumer smoke test.

Version 0.1.4 retains the core HTTP contract and minimum Rust/server versions
of 0.1.3. Its corrections require an updated client build/package. Registry
availability requires successful publication; server and SDK releases remain
independent. See the [upgrade notes](#upgrading-from-013).

## Upgrading from 0.1.3

Set `nelcota-client = "0.1.4"`, update Cargo.lock with
`cargo update -p nelcota-client --precise 0.1.4`, then build and test the
application. Rust 1.88+, native Tokio on the supported platforms, server 0.3.0+
and public Rust imports remain unchanged. Server upgrades do not update this crate.

- Request a row with `.select(...)` before `single`/`maybe_single` on a write;
  HEAD and minimal writes are refused before HTTP. The SDK therefore cannot
  commit such a write and only afterward report missing cardinality.
- Handle `Error::Usage` for blank OAuth codes and malformed MIME type/subtype
  components. Valid content-type parameters, optional space/tab before their
  delimiter, and zero-byte uploads remain supported; headers are sent unchanged.
- Cancellation releases queued auth/session callers without interrupting an
  accepted refresh/persistence owner. Older user reads preserve newer cached
  profile/session state. Retry limits and mutation replay policy are unchanged.

Exercise login/refresh/sign-out, row representation/cardinality and a file
transfer in staging. Registry installation requires the selected version to be
published; before then, use a reviewed local path or packaged archive.
