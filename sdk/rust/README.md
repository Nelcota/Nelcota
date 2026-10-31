# nelcota-client

Async Rust SDK for Nelcota: REST tables/views and RPC, auth sessions and OAuth,
and file storage under PostgreSQL RLS. For native applications using Tokio.

```toml
[dependencies]
nelcota-client = "0.1.7"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

Requires Rust 1.88+ (checked in CI) and Nelcota server 0.3.0 or later.

| SDK | Server baseline | Support |
|---|---|---|
| 0.1.x | Server `v0.3.0` or later | Full HTTP/Postgres contract suite, OAuth, `update_user` and generated Rust models |
| 0.1.x | Server `v0.2.0` | Not supported: lacks the OAuth routes, `PUT /auth/v1/user`, the JSON error contract and the Rust generator |

```rust,no_run
use nelcota_client::{Client, rest::Order};
use serde::Deserialize;

#[derive(Deserialize)]
struct Note { id: i64, body: String }

# async fn example() -> nelcota_client::Result<()> {
let client = Client::builder("https://api.example.com").build()?;
client.auth().sign_in_with_password("ana@example.com", "password").await?;
let response = client.from("notes").select("id,body")
    .order("id", Order::descending()).range(0, 19).count_exact()
    .execute::<Vec<Note>>().await?;
for note in response.data { println!("{}: {}", note.id, note.body); }
# Ok(()) }
```

## Version scope

This guide targets 0.1.7. Version 0.1.6 is the previous published baseline.
The patch runs the shared session refresh under the client's timeout rather than
the first caller's, rotates a due session after a concurrent user update, and
retries background refresh inside the server's 10-second reuse window.
It preserves public imports, Rust 1.88+, native Tokio and the server protocol.
See the [changelog](CHANGELOG.md) and [upgrade notes](docs/contract.md#upgrading).
Version 0.1.7 is available on crates.io; [registry receipts](https://github.com/Nelcota/Nelcota/pull/181#issuecomment-6423930169)
record its checksum and a fresh consumer. A server upgrade does not
update installed clients.

## REST

Builders are local and consume `self`; clone a base query to reuse it. Only
`execute` sends HTTP. Results are `Result<Response<T>, Error>`; response metadata
includes HTTP status, count and headers. Decode into your own `Deserialize`
structs or `serde_json::Value`. Column names and select expressions are checked
by the server against its current catalog; these strings are not compile-time
schema validation.

```rust,no_run
# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {
use serde_json::{Value, json};
use nelcota_client::rest::{Condition, IsValue, UpsertOptions};
let note = client.from("notes").insert(&json!({"body":"hello"}))
    .select("id,body").single().execute::<Value>().await?;
client.from("notes").update(&json!({"body":"edited"}))
    .eq("id", &note.data["id"]).execute::<()>().await?;
client.from("notes").delete().eq("id", &note.data["id"])
    .execute::<()>().await?;
client.from("products").upsert(&json!({"slug":"pen","name":"Pen"}),
    UpsertOptions { on_conflict:vec!["slug".into()], ..Default::default() })
    .execute::<()>().await?;
client.from("orders").select("id,customer:customers(name),items(product,qty)")
    .gte("items.qty", 2)
    .or([Condition::eq("status", "paid"),
         Condition::all([Condition::gt("total", 100), !Condition::is("archived", IsValue::True)])])
    .execute::<Vec<Value>>().await?;
let total = client.rpc("cart_total", &json!({"cart_id":7}))
    .execute::<Value>().await?;
