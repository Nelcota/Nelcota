# Rust SDK contract

`nelcota-client` 0.1.x supports Nelcota server 0.3.0 or later; release 0.1.2 is
verified against server 0.4.0. The released v0.2.0 tag is a legacy baseline
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

HTTP error bodies larger than 64 KiB are discarded; status, a generic error
code and Retry-After remain available. Successful responses keep their existing
buffering or streaming contract.

One Client and its clones share lifecycle coordination. Explicit token clones
control REST/storage and get_user only; other auth methods manage the shared
login session. Refresh waiters share one background rotation task; cancelling
or dropping them does not leave a task per waiter or stop an accepted rotation.
Default sessions never persist outside memory. Shared stores across independently
constructed clients/processes require their own coordination.

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

Prepared 0.1.3 retains the core HTTP contract and minimum versions of 0.1.2.
Its refresh-margin/finite-input corrections and expanded lifecycle checks need
a new client build/package. Registry availability requires successful
publication; server and SDK releases remain independent.
