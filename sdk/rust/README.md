# nelcota-client

Async Rust SDK for Nelcota: REST tables/views and RPC, auth sessions and OAuth,
and file storage under PostgreSQL RLS. For native applications using Tokio.

```toml
[dependencies]
nelcota-client = "0.1.4"
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

This guide targets 0.1.4. Version 0.1.3 is the previous published baseline;
0.1.4 adds queued-auth cancellation, profile ordering, cardinality preflight
and OAuth/MIME input checks. Registry installation requires successful
publication of that version; use a local path/archive before it is available.
See the [upgrade notes](docs/contract.md#upgrading-from-013). Installing a server release does not
update clients. Rust 1.88+, server 0.3.0+ and the HTTP contract remain unchanged.

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
Conditions are constructed, never assembled from untrusted syntax strings.
Embedded filters use paths such as `items.qty`; `order_on`, `limit_on`,
`range_on`, `and_on`, `or_on` target embedded rows. `order` calls accumulate.

Writes return an empty body by default (`execute::<()>()`); call `select` for
representation. `single` requires exactly one row; `maybe_single` returns null
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
let background = client.auth().start_auto_refresh(); // opt-in; retain this handle
client.auth().request_password_reset("ana@example.com").await?;
client.auth().send_magic_link("ana@example.com").await?;
client.auth().resend_confirmation("ana@example.com").await?;
client.auth().sign_out().await?;
drop(background);
# Ok(()) }
```

Session storage defaults to memory. For a CLI or desktop app,
`auth::FileStorage::new(path)` keeps the session in a JSON file, written
atomically and readable by its owner only (0600 on Unix). Implement
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

Refresh runs before expiry when a request needs a token. Opt-in background
refresh stops when its handle is dropped. Both paths cap the configured refresh
margin at half the token lifetime, avoiding repeated rotation of fresh
short-lived tokens. Rotation continues if a waiter is
cancelled/dropped, so a consumed refresh token can still be replaced locally.
A transient failure keeps the previous identity; an invalid grant clears the
session and returns the failure to the initiating request. Logout waits for
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

OAuth uses PKCE S256 with Google/GitHub. `begin_oauth` returns `PkceFlow { url,
verifier }`; keep it private, open its URL in your application's browser flow,
and consume it with `handle_redirect(&mut callback_url, flow)` or exchange the
code/verifier explicitly. The SDK does not open a browser or create a callback
server. `redirect_to` must be in `NELCOTA_OAUTH_REDIRECT_URLS`.

Email links carry `#type=...&token=...`. `EmailLink::parse(&mut url)` extracts
the token and clears the fragment. Pass signup/magic links to
`verify_email_link`; use `reset_password(token, password)` for recovery.
Session, flow and link Debug implementations omit secret tokens.

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

`Field::Omit` skips a write field, keeping its default/current value;
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