# Ok(()) }
```

Filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in_values`,
`not_in`, `is`/`is_null`, `not_is`, `not`, `matches`, `and`, `or`.
Conditions are constructed, never assembled from untrusted syntax strings;
`Condition` columns are plain names of the filtered table (no `relation.column`).
`escape_like(text)` makes `like`/`ilike` match text literally, escaping `\`, `%`,
`_` and `*` (a literal `*` needs a server newer than 0.5.6; older servers treat
every `*` as a wildcard).
Embedded filters use paths such as `items.qty`; `order_on`, `limit_on`,
`range_on`, `and_on`, `or_on` target embedded rows. `order` calls accumulate.

Writes return an empty body by default (`execute::<()>()`); call `select`,
before or after `insert`/`update`/`upsert`/`delete`, for representation. `single` requires exactly one row; `maybe_single` returns null
for zero rows (decode to `Option<T>`). Use `head().count_exact().execute::<()>()`
for count-only reads. Update/delete require a parent filter before any HTTP is
sent. Exact counts scan all matching rows; only request them when needed.

Each read returns at most `NELCOTA_MAX_ROWS` rows (1000 by default), even
without `limit`. Page with `range(start, end)` or `limit` + `offset`, ordered
by a unique column, until a page comes back empty; `count_exact()` gives the
total when you need it.

## Auth

```rust,no_run
# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {
let signup = client.auth().sign_up("ana@example.com", "strong-password-123", None).await?;
// signup.session is None while email confirmation is pending.
let session = client.auth().get_session().await?;
let user = client.auth().get_user().await?;
// Merged into user_metadata; a null value removes the key.
client.auth().update_user(nelcota_client::auth::UserUpdate {
    data: Some(serde_json::json!({ "plan": "pro" })),
    ..Default::default()
}).await?;
let mut events = client.auth().subscribe();
let background = client.auth().try_start_auto_refresh()?; // opt-in; retain this handle
client.auth().request_password_reset("ana@example.com").await?;
client.auth().send_magic_link("ana@example.com").await?;
client.auth().resend_confirmation("ana@example.com").await?;
client.auth().sign_out().await?;
drop(background);
# Ok(()) }
```

Session storage defaults to memory. For a CLI or desktop app,
`auth::FileStorage::new(path)` keeps the session in a JSON file, written
atomically and readable by its owner only on Unix (0600 file, 0700 for the
directories it creates). On Windows the file inherits its directory's ACL, so
keep it under the user's profile. A corrupt stored session counts as signed
out: the client emits `SignedOut` and removes it. A failure to read the file
(permissions, a sharing violation) is returned and the file is kept. Implement
`auth::SessionStorage` for a keychain, encrypted file or per-request cookie
store.

```rust,no_run
# fn example() -> nelcota_client::Result<()> {
use std::sync::Arc;
use nelcota_client::{Client, auth::FileStorage};
let client = Client::builder("https://api.example.com")
    .session_storage(Arc::new(FileStorage::new("/home/ana/.config/notes/session.json")))
    .build()?;
# Ok(()) }
```
Clones share one session,
lifecycle lock and refresh result. Independent clients/processes sharing a
persistent store need external coordination: the store interface alone does
not serialize refresh. A spent refresh token terminates its server session.

Reading the session never waits for sign-in, refresh or persistence. Refresh
starts when a request needs a token inside the refresh margin; the request keeps
sending the still-valid token, and only an expired token waits for the shared
rotation. Expiry is measured on this machine's clock from `expires_in`, so
server clock skew does not cause early or late refresh. Opt-in background
refresh stops when its handle is dropped. Both paths cap the configured refresh
margin at half the token lifetime, avoiding repeated rotation of fresh
short-lived tokens. Rotation continues if a waiter is
cancelled/dropped, so a consumed refresh token can still be replaced locally.
A transient failure keeps a still-valid identity; once the token has expired the
request returns the refresh error (with its status and Retry-After) instead of
sending it. An invalid grant clears the session and returns the failure. Logout waits for
rotation and clears locally even if server revocation fails. Existing access
tokens may remain valid until expiry.

In a backend, scope a caller token to a clone; this does not alter the shared
session or refresh the supplied token:

```rust,no_run
# fn example(client: nelcota_client::Client, caller_token: String) {
let caller = client.with_access_token(caller_token);
let visitor = client.anonymous();
# }
```

A token that cannot be sent as a header makes every request of that clone fail
with the same `Error::Usage` that `ClientBuilder::build` returns for
`access_token`; `try_with_access_token` returns that error immediately.

OAuth uses PKCE S256 with Google/GitHub. `begin_oauth` returns `PkceFlow { url,
verifier }`; keep it private, open its URL in your application's browser flow,
and consume it with `handle_redirect(&mut callback_url, flow)` or exchange the
code/verifier explicitly. The SDK does not open a browser or create a callback
server. `redirect_to` must be in `NELCOTA_OAUTH_REDIRECT_URLS`.

Email links carry `#type=...&token=...`. `EmailLink::parse(&mut url)` extracts
the token and clears the fragment. Pass signup/magic links to
`verify_email_link`; use `reset_password(token, password)` for recovery.
Session, flow, sign-up and link Debug implementations omit secret tokens.

A sign-up awaiting confirmation returns `SignUp { verifier: Some(..) }`, the
PKCE verifier bound to its email link. Keep it private with the pending
sign-up (the SDK does not store it) and confirm with
`verify_signup_link(&link, &verifier)` to keep the password chosen at sign-up;
keep it until that succeeds, so a failed attempt can be retried. Confirming
with `verify_email_link`, from another device or with a resent link still
signs in, but the server clears that password; set one with `update_user`.

## Storage

```rust,no_run
# async fn example(client: nelcota_client::Client, user_id: String) -> nelcota_client::Result<()> {
use nelcota_client::storage::{UploadOptions, OpenOptions, ListOptions};
let files = client.storage().from("avatars")?;
let name = format!("{user_id}/me.txt");
files.upload(&name, "hello", UploadOptions::default()).await?; // text/plain, from .txt
files.upload("logo", "<svg/>", UploadOptions {
    content_type: Some("image/svg+xml".into()), upsert: true,
}).await?;
let bytes = files.download(&name).await?;
let response = files.open(&name, OpenOptions { range:Some((0,Some(3))), ..Default::default() }).await?;
let listing = files.list(ListOptions { prefix:format!("{user_id}/"), ..Default::default() }).await?;
let signed_url = files.create_signed_url(&name, 3600).await?;
let public_url = files.public_url(&name)?;
files.remove(&name).await?;
# Ok(()) }
```

Without an explicit `content_type`, uploads guess it from the name's extension
(`json`, `csv`, `txt`, `html`, `css`, `js`, `svg`, `png`, `jpg`, `gif`, `webp`,
`pdf`, `mp4` and other common types; see `storage::guess_content_type`) and
fall back to `application/octet-stream`. `upload_reader` streams a Tokio reader. `open` returns a streaming
`reqwest::Response`; handle 206, 304, ETag and stream failures yourself after it
returns. `download` buffers the file and reports body failures in its Result.
Uploads/downloads default to no deadline; scope a `RequestOptions` timeout when
needed. S3 redirects are followed; bearer tokens are stripped across origins.
Object names are NFC-normalized and encoded per segment. Empty/dot segments,
backslashes and control characters are rejected.

Buckets support list/get/create/update/delete, usually with `service_role`.
`update_bucket` replaces all settings, so it takes a `BucketUpdate`, which has
no `Default`: every field is explicit, and `None` clears a limit on purpose.
Start from the current bucket to change one setting:

```rust,no_run
# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {
use nelcota_client::storage::BucketUpdate;
let current = client.storage().get_bucket("avatars").await?;
client.storage().update_bucket("avatars", BucketUpdate { public: true, ..current.into() }).await?;
# Ok(()) }
```

Authorization belongs to server RLS; a `service_role` token bypasses it and
belongs only in a trusted application.

## Rust schema types

```sh
nelcota types --lang rust -o src/database.rs
```

Generated modules expose `schema::table::{Row, Insert, Update, NAME,
PRIMARY_KEY}` and `schema::rpc::function::{Args, Returns, NAME}`. Enum columns
have serde-renamed enums. Generated/identity-always columns are omitted from
write models; views have write models except materialized views. Projections
and embeds need structs matching their selected shape.

`Field::Omit` skips a write field, keeping its default/current value. Hand-written
structs need `#[serde(default, skip_serializing_if = "nelcota_client::Field::is_omitted")]`
on each `Field` (generated ones have it); a bare `Omit` fails to serialize rather
than writing null.
`Field::Value(None)` sends explicit null for nullable columns. UUID/date/time
and unknown scalar types use strings. Bigint uses i64, numeric uses
`serde_json::Number` with arbitrary precision, and arrays allow null elements.
RPC return aliases allow null; optional arguments distinguish omission from
explicit null. Types are generated from the configured exposed schema, without
requiring a DB connection when compiling consumer applications.

## Errors, deadlines and retries

`Error::code()`, `status()` and `retry_after()` preserve server facts.
Other variants distinguish invalid input, network, timeout, cancellation,
invalid response, cardinality and session storage failures. No panic is used
for caller configuration or HTTP failures. Signed request URLs are omitted
from transport error text. A response without a JSON body (a `head()` count, a
proxy page) gets `unauthorized`, `forbidden`, `not_found`, `rate_limited`,
`unavailable` or `http_<status>` as its code.

When the server reports them, `sqlstate()`, `details()`, `hint()` and
`constraint()` expose what Postgres said about a `db_error`; older servers send
none. Helpers classify common cases: `is_not_found()`, `is_conflict()`,
`is_unique_violation()`, `is_rate_limited()`, `is_unauthorized()`,
`is_forbidden()` and `is_retryable()`.

```rust,no_run
# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {
use serde_json::json;
match client.from("notes").insert(&json!({"slug":"a"})).execute::<()>().await {
    Err(error) if error.is_unique_violation() => {
        println!("taken ({:?})", error.constraint());
    }
    other => { other?; }
}
# Ok(()) }
```

Only GET/HEAD retry network/body-read failures and 429/503, default two retries.
The backoff has jitter and respects Retry-After (seconds or HTTP date); a delay
over 30 seconds returns immediately. Mutations, auth exchange, RPC and POST
storage listings never retry automatically. Timeouts cover each attempt and
buffered body; refresh and backoff are separate. Drop a request future or use
`CancellationToken` to cancel; an already accepted server write cannot be undone
by cancelling the client. Raw stream lifetime is managed by reqwest/caller.

`Client::builder(url).header("x-app", "notes")` adds a header to every request;
`build` refuses invalid headers and `Authorization`, which comes from
`access_token` or the session. Custom `http_client` instances must disable
their own auth/mutation retries.
The default client uses explicit rustls/ring and Mozilla roots without a global
crypto-provider initialization. It can be reused across tasks.

Start with the [quickstart](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md)
(local server, migration, generated types). The examples in `examples/` use
the shared [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql)
schema. Empty results, 401/403 or a 1000-row cap? See
[troubleshooting](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md).
Portuguese guide: [quickstart.pt-BR.md](docs/quickstart.pt-BR.md).
Contract: [contract.md](docs/contract.md). Release: [releasing.md](docs/releasing.md).


## Reliable lifecycle and streaming

Clone a client to share one login lifecycle. For independent request identities,
use `with_access_token` or `anonymous`; do not change a shared login session for
each incoming user. Independent clients/processes that share FileStorage need
external rotation coordination. Keep its parent directory private and handle
storage errors without logging session credentials.

Use `tokio::time::timeout` around the complete operation for a caller deadline;
query and scoped timeouts cover individual HTTP attempts. Since 0.1.5, an explicit query timeout overrides the scoped default. For large
files, use `storage().from(bucket)?.open(...)` and consume response chunks with
backpressure; dropping the response stops reading it. `download()` deliberately
buffers bytes. Background refresh is opt-in: retain its handle while needed and
drop it when the owner ends.
