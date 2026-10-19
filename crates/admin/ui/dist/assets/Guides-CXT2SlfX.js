import{$ as e,At as t,B as n,C as r,Ct as i,Gt as a,Ht as o,L as s,Lt as c,Mt as l,Ot as u,R as d,Rt as f,St as p,Tt as m,U as h,V as g,W as _,Wt as ee,X as v,_ as y,_t as b,dt as x,et as S,f as te,ft as ne,i as C,it as re,j as w,k as ie,lt as ae,n as T,q as E,s as D,st as O,tt as k,vt as A,wt as j}from"./index.svelte-C3Y0DBQD.js";import{a as oe,i as se,n as ce,o as le,r as ue,t as de}from"./select-ClXNXdfv.js";import{c as M,i as fe,n as N,o as pe,r as me}from"./index-CcN3T8-7.js";import{i as he,n as P,r as F,t as ge}from"./openapi-BfXLWMH1.js";import{t as _e}from"./book-open-CSGUXGJd.js";import{t as ve}from"./rows-3-Bf14uqIw.js";import{t as I}from"./download-3x-IldI5.js";import{t as ye}from"./skeleton-DFhkDDTo.js";import{t as be}from"./PageHeader-DoEB0Odh.js";import{t as xe}from"./CodeBlock-B_9xGeeO.js";import{t as Se}from"./EmptyState-7doOidqQ.js";import{t as L}from"./remote-resource.svelte-C2WBBS1k.js";import{t as Ce}from"./arrow-right-DSz9pfDe.js";import{t as we}from"./search-Eut_JCyJ.js";import{t as Te}from"./SearchField-eGfJuULm.js";import{t as Ee}from"./badge-BmdqWfbo.js";import{t as De}from"./download-BPqCXBjH.js";import{U as Oe,W as ke}from"./AuthenticatedShell-CGUwUDEL.js";var Ae=`# Documentation

Choose a guide for your task. Examples target the current source unless a
published version is specified; server and SDK packages have separate versions.

## Start

- [Local quickstart](quickstart.md): install, migrate and make an authenticated request.
- [Notes staging](onboarding/notes.md): private notes/files and restart acceptance.
- [Troubleshooting](troubleshooting.md): access, auth, types and limits.

## Build an application

- [REST API](api.md): queries, relations, writes, RPC, OpenAPI and errors.
- [Authentication](schema-auth.md) and [JWT/roles](jwt-and-roles.md): identities, sessions and PostgreSQL authorization.
- [Storage](storage.md): disk/S3, policies, signed URLs and consistency.
- [Webhooks](webhooks.md): durable events, signatures, retries and destination safety.
- [TypeScript SDK](../sdk/typescript/README.md) and [Rust SDK](../sdk/rust/README.md): APIs and lifecycle.
- [Examples](../examples/README.md): schemas and runnable consumers.
- [Auth integration](auth-integration.md): authentication in another Rust application.

## Operate

- [Deploy](deploy.md): Docker/systemd, HTTPS and isolated projects.
- [Backup](backup.md): paired snapshots, offsite copies and database PITR.
- [Controlled updates](panel-updates.md): unpublished controller and required VPS acceptance.
- [Panel](panel.md): administrative UI and its authority.
- [Host project management](host-management.md): isolated project creation, confirmed backup/restore/removal and persistent recovery.
- [Security model](security/README.md): protections and deployer responsibilities.
- [Release handoff](onboarding/release.md) and [leaving](leaving.md): upgrades and exports.

## Reference

- [Configuration](configuration.md): server fields plus CLI/install/backup settings.
- [CLI](cli.md): commands, options, defaults and destructive operations.
- [Glossary](glossary.md): terminology used throughout these guides.
- [Reporting security issues](../SECURITY.md), [contributing](../CONTRIBUTING.md) and [community conduct](../CODE_OF_CONDUCT.md).

## Design and evidence

- [Architecture](architecture.md): ownership, request lifecycle and budgets.
- [Decisions](decisions.md): historical rationale and superseded choices.
- [Review summary](security/review-summary.md): retained evidence and practical limits.
- [Goals](goals/README.md), [Notes validation](onboarding/validation.md) and [benchmarks](../bench/README.md): dated results, not production guarantees.
- [Native review presets](../presets/README.md): Oxlint/Python and its coverage limits.
- [Translations](i18n/README.md): English guide sources and Portuguese catalogs.

The panel embeds the fixed guide set in its registry. Repository-only references,
indexes and historical reports may need GitHub access; adding a file does not
register a panel guide. Existing paths and section identifiers are preserved
when possible.
`,je='# REST API\n\nGenerated from the exposed schema (`NELCOTA_DB_SCHEMA`, default `public`). Every\ntable, view and function in the schema becomes an endpoint, and **Postgres\ndecides access**: GRANTs say which roles may use each object and RLS says which\nrows each user sees.\n\n## Prerequisites\n\nYou need an initialized server, tables/functions in its exposed schema and\nGRANTs for the caller. Query examples use illustrative orders/products schemas;\ncreate your own matching SQL first. This reference describes current source;\nuse release-tag documentation for older binaries.\n\n> New tables have no GRANT for `anon`/`authenticated`: until you grant it, the\n> API answers 401/403. This is intentional.\n>\n> ```sql\n> GRANT SELECT, INSERT, UPDATE, DELETE ON public.my_table TO authenticated;\n> ALTER TABLE public.my_table ENABLE ROW LEVEL SECURITY;\n> CREATE POLICY ... ;\n> ```\n\n## Reads: `GET /rest/v1/{table}`\n\n| Parameter | Example | Effect |\n|---|---|---|\n| `select` | `select=id,title` | columns (default `*`) and embedded relations, see below |\n| `{column}` | `price=gt.10` | filter (several are combined with AND) |\n| `or`, `and` | `or=(status.eq.paid,status.eq.shipped)` | group of filters, see below |\n| `order` | `order=created_at.desc.nullslast,id` | ordering |\n| `limit`, `offset` | `limit=20&offset=40` | pagination |\n\n### Operators\n\n| Operator | SQL | Example |\n|---|---|---|\n| `eq`, `neq` | `=`, `<>` | `status=eq.active` |\n| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` | `age=gte.18` |\n| `like`, `ilike` | `LIKE`, `ILIKE` (`*` becomes `%`) | `name=ilike.*silva*` |\n| `in` | `= ANY(...)` | `id=in.(1,2,3)`, `name=in.("a,b",c)` |\n| `is` | `IS NULL/TRUE/FALSE/UNKNOWN` | `deleted_at=is.null` |\n| `not.` | `NOT (...)` | `status=not.eq.cancelled`, `x=not.is.null` |\n\nValues reach Postgres as parameters and Postgres itself converts them to the\ncolumn type (`$1::text::<type>`). A value invalid for the type gives 400.\n\n### Embedding related rows\n\n`select` follows foreign keys in either direction, so one request returns an\norder with its customer and items:\n\n```\nGET /rest/v1/orders?select=id,total,customers(name),items(product,qty)\n\n[{ "id": 10, "total": 30.00,\n   "customers": { "name": "Ana" },\n   "items": [{ "product": "Pen", "qty": 2 }, { "product": "Ruler", "qty": 1 }] }]\n```\n\n- When this table has the foreign key (`orders.customer_id → customers`), the\n  embed is an **object**, or `null` when nothing matches. When the other table\n  points here (`items.order_id → orders`), it is an **array**, `[]` when empty.\n- `items(*)` takes every column. `purchases:orders(*)` renames the key.\n- Two foreign keys to the same table (`buyer_id`, `seller_id` → `users`) are\n  ambiguous: pick one with the column or the constraint name,\n  `buyer:users!buyer_id(email),seller:users!seller_id(email)`. The error lists\n  the options.\n- Embeds nest, up to 4 levels: `customers?select=name,orders(id,items(product))`.\n  A table cannot be embedded into itself (self-reference). A key that repeats\n  a selected column is a 400: rename it with an alias.\n- **RLS applies to the embedded table** too: each embed runs with the request\'s\n  role, so it shows exactly what a direct read of that table would. A related\n  row the user cannot see becomes `null` or is left out of the array.\n- Works in the representation of writes (`return=representation`).\n- Each embed is a correlated subquery: index the foreign key columns on the\n  "many" side (Postgres does not create those indexes on its own).\n\n### Filtering, ordering and paging embedded rows\n\nA parameter prefixed with the embed\'s key (its alias, when it has one) applies\nto the embedded rows; a deeper embed adds its key to the path:\n\n```\nGET /rest/v1/customers?select=name,orders(id,total,items(product))\n    &orders.total=gte.5\n    &orders.order=total.desc\n    &orders.limit=2\n    &orders.items.or=(qty.eq.1,qty.gt.5)\n```\n\n- Every filter operator and `or`/`and` work, plus `order`, `limit` and\n  `offset`. Paging only applies to arrays: on a single-row embed it is a 400.\n- These narrow the **embedded rows only**: the parent rows stay, with `[]` or\n  `null` where nothing matched. Filters on the parent table (`?id=eq.1`) still\n  pick the parent rows.\n- The order of the parameters in the URL does not matter.\n\n### Combining filters: `or` and `and`\n\nSame syntax as PostgREST. Inside the parentheses each filter is written\n`column.operator.value`:\n\n```\n?or=(status.eq.paid,status.eq.shipped)\n?or=(stock.eq.0,and(price.gt.100,featured.is.true))\n?not.or=(status.eq.cancelled,deleted_at.not.is.null)\n?or=(price.gt.100,price.lt.3)&stock=gt.0      # the group is ANDed with the rest\n```\n\n- `and(...)` and `or(...)` nest; `not.` before a group negates it, and\n  `column.not.operator.value` negates one filter.\n- A value with commas or parentheses goes in double quotes, with `\\"` and `\\\\`\n  as escapes: `or=(name.eq."Ruler, 30cm",name.eq."f(x)")`. `in` lists keep\n  their own quoting.\n- At most 8 nested levels and 100 filters per group; beyond that, 400.\n- A column literally named `or` or `and` cannot be used as a direct filter,\n  only inside a group (`and=(or.eq.1)`), as in PostgREST.\n- RLS still applies: a group can only narrow what the policies allow, never\n  widen it, on reads and on `PATCH`/`DELETE`.\n\n### Responses\n\n- Body: a JSON array built by Postgres (`json_agg`).\n- `Content-Range: 0-19/*`, or `0-19/137` with `Prefer: count=exact`.\n- `NELCOTA_MAX_ROWS` defaults to **1000** and must be positive. It caps the root\n  read, each embedded collection, and set-returning RPCs, including explicit\n  limits larger than the cap. Embedded collections in write representations\n  have a fixed cap of 1000. Paginate collections to reach subsequent rows.\n- JSON has an **8 MiB serialization budget**, checked in PostgreSQL before each\n  row enters an aggregate, also on write representations and scalar RPCs.\n  Intermediate embedded values count towards the same budget, so deeply nested\n  results can reach it with less than 8 MiB of final output. Oversized results\n  return `413 response_too_large`; a write requesting such a representation\n  rolls back. A single database value must still be serialized before its size\n  can be checked. Administrative streaming exports remain available for large data.\n- `select` accepts at most 128 items across the relation tree. Repeated columns\n  are rejected; `*` already includes explicitly selected columns.\n\n## Writes\n\nAn insert accepts at most **1000 rows** and **128 distinct column sets** per\nrequest. Split larger batches into requests. A request body (writes and RPC\narguments) can have at most `NELCOTA_MAX_BODY_BYTES` bytes, **2 MiB** by\ndefault; a larger one gets `413 payload_too_large`. The body is buffered and\nparsed whole, so raise the limit only as far as the server\'s memory allows. Each accepted request keeps its\ntransactional behavior and missing columns still receive their defaults.\n\n| Verb | Body | Filters | Without `return=representation` | With `return=representation` |\n|---|---|---|---|---|\n| `POST` | object or array | not accepted | 201 empty | 201 + array |\n| `PATCH` | object | **required** | 204 | 200 + array |\n| `DELETE` | - | **required** | 204 | 200 + array |\n\n- `select=` also picks the columns of the representation.\n- On `POST`, missing columns get their `DEFAULT`, even in a batch whose\n  objects have different keys.\n- An empty body on `POST`/`PATCH` is refused (400 `invalid_body`); to insert\n  a row of defaults, send `{}`. An `/rpc` call without a body has no arguments.\n- `PATCH`/`DELETE` without a filter are refused (400), to avoid changing or\n  deleting the whole table by mistake. To do that on purpose, use an explicit\n  filter (`?id=not.is.null`).\n- `order`, `limit` and `offset` are refused on `PATCH`/`DELETE` (400\n  `invalid_query`): they change every row the filters match, so narrow the\n  filters instead.\n- With `Prefer: count=exact`, `PATCH`/`DELETE` answer `Content-Range: */<n>`\n  with the number of rows changed (and `Preference-Applied: count=exact`),\n  with or without `return=representation`.\n- `return=representation` runs `RETURNING`, which requires `SELECT`\n  permission (GRANT + policy) on the written rows.\n\n### Upsert: create or update in one call\n\n```\nPOST /rest/v1/products\nPrefer: resolution=merge-duplicates\n[{ "id": 1, "price": 3.00 }, { "id": 99, "name": "Eraser", "price": 1.00 }]\n```\n\n- `Prefer: resolution=merge-duplicates` updates a row whose key already exists,\n  with the columns the object sent (the others keep their values; the key\n  itself is never changed). `resolution=ignore-duplicates` keeps the existing\n  row; with `return=representation`, only the rows actually written come back.\n- The key is the primary key, or `?on_conflict=col1,col2`, which must match a\n  unique constraint (otherwise 400). `on_conflict` without `resolution` is a\n  400. The response confirms with `Preference-Applied`.\n- A batch that repeats a key gets a 400 from Postgres (a row cannot be updated\n  twice in one statement).\n- A `GENERATED ALWAYS AS IDENTITY` column cannot receive values, so it cannot\n  be the upsert key: use `BY DEFAULT`, or another unique column with\n  `on_conflict`.\n- RLS still decides: on a conflict, the existing row must pass the `UPDATE`\n  policy. A user cannot take over someone else\'s row through an upsert (403).\n\n## Functions: `POST /rest/v1/rpc/{function}`\n\nBody: an object with the **named** arguments (`{"a": 1, "b": 2}`); arguments\nwith a `DEFAULT` are optional. With overloads, the signature whose names match\nthe keys wins.\n\n| Function returns | Response |\n|---|---|\n| `SETOF`/`TABLE` | JSON array |\n| scalar or composite | JSON value |\n| `void` | 204 |\n\n`RAISE EXCEPTION` becomes 400 with the message, also with a custom SQLSTATE of\nclass `P0` (`USING ERRCODE = \'P0002\'`) and for a failed `ASSERT`; its `DETAIL`\nand `HINT` come back as `details` and `hint` (see [Errors](#errors)). The\nfunction runs with the JWT\'s role (unless it is `SECURITY DEFINER`):\n`auth.uid()` works inside it.\n\n> **Warning:** By default, Postgres grants `EXECUTE` on new functions to\n> `PUBLIC` (including `anon`). For sensitive functions:\n> `REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC; GRANT EXECUTE ON FUNCTION f() TO authenticated;`\n\n## OpenAPI: `GET /rest/v1/`\n\nAn OpenAPI 3.0 document generated from the catalog and **filtered by the\nrequest\'s role**: `anon` only sees what `anon` may use.\n\nSchema models: `nelcota types -o database.ts` (TypeScript, default), or\n`nelcota types --lang rust -o database.rs` for the\n[Rust SDK](../sdk/rust/README.md). The Rust models distinguish omitted write\nfields from explicit nulls and keep Postgres numeric precision.\n\nViews run with their owner\'s underlying privileges by default and can bypass\nthe caller\'s row policies even when the source table enables RLS. For views\nthat should apply the caller\'s policies, use `security_invoker = true` and grant\nthe caller the required access to the underlying tables. The panel warns about\nexposed owner views; changing that option or revoking their GRANT clears the\nwarning. Materialized views and foreign tables have no local row policies and\nalso need explicit access controls.\n\n## Catalog reload\n\nThe API keeps the introspection in memory. An event trigger (migration V3)\nnotifies the server after DDL. Reloads are coalesced/serialized and failed\nrefreshes retry with bounded backoff; there is no fixed completion guarantee. Without a\nsuperuser (some managed Postgres services), reload by hand:\n\n```sql\nNOTIFY nelcota, \'reload schema\';\n```\n\n## Errors\n\nEvery error from the server (REST, auth, storage, unknown routes, wrong\nmethods, body limits and timeouts) is JSON with the same shape:\n\n```json\n{"code": "db_error", "message": "duplicate key value violates unique constraint \\"products_pkey\\" (23505)",\n "sqlstate": "23505", "details": "Key (id)=(1) already exists.", "constraint": "products_pkey"}\n```\n\n- `code` and `message` are always present. `code` is stable and meant for\n  programs; `message` is English text for people.\n- Errors that come from Postgres add `sqlstate` (the 5-character SQLSTATE)\n  and, when Postgres provides them, `details`, `hint` and `constraint`\n  (`DETAIL`, `HINT` and the violated constraint\'s name). Absent fields are\n  omitted, never `null`. For `db_error`, `message` stays `"<text> (<sqlstate>)"`.\n- Every response carries `x-request-id` (see [Request IDs](#request-ids)):\n  quote it when reporting an error.\n\n| Status | `code` | When |\n|---|---|---|\n| 400 | `invalid_query` | invalid column/operator/order in the URL; `order`/`limit`/`offset` on `PATCH`/`DELETE` |\n| 400 | `invalid_body` | the body is not valid JSON, or is empty on `POST`/`PATCH` |\n| 400 | `db_error` | value invalid for the type, check, not null, generated column, `RAISE EXCEPTION` (any SQLSTATE of class `P0`) |\n| 401 | `invalid_token` | invalid or expired JWT (`WWW-Authenticate: Bearer error="invalid_token"`) |\n| 401 | `db_error` | `anon` without permission: sign in (`WWW-Authenticate: Bearer`) |\n| 403 | `db_error` | role without permission, or a policy violated on write |\n| 404 | `not_found` | table/function outside the exposed schema, or an unknown route |\n| 405 | `method_not_allowed` | the route exists but not with this method (`Allow` lists the methods) |\n| 409 | `db_error` | unique key, foreign key or exclusion constraint violated |\n| 413 | `payload_too_large` | request body over `NELCOTA_MAX_BODY_BYTES` (default 2 MiB) |\n| 413 | `response_too_large` | the JSON response would exceed the 8 MiB budget |\n| 415 | `unsupported_media_type` | an auth or storage JSON endpoint without `Content-Type: application/json` |\n| 422 | `invalid_body` | an auth or storage JSON body with a missing field or a field of the wrong type |\n| 429 | `rate_limited` | too many attempts (`Retry-After`) |\n| 500 | `internal` | unexpected error; details only in the server log |\n| 503 | `unavailable` | database unreachable, or a transient failure: serialization failure (`40001`), deadlock (`40P01`), lock not available (`55P03`), too many connections (`53300`), server shutting down or starting (`57P01`, `57P02`, `57P03`). Comes with `Retry-After: 1` (and `sqlstate` when Postgres answered): retry the request |\n| 504 | `db_error` | `statement_timeout` (`NELCOTA_STATEMENT_TIMEOUT_SECS`, default 10 s; `sqlstate` `57014`) |\n| 504 | `timeout` | the whole request took longer than `NELCOTA_REQUEST_TIMEOUT_SECS` (default 15 s, must exceed the statement timeout) |\n\nAuth and storage add their own codes; see [schema-auth.md](schema-auth.md) and\n[storage.md](storage.md).\n\n## Request IDs\n\nEach response carries an `x-request-id` header: the one the request came with\n(for example from a proxy in front), or a new UUID. The server logs one line\nper response at `INFO` with the method, path (never the query string), status,\nlatency and that id, so an error a user reports can be found in the log.\nBrowsers can read the header (it is in `Access-Control-Expose-Headers`).\n\n## Out of the MVP\n\nFiltering parent rows by their embeds (PostgREST\'s `!inner`),\nself-referencing embeds, `GET` on `/rpc`, `Accept: application/vnd.pgrst.object+json`.\n\n## Related guides\n\nSee [auth](schema-auth.md), [JWT/roles](jwt-and-roles.md), [storage](storage.md) and [troubleshooting](troubleshooting.md).\n',Me="# Architecture\n\n```\nclient ──HTTPS──▶ Caddy ──▶ nelcota (single binary) ──▶ Postgres 17\n                              │ axum: /health, /rest/v1/*, /storage/v1/*\n                              │ auth: validates JWT → Claims\n                              │ core: pool (authenticator) + transaction with role/claims\n```\n\n## Prerequisites\n\nThis page describes current source ownership and budgets. To build it, use the\npinned Rust toolchain; PostgreSQL is required for runtime validation. Historical\narchitecture choices belong to the decision log, and published artifacts can\npredate source-only capabilities.\n\n## Crates\n\n| Crate | Responsibility |\n|---|---|\n| `nelcota-core` | config (`figment`), HTTP errors, `Claims`/`Role`, pool, migrations, `begin_request` |\n| `nelcota-auth` | `JwtVerifier` trait, EdDSA/HS256 keys and JWKS, `Auth` extractor, signup/login/refresh/logout, email links (recovery, confirmation, magic link), OAuth/OIDC providers, argon2id, rate limit |\n| `nelcota-api`  | catalog introspection, SQL builder, CRUD/RPC, OpenAPI, TS types |\n| `nelcota-storage` | files: buckets and objects under RLS (`storage` schema), bytes on disk or S3 (`object_store`), signed URLs, orphan collector |\n| `nelcota-webhooks` | transactional row events, persistent delivery leases, signing, safe HTTP dispatch, retries and retention |\n| `nelcota-admin` | panel at `/admin`: JSON API (`/admin/api`) + embedded Svelte SPA (`ui/dist`) |\n| `nelcota-cli`  | host with N projects (`init`, `up`, `projects`, `remove`, `migrate`, `backup`, `upgrade`, `panel-login`...). Modules: `host` (registry), `naming`, `scaffold`, `caddy`, `registry`, `panel_login`, `lifecycle`, `backup`, `upgrade` |\n| `nelcota-deployment` | release/protocol types, durable jobs, host leases and irreversible recovery decisions; CLI/admin adapt runtime effects and operator HTTP |\n| `nelcota-server` | the `nelcota` binary: dispatches the CLI or starts the server (trace, timeout, CORS, gzip) |\n\nThe backend compiles into one binary, static with musl in the Docker image.\nArtifact size depends on version/architecture and embedded assets; do not infer\ncurrent size or deployment capacity from older builds.\n\nThe query compiler separates the validated request representation (`query/mod.rs`),\nURL parsing (`query/parse.rs`) and SQL generation (`query/sql.rs`), behind the\nexisting public interface. Panel handlers are grouped under `admin/src/tables/`,\n`users/` and `policies/`, with small root facades that expose named handlers to\nthe router. Tables own row queries, structure, exports and DDL adaptation;\n`tables/catalog` supplies metadata also used by overview and policies. Pure\nDDL generation stays in `ddl/`, execution in `apply`, and SQL error adaptation\nin `error`. Table DDL exposes a small facade over `table/spec` (typed input),\n`table/column` (shared column rendering), `table/create` and `table/alter`\n(statement planning). Alteration keeps one working schema owner and preserves\nthe action order. The SQL feature also owns its autocomplete schema endpoint.\n\nAuthentication's HTTP handlers adapt requests to `accounts` and `sessions`.\n`db` owns auth-role transactions and `request` owns HTTP metadata. `links`\nowns single-use email links (token storage, email text, sending and sign-in\nby link); `recovery` adds the password change, `confirmation` the signup\npolicy and `verify` routes a link by its `type`. `oauth` owns provider\nsign-in: `provider` (with one module per provider) talks to the provider,\n`flow` stores sign-ins in progress, `identities` decides which account opens\nand `redirects` holds the allowlist. The panel's root assembles routes;\n`auth`, `middleware`, `error`, `assets` and `state` own their respective behavior.\n\nStorage's `upload` module owns streamed writes and their metadata commit,\n`operations` owns reads/listing/deletion, and `signing` owns signed-file grants.\nTheir interface takes upload options and a byte stream and returns typed data.\nThe `http` adapter handles headers, response status, URLs and file serving for\nboth public routes and the panel. Policy checks still happen before bytes are\nconsumed, and failed writes still clean up their unpublished versions.\n\nThe CLI separates project lifecycle and version upgrades from backup workflows.\n`backup/workflow` coordinates capture, retention and restore; `backup/remote`\nowns S3 transport. Database and immutable file capture retain one owner so\ntheir snapshot consistency remains intact.\n\nWebhooks separate panel configuration/history (`management`), destination and\nDNS policy (`destination`), HMAC (`signing`), lease persistence (`queue`), HTTP\ndelivery (`transport`) and async scheduling (`worker`). A PostgreSQL trigger\ncommits events with business rows; a dedicated two-connection pool and four\nconcurrent sends keep outbound work independent of API and panel traffic.\nSee [events and webhooks](webhooks.md) for delivery guarantees and limits.\n\nPanel wire DTOs live in `admin/src/contracts.rs` and the existing structure/DDL\ntypes. Their generated TypeScript and JSON Schemas are versioned with the UI;\nstandalone validators reject incompatible responses in the client. Row values\nremain strings or NULL so decimal and bigint values retain precision.\n\nThe SQL editor streams messages over dedicated connections with a 30-second\nstatement timeout, four concurrent runs, 1000 retained rows per result, an 8 MiB\nretained-value budget and 32 displayed results. It drains the entire batch after\nreaching a display limit, preserving transaction semantics. Dropping the HTTP\nfuture sends a Postgres cancellation request and closes its dedicated connection.\nOrdinary API pool connections stay separate.\n\nTable previews reuse one admin connection and roll back the caller's role\nbefore reading owner metadata. Table exports use separate connections, with\ntwo concurrent downloads, a 30-second statement timeout and a two-minute\nresponse lifetime. Dropping a response cancels the query; a deadline closes\nthe connection even when its body is not polled. Admission remains occupied\nthrough cancellation, and an interrupted stream fails instead of reporting\na complete file. Small-table counts probe at most 10,001 rows under a 250 ms\nstatement timeout; outgrown small-table estimates produce an unknown total.\n\nStorage directory listing seeks through a generated parent-path byte key,\nskipping each returned folder's subtree. Every seek runs against\n`storage.objects` under the caller's RLS. NUL-separated UTF-8 segments preserve\nC ordering and isolate literal prefixes, including Unicode, `%` and `_`.\nAn ordered scope-fingerprint/name index pages immediate files. Its generated\ninteger fingerprint supports seeks under RLS; exact bucket and parent checks\nreject hash collisions. Listing transactions disable bitmap scans locally\nto favor ordered page seeks when statistics are missing.\nThe key helpers only transform their inputs;\npublic execution preserves custom SQL writers without changing object RLS.\nA bucket browser requests only that bucket's usage. Migrations V14 and V15\nadd user ordering and directory indexes. V15 computes the derived keys for\nexisting metadata and rebuilds the table under the migration lock, so\nupgrades of large stores need time for that one-time rewrite.\n\nInternal migration V16 adds durable panel SSO redemption receipts shared by\nall instances of the project. Upgrading from 0.4.0 applies V14, V15 and V16;\nkeep a tested paired database/file backup and allow a maintenance window for\nthe metadata rewrite. V16 is outside the standalone auth migration selection.\n\nDDL commits once and reports `applied` plus `catalog_pending`. An introspection\nfailure after COMMIT does not turn a successful mutation into an error. Catalog\nreloads are serialized, and one worker retries failed refreshes with backoff;\nthe client refreshes its view without replaying the change.\n\n`RemoteResource` owns loading, errors, cancellation and result ordering in table,\nuser and storage pages. Storage's upload queue owns progress, partial failures\nand conflict retries, capturing the bucket and folder before navigation changes.\nThese modules have unit tests; browser flows and real-Postgres regressions run in CI.\n`TableRows` owns row selection, loading and mutation reconciliation, including\ncaptured primary keys and navigation during writes. The table page owns its\nnavigation, dialogs and presentation; its HTTP adapter supplies row operations.\n\nRecovery operations own link issuance and atomic consumption, password updates,\nsession revocation and post-commit email delivery. HTTP handlers only extract\nrequest metadata, apply public endpoint rate limits and adapt their results.\nMigration operations return typed records and commit version allocation,\nchecksums and change tracking together; their `files` module owns names,\nrendering and directory discovery, while the root handles HTTP downloads.\n\nThe REST root composes routes. Its `http` adapter handles URLs, preferences,\nstatus codes and headers; `operations` compiles and executes CRUD/RPC under\nthe caller's role, returning PostgreSQL-generated JSON and range metadata.\nCatalog internals separate `model`, `introspection`, `refresh` and `listener`\nbehind the public `CatalogHandle` interface. Introspection coordinates private\nreaders for relations, columns, constraints and functions; each reader owns\nits query and row mapping. The four reads remain sequential, and a complete\nsnapshot is published only after all succeed. Keep the returned `ReloadListener`\nowner alive until shutdown; dropping it cancels the listener/driver. Dropping\nthe final catalog owner cancels reconciliation, including pool waits.\n\nThe SQL executor owns connection lifetime, concurrency, result budgets and\ncancellation behind `execute`; the route handles HTTP status and serialization.\nThe panel's `SqlExecution` owns request state and timing, and `StorageBrowser`\nowns folder paging and refreshes after uploads/deletions. Both accept adapters\nand discard stale responses when cancelled or navigated away from.\n\nNative deployment separates machine/package provisioning, systemd units,\nPostgreSQL configuration and atomic binary replacement. Caddy owns its own\nconfiguration writes. PITR separates private configuration from process adapters\nand restore sequencing; restore still coordinates stopping services, restoring,\nwaiting for promotion, taking a backup on the new timeline and starting the app.\n\n## Source organization\n\nNelcota is a modular monolith: capability modules ship in one binary. Use a\nsmall facade to expose a complete operation, keeping its validation, transaction\nand cleanup together. HTTP adapters translate requests, results and errors.\nIntroduce interchangeable adapters where implementations actually vary, such\nas disk/S3 storage and SMTP/test mail delivery. Concrete functions and existing\ntypes are enough elsewhere; a generic repository or another layer is not needed\nto wrap PostgreSQL.\n\nKeep the existing crate boundaries: each crate owns a product capability,\nand `server` assembles them. Add an internal module when behavior needs an\nindependent owner; file length alone does not require a new crate or layer.\nRust module facades use explicit exports. Types returned by a public method\nmust be reachable through its public interface, including errors such as\n`SqlBusy` alongside `SqlExecutor`.\n\nApply SOLID to these existing boundaries:\n\n- Single responsibility: separate typed requests, SQL planning, database reads,\n  HTTP adaptation and browser effects; keep transaction and cleanup ownership together.\n- Open/closed: extend real variation through existing storage, mail and database\n  interfaces. Do not introduce a trait or strategy for one implementation.\n- Liskov substitution: preserve public signatures, error behavior and output;\n  use the same characterization tests before and after moving responsibilities.\n- Interface segregation: expose the operation a caller needs through a small\n  facade; keep query-specific readers and rendering helpers private.\n- Dependency inversion: shared panel infrastructure depends on shared contracts\n  and session state, while pages depend on that infrastructure. Shared modules\n  must not import a feature page or the application shell.\n\nBucket mutations belong to storage's operation interface on `StorageState`.\nBoth the public routes and panel call it; bucket privileges, RLS and foreign\nkeys remain PostgreSQL's responsibility. Operations return typed records and\nbucket errors, while each HTTP adapter preserves its response/error vocabulary.\nOnly the panel adapter trims empty MIME inputs from forms. A failed deletion\nrolls back before reading the optional file count for its error response.\nPanel user operations accept the admin pool and return data; their HTTP adapter\nowns messages and status codes. Password changes and session revocation remain\none transaction inside the operation.\n\nThe panel's `ui/src/lib/features/<feature>/` owns its page, state, HTTP\nadapter, pure helpers, components and adjacent unit tests. `shell/` owns\nnavigation, the command palette and the application frame. Reusable panel\ncomponents live in `components/shared/`; shadcn primitives stay in\n`components/ui/`. Table/policy metadata and DDL previews shared by several\nfeatures live in `shared/schema/`, including the identifier rendering used by\nboth guided access and policy templates. API usage examples belong to\n`features/api/api-examples.ts`.\n\nShared panel modules have explicit owners under `ui/src/lib/`:\n\n| Directory | Responsibility |\n| --- | --- |\n| `transport/` | HTTP requests, response parsing, upload adaptation and transport errors |\n| `contracts/` | Generated wire-type facade and response-contract selection |\n| `resources/` | Request lifetime, query cache and shared panel-session state |\n| `navigation/` | History routing, route matching and URL pagination |\n| `browser/` | Clipboard, download effects, identifiers and local persistence |\n| `forms/` | Password input helpers and confirmation before closing dirty forms |\n| `formatting/` | Date labels and pure CSV/JSON encoding |\n| `components/` | UI primitives, reusable components and their class/type utilities |\n\nKeep source files and adjacent tests inside those directories. Pure tabular\nencoding is independent of object URLs and download clicks; upload error\nconstruction is independent of the API/session coordinator. Shared session state\nlives in `resources/session.svelte.ts`, consumed by both transport and login.\nThe shadcn aliases point generated utilities to `components/utils` and browser\nhooks to `browser/`, keeping future generated modules in the same ownership map.\n\n`python3 scripts/check-boundaries.py` rejects loose library modules, unregistered\nlibrary directories, shared-to-page imports and stale direct module URLs in\nbrowser probes. Existing native import lint checks dependency cycles. Adding a\nnew shared owner requires updating this map and its boundary contract.\n\nUse relative imports within a feature and `$lib/...` for dependencies outside\nit. Rust filenames use snake_case, TypeScript helpers use kebab-case, and\nSvelte components use PascalCase. Use structs/enums or plain TypeScript types\nfor data; stateful modules compose existing resource modules behind their\nown methods. Reuse generated wire types instead of copying their shape;\n`SchemaResponse` serves both autocomplete and SQL request state. Do not edit\nthe generated contracts or validators by hand.\n\nRust unit tests stay with their implementation. Integration scenarios stay in\n`server/tests`, where the production router and a real PostgreSQL instance\nare assembled. `tests/admin.rs` loads feature modules under `tests/admin/`\nas one integration suite. `tests/common/panel.rs` owns panel login, cookie\nassertions and request helpers shared with storage and architecture suites.\n\n## A request's flow\n\n1. `Auth` (extractor) turns the `Authorization` header into `Claims`.\n2. The operation takes a connection from the pool (always as `authenticator`).\n3. `db::begin_request` opens the transaction and sets role + claims.\n4. The query runs under RLS; Postgres builds the JSON (`json_agg`) and the API\n   just passes the bytes through.\n5. COMMIT. Postgres errors are translated by `ApiError::from_db`.\n\n`db::begin_request` is the **only** path to run SQL on behalf of a user.\n\n## Startup\n\n1. Loads the config (`NELCOTA_*` + optional `nelcota.toml`).\n2. `db::bootstrap` (admin connection): advisory lock → migrations in\n   `migrations/` (control table `nelcota.schema_migrations`) → `authenticator`\n   password (SCRAM verifier computed locally).\n3. Creates the API pool and starts the HTTP server. Shuts down cleanly on\n   SIGTERM/Ctrl+C.\n\n## Routes\n\n| Prefix | Served by | Authorization |\n|---|---|---|\n| `/health` | server | public |\n| `/rest/v1/*` | api | JWT → role → GRANTs + RLS |\n| `/auth/v1/*` | auth | public (signup/login/email links/provider sign-in) or the user's JWT |\n| `/storage/v1/*` | storage | JWT → role → RLS on `storage.objects`; public buckets and signed URLs without a token |\n| `/admin/*` | admin | panel login (session), admin connection |\n\n## Internal migrations\n\nPlain SQL in `migrations/V<n>__<name>.sql`, applied by `refinery` and recorded\nin `nelcota.schema_migrations` (version, name, date, checksum). They can be\napplied by hand with `psql` if Nelcota no longer exists. The early ones\n(V1–V6) keep their original Portuguese names and comments: refinery checksums\nname and content, so editing them would break existing installs (D68).\n\n## Authentication flow\n\n```mermaid\nsequenceDiagram\n    participant App as Application client\n    participant Auth as /auth/v1\n    participant DB as Private PostgreSQL\n    App->>Auth: Signup or password sign-in\n    Auth->>DB: Validate credentials / create session\n    Auth-->>App: Access JWT and rotating refresh token\n    App->>Auth: Refresh token (serialize callers)\n    Auth->>DB: Atomic rotation / reuse detection\n    Auth-->>App: Replacement token pair\n    Note over App,DB: REST/storage use access JWT + transaction-local role/claims and RLS\n```\n\nThe project panel has separate administrator sessions. Controlled updates add\nseparate controller/worker processes using the same binary and a separately\nenrolled operator origin; they do not grant host authority to a project login.\nThe controller remains source-only pending a new release and VPS acceptance.\n\n## Related guides\n\nSee [decisions](decisions.md), [REST API](api.md), [auth](schema-auth.md),\n[webhooks](webhooks.md) and [deploy](deploy.md). Reusable-auth setup is in the\nrepository-only guide at `docs/auth-integration.md`. Mermaid diagrams render\non GitHub; the current embedded reader displays their source.\n\n## Host controller boundaries\n\nHost project management keeps pure commands, bounded DTOs and durable receipts\nin `nelcota-deployment`; root effects, policy and recovery live in `nelcota-cli`. `nelcota-admin` is an unprivileged HTTP adapter. The separately\nauthenticated UI requests plans and confirmed operations through the worker;\nproject credentials never grant host authority. Updates, CLI mutations and host\njobs share one lease and refuse unresolved work. See `docs/host-management.md`\nfor the Unreleased feature’s enrollment, recovery and validation limits.\n",Ne=`# Integrating authentication in another Rust application

The supported stack is Rust 1.99+, Axum 0.8 and PostgreSQL 17. The runnable
consumer in \`examples/auth-consumer\` has its own workspace. Its Nelcota
dependency is \`nelcota-auth\`; \`nelcota-core\` is the only internal transitive
dependency. Server, CLI, REST, panel, storage and webhooks are absent from its
dependency graph. No Node runtime is required.

This archive/facade workflow describes unpublished source after server 0.4.0.
A workspace version does not establish registry availability; use matched
candidate archives until core/auth receive a separately reviewed release.

## Build and distribution

From the repository:

\`\`\`sh
cargo build --manifest-path examples/auth-consumer/Cargo.toml
python3 scripts/check-boundaries.py
cargo package -p nelcota-core -p nelcota-auth --allow-dirty --no-verify
python3 scripts/test-auth-package.py --run
\`\`\`

The last command extracts both real \`.crate\` archives into a temporary directory,
copies the external consumer there and builds offline. A local registry patch
points auth's normalized registry dependency at the extracted core archive.
It creates disposable PostgreSQL, generates credentials and an Ed25519 key,
checks signup, refresh and JWKS, then verifies graceful shutdown releases DB
connections and that unrelated capability tables were never installed.
Docker, OpenSSL and Python 3.11.8+ are needed for this regression fixture.

This proves packaged assets and dependency versions, including migrations and
the rebuild hook. It does not upload packages or reserve registry names. Before
an independent release, publish core first, then auth at the matching version,
and replace the example's path dependency with the registry dependency.
Do not publish these two packages independently with mismatched migration plans.

## Constructing and starting the host

The example reads three required variables and one optional listener setting:

| Variable | Meaning |
|---|---|
| \`AUTH_DATABASE_URL\` | Administrator URL to a private, disposable development database. |
| \`AUTH_DATABASE_PASSWORD\` | Runtime-generated password for the cluster's \`authenticator\` role. |
| \`AUTH_PRIVATE_KEY\` | Runtime-generated Ed25519 PKCS#8 key, base64 or PEM. |
| \`AUTH_BIND\` | Optional listener; defaults to \`127.0.0.1:8080\`. |

Generate a development key with \`openssl genpkey -algorithm Ed25519 -outform DER\`
and base64-encode its bytes. Keep it and the database password out of Git, logs
and browser bundles. In production, inject stable keys from the host's secret
store so restarts and cooperating instances verify the same tokens.

The startup order is explicit in \`main.rs\`: connect as the administrator for
\`bootstrap\`; configure a separate request pool as \`authenticator\`; construct
\`Keys\`, one shared \`Passwords\` worker pool and \`AuthState::new\`; own a pruner
handle; mount \`router\` with a request deadline; serve with Ctrl-C shutdown.
The example closes the pool after aborting and awaiting its pruner.

Example budgets are four DB connections, two password threads, a five-second
pool wait/create budget and PostgreSQL statement timeout, a ten-second request
deadline and a thirty-second startup deadline. Each hash retains the existing
Argon2id strength: 19 MiB, two iterations, one lane. Dedicated workers bound
thread count and allocator arenas. Cancelling a caller does not release its
running hash slot before computation finishes. Share one \`Passwords\` instance
per host rather than constructing a pool per request.

\`AuthSettings::validate\` and \`AuthState::new\` reject empty issuers, zero or
unrepresentable lifetimes, unsafe link pages and zero request budgets. Defaults
in the example are a 900-second access token, 30-day refresh token, enabled
signup, disabled proxy trust and disabled email/OAuth flows. If a host manually
assembles the public state fields, it owns the equivalent configuration checks.

## Routes and optional adapters

The existing \`/auth/v1\` routes are preserved: \`signup\`, \`token\`, \`logout\`, \`user\`,
\`recover\`, \`resend\`, \`magiclink\`, \`verify\`, \`authorize\`, \`callback\` and
\`.well-known/jwks.json\`. The token endpoint supports password, refresh and PKCE
grants. Errors keep the existing JSON vocabulary and HTTP statuses through
\`ApiError\`. Both existing SDKs can use the external host's auth routes.

Assign \`state.mailer\`, configure \`state.settings.links\` before constructing
the final state, and use the shared \`MailDelivery\` admission/deadline for mail
flows. Missing adapters leave the corresponding flows disabled. Provider
integration uses \`OAuth\`, \`Provider\`, \`ProviderKind\` and explicit redirect
allowlists. Google and GitHub flows retain the existing verified-email and
PKCE contracts. Provider HTTP transport initializes its TLS provider internally.

\`Keys\`, \`JwtVerifier\`, \`SharedVerifier\`, \`Auth\`, \`Claims\`, \`Role\` and \`VerifyError\`
are reachable from the auth facade. EdDSA is preferred; JWKS exposes only public
key material. HS256 requires at least 32 bytes and publishes no shared secret.
With EdDSA and HS256 configured, signing uses EdDSA and legacy HS256 verification
continues. Unknown algorithms/keys and malformed/expired claims fail closed.
Optional \`nbf\` and \`iat\` must be whole non-negative epoch seconds and cannot be
more than 30 seconds in the future, using the same leeway as expiration.
This applies to both algorithms and raw-payload verification.
\`aud\` remains informative and issuer validation is not enforced by \`Keys\`:
applications needing stricter policies must supply a verifier for their own
protected routes and middleware around auth routes. The built-in auth router
uses its configured \`Keys\` verifier. Do not silently
assume an issuer/audience policy that the existing contract does not enforce.

Access JWTs remain stateless until expiry. Logout/revocation prevents refresh;
it does not retract an already-issued access token. Refresh rotation preserves
the documented short retry grace: competing requests can both return a response,
but only the newest successor remains usable. Recovery, confirmation, magic-link
and PKCE credentials retain their single-use database consumption boundaries.
Password/link changes and revocation must not resurrect an ended session.

## Database lifecycle and authorization

\`nelcota_auth::bootstrap\` installs canonical versions 1, 2, 5, 9, 10 and 14.
These are the auth tables, shared roles/context functions, single-use links,
OAuth identities and the user-listing index. Shared infrastructure includes
\`nelcota.schema_migrations\`, \`extensions\`, pgcrypto and pg_stat_statements.
Panel tables, catalog triggers, storage and webhook objects are absent.
Bootstrap needs an administrator able to create roles and the extensions.

The canonical SQL in root \`migrations/\` remains unchanged. The core archive
contains byte-identical copies, enforced by \`scripts/check-boundaries.py\`.
Names, refinery checksums and history records are verified before applying
missing selected versions. SQL and each new history record commit together;
concurrent hosts serialize with the existing advisory lock. Unknown versions
and divergent checksums fail closed.

An auth-only database can later start the complete Nelcota host. Promotion fills
its lower canonical gaps in one transaction, then uses the ordinary strict full
runner. A failure rolls those gaps back so retry remains supported. Existing
users, hashes, sessions, tokens and migration checksums are preserved. An
arbitrary gap in a full database's history is not accepted as promotion.

Keep built-in role flags consistent with the canonical migrations.
Bootstrap rejects privileged/inheriting request roles and inherited memberships
on the five shared/auth roles; existing \`nelcota_storage\` and
\`nelcota_webhooks\` roles receive the same checks. It does not silently downgrade
an operator's existing roles.
Investigate the unexpected grant and repair it intentionally before retrying.
Do not share a PostgreSQL cluster with applications that repurpose these names
or use a different authenticator password. Roles/passwords are cluster-global;
the advisory migration lock is database-local. Use separate clusters for
independent installations or coordinate bootstrap through the cluster owner.

Authentication establishes identity; PostgreSQL grants and RLS establish access.
The request pool must never use the administrator or a service-role token for
end-user operations. Request role/claims belong in transaction-local settings,
with rollback on errors and cancellation. Auth credential tables are unavailable
to anon, authenticated and service roles. Service tokens deliberately bypass
RLS and belong only in trusted backends.

The included connector uses \`NoTls\`, matching Nelcota's private PostgreSQL
topology. Do not expose that database connection over an untrusted network.
A host requiring a managed database's TLS connector needs an additional
connector integration; it is not demonstrated by this example.

## Compatibility and operation

Auth/core versions travel together. The current candidate manifests use 0.4;
subsequent compatible fixes preserve constructors, routes, error vocabulary,
claims and additive database history. Breaking Rust changes during 0.x require
a new minor version and a migration/upgrade note. After 1.0, breaking public
changes require a major version. Released SQL is never edited in place.
An older package must not initialize a database containing unknown newer
migrations: upgrade the package before retrying that initialization.

Own \`pruner_task\` for application shutdown, or call \`prune\` from the host's
scheduler. Legacy \`spawn_pruner\` remains a detached compatibility helper.
Hourly scheduling skips missed ticks; token cleanup uses bounded batches and
retains revoked tokens long enough to recognize replay. Rate limits are bounded
in memory and per process, not a shared cluster-wide IP quota.

On pool exhaustion, inspect bounded wait deadlines and workload budgets before
increasing connections. On bootstrap history errors, restore the correct
migration/package version; never remove checksum verification. A cancelled
bootstrap stops its connection driver and sends a bounded PostgreSQL cancellation
request, including when waiting for the advisory lock. The bootstrap session
also enables PostgreSQL's one-second client connection checks, so a stopped
runtime cannot leave a disconnected advisory waiter. This does not impose a
one-second migration deadline or change request-pool settings.

\`cargo bench -p nelcota-auth --bench operations\` records password hashing and
EdDSA verification separately, without database/network latency. The release
campaign measures login and refresh end to end, with RLS and resource checks.

See \`docs/goals/execution-report.md\` for compatibility, isolation, concurrency,
packaging and resource evidence from the complete implementation review.
`,Pe=`# Backup and restore

Capture and restore a database together with its disk-file snapshot. You need
a selected initialized host/project, PostgreSQL tools through its runtime,
sufficient disk space and a private offsite destination when configured.

Source fixes after 0.4.0 are unpublished: use matching release guidance and
verify the actual artifact. Take a compatible verified pair before destructive
recovery; database PITR has different guarantees from a dump restore.

## Backup

\`\`\`sh
nelcota -p shop backup            # pg_dump -Fc → projects/shop/backups/nelcota-shop-<date>.dump
                                  # (+ s3://<bucket>/shop/ when host.env has a bucket)
nelcota -p shop backup --upload   # requires the upload: fails if host.env has no bucket
nelcota backup --all --keep 7     # every project; keeps the 7 most recent local dumps (--keep ≥ 1)
\`\`\`

\`backup\` uploads on its own whenever the S3 variables are in \`host.env\`, so
adding a bucket after \`init\` needs no other change. \`--upload\` forces it and
fails without one.

The first \`init\` (as root) installs a daily cron job at 03:00
(\`/etc/cron.d/nelcota-backup\`):

\`\`\`
0 3 * * * root '/usr/local/bin/nelcota' -C '/opt/nelcota' backup --all --keep 7 >> /var/log/nelcota-backup.log 2>&1
\`\`\`

A broken project does not stop the others from being backed up; the command
lists the failures and exits non-zero. \`nelcota status\` shows the age of each
project's last backup, and \`nelcota doctor\` reports a missing cron job or a
backup older than 26 hours.

With disk storage, every dump has a sibling \`<dump>.files/\` directory containing
the immutable object versions and a SHA-256 manifest. The dump and file list
share one exported Postgres snapshot. A SHARE lock on \`storage.objects\` prevents
metadata changes during capture; reads continue, but file writes may wait.

The upload publishes that directory to \`s3://<bucket>/<project>/<dump>.files/\`
before uploading the dump. Later replacements and deletions cannot change an
older snapshot. Keep each dump together with its file directory; \`--keep\` prunes
both locally. Configure remote lifecycle rules for both members of the pair.

On Unix, dumps, snapshot files, manifests and environment files are created
with mode **0600**, before writing data. Backup and archive directories use
**0700**. Copies retain the private policy rather than the source's mode;
downloads run with umask 077 and their bundles are sealed afterward. Existing
environment files are restricted before overwriting them. Windows keeps the
filesystem's ACL policy; Unix modes are not simulated there.

The dump uses \`pg_dump\`'s custom format: it includes schema, data, RLS
policies, functions and the \`auth\` schema (users with their argon2id hashes).
Cluster roles (\`anon\`, \`authenticated\`...) are not in the dump, but Nelcota's
migrations recreate them on any new install.

### S3-compatible

Any service with an S3 API: AWS S3, Backblaze B2, Cloudflare R2, Wasabi,
MinIO. Variables in \`host.env\` (they apply to every project):

\`\`\`sh
NELCOTA_BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
NELCOTA_BACKUP_S3_BUCKET=my-backups
NELCOTA_BACKUP_S3_ACCESS_KEY=...
NELCOTA_BACKUP_S3_SECRET_KEY=...
NELCOTA_BACKUP_S3_REGION=us-west-002
\`\`\`

Docker uploads use the \`amazon/aws-cli\` image. Systemd hosts execute native
AWS CLI v2, which you must install separately. Set private bucket access and
explicit remote lifecycle rules for both dumps and file snapshots. Test readback
and off-host restore; a successful upload alone does not prove recoverability.

> **Keep \`host.env\` and each project's \`.env\` somewhere safe, apart from the
> bucket.** They are not in the backup (they hold secrets). Without the
> project's \`.env\` a restore still works, but the JWT key changes and every
> user has to sign in again (passwords keep working).

## Restore

\`\`\`sh
nelcota -p shop restore projects/shop/backups/nelcota-shop-20261006T030000Z.dump
\`\`\`

The restore asks for confirmation (\`--yes\` skips it), puts the project's
Caddy site in maintenance (HTTP 503 with \`Retry-After\`), stops the app and
takes a **safety backup** of the current state, printing its path. Then it
runs \`pg_restore --clean --if-exists\` in **a single transaction** (if anything
fails, the database stays as it was), starts the app and reopens traffic once
it is healthy. If the app does not become healthy, the site stays in
maintenance and the error shows how to go back:

\`\`\`sh
nelcota -p shop restore projects/shop/backups/<safety dump> --yes
\`\`\`

A restore also takes over a maintenance gate left closed by a failed upgrade
or restore, since it is how such a project recovers.

Use \`--files\` to restore the matching disk snapshot. It uses the local sibling
directory when present, otherwise fetches that dump's snapshot from the backup
bucket. The manifest, file sizes and hashes are checked before stopping the app.
The immutable versions are copied before restoring the database, so a file-copy
failure leaves the database untouched. Existing unrelated versions remain for
the normal orphan collector. Backups made with the former shared storage mirror
have no historical file manifest; they remain usable for database-only restores.

### Restore on a new VPS

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh
mkdir -p /opt/nelcota && cd /opt/nelcota
nelcota init api.shop.com --yes
cp /safe/place/shop.env projects/shop/.env   # optional: keeps the JWT key
nelcota up
aws s3 cp s3://my-backups/shop/nelcota-shop-....dump projects/shop/backups/ --endpoint-url ...
nelcota -p shop restore projects/shop/backups/nelcota-shop-....dump --files --yes
\`\`\`

This restores the matching disk snapshot too; fetch its directory/manifest or
configure the host backup bucket so the CLI can fetch it. Omit \`--files\` only
for an intentional database-only restore. Preserve and reconcile the private
project/host configuration, including credentials and SSO settings. The direct
\`aws\` download above requires an installed AWS CLI and configured private access.

The acceptance test (\`scripts/acceptance.sh --local\`) takes a backup, writes
more data, restores and checks that the state went back to the backup's.

When a project is removed (\`nelcota -p <name> remove\`), a final backup is kept
in \`archive/\`, in the host folder. If its Postgres is stopped, \`remove\` starts
it for the backup and refuses to delete anything when it cannot;
\`--no-backup\` removes without one.
Disk snapshots are archived alongside the final dump.

## PITR (point-in-time recovery)

Daily dumps lose up to 24 h of writes in the worst case. With PITR on,
Postgres sends every WAL segment to the S3-compatible storage as it fills (and
at least once a minute), next to periodic base backups, so the project can go
back to **any second** the archive covers: just before a bad migration or a
\`DELETE\` without a \`WHERE\`.

\`\`\`sh
nelcota -p shop pitr enable                                    # archiving + first full backup
nelcota -p shop pitr status                                    # backups and the range covered
nelcota -p shop pitr backup                                    # base backup now (full Sunday, otherwise differential)
nelcota -p shop pitr restore --time "2026-10-07 14:30:00+00"   # back to that moment
nelcota -p shop pitr restore                                   # up to the last archived write
nelcota -p shop pitr disable                                   # stops archiving (keeps what is in S3)
\`\`\`

- It uses [pgBackRest](https://pgbackrest.org/), installed in the project's
  Postgres image (\`postgres/Dockerfile\`: the official \`postgres:17-alpine\` plus
  the Alpine package, so the data directory is unchanged). Everything goes to
  \`s3://<bucket>/<project>/pitr/\`, beside the dumps.
- It needs the S3 settings in \`host.env\` (the same ones the backup upload uses).
  pgBackRest only talks to S3 over HTTPS. For your own MinIO/SeaweedFS with a
  private certificate authority, install its trusted CA for the runtime.
  \`NELCOTA_BACKUP_S3_VERIFY_TLS=false\` disables verification and should not
  be used for production recovery. For providers requiring path-style URLs,
  set \`NELCOTA_BACKUP_S3_URI_STYLE=path\`.
- \`enable\` writes \`pgbackrest.env\` in the project folder (mode 600, it holds
  the S3 keys). After changing the S3 settings in \`host.env\`, run \`enable\`
  again to regenerate it.
- The daily \`backup --all\` also takes a base backup for projects with PITR:
  full on Sundays, differential on the other days. Two full backups are kept,
  so the window reaches back one to two weeks. Fewer WAL segments to replay
  means a faster restore.
- PITR restores PostgreSQL only. It does not rewind disk/S3 object bytes.
  Older metadata can refer to versions already deleted; maintain provider
  versioning/history or a separately verified file-recovery plan. Paired
  dump/file snapshots are a different recovery mechanism.
- \`restore\` stops the project, rewrites the data directory from the closest
  base backup, replays the WAL up to the target and starts everything again.
  It discards every write after the target, so it asks for confirmation
  (\`--yes\` skips it). Then it takes a new full backup, because the restored
  database continues on a new timeline that older backups cannot serve.
- Recovery is destructive. Some configuration/archive problems are rejected
  early, but an unreachable target can be detected during WAL replay after
  files were restored. Before changing data, the CLI persists a recovery fence
  outside the data directory. An error or interrupted restore retains it across
  CLI exit, service restart and machine reboot. Do not assume the old database
  is unchanged or automatically restored. Use the explicit recovery steps below.
- Projects created before PITR are updated by \`enable\`: Postgres switches to
  the image built from \`postgres/Dockerfile\` and gets an \`egress\` network to
  reach S3 (the \`internal\` network has no way out). If \`docker-compose.yml\`
  was edited by hand, \`enable\` prints the changes to make.

The acceptance test (\`scripts/acceptance-pitr.sh\`) runs the whole cycle
against a local S3 server with TLS.

### Supported PostgreSQL startup configuration

Docker PITR supports the PostgreSQL 17 image generated from \`postgres/Dockerfile\`
and the data directory \`/var/lib/postgresql/data\`. The resolved
\`services.postgres.command\` must be absent/null, exactly \`["postgres"]\`, or the
complete, unchanged command generated by \`nelcota init\` for a \`1gb\`, \`2gb\`,
\`4gb\` or \`8gb\` profile. All four generated tuning profiles remain supported.
An empty command, wrappers, extra flags, reordered arguments or hand-edited
tuning commands are refused; restore does not try to classify individual flags.

\`services.postgres.environment.PGDATA\` must be omitted or exactly
\`/var/lib/postgresql/data\`. A null/inherited value or an unresolved environment
representation is refused. For example, this explicit default is supported:

\`\`\`yaml
services:
  postgres:
    command: ["postgres"]
    environment:
      PGDATA: /var/lib/postgresql/data
\`\`\`

Commands containing \`-D\`/\`--pgdata\`, \`-c data_directory=...\` or
\`-c config_file=...\` are unsupported, including alternate spellings and flags
appended to a generated profile. A custom configuration file could redirect
the data directory indirectly. Preflight resolves Compose and refuses unknown
settings before stopping services, writing a fence or running any restore
adapter. The error names the setting and supported configuration. Existing
fences remain in place if a retry has unsupported settings.

Native PITR supports the packaged \`postgresql@17-main\` unit with
\`/usr/bin/pg_ctlcluster --skip-systemctl-redirect 17-main start\`, no systemd
environment overrides and \`/etc/postgresql/17/main/postgresql.conf\`.
\`pg_ctl_options\` in \`/etc/postgresql/17/main/pg_ctl.conf\` must be empty or
unset. The cluster's \`environment\` file must be empty/comments or contain only
\`PGDATA=/var/lib/postgresql/17/main\`. \`PG_CLUSTER_CONF_ROOT\` must be unset or
\`/etc/postgresql\`. PostgreSQL itself resolves the effective \`data_directory\`,
including configuration includes and \`postgresql.auto.conf\`; it must be exactly
\`/var/lib/postgresql/17/main\`. Unreadable, indeterminate or customized startup
settings are refused before mutation. The generated native tuning profiles
continue to work; native recovery supplies fixed \`-D\` and \`config_file\` arguments.

### PITR recovery fence

This is an Unreleased source capability; use a matching CLI and app artifact.
Run fence mutations and recovery on the Linux host. Docker refuses a restore
before changing data if the app image does not support the guard. Native recovery
also requires the matching installed app binary. Custom entrypoints, app commands
or data-directory locations require reviewed integration; they are refused
rather than silently left unprotected.

The durable fence is \`active.json\` (or a partially committed \`recovery.json\`)
under \`/var/lib/nelcota-pitr/\` on systemd, or
\`projects/<project>/pitr-fence/\` on Docker. Private receipts bind the fence to
its owning project and directory. Docker's \`active.json\` holds the exact original
Compose bytes for atomic release; do not print or publish its contents. The fence
has no timeout and is never removed at boot. Do not delete these files, move the
host directory, bypass entrypoints or disable the start guards.

Native PostgreSQL and app units check the fence in \`ExecStartPre\`, including
boot, manual \`systemctl start\` and cluster starts redirected through systemd.
The guard invokes a dedicated check-only copy at
\`/usr/local/lib/nelcota/pitr-check\`, retained across app binary rollback, without
following a script inside the fence directory. The CLI refuses \`up\`, service starts/restarts
and direct serving while fenced. Plain \`up\` is not a recovery action: use
\`pitr recover\` or a covered restore. Each refusal identifies the fence and
recovery command; systemd records its message in the service journal. A refused
unit can be \`failed\` with PID zero.

Docker temporarily rewrites \`docker-compose.yml\` and removes old containers
without removing their data volumes before any restore writes. The fenced
Compose mounts the project directory read-only so a substituted fence-directory
symlink remains visible to both entrypoint guards; its restart policy is
\`no\`. This prevents old \`unless-stopped\` or \`always\` containers from reopening
after a daemon or host restart. A manual container start still exits at the
guard, even if its restart policy is changed. Docker starts asynchronously:
inspect its exit status and logs, not only the exit code of \`docker start\`.
Successful recovery restores the exact original Compose bytes and \`up\` applies
its original restart policies.

Recovery validates directory components and every state file without following
symlinks, and rejects wrong owners, hardlinks or unexpected types before changing
PITR state or services. A refusal names the rejected path; preserve every marker
and investigate the ownership/layout instead of deleting it.

After verification and a clean recovery-server stop, Docker persists an
owner-bound \`release.verified.json\`, prepares \`active.json\` with the original
Compose bytes and removes \`recovery.json\`. One atomic rename then removes the
last marker and restores \`docker-compose.yml\` together; both directories are
synced. Failure before that commit leaves markers and guarded Compose. Failure
after it leaves no markers and the original Compose. Native guards remain
installed while markers are removed and synced. Repeating \`pitr recover --yes\`
re-verifies a fenced directory or finishes an already committed release; a
failed final sync does not require manual edits. The retained verification
receipt is metadata, not an active fence, and never authorizes automatic cleanup.

Inspect the fence and preserve the failed restore's diagnostics:

\`\`\`sh
nelcota -C /opt/nelcota -p shop pitr status
# Native service diagnostics:
sudo journalctl -u postgresql@17-main -u nelcota-shop -n 60 --no-pager
\`\`\`

If native recovery refuses an older installed app binary, keep services stopped
and install your already verified matching artifact atomically before retrying.
Do not replace it with an unverified download:

\`\`\`sh
sudo install -m 0755 /path/to/verified/nelcota /usr/local/lib/nelcota/nelcota.pitr-new
sudo mv /usr/local/lib/nelcota/nelcota.pitr-new /usr/local/lib/nelcota/nelcota
\`\`\`

When files may have been replaced or WAL recovery was interrupted, retry a
restore with a target covered by the archive. This explicit operation keeps
ordinary starts fenced while a temporary recovery-only PostgreSQL instance
replays WAL, without a TCP listener or autostart. Only verified promotion and
a stopped recovery instance release the fence:

\`\`\`sh
sudo nelcota -C /opt/nelcota -p shop pitr restore --time "2026-10-07 14:30:00+00" --yes
\`\`\`

To intentionally retain the current directory, first establish from the error
and backup history that retaining it is appropriate. Then run verification:

\`\`\`sh
sudo nelcota -C /opt/nelcota -p shop pitr recover --yes
sudo nelcota -C /opt/nelcota -p shop up
nelcota -C /opt/nelcota -p shop status
\`\`\`

\`recover\` stops any owned leftover recovery instance, requires a cleanly stopped
PG17 directory without recovery signals or a backup label, verifies the control
file and enabled page checksums, then checks heaps, TOAST and B-tree indexes
with \`pg_amcheck\` using at most two parallel workers. It can install the missing \`amcheck\`
extension in \`pg_catalog\`. This temporary PostgreSQL instance has no TCP
listener and cannot autostart; ordinary services remain blocked. After a clean
stop, the offline checks run again before the fence is durably cleared.
\`--yes\` skips the question, never verification. Failed checks retain the fence;
use a covered restore instead of removing it manually.

These checks cannot prove application-level correctness, preservation of every
acknowledged write or byte identity when checksums were disabled. Reconcile
data with your verified backup/history. After starting, verify an authorized
read, another user's RLS isolation, anonymous rejection and a private-file 404
before reopening external traffic. Recovery checks do not replace an off-host
restore rehearsal or paired file recovery.

## Troubleshooting

A missing offsite destination fails \`--upload\`; a partially configured bucket
also fails rather than silently skipping transfer. Check available space,
provider permissions/TLS and the full dump/files pair. On failed recovery, keep
maintenance and private diagnostics intact and inspect the selected runtime;
do not discard the safety backup. Use a disposable host to rehearse recovery.

Related: [deploy](deploy.md), [storage](storage.md), [leaving](leaving.md). Controlled-update recovery has a separate repository
guide at \`docs/panel-updates.md\`.
`,Fe=`# CLI reference

Use \`nelcota --help\` and \`<command> --help\` for the installed binary. This reference
was generated from a locked build of source commit
\`5cd74c590ed16e5b44da52cde423ed2ca209d2ee\`. It reports version 0.4.0 before
the next release bump; the \`updates\` command is source-only and absent from
published 0.4.0. Match release/tag and checksum, not the version string alone.

## Prerequisites and selection

Production host operations require Docker or supported Debian/Ubuntu systemd,
appropriate host privileges, a private host directory and the selected project.
Global \`-C\`/\`--dir\` selects the host (\`NELCOTA_ROOT\`, default \`.\`); \`-p\`/\`--project\`
selects a project. Commands needing one project require selection on multi-project
hosts. Without configuration, a bare \`nelcota\` prints help; with process/TOML
server configuration, it serves. \`serve\` explicitly loads server configuration.

Application \`migrate\`, \`types\` and \`token\` use saved dev settings, host runtime
configuration or direct process settings. Run migrations in your application
folder; the repository-root migrations are internal Nelcota SQL.

> **Warning:** \`token service-role\` bypasses RLS. Keep its result private.
> \`remove\`, \`down --volumes\`, \`restore\` and \`pitr restore\` can delete/replace data.
> A confirmation flag does not replace a verified backup and restore plan.

## Commands and options

Each block is the actual help output, preserving option names, accepted values,
defaults and arguments. Help does not run the command. Global options repeat
because they are accepted across command levels.

### Global help

\`\`\`text
BaaS on plain Postgres: REST API, auth and deploy in a single binary.

Usage: nelcota [OPTIONS] [COMMAND]

Commands:
  updates         Secure, separately authenticated host update controller
  serve           Starts the HTTP server (the default when no command is given)
  init            Creates a project (and the host, the first time)
  projects        Lists the host's projects and the state of each one
  up              Starts the projects and Caddy (all of them, or only the one from -p)
  down            Stops a project (or all with --all). With --volumes, DELETES the data
  status          State of the projects (all of them, or only the one from -p)
  doctor          Checks the host: Docker, ports, disk, DNS, backup job and age, S3, health
  logs            Logs of a project, or of the host's Caddy
  remove          Removes a project: final backup in archive/, containers and data deleted
  panel-login     Panel login: one for all (shared) or one per project
  dev             Local development environment (Postgres in a container + server)
  migrate         Applies SQL migrations from the directory (files V<n>__<name>.sql)
  upgrade         Updates the app image, with a backup first and a rollback if it fails
  backup          Dumps the database to backups/ and uploads it to S3 when host.env has a bucket
  restore         Restores a dump (replaces the project's current database)
  pitr            Point-in-time recovery: WAL archived to S3 with pgBackRest
  types           Generates TypeScript or Rust types from the exposed schema
  token           Issues service tokens
  keygen          Generates a new Ed25519 private key (for NELCOTA_JWT_PRIVATE_KEY)
  admin-password  New panel password (the host's with single sign-on; the project's with per-project login)
  healthcheck     Local healthcheck (used by Docker): exits with 0 if /health answers 200
  help            Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
  -V, --version            Print version
\`\`\`

### nelcota init

\`\`\`text
Creates a project (and the host, the first time)

Usage: nelcota init [OPTIONS] [DOMAIN]

Arguments:
  [DOMAIN]
          Project domain (e.g. api.shop.com). Without it, use --project with a base domain (subdomain) or --local

Options:
  -C, --dir <DIR>
          Host folder (where nelcota-host.json, caddy/ and projects/ live)

          [env: NELCOTA_ROOT=]
          [default: .]

      --project <PROJECT>
          Project name (default: derived from the domain, e.g. api.shop.com → shop)

      --base-domain <BASE_DOMAIN>
          Host base domain: \`--project shop\` becomes \`shop.<base>\`

      --local
          Local host, without a public domain: HTTPS at https://<project>.localhost

      --panel-login <PANEL_LOGIN>
          Panel login when creating the host: one for all (default) or per project

          Possible values:
          - shared:      One login for every panel on the host (SSO between projects)
          - per-project: Each project with its own login

          [default: shared]

      --email <EMAIL>
          Administrator email (default: admin@<domain>)

  -y, --yes
          Asks no questions (uses the defaults and the flags)

      --image <IMAGE>
          App image

          [env: NELCOTA_IMAGE=]
          [default: ghcr.io/nelcota/nelcota-server]

      --version <VERSION>
          Image tag (default: this binary's version)

      --profile <PROFILE>
          Postgres profile: 1gb, 2gb, 4gb or 8gb (default: by the RAM split across the projects)

      --s3-endpoint <S3_ENDPOINT>


      --s3-bucket <S3_BUCKET>


      --s3-access-key <S3_ACCESS_KEY>


      --s3-secret-key <S3_SECRET_KEY>


      --s3-region <S3_REGION>
          [default: us-east-1]

      --runtime <RUNTIME>
          How projects run: docker (N per host) or systemd (one, on Debian/Ubuntu, with Postgres and Caddy from apt). Only when the host is created

          [default: docker]
          [possible values: docker, systemd]

      --firewall
          Configures ufw (allows SSH, 80 and 443 and enables it)

      --skip-checks
          Skips the environment checks

  -h, --help
          Print help (see a summary with '-h')
\`\`\`

### nelcota dev

\`\`\`text
Local development environment (Postgres in a container + server)

Usage: nelcota dev [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --listen <LISTEN>    [default: 127.0.0.1:8000]
      --db-port <DB_PORT>  Local port of the development Postgres (default: the saved one, else 54322). A new port is saved in .nelcota/dev.env
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota migrate

\`\`\`text
Applies SQL migrations from the directory (files V<n>__<name>.sql)

Usage: nelcota migrate [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --path <PATH>        [default: migrations]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota types

\`\`\`text
Generates TypeScript or Rust types from the exposed schema

Usage: nelcota types [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --lang <LANG>        [default: typescript] [possible values: typescript, rust]
  -o, --out <OUT>
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota token

\`\`\`text
Issues service tokens

Usage: nelcota token [OPTIONS] <COMMAND>

Commands:
  service-role  JWT with the service_role role (BYPASSES RLS: never use it in a frontend)
  help          Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota token service-role

\`\`\`text
JWT with the service_role role (BYPASSES RLS: never use it in a frontend)

Usage: nelcota token service-role [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --days <DAYS>        [default: 3650]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota backup

\`\`\`text
Dumps the database to backups/ and uploads it to S3 when host.env has a bucket

Usage: nelcota backup [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --upload             Requires the S3 upload (fails if host.env has no bucket). Without it, the dump is uploaded whenever the bucket is configured
      --keep <KEEP>        Keeps only the N most recent local dumps (at least 1: the new one)
  -p, --project <PROJECT>  Project (required when the host has more than one)
      --all                All projects
  -h, --help               Print help
\`\`\`

### nelcota restore

\`\`\`text
Restores a dump (replaces the project's current database)

Usage: nelcota restore [OPTIONS] <FILE>

Arguments:
  <FILE>

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --files              Also restores the files from the backup bucket (disk storage)
  -p, --project <PROJECT>  Project (required when the host has more than one)
      --yes                Does not ask for confirmation
  -h, --help               Print help
\`\`\`

### nelcota upgrade

\`\`\`text
Updates the app image, with a backup first and a rollback if it fails

Usage: nelcota upgrade [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --version <VERSION>  Target version (default: this binary's version)
      --all                All projects, one at a time
  -p, --project <PROJECT>  Project (required when the host has more than one)
      --allow-downgrade    Allows a target older than the running version
      --reinstall          Redeploys even when the project is already on the target version
      --dry-run            Only prints the current → target version of each project
  -h, --help               Print help
\`\`\`

### nelcota down

\`\`\`text
Stops a project (or all with --all). With --volumes, DELETES the data

Usage: nelcota down [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --volumes            Also deletes the data volumes (asks for confirmation; Docker only)
      --all
  -p, --project <PROJECT>  Project (required when the host has more than one)
      --yes                Does not ask for confirmation before deleting volumes
  -h, --help               Print help
\`\`\`

### nelcota remove

\`\`\`text
Removes a project: final backup in archive/, containers and data deleted

Usage: nelcota remove [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --yes                Does not ask for confirmation
      --keep-files         Keeps the project folder (migrations, backups)
  -p, --project <PROJECT>  Project (required when the host has more than one)
      --no-backup          Skips the final backup (otherwise a stopped Postgres is started for it)
  -h, --help               Print help
\`\`\`

### nelcota logs

\`\`\`text
Logs of a project, or of the host's Caddy

Usage: nelcota logs [OPTIONS] [SERVICE]

Arguments:
  [SERVICE]
          app, postgres or caddy (default: the project's app and postgres)

          Possible values:
          - app
          - postgres
          - caddy:    The shared proxy (host-wide; -p is not needed)

Options:
  -C, --dir <DIR>
          Host folder (where nelcota-host.json, caddy/ and projects/ live)

          [env: NELCOTA_ROOT=]
          [default: .]

  -f, --follow


  -p, --project <PROJECT>
          Project (required when the host has more than one)

  -h, --help
          Print help (see a summary with '-h')
\`\`\`

### nelcota healthcheck

\`\`\`text
Local healthcheck (used by Docker): exits with 0 if /health answers 200

Usage: nelcota healthcheck [OPTIONS]

Options:
      --addr <ADDR>        [default: 127.0.0.1:8000]
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota projects

\`\`\`text
Lists the host's projects and the state of each one

Usage: nelcota projects [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota up

\`\`\`text
Starts the projects and Caddy (all of them, or only the one from -p)

Usage: nelcota up [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota status

\`\`\`text
State of the projects (all of them, or only the one from -p)

Usage: nelcota status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota doctor

\`\`\`text
Checks the host: Docker, ports, disk, DNS, backup job and age, S3, health

Usage: nelcota doctor [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota panel-login

\`\`\`text
Panel login: one for all (shared) or one per project

Usage: nelcota panel-login [OPTIONS] <MODE>

Arguments:
  <MODE>
          Possible values:
          - shared:      One login for every panel on the host (SSO between projects)
          - per-project: Each project with its own login

Options:
  -C, --dir <DIR>
          Host folder (where nelcota-host.json, caddy/ and projects/ live)

          [env: NELCOTA_ROOT=]
          [default: .]

  -p, --project <PROJECT>
          Project (required when the host has more than one)

  -h, --help
          Print help (see a summary with '-h')
\`\`\`

### nelcota admin-password

\`\`\`text
New panel password (the host's with single sign-on; the project's with per-project login)

Usage: nelcota admin-password [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota keygen

\`\`\`text
Generates a new Ed25519 private key (for NELCOTA_JWT_PRIVATE_KEY)

Usage: nelcota keygen [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota serve

\`\`\`text
Starts the HTTP server (the default when no command is given)

Usage: nelcota serve [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota pitr

\`\`\`text
Point-in-time recovery: WAL archived to S3 with pgBackRest

Usage: nelcota pitr [OPTIONS] <COMMAND>

Commands:
  enable   Archives every WAL segment to the host's S3 and takes a first full backup
  disable  Stops archiving (the backups already in S3 are kept)
  status   Base backups and the time range that can be restored
  backup   Takes a base backup now (full on Sundays, differential otherwise)
  restore  Restores the database to a moment (REPLACES the current data)
  help     Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota pitr enable

\`\`\`text
Archives every WAL segment to the host's S3 and takes a first full backup

Usage: nelcota pitr enable [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota pitr disable

\`\`\`text
Stops archiving (the backups already in S3 are kept)

Usage: nelcota pitr disable [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota pitr status

\`\`\`text
Base backups and the time range that can be restored

Usage: nelcota pitr status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota pitr restore

\`\`\`text
Restores the database to a moment (REPLACES the current data)

Usage: nelcota pitr restore [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --time <TIME>        Target moment, e.g. "2026-10-07 14:30:00+00" (default: the last archived write)
  -p, --project <PROJECT>  Project (required when the host has more than one)
      --yes                Does not ask for confirmation
  -h, --help               Print help
\`\`\`

### nelcota updates

\`\`\`text
Secure, separately authenticated host update controller

Usage: nelcota updates [OPTIONS] <COMMAND>

Commands:
  enroll        Enroll a host with a separate HTTPS origin and scoped operator (root/SSH only)
  serve         Unprivileged HTTP controller (normally managed by systemd)
  worker        Restricted privileged IPC worker (normally managed by systemd)
  status        Inspect the durable journal over SSH, including interrupted jobs
  recover       Recover one interrupted job. Never restores an old snapshot after commit
  host-recover  Resume a host-management receipt after inspecting the interrupted operation
  host-status   Inspect host projects and durable management receipts over SSH
  help          Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota updates enroll

\`\`\`text
Enroll a host with a separate HTTPS origin and scoped operator (root/SSH only)

Usage: nelcota updates enroll [OPTIONS] --origin <ORIGIN> --email <EMAIL> --password-file <PASSWORD_FILE> --verifier <VERIFIER> --projects <PROJECTS>

Options:
  -C, --dir <DIR>
          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --origin <ORIGIN>

      --email <EMAIL>

  -p, --project <PROJECT>
          Project (required when the host has more than one)
      --password-file <PASSWORD_FILE>
          Private file containing a new operator password (at least 16 characters)
      --verifier <VERIFIER>
          Root-owned native GitHub CLI supporting \`attestation verify\`
      --projects <PROJECTS>

      --host-management <HOST_MANAGEMENT>
          Private root-owned JSON approving host management, image and DNS scope
  -h, --help
          Print help
\`\`\`

### nelcota updates host-status

\`\`\`text
Inspect host projects and durable management receipts over SSH

Usage: nelcota updates host-status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota updates host-recover

\`\`\`text
Resume a host-management receipt after inspecting the interrupted operation

Usage: nelcota updates host-recover [OPTIONS] --job <JOB>

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
      --job <JOB>
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota updates recover

\`\`\`text
Recover one interrupted job. Never restores an old snapshot after commit

Usage: nelcota updates recover [OPTIONS] --job <JOB>

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
      --job <JOB>
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota updates serve

\`\`\`text
Unprivileged HTTP controller (normally managed by systemd)

Usage: nelcota updates serve [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --config <CONFIG>    [default: /etc/nelcota-updates/controller.json]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota updates worker

\`\`\`text
Restricted privileged IPC worker (normally managed by systemd)

Usage: nelcota updates worker [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota updates status

\`\`\`text
Inspect the durable journal over SSH, including interrupted jobs

Usage: nelcota updates status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

### nelcota pitr backup

\`\`\`text
Takes a base backup now (full on Sundays, differential otherwise)

Usage: nelcota pitr backup [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (where nelcota-host.json, caddy/ and projects/ live) [env: NELCOTA_ROOT=] [default: .]
  -p, --project <PROJECT>  Project (required when the host has more than one)
  -h, --help               Print help
\`\`\`

## Operational guarantees and limits

- \`upgrade\` targets the installed CLI version unless you provide a version. Install
  that CLI first; upgrades on enrolled hosts must use the separate controller.
- Ordinary upgrade/restore maintenance, paired snapshots and rollback are in
  [deploy](deploy.md) and [backup](backup.md). Database PITR has different failure
  and file-recovery limits; do not infer dump-restore guarantees from it.
- \`pitr backup\` takes a base backup now: full on Sunday, differential otherwise.
- \`init\` validates arguments before provisioning; provisioning errors can still
  leave files/services requiring inspection. \`--skip-checks\` does not make a
  failed deployment safe.
- \`updates enroll\` requires root/SSH and official artifacts plus a separate origin.
  Installation remains disabled until the exact-binary acceptance matrix passes.
  Internal serve/worker roles are normally managed by systemd.

## Troubleshooting

Use \`status\`, \`doctor\` and the selected service logs. Preserve unresolved update
journals/backups and use \`updates status\`/\`recover\` over SSH; do not clear receipts
to bypass a blocked host. For permission/SQL/auth errors, see
[troubleshooting](troubleshooting.md).

Related: [configuration](configuration.md), [deploy](deploy.md), [backup](backup.md)
and [controlled updates](panel-updates.md).
`,Ie='# Configuration reference\n\nConfigure the server from process environment variables or a TOML file. This\nreference is derived from `Config` and its defaults in `crates/core/src/config.rs`,\nplus the CLI, installer and backup adapters. Use the matching release source for\npublished binaries; deployment validation settings below exist only in `main`.\n\n## Loading and file ownership\n\nPrecedence is built-in defaults, then `nelcota.toml` (or `NELCOTA_CONFIG`), then\n`NELCOTA_` environment variables. TOML uses lowercase field names without the\nprefix. `nelcota serve` does not automatically read `.env`. Compose injects the\nproject file; native systemd uses its environment file; the host CLI reads project\nfiles for operations. `nelcota dev` constructs generated development settings\nand reuses `.nelcota/dev.env`; it is not a production environment-file loader.\n\nFor standalone serving, set real process variables through your service manager\nor use a private TOML file. This example is a shape, not runnable credentials:\n\n```toml\ndatabase_url = "postgres://postgres:REPLACE@127.0.0.1:5432/postgres"\nauthenticator_password = "REPLACE_WITH_A_GENERATED_SECRET"\njwt_private_key = "REPLACE_WITH_KEYGEN_OUTPUT"\nlisten = "127.0.0.1:8000"\n```\n\nGenerate keys with `nelcota keygen`, passwords with `openssl rand -base64 48`,\nand panel hashes with the CLI. Keep files containing these values owner-readable\nand out of version control. Optional secret/mail values that normalize to blank\nare absent; do not assume every optional field accepts an empty string.\n\n## Server variables\n\nTypes mirror the Rust contract: `Secret` is a string; `Option<T>` is optional;\ninteger sizes are unsigned except `max_rows`, which must be positive. Durations\nand sizes use seconds/days/bytes as specified. Examples containing `REPLACE`,\nprovider IDs or generated values require your own credentials.\n\n| Variable | Type | Default | Example | Effect / validation |\n| --- | --- | --- | --- | --- |\n| `NELCOTA_DATABASE_URL` | `Secret` | `empty (required)` | `postgres://postgres:REPLACE@127.0.0.1:5432/postgres` | Required administrator connection for bootstrap and panel; request pools replace credentials with authenticator. Private PostgreSQL only: built-in connectors use NoTls. |\n| `NELCOTA_AUTHENTICATOR_PASSWORD` | `Secret` | `empty (required)` | `runtime-generated secret` | Required, at least 16 bytes; cluster-global authenticator password. Coordinate independent databases or use separate clusters. |\n| `NELCOTA_JWT_PRIVATE_KEY` | `Option<Secret>` | `unset` | `nelcota keygen output` | Ed25519 PKCS#8 PEM or one-line base64. Signs EdDSA and publishes its public JWKS; preferred over HS256. |\n| `NELCOTA_JWT_SECRET` | `Option<Secret>` | `unset` | `runtime-generated 48-byte base64 secret` | HS256 requires at least 32 bytes. Signs when no Ed25519 key exists; otherwise verifies legacy HS256 tokens only. |\n| `NELCOTA_JWT_ISSUER` | `String` | `nelcota` | `my-api` | Issued iss claim; built-in verification does not enforce issuer/audience. Choose a consistent nonempty value. |\n| `NELCOTA_JWT_EXPIRY_SECS` | `u64` | `900` | `900` | Positive access-token lifetime in seconds; must not overflow its representable range. |\n| `NELCOTA_REFRESH_TOKEN_TTL_DAYS` | `u32` | `30` | `30` | Positive refresh lifetime in days, renewed per rotation; bounded by PostgreSQL timestamp horizon. |\n| `NELCOTA_SIGNUP_ENABLED` | `bool` | `true` | `false` | Allows public signup. Provider sign-in for existing linked accounts has its own documented flow. |\n| `NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` | `u32` | `30` | `30` | Positive password/signup/email/provider budget per IP. Password login also has an email budget. Refresh/PKCE use a separate 10x budget. |\n| `NELCOTA_TRUST_PROXY` | `bool` | `false` | `true` | Uses rightmost X-Forwarded-For for caller IP. Enable only behind a correctly configured trusted proxy with direct access restricted. |\n| `NELCOTA_SMTP_URL` | `Option<Secret>` | `unset` | `smtps://user:REPLACE@smtp.example.com:465` | Auth email transport; smtps or smtp with required TLS. Set sender and recovery page together. Blank is absent. |\n| `NELCOTA_SMTP_FROM` | `Option<String>` | `unset` | `App <no-reply@example.com>` | Sender mailbox/display name. Quote spaces in the deployment environment-file format. |\n| `NELCOTA_PASSWORD_RECOVERY_URL` | `Option<String>` | `unset` | `https://app.example.com/recovery` | Required with SMTP; HTTP(S) application link page without a fragment. Production should use HTTPS. |\n| `NELCOTA_EMAIL_CONFIRMATION_URL` | `Option<String>` | `unset` | `https://app.example.com/confirm` | With SMTP, makes signup wait for email confirmation. HTTP(S) page without a fragment. |\n| `NELCOTA_MAGIC_LINK_URL` | `Option<String>` | `unset` | `https://app.example.com/sign-in` | With SMTP, enables passwordless links for existing accounts. HTTP(S) page without a fragment. |\n| `NELCOTA_API_URL` | `Option<String>` | `unset` | `https://api.example.com` | Public API HTTP(S) origin for OAuth callback; required when a provider is enabled. Also used as Vite proxy override during UI development. |\n| `NELCOTA_OAUTH_REDIRECT_URLS` | `Option<String>` | `unset` | `https://app.example.com/auth` | Comma-separated application pages allowed after OAuth; same origin and equal/below path. Required with a provider. |\n| `NELCOTA_OAUTH_GOOGLE_CLIENT_ID` | `Option<String>` | `unset` | `provider-issued ID` | Google OAuth client ID; set together with its secret and API/redirect URLs. |\n| `NELCOTA_OAUTH_GOOGLE_CLIENT_SECRET` | `Option<Secret>` | `unset` | `provider-issued secret` | Google OAuth secret; keep out of frontend configuration. |\n| `NELCOTA_OAUTH_GITHUB_CLIENT_ID` | `Option<String>` | `unset` | `provider-issued ID` | GitHub OAuth client ID; set together with its secret and API/redirect URLs. |\n| `NELCOTA_OAUTH_GITHUB_CLIENT_SECRET` | `Option<Secret>` | `unset` | `provider-issued secret` | GitHub OAuth secret; keep out of frontend configuration. |\n| `NELCOTA_ADMIN_EMAIL` | `Option<String>` | `unset` | `admin@example.com` | Project-panel login identity; panel is disabled without email and password hash. |\n| `NELCOTA_ADMIN_PASSWORD_HASH` | `Option<Secret>` | `unset` | `generated PHC argon2id hash` | PHC argon2id hash; generated by init/admin-password. Single-quote dollar signs in environment files. |\n| `NELCOTA_ADMIN_SSO_SECRET` | `Option<Secret>` | `unset` | `host-generated secret` | Shared host-panel handoff secret; absent means per-project login. Generated by CLI login management. |\n| `NELCOTA_PROJECT_NAME` | `Option<String>` | `unset` | `shop` | Project identity displayed in the panel; generated by host deployment. |\n| `NELCOTA_HOST_REGISTRY` | `Option<PathBuf>` | `unset` | `/etc/nelcota/shared/projects.json` | Public project name/URL registry for the switcher; generated by the host CLI. |\n| `NELCOTA_MIGRATIONS_DIR` | `Option<PathBuf>` | `unset` | `./migrations` | Folder scanned when allocating panel-generated application migrations; /migrations is detected in the container. |\n| `NELCOTA_DB_SCHEMA` | `String` | `public` | `public` | Schema exposed through REST/catalog and type generation. |\n| `NELCOTA_MAX_ROWS` | `Option<i64>` | `1000` | `1000` | Positive root/embedded read and set-returning RPC cap; omitted/None uses 1000. Write-embedded collections have their own fixed 1000 cap. |\n| `NELCOTA_MAX_BODY_BYTES` | `usize` | `2097152` | `2097152` | Positive REST write/RPC body cap in bytes; bodies are buffered. Does not set the streamed file-upload limit. |\n| `NELCOTA_LISTEN` | `SocketAddr` | `0.0.0.0:8000` | `127.0.0.1:8000` | HTTP bind socket. Raw serve defaults to all interfaces; dev overrides to loopback, and host runtime controls binding separately. |\n| `NELCOTA_DB_POOL_SIZE` | `usize` | `10` | `10` | Positive request-pool capacity; does not set separate panel/webhook/export budgets. |\n| `NELCOTA_REQUEST_TIMEOUT_SECS` | `u64` | `15` | `15` | Positive ordinary HTTP request deadline in seconds. Must exceed nonzero statement timeout; streamed uploads/exports have separate budgets. |\n| `NELCOTA_STATEMENT_TIMEOUT_SECS` | `u64` | `10` | `10` | Request-pool PostgreSQL statement timeout in seconds. 0 disables that timeout; use deliberately. Panel SQL has separate fixed budgets. |\n| `NELCOTA_LOG_FORMAT` | `LogFormat` | `text` | `json` | text or json tracing output; verbosity comes from RUST_LOG. |\n| `NELCOTA_WEBHOOKS_ALLOW_LOOPBACK` | `bool` | `false` | `false` | Development-only HTTP(S) to localhost/127.0.0.1/::1. Does not permit LAN/metadata addresses or arbitrary public HTTP. |\n| `NELCOTA_DEPLOYMENT_VALIDATION` | `bool` | `false` | `controller-managed` | Linux controller-owned candidate gate; requires gate path and identity. Never configure manually to enable an update. |\n| `NELCOTA_DEPLOYMENT_GATE` | `Option<PathBuf>` | `unset` | `controller-managed absolute path` | Absolute controller-owned gate path bound to the candidate. Keep ownership and protocol managed by enrollment. |\n| `NELCOTA_DEPLOYMENT_ID` | `Option<String>` | `unset` | `controller-managed 64-character hex ID` | Controller-owned candidate operation identity; 64 lowercase hexadecimal characters while validation is enabled. |\n| `NELCOTA_STORAGE_BACKEND` | `StorageBackend` | `off` | `disk` | off, disk or s3. Raw serve defaults to off; init/dev enable disk with runtime-specific paths. |\n| `NELCOTA_STORAGE_DIR` | `Option<PathBuf>` | `unset` | `./storage` | Required for disk. Server must own the directory and enforce private permissions. |\n| `NELCOTA_STORAGE_S3_ENDPOINT` | `Option<String>` | `unset` | `https://s3.example.com` | Custom S3 endpoint; absent/blank selects AWS. Production must use verified HTTPS. |\n| `NELCOTA_STORAGE_S3_BUCKET` | `Option<String>` | `unset` | `files` | Required with S3 backend; separate from the offsite backup bucket. |\n| `NELCOTA_STORAGE_S3_REGION` | `String` | `auto` | `us-east-1` | Provider region. auto is appropriate for R2; set the actual region for AWS. |\n| `NELCOTA_STORAGE_S3_ACCESS_KEY_ID` | `Option<String>` | `unset` | `provider-issued ID` | Required with S3 backend; scope provider privileges to the application bucket. |\n| `NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY` | `Option<Secret>` | `unset` | `provider-issued secret` | Required with S3 backend; never expose or log the value. |\n| `NELCOTA_STORAGE_S3_VIRTUAL_HOSTED` | `bool` | `false` | `false` | Use bucket.endpoint URLs instead of endpoint/bucket when supported by your provider. |\n| `NELCOTA_STORAGE_MAX_FILE_SIZE` | `u64` | `52428800` | `52428800` | Positive maximum upload bytes; a bucket can only lower it. Default is 50 MiB. |\n| `NELCOTA_STORAGE_MAX_TOTAL_SIZE` | `Option<u64>` | `unset` | `10737418240` | Optional committed total-byte cap across all buckets. Unset has no cap; 0 leaves no capacity for nonempty files. |\n| `NELCOTA_STORAGE_MIN_FREE_BYTES` | `u64` | `1073741824` | `1073741824` | Disk backend free-space reserve, in bytes. Default is 1 GiB. |\n| `NELCOTA_STORAGE_PUBLIC_URL` | `Option<String>` | `unset` | `https://files.example.com` | Public-file URL origin; absent uses relative API URLs. Configure an HTTPS proxy to public object routes. |\n| `NELCOTA_STORAGE_UPLOAD_TIMEOUT_SECS` | `u64` | `3600` | `3600` | Positive admission/policy/byte-reception deadline in seconds when enabled. Metadata publication and multipart cleanup have separate bounded settlement. |\n\nAll 52 fields are listed above. `Secret` affects log formatting, not encryption\nof the environment file. API signatures are not a substitute for private key\nstorage. Backend and backup S3 credentials/settings are separate.\n\n## CLI and installer variables\n\n| Variable | Scope / type | Default | Example | Effect |\n| --- | --- | --- | --- | --- |\n| `NELCOTA_CONFIG` | server path | `nelcota.toml` | `/etc/nelcota/server.toml` | Selects TOML file; environment overrides it. |\n| `NELCOTA_ROOT` | CLI host path | `.` | `/opt/nelcota` | Equivalent to global `--dir`; does not chdir the raw server TOML loader. |\n| `NELCOTA_IMAGE` | init image string | `ghcr.io/nelcota/nelcota-server` | `ghcr.io/nelcota/nelcota-server` | Default project app image; custom images are outside controlled-update V1. |\n| `NELCOTA_VERSION` | installer/host version string | installer: `latest`; init: CLI version | `0.4.0` | Installer release selection; persisted host image tag. Installing the CLI does not upgrade running projects. |\n| `NELCOTA_REPO` | installer repository string | `Nelcota/Nelcota` | `Nelcota/Nelcota` | Release source override; use official artifacts for supported deployments. |\n| `PREFIX` | installer directory | `/usr/local/bin` | `$HOME/.local/bin` | Writable user-owned prefix can avoid sudo for binary installation. Add it to your PATH yourself. |\n| `NELCOTA_SKIP_DOCKER` | installer string switch | `0` | `1` | Exactly `1` skips Docker installation; does not provide Docker for dev. |\n| `NELCOTA_APP_IMAGE` | controller-managed image identity | unset | controller-managed digest | Pins the app image on enrolled Docker hosts; do not hand-edit during a job. |\n| `RUST_LOG` | server tracing filter | `info,tower_http=info` | `info,tower_http=info` | Controls log levels, independently of text/json format. Debug diagnostics can contain operational details. |\n\n## Offsite backup and PITR settings\n\nSet these in the host\'s private `host.env`, not the public app client. Endpoint,\nbucket, access key and secret must be configured together. Docker invokes an\nAWS CLI container; systemd offsite transport requires native AWS CLI v2.\n\n| Variable | Type | Default | Example | Effect |\n| --- | --- | --- | --- | --- |\n| `NELCOTA_BACKUP_S3_ENDPOINT` | HTTPS URL | unset | `https://s3.example.com` | Required backup/PITR provider endpoint. |\n| `NELCOTA_BACKUP_S3_BUCKET` | string | unset | `private-backups` | Host backup bucket, shared by project prefixes. |\n| `NELCOTA_BACKUP_S3_ACCESS_KEY` | secret string | unset | provider-issued ID | Backup transport credential. |\n| `NELCOTA_BACKUP_S3_SECRET_KEY` | secret string | unset | provider-issued secret | Keep private; unrelated to the app storage credential. |\n| `NELCOTA_BACKUP_S3_REGION` | string | `us-east-1` | `us-west-002` | Backup/PITR provider region. |\n| `NELCOTA_BACKUP_S3_URI_STYLE` | `host` or `path` | `host` | `path` | pgBackRest addressing style; regenerate with pitr enable. |\n| `NELCOTA_BACKUP_S3_VERIFY_TLS` | string switch | verified TLS | leave unset | pgBackRest disables verification only for the literal false setting. Keep verification enabled; install trusted certificates for private providers. |\n\n## Development and test scope\n\nTest/example variables such as `NELCOTA_TEST_DATABASE_URL`, S3 fixture settings,\n`NELCOTA_URL`/`NELCOTA_EMAIL`/`NELCOTA_PASSWORD` and benchmark controls do not\nconfigure the production server. See [CONTRIBUTING](../CONTRIBUTING.md) and each example/benchmark\nguide for their scope. Never point test database variables at valuable data.\n\n## Troubleshooting\n\n- Missing required values: configure the process/TOML, not an unconsumed `.env` file.\n- SMTP/provider startup failure: configure each required group together and use permitted link pages.\n- Timeouts: keep request timeout greater than a nonzero statement timeout; different workloads use separate budgets.\n- Storage disabled: raw serve defaults to off; select backend and required directory/provider credentials.\n- Update validation error: repair enrollment/job state over SSH; never manually disable a candidate gate.\n\nRelated: [CLI](cli.md), [deploy](deploy.md), [auth](schema-auth.md),\n[storage](storage.md), [backup](backup.md) and [security](security/README.md).\n',Le=`# Decision log

Historical decisions made while building Nelcota, with the why. Newest at the
end. Earlier milestones are snapshots: current server source requires Rust 1.99,
the Rust SDK supports 1.88, and a bare CLI without server configuration prints
help. Use current operating guides and release notes over superseded choices.
Decision numbers and historical rationale remain intact.

## Milestone 1

**D1. Apache-2.0 license.** Chosen by the maintainer (2026-10-06).

**D2. Name and binary.** The project is called Nelcota; the single binary is
\`nelcota\` (crate \`nelcota-server\`). In Milestone 4 it gains subcommands
(\`nelcota init\`, \`nelcota up\`...); without arguments it starts the server.

**D3. The \`admin\` and \`cli\` crates only arrive in Milestones 4/5.** Avoids
empty crates.

**D4. Integration tests in \`crates/server/tests/\`.** The workspace is virtual
(there is no package at the root), and Cargo integration tests must belong to a
package. \`server\` exposes the \`Router\` in a lib so the tests use the same code
as production.

**D5. A single URL.** \`NELCOTA_DATABASE_URL\` points to a role that owns the
schema (the \`postgres\` superuser in Docker) and is used only for migrations and
to set the \`authenticator\` password. The API uses the same host/database,
swapping user/password for \`authenticator\` / \`NELCOTA_AUTHENTICATOR_PASSWORD\`.

**D6. The \`authenticator\` password stays out of migrations.** Migrations hold
no secrets. At startup the server computes the SCRAM-SHA-256 verifier on the
client side and runs \`ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'\`: the plain
password never travels over the wire nor shows up in Postgres' statement log.

**D7. \`set_config('role', $1, true)\` instead of \`SET LOCAL ROLE x\`.** Both are
equivalent (\`SET LOCAL ROLE\` is sugar for \`set_config('role', ..., true)\`), but
\`set_config\` takes a parameter, sets role and claims in a single round trip and
avoids any SQL built as a string. The role value comes from a closed \`enum\`.

**D8. Pool with \`RecyclingMethod::Fast\`.** Role and claims are
transaction-scoped and die on COMMIT/ROLLBACK (including a drop without commit,
which sends ROLLBACK). No \`DISCARD ALL\` is needed on each checkout. Covered by
the pool-leak and rollback tests in \`crates/server/tests/rls.rs\`.

**D9. Internal migrations in \`nelcota.schema_migrations\`.** A schema of its
own, without GRANTs to the API roles, so it does not show up in \`public\`
(which the automatic API exposes). An advisory lock serializes bootstrap
across instances.

**D10. The example table stays out of migrations.** \`examples/todos.sql\` is
applied by the tests and optionally in dev. Nelcota's migrations create no
business tables in anyone's database.

**D11. Extensions in the \`extensions\` schema.** \`pgcrypto\` and
\`pg_stat_statements\` stay out of \`public\`. \`pg_stat_statements\` requires
\`shared_preload_libraries=pg_stat_statements\` (already in the dev compose and
in the tests).

**D12. Provisional HS256 JWT** (superseded by D20). Milestone 1 uses HS256
with a shared secret (≥ 32 characters) behind the \`JwtVerifier\` trait.
Milestone 2 adds EdDSA + JWKS as the default, and HS256 stays as a simple mode.

**D13. Claim rules.** \`role\` is required and must be \`anon\`, \`authenticated\`
or \`service_role\`. \`authenticated\` requires a uuid \`sub\` (so \`auth.uid()\` never
fails the cast). \`aud\` is not verified yet (it joins the contract in Milestone
2). 30 s leeway on \`exp\`.

**D14. No token = \`anon\`; invalid token = 401.** An \`Authorization\` header
that is present but invalid (expired, wrong signature, scheme other than
\`Bearer\`, unknown role) never silently becomes \`anon\`.

**D15. 401 vs 403 on missing permission.** \`insufficient_privilege\` (42501)
becomes 401 for \`anon\` (needs to sign in) and 403 for the other roles, as in
PostgREST.

**D16. \`rsa\` ignored in \`cargo audit\`/\`cargo deny\` (RUSTSEC-2023-0071).** It
comes through \`jsonwebtoken\`'s \`rust_crypto\` backend. The Marvin Attack affects
operations with the RSA **private** key; Nelcota never signs with RSA. The
\`aws_lc_rs\` backend would avoid the dependency, but requires a C/CMake
toolchain in the build, which hurts the "simple static binary". Revisit if
RS256 is ever used for signing.

**D17. Libraries outside the prompt's table.**
- \`uuid\`: validates the \`sub\` claim and is Postgres' native type for ids.
- \`postgres-protocol\`: already a transitive dependency of \`tokio-postgres\`;
  used to compute the SCRAM verifier (D6).
- \`http-body-util\` (dev only): reads response bodies in tests.

**D18. Postgres without TLS on the internal network.** The database is only
reachable over Docker's internal network (or localhost in dev). TLS to the
database waits for a remote-database scenario.

**D19. Edition 2024, MSRV 1.88.** The current \`testcontainers-modules\` already
requires 1.88.

## Milestone 2

**D20. EdDSA (Ed25519) as the default; HS256 as legacy.** The private key comes
from \`NELCOTA_JWT_PRIVATE_KEY\` (PKCS#8 PEM or the one-line base64, which fits
in a \`.env\`). With an EdDSA key **and** an HS256 secret configured, the server
signs with EdDSA and accepts both when verifying (zero-downtime migration). The
\`kid\` is the RFC 7638 thumbprint.

**D21. Internal \`nelcota_auth\` role for the \`auth\` schema.** Auth handlers run
with \`SET LOCAL ROLE nelcota_auth\` (a fixed string). No JWT can assume it (the
\`Role\` enum does not contain it), and the API roles have no GRANT on \`auth.*\`.
Discarded alternative: \`SECURITY DEFINER\` functions, which would spread logic
into PL/pgSQL with no real gain.

**D22. 32-byte opaque refresh token, stored only as SHA-256.** SHA-256 (not
argon2) because the token already has 256 bits of entropy; lookup is through a
unique index, with no comparison in the application.

**D23. Reuse detection revokes the session (family), not the user.** Other
sessions stay valid. No grace window for now (documented).

**D24. Logout revokes the session; the access JWT is valid until \`exp\`.**
Access tokens are stateless and short (15 min by default). Checking revocation
on every request would cost an extra database round trip.

**D25. Argon2id with RustCrypto's default parameters (m=19 MiB, t=2, p=1).**
Runs in \`spawn_blocking\`, with at most \`min(cores, 4)\` concurrent hashes (peak
< 80 MiB). Logging in with an unknown email verifies against a dummy hash, so
the response time does not reveal whether the account exists.

**D26. In-memory rate limit, fixed 1-minute window** (the window became a GCRA in D69), per IP (signup/token)
and per email (login). One binary per install makes Redis unnecessary. The IP
comes from \`X-Forwarded-For\` (rightmost entry) only with
\`NELCOTA_TRUST_PROXY=true\`.

**D27. Signing up with a duplicate email answers 409.** Without email
confirmation in the MVP, hiding the account's existence at signup would bring
no real protection (login still does not reveal it).

**D28. New libraries.** \`argon2\` (it was in the table); \`sha2\`, \`base64\` and
\`getrandom\` were already transitive dependencies (\`jsonwebtoken\`/RustCrypto)
and are used directly at the same versions, without growing the tree. The ISC
license is allowed in \`cargo deny\` (it comes from \`simple_asn1\`, used to read
PEM).

## Milestone 3

**D29. Dynamic SQL with our own builder, no \`sea-query\`.** Every URL value
becomes a **text** parameter, and Postgres converts it to the column type
(\`$1::text::<catalog type>\`); inserts and updates use
\`json_populate_recordset\`/\`json_populate_record\`, and RPC uses \`json_to_record\`.
That way Postgres validates types as it would a literal, and the application
does not need to map types. \`sea-query\` binds each value to a Rust type (and
\`sea-query-postgres\` would require that mapping), besides not expressing these
patterns well. The builder is ~400 lines with three auditable rules:
identifiers only from the catalog and always quoted; cast types only from the
catalog; values always parameters. Unit and integration tests cover injection
on both sides.

**D30. OpenAPI built with \`serde_json\`, no \`utoipa\`.** \`utoipa\` generates the
specification at compile time from Rust types; ours comes from the catalog at
run time. The document is filtered by the request role's privileges (like
PostgREST's \`follow-privileges\` mode).

**D31. Catalog reload through an event trigger + \`LISTEN nelcota\`.** The
trigger runs on \`ddl_command_end\` and \`sql_drop\` (including GRANT/REVOKE). The
listener batches bursts (100 ms), reconnects with backoff and reloads on every
reconnect. Without a superuser, the migration proceeds without the trigger and
reloading is manual (\`NOTIFY\`).

**D32. PATCH/DELETE require a filter.** Unlike PostgREST (which allows it and
lets RLS limit it), we refuse with 400. The cost is an explicit filter when
the intent really is to hit everything.

**D33. Batches with different keys respect DEFAULT.** Rows are grouped by
column set and each group becomes an INSERT (CTEs in one statement). In
PostgREST, without \`Prefer: missing=default\`, missing columns become NULL; we
find DEFAULT the least surprising behaviour.

**D34. \`statement_timeout\` on the \`authenticator\` role.** \`ALTER ROLE anon SET
...\` has no effect with \`SET ROLE\` (Postgres only applies a role's settings at
login). Bootstrap applies \`NELCOTA_STATEMENT_TIMEOUT_SECS\` (default 10 s) to
\`authenticator\`, and the error becomes 504.

**D35. Postgres' default kept for \`EXECUTE\` on functions (PUBLIC).** Changing
the default privileges would hide plain Postgres behaviour; the documentation
and the panel warn about it.

**D36. New libraries.** \`form_urlencoded\`, \`futures-util\` and \`bytes\` were
already transitive dependencies (axum/tokio-postgres); tower-http's
\`compression-gzip\` adds \`flate2\`.

## Milestone 4

**D37. One binary, two roles.** \`nelcota\` without arguments (or \`serve\`)
starts the server; the subcommands operate the install. On a host,
\`migrate\`/\`types\`/\`token\` are forwarded to the \`app\` container (\`docker compose
exec\`), which is what can reach Postgres on an \`internal: true\` network; with
\`NELCOTA_DATABASE_URL\` in the environment, they run directly.

**D38. Postgres profiles become \`-c key=value\` in the compose file.** The
\`deploy/postgres/profiles/*.conf\` files are the source; \`init\` turns them into
arguments of the \`postgres\` command. Using \`config_file\` would replace the
image's whole \`postgresql.conf\` (and change the default \`pg_hba.conf\`
directory).

**D39. Backups with \`pg_dump -Fc\`; S3 uploads with the \`amazon/aws-cli\`
image.** Nothing to install on the host and no home-grown S3 signing (SigV4).
Restore in a single transaction (\`--single-transaction --exit-on-error\`). PITR
with WAL-G is pending (daily dumps: an RPO of up to 24 h).

**D40. Upgrade with rollback = previous image + restore of the pre-upgrade
backup.** The new version may have applied internal migrations the previous
one does not know (refinery refuses to start with an "unknown" migration).
That is why the rollback also restores the database and the matching disk-file
snapshot. The proxy stays in maintenance from before the old app stops until
the upgraded or restored app is healthy, so successful public writes cannot
be lost between capture and rollback. Failure-path tests cover this sequencing.

**D41. \`scratch\` image with a musl binary; built-in healthcheck.** No shell or
curl in the image: \`nelcota healthcheck\` performs \`GET /health\` over plain TCP.

**D42. User migrations in refinery's format (\`V<n>__<name>.sql\`)**, in
\`nelcota.user_migrations\`, separate from the internal ones
(\`nelcota.schema_migrations\`). CRLF is normalized before the checksum (a
Windows checkout does not diverge).

**D43. \`install.sh\` installs Docker with the official script if it is
missing** (as root and without \`NELCOTA_SKIP_DOCKER=1\`): that is what makes
the "3 commands" possible on a fresh VPS. The binary's SHA-256 checksum is
always verified.

**D44. \`init\` does not enable the firewall without \`--firewall\`.** Enabling
\`ufw\` remotely with the wrong SSH port locks the owner out of the machine. By
default it only recommends it.

## Milestone 5

**D45. Panel with server-side HTML + ~2 KB of our own JS, no HTMX**
(superseded by D50). Pages are ordinary forms; the only interactive part (the
SQL editor) fits in a few lines of \`fetch\`. CSP \`script-src 'self'\` without
\`unsafe-inline\`. Assets embedded with \`rust-embed\`.

**D46. Panel login separate from end users.** Email + argon2id hash in the
\`.env\` (generated by \`init\`; the password is shown once). In-memory sessions
(restarting the server signs the admin out), \`HttpOnly; SameSite=Strict\`
cookie (\`Secure\` behind the proxy), login rate limit and an
\`Origin\`/\`Sec-Fetch-Site\` check on every POST (CSRF).

**D47. The panel uses the admin connection.** The admin owns the database, as
in \`psql\`. Table writes reuse the API's SQL builder (catalog identifiers,
parameterized values). The SQL editor opens a **new** connection per run:
\`BEGIN\` without \`COMMIT\` or \`SET ROLE\` do not contaminate the pool. The SQL
text does not go to the log.

**D48. Panel values keep Postgres' text** (\`RawValue\`), without going through
\`f64\`: \`numeric(30,10)\` shows and is edited with every digit.

## Panel design

**D49 (superseded by D50).** A panel with a database-console look (dark by
default, emerald accent), inspired by Supabase but with its own name, brand
and icons. Inter + JetBrains Mono typography, embedded in the binary (~88 KB,
OFL, see \`crates/admin/assets/FONTS.md\`): no Google Fonts, to keep the CSP at
\`'self'\` and work offline. Light mode via \`prefers-color-scheme\`. Hand-drawn
SVG icons (no icon package). On the overview, the row count is exact for
tables under 10 thousand estimated rows and uses the planner's estimate (\`≈\`)
for large ones.

## Panel in Svelte

**D50. Panel in Svelte 5 + shadcn-svelte + Tailwind v4 + CodeMirror 6**,
built with Vite (the maintainer's choice, 2026-10-06). The goal is the
interactivity server-side HTML did not deliver well: inline editing in the
grid, side sheets, multiple selection, column sorting, a SQL editor with
syntax highlighting and autocomplete for the database's tables and columns. An
SPA with Vite, **no SvelteKit**: it injects inline script into the page, which
would break the CSP \`script-src 'self'\`. Our own routing (~60 lines, history
API).

**D51. The build (\`crates/admin/ui/dist\`) is versioned in git** and embedded
with \`rust-embed\`. That way \`cargo build\`, \`cargo install\` and the Dockerfile
still need no Node: only whoever works on the panel needs Node. CI's
\`admin-ui\` job runs \`npm ci\`, \`npm audit\`, \`svelte-check\`, \`vite build\` and
fails if the versioned \`dist\` is out of date.

**D52. CSP: \`style-src\` now accepts \`'unsafe-inline'\`; \`script-src\` stays at
\`'self'\` only.** Svelte transitions, CodeMirror and menu positioning
(floating-ui) inject styles at run time. Inline style runs no code; inline
scripts remain forbidden (there is a test).

**D53. The panel becomes a JSON API at \`/admin/api/*\`.** Same session, same
origin check (CSRF) and the same SQL builder as the REST API. Values travel as
Postgres' exact text (\`RawValue\`). Batch deletes in a single transaction. The
SPA is served at any \`/admin/*\` (fallback to \`index.html\`). Hashed assets get
immutable caching; \`index.html\`, \`no-cache\`.

**D54. CodeMirror loaded on demand.** The main bundle stays around 130 KB
gzip; the SQL editor (~145 KB gzip) is only downloaded when its page opens.
The Inter and JetBrains Mono fonts come from \`@fontsource-variable\` (OFL),
served by the binary itself.

**D55. A panel without ornaments.** Removed the generic template patterns:
stat cards with icons, gradients, a glowing login, a logo in a colored square,
pills and dots on every status, avatars with initials, skeletons, colored
toasts, an icon before every title, subtitles explaining the obvious and the
"Postgres 17" pill (which was hardcoded, not read from the database).
Criterion: color only for problems (no RLS, RLS without policies, error,
destructive action); short texts. Inter/JetBrains Mono swapped for IBM Plex
Sans/Mono, less ubiquitous and with the feel of a technical tool. Security
warnings stay, as plain text.

## Several projects per host

**D56. One host, N isolated projects.** A shared Caddy (the only one to
publish 80/443) and, per project, an app and a Postgres on an exclusive
internal network. A single project is a host with one project: there are not
two models to maintain. The registry (\`nelcota-host.json\`) is the source of
truth; the Caddyfile and the public list (\`shared/projects.json\`) are
generated from it.

**D57. One Postgres per project.** Postgres roles apply to the whole server;
in a shared Postgres, projects would share \`anon\`, \`authenticated\`,
\`service_role\` and the \`authenticator\` password. The cost (~50 MB of RAM per
project) buys physical isolation, per-project backup/restore and leaving, and
independent upgrades.

**D58. Own domain or a subdomain of the base domain.** \`init api.shop.com\`
derives the name "shop"; \`init --project blog\` uses \`blog.<base-domain>\`.
Locally: \`<project>.localhost\` (browsers resolve \`*.localhost\` to the
machine).

**D59. Single sign-on through an SSO handoff, with a per-project login
option.** Cookies do not cross domains, so the origin panel issues an HS256
JWT (host's shared secret, \`aud\` = target project, 60 s, single-use \`jti\`)
that travels in the URL fragment and is traded for a session at the target.
In per-project mode there is no shared secret and the handoff does not exist.
Only \`panel_login.rs\` writes admin credentials into the \`.env\` files;
switching modes regenerates and restarts the apps.

**D60. The project list is mounted as a folder and reread on every request.**
The app receives \`shared/\` read-only (a folder bind, not a file bind, so the
CLI's atomic rename is visible). New projects show up in the switcher without
restarting anyone. Each project's state comes from \`GET /health\` over the
\`nelcota_edge\` network, which now includes the version.

**D61. Removal always with a final backup** in \`archive/\` before deleting
containers and volumes; the site leaves Caddy with \`caddy reload\` (without
taking the others down).

## Identity and account in the panel

**D62. The mascot is the panel's identity, the only exception to D55.** It
comes from the NelcotaScreenShare atlas (\`src/assets/mascot/\`), cropped with
the poses anchored at the feet and right arm so the figure does not jump when
the expression changes. It is not decoration because it reacts to the login
screen's state: it waves on open, follows the pointer with its eyes, closes
its eyes while the password is typed and looks sad after a refused login. The
eyes are a vector layer over the PNG's (only the pupil moves); with
\`prefers-reduced-motion\` the gaze jumps straight to the target.

**D63. Full-height sidebar.** Project at the top (same height and border as
the topbar), pages in the middle, account at the bottom; the topbar covers
only the content area. Pinned, it takes 240px from \`xl\` up; collapsed, it
becomes an icon rail that expands over the content. "Projects" left the menu:
the project switcher already leads there.

**D64. The admin photo lives in the project's database, in the \`nelcota\`
schema** (migration V4, \`nelcota.admin_avatar\`). The admin login only exists
in environment variables, so there was nowhere to keep data about them; the
internal schema has no USAGE for any API role. The photo is per project (each
one has its own Postgres). The browser center-crops and scales it to 256px in
WebP; the server only accepts PNG, JPEG or WebP recognized by their leading
bytes, up to 256 KB. The URL carries the version (\`?v=\`), so the image can be
cached.

**D65. \`nelcota-core\` recompiles when \`migrations/\` changes.**
\`embed_migrations!\` reads the folder without telling the compiler; a
\`build.rs\` with \`rerun-if-changed\` avoids incremental builds with the old
list.

**D66. Password recovery by email, with the project's SMTP.** Nelcota runs no
mail server: \`NELCOTA_SMTP_URL\`, \`NELCOTA_SMTP_FROM\` and
\`NELCOTA_PASSWORD_RECOVERY_URL\` (all three or none; half-configured, the
server does not start). The link goes to the app's page with the token in the
fragment; tokens live in \`auth.one_time_tokens\` (migration V5) only as
SHA-256, are valid for 1 hour and once, with at most one email per minute per
account. Sending happens in the background so the response time does not
reveal whether the account exists. Using the link changes the password, ends
the sessions and marks the email as confirmed. Sent with \`lettre\` over rustls
+ ring, with Mozilla's roots embedded (\`webpki-roots\`): the \`scratch\` image has
no system certificates and the musl build stays free of OpenSSL. This brought
two permissive licenses into \`deny.toml\`: CDLA-Permissive-2.0 (the root list,
which is data) and 0BSD (\`quoted_printable\`).

**D67. Panel DDL becomes a migration, registered as already applied.** Every
DDL the panel applies goes through \`apply.rs\` and is recorded in
\`nelcota.panel_changes\` (migration V6), in the same transaction. "Generate
migration" bundles the pending ones into a file and inserts the matching row
into \`nelcota.user_migrations\` with refinery's checksum
(\`Migration::unapplied(..).checksum()\`): \`migrate\` does not reapply the file
and, with \`abort_divergent\`, refuses an edited copy. The generated text is
stored (\`nelcota.panel_migrations\`) so it downloads again byte for byte. The
version goes past the highest number in the database, in the folder and among
earlier exports; the folder comes from \`NELCOTA_MIGRATIONS_DIR\` or from the
\`/migrations\` mount in the container. The SQL editor is left out: it can run
anything, including DML, and separating schema changes would require parsing
the SQL.

**D68. English codebase, translated panel.** Code, identifiers, comments,
tests, server messages (REST, auth and admin API errors), CLI output, the
recovery email, the README and these docs are English. Only the panel
interface is translated: Portuguese (pt-BR) and English, through typed
per-area catalogs (\`crates/admin/ui/src/lib/i18n/messages\`) where the English
object is typed against the Portuguese one, so a missing key fails the type
check. The panel picks the browser language on the first visit and remembers
the choice made in the account menu. Admin API errors carry \`code\` and
\`params\` (\`{"error", "code", "params"}\`), so the panel shows them in the
chosen language and falls back to the server's English text (raw Postgres
errors, for instance). Migrations V1–V6 keep their Portuguese file names and
comments: refinery checksums name and content, and editing them would make
every existing install refuse to start.

**D69. Libraries instead of four hand-written pieces.** A review of what
the code reimplemented kept the deliberate ones (the SQL builder of D29, the
OpenAPI of D30, the PostgREST-style parser, TypeScript generation, CSV,
secret generation, image sniffing) and replaced four:
- **Rate limit:** \`governor\`'s keyed GCRA instead of a fixed window. The budget
  refills continuously, so a client can no longer spend almost twice the limit
  across the turn of a minute, and \`Retry-After\` is the real wait. Still in
  memory per process; only the \`std\` and \`dashmap\` features.
- **Session cookie:** the \`cookie\` crate parses the \`Cookie\` header and builds
  \`Set-Cookie\` in one place, instead of \`split(';')\` and \`format!\`. No signing
  or encryption features: the value is an opaque token.
- **Health probe:** \`hyper-util\`'s client instead of a hand-written HTTP/1.1
  request and response split; a chunked body no longer breaks it. hyper was
  already in the tree through axum.
- **Identifier quoting:** \`postgres_protocol::escape::escape_identifier\`, already
  a dependency. String literals in generated DDL keep the hand-written \`''\`
  doubling: \`escape_literal\` would emit \` E'...'\` for backslashes and change the
  text of panel-generated migrations.

**D70. \`or=\`/\`and=\` as PostgREST logic trees.** The request's filters are
a tree (\`Condition\`): leaves are the existing filters and groups join their
items with OR/AND, optionally negated; the top level stays ANDed, so existing
URLs mean the same. Each group renders as a parenthesized expression, so
precedence never depends on its surroundings, and leaves keep the D29 rules
(catalog columns, quoted identifiers, values as parameters). Depth is capped at
8 and a tree at 100 filters, which bounds the recursive parser on hostile
input. As in PostgREST, \`or\`/\`and\` are reserved query keys.

**D71. Upsert through \`Prefer: resolution\` and \`on_conflict\`, as in
PostgREST.** Each INSERT group (D33) gets \`ON CONFLICT (key)\`: \`DO UPDATE SET\`
for the columns the object sent, except the key, or \`DO NOTHING\`; a merge with
nothing left to update falls back to \`DO NOTHING\`. The key is the primary key
or \`on_conflict\`, whose columns are checked against the catalog; whether they
form a unique key is left to Postgres, and its \`42P10\` and \`21000\` errors now
map to 400 instead of 500. RLS needs no special handling: Postgres applies the
INSERT policy to the new row and the UPDATE policy to the existing one.

**D72. Relation embedding through foreign keys, one level, as correlated
subqueries.** \`select=\` accepts \`[alias:]table[!hint](columns)\`. The relation
comes only from the catalog's foreign keys inside the exposed schema, in
either direction: this table's key gives an object (\`to_json\` of a subquery
that matches at most one row, since the key references a unique one), the
other table's key gives an array (\`json_agg\`). Each embed is a subquery in the
select list, so it runs in the same transaction with the request's role and
the related table's RLS filters it like a direct read; there is no separate
permission logic. Ambiguous links ask for a hint (column or constraint name);
nesting and self-references are refused for now. The panel's parser keeps
refusing embeds (\`parse_request\`), the API uses
\`parse_request_with_relations\`.

**D73. Nested embeds and per-embed filters, as in PostgREST.** An embed's
column list is a full \`select\`, so embeds nest, at most 4 levels (each level
is one more correlated subquery per parent row; the cap bounds what a single
URL can stack). Parameters prefixed with an embed's key (\`items.qty=gt.1\`,
\`orders.items.order=...\`) go to that embed: filters and \`or\`/\`and\` trees join
the foreign key in the subquery's \`WHERE\`, and \`order\`/\`limit\`/\`offset\` page
the embedded array (refused on a single-row embed). They narrow the embedded
rows only; the parent rows stay, with \`null\` or \`[]\`. \`select\` is parsed first,
so the parameter order in the URL does not matter. Filters now carry their
column type, so the same SQL builder serves any row alias. Nested subqueries
are aliased by their path (\`_e0_1\`) so a child never shadows its parent.
Self-references stay refused, and filtering parents by their embeds
(PostgREST's \`!inner\`) is not implemented.

**D74. PITR with pgBackRest, inside the project's Postgres container.**
pgBackRest instead of WAL-G: Alpine packages it (2.58), so the image stays
\`postgres:17-alpine\` plus one \`apk add\`. WAL-G only ships glibc binaries, and
moving to a Debian image would change the libc and with it text collation,
silently invalidating the indexes of existing projects. The image is built
locally from \`postgres/Dockerfile\` (no second image to publish). Settings
travel as \`PGBACKREST_*\` variables from \`pgbackrest.env\` (mode 600) through
\`env_file\` with \`required: false\`, so no config file has to be readable by the
container's postgres user and "PITR on" is just that file existing; archiving
itself is \`ALTER SYSTEM\` (archive_mode, archive_command, \`archive_timeout =
60s\`), which the profile's \`-c\` flags do not touch. Postgres gets a
per-project \`egress\` network: the \`internal\` one has no route out, and nothing
can connect in through either. Base backups ride on the existing daily
\`backup --all\` (full on Sundays, differential otherwise, two fulls kept). A
restore recreates the Postgres container, so its restart count tells a failed
recovery (a target past the archive makes Postgres exit) apart, and ends with
a full backup: the new timeline forks before any later backup on the old one,
which pgBackRest would otherwise refuse to restore from.

**D75. Hosts without Docker: one project, systemd units, apt packages.**
\`init --runtime systemd\` (Debian/Ubuntu, as root) gets Postgres 17 and
pgBackRest from PGDG and Caddy from its repository: the versions match the
Docker hosts and security updates come with \`apt upgrade\`. One project per
machine: N isolated projects would mean N clusters on N ports and N system
users, and that isolation is what Docker already gives. The runtime lives in
the registry (\`"runtime"\`, Docker when absent), and every operation goes
through \`Project\`, which turns "start the app", "run this as postgres",
"is Postgres healthy" into \`docker compose\` or \`systemctl\`/\`runuser\`/
\`journalctl\`; \`ops\` and \`pitr\` no longer know which. The app runs a copy of
the binary (\`/usr/local/lib/nelcota/nelcota\`) so \`upgrade\` can swap it and
keep the previous one for the rollback, in a unit with \`DynamicUser\`,
\`ProtectSystem=strict\`, no capabilities and only the loopback port. Commands
that need the app's configuration (\`migrate\`, \`types\`, \`token\`) run this
binary as a child process with the project's \`.env\`, rather than setting
variables in the CLI's own process. pgBackRest reads the same settings as on
Docker, written as \`/etc/pgbackrest/pgbackrest.conf\` (archive_command runs
under the Postgres unit, which does not get the \`.env\`).

**D76. The image is \`ghcr.io/nelcota/nelcota-server\`.** The name that
matches the repository, \`ghcr.io/hanielcota/nelcota\`, is a package from an
earlier project (now NelcotaScreenShare) whose production still pulls its
\`latest\` tag. Pushing there would overwrite that tag, and deleting it would
break that deploy, so this project publishes under another name. The release
image is the released musl binaries copied into \`scratch\`
(\`deploy/release.Dockerfile\`), linked to this repository by the
\`org.opencontainers.image.source\` label.

## Storage

**D77. Metadata in Postgres under RLS, bytes in an object store.** A
\`storage\` schema holds \`storage.buckets\` and \`storage.objects\` (bucket, name,
owner \`DEFAULT auth.uid()\`, size, type, etag). Who may read, write or delete
a file is decided by RLS policies on \`storage.objects\`, written in plain SQL
like any other policy; the server never decides it. The bytes live behind the
\`object_store\` crate (Apache Arrow) with two backends: the local disk (the
default, nothing to configure after \`nelcota up\`) and any S3-compatible
service (recommended for production: R2, B2, AWS...). \`object_store\` is used
with \`aws-base\` + \`ring\`, never \`aws-lc-rs\`, for the same reason as D16. No
bundled object server: Garage on a single node keeps the files on the same
disk as a plain directory would, for one more service to run, and MinIO's
community edition went into maintenance mode in 2025. The routes follow the
shape of Supabase Storage (\`/storage/v1/object/{bucket}/{path}\`), without
promising compatibility with its client; the route words (\`public\`, \`sign\`,
\`list\`) cannot be bucket names.

**D78. Uploads stream through the server; keys are versioned.** The client
sends the file to Nelcota, which streams it to the store: one endpoint, the
usual \`Bearer\`, no CORS on a second origin, and size, type and quota checked
in the same flow. Before taking the bytes, a rolled-back \`INSERT\` under the
caller's role checks the policy, so a caller without permission cannot fill
the disk. The bytes go to \`{bucket}/{version}\` (a UUIDv7), not to the
object's name; only after the upload completes does a short transaction
insert or update the row under RLS. Holding no connection while bytes flow
keeps slow clients from draining the pool; versioned keys make an overwrite
atomic (readers see the old file or the new one, never half) and keep a
failed upload from clobbering anything. Deleting or replacing a file removes
the old bytes right after the commit: a delete means the file is gone, which
also means a database restore does not bring deleted files back. A periodic
collector removes bytes no row points to (left by a crash mid-upload) once
they are a day old, so it never races an upload in flight. A plain upload
needs only an \`INSERT\` policy; overwriting and deleting also need \`SELECT\`,
as \`UPDATE\`/\`DELETE\` with a \`WHERE\` do in Postgres. Storage routes run
outside the request timeout and the gzip layer.

**D79. User files are served as inert content.** Every object response
carries \`X-Content-Type-Options: nosniff\` and \`Content-Security-Policy:
sandbox\`; only raster images, audio, video and plain text are served
\`inline\`, everything else (HTML, SVG, PDF...) as an \`attachment\`. The type is
sniffed from the first bytes, not taken from the client. Paths reject \`..\`,
empty segments, control characters and over-long names, and are normalized
to Unicode NFC. Signed URLs are short-lived JWTs signed with the project's
keys and bound to one bucket and path. On the S3 backend a download is a
\`302\` to a presigned URL on the provider's domain; on disk the server
streams it with \`Range\` and \`ETag\`. \`NELCOTA_STORAGE_PUBLIC_URL\` can move
public files to their own origin (e.g. \`files.shop.com\`).

**D80. Storage cannot take the database down.** On a single VPS the files and
Postgres share a disk. Every upload has a size cap (per bucket, and a global
\`NELCOTA_STORAGE_MAX_FILE_SIZE\`, 50 MiB by default); an optional total quota
covers all buckets; and on the disk backend an upload is refused when free
space would fall under \`NELCOTA_STORAGE_MIN_FREE_BYTES\` (1 GiB by default).
In-flight uploads reserve their capacity, and publication checks the resulting
total under a database transaction lock across instances. Replacements credit
their old logical size while reserving disk space for the new version.
Per-user quotas are left to policies, which see the final row (with its
size) on insert. Image transformations and resumable (TUS) uploads stay out:
decoding untrusted images is a steady source of CVEs.

**D81. New projects store files on their disk; backups mirror them**
(the shared backup mirror is superseded by D82).
\`nelcota init\` writes \`NELCOTA_STORAGE_BACKEND=disk\`: on Docker the app
mounts \`projects/<name>/storage\` (owned by the image's user 65532), on
systemd the unit's \`StateDirectory\`. Storage works right after \`nelcota up\`,
and moving to S3 is two lines in \`.env\`. A file on the same disk as the
database is lost with it, so \`backup --upload\` also runs \`aws s3 sync
--delete\` of that directory to \`<bucket>/<project>/storage/\`: keys never
change once written (D78), so each run only sends new files, and
\`restore --files\` brings them back. Caddy stops compressing \`/storage/*\`,
which would break byte ranges. Projects created before storage keep it off
until they add the two lines and the volume (docs/storage.md).

## Panel and backup reliability

**D82. Disk backups capture immutable files beside each dump.** A shared
mirror loses old versions when later uploads replace or delete them, so it
cannot restore the files referenced by a historical database dump. Each dump
now has its own \`.files/\` directory and SHA-256 manifest. An exported Postgres
snapshot and a SHARE lock on \`storage.objects\` keep the copied versions and
dump metadata consistent. Upload files before publishing the dump; retain and
archive the pair together. Restore validates the manifest before stopping the
app and copies immutable versions before restoring the database. Older dumps
remain usable for database-only restores (docs/backup.md).

**D83. The panel validates wire contracts generated from Rust.** \`ts-rs\` and
\`schemars\` export TypeScript and JSON Schema from the server DTOs; Ajv emits
standalone browser validators so the existing CSP needs no runtime code
generation. Drift checks run in CI. Database cell values stay text or NULL
(D48). Resource state and upload queues own cancellation, result ordering and
the captured upload destination, with unit and browser regression tests.

**D84. SQL display limits bound memory without changing batch semantics.**
Dedicated editor connections (D47) allow at most four runs with a 30-second
statement timeout. The client retains up to 1000 rows per result, 8 MiB of
values and 32 displayed results, while the server drains the remaining batch
so later statements still execute. Dropping a request sends Postgres
cancellation and closes its connection. DDL reports \`applied\` separately from
\`catalog_pending\`: a failed refresh after COMMIT retries with backoff instead
of asking the user to replay an already committed mutation.

**D85. Modules follow independent reasons for change.** Authentication shares
session/token operations and auth-role transactions independently of its HTTP
handlers. Panel route composition does not own cookies, response headers or
asset serving. Storage operations accept a byte stream and explicit options
and return typed results; the public routes and panel share the HTTP adapter.
CLI lifecycle, backup sequencing, remote transport and version upgrades have
separate owners. The table editor's row module owns loading and write
reconciliation while the page owns navigation and presentation. Existing
transaction, RLS and snapshot guarantees remain coordinated inside their
operation modules (docs/architecture.md).

**D86. Operation interfaces own complete lifetimes.** Recovery and migration
workflows return data without HTTP extraction or response construction. Their
atomic database changes stay under one transaction owner. The SQL executor
owns its connection, cancellation and display budgets behind one execution
method; the route chooses the HTTP response. REST execution returns the JSON
already built by PostgreSQL and response metadata, preserving RLS and error
ordering. Catalog model, introspection and refresh workers remain internal to
the existing facade. Panel SQL and storage modules accept transport adapters
and own cancellation, captured destinations and mutation refreshes. Native
provisioning and PITR configuration/process adapters are separate from restore
sequencing, with no new deployment runtime or command contract.

**D87. Feature ownership determines source location.** Panel pages, state,
adapters, components and unit tests live with their feature. The shell and
shared schema/presentation helpers have named locations; generated wire
contracts remain authoritative. Admin backend facades group table, policy and
account handlers and explicitly export their interface. Integration tests
share panel request helpers and keep feature scenarios under one admin suite.
This changes source navigation without introducing another runtime, crate
layer, HTTP contract or transaction owner (docs/architecture.md).

**D88. Facades expose complete operations in the modular monolith.** The
existing capability crates and single binary remain the architecture. Bucket
reads and mutations now have one storage owner shared by the public API and
panel, with typed records and errors. HTTP adapters keep their existing wire
contracts and input normalization; PostgreSQL still enforces privileges, RLS
and nonempty-bucket deletion through its foreign key. Panel account operations
own validation, SQL and password/session transactions independently of HTTP.
Reuse the existing disk/S3 and mail adapters where implementations vary; add no
generic repository, dependency container or extra crate layer. Integration
tests exercise bucket policies through the operation interface and prove that
a failed session revocation rolls back the password change.

## Email links

**D89. Signup confirmation and magic links reuse the recovery link.** Two
optional pages, \`NELCOTA_EMAIL_CONFIRMATION_URL\` and \`NELCOTA_MAGIC_LINK_URL\`,
need the D66 SMTP and turn on one flow each; without them nothing changes.
Their tokens share \`auth.one_time_tokens\` (V9 widens the \`kind\` CHECK to
\`signup\` and \`magiclink\`), the token in the URL fragment, the one email per
minute per account and kind, and background sending. A token only works as
the kind it was issued for. With confirmation on, signup answers \`201 {user}\`
without a session, and password sign-in answers \`400 email_not_confirmed\`
(only after a correct password, so it reveals nothing) until a signup, magic
or recovery link is opened; \`POST /auth/v1/resend {type: "signup"}\` sends a
new link to unconfirmed accounts only. Turning confirmation on in a project
with unconfirmed accounts holds them too: they confirm through \`resend\` or a
magic link, or the operator runs \`UPDATE auth.users SET email_confirmed_at =
now()\`. A magic link only signs in existing accounts: creating accounts from
an unauthenticated email request would let anyone fill \`auth.users\` and
squat addresses before their owners sign up. Lifetimes: recovery 1 hour,
confirmation 24 hours, magic link 15 minutes (it signs in by itself). The
\`links\` module owns the link lifecycle (token storage, email text, sending,
sign-in by link); \`recovery\` keeps only the password change, \`confirmation\`
the signup policy and \`verify\` the routing by \`type\`.

**D90. Panel accounts count as confirmed.** An account the administrator
creates is marked confirmed at once: the operator vouches for the address,
and with signup confirmation on it would otherwise be held until a magic
link or \`resend\`. The users page marks unconfirmed accounts and offers
"Confirm email" for them (\`POST /admin/api/users/{id}/confirm\`, idempotent),
which replaces the SQL \`UPDATE\` of D89 for projects that turn confirmation
on with older accounts. It sends no email: the panel has no mailer and an
invitation flow is a separate decision.

## Sign-in providers

**D91. OAuth/OIDC sign-in with PKCE on both legs, and verified-email
linking.** Google (OpenID Connect userinfo) and GitHub (REST profile plus its
email list, the only place that says an address is verified) sit behind one
\`Provider\` type, each in its own module; another provider is another module.
The app starts at \`GET /auth/v1/authorize\` with its own S256 challenge;
Nelcota keeps the sign-in in \`auth.flow_states\` (V10) with a separate PKCE
verifier toward the provider, redeems the provider's code server to server,
and sends the person to \`redirect_to?code=...\`. The app trades that code and
its verifier for a session at \`POST /auth/v1/token?grant_type=pkce\`, so a code
read from a URL, a log or a \`Referer\` is useless alone; a code is tried once.
\`redirect_to\` must sit under one of \`NELCOTA_OAUTH_REDIRECT_URLS\` (same origin,
path below), so \`/authorize\` is no open redirect; the callback is
\`NELCOTA_API_URL/auth/v1/callback\`. A provider account is identified by its
own id (\`auth.identities\`, unique per provider), never by email. A first
sign-in links an existing account only when the provider verified the email:
a confirmed account is linked as is; an unconfirmed one is taken over by the
verified owner, losing the password, sessions and links someone else may have
set up with the address (the pre-registration takeover); an unverified email
that matches an account is refused (\`email_conflict\`). New accounts get no
password and are confirmed when the provider verified the email. Refusals and
provider errors go back to the app as \`?error=<code>\`, and an unknown \`state\`
is an error page, since there is no trusted place to return to. The HTTPS
client is the \`reqwest\` already in the tree for S3, on rustls with \`ring\`
(D16), with a 10 s timeout, no redirects and bounded response bodies.

## Panel

**D92. Code gets syntax colours, the second exception to D55.** The SQL
editor colours keywords, function calls, types, strings, numbers and
comments; table and column names keep the text colour. Colour there carries
meaning (it is how people read code) rather than decorating the page. The
palette follows GitHub's light and dark syntax themes, a tested and
readable reference, as \`--syntax-*\` tokens next to the other theme colours.
The SQL grammar does not mark function calls, so a small view plugin tints an
identifier right before \`(\` and a built-in keyword glued to it (\`count(\`),
but not keywords that open a clause or a list (\`in (\`, \`exists(\`). Only the
lazily loaded editor changes (D54); read-only SQL blocks stay plain.

**D93. Plain language first, technical on demand; the overview guides.**
Access rules read as what they mean for the app's users: a table is
Protected, Locked (protection on, no rules) or Unprotected; grants become
"Read only" or "Read and write" for Visitors and Signed-in users; a policy is
a sentence ("Each user only sees and changes their own rows") when it matches
a known shape (public or signed-in reading, owner by \`auth.uid()\`), and
"Custom rule" with its SQL in view otherwise. A "Technical details" toggle,
remembered per browser, brings back RLS, roles, grants and SQL. The overview
opens with what needs action (unprotected and locked tables, each linked to
its policies) and a next-steps list that is only ever ticked by the project's
state: a first table, every API table protected, a user, and a first sign-in
through the API (\`signed_in_users\`), which means an app is connected. Counts
shrink to one line. Navigation and the accent colour stay (D55, D63).

**D94. The SQL editor can run as a visitor or a signed-in user.** By default
it still runs as the database owner, without RLS, which the toolbar shows as an
amber "Full access" notice. The notice is also the picker: "Visitor" runs as
\`anon\`, and "Signed-in user..." runs as \`authenticated\` with the claims of a
real account chosen by email (\`sub\`, \`email\`), so \`auth.uid()\`, \`auth.jwt()\`,
grants and policies behave as they do for that person through the API. The
editor's connection is dedicated to one run, so the executor sets the role and
\`request.jwt.claims\` for the session before the SQL, as the API does per
request. It is a way to test rules, not a security boundary: the administrator
can always run anything as the owner, and the SQL may even \`RESET ROLE\`. The
choice is not persisted, so a reload goes back to the owner.

## Client SDK

**D95. Nelcota ships its own TypeScript client, a thin layer over HTTP.**
\`@nelcota/client\` lives in \`sdk/typescript/\` so its contract tests run in the
same CI against the real binary; it borrows no third-party BaaS client.
Every method is one HTTP request with no hidden cache, and access stays with
RLS: the client never decides permissions. It has no runtime dependencies
(only \`fetch\`, \`URL\`, Web Crypto, \`AbortSignal\`, Web Locks and
\`BroadcastChannel\`), so it runs in browsers, Node 22+, Deno, Bun and edge
runtimes, is ESM with subpath exports and side-effect free, and keeps the
supply chain to the TypeScript compiler. Results are values (\`{ data, error }\`)
carrying the server's \`code\` untouched; only programming mistakes throw.
Untrusted input never becomes syntax: identifiers are validated, values in
\`or\`/\`and\` groups and \`in\` lists are always quoted, storage paths are encoded
per segment with \`..\` refused, and a \`service_role\` token in a browser is
refused because it bypasses RLS. Refresh is single-flight in a process and,
in browsers, serialized across tabs with a Web Lock, because refresh rotation
ends a session whose token is reused (D23). Retries only cover idempotent
requests on 429/503 and honour \`Retry-After\`. Types come from
\`nelcota types\`, which now also emits each table's \`Relationships\` so a
\`select\` string can be typed down to its embeds. The server exposes
\`Retry-After\`, \`Preference-Applied\` and \`Last-Modified\` through CORS so a
browser can read them. The SDK follows its own semver and states the minimum
server version it needs.

## Tooling

**D96. Tooling follows the newest stable releases.** The MSRV moves from
1.88 (D19) to 1.99, the stable toolchain CI, the Docker image and the
release build already use, so \`cargo update\` picks the newest crates
instead of the newest that build on an old compiler. TypeScript is 7, the
native compiler: the SDK and the panel's plain TypeScript projects check
with it. svelte-check still needs the TypeScript 6 compiler API (TS 7 has
no stable JS API yet), so the panel keeps it as \`typescript\`, from
\`@typescript/typescript6\`, while \`tsc\` comes from \`typescript-7\` and the
scripts call it by path, since both packages ship a \`tsc\` binary. Drop the
TS 6 package once svelte-check supports 7. Updates still wait seven days
after release (Dependabot cooldown), so "newest" means newest that has
been out for a week.

## Connecting apps and access

**D97. The panel connects apps and explains refusals.** The API page leads
with the SDK: install, a \`database.ts\` download generated by the same code as
\`nelcota types\`, and examples typed for the chosen table. Three tools answer
"why can't my app see this?": the table grid can be read as a visitor or a
user (the D94 executor's role and claims, in a rolled-back transaction,
read-only); each bucket lists the \`storage.objects\` policies that name it (or
no bucket at all) and adds new ones from five server-side templates, so no
browser text becomes SQL and the panel recognizes them back in plain words;
and the server records API calls answered with 401, 403 or 429 in a
100-entry ring buffer for the policies page. That log is in memory on
purpose: no write per refused request, nothing to retain or purge, and it is
per process, which matches one panel per project. It keeps the path, not the
query string or token, and reads the role by verifying the token again only
for refused calls. The sign-in page is read-only because those settings come
from the environment. Pages off the main path (policies, a bucket, sign-in)
load on demand so the main chunk stays inside its 900 kB budget.

## Panel redesign

**D98. A dashboard look with real traffic, replacing D55's restraint and
D63's sidebar.** The panel follows a reference dashboard the user maintains:
its tokens (oklch page and card tones, a bright green for actions, a 0.75rem
base radius giving 26.4px cards), a three-column top bar with the pages as
short pills and an account chip, full-width pages with 32px gutters, 24px
titles inside and a large one on the overview, borderless cards, pill
searches and lighter tables. The overview mirrors the reference layout: one
period selector for the page, the period's traffic as the headline with
meters, stat cards beside a chart, and three cards below (rows per table,
recently blocked calls, what needs attention). The charts need data over
time, so the server counts API requests per minute (refused, server errors,
a latency histogram for p95) for 24 hours in memory, alongside the D97 log:
no write per request, gone on restart, which the overview says. As in the
reference, requests are a green area and refused calls a grey one; a grey
series alone would fail a colour-vision check, so values stay reachable
through the series filters, the tooltip, a keyboard crosshair (a slider for
assistive technology) and a table view. The mascot and the syntax colours
(D62, D92) stay; plain language first (D93) stays.

Later passes settled the rules new screens follow:

- **Surfaces, darkest to lightest in dark mode:** page (graphite, a step
  lighter than the reference at the user's request), card (rounded-3xl),
  well (rounded-2xl insets inside a card: code, tiles, rows, empty states),
  field (inputs, a step above the well). In light mode the page is grey,
  cards and fields white, wells light grey. Boxes are filled, not outlined;
  a dashed border marks only drop zones and "add" tiles, and a tinted fill
  (destructive or warning at 10%) marks danger and alerts.
- **Top bar:** a project chip (mascot, project, environment, a dot for
  whether the server answers) and the account chip balance the six centred
  pills; search is a round button. Tables, SQL and Migrations share the
  Database pill, with tabs between them inside.
- **Page grid:** pages cap at 1440px. Figures lead pages that have them, on
  the same tracks as the columns below; side columns are 24rem. Grids start
  at the container's width, so nothing scrolls sideways on phones.
- **Contrast:** text tones are checked against every surface in both themes
  (4.5:1 or more for body text), not eyeballed.

## Established libraries for protocols and panel infrastructure

The panel uses TanStack Query for concurrent read deduplication and optional
freshness windows. Explicit reloads still fetch from the server. Mutations
invalidate reads; session changes clear both cached and pending results, and
callers receive independent clones so editing a row cannot edit shared data.
TanStack Table owns row selection and column visibility using stable primary
keys; the existing keyboard editing, server ordering and permissions remain
part of the grid.

Uppy and XHRUpload handle raw-body storage uploads and progress. Automatic
retries are disabled because a failed connection can follow an already committed
upload. Destination snapshots and conflict decisions stay in the upload queue.
Shiki replaces regular-expression highlighting with lazy-loaded language
grammars and its JavaScript engine. Tokens remain escaped Svelte text; no
runtime \`eval\`, WebAssembly or Node APIs are needed in the browser.

Scalar renders the anonymous OpenAPI catalog in a same-origin frame, isolating
its styles and hash navigation from the panel. Its assets are included in the
Rust binary; external fonts, telemetry, the agent and request proxy are disabled.
Only that reference document permits same-origin framing. The rest of the panel
keeps its frame restrictions. Scalar is loaded only when the reference is opened.

The Rust oauth2 library builds authorization URLs, S256 PKCE and token exchanges;
openidconnect parses Google's typed user-info claims. Both use the existing
bounded reqwest transport, without adding a second HTTP stack. Nelcota retains
its one-time state, account linking and session policies. These dependencies
do not add a JavaScript server: Rust serves the compiled panel and backend.

**D99. Client conversions preserve Postgres value identity.** JSON numbers
remain numeric when conversion preserves their decimal value. The TypeScript
SDK keeps unsafe integers and decimals that would lose digits as strings,
including nested JSON values and RPC results. Generated numeric types that
can exceed JavaScript precision use \`number | string\`, so callers must handle
both forms and can reuse exact values in filters and writes. This preserves
the existing HTTP protocol and needs no runtime dependency or JSON reviver
source support. PostgreSQL array elements can be null even in NOT NULL columns;
generated scalar and enum arrays therefore use \`(T | null)[]\`. Column
nullability remains separate. Regenerate schema types after updating the SDK.

**D100. Panel database work has bounded budgets and indexed storage pages.**
Table previews reuse one admin connection and roll back the caller's role before
reading owner metadata. Small-table counts probe at most 10,001 rows with a
250 ms statement timeout. When a table outgrows its small estimate, its total
becomes unknown until statistics provide a larger estimate.

Table exports use two dedicated connection slots shared by all panel sessions,
with a 30-second statement timeout and a two-minute response lifetime. Dropping
a response cancels its query. Completion checks the deadline directly and
arbitrates atomically with interruption, so a delayed watchdog cannot report a
late export as complete. Admission stays occupied during bounded cancellation.

Storage directory pages seek through a generated parent-path byte key and skip
each returned folder's subtree. Immediate files use an ordered generated
scope-fingerprint/name index; exact bucket and parent checks reject collisions.
Every seek remains subject to the caller's object RLS. Listing transactions
disable bitmap scans locally to favor ordered seeks before statistics catch up.
The pure key helpers allow public execution to preserve custom SQL writers;
their generated values convey no additional access privileges.

V14 indexes the stable creation-time/ID user order. V15 computes stored directory
keys and scope fingerprints and builds their indexes under the migration lock.
Large installations need time for this one-time metadata rewrite. Upgrade tests
verify original rows, schema objects, policies and files, including legacy SQL
paths whose multibyte names exceed the HTTP byte limit.

**D101. Updates use a separately enrolled native control plane.** The same
binary runs an unprivileged HTTP/UI role and a restricted root IPC worker, on a
management origin independent of project traffic. Project/SSO/service-role
credentials grant no host authority; root-owned enrollment binds operator scope
to a project incarnation. Only official, ready, digested and attested stable
artifacts are eligible. The deployment capability owns typed receipts, shared
host leases and durable transitions; CLI adapters own runtime effects and the
admin crate owns HTTP/embedded UI. Both public-traffic commit and restarting a
restored version are irreversible data boundaries. Candidate routes/background
effects stay gated by an operation identity. Production installation starts
disabled until exact-binary VPS fault/offsite evidence passes. See
the repository-only operating guide at \`docs/panel-updates.md\` and G03 at
\`docs/goals/panel-updates-and-recovery.md\`. These are not registered panel guides.

### Known pending items

- Filtering parent rows by their embeds (\`!inner\`) and self-referencing embeds.
- \`nelcota.com/install\` should redirect to
  \`https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh\`.
`,Re="# Deploy\n\nProvision PostgreSQL, the Rust app and Caddy for HTTPS on a VPS. You need\na supported Linux host, administrative access, DNS and open ports 80/443.\nUse an explicitly selected published CLI/image version; source-only features\nrequire their own release and acceptance. Node is not required.\n\n```sh\ncurl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh     # binary (with checksum) + Docker if missing\nmkdir -p /opt/nelcota && cd /opt/nelcota\nnelcota init api.yourdomain.com                 # creates the host and the first project\nnelcota up                                      # starts projects + Caddy, waits for the healthcheck\nnelcota doctor                                  # optional: checks DNS, ports, backups and health\n```\n\nFirst create a DNS **A** record for the domain pointing at the VPS IP. Caddy\nissues the certificate on its own on the first request. After starting\neverything, `up` polls `https://<domain>/health` for up to a minute; if the\npublic URL does not answer, it lists what to check (DNS, firewall, Caddy logs)\nand exits non-zero. Local hosts (`--local`) skip this check.\n\nWithout `curl | sh`: download `nelcota-<architecture>` and\n`nelcota-<architecture>.sha256` from the releases page, run `sha256sum -c` and\ncopy it to `/usr/local/bin`. The [script](../scripts/install.sh) does just\nthat.\n\nThe built-in database connector uses private-network `NoTls`; an `sslmode`\nURL is not a TLS connector. Keep database ports private. Production secrets\nshould be stable/private; do not use dev credentials or service tokens in apps.\n\n## Host and projects\n\nA VPS can hold **several projects**, each one isolated: its own Postgres,\nusers, JWT keys, panel and backups. A single project is simply a host with one\nproject.\n\n```\nInternet ──80/443──▶ Caddy (shared)\n                        ├── api.shop.com ──▶ app-shop ──▶ shop's Postgres   (its own internal network)\n                        └── blog.example.com ──▶ app-blog ──▶ blog's Postgres\n```\n\n```\n/opt/nelcota/                   (the host folder; -C <folder> or NELCOTA_ROOT)\n├── nelcota-host.json           registry: login mode, base domain, projects (no secrets)\n├── host.env                    host secrets (0600): admin, SSO secret, S3\n├── shared/projects.json        public list (name + URL), mounted into the apps for the switcher\n├── caddy/                      shared Caddy; the Caddyfile is generated from the registry\n├── archive/                    final backups of removed projects\n└── projects/<name>/            docker-compose.yml, .env (0600), migrations/, backups/\n```\n\n- Only Caddy publishes ports. Each project's Postgres sits on its own\n  `internal: true` network; apps talk to Caddy over the `nelcota_edge` network.\n  Postgres also joins an `egress` network of its own, outbound only, to\n  archive WAL to S3 when PITR is on.\n- One Postgres per project, not a shared one: Postgres roles (`anon`,\n  `authenticated`, `authenticator`...) apply to the whole server, and separate\n  servers keep the physical isolation and a per-project `pg_dump` for leaving.\n\n### Own domain or subdomain\n\n```sh\nnelcota init api.shop.com                                # own domain → project \"shop\"\nnelcota init api.shop.com --project sales                # explicit name\nnelcota init --project blog --base-domain example.com    # subdomain: blog.example.com\nnelcota init --project panel                             # uses the base domain already saved on the host\nnelcota init --local --project shop                      # local: https://shop.localhost\n```\n\nThe project name comes from the domain (`api.shop.com` → `shop`), or from\n`--project`. It shows up in the panel's project switcher and in the commands'\n`-p`.\n\nArguments are validated before provisioning. A package, filesystem or service\nfailure during provisioning can still leave files/services behind; inspect the\nreported stage before retrying.\n\n### `init` flags\n\n| Flag | What it does |\n|---|---|\n| `--project <name>` | project name (default: derived from the domain) |\n| `--base-domain <domain>` | saves the host's base domain: `--project shop` becomes `shop.<base>` |\n| `--local` | local host without a public domain (`https://<project>.localhost`, internal certificate); only when the host is created |\n| `--panel-login shared\\|per-project` | panel login mode when the host is created (default `shared`) |\n| `--email <email>` | administrator email (default `admin@<domain>`) |\n| `-y`, `--yes` | asks no questions (defaults and flags only) |\n| `--image <image>` | app image (default `ghcr.io/nelcota/nelcota-server`, or `NELCOTA_IMAGE`) |\n| `--version <tag>` | image tag (default: the CLI's version) |\n| `--profile 1gb\\|2gb\\|4gb\\|8gb` | Postgres profile (default: by the RAM split across the projects) |\n| `--s3-endpoint`, `--s3-bucket`, `--s3-access-key`, `--s3-secret-key`, `--s3-region` | backup bucket, written to `host.env` (all four or none; region defaults to `us-east-1`). Without them, an interactive `init` asks, reading the secret key without echo |\n| `--runtime docker\\|systemd` | how projects run (only when the host is created; see below) |\n| `--firewall` | configures `ufw` (SSH, 80 and 443) |\n| `--skip-checks` | skips the Docker, ports, RAM and DNS checks |\n\n## Commands\n\nWith a single project, `-p` is optional. With several, commands that act on a\nproject ask for `-p <name>`.\n\n| Command | What it does |\n|---|---|\n| `nelcota projects` | lists projects, state and version |\n| `nelcota up` | starts every project and Caddy (`-p` for just one), then checks public HTTPS |\n| `nelcota status` | app and Postgres health, last backup age, version and free disk |\n| `nelcota doctor` | checks Docker, Caddy/ports 80 and 443, free disk, DNS, the backup cron, a backup younger than 26 h per project, S3 and service health; exits non-zero on any problem |\n| `nelcota -p shop logs -f [app\\|postgres]` / `logs caddy` | project logs / the shared proxy's logs |\n| `nelcota -p shop down` / `down --all` | stops (`--volumes` DELETES the data after a confirmation, `--yes` skips it; Docker only) |\n| `nelcota -p shop migrate` | applies `projects/shop/migrations/V<n>__<name>.sql` |\n| `nelcota -p shop types -o database.ts` / `types --lang rust -o database.rs` | TypeScript (default) or Rust types of the schema |\n| `nelcota -p shop token service-role` | service JWT (**bypasses RLS**) |\n| `nelcota -p shop backup` / `backup --all --keep 7` | dump into `backups/`, uploaded to S3 when `host.env` has a bucket ([backup.md](backup.md)) |\n| `nelcota -p shop restore <file>` | restores a dump, after a safety backup of the current state |\n| `nelcota -p shop pitr enable` / `status` / `restore --time ...` | point-in-time recovery with WAL archived to S3 ([backup.md](backup.md#pitr-point-in-time-recovery)) |\n| `nelcota -p shop upgrade` / `upgrade --all` | upgrades with a backup and automatic rollback (`--dry-run` shows current → target; downgrades need `--allow-downgrade`) |\n| `nelcota -p shop remove` | final backup in `archive/` (starting Postgres if needed; `--no-backup` skips it), removes containers, data and the Caddy site |\n| `nelcota panel-login shared` / `per-project` | panel login: single or per project |\n| `nelcota admin-password` | new panel password (`-p` with per-project login) |\n\nOn a host, `migrate`, `types` and `token` run inside the project's `app`\ncontainer, which is what can reach Postgres. Outside a host, they use\n`NELCOTA_DATABASE_URL`.\n\n## Without Docker (systemd)\n\nOn a small VPS that will only ever hold one project, Nelcota can skip Docker:\n\n```sh\ncurl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | NELCOTA_SKIP_DOCKER=1 sh\nmkdir -p /opt/nelcota && cd /opt/nelcota\nnelcota init api.yourdomain.com --runtime systemd\nnelcota up\n```\n\nAs root on Debian or Ubuntu, `init` installs Postgres 17 and pgBackRest from\nthe PostgreSQL project's apt repository (PGDG) and Caddy from its own, then:\n\n| What | Where |\n|---|---|\n| Postgres profile (by RAM) | `/etc/postgresql/17/main/conf.d/nelcota.conf` |\n| The app | `nelcota-<name>.service`, running `/usr/local/lib/nelcota/nelcota serve` on `127.0.0.1:8000` with the project's `.env` |\n| Caddy | the `caddy` service, `/etc/caddy/Caddyfile` generated from the registry |\n| PITR settings | `/etc/pgbackrest/pgbackrest.conf` (with `pitr enable`) |\n\n- Install AWS CLI v2 on the host before using offsite dump/file backups.\n  Native package provisioning installs Postgres, pgBackRest and Caddy, not AWS CLI.\n- Every command works the same way (`up`, `down`, `status`, `logs`, `migrate`,\n  `backup`, `restore`, `pitr`, `upgrade`, `remove`); they drive `systemctl`,\n  `journalctl` and `runuser -u postgres` instead of `docker compose`.\n- One project per machine: a second `init` is refused, including from another\n  directory and with `--skip-checks`. A machine-wide lease serializes native\n  init/removal; `/var/lib/nelcota-native/owner.json` keeps the host-directory\n  claim across interrupted commands. Only a completely successful `remove`\n  releases it. Do not delete this record to bypass an interrupted installation:\n  inspect and recover the original host over SSH. Legacy installations without\n  a record are adopted only when their existing unit points unambiguously to\n  the selected host's absolute `.env` path; conflicting or incomplete state\n  requires explicit recovery. For multiple projects, use Docker.\n- Native PostgreSQL uses the local `17/main` cluster on port 5432. A differently\n  configured `17/main`, or another PostgreSQL cluster reserving 5432, is rejected\n  before packages or new host/project configuration are written, including with\n  `--skip-checks`. Other ports are not selected by native database commands. Native\n  administrative clients explicitly select this cluster and local socket;\n  ambient `PGCLUSTER`, `PGHOST`, `PGHOSTADDR`, `PGPORT` or service settings cannot\n  redirect a backup, restore or credential update to a different database.\n- The app's unit runs as a throwaway user (`DynamicUser`) with no write\n  access to the system (`ProtectSystem=strict`) and no capabilities.\n- `upgrade` swaps the binary the unit runs for the one you are running (so\n  install the new version first: `NELCOTA_VERSION=x.y.z install.sh`), keeps the\n  previous one and, if the app does not become healthy, puts it back and\n  restores the pre-upgrade backup.\n- `remove` takes the final backup, then deletes the unit and the Postgres\n  cluster with its data (`pg_dropcluster`).\n- `down --volumes` is Docker-only.\n\n## Panel login\n\n- **Single** (default): one email and password for every panel on the host.\n  Signing in to one panel and switching projects with the switcher does not ask\n  for the password again.\n- **Per project**: each panel has its own credentials; the switcher just takes\n  you to the other panel, which asks for its own login.\n\n```sh\nnelcota panel-login per-project     # generates and shows one password per project\nnelcota panel-login shared          # back to single login (host password)\n```\n\nSecurity details in [panel.md](panel.md).\n\n## What the first `init` does\n\n1. **Checks** Docker and the compose plugin (a user outside the `docker`\n   group is told to use sudo or `usermod -aG docker $USER`), free ports 80/443\n   (in use = error, with how to find the process; `--skip-checks` continues\n   anyway), RAM and the domain's DNS.\n2. **Generates** the host secrets: admin credentials (password shown **once**;\n   `host.env` keeps only the argon2id hash) and the single sign-on secret.\n3. **Backup:** asks for the S3-compatible destination (or use `--s3-*`) and,\n   as root, installs the daily cron job for every project (03:00, keeps 7).\n   The job uploads whenever `host.env` has a bucket, so S3 can be added later.\n4. **Machine:** with `--firewall`, configures `ufw` (SSH, 80 and 443).\n\nEach later `init` only creates the project: its own secrets (Postgres,\n`authenticator`, Ed25519 key), a Postgres profile from the RAM split between\nprojects, and the Caddy site (reloaded without taking the others down).\n\nProject capacity depends on queries, data, hashing, uploads and PostgreSQL\nworking sets. Select a profile, measure your workload and monitor headroom.\nThe benchmark guide records specific fixtures; it does not establish a\nprojects-per-GB guarantee.\n\n## Migrations\n\nPlain SQL in `projects/<name>/migrations/`, named `V1__create_tables.sql`,\n`V2__indexes.sql`... Each file runs in a transaction. Tracking lives in\n`nelcota.user_migrations` (version, name, date, checksum): if an already\napplied file is edited, `migrate` refuses. After applying, the API reloads the\ncatalog on its own.\n\n### Changes made in the panel\n\nTables, columns and policies created in the panel go straight to the project's\ndatabase, but they do not exist in any other environment (staging, another\nmachine, a fresh database) until they become a file. The panel records each\none and lists the pending ones under **Migrations**; \"Generate migration\"\ndownloads `V<n>__<name>.sql` with them and already registers it as applied in\nthis database, with the same checksum `migrate` computes. Put the file in\n`migrations/` and commit it: nothing runs again here, and `migrate` applies it\nin the other environments.\n\nThe chosen number goes past everything in the database and in the folder (the\ncontainer reads `./migrations`, mounted at `/migrations`), so a file not yet\napplied is never overtaken. Outside the container, point to the folder with\n`NELCOTA_MIGRATIONS_DIR`. What you run in the SQL editor is not recorded: copy\nthat SQL into a migration by hand.\n\n## Upgrade\n\n`nelcota -p shop upgrade` makes the target image available before changing the\nrunning project. It then puts that project's Caddy site in maintenance (HTTP\n503 with `Retry-After`), stops the app to drain existing requests, and captures\nthe database and disk files together. Only then does it change\n`NELCOTA_VERSION` in `.env`, start the new version and wait for its healthcheck.\n\nIf the new version does not become healthy, the CLI restores the previous\nversion, database and paired disk snapshot before reopening traffic. If backup\ncreation fails, it restarts the unchanged previous version. A failed or\ninterrupted recovery leaves the maintenance gate closed; after fixing the\ncause, `nelcota -p shop up` checks health and reopens it. Other projects keep\nserving traffic; `upgrade --all` upgrades one at a time, keeps going when one\nproject fails (it was rolled back) and lists the failures at the end.\n\nWithout `--version`, the target is the CLI's own version. The CLI compares it\nwith the project's `NELCOTA_VERSION` first:\n\n- same version: nothing to do (`--reinstall` redeploys it anyway, e.g. a rebuilt\n  binary on a systemd host);\n- older target: refused, because the older app does not know the newer\n  migrations. When the CLI itself is the older one, reinstall it\n  (`curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh`); to go back on purpose, pass\n  `--allow-downgrade`;\n- `--dry-run` prints `current → target` for each project and changes nothing.\n\n```sh\nnelcota upgrade --all --dry-run\nnelcota -p shop upgrade --version 0.4.0  # published target; already-current projects are skipped\n```\n\n## Local development\n\n```sh\nnelcota dev        # Postgres 17 in a container (127.0.0.1:54322) + server on :8000\n```\n\nThe development secrets (panel and Postgres passwords, JWT key) live in\n`.nelcota/dev.env`, readable only by you; the startup banner says where they\nare instead of printing them. `nelcota token service-role --days 30` issues a\n`service_role` token for that environment.\n\n`--db-port <port>` moves the development Postgres to another local port. The\nnew port is saved in `.nelcota/dev.env`; it gets its own container and data,\nand the old container is left as it was.\n\nTo test the full deploy locally (several projects, Caddy, HTTPS with an\ninternal certificate): `nelcota init --local --project shop` and open\n`https://shop.localhost/admin/`.\n\n## Acceptance test\n\n```sh\nACCEPT_DOMAIN=api.example.com ./scripts/acceptance.sh   # real VM\n./scripts/acceptance.sh --local                          # local simulation\n```\n\nLast local run (2026-10-06, Windows 11 + Docker Desktop, cached images): **two\nprojects with HTTPS in 28 s**. Also passing: migrate (idempotent), signup and\nRLS through Caddy, isolation between projects (one project's JWT is not valid\non the other; one project's tables do not exist on the other), single sign-on\nbetween panels with a single-use token, switching to per-project login and\nback, `types`, backup → write → restore, automatic upgrade rollback without\naffecting the other project, and project removal with a backup in `archive/`.\n\nThis dated local run is historical evidence. It does not validate a current\nVPS, public DNS/TLS, the native systemd runtime or controlled updates. Published\nreleases now exist; run acceptance on your target host/version before relying\non production behavior.\n\n## Optional host management\n\nThe Unreleased controller can provision and manage isolated Docker projects\nafter explicit SSH enrollment. Approve an official image, domain scope and VPS\naddresses before enabling creation; inspect operation reviews and retain\nrecovery access. See `docs/host-management.md` for supported layouts and\nproduction acceptance.\n",ze=`# Glossary

Use these terms when reading guides or reporting a problem. You need no running
installation to use this reference.

| Term | Meaning |
| --- | --- |
| Host | Deployment directory and machine managed by the CLI, with shared proxy and project registry. |
| Project | Isolated application deployment with its own PostgreSQL, users, keys and storage. Docker supports several projects; systemd supports one per host. |
| Schema | PostgreSQL namespace. The configured exposed schema generates REST resources; internal schemas hold auth/storage/control data. |
| Role | PostgreSQL identity used for privileges. A validated JWT selects a closed caller role within a transaction. |
| GRANT | SQL permission to use an object. RLS does not grant access by itself. |
| RLS | Row-level security. PostgreSQL filters/checks rows using policies for the active role. |
| Policy | SQL \`USING\`/\`WITH CHECK\` rule for permitted rows and operations. |
| \`service_role\` | Trusted server role with \`BYPASSRLS\`, still subject to SQL privileges. Never expose its token to clients. |
| Session | Login identity and rotating refresh-token family. Revoking refresh does not retract issued access JWTs. |
| Access token | Signed bearer JWT identifying a caller until expiry. |
| Refresh token | Opaque credential exchanged for a new token pair. Store privately and serialize rotation. |
| Bucket | Storage configuration grouping object names and visibility/MIME/size limits. |
| Object | Metadata row under RLS plus an immutable version of file bytes on disk/S3. |
| Migration | Versioned SQL file with an immutable applied checksum. Application and internal migrations have separate histories. |
| Event / delivery | Committed row change / one destination's attempt history. Webhooks are at least once. |
| Backup pair | Database dump and matching disk-file snapshot/manifest. Keep both. |
| PITR | Database recovery from a base backup and archived WAL; file bytes are separate. |
| Operator | Separately enrolled update-controller identity with explicit deployment scope. Project admin login does not grant this authority. |

Related: [documentation](README.md), [JWT/roles](jwt-and-roles.md) and
[security](security/README.md).
`,Be=`# Host project management

The separately authenticated host controller manages isolated Docker projects.
It uses the same Rust binary and project/runtime adapters as the CLI. Each new
project receives its own PostgreSQL cluster, signing keys, users, disk files,
migrations and project panel. The project panel links to the controller; project
cookies, SSO and service-role tokens never grant host authority.

This capability is **Unreleased**. Published 0.4.0 does not include the host
controller. Build this source for disposable validation; production enrollment
requires a matching official controller release and host-specific acceptance.

## Explicit operator enrollment

Initialize the host and its first project through SSH using the deploy guide.
Use a dedicated public HTTPS controller origin, native attestation verifier and
private operator-password file as described in \`docs/panel-updates.md\`.

Host creation authority is an additional SSH grant. Prepare a root-owned JSON
file, mode 0600, approving one official release image, its source commit, domain
scope, VPS addresses and maximum concurrent projects. This is a shape; replace
every placeholder with reviewed release/host values:

\`\`\`json
{
  "version": "RELEASE_VERSION",
  "image_digest": "64_LOWERCASE_HEX_CHARACTERS_FROM_THE_OFFICIAL_IMAGE",
  "source_sha": "40_LOWERCASE_HEX_CHARACTERS_FROM_THE_RELEASE_COMMIT",
  "max_projects": 32,
  "domain_suffixes": ["apps.example.com"],
  "addresses": ["YOUR_PUBLIC_VPS_IP"]
}
\`\`\`

Pass this file on the initial enrollment:

\`\`\`sh
sudo nelcota -C /opt/nelcota updates enroll \\
  --origin https://control.example.com \\
  --email operator@example.com \\
  --password-file /safe/operator-password \\
  --verifier /usr/local/bin/gh \\
  --projects first \\
  --host-management /safe/host-management.json
\`\`\`

An already enrolled host requires an explicit SSH policy change: copy these
values into \`host_management\`, set \`manage_host: true\` only on the designated
operator, and restart the worker. Policy changes revoke existing sessions and
reviews. Keep \`enable_installation\` and update acceptance settings unchanged:
project creation authority does not complete the separate update acceptance.

V1 creation supports Docker, shared project-panel login and disk storage.
Root control files must retain their trusted ownership and permissions.
Per-project panel credentials, S3 application storage, PITR or custom Compose
layouts require their CLI/recovery workflows; the interface reports blockers.
PostgreSQL profiles estimate configuration and do not reserve RAM or guarantee
capacity. Measure application/database load before filling the host.

## Visual workflow

Open the host controller from the Projects page and sign in with the enrolled
operator. The Projects tab shows resource counters, project domains, backend/
database health, backup selection, structured log metadata and operation history.

Every operation has a review showing its exact project, domain/backup, approved
version/image, effects, blockers and expiration. Review both acknowledgments,
type the displayed action/project phrase and re-enter the operator password.
Reviews expire after five minutes and are revalidated before acceptance.

Creation checks project/domain collisions (including the controller hostname at
any port), reserved Docker containers/volumes/networks, domain scope, DNS addresses, disk
reserve, estimated RAM share and project count. It verifies image provenance,
pins immutable image bytes, starts the isolated services, publishes the project
and verifies public HTTPS. Failed partial provisioning remains inspectable;
it never erases an existing folder to retry automatically.

Backup captures and verifies a consistent database/disk-file pair. It is a local
copy; configure and test off-host backups separately. Restore validates the
selected pair, enters maintenance and captures the current state first. Once
the restored state reaches verification, recovery preserves any later writes
and never automatically replays the earlier snapshot. Before that checkpoint,
recovery revalidates the preserved safety pair and refuses destructive work if
it is missing or corrupt.

Removal enters maintenance, stops application writes and verifies a final paired
backup in \`archive/\` before deleting database volumes. Configuration and disk
files remain in a private retired-project directory. Only the selected project
leaves the host registry/proxy; other projects remain running. A recreated name
gets a new identity and never inherits a scoped operator's former authority.

## Disconnects and recovery

The VPS owns accepted work. Closing or reloading the page does not cancel it.
The browser stores only a per-operator request identifier in session storage,
never the password. Uncertain responses are reconciled with durable receipts;
retrying the same identifier returns the same job. Mutations are never retried
automatically. Concurrent CLI, update and management mutations use one host
lease and refuse unresolved operations.

Interrupted jobs require operator attention. The UI shows the last recorded
stage and offers a separately confirmed recovery. SSH diagnostics remain useful:

\`\`\`sh
sudo nelcota -C /opt/nelcota updates host-status
sudo nelcota -C /opt/nelcota updates host-recover --job OPERATION_ID
sudo journalctl -u nelcota-updates-worker -u nelcota-updates-controller
\`\`\`

Private receipts/logs are under \`<host>/updates/host-jobs/<id>/\`. The browser
receives bounded structured event metadata; free-form application messages,
SQL, credentials and command output stay private. Preserve incomplete receipts,
safety/final backups and retired configuration. Archive only completed history
before reaching the bounded 255-job journal limit. Inventory remains readable
when a partial removal has already moved a project directory; an incomplete
recreation of a retired name can restart under its durable receipt. Temporary
host-lease contention delays reconciliation and never retries mutations.

## Validation limits

\`scripts/test-host-management.py\` runs owned Docker projects and real PostgreSQL,
file snapshots, restore, post-verification recovery, missing safety backups, partial removal/recreation,
worker-policy reload, Docker volume collisions and removal. It uses explicit
doubles for DNS/image provenance, public TLS, proxy reload and the unused PITR
image extension. Browser tests cover visual approval, blockers and lost responses.
These tests do not certify a production VPS, actual abrupt power loss, native
systemd deployment or off-host recovery. Rehearse those on the selected host and
exact official controller/image before production use.

Related: [deploy](deploy.md), [backup](backup.md), [security model](security/README.md)
and the separately gated [update controller](panel-updates.md).
`,Ve='# JWT and roles\n\nPublic contract. The JWT format is ours and documented here; no library\ndictates it.\n\n## Prerequisites\n\nYou need an initialized private PostgreSQL database and a signing key or\ncompatible verifier. This page describes built-in token/role behavior; issuer\nand audience policy are not enforced by the built-in verifier.\n\n## Postgres roles\n\n| Role            | Login | Used by                            | RLS        |\n|-----------------|-------|------------------------------------|------------|\n| `authenticator` | yes   | the API connection (pool)          | n/a        |\n| `anon`          | no    | requests without `Authorization`   | enforced   |\n| `authenticated` | no    | signed-in end users                | enforced   |\n| `service_role`  | no    | trusted backend                    | **bypassed** (`BYPASSRLS`) |\n| `nelcota_auth`  | no    | internal: the server reading `auth.*` | n/a (no JWT can assume it) |\n\n`authenticator` is `NOINHERIT`: on its own it has no privilege at all. It is a\nmember of the other roles and assumes one of them in each request.\n\n> **Warning:** **A JWT with `role: service_role` bypasses all RLS. It must\n> NEVER go to the frontend, a mobile app or anywhere outside your server.**\n\n## What happens in each request\n\n1. The API reads `Authorization: Bearer <jwt>` (the scheme is case-insensitive:\n   `bearer <jwt>` works too).\n   - Without the header: the request becomes `anon`.\n   - Header present but invalid (signature, `exp`, `nbf`, `iat`, scheme, unknown `kid` or\n     role): **401**. It never silently becomes `anon`.\n2. Opens **one** transaction and runs, with parameters:\n   ```sql\n   SELECT set_config(\'role\', $1, true),                -- = SET LOCAL ROLE\n          set_config(\'request.jwt.claims\', $2, true);  -- full claims\n   ```\n3. Runs the query. Postgres RLS decides what the role sees.\n4. COMMIT (or ROLLBACK on error). Role and claims die with the transaction.\n\nApplication row access is determined by PostgreSQL GRANTs and RLS. The server\nalso validates authentication, query/path syntax and operation boundaries before\nexecuting the request.\n\n## Signing\n\n- **EdDSA (Ed25519)**, the default. Private key in `NELCOTA_JWT_PRIVATE_KEY`\n  (PKCS#8 in PEM, or the one-line base64). The public key is published at\n  `GET /auth/v1/.well-known/jwks.json` (`kty: OKP`, `crv: Ed25519`, `kid` =\n  RFC 7638 thumbprint). Each token\'s header carries the `kid`.\n- **HS256**, the simple/legacy mode, with `NELCOTA_JWT_SECRET` (≥ 32\n  characters). When there is an EdDSA key, the HS256 secret is only used to\n  **verify** old tokens, which allows migrating without signing anyone out.\n\nGenerate a key: `openssl genpkey -algorithm ed25519` (or `nelcota init`, which\ngenerates one).\n\n## Claims of user tokens (issued by `/auth/v1`)\n\n```json\n{\n  "iss": "nelcota",\n  "aud": "authenticated",\n  "sub": "3f1c…-uuid",\n  "role": "authenticated",\n  "email": "ana@example.com",\n  "session_id": "8a2d…-uuid",\n  "iat": 1767225600,\n  "exp": 1767226500\n}\n```\n\n## Validation rules (any issuer)\n\n| Claim  | Required | Rule |\n|--------|----------|------|\n| `role` | yes | `anon`, `authenticated` or `service_role`. Any other value → 401. |\n| `sub`  | only for `authenticated` | the user\'s uuid (`auth.uid()`). |\n| `exp`  | yes | epoch in seconds; 30 s of leeway. |\n| `nbf`, `iat` | no | if present, whole non-negative epoch seconds; reject values more than 30 s in the future. |\n| `iss`, `aud` | no | informative: not required or matched by verification. |\n\nThe same built-in `Keys` validator checks EdDSA and HS256 API tokens and signed\nraw payloads. Standalone auth consumers inherit these checks. The Rust and\nTypeScript SDKs forward tokens to the server; they do not verify signatures or\nmake authorization decisions from decoded claims. Keep issuer/audience policy\nin a custom verifier when required; `iss`/`aud` remain informative.\n\nOther claims are passed through untouched to `auth.jwt()`. Logout revokes the\nsession and the refresh tokens; the access JWT, which is stateless, stays valid\nuntil `exp` (default: 15 minutes, `NELCOTA_JWT_EXPIRY_SECS`).\n\n## Switching auth providers\n\nSince policies only depend on `auth.uid()`, `auth.role()` and `auth.jwt()`,\nany issuer producing a JWT with the claims above works. Verification sits\nbehind the `JwtVerifier` trait; accepting an external JWKS (Auth0, Keycloak,\nZitadel...) is a new implementation of that trait.\n\n## SQL functions\n\n```sql\nauth.jwt()  -> jsonb  -- request claims (\'{}\' outside a request)\nauth.uid()  -> uuid   -- the sub claim\nauth.role() -> text   -- the role claim\n```\n\nPolicy example:\n\n```sql\nCREATE POLICY owner ON public.todos\n    FOR SELECT TO authenticated\n    USING (user_id = auth.uid());\n```\n\n## HTTP status codes\n\n| Situation | Status |\n|---|---|\n| Invalid or expired JWT, unknown role or a scheme other than Bearer | 401 `invalid_token` |\n| `anon` without permission on the table | 401 `db_error` (`sqlstate` `42501`) |\n| `authenticated` without permission / policy violated on write | 403 `db_error` (`sqlstate` `42501`) |\n| Table does not exist | 404 `not_found` |\n\nThe body is the API\'s error JSON (`code`, `message` and, for database errors,\n`sqlstate`/`details`/`hint`/`constraint`); see [api.md](api.md#errors).\n\nEvery 401 carries `WWW-Authenticate`: `Bearer error="invalid_token"` when a\ntoken was presented and rejected, plain `Bearer` when the request had no\ntoken (an `anon` request that needs to sign in).\n\n## Related guides\n\nSee [auth schema](schema-auth.md), [REST API](api.md) and [deploy](deploy.md).\n',He=`# Leaving Nelcota (no lock-in)

Export your schema, policies, identities and files to another backend. You need
owner access, PostgreSQL tools and a verified destination. Database metadata is
SQL; file bytes and deployment secrets must be exported separately. Completion
time depends on dataset size and destination compatibility.

For the Docker commands below, enter \`projects/<name>/\` inside your host folder
so Compose selects that project. Systemd hosts use native PostgreSQL tools.
Keep dumps, user/password-hash exports, file mappings and configuration private.

## 1. The whole database (schema, data, policies, functions, users)

\`\`\`sh
docker compose exec -T postgres pg_dump -U postgres -Fc postgres > nelcota.dump
# restore into any Postgres 17+:
pg_restore --no-owner -d "postgres://user@new-host/db" nelcota.dump
\`\`\`

The roles \`anon\`, \`authenticated\`, \`service_role\`, \`authenticator\` and
\`nelcota_auth\` are global and not part of \`pg_dump\`. Create them on the target
first (the file \`migrations/V1__roles_e_auth.sql\` does that and is idempotent)
or use \`pg_restore --no-acl\` if you will not use them.

## 2. Just the users (with their hashes)

\`\`\`sh
docker compose exec -T postgres psql -U postgres -c "\\copy (
  SELECT id, email, encrypted_password, email_confirmed_at,
         raw_user_meta_data, created_at, last_sign_in_at
  FROM auth.users) TO STDOUT WITH CSV HEADER" > users.csv
\`\`\`

\`encrypted_password\` uses the standard PHC argon2id format
(\`$argon2id$v=19$m=19456,t=2,p=1$...\`). Any argon2 library verifies these
hashes without conversion: users **do not need to change their passwords**.
Details in [schema-auth.md](schema-auth.md).

## 3. The JWTs

The format is in [jwt-and-roles.md](jwt-and-roles.md). To switch auth
providers without rewriting the policies, the new provider only has to issue
tokens with \`role\` and \`sub\`. The \`auth.uid()\`/\`auth.jwt()\` functions stay the
same.

## 4. The files

\`storage.objects\` is part of the dump above. The bytes are plain files in
\`projects/<name>/storage/\` (disk) or objects in your own bucket (S3), stored
as \`<bucket>/<version>\`. The name of each one:

\`\`\`sh
docker compose exec -T postgres psql -U postgres -c "\\copy (
  SELECT bucket_id || '/' || version AS key, bucket_id || '/' || name AS name
  FROM storage.objects) TO STDOUT WITH CSV HEADER" > files.csv
\`\`\`

## 5. What stays behind

Only the \`nelcota\` binary: the automatic REST API and the panel. Without
Nelcota, Postgres keeps serving exactly the same data with the same policies,
and you can point PostgREST, Hasura or your own backend at it.
`,Ue=`# Controlled panel updates

The update controller and worker ship in the same Rust binary as the API. They
run as separate host processes. The controller serves the embedded panel on a
separate HTTPS origin; it remains reachable while a project is in maintenance.
No Node service, Docker socket in the application, or privileged project cookie
is involved. Node is used only to build the existing frontend.

Installation is disabled after enrollment. Local tests do not constitute VPS
acceptance. The current published 0.4.0 release predates this controller; a new
stable release (0.5.0 or later) containing this implementation is required before deploying it.

## Enrollment over SSH

Use a verified official release on a Linux VPS with systemd, an official-image
host registry and a separate public DNS hostname, for example
\`updates.example.com\`. Its DNS must resolve to the VPS. Existing project domains
cannot be reused. Keep SSH available throughout updates and recovery.

The host metadata, project directories, \`.env\` files and all ancestors must be
root-owned without group/other write permission. Application storage keeps its
existing service ownership; do not recursively change storage ownership. The
native GitHub CLI must be root-owned and checksum-verified against its official
release; it must support \`attestation verify\`, \`--bundle\`, \`--source-digest\` and
\`--source-ref\`. systemd hosts also need AWS CLI v2 for offsite backups. Docker
hosts use the existing AWS CLI container transport.

Prepare a private operator-password file on the VPS (mode 0600, at least 16
characters). Supply its path, never a password argument or shell-history value:

\`\`\`sh
sudo nelcota -C /opt/nelcota updates enroll \\
  --origin https://updates.example.com \\
  --email operator@example.com \\
  --password-file /root/nelcota-update-password \\
  --verifier /usr/local/bin/gh \\
  --projects shop,blog
\`\`\`

Enrollment installs \`nelcota-updates-worker.service\` as root and
\`nelcota-updates-controller.service\` as the dedicated \`nelcota-updates\` user.
Their binary is separate from the project's deployed executable. It writes a
root-owned policy, scoped project identity receipts, a public controller link,
proxy routing and Unix socket mounts. It checks compose layouts before editing
known image/mount entries. Native gates live in a root-owned, readable
\`/var/lib/nelcota-deployment-gates/\` directory so the dynamic app user does not
need access to private host metadata. A custom layout requires operator review; it is not
silently replaced. DNS/HTTPS, service startup and the root-owned files must be
checked on the real host before enabling installation. A failed enrollment may
leave installed files/accounts; inspect and repair them over SSH before retrying.

Native enrollment and every update preflight require the canonical project unit,
no systemd drop-ins and no pending daemon reload. Overrides can change the actual
database or environment without changing the project's \`.env\`; they therefore
require separate operator review. Preparation also verifies that the active
native PID uses the installed executable before capturing its recovery identity.

Open \`/admin/updates\` in a project panel or go directly to
\`https://updates.example.com/admin/\`. Sign in with the enrolled operator.
Project-admin, SSO, bearer and service-role credentials do not grant deployment
authority. Each operator sees only its explicitly enrolled projects and history.
A project removed and recreated under the same name needs a fresh identity and
policy enrollment; it does not inherit authority from its name.

Remove the initial password file after confirming the operator login. To revoke
or rotate credentials, change \`/etc/nelcota-updates/policy.json\` over SSH and
restart the worker. A changed policy immediately invalidates old requests;
worker restart also invalidates its in-memory sessions and plans. The controller
never edits this policy. Do not edit deployment metadata or invoke Docker/
systemd operations outside the CLI while an operation is active.

## Release trust and readiness

Only stable releases from \`Nelcota/Nelcota\` are discovered. HTTPS redirects,
filenames, sizes, versions, architectures, source revisions and protocol shapes
are bounded. The worker verifies SHA-256 plus Sigstore/GitHub provenance using
native \`gh\`, the official release workflow, exact source SHA and tag ref, and
rejects self-hosted attestations. Published binary, manifest and OCI attestation
bundles are fetched from fixed release asset paths; no GitHub personal token is
required for bundle-based verification. The verifier still needs its trusted
roots and public registry connectivity. TLS/signature failures block preparation.

The release workflow publishes readiness only after both Linux musl binaries,
the OCI index and their provenance exist, and the latest main CI run for the
exact source has completed successfully. It signs \`update-manifest.json\`, which
binds binary hashes/sizes, OCI digest, internal migration version, CI run and
minimum application/controller/protocol versions. Workflow-dispatch republishing
does not create a tag-bound readiness receipt. A partial or changed release,
downgrade, prerelease, unknown protocol or incompatible controller cannot install.
Checking a release never starts maintenance or updates a project.

## Enablement and acceptance evidence

Keep \`enable_installation: false\` until the G03 acceptance matrix has been
executed with the exact installed controller binary and retained evidence. The
worker requires a root-owned private report whose \`binary_sha256\` matches that
binary, \`schema\` is 1, \`status\` is \`passed\`, and every following check is true:

| Report check | Required evidence |
|---|---|
| \`docker_upgrade\`, \`docker_rollback\` | Actual Docker services, seeded DB/files/credentials, upgrade and forced precommit failure |
| \`systemd_upgrade\`, \`systemd_rollback\` | Actual systemd services and the same continuity/rollback checks |
| \`worker_crash\` | Kill the worker at each journal/effect boundary, restart and recover via SSH/UI |
| \`power_loss\` | Abrupt disposable-VM power loss, durable journal/maintenance/gate and recovery proof |
| \`provenance\` | Real release bundles plus rejected checksum, source/ref/signer and partial-release cases |
| \`browser_reconnect\` | Browser close/reload, lost response, idempotent retry and recovery during app downtime |
| \`offsite_restore\` | Restore the downloaded DB/files/configuration on a separate disposable host |

Record OS/architecture, Postgres version, source/release/binary identity, commands,
results, RPO/RTO and evidence locations. Keep failing, skipped and unrun checks
separate. This report is a root operator attestation backed by retained evidence;
a boolean template is not a substitute for running the checks. Set its absolute
path in \`validation_report\` and enable installation only after all gates pass.
There is no HTTP bypass. Each architecture requires evidence for its own binary.

V1 blocks project S3 storage, PITR, external/custom database layouts and custom
images. Ordinary disk storage with local per-project Postgres 17 is the supported
model after acceptance. Offsite backups require HTTPS, readback verification of
the exact dump/file manifest/bytes, and encrypted configuration upload (SSE
AES256). Backups must fit alongside restoration and artifact space; preflight
reserves three times the measured database/file size plus the configured buffer.

## Operation and recovery

Prepare a five-minute plan, inspect target/digest/requirements and confirm the
operator password again. Installation rechecks the configuration and manifest
identities. A durable idempotency key binds retries to the accepted operation.
There is one mutation lease per host; ordinary CLI mutations use the same lease
and refuse unresolved jobs. On enrolled hosts, legacy \`upgrade\` is blocked so it
cannot override a pinned image or accidentally deploy the controller as the app.

The worker prepares verified artifacts, persists previous runtime/configuration
identities, closes and syncs maintenance, stops the app and checks that its DB
connections are gone. It captures the paired snapshot, validates the dump and
file manifest, refuses source/destination symlink traversal using directory
handles, reads the offsite backup back and records the identities before
activation. The candidate blocks all application routes except \`/health\` and
pauses webhook dispatch, auth pruning and file collection while validating.
Health, executable/image identity (including the running native PID) and internal migration version are checked.
Only a durable commit decision may release a gate bound to
that candidate's operation ID. Application-route readiness is then checked before
reopening the proxy. An older/cancelled candidate cannot reuse another
operation's commit signal. The UI uses phase/sequence receipts; percentages do
not pretend to estimate remaining migration time.

Before commit, a failure can restore the verified paired snapshot, previous
configuration and exact previous binary/image. Before restarting the restored
version, the journal records a second irreversible boundary: background work
may write data even before public traffic opens. Failure after either boundary
preserves current data; it never automatically restores an earlier snapshot.
A failed/uncertain restore leaves maintenance closed. Worker/job crashes become
\`needs_operator\`; journal corruption never becomes guessed success.
Recovery error handling reloads the authoritative receipt, including when rename
succeeded before fsync reported an error. Older/conflicting sequences cannot
overwrite newer receipts, revoke either irreversible decision or reopen a
completed job.

The browser polls with a single request loop, bounded backoff and stale-sequence
protection. Closing the page cancels only browser requests. Mutating requests
are not automatically retried. On a lost response, inspect the journal through
the panel; an explicit retry with the same key returns the accepted job.

For SSH inspection and recovery:

\`\`\`sh
sudo /usr/local/lib/nelcota-updates/nelcota updates status
sudo /usr/local/lib/nelcota-updates/nelcota updates recover --job OPERATION_ID
sudo journalctl -u nelcota-updates-worker -u nelcota-updates-controller
\`\`\`

Job state and private runtime diagnostics are under \`<host>/updates/jobs/\`.
HTTP responses contain safe phase/error codes, not logs, credentials, dump paths
or command output. Preserve incomplete jobs, their paired backups, previous
configuration and images/binaries. Normal backup retention cannot run under an
active/unresolved deployment lease. The bounded journal admits at most 255 jobs;
archive completed history over SSH after reviewing retention needs. Do not delete
incomplete receipts to clear a blocked host.

Controller replacement is a separate SSH procedure: require no incomplete jobs,
stop both update services, verify the new official controller and native verifier,
replace their installed files atomically, invalidate/re-run the exact-binary
acceptance report, and restart/recheck both services and HTTPS. Application jobs
never update their own controller. Do not use an ordinary application rollback
as controller replacement or incident/PITR recovery.
`,We=`# Panel

At \`https://<project-domain>/admin/\`. Its own login, separate from end users:
the email and password generated by the first \`nelcota init\` (the password is
shown only once).

The panel is available in **Portuguese and English**. On the first visit it
follows the browser language (any Portuguese locale gets Portuguese, anything
else English); the choice in the account menu (Language) is remembered in that
browser. Server messages and error texts are English; the panel shows errors
in the chosen language by their error code.

## Prerequisites

Use an initialized project with panel credentials and access to its API origin.
The project administrator can run privileged SQL; this is not an end-user token
or an enrolled update-operator login. This reference describes current source.

## Several projects

Each project has its own panel, on its own domain, showing only its data. At
the top left, next to the mascot, the **project switcher** (current project name) lists
the other projects on the host and leads to "All projects": name, domain,
state (up / down), version and a button to open each panel.

With **single sign-on** (default), switching projects in the switcher does not
ask for a password. With **per-project login** (\`nelcota panel-login
per-project\`), the switcher just takes you to the other panel, which asks for
its own login. The login screen always shows which project the panel belongs
to.

### How single sign-on works

Cookies do not cross different domains (\`api.shop.com\` → \`api.blog.com\`), so
the origin panel performs a *handoff*:

1. The admin, already signed in to the shop's panel, picks "blog" in the
   switcher.
2. The shop's panel issues a token for the blog: an HS256 JWT signed with the
   host's shared secret, \`aud\` = blog, valid for 60 s, unique \`jti\`.
3. The browser opens \`https://<blog>/admin/#sso=<token>\`. The token travels in
   the URL **fragment**, which does not show up in server logs or the
   \`Referer\`.
4. The blog's panel validates signature, audience, validity and the admin
   email, refuses already-used tokens and creates its own session. The token
   leaves the URL immediately.

Handoff redemption writes a SHA-256 digest of the signed \`jti\` to the project's
internal PostgreSQL replay table before creating a panel session. All processes
and instances sharing that database use the same atomic single-use boundary;
database failures refuse the handoff. Receipts cover the 5-second validation
leeway and remain for at least another day. Each successful redemption removes
at most 5,000 older receipts; idle tables are cleaned on the next redemption.
Keep instance clocks synchronized. A panel session never grants host-controller
authority. Internal migration \`V16\` installs this owner-only table; it is not
part of the standalone auth migration selection.

With per-project login there is no shared secret: the handoff does not exist,
and each panel only accepts its own credentials.

An SPA in **Svelte 5 + shadcn-svelte + Tailwind v4**, with **CodeMirror 6** in
the SQL editor, Manrope for the interface and IBM Plex Mono for code. The build
is embedded in the binary: no CDN and no Node in production (fonts too,
because of the CSP \`font-src 'self'\`). Dark theme by default; theme and
language are in the account menu, at the top right.

The pages are pills across the top (on narrow screens, in their own row; on
phones, in the menu). **Database** groups Tables, SQL and Migrations, with
tabs between them inside each page; **User sign-in** is reached from the
Users page. The project chip at the top left shows the project, whether it
runs locally or on which host, and a dot for whether the server answers
(checked every minute and when the window regains focus). Search (Ctrl K)
sits beside the account chip. The
**overview** leads with the API's traffic: requests in the last 24 hours,
the share refused and the share that failed, then cards for tables (how
many are protected), users (how many have signed in from the app) and
refused calls, beside a chart of requests and refused calls over the last
hour or day, with a table view. The counts are kept in memory per minute
for 24 hours: restarting the server starts them again.

RLS state shows as a colored badge: green (RLS with policies), amber (RLS on
without policies) and red (table exposed without RLS).

| Feature | How to use it |
|---|---|
| Edit a cell | double click; Enter saves, Esc cancels, NULL button for nulls |
| Edit or insert a full row | expand button next to the row's checkbox / "Insert row" (side panel). Closing an altered form asks whether to keep editing or discard |
| Delete several rows | tick the boxes and "Delete N" (a single transaction) |
| Sort | click the column header (asc → desc → unsorted) |
| Filter | "Filter" in the grid: equals, not equal, contains, greater/less, is/is not NULL. Filters live in the URL in the REST API format (\`/admin/tables/orders?status=eq.paid\`). Page, page size and sort use \`_page\`, \`_size\`, \`_sort\` and \`_desc\`; the complete view survives switching between Data and Structure, refresh and browser navigation |
| Export a table | "Export" → CSV or JSON, with the grid's order and filters. The server streams with bounded buffers and no collection row cap; exports have a two-minute lifetime and can fail on timeout/cancellation. CSV has a BOM for Excel accents |
| Follow a foreign key | the arrow in an FK cell opens the referenced row in the other table; the header shows \`→ table\` |
| Run SQL | Ctrl+Enter; table and column autocomplete; templates and history |
| Save queries | Ctrl+S or "Save"; they show in the editor's sidebar and in the palette. Each query has its own draft; opening another query, template or new query keeps previous work. Saved queries and drafts are stored in this browser, per project |
| Read long values | "View full content" in long grid and SQL result cells; copy from the detail dialog |
| Resize SQL results | drag the separator between the editor and results, or focus it and use the arrow keys. The split is remembered in the browser |
| Export a SQL result | "Export" above each result → CSV or JSON |
| Command palette | Ctrl+K (⌘K on Mac) or the search button at the top right: pages, tables, saved queries, templates and actions |
| Create a table | "New table" in the table list: columns (type, default, PK, identity, UNIQUE, foreign key), RLS on by default and a GRANTs matrix. Shows the SQL before creating |
| Edit the structure | the table's **Structure** tab (\`/admin/tables/<name>/structure\`): add, edit and delete columns; rename the table; description; turn RLS on/off; GRANTs per role; delete the table (by typing its name) |
| Policies | search tables and filter their RLS status; "New policy" on each table, with templates (public read, signed-in users read, owner reads/creates/updates/deletes); edit and delete; "Enable RLS" on tables without it. Long expressions expand on demand |
| service_role token | **API** page, expandable token section after the examples: issues a token with the chosen validity; shown once and never stored |
| Create a user / reset a password | **Users** page: "New user" and "Reset password…" in each user's menu, with a password generator. Same rules as public signup. Accounts created here count as confirmed and the panel sends no invitations; end users can recover their own password by email when the project has SMTP configured ([schema-auth.md](schema-auth.md#password-recovery)) |
| Generate migration | **Migrations** page: schema changes made in the panel (tables, columns, policies) that are not in any file yet, and the project's migrations (applied or only in the folder). "Generate migration" downloads \`V<n>__<name>.sql\` and registers it as applied in this database; the file goes into \`migrations/\` (see [deploy](deploy.md#changes-made-in-the-panel)) |
| Profile photo | account menu, at the top right: "Add photo…". The image is center-cropped and scaled to 256px in the browser; the server accepts PNG, JPEG or WebP up to 256 KB. It lives in the project's database (\`nelcota.admin_avatar\`, out of reach of the API roles), so it works in any browser, but it is per project |
| Dates in the grid | \`timestamptz\` shows in the viewer's time zone and language; \`timestamp\` and \`date\` as stored. The exact value is in the tooltip, in edit mode and in exports |

CSV exports protect spreadsheet imports: formula-like cells and headers receive
a quoted tab prefix, including formulas hidden behind whitespace or control
characters. Negative numeric literals keep their digits and numeric form.
Use JSON export when you need the original text without this neutralization.

| Page | What it has |
|---|---|
| **Overview** | what needs action (unprotected or locked tables), next steps ticked by the project's state (first table, data protected, a user, a first sign-in through the app), a one-line summary and the table list with who can read and write. Pages that show access rules read in plain language; "Technical details" shows RLS, roles, grants and SQL |
| **Tables** | every table in the exposed schema, estimated rows, \`anon\`/\`authenticated\` GRANTs and RLS status. List, insert, edit and delete rows (tables with a primary key); create tables and edit the structure |
| **SQL editor** | runs as the database owner (bypasses RLS, shown as a "Full access" notice), or as a visitor or a chosen signed-in user to try the access rules (D94); Ctrl+Enter runs the query, or only the selection; a failed statement is underlined in the editor; a status bar with cursor position and run limits; results fold away until the first run; drafts are named by what they do ("Query on orders"); saved queries are renamed by clicking their title |
| **Migrations** | panel changes not yet in a migration and the project's migrations, with "Generate migration" |
| **Storage** | buckets with file count, size, limit and accepted types (create, edit, delete when empty); a file browser by folder: upload by selection or drop, per-file progress (asks before replacing), preview, download, copy the public URL, delete. Passive image formats and PDFs up to 20 MB can be previewed; plain text, CSV and JSON up to 1 MB. PDFs open in the browser viewer. Files go through the same checks as the API ([storage.md](storage.md)) |
| **Users** | search by email, how each account signs in (password, Google, GitHub, or email links only), last sign-in, active sessions, unconfirmed emails; create a user, confirm an email, reset a password (ends their sessions), end sessions or delete a user |
| **Policies** | each table's policies (\`USING\`/\`WITH CHECK\`): create, edit and delete; tables without RLS; functions \`anon\` can execute |
| **API** | section navigation, project address, how each role calls the API, curl and JavaScript examples generated from each table's columns, service_role token. Topic, language and table are shareable through the URL |

## Connecting an app and understanding access

- **API → Connect with the SDK**: install command, a **Download database.ts**
  button (the same file \`nelcota types\` writes) and the \`createClient\` lines
  for this project. The examples switch between the TypeScript SDK (default),
  curl and plain \`fetch\`, generated from the chosen table's columns.
- **User sign-in**: which ways in are on (sign-up, email confirmation,
  password recovery, magic link, Google, GitHub), and for each one that is off
  the environment variables that turn it on. With a provider on, it shows the
  callback address to register with Google or GitHub and the app pages a
  sign-in may return to. Read-only: these settings live in the server's
  \`.env\`.
- **Tables → View as**: reads the grid as a visitor or as a chosen user, with
  the same role, claims, grants and RLS the API applies, in a transaction that
  is rolled back. It is read-only; a role without a GRANT gets a plain
  explanation instead of rows.
- **Storage → a bucket → Who reaches the files**: the policies on
  \`storage.objects\` that apply to the bucket, in plain language, and templates
  to add more (anyone or signed-in users download, signed-in users upload,
  each user only their own folder or their own files). They are created like
  any panel change, so "Generate migration" includes them. A private bucket
  without rules is flagged: only the panel and \`service_role\` reach it.
- **Policies → Recently blocked**: the last 100 API calls answered with 401,
  403 or 429, who made them and why, in plain language. They are kept in
  memory only (gone on restart), with the path but never the query string or
  the token. Reads that RLS filters are not refusals (they return fewer rows)
  and do not show here.

## Guides and references

The book icon in the top bar opens **Guides and references** at \`/admin/guides\`.
The reader includes its registered project guides, JavaScript/TypeScript and
Rust SDK references, SQL examples and server recipes. Repository-only references
and historical reports are not automatically added to the reader. Search matches the full text,
code blocks have copy buttons, and a table of contents links to each section.
On phones, a guide selector replaces the sidebar. Guides and references follow
the panel language, with Portuguese translations of the English sources. Code
examples, inline code, URLs and section identifiers remain unchanged. Translations
live in \`docs/i18n/pt-BR/\`; \`npm run guides:check\` verifies every prose fragment
against its source and fails on missing or outdated translations. Code-only
changes flow straight from the source without requiring a translation update.

SDK help on the API page and the S3 guide on the Storage page open in this
reader. Links between repository documents stay in the panel, including
section links that can be shared and survive a reload. Registered sources and images are bundled, so reading those needs no GitHub
access. The longer Notes staging guide opens on GitHub. Some unregistered
repository links are not supported by the current reader; consult the repository
for them.

**API → OpenAPI documentation**, also available from the command palette,
opens the live reference inside the panel. It fetches \`/rest/v1/\` as \`anon\`,
shows available routes, parameters, request bodies, responses and schema models,
and can download the complete JSON. The panel administrator session does not
grant extra API privileges. An empty catalog points to the table access screen;
a failed request can be retried.

## RLS warnings

- **without RLS**: a regular table with a GRANT to \`anon\` or \`authenticated\`
  and RLS off. Whoever has the GRANT sees and changes **every** row. Shown
  prominently at the top of the panel and on the policies page.
- **RLS without policies**: RLS on and no policy. Nobody but \`service_role\`
  (and the owner) has access: it is safe, but maybe not what you want.

## Changing the admin password

\`\`\`sh
nelcota admin-password            # single login: new host password, applied to every project
nelcota -p shop admin-password    # per-project login: new password for the shop only
\`\`\`

You can also use an argon2id hash (PHC format) generated by any tool:
\`NELCOTA_ADMIN_PASSWORD_HASH='$argon2id$...'\` in the \`.env\` (in single quotes
because of the \`$\`), followed by \`docker compose up -d --force-recreate app\`.

## Security

- Session cookie \`HttpOnly\`, \`SameSite=Strict\` and \`Secure\` behind Caddy;
  in-memory sessions valid for 12 h (restarting the server signs everyone out).
- Login attempts limited to 10 per minute.
- The page itself contains no data: everything comes from \`/admin/api/*\`,
  which requires the session. Every state-changing request must come from the
  same origin.
- CSP without inline scripts (\`script-src 'self'\`), \`X-Frame-Options: DENY\`.
- Svelte escapes interface text. The guide reader renders Markdown with raw HTML
  escaped and unsafe links rejected; code examples are rendered as text.
- DDL made by the panel (tables, columns, policies): the interface sends a
  typed specification, and the server builds the SQL with identifiers always
  quoted and types from a closed list. Expressions (\`DEFAULT\`, \`USING\`,
  \`WITH CHECK\`) are SQL by nature: each statement goes through the extended
  protocol, which refuses a second statement hidden in the expression, and
  everything runs in one transaction (or nothing is applied). The SQL is shown
  before running.
- Foreign keys from the form only point into the exposed schema (for
  \`auth.users\`, use the SQL editor).
- The SQL editor uses a new connection per run and the SQL text does not go to
  the log.
- \`service_role\` tokens issued by the panel are neither stored nor logged
  (only the fact and the validity).
- Without \`NELCOTA_ADMIN_EMAIL\` and \`NELCOTA_ADMIN_PASSWORD_HASH\`, the panel is
  off (the \`/admin\` routes do not even exist).

## Panel development

\`\`\`sh
cd crates/admin/ui
npm ci
npm run dev        # http://127.0.0.1:5173/admin/; proxy: http://127.0.0.1:8000
npm run check      # types (svelte-check)
npm run build      # generates dist/ (versioned and embedded in the binary)
\`\`\`

After bundled guide/UI changes, run \`npm run build\` and rebuild the binary
(\`cargo build --locked -p nelcota-server\`). Commit generated \`dist/\` in its own
build commit. CI checks it for drift. Set \`NELCOTA_API_URL\` when Vite should
proxy another backend.

Interface texts live in \`src/lib/i18n/messages/<area>.ts\`, with a Portuguese
(\`pt-BR\`) and an English (\`en\`) object; the English one is typed against the
Portuguese one, so a missing key fails \`npm run check\`. Never hardcode a
user-facing string in a component.

## Related guides

See [deploy](deploy.md), [auth](schema-auth.md), [storage](storage.md) and [troubleshooting](troubleshooting.md).

## Host projects in the controller

The Unreleased host controller adds project creation, paired backups, restore
and removal with visual review, typed confirmation, operator reauthentication
and durable recovery. It uses a separate HTTPS origin and SSH-granted host
authority. The Projects page links to this controller when enrolled.
Deployment, supported layouts and activation are described in \`docs/host-management.md\`.
`,Ge=`# Quickstart: local development

Create a local application, make an authenticated request and read your own
rows through PostgreSQL RLS. For production HTTPS, use [deploy.md](deploy.md).

You need Docker, \`curl\` and \`jq\`. The optional JavaScript client needs Node 22+;
Rust client development needs Rust 1.88+. Building the server from source needs
the pinned Rust 1.99.0 toolchain. The binary needs no Node runtime.

## 1. Install the binary

On Linux with Docker already installed:

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | NELCOTA_SKIP_DOCKER=1 sh
nelcota --version
\`\`\`

This installs the latest published release, currently 0.4.0. To build that
release on macOS/Windows with Rust 1.99+:

\`\`\`sh
cargo install --locked --git https://github.com/Nelcota/Nelcota --tag v0.4.0 nelcota-server
\`\`\`

For this checkout, run \`cargo build --locked -p nelcota-server\` and use the
absolute path to \`target/debug/nelcota\` in place of \`nelcota\`. Unreleased features
are listed in the server changelog. See [Notes staging](onboarding/notes.md)
for separate published/candidate acceptance.

## 2. Start the development environment

Use a fresh application directory outside Nelcota's repository:

\`\`\`sh
mkdir notes-app && cd notes-app
nelcota dev
\`\`\`

The command starts PostgreSQL 17 in \`nelcota-dev-postgres-54322\`, stores data
in a Docker volume, applies internal migrations and serves the API in the
foreground. The API is at \`http://127.0.0.1:8000\`, and the panel is at \`/admin/\`.
Its account is \`admin@localhost\`; read \`ADMIN_PASSWORD\` locally from
\`.nelcota/dev.env\`. Do not share that file.

Generated database passwords, signing keys and panel credentials persist in
that owner-readable, Git-ignored file. Repeating \`dev\` reuses them. Use
\`--listen 127.0.0.1:9000\` or \`--db-port 54323\` for free ports; changing the database
port selects another container/volume, rather than moving data. Ctrl+C stops
the API; the database container and its data remain until you stop/remove them.

\`dev\` enables disk storage and leaves SMTP/email confirmation off. Signup
therefore returns a session immediately. It uses generated settings, not your
application's \`.env\` overrides.

## 3. Write a migration

Keep \`dev\` running. Open a second terminal in \`notes-app\`. This file contains
the schema used by the SDK examples, including \`extra\` and the private \`files\`
bucket. Do this once in a fresh database:

\`\`\`sh
mkdir -p migrations src
cat > migrations/V1__notes.sql <<'SQL'
CREATE TABLE public.notes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner uuid NOT NULL DEFAULT auth.uid(),
    body text NOT NULL,
    extra jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;
CREATE POLICY notes_owner ON public.notes FOR ALL TO authenticated
    USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
INSERT INTO storage.buckets (id, public) VALUES ('files', false);
CREATE POLICY notes_files_owner ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text);
SQL
\`\`\`

For an existing schema, use the repeatable [examples/notes.sql](../examples/notes.sql)
or a new migration adding missing columns. \`CREATE TABLE IF NOT EXISTS\` does
not add columns to an existing table. A GRANT permits an operation, RLS enables
row filtering, and a policy defines accessible rows.

## 4. Apply it

\`\`\`sh
nelcota migrate
nelcota migrate
\`\`\`

The first run applies the file and records its checksum in
\`nelcota.user_migrations\`; the second is a no-op. The API reloads its catalog
without restarting. Never edit an applied migration: add \`V2__...\` instead.
The repository-root \`migrations/\` contains internal SQL, not your app schema.

## 5. Generate types

\`\`\`sh
nelcota types -o src/database.ts
nelcota types --lang rust -o src/database.rs
\`\`\`

Regenerate after schema changes. Generators describe the running server's schema;
consumer compilation does not connect to your database.

## 6. Use it from the client

First make an authenticated request using only \`curl\` and \`jq\`:

The catalog reloads asynchronously after migration. The bounded read below
waits for \`notes\` before sending a write; an error other than 404 stops the
example. Mutations are sent once.

\`\`\`sh
set -eu
SESSION=$(curl -fsS -X POST http://127.0.0.1:8000/auth/v1/signup \\
  -H 'content-type: application/json' \\
  -d '{"email":"ana@example.com","password":"a-development-password"}')
TOKEN=$(printf '%s' "$SESSION" | jq -er '.access_token')
NELCOTA_SCHEMA_READY=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  NELCOTA_READ_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \\
    http://127.0.0.1:8000/rest/v1/notes -H "authorization: Bearer $TOKEN")
  if [ "$NELCOTA_READ_STATUS" = 200 ]; then NELCOTA_SCHEMA_READY=1; break; fi
  [ "$NELCOTA_READ_STATUS" = 404 ] || { printf '%s\\n' 'Readiness request failed' >&2; exit 1; }
  sleep 0.2
done
[ "$NELCOTA_SCHEMA_READY" = 1 ] || { printf '%s\\n' 'Schema is not ready' >&2; exit 1; }
curl -fsS -X POST http://127.0.0.1:8000/rest/v1/notes \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -H 'prefer: return=representation' -d '{"body":"My first note"}'
curl -fsS 'http://127.0.0.1:8000/rest/v1/notes?order=id.desc' \\
  -H "authorization: Bearer $TOKEN"
\`\`\`

Use this password only for the local example. If the account exists, sign in
with \`POST /auth/v1/token?grant_type=password\` and the same JSON body instead
of signing up again. Another user's token returns none of Ana's notes.
On a project with confirmation enabled, confirm the email and sign in before
extracting an access token.

For a runnable JavaScript client, install the published package:

\`\`\`sh
npm init -y
npm install @nelcota/client@0.1.2
cat > client.mjs <<'JS'
import { createClient, unwrap } from '@nelcota/client';
const client = createClient('http://127.0.0.1:8000');
try {
  unwrap(await client.auth.signInWithPassword({
    email: 'ana@example.com', password: 'a-development-password',
  }));
  const { data } = await client.from('notes').select('id,body,created_at')
    .order('id', { ascending: false }).throwOnError();
  console.log(data);
} finally { client.dispose(); }
JS
node client.mjs
\`\`\`

In a TypeScript application, import \`Database\` from the generated file and use
\`createClient<Database>(url)\` with your framework's TypeScript build configuration.
The [TypeScript SDK](../sdk/typescript/README.md) explains published versus source
behavior. The [Rust SDK](../sdk/rust/README.md) uses the same Notes schema.

> **Warning:** \`service_role\` bypasses RLS. Never use it in a browser or mobile
> client; use each user's access token.

## Troubleshooting

For occupied ports, select free API/database ports before startup. For
\`user_already_exists\`, sign in to the existing account. For empty rows, 401/403
or missing columns, check [troubleshooting.md](troubleshooting.md).
Creating \`.env\` alone does not configure \`nelcota serve\`: it reads process
variables and optional TOML. Host Compose/systemd and \`dev\` load their own settings.

## Next

- Query syntax and errors: [api.md](api.md).
- Files and policies: [storage.md](storage.md).
- SDKs: [TypeScript](../sdk/typescript/README.md) and [Rust](../sdk/rust/README.md).
- Production: [deploy.md](deploy.md). Installation/restart checks: [Notes staging](onboarding/notes.md).
`,Ke='# The `auth` schema\n\nA public, stable contract. Every table is ordinary SQL: you can read, export\nand migrate it without Nelcota (see [leaving.md](leaving.md)).\n\nThe tables are **not** exposed by the REST API. The server reaches them with\nthe internal role `nelcota_auth`, which no JWT can assume. `anon`,\n`authenticated` and `service_role` have no GRANT on them (there is a test for\nthat).\n\n## Prerequisites\n\nYou need a running initialized server. Password login is available by default;\nSMTP/link pages and OAuth providers are optional configuration groups. Schema\nand endpoint examples describe current source, with release differences tracked\nin the server changelog. Never expose database password hashes or link tokens.\n\n## `auth.users`\n\n| Column | Type | Notes |\n|---|---|---|\n| `id` | `uuid` PK | `gen_random_uuid()`; it is the JWT `sub` and `auth.uid()` |\n| `email` | `text` unique | always lowercase, ≤ 254 characters |\n| `encrypted_password` | `text` | **argon2id PHC string** (see below); `NULL` = no password |\n| `email_confirmed_at` | `timestamptz` | set when the person opens a signup confirmation, magic or recovery link (proves they receive the email) |\n| `raw_user_meta_data` | `jsonb` | the signup `data` field; returned as `user_metadata` |\n| `created_at`, `updated_at` | `timestamptz` | |\n| `last_sign_in_at` | `timestamptz` | updated on every login |\n\n### Password format\n\nAccount emails use a simple mailbox address: a dot-atom ASCII local part (up\nto 64 bytes), a DNS domain with nonempty labels, and at most 254 bytes overall.\nSurrounding spaces are trimmed and the address is lowercased. Controls, display\nnames, quoted local parts and consecutive dots are rejected before hashing or\nquerying the database, using the same rule for public auth and panel accounts.\nInternational domains can use their ASCII/Punycode form. Existing malformed\naddresses are not renamed automatically; an administrator should verify\nownership before repairing such a row in SQL.\n\nThe server shares one bounded Argon2 worker budget between public auth, panel\nlogin and account administration. Panel login rate limits apply per client IP;\nforwarded headers are used only when `trust_proxy` is configured.\n\n```\n$argon2id$v=19$m=19456,t=2,p=1$<salt base64>$<hash base64>\n```\n\nIt is the standard PHC format. The parameters (19 MiB, 2 iterations,\nparallelism 1) follow the OWASP recommendation. It works directly with any\nargon2 library: Python `argon2-cffi` (`PasswordHasher().verify(hash,\npassword)`), Node `argon2` (`argon2.verify(hash, password)`), Go\n`alexedwards/argon2id`, PHP `password_verify()`, Keycloak/Authentik via import.\n\n## `auth.sessions`\n\nOne row per login.\n\n| Column | Type | Notes |\n|---|---|---|\n| `id` | `uuid` PK | goes into the JWT as the `session_id` claim |\n| `user_id` | `uuid` → `auth.users` | `ON DELETE CASCADE` |\n| `created_at`, `refreshed_at` | `timestamptz` | |\n| `revoked_at` | `timestamptz` | logout or detected refresh token reuse |\n| `user_agent`, `ip` | `text`, `inet` | informative |\n\n## `auth.refresh_tokens`\n\n| Column | Type | Notes |\n|---|---|---|\n| `id` | `bigint` PK | |\n| `session_id` | `uuid` → `auth.sessions` | the token\'s "family" |\n| `token_hash` | `bytea` unique | **SHA-256** of the opaque token; the token itself is never stored |\n| `revoked` | `boolean` | `true` once used (rotation) |\n| `created_at`, `expires_at` | `timestamptz` | default validity: 30 days |\n\n### Rotation and reuse detection\n\n1. `POST /auth/v1/token?grant_type=refresh_token` with token R1.\n2. R1 valid → marked `revoked = true`; R2 is issued in the same session.\n3. If R1 is used **again** (someone has a copy), the whole session is revoked:\n   R2, R3... stop working. The user\'s other sessions continue.\n\n**Retry grace window.** A client that lost the answer to step 2 (network drop,\ntwo tabs refreshing at once) still holds only R1. For **10 seconds** after the\nrotation, presenting R1 again is treated as a retry: the server revokes R2 (and\nany other live token of the session issued after R1) and answers with a fresh\npair for the **same session**. Retries never extend the window, which counts\nfrom the original rotation (its `refreshed_at`). Once R2\'s successor has been\nrotated in turn, or after the window, R1 is reuse again and step 3 applies.\nThe client should still serialize refreshes; the window only absorbs retries.\n\n### Cleanup\n\nOnce an hour the server deletes refresh tokens past `expires_at` (a rotated\ntoken stays until then, so reuse is still detected), sessions left without\nany token, and sessions revoked more than 7 days ago (with their tokens).\nNothing that could still sign anyone in is removed.\n\n## `auth.one_time_tokens`\n\nLinks sent by email: password recovery, signup confirmation and magic link.\n\n| Column | Type | Notes |\n|---|---|---|\n| `id` | `bigint` PK | |\n| `user_id` | `uuid` → `auth.users` | `ON DELETE CASCADE` |\n| `kind` | `text` | `recovery`, `signup` or `magiclink`; a token only works as its kind |\n| `token_hash` | `bytea` unique | **SHA-256** of the token; the token itself is never stored |\n| `created_at`, `expires_at` | `timestamptz` | validity: recovery 1 hour, signup 24 hours, magic link 15 minutes |\n| `used_at` | `timestamptz` | set on use; the link does not work again |\n\n## `auth.identities`\n\nAccounts at sign-in providers linked to a user (see\n[Sign-in with Google or GitHub](#sign-in-with-google-or-github)).\n\n| Column | Type | Notes |\n|---|---|---|\n| `id` | `uuid` PK | |\n| `user_id` | `uuid` → `auth.users` | `ON DELETE CASCADE` |\n| `provider` | `text` | `google` or `github` |\n| `provider_id` | `text` | the provider\'s account id (`sub`); unique per provider |\n| `email` | `text` | the email the provider reported at the last sign-in |\n| `identity_data` | `jsonb` | the provider\'s profile as received |\n| `created_at`, `updated_at`, `last_sign_in_at` | `timestamptz` | |\n\n## `auth.flow_states`\n\nProvider sign-ins in progress; each row lives minutes.\n\n| Column | Type | Notes |\n|---|---|---|\n| `state_hash` | `bytea` unique | **SHA-256** of the `state` sent to the provider |\n| `provider` | `text` | |\n| `provider_verifier` | `text` | PKCE verifier toward the provider; atomically cleared when claiming the callback, before HTTP exchange |\n| `code_challenge` | `text` | the app\'s S256 challenge |\n| `redirect_to` | `text` | the app page to return to |\n| `auth_code_hash` | `bytea` unique | **SHA-256** of the code handed to the app |\n| `user_id` | `uuid` → `auth.users` | set when the provider answers |\n| `created_at`, `expires_at` | `timestamptz` | 10 minutes at the provider, then 5 to redeem the code |\n\nOnly one callback can claim a state, even while the provider is still\nresponding. Failed or cancelled exchanges require a new `/authorize`; no\ndatabase transaction remains open during provider HTTP requests. Callback\nrequests have a separate per-IP budget from `/authorize`.\n\nIn-memory limiters track at most 50,000 keys. At capacity they reject new\nkeys with `429` and a one-second retry hint, while existing keys keep their\nindependent quotas. Cleanup runs at most once per second under capacity\npressure and removes only keys idle since their last accepted request for\na full minute, enough to recover the complete GCRA burst.\n\n## Endpoints\n\n| Method and route | Body | Response |\n|---|---|---|\n| `POST /auth/v1/signup` | `{email, password, data?}` | 201 + session (201 `{user}` with email confirmation on) |\n| `POST /auth/v1/token?grant_type=password` | `{email, password}` | 200 + session |\n| `POST /auth/v1/token?grant_type=refresh_token` | `{refresh_token}` | 200 + session |\n| `POST /auth/v1/token?grant_type=pkce` | `{auth_code, code_verifier}` | 200 + session |\n| `GET /auth/v1/authorize` | `?provider&redirect_to&code_challenge&code_challenge_method=S256` | 303 to the provider |\n| `GET /auth/v1/callback` | (the provider\'s redirect) | 303 to `redirect_to?code=...` or `?error=...` |\n| `POST /auth/v1/logout` | Bearer | 204 (revokes the session) |\n| `GET /auth/v1/user` | Bearer | user data |\n| `PUT /auth/v1/user` | Bearer + `{password?, current_password?, data?}` | 200 + user data (see [Updating the signed-in user](#updating-the-signed-in-user)) |\n| `GET /auth/v1/.well-known/jwks.json` | - | public JWKS |\n| `POST /auth/v1/recover` | `{email}` | 200 `{}` (whether or not the account exists) |\n| `POST /auth/v1/magiclink` | `{email}` | 200 `{}` (whether or not the account exists) |\n| `POST /auth/v1/resend` | `{type: "signup", email}` | 200 `{}` (whether or not the account exists) |\n| `POST /auth/v1/verify` | `{type: "recovery", token, password}` or `{type: "signup" \\| "magiclink", token}` | 200 + session |\n\nSession:\n\n```json\n{\n  "access_token": "<JWT>",\n  "token_type": "bearer",\n  "expires_in": 900,\n  "expires_at": 1767225600,\n  "refresh_token": "<opaque>",\n  "user": { "id": "...", "email": "...", "user_metadata": {}, "created_at": "...", "last_sign_in_at": "...", "email_confirmed_at": null }\n}\n```\n\nErrors: `422 invalid_email` or `422 weak_password` (email or password outside\nthe rules), `422 validation_failed` (a value the endpoint requires is missing,\nsuch as `refresh_token`), `400`/`422 invalid_body` (the body is not JSON or a\nfield has the wrong type), `409\nuser_already_exists`, `400 invalid_grant` (invalid credentials or refresh, with\nthe same message for an unknown email and a wrong password), `429\nrate_limited` with `Retry-After`, `403 signup_disabled`, `400\nemail_not_confirmed` (correct password, email confirmation pending).\n\nLinks: `403 recovery_disabled`, `confirmation_disabled` or `magiclink_disabled`\n(the project has not configured that flow), `400 invalid_grant` (invalid,\nexpired, already used or other-kind link), `400 unsupported_type`.\n\nEmail flows share **16 delivery slots** per process and a **30-second** total\nsend deadline, including custom mailers. Overload returns `503 mail_busy`\nbefore creating an account or issuing a token, with the same response for\nexisting and unknown accounts. An admitted background send owns its slot until\nit completes or times out.\nSMTP errors and timeouts are logged; sending remains a best-effort background\noperation rather than a durable delivery queue.\n\nPassword: 8 to 256 characters. Password login has hard limits of\n`NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` per IP (default 30) and per normalized\nemail/IP pair. All attempts count, including successful and unknown-account\nattempts. Each bucket allows a burst of that size and refills continuously\nat that many attempts per minute; the shared per-IP budget remains unchanged.\n\nThe account aggregate uses the same quota for backpressure, rather than hard\nrejection: excess attempts wait 125, 250, 500, 1,000, then at most 2,000 ms.\nA refill admission resets the delay progression. Waiting holds neither a DB\nconnection nor a password worker. A correct login from an independent source\nwith available IP/pair budgets inherits at most two seconds of throttle delay,\neven during continuing account-targeted abuse. Normal request deadlines,\nworker admission/overload responses and bounded limiter capacity still apply.\n\nTrade-off: a strict account-wide verification ceiling cannot also guarantee\nadmission of an unrecognized legitimate source when attackers continuously\nspend that ceiling. Distributed sources can now exceed the former aggregate\nceiling; each source and email/source pair retain the original hard quota.\nThe aggregate delay is backpressure, not a distributed brute-force ceiling.\nKeep trusted proxy configuration and upstream abuse controls; limits are per\nprocess and shared NAT users still share their IP budget.\n\nRefreshes and PKCE redemptions (`grant_type=refresh_token` / `pkce`) draw from\na separate per-IP budget of 10 times that (300 by default), so open tabs\nrefreshing do not use up the password sign-in budget.\n\n## Updating the signed-in user\n\n`PUT /auth/v1/user` with the user\'s access token changes their own account.\nSend at least one of:\n\n- `data`: merged into `user_metadata` (`raw_user_meta_data`) one level deep:\n  the keys sent replace the stored ones, the others stay, and a key sent as\n  `null` is removed. `{"data": {"plan": "pro", "tmp": null}}`.\n- `password` (same rules as signup): requires `current_password` when the\n  account already has a password (`422 validation_failed` without it, `400\n  invalid_grant` when wrong). An account without one (magic link or provider\n  sign-in) can set it directly. The user\'s **other** sessions are revoked;\n  the calling session and its refresh token keep working. Attempts count\n  against the per-minute limit, per user.\n\nThe access token\'s session must still be active (not logged out or revoked):\notherwise `401 invalid_token`. The response is the updated user, as in `GET\n/auth/v1/user`. Changing the email is not supported yet (it needs a\nconfirmation of the new address); an administrator can change it in SQL.\n\nPassword replacement through the signed-in account, recovery completion or\npanel administration retires that user\'s pending email credentials and OAuth\ncodes in the same transaction. Existing token issuance history remains for\nemail send cooldowns; unrelated accounts are unchanged. Account-row locking\nserializes replacement with credential redemption. A database error rolls\nback the password, session and pending-credential changes together.\n\n## Password recovery\n\nOff until the project configures SMTP (Nelcota has no mail server of its own;\nuse your provider\'s: Postmark, SES, Resend...). In the project\'s `.env`, all\nthree together:\n\n```sh\nNELCOTA_SMTP_URL=smtps://user:password@smtp.example.com:465   # or smtp://...:587?tls=required\nNELCOTA_SMTP_FROM=\'Shop <no-reply@shop.com>\'\nNELCOTA_PASSWORD_RECOVERY_URL=https://app.shop.com/new-password\n```\n\nA half-configured setup stops the server from starting (better than finding\nout on the first "forgot my password").\n\nWhen SMTP is disabled, there is no self-service email reset. An operator must\nverify the account owner\'s identity through a separate trusted channel, sign\nin to the project panel, open **Users**, select the account and reset its\npassword. Deliver the replacement privately. This ends refresh sessions but\ndoes not erase IP/pair throttle state or revoke existing access JWTs before\nexpiry. Stop abusive sources at the trusted ingress, then retry from an\nindependent source or allow at most 60 seconds without new attempts for full\nbucket refill. There is no persistent account lock to unlock. Do not restart\nthe service or disable limits as a recovery shortcut.\n\n1. The app calls `POST /auth/v1/recover {email}`. The answer is always\n   `200 {}`, so it does not reveal who has an account. If the account exists,\n   an email arrives (in English, subject "Reset your password") with the link\n   `https://app.shop.com/new-password#type=recovery&token=...`.\n2. That app page reads the token from the fragment (`location.hash`), asks for\n   the new password and calls `POST /auth/v1/verify {type: "recovery", token,\n   password}`.\n3. The response is a session (same format as login): the person is signed in.\n\nGuarantees:\n\n- The token travels in the URL fragment, which the browser sends to no server:\n  it does not show up in logs or in the `Referer`.\n- It is valid for 1 hour and only once. Asking again voids the previous link.\n- At most one email per minute for the same account, on top of the per-IP\n  rate limit: the endpoint cannot be used to flood someone\'s inbox.\n- The email goes out in the background: response time does not reveal whether\n  the account exists, and an SMTP failure goes to the log instead of becoming\n  an error.\n- Changing the password ends every session of the account (refresh tokens stop\n  working immediately; access JWTs already issued stay valid until they\n  expire).\n\n## Signup confirmation\n\nOff by default. With SMTP configured, setting the page that receives the link\nturns it on:\n\n```sh\nNELCOTA_EMAIL_CONFIRMATION_URL=https://app.shop.com/welcome\n```\n\n1. `POST /auth/v1/signup` creates the account and answers `201 {"user": {...}}`\n   **without** a session; an email ("Confirm your email") carries\n   `https://app.shop.com/welcome#type=signup&token=...`, valid for 24 hours.\n2. The page reads the token from the fragment and calls `POST /auth/v1/verify\n   {type: "signup", token}`: the email is confirmed and the answer is a session.\n3. Until then, password sign-in answers `400 email_not_confirmed`, only after a\n   correct password. `POST /auth/v1/resend {type: "signup", email}` sends a new\n   link to an unconfirmed account (same cooldown and `200 {}` as recovery).\n\nOpening a magic or recovery link also confirms the email. Accounts that were\nalready unconfirmed when the flow was turned on are held as well; mark them\nwith "Confirm email" on the panel\'s Users page (or `UPDATE auth.users SET\nemail_confirmed_at = now()`) if they should keep signing in. Accounts created\nin the panel are confirmed from the start.\n\nWhen recovery first confirms an account, it removes provider identities and\npending OAuth/email codes established before that inbox proof, revokes previous\nsessions and installs the owner\'s new password in the same transaction.\nRecovery of an already confirmed account preserves its linked providers while\nstill changing the password and revoking the existing sessions.\n\n## Magic link\n\nPasswordless sign-in for existing accounts, on when its page is configured:\n\n```sh\nNELCOTA_MAGIC_LINK_URL=https://app.shop.com/signed-in\n```\n\n1. `POST /auth/v1/magiclink {email}` always answers `200 {}`. If the account\n   exists, an email ("Your sign-in link") carries\n   `https://app.shop.com/signed-in#type=magiclink&token=...`, valid for 15\n   minutes.\n2. The page calls `POST /auth/v1/verify {type: "magiclink", token}` and gets a\n   session; the email counts as confirmed.\n\nOn the first proof of inbox ownership, a magic link clears any password from\nthe unconfirmed signup and revokes its earlier sessions, provider identities,\npending OAuth codes and email links. Someone else may have registered that\naddress. The inbox owner can set\na new password through recovery. Already confirmed accounts keep their\npassword and sessions; signup confirmation still approves its signup password.\nRevoked sessions cannot refresh, while previously issued access JWTs retain\ntheir normal expiry (as for logout and password recovery).\n\nIt does not create accounts: an email request would otherwise let anyone\nreserve addresses before their owners sign up. Same guarantees as recovery:\ntoken only in the fragment, one use, one email per minute per account,\nsending in the background.\n\n## Sign-in with Google or GitHub\n\nOff until a provider is configured. Register an OAuth app at the provider with\nthe callback `https://<api domain>/auth/v1/callback`, then:\n\n```sh\nNELCOTA_API_URL=https://api.shop.com\nNELCOTA_OAUTH_REDIRECT_URLS=https://shop.com/auth,http://localhost:5173/auth\nNELCOTA_OAUTH_GOOGLE_CLIENT_ID=...\nNELCOTA_OAUTH_GOOGLE_CLIENT_SECRET=...\nNELCOTA_OAUTH_GITHUB_CLIENT_ID=...\nNELCOTA_OAUTH_GITHUB_CLIENT_SECRET=...\n```\n\nA half-configured provider, or a provider without the two URLs, stops the\nserver from starting.\n\n1. The app creates a PKCE pair: a random `code_verifier` (43 to 128\n   characters) kept in the browser and `code_challenge =\n   base64url(SHA-256(code_verifier))`. It sends the person to\n   `GET /auth/v1/authorize?provider=github&redirect_to=https://shop.com/auth&code_challenge=...&code_challenge_method=S256`.\n2. After the provider, the person lands on\n   `https://shop.com/auth?code=...` (or `?error=...`).\n3. The page calls `POST /auth/v1/token?grant_type=pkce {auth_code,\n   code_verifier}` and gets a session (same format as login).\n\nErrors on `redirect_to`: `access_denied` (the person declined),\n`provider_error`, `email_conflict` (the provider did not verify an email that\nbelongs to an account), `email_required` (the provider gave no email),\n`signup_disabled`. `/authorize` answers `400 redirect_not_allowed`, `400\ninvalid_code_challenge` or `403 provider_disabled`; `/callback` answers `400\ninvalid_state` for an unknown, expired or already answered sign-in.\n\nWhich account opens:\n\n- a provider account already linked: its user, even if the email changed at\n  the provider;\n- an email the provider **verified** that matches a confirmed account: that\n  account, which gains the identity (its password keeps working);\n- a verified email that matches an **unconfirmed** account: the verified owner\n  takes it over; the previous password, sessions, provider identities and\n  pending email/OAuth codes are removed, then the verified identity is linked,\n  since whoever created it may not own the address;\n- an unverified email that matches an account: refused (`email_conflict`);\n- no account: a new one without password, confirmed when the provider verified\n  the email, with `user_metadata` `name` and `avatar_url` from the provider.\n\nGuarantees: `redirect_to` must sit under one of `NELCOTA_OAUTH_REDIRECT_URLS`\n(same origin, path below), so the endpoint cannot redirect elsewhere. The\ncode in the app\'s URL works once, for 5 minutes, and only with the verifier\nthe app kept. Nelcota uses its own PKCE and `state` toward the provider and\ntalks to it only server to server.\n\n## Related guides\n\nSee [JWT/roles](jwt-and-roles.md), [REST API](api.md) and [troubleshooting](troubleshooting.md).\n',qe=`# Storage

Files with the same rule as everything else: **Postgres decides access.**
Each file is a row in \`storage.objects\`; RLS policies on that table say who
may upload, read, replace or delete it. The bytes live on the server's disk
or in any S3-compatible bucket. The design and its reasons are D77–D80 in
[decisions.md](decisions.md).

## Prerequisites

You need initialized storage metadata, an enabled disk/S3 backend and policies
for your caller. Examples assume an authenticated user and explicit bucket setup.
This page describes source behavior; check the matching release for published
limits and fixes. Keep provider secrets in the private deployment configuration.

## Turning it on

New projects (\`nelcota init\`) keep files on the project's disk:

\`\`\`sh
NELCOTA_STORAGE_BACKEND=disk
NELCOTA_STORAGE_DIR=/storage        # projects/<name>/storage on the host
\`\`\`

In production, an S3-compatible bucket keeps files off a single disk
(Cloudflare R2, Backblaze B2, AWS S3, Wasabi...):

\`\`\`sh
NELCOTA_STORAGE_BACKEND=s3
NELCOTA_STORAGE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # empty = AWS
NELCOTA_STORAGE_S3_BUCKET=files
NELCOTA_STORAGE_S3_REGION=auto                                          # R2: auto; AWS: us-east-1...
NELCOTA_STORAGE_S3_ACCESS_KEY_ID=...
NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY=...
# NELCOTA_STORAGE_S3_VIRTUAL_HOSTED=true   # bucket.endpoint URLs, if the provider requires them
\`\`\`

Then \`nelcota -p <name> up\`. Without \`NELCOTA_STORAGE_BACKEND\` storage is off
and \`/storage/v1\` does not exist. A project created before storage existed
turns it on by adding the two \`disk\` lines to its \`.env\` and
\`- ./storage:/storage\` to the app's \`volumes\` in \`docker-compose.yml\`
(\`mkdir storage && chown 65532:65532 storage\` first).

On Unix, the CLI creates the disk storage root with mode **0700**, owned by
the app's UID 65532 on Docker hosts. The server also enforces 0700 at startup
on existing roots, before opening the store. This prevents other host users
from reading or enumerating private files, including staged uploads and old
files, regardless of their individual modes. The server must own the root
and be allowed to change its permissions. Windows deployments require the
equivalent directory ACL; Unix modes do not configure Windows ACLs.

| Variable | Default | |
|---|---|---|
| \`NELCOTA_STORAGE_MAX_FILE_SIZE\` | 50 MiB | largest file; a bucket can only lower it |
| \`NELCOTA_STORAGE_MAX_TOTAL_SIZE\` | none | cap on all buckets together, in bytes |
| \`NELCOTA_STORAGE_MIN_FREE_BYTES\` | 1 GiB | disk backend: refuse uploads that would leave less free space |
| \`NELCOTA_STORAGE_UPLOAD_TIMEOUT_SECS\` | 3600 | shared deadline for admission, database/policy waits and receiving bytes |
| \`NELCOTA_STORAGE_PUBLIC_URL\` | the API's | origin of public file URLs, e.g. \`https://files.shop.com\` |

Uploads reserve capacity while their bodies are being received. A request
without \`Content-Length\` reserves up to its allowed file size or the remaining
capacity; another upload may receive 507 until that reservation is released.
The committed total is checked in a serialized database transaction, including
when several server instances share the same database. Replacements receive
credit for their old bytes against the total quota, but still need disk space
for the new version while it is being written.

At most **32 uploads** may be active in a process. Excess attempts return
\`503 upload_busy\` immediately. Admission and byte reception share the configured
deadline, including pool and quota waits (\`408 upload_timeout\`); metadata
publication then settles with database timeouts so cancellation cannot delete
bytes after an ambiguous commit.

Canceled or timed-out multipart uploads abort their uploaded parts in a bounded
cleanup task. Creation and cleanup share the 32-upload capacity; creation may
settle for up to 30 seconds and abort for up to 10 seconds after cancellation.
Configure an S3 \`AbortIncompleteMultipartUpload\` lifecycle rule as well: process
crashes, unavailable providers or an initiation response lost before its upload
ID arrives cannot be cleaned up reliably by the server. Object garbage
collection only sees completed objects, not unfinished multipart parts.

\`storage.usage\` holds the committed byte total. Statement-level triggers update
it transactionally for inserts, updates, deletes, upserts and truncation,
including administrative SQL; bulk statements aggregate their changes once.
Only the internal storage role can read it. No caller role can modify it.
The migration initializes it while metadata writes are locked. If an operator
disabled triggers during maintenance, reconcile before resuming writes:

\`\`\`sql
BEGIN;
LOCK TABLE storage.objects IN SHARE MODE;
UPDATE storage.usage SET bytes = (SELECT coalesce(sum(size), 0)::bigint FROM storage.objects)
WHERE singleton;
COMMIT;
\`\`\`

## Buckets and policies

A bucket is a row in \`storage.buckets\`. Create it in a migration (or with
\`POST /storage/v1/bucket\` as \`service_role\`):

\`\`\`sql
-- migrations/V2__avatars.sql
INSERT INTO storage.buckets (id, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', true, 2097152, '{image/*}');

-- Each user writes only into the folder named after their id.
CREATE POLICY avatar_owner ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
\`\`\`

**Until a policy says otherwise, nobody but \`service_role\` reaches any file.**
\`public\` only opens reads through \`/object/public/\`; writes to a public bucket
still go through the policies.

| Operation | Policies needed |
|---|---|
| upload (\`POST\`) | \`INSERT\` |
| replace (\`PUT\`) | \`INSERT\`, \`SELECT\`, \`UPDATE\` |
| download, sign, list | \`SELECT\` |
| delete | \`SELECT\`, \`DELETE\` |

\`owner\` is filled with \`auth.uid()\` on upload, so \`owner = auth.uid()\` is the
simplest private-files policy. Helpers for paths:
\`storage.foldername('a/b/c.png')\` → \`{a,b}\`, \`storage.filename(...)\` →
\`c.png\`, \`storage.extension(...)\` → \`png\`. A policy sees the final row,
including \`size\`, so a per-user quota is a policy too:

\`\`\`sql
CREATE POLICY quota ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
    WITH CHECK ((SELECT coalesce(sum(size), 0) FROM storage.objects
                  WHERE owner = auth.uid()) + size <= 100 * 1024 * 1024);
\`\`\`

Bucket names: lowercase letters, digits, \`-\` and \`_\`; \`public\`, \`sign\` and
\`list\` are reserved. A bucket with files cannot be dropped.

## HTTP API

Every route takes the usual \`Authorization: Bearer <jwt>\` (none = \`anon\`).
Paths are percent-encoded; segments cannot be empty, \`.\` or \`..\`.

\`\`\`sh
# upload (409 if the name exists; PUT replaces)
curl -X POST "$API/storage/v1/object/avatars/$USER_ID/me.png" \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: image/png' --data-binary @me.png
# {"id":"...","bucket":"avatars","name":"<id>/me.png","size":48213,
#  "mime_type":"image/png","etag":"...","public_url":"/storage/v1/object/public/avatars/<id>/me.png"}

curl "$API/storage/v1/object/avatars/$USER_ID/me.png" -H "authorization: Bearer $TOKEN"   # download
curl "$API/storage/v1/object/public/avatars/$USER_ID/me.png"                               # public bucket
curl -X DELETE "$API/storage/v1/object/avatars/$USER_ID/me.png" -H "authorization: Bearer $TOKEN"
\`\`\`

| Route | |
|---|---|
| \`POST /storage/v1/object/{bucket}/{path}\` | upload a new file (201) |
| \`PUT /storage/v1/object/{bucket}/{path}\` | upload or replace (200 replaced, 201 created) |
| \`GET /storage/v1/object/{bucket}/{path}\` | download under the caller's policies |
| \`GET /storage/v1/object/public/{bucket}/{path}\` | download from a public bucket, no token |
| \`POST /storage/v1/object/sign/{bucket}/{path}\` | \`{"expires_in": 3600}\` → \`{"signed_url": "..."}\` (up to 7 days) |
| \`GET /storage/v1/object/sign/{bucket}/{path}?token=...\` | download with a signed URL, no token |
| \`POST /storage/v1/object/list/{bucket}\` | \`{"prefix": "a/", "limit": 100, "offset": 0}\` → \`{"folders": [...], "objects": [...]}\` |
| \`DELETE /storage/v1/object/{bucket}/{path}\` | delete (204) |
| \`GET/POST /storage/v1/bucket\`, \`GET/PUT/DELETE /storage/v1/bucket/{id}\` | buckets (writes: \`service_role\`) |

Listing applies \`limit\` and \`offset\` independently to the sorted \`folders\` and
\`objects\` arrays. Advance the offset by the requested limit while either array
fills a page; a page containing only folders can still have a next page.

A file the caller may not see answers 404, as if it did not exist. Downloads
take \`?download\` to force a "save as". Errors: 400 \`invalid_path\`, 404
\`bucket_not_found\`/\`object_not_found\`, 409 \`object_exists\`, 413
\`file_too_large\`, 415 \`mime_type_not_allowed\`, 507 \`storage_full\`. The JSON
endpoints (bucket writes, list, sign) answer 400/422 \`invalid_body\` for a
malformed body and 415 \`unsupported_media_type\` without \`Content-Type:
application/json\`; a range that cannot be served is 416
\`range_not_satisfiable\` (with \`Content-Range: bytes */<size>\`). Every error
has the API's JSON shape (see [api.md](api.md#errors)).

## How files are served

- **The type comes from the bytes**, not from the client: a "PNG" that is
  really HTML is stored as \`text/html\` (and refused by an \`image/*\` bucket).
- **Files are inert.** Every response has \`X-Content-Type-Options: nosniff\` and
  \`Content-Security-Policy: sandbox\`. Only images (not SVG), audio, video and
  plain text open in the browser; HTML, SVG, PDF and the rest download.
  For public files on their own origin, point \`NELCOTA_STORAGE_PUBLIC_URL\` at
  a second domain that proxies \`/storage/v1/object/public/*\` to the app.
- **Disk:** \`Range\` (video seeking, resumed downloads), \`ETag\` and
  \`If-None-Match\`. Public files are cacheable for 60 s; private ones are
  revalidated each time.
- **S3:** downloads are a \`302\` to a presigned URL valid for at most 5 minutes;
  the bytes come straight from the provider.

## Consistency

A file's bytes are stored under a new key (\`<bucket>/<uuidv7>\`) on every
upload, and the row is written only after the bytes are complete. Readers
never see a half-written file, and an upload that fails or is refused leaves
nothing behind. Replacing or deleting a file removes the old bytes right
away: **a database restore does not bring deleted files back**. An hourly
collector removes bytes no row points to once they are a day old (left by a
crash mid-upload).

## Backups

With the disk backend, every dump has its own \`<dump>.files/\` snapshot and
SHA-256 manifest. \`nelcota backup --upload\` uploads that immutable snapshot to
\`s3://<backup bucket>/<project>/<dump>.files/\`. Later file deletions leave older
snapshots intact. After losing the server:

\`\`\`sh
nelcota -p shop restore backups/nelcota-shop-<date>.dump --files --yes
\`\`\`

\`--files\` verifies and restores that dump's snapshot, locally or from the backup
bucket. Keep the \`.dump\` and \`.dump.files/\` directory together. With the S3 backend the
files never leave the provider; use its versioning or replication if you need
more copies.

## Leaving

The metadata is plain SQL (\`storage.objects\`), the bytes are ordinary files or
S3 objects. To get them back under their names:

\`\`\`sql
SELECT bucket_id || '/' || version AS key, bucket_id || '/' || name AS name
  FROM storage.objects;
\`\`\`

## Related guides

See [REST API](api.md), [backup](backup.md), [JWT/roles](jwt-and-roles.md) and [troubleshooting](troubleshooting.md).
`,Je="# Troubleshooting\n\nThe usual surprises, what causes them and how to fix them. Errors are\n`{\"code\", \"message\"}` JSON; the SDKs expose them as `error.code` /\n`Error::code()`. Newer servers also send `sqlstate`, `details`, `hint` and\n`constraint` for database errors.\n\n## A query returns `[]`, but the rows exist\n\nRow-level security filtered them. RLS never fails a read: rows the policies\ndo not allow simply are not there for this caller. Check:\n\n- **Who is asking.** Without a session the request runs as `anon`; with one,\n  as `authenticated` with `auth.uid()` = the user's id. A row owned by\n  another user is invisible, as intended.\n- **The policy.** `USING (owner = auth.uid())` only matches rows whose\n  `owner` was set. Rows inserted from the SQL editor or a migration have the\n  `owner` you gave them (or `NULL`, since `auth.uid()` is empty there).\n- **Policies for the role.** A policy `TO authenticated` does not apply to\n  `anon`. With RLS enabled and no policy for a role, that role sees nothing.\n\nThe same goes for `update` and `delete`: changing zero rows is a success, not\nan error. To be sure a row changed, ask for it back\n(`.update({...}).eq('id', id).select('id')`) and check the result.\n\nA write that violates a policy's `WITH CHECK` *is* an error: 401/403\n`db_error` with `new row violates row-level security policy` (`42501`).\n\n## 401 or 403 with a valid token\n\nThe role has no **GRANT** on the table, so Postgres refuses before RLS is\neven consulted: `db_error`, `permission denied for table notes (42501)`.\nVisitors (`anon`) get 401 (signing in may help); signed-in users get 403.\n\n```sql\nGRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;\nGRANT SELECT ON public.notes TO anon;   -- only if visitors may read it\n```\n\nFunctions called through `rpc` need `GRANT EXECUTE`. Storage needs policies on\n`storage.objects` ([storage.md](storage.md)).\n\nA 401 `invalid_token` is different: the token is malformed, expired or\nsigned by another key (a token from another project, or from before\n`nelcota dev` was reset). Sign in again; the SDKs refresh tokens on their\nown while the refresh token is valid.\n\n## `email_not_confirmed` on sign-in\n\nThe server has `NELCOTA_EMAIL_CONFIRMATION_URL` set, so a new account must\nopen the link sent by email before it can sign in with a password. Sign-up\nanswers with the user and no session while it waits. Send the link again\nwith `resendConfirmation(email)` (`resend_confirmation` in Rust). Locally,\n`nelcota dev` leaves confirmation off.\n\n## `redirect_not_allowed` when starting an OAuth sign-in\n\n`redirectTo` must match one of the comma-separated\n`NELCOTA_OAUTH_REDIRECT_URLS`: same scheme, host and port, and a path equal\nto or under the listed one. `http://localhost:5173/auth/callback` and\n`http://127.0.0.1:5173/auth/callback` are different origins. Restart the\nserver after changing the variable.\n\n## Types do not match the database\n\n`nelcota types` writes a snapshot of the schema. After a migration, run it\nagain (`nelcota types -o src/database.ts`, or `--lang rust`), otherwise new\ncolumns are unknown to the compiler and removed ones still compile, failing\nonly at run time with `invalid_query` or `db_error`. Running it in CI and\nfailing on a diff catches stale files.\n\nThe server itself reloads its catalog on every DDL. On a managed Postgres\nwithout the event trigger, reload it by hand: `NOTIFY nelcota, 'reload schema';`.\n\n## `service_role` refused in the browser\n\n`@nelcota/client` throws `NelcotaUsageError: A service_role token bypasses\nRLS and must never reach a browser` when it sees such a token in a page. That\ntoken skips every policy, so anyone who opens the developer tools would own\nthe database. Use it only on a server (for example from\n`nelcota token service-role --days 30`); in the browser, sign users in and\nlet RLS decide.\n\n## Only 1000 rows come back\n\nEach read returns at most `NELCOTA_MAX_ROWS` rows (1000 by default), even\nwithout a `limit` and even if the `limit` is larger. Page through the rest:\n\n- TypeScript: `range(from, to)` or `limit` + `offset`; the result's `range`\n  and `count` (with `count: 'exact'`) tell whether more rows exist, and\n  `pages(size)` walks every row.\n- Rust: `range(start, end)` or `limit` + `offset`, with `count_exact()`.\n- HTTP: `Content-Range: 0-999/*` (or `/total` with `Prefer: count=exact`).\n\nOrder by a unique column when paging. Raising the cap makes every large read\ncost more memory; responses also have an 8 MiB budget\n(`413 response_too_large`).\n\n## 429 `rate_limited`\n\nPassword sign-in, signup, email links and provider sign-in use per-endpoint\nIP budgets based on `NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` (30 by default).\nPassword login also has a per-email budget. Refresh and PKCE redemption share\na separate per-IP budget of ten times that value (300 by default). Quotas are\nper process, not distributed across server instances. Clients behind a NAT can\nshare an IP budget. The response carries `Retry-After`; SDKs expose it as\n`error.retryAfter` (seconds) / `Error::retry_after()`. Enable\n`NELCOTA_TRUST_PROXY=true` only behind a trusted forwarding proxy: the rightmost\n`X-Forwarded-For` value is used. Restrict direct API access and configure CDN/proxy\nhops deliberately; otherwise the quota may identify the proxy instead of a user.\n\nA 503 `unavailable` means the database could not be reached or is\noverloaded; it may also carry `Retry-After`. The SDKs retry reads on 429 and\n503 by themselves; writes are never retried automatically.\n",Ye=`# Events and webhooks

Send committed database changes to an HTTP endpoint. Configuration, signing keys and delivery history are under **Events** in the panel. The same Rust binary dispatches deliveries; Postgres stores the queue, so a restart does not lose pending work.

## Prerequisites

Use server 0.4.0+ with administrator access and a trusted receiver. The receiver
needs bounded raw-body signature verification and durable event-ID deduplication.
Source-only scheduler/lifecycle changes are listed in Unreleased.

## Create a webhook

1. Open **Events → New webhook**.
2. Name it, choose a table and select \`INSERT\`, \`UPDATE\` and/or \`DELETE\`.
3. Enter the public HTTPS URL that receives JSON POST requests.
4. Keep the default six attempts, or choose one to ten.
5. Save and copy the signing key to your receiving service. It appears only once.

Only ordinary tables in the exposed schema are supported in this version. Views, partitioned tables, storage metadata and authentication tables are excluded. A table rename keeps its webhooks, because capture follows its PostgreSQL object identity. Dropping and recreating a table requires a new webhook.

Pausing stops capturing new changes and holds existing pending deliveries. Reactivating resumes the queue; changes made while paused are not replayed. Deleting cancels pending work and removes the key, while keeping terminal delivery history. A send already in progress may still arrive after a pause, deletion or key rotation.

Editing a URL affects new events. Queued deliveries keep their original destination. Resending uses the webhook's current URL, key and attempt limit. Key rotation takes effect on newly started sends; update the receiver before resuming a paused webhook.

## Event payload

The receiver gets a JSON object. The event ID is stable across retries, resends and destinations receiving the same database change. Each destination and manual resend has its own delivery ID.

\`\`\`json
{
  "version": 1,
  "id": "94ca9597-b0d8-4c4c-a8ba-e5052c031382",
  "schema": "public",
  "table": "orders",
  "type": "UPDATE",
  "occurred_at": "2026-10-11T12:00:00Z",
  "record": { "id": 42, "status": "paid" },
  "old_record": { "id": 42, "status": "pending" }
}
\`\`\`

For \`INSERT\`, \`old_record\` is null. For \`DELETE\`, \`record\` is null. Changes made through REST, RPC, the panel or direct SQL are captured by the same trigger. The event commits with the changed row; a rolled-back transaction creates no delivery. Capture never makes a network call.

The destination receives the full changed row and, for updates/deletes, the previous row. Only project administrators configure destinations. Public API roles cannot inspect the queue or keys; RLS continues to decide which business rows those roles can change. Webhooks are privileged server-to-server integrations, not subscriptions filtered for individual users.

## Verify signatures

Each request includes these headers:

| Header | Meaning |
| --- | --- |
| \`x-nelcota-event-id\` | Stable event UUID; use it for durable deduplication |
| \`x-nelcota-delivery-id\` | Delivery identifier shown in the panel |
| \`x-nelcota-timestamp\` | Unix timestamp in seconds for this send |
| \`x-nelcota-signature\` | \`v1=\` followed by the lowercase HMAC-SHA256 hex digest |

The signed bytes are the event ID, a period, the timestamp, another period and the exact request body. The HMAC key is the literal signing-key string, including its prefix. Use the raw body before parsing JSON, reject timestamps more than five minutes from your server clock, compare in constant time, then check that the payload ID matches the signed header.

\`\`\`js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(headers, rawBody, secret) {
  const id = headers.get('x-nelcota-event-id') ?? '';
  const timestamp = headers.get('x-nelcota-timestamp') ?? '';
  const signature = headers.get('x-nelcota-signature') ?? '';
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^\\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  if (!/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret)
    .update(\`\${id}.\${timestamp}.\`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}
\`\`\`

Keep the receiving body bounded to 256 KiB. After verifying, parse JSON and process once per event ID in a database transaction with a unique constraint. Record acceptance durably before replying with 2xx. A repeated event should also receive 2xx, without repeating the action. For multiple independent consumers sharing a database, deduplicate by consumer and event ID.

## Retries and delivery history

Any 2xx response acknowledges delivery. Network errors, timeouts, HTTP 408, 425, 429 and 5xx retry automatically. Other statuses, including redirects, are terminal failures. The receiver has ten seconds to answer; a separate twelve-second deadline also bounds DNS and connection setup.

Retry delays start at approximately 5 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes and 1 hour, with jitter and a one-hour cap. A numeric \`Retry-After\` is respected up to one hour without reducing the normal delay. Six attempts by default means the initial send and five retries. A lost worker lease is recovered after two minutes and still counts as an attempt.

Delivery is **at least once**, with no ordering guarantee. A receiver may process an event whose acknowledgement never reaches Nelcota; the next attempt may send it again. Multiple workers claim queue rows with short leases and do not hold a database connection during HTTP calls.

The history shows status, HTTP code, attempts, timestamps and the exact payload. A delivery detail shows every attempt, including sends interrupted by a restart. **Resend** creates a new delivery, preserving the original history and stable event ID. Active deliveries cannot be resent; the webhook must be enabled. Receiver response bodies and signing keys never appear in history.

## Limits and retention

There are at most 50 active configurations per project and ten per table. The queue holds at most 10,000 outstanding deliveries and 100,000 retained deliveries. Admission is transactional: if a limit is reached, the business write fails with a retryable database-capacity error instead of silently losing its event. The panel shows usage and warns at 80%.

Terminal history is kept for up to seven days and cleaned in bounded batches. Pending deliveries are never deleted by age. **Clear history** removes only terminal deliveries and their payloads. To free a stalled queue, fix or enable its destinations, or delete unwanted webhooks to cancel their pending work. Keep database backups private: they contain signing keys and event payloads.

A payload larger than 256 KiB produces a visibly failed delivery with omitted contents, while the business row still commits. Such a delivery cannot be resent; reduce the row size or use another integration for large values. Changes to a hook configuration are project configuration, separate from schema migration exports.

## Destination safety and local development

Public destinations require HTTPS with certificate verification. Credentials, query parameters and fragments in URLs are rejected. Redirects and environment proxy settings are disabled. Private, loopback, link-local, metadata, carrier-grade NAT, multicast and reserved IP ranges are blocked, including DNS answers at connection time. All addresses in a DNS answer must pass the policy, preventing DNS rebinding into internal services.

For local development only, set \`NELCOTA_WEBHOOKS_ALLOW_LOOPBACK=true\` and restart. This permits HTTP or HTTPS to \`localhost\`, \`127.0.0.1\` and \`::1\`; it never opens private networks or metadata addresses. Inside Docker, loopback refers to the Nelcota container, not the host. Use a public HTTPS development tunnel when the receiver runs outside that container.

No Redis, HTTP extension, extra server or Node process is required for dispatch. The queue worker uses a small pool separate from API and panel connections. A graceful shutdown stops claiming work and gives started deliveries time to finish; unfinished leases remain recoverable after startup.

## Related guides

See [REST API](api.md), [panel](panel.md), [backup](backup.md) and [architecture](architecture.md).
`,Xe=`-- Schema for the SDK examples (TypeScript and Rust): private notes and a
-- private \`files\` bucket where each user writes under a folder named after
-- their id. Safe to run more than once.
--
-- Apply it to a development project as the database owner, either:
--   * copy it to migrations/V1__notes.sql (or the next free version) and run
--     \`nelcota migrate\`, or
--   * paste it into the SQL editor of the panel (/admin/).
--
-- It is not part of Nelcota's own migrations: Nelcota creates no business
-- tables in anyone's database.

CREATE TABLE IF NOT EXISTS public.notes (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner      uuid        NOT NULL DEFAULT auth.uid(),
    body       text        NOT NULL,
    extra      jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

-- anon gets no GRANT: without signing in, reads are denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;

DROP POLICY IF EXISTS notes_owner ON public.notes;
CREATE POLICY notes_owner ON public.notes FOR ALL TO authenticated
    USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());

INSERT INTO storage.buckets (id, public) VALUES ('files', false)
    ON CONFLICT (id) DO NOTHING;

-- Each user reads and writes only files under \`<their user id>/\`.
DROP POLICY IF EXISTS notes_files_owner ON storage.objects;
CREATE POLICY notes_files_owner ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text);
`,Ze='# nelcota-client\n\nAsync Rust SDK for Nelcota: REST tables/views and RPC, auth sessions and OAuth,\nand file storage under PostgreSQL RLS. For native applications using Tokio.\n\n```toml\n[dependencies]\nnelcota-client = "0.1.3"\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\ntokio = { version = "1", features = ["macros", "rt-multi-thread"] }\n```\n\nRequires Rust 1.88+ (checked in CI) and Nelcota server 0.3.0 or later.\n\n| SDK | Server baseline | Support |\n|---|---|---|\n| 0.1.x | Server `v0.3.0` or later | Full HTTP/Postgres contract suite, OAuth, `update_user` and generated Rust models |\n| 0.1.x | Server `v0.2.0` | Not supported: lacks the OAuth routes, `PUT /auth/v1/user`, the JSON error contract and the Rust generator |\n\n```rust,no_run\nuse nelcota_client::{Client, rest::Order};\nuse serde::Deserialize;\n\n#[derive(Deserialize)]\nstruct Note { id: i64, body: String }\n\n# async fn example() -> nelcota_client::Result<()> {\nlet client = Client::builder("https://api.example.com").build()?;\nclient.auth().sign_in_with_password("ana@example.com", "password").await?;\nlet response = client.from("notes").select("id,body")\n    .order("id", Order::descending()).range(0, 19).count_exact()\n    .execute::<Vec<Note>>().await?;\nfor note in response.data { println!("{}: {}", note.id, note.body); }\n# Ok(()) }\n```\n\n## Version scope\n\nThis checkout prepares 0.1.3. The registry dependency above requires successful\npublication; use a local path/archive until then. Published 0.1.2 lacks the\nrefresh-margin/finite-input fixes and expanded lifecycle checks. Installing a\nserver release does not update clients. The minimum Rust/server versions and\nHTTP contract remain unchanged.\n\n## REST\n\nBuilders are local and consume `self`; clone a base query to reuse it. Only\n`execute` sends HTTP. Results are `Result<Response<T>, Error>`; response metadata\nincludes HTTP status, count and headers. Decode into your own `Deserialize`\nstructs or `serde_json::Value`. Column names and select expressions are checked\nby the server against its current catalog; these strings are not compile-time\nschema validation.\n\n```rust,no_run\n# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {\nuse serde_json::{Value, json};\nuse nelcota_client::rest::{Condition, IsValue, UpsertOptions};\nlet note = client.from("notes").insert(&json!({"body":"hello"}))\n    .select("id,body").single().execute::<Value>().await?;\nclient.from("notes").update(&json!({"body":"edited"}))\n    .eq("id", &note.data["id"]).execute::<()>().await?;\nclient.from("notes").delete().eq("id", &note.data["id"])\n    .execute::<()>().await?;\nclient.from("products").upsert(&json!({"slug":"pen","name":"Pen"}),\n    UpsertOptions { on_conflict:vec!["slug".into()], ..Default::default() })\n    .execute::<()>().await?;\nclient.from("orders").select("id,customer:customers(name),items(product,qty)")\n    .gte("items.qty", 2)\n    .or([Condition::eq("status", "paid"),\n         Condition::all([Condition::gt("total", 100), !Condition::is("archived", IsValue::True)])])\n    .execute::<Vec<Value>>().await?;\nlet total = client.rpc("cart_total", &json!({"cart_id":7}))\n    .execute::<Value>().await?;\n# Ok(()) }\n```\n\nFilters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in_values`,\n`not_in`, `is`/`is_null`, `not_is`, `not`, `matches`, `and`, `or`.\nConditions are constructed, never assembled from untrusted syntax strings.\nEmbedded filters use paths such as `items.qty`; `order_on`, `limit_on`,\n`range_on`, `and_on`, `or_on` target embedded rows. `order` calls accumulate.\n\nWrites return an empty body by default (`execute::<()>()`); call `select` for\nrepresentation. `single` requires exactly one row; `maybe_single` returns null\nfor zero rows (decode to `Option<T>`). Use `head().count_exact().execute::<()>()`\nfor count-only reads. Update/delete require a parent filter before any HTTP is\nsent. Exact counts scan all matching rows; only request them when needed.\n\nEach read returns at most `NELCOTA_MAX_ROWS` rows (1000 by default), even\nwithout `limit`. Page with `range(start, end)` or `limit` + `offset`, ordered\nby a unique column, until a page comes back empty; `count_exact()` gives the\ntotal when you need it.\n\n## Auth\n\n```rust,no_run\n# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {\nlet signup = client.auth().sign_up("ana@example.com", "strong-password-123", None).await?;\n// signup.session is None while email confirmation is pending.\nlet session = client.auth().get_session().await?;\nlet user = client.auth().get_user().await?;\n// Merged into user_metadata; a null value removes the key.\nclient.auth().update_user(nelcota_client::auth::UserUpdate {\n    data: Some(serde_json::json!({ "plan": "pro" })),\n    ..Default::default()\n}).await?;\nlet mut events = client.auth().subscribe();\nlet background = client.auth().start_auto_refresh(); // opt-in; retain this handle\nclient.auth().request_password_reset("ana@example.com").await?;\nclient.auth().send_magic_link("ana@example.com").await?;\nclient.auth().resend_confirmation("ana@example.com").await?;\nclient.auth().sign_out().await?;\ndrop(background);\n# Ok(()) }\n```\n\nSession storage defaults to memory. For a CLI or desktop app,\n`auth::FileStorage::new(path)` keeps the session in a JSON file, written\natomically and readable by its owner only (0600 on Unix). Implement\n`auth::SessionStorage` for a keychain, encrypted file or per-request cookie\nstore.\n\n```rust,no_run\n# fn example() -> nelcota_client::Result<()> {\nuse std::sync::Arc;\nuse nelcota_client::{Client, auth::FileStorage};\nlet client = Client::builder("https://api.example.com")\n    .session_storage(Arc::new(FileStorage::new("/home/ana/.config/notes/session.json")))\n    .build()?;\n# Ok(()) }\n```\n Clones share one session,\nlifecycle lock and refresh result. Independent clients/processes sharing a\npersistent store need external coordination: the store interface alone does\nnot serialize refresh. A spent refresh token terminates its server session.\n\nRefresh runs before expiry when a request needs a token. Opt-in background\nrefresh stops when its handle is dropped. Both paths cap the configured refresh\nmargin at half the token lifetime, avoiding repeated rotation of fresh\nshort-lived tokens. Rotation continues if a waiter is\ncancelled/dropped, so a consumed refresh token can still be replaced locally.\nA transient failure keeps the previous identity; an invalid grant clears the\nsession and returns the failure to the initiating request. Logout waits for\nrotation and clears locally even if server revocation fails. Existing access\ntokens may remain valid until expiry.\n\nIn a backend, scope a caller token to a clone; this does not alter the shared\nsession or refresh the supplied token:\n\n```rust,no_run\n# fn example(client: nelcota_client::Client, caller_token: String) {\nlet caller = client.with_access_token(caller_token);\nlet visitor = client.anonymous();\n# }\n```\n\nOAuth uses PKCE S256 with Google/GitHub. `begin_oauth` returns `PkceFlow { url,\nverifier }`; keep it private, open its URL in your application\'s browser flow,\nand consume it with `handle_redirect(&mut callback_url, flow)` or exchange the\ncode/verifier explicitly. The SDK does not open a browser or create a callback\nserver. `redirect_to` must be in `NELCOTA_OAUTH_REDIRECT_URLS`.\n\nEmail links carry `#type=...&token=...`. `EmailLink::parse(&mut url)` extracts\nthe token and clears the fragment. Pass signup/magic links to\n`verify_email_link`; use `reset_password(token, password)` for recovery.\nSession, flow and link Debug implementations omit secret tokens.\n\n## Storage\n\n```rust,no_run\n# async fn example(client: nelcota_client::Client, user_id: String) -> nelcota_client::Result<()> {\nuse nelcota_client::storage::{UploadOptions, OpenOptions, ListOptions};\nlet files = client.storage().from("avatars")?;\nlet name = format!("{user_id}/me.txt");\nfiles.upload(&name, "hello", UploadOptions::default()).await?; // text/plain, from .txt\nfiles.upload("logo", "<svg/>", UploadOptions {\n    content_type: Some("image/svg+xml".into()), upsert: true,\n}).await?;\nlet bytes = files.download(&name).await?;\nlet response = files.open(&name, OpenOptions { range:Some((0,Some(3))), ..Default::default() }).await?;\nlet listing = files.list(ListOptions { prefix:format!("{user_id}/"), ..Default::default() }).await?;\nlet signed_url = files.create_signed_url(&name, 3600).await?;\nlet public_url = files.public_url(&name)?;\nfiles.remove(&name).await?;\n# Ok(()) }\n```\n\nWithout an explicit `content_type`, uploads guess it from the name\'s extension\n(`json`, `csv`, `txt`, `html`, `css`, `js`, `svg`, `png`, `jpg`, `gif`, `webp`,\n`pdf`, `mp4` and other common types; see `storage::guess_content_type`) and\nfall back to `application/octet-stream`. `upload_reader` streams a Tokio reader. `open` returns a streaming\n`reqwest::Response`; handle 206, 304, ETag and stream failures yourself after it\nreturns. `download` buffers the file and reports body failures in its Result.\nUploads/downloads default to no deadline; scope a `RequestOptions` timeout when\nneeded. S3 redirects are followed; bearer tokens are stripped across origins.\nObject names are NFC-normalized and encoded per segment. Empty/dot segments,\nbackslashes and control characters are rejected.\n\nBuckets support list/get/create/update/delete, usually with `service_role`.\n`update_bucket` replaces all settings, so it takes a `BucketUpdate`, which has\nno `Default`: every field is explicit, and `None` clears a limit on purpose.\nStart from the current bucket to change one setting:\n\n```rust,no_run\n# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {\nuse nelcota_client::storage::BucketUpdate;\nlet current = client.storage().get_bucket("avatars").await?;\nclient.storage().update_bucket("avatars", BucketUpdate { public: true, ..current.into() }).await?;\n# Ok(()) }\n```\n\nAuthorization belongs to server RLS; a `service_role` token bypasses it and\nbelongs only in a trusted application.\n\n## Rust schema types\n\n```sh\nnelcota types --lang rust -o src/database.rs\n```\n\nGenerated modules expose `schema::table::{Row, Insert, Update, NAME,\nPRIMARY_KEY}` and `schema::rpc::function::{Args, Returns, NAME}`. Enum columns\nhave serde-renamed enums. Generated/identity-always columns are omitted from\nwrite models; views have write models except materialized views. Projections\nand embeds need structs matching their selected shape.\n\n`Field::Omit` skips a write field, keeping its default/current value;\n`Field::Value(None)` sends explicit null for nullable columns. UUID/date/time\nand unknown scalar types use strings. Bigint uses i64, numeric uses\n`serde_json::Number` with arbitrary precision, and arrays allow null elements.\nRPC return aliases allow null; optional arguments distinguish omission from\nexplicit null. Types are generated from the configured exposed schema, without\nrequiring a DB connection when compiling consumer applications.\n\n## Errors, deadlines and retries\n\n`Error::code()`, `status()` and `retry_after()` preserve server facts.\nOther variants distinguish invalid input, network, timeout, cancellation,\ninvalid response, cardinality and session storage failures. No panic is used\nfor caller configuration or HTTP failures. Signed request URLs are omitted\nfrom transport error text. A response without a JSON body (a `head()` count, a\nproxy page) gets `unauthorized`, `forbidden`, `not_found`, `rate_limited`,\n`unavailable` or `http_<status>` as its code.\n\nWhen the server reports them, `sqlstate()`, `details()`, `hint()` and\n`constraint()` expose what Postgres said about a `db_error`; older servers send\nnone. Helpers classify common cases: `is_not_found()`, `is_conflict()`,\n`is_unique_violation()`, `is_rate_limited()`, `is_unauthorized()`,\n`is_forbidden()` and `is_retryable()`.\n\n```rust,no_run\n# async fn example(client: nelcota_client::Client) -> nelcota_client::Result<()> {\nuse serde_json::json;\nmatch client.from("notes").insert(&json!({"slug":"a"})).execute::<()>().await {\n    Err(error) if error.is_unique_violation() => {\n        println!("taken ({:?})", error.constraint());\n    }\n    other => { other?; }\n}\n# Ok(()) }\n```\n\nOnly GET/HEAD retry network/body-read failures and 429/503, default two retries.\nThe backoff has jitter and respects Retry-After (seconds or HTTP date); a delay\nover 30 seconds returns immediately. Mutations, auth exchange, RPC and POST\nstorage listings never retry automatically. Timeouts cover each attempt and\nbuffered body; refresh and backoff are separate. Drop a request future or use\n`CancellationToken` to cancel; an already accepted server write cannot be undone\nby cancelling the client. Raw stream lifetime is managed by reqwest/caller.\n\n`Client::builder(url).header("x-app", "notes")` adds a header to every request;\n`build` refuses invalid headers and `Authorization`, which comes from\n`access_token` or the session. Custom `http_client` instances must disable\ntheir own auth/mutation retries.\nThe default client uses explicit rustls/ring and Mozilla roots without a global\ncrypto-provider initialization. It can be reused across tasks.\n\nStart with the [quickstart](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md)\n(local server, migration, generated types). The examples in `examples/` use\nthe shared [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql)\nschema. Empty results, 401/403 or a 1000-row cap? See\n[troubleshooting](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md).\nPortuguese guide: [quickstart.pt-BR.md](docs/quickstart.pt-BR.md).\nContract: [contract.md](docs/contract.md). Release: [releasing.md](docs/releasing.md).\n',Qe=`# Rust SDK contract

\`nelcota-client\` 0.1.x supports Nelcota server 0.3.0 or later; release 0.1.2 is
verified against server 0.4.0. The released v0.2.0 tag is a legacy baseline
without the newer OAuth routes and generators; see the README compatibility
matrix. Package and server versions are independent. Native Tokio on Linux,
Windows and macOS is the supported target; blocking and WASM interfaces are
not part of 0.1.

| Module | HTTP contract |
|---|---|
| REST read | GET/HEAD \`/rest/v1/{table}\`; select/filter/order/paging, Prefer count, Content-Range |
| REST write | POST/PATCH/DELETE \`/rest/v1/{table}\`; minimal/representation, upsert resolution/on_conflict |
| RPC | POST \`/rest/v1/rpc/{name}\` with named JSON arguments |
| Auth | POST signup; token grants password/refresh_token/pkce; GET user; POST logout |
| Email | POST recover/magiclink/resend/verify |
| OAuth | Authorization URL with S256 PKCE; one-use code exchange |
| Objects | POST/PUT/GET/DELETE \`/storage/v1/object/{bucket}/{path}\`, raw bytes |
| Sharing/listing | POST object/list and object/sign; local object/public URL construction |
| Buckets | GET/POST bucket; GET/PUT/DELETE bucket/{id} |

The query grammar and server capabilities match the TypeScript contract.
Responses become Rust Result values; empty bodies become JSON null (decode to
unit or an appropriate Option). \`Response<T>\` carries status, count and headers.
Auth/storage convenience methods return the decoded model or structured error.

Unreleased cardinality preflight rejects HEAD and minimal writes with
\`single\`/\`maybe_single\` before HTTP. Request write rows with \`.select(...)\`;
array-returning RPC calls remain supported. Published 0.1.3 predates this guard.

HTTP error bodies larger than 64 KiB are discarded; status, a generic error
code and Retry-After remain available. Successful responses keep their existing
buffering or streaming contract.

One Client and its clones share lifecycle coordination. Explicit token clones
control REST/storage and get_user only; other auth methods manage the shared
login session. Refresh waiters share one background rotation task; cancelling
or dropping them does not leave a task per waiter or stop an accepted rotation.
Default sessions never persist outside memory. Shared stores across independently
constructed clients/processes require their own coordination.

Unreleased token cancellation also covers authentication waiting for the lifecycle
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

Prepared 0.1.3 retains the core HTTP contract and minimum versions of 0.1.2.
Its refresh-margin/finite-input corrections and expanded lifecycle checks need
a new client build/package. Registry availability requires successful
publication; server and SDK releases remain independent.
`,$e='# Começando com Rust\n\nAs correções **Unreleased** deste checkout exigem um novo pacote do cliente.\nElas recusam `single`/`maybe_single` em HEAD ou escritas sem representação\nantes de enviar HTTP: use `.select(...)` para receber a linha de uma escrita.\nO cancelamento também retira requisições de auth da fila de ciclo de vida;\numa rotação aceita continua responsável por persistir sua sessão.\nEssas correções ainda não fazem parte do pacote publicado 0.1.3.\n\nO SDK usa Tokio e requer Rust 1.88+. Este checkout prepara 0.1.3; adicione\n`nelcota-client = "0.1.3"` ao Cargo.toml somente após a publicação, junto de\nserde, serde_json e tokio (veja o README). Antes disso, use uma dependência\nlocal `path` para `sdk/rust` ou o arquivo validado. O pacote publicado 0.1.2\ntem comportamento anterior. O servidor compilado do repositório exige Rust\n1.99.0; ele e o SDK têm versões independentes.\n\n1. Inicie o Nelcota com `cargo run -- dev` ou use um projeto implantado.\n2. Aplique [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql) (o mesmo do SDK JavaScript) pelo\n   editor SQL do painel ou como migração (`nelcota migrate`).\n3. Defina `NELCOTA_URL`, `NELCOTA_EMAIL` e `NELCOTA_PASSWORD` para um usuário\n   existente. Como alternativa, passe `NELCOTA_ACCESS_TOKEN`.\n4. Execute `cargo run -p nelcota-client --example rest` na raiz do repositório.\n   O exemplo cria uma nota, lê, atualiza e remove a nota que acabou de criar.\n\nPara obter modelos do banco:\n\n```sh\nnelcota types --lang rust -o src/database.rs\n```\n\nInclua com `mod database;`. Use `database::public::notes::Row` ao selecionar\ntodas as colunas, ou uma struct própria para projeções. Insert e Update usam\n`Field::Omit` para não enviar campos e `Field::Value(None)` para escrever null\nem campos anuláveis. Campos calculados não aparecem nas escritas.\n\nCada cliente mantém sua sessão em memória; clones compartilham a coordenação\nde refresh. Em um backend que atende vários usuários, use\n`client.with_access_token(token_do_usuario)` por requisição. Isso mantém o\ntransporte compartilhado e cada chamada com a identidade correta.\n\nOs exemplos `storage` e `oauth` mostram arquivos com streaming e PKCE. Defina\n`NELCOTA_UPLOAD_PATH` para o arquivo no primeiro; no segundo, configure\n`NELCOTA_OAUTH_REDIRECT_URL` também na lista permitida do servidor, abra a URL\nimpressa e cole a URL de retorno quando solicitado. Eles não imprimem os tokens\nda sessão. As políticas do banco continuam decidindo quem pode acessar os dados.\n',et=`# Releasing nelcota-client

The Rust package has independent semver. A release targets the documented
server protocol, rather than requiring matching server/package versions.

The maintainer needs ownership of \`nelcota-client\` on crates.io. Configure its
trusted publisher for GitHub owner \`Nelcota\`, repository \`Nelcota\`, workflow
\`sdk-rust-release.yml\`, and environment \`crates-io\`. The GitHub-hosted publish
job exchanges its OIDC identity for a short-lived token with
\`rust-lang/crates-io-auth-action\`; it does not use a stored registry token.
After a repository transfer, update the publisher's owner before releasing.
This repository does not contain registry credentials.

1. Run SDK checks and \`cargo test -p nelcota-server --test sdk_rust\` with Docker.
2. Run the Rust generator tests and external package consumer check.
3. Update the package version, compatibility contract and changelog.
4. Run \`cargo publish -p nelcota-client --dry-run\` from a clean checkout.
5. Push an intentional \`rust-sdk-v<version>\` tag to invoke sdk-rust-release.yml.

The release workflow checks tag/version equality, repeats SDK checks and the
real HTTP/Postgres contracts, verifies the package and publishes in the
\`crates-io\` environment. Publishing requires maintainer registry configuration;
local implementation/testing does not publish or create tags.

Example external package check (after \`cargo package -p nelcota-client\`):

\`\`\`sh
python sdk/rust/scripts/package-test.py
\`\`\`

The consumer resolves the archive under Cargo's effective \`target_directory\`,
including \`CARGO_TARGET_DIR\` and Cargo configuration. Use the same configuration
for packaging and verification. To run the archive-selection regressions:

\`\`\`sh
python3 sdk/rust/scripts/test_package.py
\`\`\`

To intentionally verify default HTTPS outside the workspace:

\`\`\`sh
cargo run -p nelcota-client --example https_smoke
\`\`\`

That makes one anonymous GET to example.com; an HTTP response proves TLS
initialized in the consumer process without Nelcota server startup.
`,tt=`# Changelog

Package releases use Semantic Versioning and Keep a Changelog categories.
Dates identify release entries; registry availability requires a successful publish.

## Unreleased

### Fixed

- Cancel queued sign-up, password login, verification and OAuth exchange waits
  without interrupting another caller's refresh or an accepted publication.
- Type bucket size limits as \`number | string | null\` and send exact decimal
  strings as JSON integers, so reading then updating a large int64 limit does
  not change its value or send a quoted number. Existing server validation
  still rejects invalid settings. Use strings before JavaScript rounds a value.
- Keep usage diagnostics concise without changing error codes or statuses.

## 0.2.0 — 2026-10-19

Prepared package candidate. Version metadata and this changelog do not publish
the package; use a local archive until registry publication completes.

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

Release notes describe the package version, not the server. Candidate 0.2.0
changes are absent from registry 0.1.2; installing them requires the new client
package after its publication, or a reviewed local archive.
`,nt=`# @nelcota/client

JavaScript and TypeScript client for [Nelcota](https://github.com/Nelcota/Nelcota/): the
REST API under RLS, auth and storage.

Start with the [quickstart](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md)
(also in [Portuguese](docs/quickstart.pt-BR.md)), the
[runnable examples](examples/) (their schema is
[examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql))
or the [client contract](docs/contract.md). Empty results, 401/403 or a
1000-row cap? See [troubleshooting](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md).

- **Thin.** Operations map directly to HTTP; session refresh and read retries
  may add requests. There is no hidden data cache, and
  Postgres (GRANTs and RLS) decides what a call may do.
- **No runtime dependencies.** It uses \`fetch\`, Web Crypto, \`AbortSignal\`,
  Web Locks and \`BroadcastChannel\`, and runs in browsers, Node 22+, Deno,
  Bun. Edge hosts need the same Web APIs and host-specific validation.
  ESM only, side-effect free, with subpath exports
  (\`/rest\`, \`/auth\`, \`/storage\`).
- **Typed from your schema** by \`nelcota types\`, down to the embeds in a
  \`select\` string.
- **Safe by construction.** Input never becomes query syntax, storage paths
  cannot climb out of their bucket, and a \`service_role\` token is refused in
  a browser.

\`\`\`sh
npm install @nelcota/client@0.2.0
nelcota types -o src/database.ts
\`\`\`

\`\`\`ts
import { createClient } from '@nelcota/client';
import type { Database } from './database';

export const nelcota = createClient<Database>('https://api.example.com');
\`\`\`

In plain JavaScript, omit the generated type and generic parameter:

\`\`\`js
import { createClient } from '@nelcota/client';
const nelcota = createClient('https://api.example.com');
\`\`\`

## Version scope

This checkout prepares 0.2.0; the registry command above requires its successful
publication. Until then, install a locally packed archive. Published 0.1.2 lacks
native IndexedDB session/PKCE journaling, exact numeric preservation and the
latest cancellation/sign-out cleanup fixes. Read each package's bundled README
for its contract. Updating the server does not update installed clients.
Node is SDK tooling/runtime, not a backend requirement.

## Independent modules

\`\`\`js
import { createAuthClient } from '@nelcota/client/auth';
import { createRestClient } from '@nelcota/client/rest';
import { createStorageClient } from '@nelcota/client/storage';

const auth = createAuthClient('https://api.example.com');
const options = { accessToken: () => auth.accessToken() };
const rest = createRestClient('https://api.example.com', options);
const storage = createStorageClient('https://api.example.com', options);
\`\`\`

Each entry includes its transport without importing the other feature modules.
\`createRestClient<Database>(url)\` also accepts generated schema types.

## Results and errors

Every call resolves to \`{ data, error }\` and never throws for HTTP or
network failures. \`error\` is a \`NelcotaError\`:

- \`status\`: the HTTP status, or \`0\` when no response arrived.
- \`code\`: the server's code untouched (\`user_already_exists\`,
  \`invalid_grant\`, \`db_error\`, \`rate_limited\`...), or a client code:
  \`network_error\`, \`timeout\`, \`aborted\`, \`invalid_response\`, \`not_single\`,
  \`session_missing\`, \`pkce_missing\`. A response without a JSON body (a HEAD
  count, a proxy page) gets \`unauthorized\`, \`forbidden\`, \`not_found\`,
  \`rate_limited\`, \`unavailable\` or \`http_<status>\`. The \`NelcotaErrorCode\`
  type lists the known codes and still accepts any string.
- \`retryAfter\`: seconds to wait, after a 429 or 503.
- \`sqlstate\`, \`details\`, \`hint\`, \`constraint\`: what Postgres reported for a
  \`db_error\` (\`23505\`, \`Key (slug)=(a) already exists.\`, \`notes_slug_key\`),
  when the server sends them; \`undefined\` otherwise.

A programming mistake (an invalid column name, a \`..\` in a file path, a
\`service_role\` token in a browser) throws a \`NelcotaUsageError\` before
anything is sent.

Custom token/storage adapters may throw their own errors. A response returned
by \`storage.open()\` is caller-owned: handle errors while reading its stream.

\`\`\`ts
const { data, error } = await nelcota.from('notes').select('id,body');
if (error) console.error(error.code, error.message);
\`\`\`

To use exceptions instead, call \`.throwOnError()\` on a query (its result
type then has no error branch) or pass any result to \`unwrap\`, which
returns \`data\` or throws the \`NelcotaError\`:

\`\`\`ts
import { unwrap } from '@nelcota/client';

const { data: notes } = await nelcota.from('notes').select('id,body').throwOnError();
const user = unwrap(await nelcota.auth.getUser());
const blob = unwrap(await nelcota.storage.from('files').download('a.txt'));
\`\`\`

## Tables, views and functions

\`\`\`ts
// Read: columns, *, embeds in either direction, filters, order, paging.
const { data, count } = await nelcota
  .from('orders')
  .select('id,total,customer:customers(name),items(product,qty)', { count: 'exact' })
  .eq('status', 'paid')
  .gte('items.qty', 2)                                  // filters the embedded rows
  .order('created_at', { ascending: false })
  .order('qty', { referencedTable: 'items' })
  .range(0, 19);
// data: { id: number | string; total: number | string; customer: { name: string } | null;
//         items: { product: string; qty: number }[] }[]

// One row: an error (not_single) unless exactly one matches.
const { data: order } = await nelcota.from('orders').select().eq('id', 10).single();

// Only the count (a HEAD request, no rows).
const { count: open } = await nelcota.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'open');

// Groups: conditions are built with typed calls, never strings.
await nelcota.from('products').select().or((c) => [
  c.eq('status', 'featured'),
  c.and([c.gt('price', 100), c.not(c.is('archived', true))]),
]);

// Writes return nothing unless you ask for the rows with select().
await nelcota.from('notes').insert({ body: 'hi' });
const { data: created } = await nelcota.from('notes').insert({ body: 'hi' }).select('id').single();
await nelcota.from('notes').update({ body: 'edited' }).eq('id', 1);
await nelcota.from('notes').delete().in('id', [1, 2, 3]);
await nelcota.from('products').upsert(rows, { onConflict: 'slug' });      // or ignoreDuplicates: true

// Functions run with the caller's role.
const { data: total } = await nelcota.rpc('cart_total', { cart_id: 7 });
\`\`\`

Filters: \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`like\`, \`ilike\`, \`in\`,
\`is\` (\`null\`, \`true\`, \`false\`, \`'unknown'\`), \`not(column, op, value)\`,
\`match({...})\`, \`or(...)\` and \`and(...)\`. A column path such as
\`orders.total\` filters an embed. Builders are immutable, so a base query can
be reused.

\`like\`/\`ilike\` read \`*\` (or \`%\`) as "any text". Wrap text a person typed in
\`escapeLike\` so \`%\` and \`_\` match literally:

\`\`\`ts
import { escapeLike } from '@nelcota/client';
nelcota.from('products').select().ilike('name', \`*\${escapeLike(search)}*\`);
\`\`\`

\`update\` and \`delete\` need at least one filter; the server refuses them
otherwise. \`count: 'exact'\` scans every matching row, so ask for it only
when you show it.

HEAD queries return \`data: null\`. \`single()\` and \`maybeSingle()\` require
rows: use \`.select()\` on writes first, and omit \`head: true\`.

### Paging

The server returns at most \`NELCOTA_MAX_ROWS\` rows per request (1000 by
default), even without a \`limit\`. Page with \`range(from, to)\` or
\`limit(n)\` + \`offset(n)\`, and read \`range\` (the rows returned, from
\`Content-Range\`) and \`count\` (with \`count: 'exact'\`) to know whether more
rows exist:

\`\`\`ts
const { data, range, count } = await nelcota
  .from('notes').select('id,body', { count: 'exact' }).order('id').range(0, 49);
const more = range !== null && count !== null && range.to + 1 < count;
\`\`\`

To walk every row, \`pages(size)\` requests one page after another until an
empty one, so a server cap below \`size\` cannot cut it short. Order by a
unique column so pages neither overlap nor skip rows; a failed page throws
its \`NelcotaError\`:

\`\`\`ts
for await (const page of nelcota.from('notes').select('id,body').order('id').pages(500)) {
  for (const note of page) console.log(note.id);
}
\`\`\`

## Auth

\`\`\`ts
await nelcota.auth.signUp({ email, password, data: { name: 'Ana' } });  // session is null while the email awaits confirmation
await nelcota.auth.signInWithPassword({ email, password });
await nelcota.auth.signOut();

const { data: session } = await nelcota.auth.getSession();   // refreshed first when about to expire
const { data: user } = await nelcota.auth.getUser();         // the server's view, now
await nelcota.auth.updateUser({ data: { plan: 'pro' } });     // merged into user_metadata; null removes a key
await nelcota.auth.updateUser({ password: next, currentPassword: password }); // ends the other sessions

const stop = nelcota.auth.onChange((event, session) => {
  // 'signed_in' | 'signed_out' | 'refreshed' | 'user_updated', also from other tabs
});
\`\`\`

**Sessions.** In browsers, native \`localStorage\` uses an IndexedDB journal
as the authoritative session state and mirrors committed sessions to
\`localStorage\`. Elsewhere sessions stay in memory. Pass \`auth: { storage }\`
to use a custom adapter, for example a cookie adapter for server-side
rendering. Anything with \`getItem\`/\`setItem\`/\`removeItem\` works, sync or async.

Browser storage can be read by any script on the page, so the usual XSS
hygiene applies (a Content Security Policy, no untrusted HTML). The session
holds a short-lived access token (15 minutes by default) and a refresh
token that rotates on every use.

**Refresh.** The access token is refreshed in the background before it
expires, and again right before a request when needed.

The server ends a session whose refresh token is used twice, so refreshes
are coordinated:

- One refresh at a time in a process, however many requests are waiting.
- Across tabs, a Web Lock serializes refreshes. A committed IndexedDB
  receipt hands the replacement to the next owner even when its
  \`localStorage\` view is stale. A reservation is committed before HTTP.

Native browser persistence requires IndexedDB. Storage failures reject
explicit auth calls; observe automatic refresh failures with
\`auth.onBackgroundError\`. If an owner disappears during rotation or cannot
save its replacement, another client refuses to reuse the reserved token.
Retry from the owning client, sign in again, or call \`signOut()\` to clear it.

Without Web Locks, a local queue coordinates clients in the same module
instance. The native journal prevents competing owners from spending a
reserved token, but cannot make them wait for the replacement. Custom shared
adapters need Web Locks or external coordination; use
\`auth: { storage: sessionStorage }\` for separate per-tab sessions.
Keep the same storage key when sharing a session adapter.

On upgrade, the journal imports the existing \`localStorage\` session once.
Reload all open tabs to avoid mixing old and new coordination protocols.
Use \`signOut()\` or clear all site data to remove native sessions; editing
only \`localStorage\` no longer changes authoritative session state.
Signing out also clears the pending OAuth verifier from the journal and
its storage mirror, including when no session exists or server logout fails.

Failed sign-in/logout publication keeps the newer local state while the exact
prior journal revision remains current, even if another client wrote that
prior revision. A new committed revision supersedes it, including an explicit
publication of the same value.

If a refresh fails for a transient reason, the old token is still sent. The
request then fails with 401 instead of silently running as a visitor.

**OAuth (Google, GitHub)** uses PKCE, with the verifier kept in this
browser:

\`\`\`ts
// Login page: navigates to the provider.
await nelcota.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth/callback' });

// On the callback page: reads ?code= (or ?error=), cleans the address bar, signs in.
const { data, error } = await nelcota.auth.handleRedirect();
\`\`\`

\`redirectTo\` must be listed in the server's \`NELCOTA_OAUTH_REDIRECT_URLS\`.
Each storage key holds one pending OAuth verifier: starting another sign-in
replaces the previous attempt. Verifier publication, navigation and callback
consumption use the same lock so asynchronous work cannot reorder them. Use
separate storage keys for independent login flows.

Native PKCE publication and consumption also use the IndexedDB journal, so
stale localStorage cannot supply an older verifier or reuse a consumed one.
An already cancelled exchange keeps its verifier. Once consumption begins,
the bounded exchange persists an accepted session even if its caller cancels
the wait; the first exchange's timeout still applies.

**Email links** arrive as \`https://your.app/page#type=...&token=...\`.
\`readEmailLink()\` takes the token and removes it from the address bar and
history:

\`\`\`ts
const link = nelcota.auth.readEmailLink();
if (link?.type === 'magiclink' || link?.type === 'signup') await nelcota.auth.verifyEmailLink(link);
if (link?.type === 'recovery') await nelcota.auth.resetPassword({ token: link.token, password: newPassword });

await nelcota.auth.sendMagicLink(email);
await nelcota.auth.requestPasswordReset(email);   // same answer whether or not the account exists
await nelcota.auth.resendConfirmation(email);
\`\`\`

**On a server**, forward the caller's token instead of keeping a session:

\`\`\`ts
// Validate the header in middleware before constructing the client.
const nelcota = createClient<Database>(url, { accessToken: () => validatedCallerToken });
\`\`\`

Create this client per request. \`validatedCallerToken\` is a token or null from
middleware that validates Bearer syntax and returns 401 for malformed headers.
Only an absent header means anonymous; do not turn malformed auth into a visitor.
The runnable [server example](examples/server.mjs) demonstrates validation and
forwarding to RLS. \`accessToken\` disables automatic session refresh; explicitly
called auth methods still store sessions.

Auth HTTP methods take \`{ signal, timeout }\` as their last argument. Concurrent
refresh calls share the first caller's timeout; each caller can cancel its own
wait independently. Once rotation starts, it finishes and saves the new token
even if a waiter cancels. REST/storage cancellation also covers waiting for a
token or session refresh. \`signOut()\` waits for a
pending refresh. Call \`nelcota.dispose()\` (or \`auth.dispose()\` for the standalone
client) to stop timers and close channels when the client is no longer used.

A \`service_role\` token bypasses RLS. Use it only on a trusted server; in a
browser the client refuses it.

## Storage

\`\`\`ts
const files = nelcota.storage.from('avatars');

await files.upload(\`\${user.id}/me.png\`, file);                       // 409 object_exists if taken
await files.upload(\`\${user.id}/me.png\`, file, { upsert: true });     // replace
const { data: blob } = await files.download(\`\${user.id}/me.png\`);
const { data: listing } = await files.list({ prefix: \`\${user.id}/\` });
await files.remove(\`\${user.id}/me.png\`);

const { data: url } = await files.createSignedUrl('reports/q1.pdf', 3600);  // anyone with the URL, for an hour
files.publicUrl('logo.png');                                                 // public buckets, no request
\`\`\`

- **Uploads** send the bytes as they are (no multipart). A \`ReadableStream\`
  is streamed without buffering where the runtime supports it (Node, Deno,
  Bun; browsers over HTTP/2).
- **\`open(name, { range, ifNoneMatch, download })\`** returns the raw
  \`Response\`, for streaming \`response.body\`, resuming with ranges (206) or
  revalidating with ETags (304).
- **Names** are normalized to NFC and encoded segment by segment. Empty,
  \`.\` and \`..\` segments, control characters and backslashes are refused.
- **Buckets** are managed with \`createBucket\`, \`updateBucket\`,
  \`deleteBucket\`, \`getBucket\` and \`listBuckets\`, usually as \`service_role\`.
  \`updateBucket\` replaces every setting and requires all three fields:

\`\`\`ts
await nelcota.storage.updateBucket('avatars', {
  public: true,
  file_size_limit: 5_000_000,
  allowed_mime_types: ['image/png', 'image/jpeg'],
});
\`\`\`

Use explicit \`null\` to clear a size or MIME limit. Partial updates are refused
before HTTP, so an omitted field cannot silently clear an existing restriction.

Who may read or write which file is up to the policies on
\`storage.objects\`; see the server's
[storage docs](https://github.com/Nelcota/Nelcota/blob/main/docs/storage.md).

## Recipes

### Polling for changes

There is no realtime channel. For a UI showing the latest 100 notes, refresh a
bounded snapshot. This example assumes an initialized \`nelcota\` client and a
\`render\` function that replaces the displayed list:

\`\`\`ts
async function poll(signal: AbortSignal) {
  const { data, error } = await nelcota.from('notes')
    .select('id,body,created_at').order('id', { ascending: false })
    .limit(100).abortSignal(signal);
  if (error) return error.retryAfter ?? 30;
  render(data);
  return 5;
}

function delay(seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const controller = new AbortController();
const finished = (async () => {
  while (!controller.signal.aborted) {
    const wait = document.hidden ? 60 : await poll(controller.signal);
    await delay(wait, controller.signal);
  }
})();
// On page/component teardown: controller.abort(); await finished; nelcota.dispose();
\`\`\`

This refreshes visible UI state; it is not durable event delivery or a complete
history export. Do not infer exactly-once delivery from timestamps or increasing
IDs: equal timestamps, page caps and transaction commit order can skip rows in
cursor recipes. Use stable ordering for pagination. For committed changes, use
the server's webhook contract with durable receiver deduplication.

### Server-side rendering with cookies

On a server that renders pages for signed-in users, keep the session in
cookies instead of memory, with a client created **per request**. The adapter
below works with any framework's cookie API (Next.js \`cookies()\`, Express
\`req.cookies\`/\`res.cookie\`, Hono, SvelteKit...):

\`\`\`ts
import { createClient, type SessionStorage } from '@nelcota/client';

interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, options: Record<string, unknown>): void;
  delete(name: string): void;
}

export function cookieStorage(jar: CookieJar): SessionStorage {
  // Normalize this application's chosen key into a cookie name.
  // Use distinct fixed storageKey values; this mapping is not collision-free.
  const name = (key: string) => key.replace(/[^\\w-]/g, '_');
  return {
    getItem: (key) => {
      const value = jar.get(name(key));
      return value === undefined ? null : decodeURIComponent(value);
    },
    setItem: (key, value) =>
      jar.set(name(key), encodeURIComponent(value), {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
      }),
    removeItem: (key) => jar.delete(name(key)),
  };
}

// In a request handler:
const nelcota = createClient<Database>(process.env.NELCOTA_URL!, {
  auth: { storage: cookieStorage(jar), storageKey: 'nelcota', autoRefresh: false },
});
const { data: notes } = await nelcota.from('notes').select('id,body');
\`\`\`

\`httpOnly\` keeps tokens away from page scripts. This adapter is illustrative:
user metadata can make a session exceed the browser's cookie-size limit, and
percent encoding increases its size. Use bounded sessions or a server-side store
with an opaque cookie identifier; handle decoding and storage failures. Framework
handlers must be allowed to write/delete cookies with matching path/domain flags.
Protect state-changing routes from CSRF. Never authorize from cached user metadata
alone; the server must verify the caller's token.

Refreshes from separate requests need shared coordination. An in-process lock
cannot serialize several server instances; centralize rotation in a shared
coordinator and let handlers reuse the accepted replacement.
\`autoRefresh: false\` (already the default outside browsers) keeps background
timers out of a request-scoped client; a token about to expire is still
refreshed before a request.

## Options

\`\`\`ts
createClient<Database>(url, {
  auth: { storage, storageKey, autoRefresh, refreshMargin },
  accessToken,           // () => token | null, replaces the session
  fetch,                 // custom fetch (tests, tracing)
  headers,               // extra headers (browsers only send what CORS allows)
  timeout: 30_000,       // ms per attempt, including buffered bodies; file transfers default to none
  retries: 2,            // reads only, on 429/503 and network errors, honouring Retry-After
});
\`\`\`

Every builder takes \`.abortSignal(signal)\` and \`.timeout(ms)\`; the other
calls take \`{ signal, timeout }\`.

Retries wait up to 30 seconds for \`Retry-After\`. A longer delay returns the
error immediately with \`retryAfter\`, allowing the app to decide when to retry.

## Compatibility

| @nelcota/client | Server baseline | Support |
|---|---|---|
| 0.2.x | Server \`v0.3.0\` or later | Full contract suite, OAuth routes, \`updateUser\`, exposed CORS headers and generated \`Relationships\` |
| 0.2.x | Server \`v0.2.0\` | Not supported: lacks the OAuth routes, \`PUT /auth/v1/user\`, the JSON error contract, generated \`Relationships\` and the newer exposed headers |

Release verification covers Node 22/24/26, Bun, Deno and the Chromium, Firefox
and WebKit engines. Other runtimes need their own validation.

## Development

\`\`\`sh
npm ci
npm run check && npm test && npm run test:types   # types, unit and type-level tests
npm run build && npm run size                     # dist/ and the size budget per entry
npm run test:package                              # install the tarball in JS/TS consumers
node test/runtime/smoke.mjs
bun test/runtime/smoke.mjs
deno run --allow-net --allow-read --allow-env test/runtime/smoke.mjs
cargo build -p nelcota-server
npx playwright-core install chromium firefox webkit
npm run test:contract -- --browser                # against the real binary (Docker), plus Chromium
\`\`\`

The contract run starts Postgres and Mailpit in containers and the server
from \`target/debug\`, applies \`test/contract/fixture.sql\` and generates the
types with \`nelcota types\`. It then runs the contract tests (including a
fuzz of the query encoding) and, with \`--browser\`, a Chromium page on
another origin.

Set \`NELCOTA_SDK_BROWSERS=chromium,firefox,webkit\` to exercise all browser
engines. Browser checks include the runnable demo, simultaneous refresh across
two real tabs and sign-out broadcasts. Each run owns unique container names
and dynamically assigned ports, so it can coexist with development services.

See [releasing.md](https://github.com/Nelcota/Nelcota/blob/main/sdk/typescript/docs/releasing.md) (in the repository) for the account setup, candidate checks
and tagged release procedure. [CHANGELOG.md](CHANGELOG.md) tracks SDK changes.
`,rt=`# Client contract

\`@nelcota/client\` 0.2.x targets the Nelcota HTTP protocol implemented by this
repository. The package has its own version; server compatibility is determined
by the endpoints and features below, not by matching package version numbers.

## Version scope

The Unreleased fixes in this checkout require a new package: published 0.2.0
does not include queued-login cancellation or exact bucket-limit writes below.

This is the 0.2.0 source/package candidate contract. Registry installation
requires successful publication; a server update does not install the client.
Published 0.1.2 predates native IndexedDB journaling and exact numeric
preservation below; consult its bundled documentation for that release.

## Interface

| Module | Methods | HTTP contract |
|---|---|---|
| REST | \`from().select()\`, filters, order, limit, range, single, maybeSingle | \`GET/HEAD /rest/v1/{table}\`; encoded query; optional \`Prefer: count=exact\`; \`Content-Range\` |
| REST writes | insert, update, delete, upsert, optional select | \`POST/PATCH/DELETE /rest/v1/{table}\`; JSON body; \`Prefer: return=minimal/representation\`; upsert resolution and \`on_conflict\` |
| RPC | \`rpc(name, args)\` | \`POST /rest/v1/rpc/{name}\`; named JSON arguments; caller's role |
| Auth | signUp | \`POST /auth/v1/signup\`; session or \`{user}\` awaiting confirmation |
| Auth | password login, refresh, exchangeCode | \`POST /auth/v1/token?grant_type=password/refresh_token/pkce\` |
| Auth | getUser, signOut | \`GET /auth/v1/user\`, \`POST /auth/v1/logout\` |
| Auth links | recover, magic link, resend, verify/reset | \`POST /auth/v1/recover\`, \`/magiclink\`, \`/resend\`, \`/verify\` |
| OAuth | signInWithOAuth, handleRedirect | \`GET /auth/v1/authorize\`; S256 PKCE; callback \`?code=\` exchanged once |
| Storage | upload, replace, open/download, remove | \`POST/PUT/GET/DELETE /storage/v1/object/{bucket}/{path}\`; raw bytes |
| Storage | list, signed URL, public URL | \`POST /storage/v1/object/list/{bucket}\`, \`/object/sign/{bucket}/{path}\`; \`/object/public/{bucket}/{path}\` |
| Buckets | list, get, create, update, delete | \`/storage/v1/bucket\` and \`/storage/v1/bucket/{id}\` |

\`schema\` selects the generated TypeScript schema; the server's configured
exposed schema determines the HTTP resource. It does not switch database schemas
at runtime. RLS and GRANTs always remain server/Postgres decisions.

## Results and failures

- Auth and storage return \`{data,error}\`. REST adds \`status\` and \`count\`; RPC
  adds \`status\`. Writes without \`.select()\` and HEAD responses return null.
  HEAD is typed as null, including chained selects. \`single\`/\`maybeSingle\`
  require a row representation and refuse minimal writes or HEAD before HTTP.
  A requested row representation that is empty or not a JSON array returns
  \`invalid_response\`; it never succeeds with null or another shape.
- HTTP failures preserve server \`code\`, \`message\` and status. Network, abort,
  timeout and interrupted buffered bodies return status 0 and client codes.
- HTTP error bodies larger than 64 KiB are discarded; status, a generic code
  and Retry-After remain available.
- Invalid JSON returns \`invalid_response\` with the response's HTTP status.
- JSON numbers stay numeric when their decimal digits survive JavaScript
  conversion. Unsafe integers and decimals that would lose digits become
  strings, including nested JSON values and RPC results. Generated \`bigint\`,
  \`numeric\`, \`real\` and \`double precision\` fields use \`number | string\`; regenerate
  schema types after upgrading. Pass exact values as strings in filters and
  writes. PostgreSQL array elements may be null independently of column
  nullability; generated arrays therefore use \`(T | null)[]\`.
- Scalar RPC result sets also allow null elements and group numeric unions as
  \`(number | string | null)[]\`. Functions returning view rows reference the
  generated \`Views\` section, while table rows reference \`Tables\`.
- Non-finite JSON input (\`NaN\` and infinities) throws \`NelcotaUsageError\` before
  authentication or HTTP, instead of silently becoming null. Explicit nulls
  remain valid. Sessions require the complete session/user shape, with
  \`expires_at\` and \`expires_in\` as safe, non-negative integers;
  \`refreshMargin\` must be finite and non-negative.
- Invalid developer configuration and unsafe identifiers/paths throw
  \`NelcotaUsageError\`. Errors thrown by user-supplied token/storage/fetch
  configuration outside the HTTP operation remain the caller's responsibility.
- GET and HEAD retry network failures, body-read failures, 429 and 503; mutations,
  auth token exchange, storage listing and RPC are not automatically retried.
- Timeout covers each attempt and its buffered body, excluding session refresh
  and the wait between retries. Retry-After up to 30 seconds is respected;
  longer delays return the error immediately with \`retryAfter\` for the caller.
- \`storage.open()\` hands the raw response to the caller. Subsequent stream
  errors must be handled by the caller; \`download()\` buffers into a Blob and
  returns body failures in its result.

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
tabs when upgrading to avoid mixing SDK coordination protocols. Use \`signOut()\`
or clear all site data to remove sessions; editing only localStorage no longer
changes the authoritative session. Custom adapters retain their existing semantics.

The refresh margin is capped at half the token lifetime, so short-lived tokens
and large configured margins do not rotate fresh sessions repeatedly. Background
jitter stays within the scheduled delay. An already expired token waits ten
seconds before a background attempt; explicit session reads still refresh it
immediately.

Auth methods that perform HTTP accept \`{signal,timeout}\` as the last argument.
Signals also cancel queued authentication before HTTP starts; withdrawing a
wait never cancels another operation's lifecycle ownership. Once a response is
accepted, its session publication can finish after the caller stops waiting.
Concurrent refresh callers share the first caller's timeout. Signals cancel
each caller's wait independently; rotation continues and persists its result
even when a waiter cancels. An already aborted caller does not start rotation.
REST/storage signals also cover waiting for the token source or session
refresh, without aborting an operation shared by other callers. \`signOut()\` waits
for a pending refresh and clears locally even when server revocation fails.
\`dispose()\` stops timers, closes channels and clears listeners; it neither
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
adapter errors are observed through the optional \`auth.onBackgroundError\`
handler; automatic refresh pauses until a session is written successfully.
Handler exceptions are isolated. Network errors returned in results keep the
existing bounded refresh retry. Native clients block on another owner's
unfinished reservation; an accepted replacement remains with its owner until
it can be persisted or a newer committed session or logout supersedes it.
Custom adapters require repair before sharing state that failed to persist.

An explicit \`accessToken\` controls REST/storage requests and disables automatic
session refresh in the combined client. Auth methods remain available and may
store a session when called explicitly.

## Bucket settings

Creation accepts \`BucketSettings\` with optional fields. Updating uses
\`BucketUpdateSettings\`, requires \`public\`, \`file_size_limit\` and
\`allowed_mime_types\`, and replaces the entire settings object with PUT.
Use explicit null to clear a limit. Missing fields throw \`NelcotaUsageError\`
before any HTTP request, including in JavaScript consumers.

\`Bucket.file_size_limit\` is \`number | string | null\`. Limits beyond JavaScript's
safe integer range are returned as exact decimal strings, and bucket settings
accept those strings for read-modify-write. Pass a positive canonical decimal
string for large int64 limits; the SDK sends it as an unquoted JSON integer.
Do not first convert an exact string to \`number\`: JavaScript rounding cannot
be recovered. The server retains its positive-int64 range and settings validation;
invalid values return their existing HTTP errors. Non-finite numbers still throw
before HTTP. Noncanonical decimal strings remain JSON-escaped and quoted.

## Release acceptance

Run \`check\`, unit/type tests, \`build\`, \`size\`, \`test:package\`, runtime smoke tests
and \`test:contract -- --browser\`. CI tests Node 22/24/26, Bun, Deno and
Chromium/Firefox/WebKit. Edge hosts may consume the Web API implementation but
are not included in this compatibility guarantee until tested on that host.
`,it=`# Começando com o SDK JavaScript do Nelcota

As correções **Unreleased** deste checkout exigem um novo pacote do cliente;
elas ainda não fazem parte do 0.2.0 publicado. O cancelamento passa a retirar
logins pendentes da fila, preservando a conclusão de operações já aceitas.
\`Bucket.file_size_limit\` passa a \`number | string | null\`: mantenha limites
grandes como strings decimais exatas ao ler e atualizar o bucket. O SDK envia
esses valores como inteiros JSON, e o servidor mantém as validações de faixa.
Converter primeiro para \`number\` pode perder precisão; use \`null\` para limpar
o limite. Atualizar o servidor não atualiza o pacote do aplicativo.

O mesmo pacote funciona em JavaScript e TypeScript. Use um servidor Nelcota
com os recursos descritos na [matriz de compatibilidade](../README.md#compatibility).

## 1. Instale

\`\`\`sh
npm install @nelcota/client@0.2.0
\`\`\`

O checkout prepara o candidato 0.2.0; o comando de registro acima só funciona
após sua publicação. O pacote publicado 0.1.2 tem comportamento anterior;
atualizar o servidor não atualiza seu SDK. Até publicar o candidato, instale
um arquivo local a partir da raiz do repositório:

\`\`\`sh
cd sdk/typescript
npm ci
NELCOTA_SDK_TARBALL="$(pwd)/$(npm pack --silent)"
mkdir -p ../../.nelcota/sdk-consumer
cd ../../.nelcota/sdk-consumer
npm init -y
npm install "$NELCOTA_SDK_TARBALL"
\`\`\`

## 2. Prepare os dados

Execute [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql) pelo editor SQL do painel ou copie-o para
\`migrations/\` e rode \`nelcota migrate\`. Ele cria \`notes\` e o bucket privado
\`files\`, e pode ser executado mais de uma vez. Cada usuário acessa suas
próprias notas e arquivos, conforme as políticas do Postgres.

## 3. Crie o cliente e entre

\`\`\`js
import { createClient } from '@nelcota/client';

const nelcota = createClient('https://api.exemplo.com');
const { data: session, error } = await nelcota.auth.signInWithPassword({
  email: 'ana@exemplo.com',
  password: 'sua-senha',
});
if (error) throw error;
\`\`\`

Para criar uma conta, use \`auth.signUp({ email, password })\`. Se a confirmação
de email estiver ativada, o cadastro retorna \`data.session === null\`: confirme
o email e depois entre. O cadastro não garante uma sessão imediata.

## 4. Grave e consulte

\`\`\`js
const created = await nelcota.from('notes')
  .insert({ body: 'Minha primeira nota' }).select('id,body').single();
if (created.error) throw created.error;

const { data: notes, error: readError } = await nelcota.from('notes')
  .select('id,body').order('id', { ascending: false }).limit(20);
if (readError) throw readError;
console.log(notes);
\`\`\`

Para alterar ou excluir, inclua um filtro, por exemplo \`.eq('id', id)\`.
Uma lista vazia pode significar que a política RLS escondeu as linhas. Consulte
os GRANTs e as políticas no painel para entender uma recusa.

## 5. Envie um arquivo

\`\`\`js
const path = \`\${session.user.id}/hello.txt\`;
const files = nelcota.storage.from('files');
const upload = await files.upload(path, 'Olá!', { upsert: true });
if (upload.error) throw upload.error;
const downloaded = await files.download(path);
if (downloaded.error) throw downloaded.error;
console.log(await downloaded.data.text());
\`\`\`

O bucket desse exemplo é privado. Para compartilhar temporariamente, use
\`createSignedUrl(path, 60)\` e confira seu \`error\` antes de usar a URL.

## 6. Use TypeScript quando quiser

\`\`\`sh
nelcota types -o src/database.ts
\`\`\`

\`\`\`ts
import { createClient } from '@nelcota/client';
import type { Database } from './database.js';
const nelcota = createClient<Database>('https://api.exemplo.com');
\`\`\`

Gere os tipos novamente depois de alterar o schema. JavaScript não exige esse
passo; TypeScript usa os tipos para conferir tabelas, colunas e argumentos.

## Exemplos executáveis

- Navegador: no diretório do SDK, rode \`npm run build\` e
  \`npm run example:browser\`. Abra \`http://127.0.0.1:5178\`, informe a URL
  da API e entre. A página permite cadastro, notas e upload.
- Node: configure \`NELCOTA_URL\`, \`NELCOTA_EMAIL\`, \`NELCOTA_PASSWORD\` e rode
  \`node examples/node.mjs\` no diretório do SDK após instalar o pacote local.
  Use \`NELCOTA_SIGN_UP=1\` se desejar cadastrar uma conta de teste.
- Servidor: configure \`NELCOTA_URL\` e rode \`node examples/server.mjs\`.
  Faça \`GET http://127.0.0.1:5179/notes\` com o token do usuário no cabeçalho
  \`Authorization: Bearer ...\`. O exemplo cria um cliente por requisição.

Nos exemplos publicados, os imports usam \`@nelcota/client\`. Para executá-los
diretamente do checkout, faça o build antes: a resolução do pacote encontra
os exports locais. O servidor do exemplo de navegador fornece um import map.

## Sessões e erros

No pacote publicado 0.1.2, a sessão do navegador usa localStorage. Na fonte
atual, um registro transacional IndexedDB mantém o estado oficial da sessão e
do PKCE; localStorage é um espelho. Esse comportamento exige um novo build/pacote
e IndexedDB disponível. A renovação é coordenada entre abas com Web Locks.
Em ambientes sem Web Locks, passe
\`auth: { storage: sessionStorage }\` para manter cada sessão na sua aba.
No servidor, use um cliente por requisição e encaminhe o token do usuário.
Um \`service_role\` deve permanecer apenas no servidor, pois ignora RLS.

Cada chave de storage mantém um verificador OAuth pendente. Iniciar outro login
substitui a tentativa anterior; a gravação, o redirecionamento e o consumo no
callback usam o mesmo bloqueio. Para fluxos de login independentes, use chaves
de storage diferentes.

HTTP, rede, timeout e cancelamento retornam \`{ data, error }\`. Configuração
inválida pode lançar uma exceção. Para liberar timers e listeners, use
\`nelcota.dispose()\`; para encerrar a sessão, use \`await nelcota.auth.signOut()\`.

Os demais métodos e opções estão no [README](../README.md) e no
[contrato do cliente](contract.md).
`,at=`# Releasing @nelcota/client

The release workflow validates the tagged commit against the real server before
publishing. Its reusable verification job runs the same package, runtime and
browser checks as pull-request CI. A failing check prevents the publish job.

## Local candidate

From \`sdk/typescript\`:

\`\`\`sh
npm ci
npm run check
npm test
npm run test:types
npm run build
npm run size
npm run test:package
npm run test:runtime
cargo build -p nelcota-server
npx playwright-core install chromium firefox webkit
npm run test:contract -- --browser
npm pack
\`\`\`

Set \`NELCOTA_SDK_BROWSERS=chromium,firefox,webkit\` to run all browser engines
locally. The default contract run uses Chromium. Bun and Deno smoke commands are
listed in the README. \`npm pack\` builds first, and the tarball contains only
compiled code, declarations, license, docs and examples. Inspect the candidate
with \`npm pack --dry-run\` before publishing.

## npm account setup

The maintainer needs access to the \`@nelcota\` scope. Authenticate locally with
\`npm login\` and verify with \`npm whoami\`; never put a token in this repository.
If npm does not yet expose package settings, complete the initial authenticated
publish of the validated candidate before configuring subsequent OIDC releases.
Use \`npm publish --access public\` from this directory for that first publish.
The publication hook runs local checks; the integration gate must also have
passed for the same source before this manual bootstrap.

Configure npm trusted publishing using:

- Owner: \`Nelcota\`
- Repository: \`Nelcota\`
- Workflow filename: \`sdk-release.yml\`
- Environment: \`npm\`

The GitHub-hosted publish job uses \`id-token: write\`, not a stored npm token.
See the [official trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/)
for current account/setup requirements. Configure it when ready to publish:
new configurations require a first successful publish within two days.

## Versioned release

1. Update \`package.json\` and the lockfile version, and add a dated changelog
   entry. Keep server compatibility accurate; do not infer it from SemVer alone.
2. Commit the reviewed SDK and workflow changes. Run/inspect CI on that commit.
3. Create \`sdk-v<package version>\` on that commit and push the tag. The workflow
   checks that the tag matches package.json, verifies the commit and publishes.
4. Confirm the workflow's publish succeeded and \`npm view @nelcota/client version\`
   returns the new version. Install it in a fresh consumer before announcing it.

Do not overwrite a published version. Fix a bad release with a new patch version
and, when appropriate, deprecate the bad version with a concrete migration note.
`,ot=`// GET /notes forwards the caller's bearer token to Postgres RLS.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRestClient } from '@nelcota/client/rest';

export function createExampleServer(apiUrl) {
  if (!apiUrl) throw new Error('Set NELCOTA_URL');
  return createServer(async (request, response) => {
    const json = (status, data) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (request.method !== 'GET' || request.url !== '/notes') return json(404, { code: 'not_found' });
    const match = request.headers.authorization?.match(/^Bearer ([^\\s]+)$/i);
    if (!match) return json(401, { code: 'session_missing' });
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    try {
      const client = createRestClient(apiUrl, { accessToken: () => match[1] });
      const { data, error } = await client.from('notes').select('id,body').order('id', { ascending: false })
        .limit(20).abortSignal(controller.signal);
      if (error) return json(error.status || 502, { code: error.code, message: error.message });
      return json(200, data);
    } catch {
      return json(500, { code: 'server_error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createExampleServer(process.env.NELCOTA_URL).listen(Number(process.env.PORT ?? 5179), '127.0.0.1', () => {
    console.log('GET http://127.0.0.1:5179/notes with Authorization: Bearer <user token>');
  });
}
`,st={"REST API":`API REST`,"Generated from the exposed schema (`NELCOTA_DB_SCHEMA`, default `public`). Every\ntable, view and function in the schema becomes an endpoint, and **Postgres\ndecides access**: GRANTs say which roles may use each object and RLS says which\nrows each user sees.":"Gerada a partir do esquema exposto (`NELCOTA_DB_SCHEMA`, padrão `public`). Toda tabela, view e função do esquema se torna um endpoint, e **o Postgres decide o acesso**: GRANTs dizem quais papéis podem usar cada objeto e RLS diz quais linhas cada usuário vê.",Prerequisites:`Pré-requisitos`,"You need an initialized server, tables/functions in its exposed schema and\nGRANTs for the caller. Query examples use illustrative orders/products schemas;\ncreate your own matching SQL first. This reference describes current source;\nuse release-tag documentation for older binaries.":`Você precisa de um servidor inicializado, tabelas/funções em seu schema exposto e GRANTs para o solicitante. As consultas usam schemas ilustrativos de pedidos/produtos; crie primeiro o SQL correspondente. Esta referência descreve a fonte atual; use a documentação da tag da versão para binários antigos.`,"New tables have no GRANT for `anon`/`authenticated`: until you grant it, the\nAPI answers 401/403. This is intentional.":"Novas tabelas não têm GRANT para `anon`/`authenticated`: até concedê-lo, a API responde 401/403. Isso é intencional.","Reads: `GET /rest/v1/{table}`":"Leituras: `GET /rest/v1/{table}`",Parameter:`Parâmetro`,Example:`Exemplo`,Effect:`Efeito`,"columns (default `*`) and embedded relations, see below":"colunas (padrão `*`) e relacionamentos embutidos, veja abaixo","filter (several are combined with AND)":`filtro (vários são combinados com AND)`,"group of filters, see below":`grupo de filtros, veja abaixo`,ordering:`ordenação`,pagination:`paginação`,Operators:`Operadores`,Operator:`Operador`,SQL:`SQL`,"`LIKE`, `ILIKE` (`*` becomes `%`)":"`LIKE`, `ILIKE` (`*` se torna `%`)","Values reach Postgres as parameters and Postgres itself converts them to the\ncolumn type (`$1::text::<type>`). A value invalid for the type gives 400.":"Valores chegam ao Postgres como parâmetros e o próprio Postgres os converte para o tipo da coluna (`$1::text::<type>`). Um valor inválido para o tipo resulta em 400.","Embedding related rows":`Incluir linhas relacionadas`,"`select` follows foreign keys in either direction, so one request returns an\norder with its customer and items:":"`select` segue chaves estrangeiras nas duas direções, então uma requisição retorna um pedido com seu cliente e itens:","When this table has the foreign key (`orders.customer_id → customers`), the\nembed is an **object**, or `null` when nothing matches. When the other table\npoints here (`items.order_id → orders`), it is an **array**, `[]` when empty.":"Quando esta tabela tem a chave estrangeira (`orders.customer_id → customers`), o relacionamento embutido é um **objeto**, ou `null` quando nada corresponde. Quando a outra tabela aponta para cá (`items.order_id → orders`), é um **array**, `[]` quando vazio.","`items(*)` takes every column. `purchases:orders(*)` renames the key.":"`items(*)` seleciona todas as colunas. `purchases:orders(*)` renomeia a chave.","Two foreign keys to the same table (`buyer_id`, `seller_id` → `users`) are\nambiguous: pick one with the column or the constraint name,\n`buyer:users!buyer_id(email),seller:users!seller_id(email)`. The error lists\nthe options.":"Duas chaves estrangeiras para a mesma tabela (`buyer_id`, `seller_id` → `users`) são ambíguas: escolha uma pela coluna ou pelo nome da restrição, `buyer:users!buyer_id(email),seller:users!seller_id(email)`. O erro lista as opções.","Embeds nest, up to 4 levels: `customers?select=name,orders(id,items(product))`.\nA table cannot be embedded into itself (self-reference). A key that repeats\na selected column is a 400: rename it with an alias.":"Relacionamentos embutidos se aninham até 4 níveis: `customers?select=name,orders(id,items(product))`. Uma tabela não pode ser embutida nela mesma (autorreferência). Uma chave que repete uma coluna selecionada resulta em 400: renomeie-a com um alias.","**RLS applies to the embedded table** too: each embed runs with the request's\nrole, so it shows exactly what a direct read of that table would. A related\nrow the user cannot see becomes `null` or is left out of the array.":"**RLS também se aplica à tabela embutida**: cada relacionamento executa com o papel da requisição, então mostra exatamente o que uma leitura direta dessa tabela mostraria. Uma linha relacionada que o usuário não pode ver se torna `null` ou fica fora do array.","Works in the representation of writes (`return=representation`).":"Funciona na representação de escritas (`return=representation`).",'Each embed is a correlated subquery: index the foreign key columns on the\n"many" side (Postgres does not create those indexes on its own).':`Cada relacionamento embutido é uma subconsulta correlacionada: indexe as colunas de chave estrangeira no lado "muitos" (o Postgres não cria esses índices automaticamente).`,"Filtering, ordering and paging embedded rows":`Filtrar, ordenar e paginar linhas embutidas`,"A parameter prefixed with the embed's key (its alias, when it has one) applies\nto the embedded rows; a deeper embed adds its key to the path:":`Um parâmetro prefixado com a chave do relacionamento (seu alias, quando houver) se aplica às linhas embutidas; um relacionamento mais profundo adiciona sua chave ao caminho:`,"Every filter operator and `or`/`and` work, plus `order`, `limit` and\n`offset`. Paging only applies to arrays: on a single-row embed it is a 400.":"Todos os operadores de filtro e `or`/`and` funcionam, além de `order`, `limit` e `offset`. A paginação só se aplica a arrays: em um relacionamento de linha única, resulta em 400.","These narrow the **embedded rows only**: the parent rows stay, with `[]` or\n`null` where nothing matched. Filters on the parent table (`?id=eq.1`) still\npick the parent rows.":"Eles restringem **apenas as linhas embutidas**: as linhas pai permanecem, com `[]` ou `null` onde nada correspondeu. Filtros na tabela pai (`?id=eq.1`) continuam selecionando as linhas pai.","The order of the parameters in the URL does not matter.":`A ordem dos parâmetros na URL não importa.`,"Combining filters: `or` and `and`":"Combinar filtros: `or` e `and`","Same syntax as PostgREST. Inside the parentheses each filter is written\n`column.operator.value`:":"Mesma sintaxe do PostgREST. Dentro dos parênteses, cada filtro é escrito como `column.operator.value`:","`and(...)` and `or(...)` nest; `not.` before a group negates it, and\n`column.not.operator.value` negates one filter.":"`and(...)` e `or(...)` se aninham; `not.` antes de um grupo o nega, e `column.not.operator.value` nega um filtro.",'A value with commas or parentheses goes in double quotes, with `\\"` and `\\\\`\nas escapes: `or=(name.eq."Ruler, 30cm",name.eq."f(x)")`. `in` lists keep\ntheir own quoting.':'Um valor com vírgulas ou parênteses vai entre aspas duplas, com `\\"` e `\\\\` como escapes: `or=(name.eq."Ruler, 30cm",name.eq."f(x)")`. Listas `in` mantêm suas próprias aspas.',"At most 8 nested levels and 100 filters per group; beyond that, 400.":`No máximo 8 níveis aninhados e 100 filtros por grupo; acima disso, 400.`,"A column literally named `or` or `and` cannot be used as a direct filter,\nonly inside a group (`and=(or.eq.1)`), as in PostgREST.":"Uma coluna literalmente chamada `or` ou `and` não pode ser usada como filtro direto, apenas dentro de um grupo (`and=(or.eq.1)`), como no PostgREST.","RLS still applies: a group can only narrow what the policies allow, never\nwiden it, on reads and on `PATCH`/`DELETE`.":"RLS continua se aplicando: um grupo só pode restringir o que as políticas permitem, nunca ampliar, em leituras e em `PATCH`/`DELETE`.",Responses:`Respostas`,"Body: a JSON array built by Postgres (`json_agg`).":"Corpo: um array JSON construído pelo Postgres (`json_agg`).","`Content-Range: 0-19/*`, or `0-19/137` with `Prefer: count=exact`.":"`Content-Range: 0-19/*`, ou `0-19/137` com `Prefer: count=exact`.","`NELCOTA_MAX_ROWS` defaults to **1000** and must be positive. It caps the root\nread, each embedded collection, and set-returning RPCs, including explicit\nlimits larger than the cap. Embedded collections in write representations\nhave a fixed cap of 1000. Paginate collections to reach subsequent rows.":"`NELCOTA_MAX_ROWS` tem padrão **1000** e deve ser positivo. Limita a leitura raiz, cada coleção embutida e RPCs que retornam conjuntos, incluindo limites explícitos maiores que o teto. Coleções embutidas em representações de escrita têm teto fixo de 1000. Pagine coleções para alcançar as linhas seguintes.","JSON has an **8 MiB serialization budget**, checked in PostgreSQL before each\nrow enters an aggregate, also on write representations and scalar RPCs.\nIntermediate embedded values count towards the same budget, so deeply nested\nresults can reach it with less than 8 MiB of final output. Oversized results\nreturn `413 response_too_large`; a write requesting such a representation\nrolls back. A single database value must still be serialized before its size\ncan be checked. Administrative streaming exports remain available for large data.":"O JSON tem um **orçamento de serialização de 8 MiB**, verificado no PostgreSQL antes de cada linha entrar em um agregado, também em representações de escrita e RPCs escalares. Valores embutidos intermediários contam para o mesmo orçamento, então resultados muito aninhados podem atingi-lo com menos de 8 MiB de saída final. Resultados grandes demais retornam `413 response_too_large`; uma escrita que solicita essa representação sofre rollback. Um único valor do banco ainda precisa ser serializado antes de verificar seu tamanho. Exportações administrativas em streaming continuam disponíveis para dados grandes.","`select` accepts at most 128 items across the relation tree. Repeated columns\nare rejected; `*` already includes explicitly selected columns.":"`select` aceita no máximo 128 itens em toda a árvore de relacionamentos. Colunas repetidas são rejeitadas; `*` já inclui colunas selecionadas explicitamente.",Writes:`Escritas`,"An insert accepts at most **1000 rows** and **128 distinct column sets** per\nrequest. Split larger batches into requests. A request body (writes and RPC\narguments) can have at most `NELCOTA_MAX_BODY_BYTES` bytes, **2 MiB** by\ndefault; a larger one gets `413 payload_too_large`. The body is buffered and\nparsed whole, so raise the limit only as far as the server's memory allows. Each accepted request keeps its\ntransactional behavior and missing columns still receive their defaults.":"Uma inserção aceita no máximo **1000 linhas** e **128 conjuntos distintos de colunas** por requisição. Divida lotes maiores em requisições. Um corpo de requisição (escritas e argumentos RPC) pode ter no máximo `NELCOTA_MAX_BODY_BYTES` bytes, **2 MiB** por padrão; um corpo maior recebe `413 payload_too_large`. O corpo é carregado e analisado inteiro, então aumente o limite apenas até onde a memória do servidor permitir. Cada requisição aceita mantém seu comportamento transacional e colunas ausentes ainda recebem seus valores padrão.",Verb:`Verbo`,Body:`Corpo`,Filters:`Filtros`,"Without `return=representation`":"Sem `return=representation`","With `return=representation`":"Com `return=representation`","object or array":`objeto ou array`,"not accepted":`não aceitos`,"201 empty":`201 vazio`,"201 + array":`201 + array`,object:`objeto`,"**required**":`**obrigatórios**`,"200 + array":`200 + array`,"`select=` also picks the columns of the representation.":"`select=` também escolhe as colunas da representação.","On `POST`, missing columns get their `DEFAULT`, even in a batch whose\nobjects have different keys.":"Em `POST`, colunas ausentes recebem seu `DEFAULT`, mesmo em um lote cujos objetos tenham chaves diferentes.","An empty body on `POST`/`PATCH` is refused (400 `invalid_body`); to insert\na row of defaults, send `{}`. An `/rpc` call without a body has no arguments.":"Corpo vazio em `POST`/`PATCH` é recusado (400 `invalid_body`); para inserir uma linha com valores padrão, envie `{}`. Uma chamada `/rpc` sem corpo não tem argumentos.","`PATCH`/`DELETE` without a filter are refused (400), to avoid changing or\ndeleting the whole table by mistake. To do that on purpose, use an explicit\nfilter (`?id=not.is.null`).":"`PATCH`/`DELETE` sem filtro são recusados (400) para evitar alterar ou excluir toda a tabela por engano. Para fazer isso intencionalmente, use um filtro explícito (`?id=not.is.null`).","`order`, `limit` and `offset` are refused on `PATCH`/`DELETE` (400\n`invalid_query`): they change every row the filters match, so narrow the\nfilters instead.":"`order`, `limit` e `offset` são recusados em `PATCH`/`DELETE` (400 `invalid_query`): eles alteram toda linha correspondente aos filtros, então restrinja os filtros.","With `Prefer: count=exact`, `PATCH`/`DELETE` answer `Content-Range: */<n>`\nwith the number of rows changed (and `Preference-Applied: count=exact`),\nwith or without `return=representation`.":"Com `Prefer: count=exact`, `PATCH`/`DELETE` respondem `Content-Range: */<n>` com o número de linhas alteradas (e `Preference-Applied: count=exact`), com ou sem `return=representation`.","`return=representation` runs `RETURNING`, which requires `SELECT`\npermission (GRANT + policy) on the written rows.":"`return=representation` executa `RETURNING`, que exige permissão `SELECT` (GRANT + política) sobre as linhas escritas.","Upsert: create or update in one call":`Upsert: criar ou atualizar em uma chamada`,"`Prefer: resolution=merge-duplicates` updates a row whose key already exists,\nwith the columns the object sent (the others keep their values; the key\nitself is never changed). `resolution=ignore-duplicates` keeps the existing\nrow; with `return=representation`, only the rows actually written come back.":"`Prefer: resolution=merge-duplicates` atualiza uma linha cuja chave já existe com as colunas enviadas pelo objeto (as demais mantêm seus valores; a chave em si nunca muda). `resolution=ignore-duplicates` mantém a linha existente; com `return=representation`, apenas as linhas realmente escritas retornam.","The key is the primary key, or `?on_conflict=col1,col2`, which must match a\nunique constraint (otherwise 400). `on_conflict` without `resolution` is a":"A chave é a chave primária ou `?on_conflict=col1,col2`, que deve corresponder a uma restrição única (caso contrário, 400). `on_conflict` sem `resolution` resulta em","The response confirms with `Preference-Applied`.":"A resposta confirma com `Preference-Applied`.","A batch that repeats a key gets a 400 from Postgres (a row cannot be updated\ntwice in one statement).":`Um lote que repete uma chave recebe 400 do Postgres (uma linha não pode ser atualizada duas vezes em uma instrução).`,"A `GENERATED ALWAYS AS IDENTITY` column cannot receive values, so it cannot\nbe the upsert key: use `BY DEFAULT`, or another unique column with\n`on_conflict`.":"Uma coluna `GENERATED ALWAYS AS IDENTITY` não pode receber valores, então não pode ser a chave do upsert: use `BY DEFAULT` ou outra coluna única com `on_conflict`.","RLS still decides: on a conflict, the existing row must pass the `UPDATE`\npolicy. A user cannot take over someone else's row through an upsert (403).":"RLS continua decidindo: em um conflito, a linha existente deve passar pela política `UPDATE`. Um usuário não pode assumir a linha de outra pessoa por upsert (403).","Functions: `POST /rest/v1/rpc/{function}`":"Funções: `POST /rest/v1/rpc/{function}`",'Body: an object with the **named** arguments (`{"a": 1, "b": 2}`); arguments\nwith a `DEFAULT` are optional. With overloads, the signature whose names match\nthe keys wins.':'Corpo: objeto com os argumentos **nomeados** (`{"a": 1, "b": 2}`); argumentos com `DEFAULT` são opcionais. Com sobrecargas, vence a assinatura cujos nomes correspondem às chaves.',"Function returns":`Retorno da função`,Response:`Resposta`,"JSON array":`array JSON`,"scalar or composite":`escalar ou composto`,"JSON value":`valor JSON`,"`RAISE EXCEPTION` becomes 400 with the message, also with a custom SQLSTATE of\nclass `P0` (`USING ERRCODE = 'P0002'`) and for a failed `ASSERT`; its `DETAIL`\nand `HINT` come back as `details` and `hint` (see [Errors](#errors)). The\nfunction runs with the JWT's role (unless it is `SECURITY DEFINER`):\n`auth.uid()` works inside it.":"`RAISE EXCEPTION` se torna 400 com a mensagem, também com SQLSTATE personalizado da classe `P0` (`USING ERRCODE = 'P0002'`) e para um `ASSERT` com falha; seu `DETAIL` e `HINT` retornam como `details` e `hint` (veja [Erros](#errors)). A função executa com o papel do JWT (a menos que seja `SECURITY DEFINER`): `auth.uid()` funciona dentro dela.","**Warning:** By default, Postgres grants `EXECUTE` on new functions to\n`PUBLIC` (including `anon`). For sensitive functions:\n`REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC; GRANT EXECUTE ON FUNCTION f() TO authenticated;`":"**Aviso:** Por padrão, o Postgres concede `EXECUTE` em novas funções a `PUBLIC` (incluindo `anon`). Para funções sensíveis: `REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC; GRANT EXECUTE ON FUNCTION f() TO authenticated;`","OpenAPI: `GET /rest/v1/`":"OpenAPI: `GET /rest/v1/`","An OpenAPI 3.0 document generated from the catalog and **filtered by the\nrequest's role**: `anon` only sees what `anon` may use.":"Um documento OpenAPI 3.0 gerado do catálogo e **filtrado pelo papel da requisição**: `anon` só vê o que `anon` pode usar.","Schema models: `nelcota types -o database.ts` (TypeScript, default), or\n`nelcota types --lang rust -o database.rs` for the\n[Rust SDK](../sdk/rust/README.md). The Rust models distinguish omitted write\nfields from explicit nulls and keep Postgres numeric precision.":"Modelos do esquema: `nelcota types -o database.ts` (TypeScript, padrão) ou `nelcota types --lang rust -o database.rs` para o [SDK Rust](../sdk/rust/README.md). Modelos Rust distinguem campos de escrita omitidos de null explícito e mantêm a precisão numérica do Postgres.","Views run with their owner's underlying privileges by default and can bypass\nthe caller's row policies even when the source table enables RLS. For views\nthat should apply the caller's policies, use `security_invoker = true` and grant\nthe caller the required access to the underlying tables. The panel warns about\nexposed owner views; changing that option or revoking their GRANT clears the\nwarning. Materialized views and foreign tables have no local row policies and\nalso need explicit access controls.":"Por padrão, views usam os privilégios do dono nas tabelas de origem e podem ignorar as políticas do usuário, mesmo quando essas tabelas têm RLS ativo. Para aplicar as políticas do usuário, use `security_invoker = true` e conceda o acesso necessário às tabelas de origem. O painel alerta sobre views expostas com os privilégios do dono; alterar essa opção ou revogar o GRANT remove o alerta. Views materializadas e tabelas externas não têm políticas locais por linha e também precisam de controles de acesso explícitos.","Catalog reload":`Recarga do catálogo`,"The API keeps the introspection in memory. An event trigger (migration V3)\nnotifies the server after DDL. Reloads are coalesced/serialized and failed\nrefreshes retry with bounded backoff; there is no fixed completion guarantee. Without a\nsuperuser (some managed Postgres services), reload by hand:":`A API mantém a introspecção em memória. Um event trigger (migração V3) notifica o servidor após DDL. Recargas são agrupadas/serializadas e falhas são repetidas com backoff limitado; não há prazo fixo garantido. Sem superusuário (alguns serviços Postgres gerenciados), recarregue manualmente:`,Errors:`Erros`,"Every error from the server (REST, auth, storage, unknown routes, wrong\nmethods, body limits and timeouts) is JSON with the same shape:":`Todo erro do servidor (REST, autenticação, armazenamento, rotas desconhecidas, métodos incorretos, limites de corpo e timeouts) é JSON com o mesmo formato:`,"`code` and `message` are always present. `code` is stable and meant for\nprograms; `message` is English text for people.":"`code` e `message` estão sempre presentes. `code` é estável e destinado a programas; `message` é texto em inglês para pessoas.",'Errors that come from Postgres add `sqlstate` (the 5-character SQLSTATE)\nand, when Postgres provides them, `details`, `hint` and `constraint`\n(`DETAIL`, `HINT` and the violated constraint\'s name). Absent fields are\nomitted, never `null`. For `db_error`, `message` stays `"<text> (<sqlstate>)"`.':'Erros vindos do Postgres adicionam `sqlstate` (SQLSTATE de 5 caracteres) e, quando fornecidos pelo Postgres, `details`, `hint` e `constraint` (`DETAIL`, `HINT` e nome da restrição violada). Campos ausentes são omitidos, nunca `null`. Para `db_error`, `message` permanece `"<text> (<sqlstate>)"`.',"Every response carries `x-request-id` (see [Request IDs](#request-ids)):\nquote it when reporting an error.":"Toda resposta inclui `x-request-id` (veja [IDs de requisição](#request-ids)): informe-o ao relatar um erro.",Status:`Status`,When:`Quando`,"invalid column/operator/order in the URL; `order`/`limit`/`offset` on `PATCH`/`DELETE`":"coluna/operador/ordenação inválidos na URL; `order`/`limit`/`offset` em `PATCH`/`DELETE`","the body is not valid JSON, or is empty on `POST`/`PATCH`":"corpo não é JSON válido ou está vazio em `POST`/`PATCH`","value invalid for the type, check, not null, generated column, `RAISE EXCEPTION` (any SQLSTATE of class `P0`)":"valor inválido para o tipo, check, not null, coluna gerada, `RAISE EXCEPTION` (qualquer SQLSTATE da classe `P0`)",'invalid or expired JWT (`WWW-Authenticate: Bearer error="invalid_token"`)':'JWT inválido ou expirado (`WWW-Authenticate: Bearer error="invalid_token"`)',"`anon` without permission: sign in (`WWW-Authenticate: Bearer`)":"`anon` sem permissão: autentique-se (`WWW-Authenticate: Bearer`)","role without permission, or a policy violated on write":`papel sem permissão ou política violada na escrita`,"table/function outside the exposed schema, or an unknown route":`tabela/função fora do esquema exposto ou rota desconhecida`,"the route exists but not with this method (`Allow` lists the methods)":"a rota existe, mas não com este método (`Allow` lista os métodos)","unique key, foreign key or exclusion constraint violated":`restrição de chave única, chave estrangeira ou exclusão violada`,"request body over `NELCOTA_MAX_BODY_BYTES` (default 2 MiB)":"corpo da requisição acima de `NELCOTA_MAX_BODY_BYTES` (padrão 2 MiB)","the JSON response would exceed the 8 MiB budget":`a resposta JSON excederia o orçamento de 8 MiB`,"an auth or storage JSON endpoint without `Content-Type: application/json`":"endpoint JSON de autenticação ou armazenamento sem `Content-Type: application/json`","an auth or storage JSON body with a missing field or a field of the wrong type":`corpo JSON de autenticação ou armazenamento com campo ausente ou de tipo incorreto`,"too many attempts (`Retry-After`)":"tentativas demais (`Retry-After`)","unexpected error; details only in the server log":`erro inesperado; detalhes apenas no log do servidor`,"database unreachable, or a transient failure: serialization failure (`40001`), deadlock (`40P01`), lock not available (`55P03`), too many connections (`53300`), server shutting down or starting (`57P01`, `57P02`, `57P03`). Comes with `Retry-After: 1` (and `sqlstate` when Postgres answered): retry the request":"banco inacessível ou falha transitória: falha de serialização (`40001`), deadlock (`40P01`), bloqueio indisponível (`55P03`), conexões demais (`53300`), servidor encerrando ou iniciando (`57P01`, `57P02`, `57P03`). Inclui `Retry-After: 1` (e `sqlstate` quando o Postgres respondeu): repita a requisição","`statement_timeout` (`NELCOTA_STATEMENT_TIMEOUT_SECS`, default 10 s; `sqlstate` `57014`)":"`statement_timeout` (`NELCOTA_STATEMENT_TIMEOUT_SECS`, padrão 10 s; `sqlstate` `57014`)","the whole request took longer than `NELCOTA_REQUEST_TIMEOUT_SECS` (default 15 s, must exceed the statement timeout)":"a requisição inteira demorou mais que `NELCOTA_REQUEST_TIMEOUT_SECS` (padrão 15 s, deve exceder o timeout de instrução)","Auth and storage add their own codes; see [schema-auth.md](schema-auth.md) and\n[storage.md](storage.md).":`Autenticação e armazenamento adicionam seus próprios códigos; veja [schema-auth.md](schema-auth.md) e [storage.md](storage.md).`,"Request IDs":`IDs de requisição`,"Each response carries an `x-request-id` header: the one the request came with\n(for example from a proxy in front), or a new UUID. The server logs one line\nper response at `INFO` with the method, path (never the query string), status,\nlatency and that id, so an error a user reports can be found in the log.\nBrowsers can read the header (it is in `Access-Control-Expose-Headers`).":"Cada resposta inclui um cabeçalho `x-request-id`: o recebido na requisição (por exemplo, de um proxy à frente) ou um novo UUID. O servidor registra uma linha por resposta em `INFO` com método, caminho (nunca a query string), status, latência e esse ID, para encontrar no log um erro relatado por um usuário. Navegadores podem ler o cabeçalho (está em `Access-Control-Expose-Headers`).","Out of the MVP":`Fora do MVP`,"Filtering parent rows by their embeds (PostgREST's `!inner`),\nself-referencing embeds, `GET` on `/rpc`, `Accept: application/vnd.pgrst.object+json`.":"Filtrar linhas pai pelos relacionamentos embutidos (`!inner` do PostgREST), relacionamentos autorreferentes, `GET` em `/rpc`, `Accept: application/vnd.pgrst.object+json`.","Related guides":`Guias relacionados`,"See [auth](schema-auth.md), [JWT/roles](jwt-and-roles.md), [storage](storage.md) and [troubleshooting](troubleshooting.md).":`Veja [autenticação](schema-auth.md), [JWT/papéis](jwt-and-roles.md), [armazenamento](storage.md) e [solução de problemas](troubleshooting.md).`},ct={Architecture:`Arquitetura`,Prerequisites:`Pré-requisitos`,"This page describes current source ownership and budgets. To build it, use the\npinned Rust toolchain; PostgreSQL is required for runtime validation. Historical\narchitecture choices belong to the decision log, and published artifacts can\npredate source-only capabilities.":`Esta página descreve propriedade de módulos e orçamentos da fonte atual. Para compilá-la, use o Rust fixado no projeto; validação em execução exige PostgreSQL. Escolhas históricas ficam no registro de decisões, e artefatos publicados podem ser anteriores a capacidades exclusivas da fonte.`,Crates:`Crates`,Crate:`Crate`,Responsibility:`Responsabilidade`,"config (`figment`), HTTP errors, `Claims`/`Role`, pool, migrations, `begin_request`":"configuração (`figment`), erros HTTP, `Claims`/`Role`, pool, migrações, `begin_request`","`JwtVerifier` trait, EdDSA/HS256 keys and JWKS, `Auth` extractor, signup/login/refresh/logout, email links (recovery, confirmation, magic link), OAuth/OIDC providers, argon2id, rate limit":"trait `JwtVerifier`, chaves EdDSA/HS256 e JWKS, extrator `Auth`, cadastro/login/renovação/logout, links de e-mail (recuperação, confirmação, link mágico), provedores OAuth/OIDC, argon2id, limitação de requisições","catalog introspection, SQL builder, CRUD/RPC, OpenAPI, TS types":`introspecção do catálogo, construtor SQL, CRUD/RPC, OpenAPI, tipos TS`,"files: buckets and objects under RLS (`storage` schema), bytes on disk or S3 (`object_store`), signed URLs, orphan collector":"arquivos: buckets e objetos sob RLS (esquema `storage`), bytes em disco ou S3 (`object_store`), URLs assinadas, coletor de órfãos","transactional row events, persistent delivery leases, signing, safe HTTP dispatch, retries and retention":`eventos transacionais de linhas, concessões persistentes de entrega, assinatura, envio HTTP seguro, novas tentativas e retenção`,"panel at `/admin`: JSON API (`/admin/api`) + embedded Svelte SPA (`ui/dist`)":"painel em `/admin`: API JSON (`/admin/api`) + SPA Svelte embutida (`ui/dist`)","host with N projects (`init`, `up`, `projects`, `remove`, `migrate`, `backup`, `upgrade`, `panel-login`...). Modules: `host` (registry), `naming`, `scaffold`, `caddy`, `registry`, `panel_login`, `lifecycle`, `backup`, `upgrade`":"host com N projetos (`init`, `up`, `projects`, `remove`, `migrate`, `backup`, `upgrade`, `panel-login`...). Módulos: `host` (registro), `naming`, `scaffold`, `caddy`, `registry`, `panel_login`, `lifecycle`, `backup`, `upgrade`","release/protocol types, durable jobs, host leases and irreversible recovery decisions; CLI/admin adapt runtime effects and operator HTTP":`tipos de versão/protocolo, jobs duráveis, leases do host e decisões irreversíveis de recuperação; CLI/admin adaptam efeitos do runtime e HTTP do operador`,"the `nelcota` binary: dispatches the CLI or starts the server (trace, timeout, CORS, gzip)":"o binário `nelcota`: despacha a CLI ou inicia o servidor (rastreamento, timeout, CORS, gzip)","The backend compiles into one binary, static with musl in the Docker image.\nArtifact size depends on version/architecture and embedded assets; do not infer\ncurrent size or deployment capacity from older builds.":`O backend compila em um binário, estático com musl na imagem Docker. O tamanho depende da versão/arquitetura e dos assets incorporados; builds antigos não determinam tamanho atual ou capacidade do deploy.`,"The query compiler separates the validated request representation (`query/mod.rs`),\nURL parsing (`query/parse.rs`) and SQL generation (`query/sql.rs`), behind the\nexisting public interface. Panel handlers are grouped under `admin/src/tables/`,\n`users/` and `policies/`, with small root facades that expose named handlers to\nthe router. Tables own row queries, structure, exports and DDL adaptation;\n`tables/catalog` supplies metadata also used by overview and policies. Pure\nDDL generation stays in `ddl/`, execution in `apply`, and SQL error adaptation\nin `error`. Table DDL exposes a small facade over `table/spec` (typed input),\n`table/column` (shared column rendering), `table/create` and `table/alter`\n(statement planning). Alteration keeps one working schema owner and preserves\nthe action order. The SQL feature also owns its autocomplete schema endpoint.":"O compilador de consultas separa a representação validada da requisição (`query/mod.rs`),\no parsing de URL (`query/parse.rs`) e a geração de SQL (`query/sql.rs`), por trás da\ninterface pública existente. Os handlers do painel ficam agrupados em `admin/src/tables/`,\n`users/` e `policies/`, com pequenas fachadas na raiz que expõem handlers nomeados ao\nroteador. Tabelas cuidam de consultas de linhas, estrutura, exportações e adaptação de DDL;\n`tables/catalog` fornece metadados também usados pela visão geral e pelas políticas. A geração\npura de DDL fica em `ddl/`, a execução em `apply` e a adaptação dos erros SQL\nem `error`. O DDL de tabelas expõe uma pequena fachada sobre `table/spec` (entrada tipada),\n`table/column` (renderização compartilhada de colunas), `table/create` e `table/alter`\n(planejamento de instruções). A alteração mantém um responsável pela estrutura de trabalho e preserva\na ordem das ações. A feature SQL também cuida de seu endpoint de schema para autocomplete.","Authentication's HTTP handlers adapt requests to `accounts` and `sessions`.\n`db` owns auth-role transactions and `request` owns HTTP metadata. `links`\nowns single-use email links (token storage, email text, sending and sign-in\nby link); `recovery` adds the password change, `confirmation` the signup\npolicy and `verify` routes a link by its `type`. `oauth` owns provider\nsign-in: `provider` (with one module per provider) talks to the provider,\n`flow` stores sign-ins in progress, `identities` decides which account opens\nand `redirects` holds the allowlist. The panel's root assembles routes;\n`auth`, `middleware`, `error`, `assets` and `state` own their respective behavior.":"Os handlers HTTP de autenticação adaptam requisições para `accounts` e `sessions`. `db` cuida das transações com o papel de autenticação e `request` dos metadados HTTP. `links` cuida dos links de e-mail de uso único (armazenamento de tokens, texto do e-mail, envio e login por link); `recovery` acrescenta a troca de senha, `confirmation` a política de cadastro e `verify` encaminha um link por seu `type`. `oauth` cuida do login por provedor: `provider` (com um módulo por provedor) se comunica com o provedor, `flow` armazena logins em andamento, `identities` decide qual conta abrir e `redirects` mantém a lista de permissões. A raiz do painel monta as rotas; `auth`, `middleware`, `error`, `assets` e `state` cuidam de seus respectivos comportamentos.","Storage's `upload` module owns streamed writes and their metadata commit,\n`operations` owns reads/listing/deletion, and `signing` owns signed-file grants.\nTheir interface takes upload options and a byte stream and returns typed data.\nThe `http` adapter handles headers, response status, URLs and file serving for\nboth public routes and the panel. Policy checks still happen before bytes are\nconsumed, and failed writes still clean up their unpublished versions.":"O módulo `upload` do armazenamento cuida de escritas em streaming e do commit dos metadados, `operations` cuida de leituras/listagem/exclusão e `signing` de concessões para arquivos assinados. Sua interface recebe opções de upload e um stream de bytes e retorna dados tipados. O adaptador `http` trata cabeçalhos, status da resposta, URLs e entrega de arquivos tanto para rotas públicas quanto para o painel. As verificações de políticas ainda ocorrem antes do consumo dos bytes, e escritas com falha ainda limpam suas versões não publicadas.","The CLI separates project lifecycle and version upgrades from backup workflows.\n`backup/workflow` coordinates capture, retention and restore; `backup/remote`\nowns S3 transport. Database and immutable file capture retain one owner so\ntheir snapshot consistency remains intact.":"A CLI separa o ciclo de vida do projeto e as atualizações de versão dos fluxos de backup. `backup/workflow` coordena captura, retenção e restauração; `backup/remote` cuida do transporte S3. A captura do banco e dos arquivos imutáveis mantém um único responsável para preservar a consistência do snapshot.","Webhooks separate panel configuration/history (`management`), destination and\nDNS policy (`destination`), HMAC (`signing`), lease persistence (`queue`), HTTP\ndelivery (`transport`) and async scheduling (`worker`). A PostgreSQL trigger\ncommits events with business rows; a dedicated two-connection pool and four\nconcurrent sends keep outbound work independent of API and panel traffic.\nSee [events and webhooks](webhooks.md) for delivery guarantees and limits.":"Webhooks separam configuração/histórico do painel (`management`), política de destino e DNS (`destination`), HMAC (`signing`), persistência de concessões (`queue`), entrega HTTP (`transport`) e agendamento assíncrono (`worker`). Um trigger do PostgreSQL faz commit dos eventos junto das linhas de negócio; um pool dedicado de duas conexões e quatro envios concorrentes mantêm os envios independentes do tráfego da API e do painel. Veja [eventos e webhooks](webhooks.md) para garantias e limites de entrega.","Panel wire DTOs live in `admin/src/contracts.rs` and the existing structure/DDL\ntypes. Their generated TypeScript and JSON Schemas are versioned with the UI;\nstandalone validators reject incompatible responses in the client. Row values\nremain strings or NULL so decimal and bigint values retain precision.":"Os DTOs de comunicação do painel ficam em `admin/src/contracts.rs` e nos tipos existentes de estrutura/DDL. Seus TypeScript e JSON Schemas gerados são versionados junto da UI; validadores independentes rejeitam respostas incompatíveis no cliente. Valores de linhas continuam sendo strings ou NULL para preservar a precisão de decimal e bigint.","The SQL editor streams messages over dedicated connections with a 30-second\nstatement timeout, four concurrent runs, 1000 retained rows per result, an 8 MiB\nretained-value budget and 32 displayed results. It drains the entire batch after\nreaching a display limit, preserving transaction semantics. Dropping the HTTP\nfuture sends a Postgres cancellation request and closes its dedicated connection.\nOrdinary API pool connections stay separate.":`O editor SQL transmite mensagens por conexões dedicadas com timeout de instrução de 30 segundos, quatro execuções concorrentes, 1000 linhas retidas por resultado, orçamento de 8 MiB para valores retidos e 32 resultados exibidos. Ele consome todo o lote após atingir um limite de exibição, preservando a semântica de transações. Descartar o future HTTP envia uma requisição de cancelamento ao Postgres e fecha sua conexão dedicada. As conexões comuns do pool da API permanecem separadas.`,"Table previews reuse one admin connection and roll back the caller's role\nbefore reading owner metadata. Table exports use separate connections, with\ntwo concurrent downloads, a 30-second statement timeout and a two-minute\nresponse lifetime. Dropping a response cancels the query; a deadline closes\nthe connection even when its body is not polled. Admission remains occupied\nthrough cancellation, and an interrupted stream fails instead of reporting\na complete file. Small-table counts probe at most 10,001 rows under a 250 ms\nstatement timeout; outgrown small-table estimates produce an unknown total.":`As prévias de tabelas reutilizam uma conexão administrativa e revertem o papel do chamador antes de ler os metadados como dono. As exportações de tabelas usam conexões separadas, com dois downloads simultâneos, limite de 30 segundos por comando e duração de dois minutos para a resposta. Descartar uma resposta cancela a consulta; o prazo fecha a conexão mesmo quando o corpo não é consumido. A vaga continua ocupada durante o cancelamento, e um stream interrompido falha em vez de informar que o arquivo está completo. As contagens de tabelas pequenas examinam no máximo 10.001 linhas com limite de 250 ms por comando; estimativas de tabelas pequenas que cresceram deixam o total desconhecido.`,"Storage directory listing seeks through a generated parent-path byte key,\nskipping each returned folder's subtree. Every seek runs against\n`storage.objects` under the caller's RLS. NUL-separated UTF-8 segments preserve\nC ordering and isolate literal prefixes, including Unicode, `%` and `_`.\nAn ordered scope-fingerprint/name index pages immediate files. Its generated\ninteger fingerprint supports seeks under RLS; exact bucket and parent checks\nreject hash collisions. Listing transactions disable bitmap scans locally\nto favor ordered page seeks when statistics are missing.\nThe key helpers only transform their inputs;\npublic execution preserves custom SQL writers without changing object RLS.\nA bucket browser requests only that bucket's usage. Migrations V14 and V15\nadd user ordering and directory indexes. V15 computes the derived keys for\nexisting metadata and rebuilds the table under the migration lock, so\nupgrades of large stores need time for that one-time rewrite.":"A listagem de diretórios do storage busca por uma chave de bytes gerada a partir do caminho pai, pulando a subárvore de cada pasta retornada. Cada busca consulta `storage.objects` sob o RLS do chamador. Segmentos UTF-8 separados por NUL preservam a ordenação C e isolam prefixos literais, incluindo Unicode, `%` e `_`. Um índice ordenado por hash de escopo e nome pagina os arquivos diretamente na pasta. Seu hash inteiro gerado permite buscas sob RLS; verificações exatas de bucket e caminho pai rejeitam colisões de hash. As transações de listagem desabilitam varreduras por bitmap localmente para favorecer buscas ordenadas de páginas quando faltam estatísticas. As funções de chave apenas transformam suas entradas; a execução pública preserva os escritores SQL customizados sem alterar o RLS dos objetos. O navegador de um bucket solicita apenas o uso daquele bucket. As migrações V14 e V15 adicionam índices de ordenação de usuários e diretórios. A V15 calcula as chaves derivadas para os metadados existentes e reconstrói a tabela sob o lock de migração, então upgrades de storages grandes precisam de tempo para essa reescrita única.","Internal migration V16 adds durable panel SSO redemption receipts shared by\nall instances of the project. Upgrading from 0.4.0 applies V14, V15 and V16;\nkeep a tested paired database/file backup and allow a maintenance window for\nthe metadata rewrite. V16 is outside the standalone auth migration selection.":`A migração interna V16 adiciona registros duráveis de resgate do SSO do painel, compartilhados por todas as instâncias do projeto. O upgrade de 0.4.0 aplica V14, V15 e V16; mantenha um backup pareado de banco/arquivos cuja restauração foi testada e reserve uma janela de manutenção para a reescrita dos metadados. V16 não integra a seleção de migrações do auth independente.`,"DDL commits once and reports `applied` plus `catalog_pending`. An introspection\nfailure after COMMIT does not turn a successful mutation into an error. Catalog\nreloads are serialized, and one worker retries failed refreshes with backoff;\nthe client refreshes its view without replaying the change.":"DDL faz commit uma vez e informa `applied` e `catalog_pending`. Uma falha de introspecção após COMMIT não transforma uma mutação bem-sucedida em erro. Recargas do catálogo são serializadas, e um worker repete atualizações que falharam com espera progressiva; o cliente atualiza sua visão sem repetir a alteração.","`RemoteResource` owns loading, errors, cancellation and result ordering in table,\nuser and storage pages. Storage's upload queue owns progress, partial failures\nand conflict retries, capturing the bucket and folder before navigation changes.\nThese modules have unit tests; browser flows and real-Postgres regressions run in CI.\n`TableRows` owns row selection, loading and mutation reconciliation, including\ncaptured primary keys and navigation during writes. The table page owns its\nnavigation, dialogs and presentation; its HTTP adapter supplies row operations.":"`RemoteResource` cuida de carregamento, erros, cancelamento e ordenação de resultados nas páginas de tabelas, usuários e armazenamento. A fila de uploads do armazenamento cuida do progresso, falhas parciais e novas tentativas após conflitos, capturando o bucket e a pasta antes de mudanças de navegação. Esses módulos têm testes unitários; fluxos de navegador e regressões com Postgres real executam na CI. `TableRows` cuida da seleção de linhas, carregamento e reconciliação de mutações, incluindo chaves primárias capturadas e navegação durante escritas. A página de tabela cuida de sua navegação, diálogos e apresentação; seu adaptador HTTP fornece operações de linhas.","Recovery operations own link issuance and atomic consumption, password updates,\nsession revocation and post-commit email delivery. HTTP handlers only extract\nrequest metadata, apply public endpoint rate limits and adapt their results.\nMigration operations return typed records and commit version allocation,\nchecksums and change tracking together; their `files` module owns names,\nrendering and directory discovery, while the root handles HTTP downloads.":"As operações de recuperação cuidam da emissão e consumo atômico de links, atualização de senhas, revogação de sessões e entrega de e-mail após commit. Handlers HTTP apenas extraem metadados da requisição, aplicam limites de requisições dos endpoints públicos e adaptam seus resultados. Operações de migração retornam registros tipados e fazem commit da alocação de versões, checksums e acompanhamento de alterações juntos; seu módulo `files` cuida de nomes, renderização e descoberta de diretórios, enquanto a raiz trata downloads HTTP.","The REST root composes routes. Its `http` adapter handles URLs, preferences,\nstatus codes and headers; `operations` compiles and executes CRUD/RPC under\nthe caller's role, returning PostgreSQL-generated JSON and range metadata.\nCatalog internals separate `model`, `introspection`, `refresh` and `listener`\nbehind the public `CatalogHandle` interface. Introspection coordinates private\nreaders for relations, columns, constraints and functions; each reader owns\nits query and row mapping. The four reads remain sequential, and a complete\nsnapshot is published only after all succeed. Keep the returned `ReloadListener`\nowner alive until shutdown; dropping it cancels the listener/driver. Dropping\nthe final catalog owner cancels reconciliation, including pool waits.":"A raiz REST compõe as rotas. Seu adaptador `http` trata URLs, preferências,\ncódigos de status e cabeçalhos; `operations` compila e executa CRUD/RPC sob\no papel do chamador, retornando JSON gerado pelo PostgreSQL e metadados de intervalo.\nOs detalhes do catálogo separam `model`, `introspection`, `refresh` e `listener`\npor trás da interface pública `CatalogHandle`. A introspecção coordena leitores privados\nde relações, colunas, constraints e funções; cada leitor cuida\nde sua consulta e do mapeamento das linhas. As quatro leituras continuam sequenciais, e um\nsnapshot completo só é publicado depois que todas passam. Mantenha o responsável por `ReloadListener`\nvivo até o encerramento; descartá-lo cancela o listener/driver. Descartar\no último responsável pelo catálogo cancela a reconciliação, incluindo esperas pelo pool.","The SQL executor owns connection lifetime, concurrency, result budgets and\ncancellation behind `execute`; the route handles HTTP status and serialization.\nThe panel's `SqlExecution` owns request state and timing, and `StorageBrowser`\nowns folder paging and refreshes after uploads/deletions. Both accept adapters\nand discard stale responses when cancelled or navigated away from.":"O executor SQL cuida do ciclo de vida das conexões, concorrência, limites de resultados e cancelamento por trás de `execute`; a rota trata status HTTP e serialização. `SqlExecution` do painel cuida do estado e duração da requisição, e `StorageBrowser` da paginação de pastas e atualizações após uploads/exclusões. Ambos aceitam adaptadores e descartam respostas antigas quando cancelados ou após navegar para outra página.","Native deployment separates machine/package provisioning, systemd units,\nPostgreSQL configuration and atomic binary replacement. Caddy owns its own\nconfiguration writes. PITR separates private configuration from process adapters\nand restore sequencing; restore still coordinates stopping services, restoring,\nwaiting for promotion, taking a backup on the new timeline and starting the app.":`A implantação nativa separa provisionamento de máquina/pacotes, unidades systemd, configuração PostgreSQL e substituição atômica do binário. O Caddy cuida de suas próprias escritas de configuração. PITR separa a configuração privada dos adaptadores de processo e da sequência de restauração; a restauração ainda coordena parar serviços, restaurar, aguardar promoção, fazer backup na nova linha do tempo e iniciar o aplicativo.`,"Source organization":`Organização do código-fonte`,"Nelcota is a modular monolith: capability modules ship in one binary. Use a\nsmall facade to expose a complete operation, keeping its validation, transaction\nand cleanup together. HTTP adapters translate requests, results and errors.\nIntroduce interchangeable adapters where implementations actually vary, such\nas disk/S3 storage and SMTP/test mail delivery. Concrete functions and existing\ntypes are enough elsewhere; a generic repository or another layer is not needed\nto wrap PostgreSQL.":`Nelcota é um monólito modular: módulos de recursos são distribuídos em um binário. Use uma pequena fachada para expor uma operação completa, mantendo sua validação, transação e limpeza juntas. Adaptadores HTTP traduzem requisições, resultados e erros. Introduza adaptadores intercambiáveis onde as implementações realmente variam, como armazenamento em disco/S3 e entrega de e-mail SMTP/de teste. Funções concretas e tipos existentes bastam nos demais casos; não é necessário um repositório genérico ou outra camada para envolver o PostgreSQL.`,"Keep the existing crate boundaries: each crate owns a product capability,\nand `server` assembles them. Add an internal module when behavior needs an\nindependent owner; file length alone does not require a new crate or layer.\nRust module facades use explicit exports. Types returned by a public method\nmust be reachable through its public interface, including errors such as\n`SqlBusy` alongside `SqlExecutor`.":"Mantenha os limites existentes entre crates: cada crate cuida de um recurso do produto, e `server` os reúne. Adicione um módulo interno quando um comportamento precisar de um responsável independente; o tamanho de um arquivo, por si só, não exige um novo crate ou camada. Fachadas de módulos Rust usam exportações explícitas. Tipos retornados por um método público devem ser acessíveis por sua interface pública, incluindo erros como `SqlBusy` junto de `SqlExecutor`.","Apply SOLID to these existing boundaries:":`Aplique SOLID a essas fronteiras existentes:`,"Single responsibility: separate typed requests, SQL planning, database reads,\nHTTP adaptation and browser effects; keep transaction and cleanup ownership together.":`Responsabilidade única: separe requisições tipadas, planejamento SQL, leituras de banco,
adaptação HTTP e efeitos no navegador; mantenha juntas as responsabilidades de transação e limpeza.`,"Open/closed: extend real variation through existing storage, mail and database\ninterfaces. Do not introduce a trait or strategy for one implementation.":`Aberto/fechado: estenda variações reais pelas interfaces existentes de armazenamento, email e banco.
Não introduza uma trait ou estratégia para uma única implementação.`,"Liskov substitution: preserve public signatures, error behavior and output;\nuse the same characterization tests before and after moving responsibilities.":`Substituição de Liskov: preserve assinaturas públicas, comportamento dos erros e saída;
use os mesmos testes de caracterização antes e depois de mover responsabilidades.`,"Interface segregation: expose the operation a caller needs through a small\nfacade; keep query-specific readers and rendering helpers private.":`Segregação de interfaces: exponha a operação necessária ao chamador por uma pequena
fachada; mantenha privados os leitores específicos de consultas e os helpers de renderização.`,"Dependency inversion: shared panel infrastructure depends on shared contracts\nand session state, while pages depend on that infrastructure. Shared modules\nmust not import a feature page or the application shell.":`Inversão de dependência: a infraestrutura compartilhada do painel depende de contratos
e estado de sessão compartilhados, enquanto as páginas dependem dessa infraestrutura. Módulos
compartilhados não devem importar uma página de feature nem o shell da aplicação.`,"Bucket mutations belong to storage's operation interface on `StorageState`.\nBoth the public routes and panel call it; bucket privileges, RLS and foreign\nkeys remain PostgreSQL's responsibility. Operations return typed records and\nbucket errors, while each HTTP adapter preserves its response/error vocabulary.\nOnly the panel adapter trims empty MIME inputs from forms. A failed deletion\nrolls back before reading the optional file count for its error response.\nPanel user operations accept the admin pool and return data; their HTTP adapter\nowns messages and status codes. Password changes and session revocation remain\none transaction inside the operation.":"Mutações de buckets pertencem à interface de operações do armazenamento em `StorageState`. Tanto as rotas públicas quanto o painel a chamam; privilégios de buckets, RLS e chaves estrangeiras continuam sendo responsabilidade do PostgreSQL. Operações retornam registros tipados e erros de buckets, enquanto cada adaptador HTTP preserva seu vocabulário de respostas/erros. Apenas o adaptador do painel remove entradas MIME vazias dos formulários. Uma exclusão com falha faz rollback antes de ler a contagem opcional de arquivos para sua resposta de erro. Operações de usuários do painel aceitam o pool administrativo e retornam dados; seu adaptador HTTP cuida de mensagens e códigos de status. Alterações de senha e revogação de sessões continuam em uma transação dentro da operação.","The panel's `ui/src/lib/features/<feature>/` owns its page, state, HTTP\nadapter, pure helpers, components and adjacent unit tests. `shell/` owns\nnavigation, the command palette and the application frame. Reusable panel\ncomponents live in `components/shared/`; shadcn primitives stay in\n`components/ui/`. Table/policy metadata and DDL previews shared by several\nfeatures live in `shared/schema/`, including the identifier rendering used by\nboth guided access and policy templates. API usage examples belong to\n`features/api/api-examples.ts`.":"A pasta `ui/src/lib/features/<feature>/` do painel contém sua página, estado, adaptador\nHTTP, helpers puros, componentes e testes unitários adjacentes. `shell/` cuida da\nnavegação, paleta de comandos e estrutura da aplicação. Componentes reutilizáveis do painel\nficam em `components/shared/`; primitivas shadcn continuam em\n`components/ui/`. Metadados de tabelas/políticas e prévias de DDL compartilhados por várias\nfeatures ficam em `shared/schema/`, incluindo a renderização de identificadores usada\ntanto pelo acesso guiado quanto pelos templates de políticas. Exemplos de uso da API ficam em\n`features/api/api-examples.ts`.","Shared panel modules have explicit owners under `ui/src/lib/`:":"Os módulos compartilhados do painel têm responsáveis explícitos em `ui/src/lib/`:",Directory:`Diretório`,"HTTP requests, response parsing, upload adaptation and transport errors":`Requisições HTTP, parsing de respostas, adaptação de uploads e erros de transporte`,"Generated wire-type facade and response-contract selection":`Fachada dos tipos de dados gerados e seleção dos contratos de resposta`,"Request lifetime, query cache and shared panel-session state":`Ciclo de vida das requisições, cache de consultas e estado compartilhado da sessão do painel`,"History routing, route matching and URL pagination":`Roteamento pelo histórico, correspondência de rotas e paginação por URL`,"Clipboard, download effects, identifiers and local persistence":`Área de transferência, efeitos de download, identificadores e persistência local`,"Password input helpers and confirmation before closing dirty forms":`Helpers de entrada de senhas e confirmação antes de fechar formulários alterados`,"Date labels and pure CSV/JSON encoding":`Rótulos de datas e codificação pura de CSV/JSON`,"UI primitives, reusable components and their class/type utilities":`Primitivas de UI, componentes reutilizáveis e seus utilitários de classes e tipos`,"Keep source files and adjacent tests inside those directories. Pure tabular\nencoding is independent of object URLs and download clicks; upload error\nconstruction is independent of the API/session coordinator. Shared session state\nlives in `resources/session.svelte.ts`, consumed by both transport and login.\nThe shadcn aliases point generated utilities to `components/utils` and browser\nhooks to `browser/`, keeping future generated modules in the same ownership map.":"Mantenha os arquivos de código e os testes adjacentes nesses diretórios. A codificação tabular\npura independe de URLs de objetos e cliques de download; a construção de erros de upload\nindepende do coordenador de API/sessão. O estado compartilhado da sessão\nfica em `resources/session.svelte.ts`, consumido pelo transporte e pelo login.\nOs aliases do shadcn direcionam os utilitários gerados para `components/utils` e os hooks\ndo navegador para `browser/`, mantendo os futuros módulos gerados no mesmo mapa de responsabilidades.","`python3 scripts/check-boundaries.py` rejects loose library modules, unregistered\nlibrary directories, shared-to-page imports and stale direct module URLs in\nbrowser probes. Existing native import lint checks dependency cycles. Adding a\nnew shared owner requires updating this map and its boundary contract.":`\`python3 scripts/check-boundaries.py\` recusa módulos soltos na biblioteca, diretórios
não registrados, imports de páginas em módulos compartilhados e URLs diretas antigas de módulos
nos testes de navegador. O lint nativo de imports existente verifica ciclos de dependência. Adicionar
um novo responsável compartilhado exige atualizar esse mapa e seu contrato de fronteiras.`,"Use relative imports within a feature and `$lib/...` for dependencies outside\nit. Rust filenames use snake_case, TypeScript helpers use kebab-case, and\nSvelte components use PascalCase. Use structs/enums or plain TypeScript types\nfor data; stateful modules compose existing resource modules behind their\nown methods. Reuse generated wire types instead of copying their shape;\n`SchemaResponse` serves both autocomplete and SQL request state. Do not edit\nthe generated contracts or validators by hand.":"Use imports relativos dentro de um recurso e `$lib/...` para dependências fora dele. Nomes de arquivos Rust usam snake_case, funções auxiliares TypeScript usam kebab-case e componentes Svelte usam PascalCase. Use structs/enums ou tipos TypeScript simples para dados; módulos com estado compõem módulos existentes de recursos por trás de seus próprios métodos. Reutilize os tipos de comunicação gerados em vez de copiar sua estrutura; `SchemaResponse` atende tanto ao preenchimento automático quanto ao estado das requisições SQL. Não edite manualmente os contratos ou validadores gerados.","Rust unit tests stay with their implementation. Integration scenarios stay in\n`server/tests`, where the production router and a real PostgreSQL instance\nare assembled. `tests/admin.rs` loads feature modules under `tests/admin/`\nas one integration suite. `tests/common/panel.rs` owns panel login, cookie\nassertions and request helpers shared with storage and architecture suites.":"Testes unitários Rust ficam junto de sua implementação. Cenários de integração ficam em `server/tests`, onde o roteador de produção e uma instância PostgreSQL real são montados. `tests/admin.rs` carrega módulos de recursos em `tests/admin/` como uma suíte de integração. `tests/common/panel.rs` cuida do login do painel, verificações de cookies e funções auxiliares de requisição compartilhadas com as suítes de armazenamento e arquitetura.","A request's flow":`Fluxo de uma requisição`,"`Auth` (extractor) turns the `Authorization` header into `Claims`.":"`Auth` (extrator) transforma o cabeçalho `Authorization` em `Claims`.","The operation takes a connection from the pool (always as `authenticator`).":"A operação obtém uma conexão do pool (sempre como `authenticator`).","`db::begin_request` opens the transaction and sets role + claims.":"`db::begin_request` abre a transação e define papel + claims.","The query runs under RLS; Postgres builds the JSON (`json_agg`) and the API\njust passes the bytes through.":"A consulta executa sob RLS; o Postgres constrói o JSON (`json_agg`) e a API apenas repassa os bytes.","COMMIT. Postgres errors are translated by `ApiError::from_db`.":"COMMIT. Erros do Postgres são traduzidos por `ApiError::from_db`.","`db::begin_request` is the **only** path to run SQL on behalf of a user.":"`db::begin_request` é o **único** caminho para executar SQL em nome de um usuário.",Startup:`Inicialização`,"Loads the config (`NELCOTA_*` + optional `nelcota.toml`).":"Carrega a configuração (`NELCOTA_*` + `nelcota.toml` opcional).","`db::bootstrap` (admin connection): advisory lock → migrations in\n`migrations/` (control table `nelcota.schema_migrations`) → `authenticator`\npassword (SCRAM verifier computed locally).":"`db::bootstrap` (conexão administrativa): bloqueio consultivo → migrações em `migrations/` (tabela de controle `nelcota.schema_migrations`) → senha de `authenticator` (verificador SCRAM calculado localmente).","Creates the API pool and starts the HTTP server. Shuts down cleanly on\nSIGTERM/Ctrl+C.":`Cria o pool da API e inicia o servidor HTTP. Encerra de forma limpa em SIGTERM/Ctrl+C.`,Routes:`Rotas`,Prefix:`Prefixo`,"Served by":`Servido por`,Authorization:`Autorização`,server:`server`,public:`público`,api:`api`,"JWT → role → GRANTs + RLS":`JWT → papel → GRANTs + RLS`,auth:`auth`,"public (signup/login/email links/provider sign-in) or the user's JWT":`público (cadastro/login/links de e-mail/login por provedor) ou JWT do usuário`,storage:`storage`,"JWT → role → RLS on `storage.objects`; public buckets and signed URLs without a token":"JWT → papel → RLS em `storage.objects`; buckets públicos e URLs assinadas sem token",admin:`admin`,"panel login (session), admin connection":`login do painel (sessão), conexão administrativa`,"Internal migrations":`Migrações internas`,"Plain SQL in `migrations/V<n>__<name>.sql`, applied by `refinery` and recorded\nin `nelcota.schema_migrations` (version, name, date, checksum). They can be\napplied by hand with `psql` if Nelcota no longer exists. The early ones\n(V1–V6) keep their original Portuguese names and comments: refinery checksums\nname and content, so editing them would break existing installs (D68).":"SQL simples em `migrations/V<n>__<name>.sql`, aplicado por `refinery` e registrado em `nelcota.schema_migrations` (versão, nome, data, checksum). Podem ser aplicadas manualmente com `psql` se o Nelcota deixar de existir. As primeiras (V1–V6) mantêm seus nomes e comentários originais em português: refinery calcula checksums do nome e conteúdo, então editá-las quebraria instalações existentes (D68).","Authentication flow":`Fluxo de autenticação`,"The project panel has separate administrator sessions. Controlled updates add\nseparate controller/worker processes using the same binary and a separately\nenrolled operator origin; they do not grant host authority to a project login.\nThe controller remains source-only pending a new release and VPS acceptance.":`O painel do projeto tem sessões administrativas separadas. Atualizações controladas adicionam processos controller/worker usando o mesmo binário e uma origem de operador autorizada separadamente; não concedem autoridade sobre o host a um login de projeto. O controller permanece exclusivo da fonte até nova publicação e validação em VPS.`,"Related guides":`Guias relacionados`,"See [decisions](decisions.md), [REST API](api.md), [auth](schema-auth.md),\n[webhooks](webhooks.md) and [deploy](deploy.md). Reusable-auth setup is in the\nrepository-only guide at `docs/auth-integration.md`. Mermaid diagrams render\non GitHub; the current embedded reader displays their source.":"Veja [decisões](decisions.md), [API REST](api.md), [autenticação](schema-auth.md), [webhooks](webhooks.md) e [deploy](deploy.md). A configuração de autenticação reutilizável fica no guia exclusivo do repositório em `docs/auth-integration.md`. Diagramas Mermaid são renderizados no GitHub; o leitor incorporado atual mostra a fonte.","Host controller boundaries":`Limites do controlador de host`,"Host project management keeps pure commands, bounded DTOs and durable receipts\nin `nelcota-deployment`; root effects, policy and recovery live in `nelcota-cli`. `nelcota-admin` is an unprivileged HTTP adapter. The separately\nauthenticated UI requests plans and confirmed operations through the worker;\nproject credentials never grant host authority. Updates, CLI mutations and host\njobs share one lease and refuse unresolved work. See `docs/host-management.md`\nfor the Unreleased feature’s enrollment, recovery and validation limits.":"O gerenciamento de projetos do host mantém comandos puros, DTOs limitados e registros persistentes em `nelcota-deployment`; efeitos privilegiados, política e recuperação ficam em `nelcota-cli`. `nelcota-admin` é um adaptador HTTP sem privilégios. A interface com autenticação separada solicita planos e operações confirmadas ao worker; credenciais de projeto nunca concedem autoridade de host. Atualizações, alterações pela CLI e tarefas do host compartilham um único bloqueio e recusam trabalho não resolvido. Consulte `docs/host-management.md` para o cadastro, a recuperação e os limites de validação do recurso ainda não lançado."},lt={"The `auth` schema":"O esquema `auth`","A public, stable contract. Every table is ordinary SQL: you can read, export\nand migrate it without Nelcota (see [leaving.md](leaving.md)).":`Um contrato público e estável. Toda tabela é SQL comum: você pode ler, exportar e migrar sem Nelcota (veja [leaving.md](leaving.md)).`,"The tables are **not** exposed by the REST API. The server reaches them with\nthe internal role `nelcota_auth`, which no JWT can assume. `anon`,\n`authenticated` and `service_role` have no GRANT on them (there is a test for\nthat).":"As tabelas **não** são expostas pela API REST. O servidor as acessa com o papel interno `nelcota_auth`, que nenhum JWT pode assumir. `anon`, `authenticated` e `service_role` não têm GRANT nelas (há um teste para isso).",Prerequisites:`Pré-requisitos`,"You need a running initialized server. Password login is available by default;\nSMTP/link pages and OAuth providers are optional configuration groups. Schema\nand endpoint examples describe current source, with release differences tracked\nin the server changelog. Never expose database password hashes or link tokens.":`Você precisa de um servidor inicializado em execução. Login com senha está disponível por padrão; SMTP/páginas de links e provedores OAuth são grupos opcionais de configuração. Exemplos de schema/endpoints descrevem a fonte atual; diferenças de versão ficam no changelog do servidor. Nunca exponha hashes de senha do banco ou tokens de links.`,Column:`Coluna`,Type:`Tipo`,Notes:`Observações`,"`uuid` PK":"`uuid` PK","`gen_random_uuid()`; it is the JWT `sub` and `auth.uid()`":"`gen_random_uuid()`; é o `sub` do JWT e `auth.uid()`","`text` unique":"`text` único","always lowercase, ≤ 254 characters":`sempre em minúsculas, ≤ 254 caracteres`,"**argon2id PHC string** (see below); `NULL` = no password":"**string PHC argon2id** (veja abaixo); `NULL` = sem senha","set when the person opens a signup confirmation, magic or recovery link (proves they receive the email)":`definido quando a pessoa abre um link de confirmação de cadastro, mágico ou de recuperação (comprova que recebe o e-mail)`,"the signup `data` field; returned as `user_metadata`":"campo `data` do cadastro; retornado como `user_metadata`","updated on every login":`atualizado a cada login`,"Password format":`Formato da senha`,"Account emails use a simple mailbox address: a dot-atom ASCII local part (up\nto 64 bytes), a DNS domain with nonempty labels, and at most 254 bytes overall.\nSurrounding spaces are trimmed and the address is lowercased. Controls, display\nnames, quoted local parts and consecutive dots are rejected before hashing or\nquerying the database, using the same rule for public auth and panel accounts.\nInternational domains can use their ASCII/Punycode form. Existing malformed\naddresses are not renamed automatically; an administrator should verify\nownership before repairing such a row in SQL.":`E-mails de conta usam um endereço simples de caixa postal: parte local ASCII dot-atom (até 64 bytes), domínio DNS com rótulos não vazios e no máximo 254 bytes no total. Espaços nas extremidades são removidos e o endereço é convertido para minúsculas. Controles, nomes de exibição, partes locais entre aspas e pontos consecutivos são rejeitados antes de calcular o hash ou consultar o banco, com a mesma regra para autenticação pública e contas do painel. Domínios internacionais podem usar sua forma ASCII/Punycode. Endereços malformados existentes não são renomeados automaticamente; um administrador deve verificar a propriedade antes de corrigir essa linha em SQL.`,"The server shares one bounded Argon2 worker budget between public auth, panel\nlogin and account administration. Panel login rate limits apply per client IP;\nforwarded headers are used only when `trust_proxy` is configured.":"O servidor compartilha um único orçamento limitado de workers Argon2 entre autenticação pública, login do painel e administração de contas. Limites de login do painel se aplicam por IP do cliente; cabeçalhos encaminhados só são usados quando `trust_proxy` está configurado.","It is the standard PHC format. The parameters (19 MiB, 2 iterations,\nparallelism 1) follow the OWASP recommendation. It works directly with any\nargon2 library: Python `argon2-cffi` (`PasswordHasher().verify(hash,\npassword)`), Node `argon2` (`argon2.verify(hash, password)`), Go\n`alexedwards/argon2id`, PHP `password_verify()`, Keycloak/Authentik via import.":"É o formato PHC padrão. Os parâmetros (19 MiB, 2 iterações, paralelismo 1) seguem a recomendação OWASP. Funciona diretamente com qualquer biblioteca argon2: Python `argon2-cffi` (`PasswordHasher().verify(hash, password)`), Node `argon2` (`argon2.verify(hash, password)`), Go `alexedwards/argon2id`, PHP `password_verify()`, Keycloak/Authentik por importação.","One row per login.":`Uma linha por login.`,"goes into the JWT as the `session_id` claim":"entra no JWT como a claim `session_id`","logout or detected refresh token reuse":`logout ou reutilização detectada de token de renovação`,informative:`informativo`,"`bigint` PK":"`bigint` PK",'the token\'s "family"':`a "família" do token`,"`bytea` unique":"`bytea` único","**SHA-256** of the opaque token; the token itself is never stored":`**SHA-256** do token opaco; o próprio token nunca é armazenado`,"`true` once used (rotation)":"`true` após o uso (rotação)","default validity: 30 days":`validade padrão: 30 dias`,"Rotation and reuse detection":`Rotação e detecção de reutilização`,"`POST /auth/v1/token?grant_type=refresh_token` with token R1.":"`POST /auth/v1/token?grant_type=refresh_token` com token R1.","R1 valid → marked `revoked = true`; R2 is issued in the same session.":"R1 válido → marcado `revoked = true`; R2 é emitido na mesma sessão.","If R1 is used **again** (someone has a copy), the whole session is revoked:\nR2, R3... stop working. The user's other sessions continue.":`Se R1 for usado **novamente** (alguém tem uma cópia), toda a sessão é revogada: R2, R3... param de funcionar. As outras sessões do usuário continuam.`,"**Retry grace window.** A client that lost the answer to step 2 (network drop,\ntwo tabs refreshing at once) still holds only R1. For **10 seconds** after the\nrotation, presenting R1 again is treated as a retry: the server revokes R2 (and\nany other live token of the session issued after R1) and answers with a fresh\npair for the **same session**. Retries never extend the window, which counts\nfrom the original rotation (its `refreshed_at`). Once R2's successor has been\nrotated in turn, or after the window, R1 is reuse again and step 3 applies.\nThe client should still serialize refreshes; the window only absorbs retries.":"**Janela de tolerância para novas tentativas.** Um cliente que perdeu a resposta da etapa 2 (queda de rede, duas abas renovando ao mesmo tempo) ainda tem apenas R1. Por **10 segundos** após a rotação, apresentar R1 novamente é tratado como nova tentativa: o servidor revoga R2 (e qualquer outro token ativo da sessão emitido após R1) e responde com um novo par para a **mesma sessão**. Novas tentativas nunca ampliam a janela, contada desde a rotação original (seu `refreshed_at`). Quando o sucessor de R2 também é rotacionado, ou após a janela, R1 volta a ser reutilização e a etapa 3 se aplica. O cliente ainda deve serializar renovações; a janela apenas absorve novas tentativas.",Cleanup:`Limpeza`,"Once an hour the server deletes refresh tokens past `expires_at` (a rotated\ntoken stays until then, so reuse is still detected), sessions left without\nany token, and sessions revoked more than 7 days ago (with their tokens).\nNothing that could still sign anyone in is removed.":"Uma vez por hora, o servidor exclui tokens de renovação após `expires_at` (um token rotacionado permanece até lá para ainda detectar reutilização), sessões sem nenhum token e sessões revogadas há mais de 7 dias (com seus tokens). Nada que ainda possa autenticar alguém é removido.","Links sent by email: password recovery, signup confirmation and magic link.":`Links enviados por e-mail: recuperação de senha, confirmação de cadastro e link mágico.`,"`recovery`, `signup` or `magiclink`; a token only works as its kind":"`recovery`, `signup` ou `magiclink`; um token só funciona como seu tipo","**SHA-256** of the token; the token itself is never stored":`**SHA-256** do token; o próprio token nunca é armazenado`,"validity: recovery 1 hour, signup 24 hours, magic link 15 minutes":`validade: recuperação 1 hora, cadastro 24 horas, link mágico 15 minutos`,"set on use; the link does not work again":`definido no uso; o link não funciona novamente`,"Accounts at sign-in providers linked to a user (see\n[Sign-in with Google or GitHub](#sign-in-with-google-or-github)).":`Contas em provedores de login vinculadas a um usuário (veja [Login com Google ou GitHub](#sign-in-with-google-or-github)).`,"`google` or `github`":"`google` ou `github`","the provider's account id (`sub`); unique per provider":"ID da conta no provedor (`sub`); único por provedor","the email the provider reported at the last sign-in":`e-mail informado pelo provedor no último login`,"the provider's profile as received":`perfil do provedor como recebido`,"Provider sign-ins in progress; each row lives minutes.":`Logins por provedor em andamento; cada linha dura minutos.`,"**SHA-256** of the `state` sent to the provider":"**SHA-256** do `state` enviado ao provedor","PKCE verifier toward the provider; atomically cleared when claiming the callback, before HTTP exchange":`verificador PKCE para o provedor; limpo atomicamente ao assumir o callback, antes da troca HTTP`,"the app's S256 challenge":`desafio S256 do aplicativo`,"the app page to return to":`página do aplicativo à qual retornar`,"**SHA-256** of the code handed to the app":`**SHA-256** do código entregue ao aplicativo`,"set when the provider answers":`definido quando o provedor responde`,"10 minutes at the provider, then 5 to redeem the code":`10 minutos no provedor, depois 5 para resgatar o código`,"Only one callback can claim a state, even while the provider is still\nresponding. Failed or cancelled exchanges require a new `/authorize`; no\ndatabase transaction remains open during provider HTTP requests. Callback\nrequests have a separate per-IP budget from `/authorize`.":"Apenas um callback pode assumir um state, mesmo enquanto o provedor ainda responde. Trocas com falha ou canceladas exigem um novo `/authorize`; nenhuma transação do banco permanece aberta durante requisições HTTP ao provedor. Requisições de callback têm um orçamento por IP separado de `/authorize`.","In-memory limiters track at most 50,000 keys. At capacity they reject new\nkeys with `429` and a one-second retry hint, while existing keys keep their\nindependent quotas. Cleanup runs at most once per second under capacity\npressure and removes only keys idle since their last accepted request for\na full minute, enough to recover the complete GCRA burst.":"Limitadores em memória acompanham no máximo 50.000 chaves. Ao atingir a capacidade, rejeitam novas chaves com `429` e indicação de nova tentativa em um segundo, enquanto chaves existentes mantêm suas cotas independentes. A limpeza executa no máximo uma vez por segundo sob pressão de capacidade e remove apenas chaves ociosas desde a última requisição aceita por um minuto inteiro, suficiente para recuperar toda a capacidade de rajada do GCRA.",Endpoints:`Endpoints`,"Method and route":`Método e rota`,Body:`Corpo`,Response:`Resposta`,"201 + session (201 `{user}` with email confirmation on)":"201 + sessão (201 `{user}` com confirmação de e-mail ativada)","200 + session":`200 + sessão`,"303 to the provider":`303 para o provedor`,"(the provider's redirect)":`(redirecionamento do provedor)`,"303 to `redirect_to?code=...` or `?error=...`":"303 para `redirect_to?code=...` ou `?error=...`",Bearer:`Bearer`,"204 (revokes the session)":`204 (revoga a sessão)`,"user data":`dados do usuário`,"Bearer + `{password?, current_password?, data?}`":"Bearer + `{password?, current_password?, data?}`","200 + user data (see [Updating the signed-in user](#updating-the-signed-in-user))":`200 + dados do usuário (veja [Atualizar o usuário autenticado](#updating-the-signed-in-user))`,"public JWKS":`JWKS público`,"200 `{}` (whether or not the account exists)":"200 `{}` (independentemente de a conta existir)",'`{type: "recovery", token, password}` or `{type: "signup" | "magiclink", token}`':'`{type: "recovery", token, password}` ou `{type: "signup" | "magiclink", token}`',"Session:":`Sessão:`,"Errors: `422 invalid_email` or `422 weak_password` (email or password outside\nthe rules), `422 validation_failed` (a value the endpoint requires is missing,\nsuch as `refresh_token`), `400`/`422 invalid_body` (the body is not JSON or a\nfield has the wrong type), `409\nuser_already_exists`, `400 invalid_grant` (invalid credentials or refresh, with\nthe same message for an unknown email and a wrong password), `429\nrate_limited` with `Retry-After`, `403 signup_disabled`, `400\nemail_not_confirmed` (correct password, email confirmation pending).":"Erros: `422 invalid_email` ou `422 weak_password` (e-mail ou senha fora das regras), `422 validation_failed` (um valor exigido pelo endpoint está ausente, como `refresh_token`), `400`/`422 invalid_body` (corpo não é JSON ou um campo tem tipo incorreto), `409 user_already_exists`, `400 invalid_grant` (credenciais ou renovação inválidas, com a mesma mensagem para e-mail desconhecido e senha incorreta), `429 rate_limited` com `Retry-After`, `403 signup_disabled`, `400 email_not_confirmed` (senha correta, confirmação de e-mail pendente).","Links: `403 recovery_disabled`, `confirmation_disabled` or `magiclink_disabled`\n(the project has not configured that flow), `400 invalid_grant` (invalid,\nexpired, already used or other-kind link), `400 unsupported_type`.":"Links: `403 recovery_disabled`, `confirmation_disabled` ou `magiclink_disabled` (o projeto não configurou esse fluxo), `400 invalid_grant` (link inválido, expirado, já usado ou de outro tipo), `400 unsupported_type`.","Email flows share **16 delivery slots** per process and a **30-second** total\nsend deadline, including custom mailers. Overload returns `503 mail_busy`\nbefore creating an account or issuing a token, with the same response for\nexisting and unknown accounts. An admitted background send owns its slot until\nit completes or times out.\nSMTP errors and timeouts are logged; sending remains a best-effort background\noperation rather than a durable delivery queue.":"Os fluxos de e-mail compartilham **16 vagas de envio** por processo e um prazo total de **30 segundos**, incluindo implementações personalizadas. A sobrecarga retorna `503 mail_busy` antes de criar uma conta ou emitir um token, com a mesma resposta para contas existentes e desconhecidas. Cada envio em segundo plano mantém sua vaga até terminar ou atingir o prazo. Erros e timeouts de SMTP são registrados; o envio continua sendo uma operação em segundo plano de melhor esforço, sem fila persistente de entrega.","Updating the signed-in user":`Atualizar o usuário autenticado`,"`PUT /auth/v1/user` with the user's access token changes their own account.\nSend at least one of:":"`PUT /auth/v1/user` com o token de acesso do usuário altera sua própria conta. Envie pelo menos um de:",'`data`: merged into `user_metadata` (`raw_user_meta_data`) one level deep:\nthe keys sent replace the stored ones, the others stay, and a key sent as\n`null` is removed. `{"data": {"plan": "pro", "tmp": null}}`.':'`data`: mesclado em `user_metadata` (`raw_user_meta_data`) em um nível: as chaves enviadas substituem as armazenadas, as demais permanecem e uma chave enviada como `null` é removida. `{"data": {"plan": "pro", "tmp": null}}`.',"`password` (same rules as signup): requires `current_password` when the\naccount already has a password (`422 validation_failed` without it, `400\ninvalid_grant` when wrong). An account without one (magic link or provider\nsign-in) can set it directly. The user's **other** sessions are revoked;\nthe calling session and its refresh token keep working. Attempts count\nagainst the per-minute limit, per user.":"`password` (mesmas regras do cadastro): exige `current_password` quando a conta já tem senha (`422 validation_failed` sem ela, `400 invalid_grant` quando incorreta). Uma conta sem senha (link mágico ou login por provedor) pode defini-la diretamente. As **outras** sessões do usuário são revogadas; a sessão chamadora e seu token de renovação continuam funcionando. Tentativas contam para o limite por minuto, por usuário.","The access token's session must still be active (not logged out or revoked):\notherwise `401 invalid_token`. The response is the updated user, as in `GET\n/auth/v1/user`. Changing the email is not supported yet (it needs a\nconfirmation of the new address); an administrator can change it in SQL.":"A sessão do token de acesso ainda deve estar ativa (sem logout ou revogação): caso contrário, `401 invalid_token`. A resposta é o usuário atualizado, como em `GET /auth/v1/user`. Alterar o e-mail ainda não é suportado (exige confirmação do novo endereço); um administrador pode alterá-lo em SQL.","Password recovery":`Recuperação de senha`,"Off until the project configures SMTP (Nelcota has no mail server of its own;\nuse your provider's: Postmark, SES, Resend...). In the project's `.env`, all\nthree together:":"Desativada até o projeto configurar SMTP (Nelcota não tem servidor de e-mail próprio; use o do seu provedor: Postmark, SES, Resend...). No `.env` do projeto, as três configurações juntas:",'A half-configured setup stops the server from starting (better than finding\nout on the first "forgot my password").':`Uma configuração incompleta impede o servidor de iniciar (melhor que descobrir no primeiro "esqueci minha senha").`,'The app calls `POST /auth/v1/recover {email}`. The answer is always\n`200 {}`, so it does not reveal who has an account. If the account exists,\nan email arrives (in English, subject "Reset your password") with the link\n`https://app.shop.com/new-password#type=recovery&token=...`.':'O aplicativo chama `POST /auth/v1/recover {email}`. A resposta é sempre `200 {}`, então não revela quem tem conta. Se a conta existir, chega um e-mail (em inglês, assunto "Reset your password") com o link `https://app.shop.com/new-password#type=recovery&token=...`.','That app page reads the token from the fragment (`location.hash`), asks for\nthe new password and calls `POST /auth/v1/verify {type: "recovery", token,\npassword}`.':'Essa página do aplicativo lê o token do fragmento (`location.hash`), pede a nova senha e chama `POST /auth/v1/verify {type: "recovery", token, password}`.',"The response is a session (same format as login): the person is signed in.":`A resposta é uma sessão (mesmo formato do login): a pessoa está autenticada.`,"Guarantees:":`Garantias:`,"The token travels in the URL fragment, which the browser sends to no server:\nit does not show up in logs or in the `Referer`.":"O token viaja no fragmento da URL, que o navegador não envia a nenhum servidor: não aparece nos logs nem no `Referer`.","It is valid for 1 hour and only once. Asking again voids the previous link.":`É válido por 1 hora e uma única vez. Pedir novamente invalida o link anterior.`,"At most one email per minute for the same account, on top of the per-IP\nrate limit: the endpoint cannot be used to flood someone's inbox.":`No máximo um e-mail por minuto para a mesma conta, além do limite por IP: o endpoint não pode ser usado para inundar a caixa de entrada de alguém.`,"The email goes out in the background: response time does not reveal whether\nthe account exists, and an SMTP failure goes to the log instead of becoming\nan error.":`O e-mail é enviado em segundo plano: o tempo de resposta não revela se a conta existe, e uma falha SMTP vai para o log em vez de se tornar um erro.`,"Changing the password ends every session of the account (refresh tokens stop\nworking immediately; access JWTs already issued stay valid until they\nexpire).":`Alterar a senha encerra todas as sessões da conta (tokens de renovação param de funcionar imediatamente; JWTs de acesso já emitidos permanecem válidos até expirar).`,"Signup confirmation":`Confirmação de cadastro`,"Off by default. With SMTP configured, setting the page that receives the link\nturns it on:":`Desativada por padrão. Com SMTP configurado, definir a página que recebe o link a ativa:`,'`POST /auth/v1/signup` creates the account and answers `201 {"user": {...}}`\n**without** a session; an email ("Confirm your email") carries\n`https://app.shop.com/welcome#type=signup&token=...`, valid for 24 hours.':'`POST /auth/v1/signup` cria a conta e responde `201 {"user": {...}}` **sem** sessão; um e-mail ("Confirm your email") contém `https://app.shop.com/welcome#type=signup&token=...`, válido por 24 horas.','The page reads the token from the fragment and calls `POST /auth/v1/verify\n{type: "signup", token}`: the email is confirmed and the answer is a session.':'A página lê o token do fragmento e chama `POST /auth/v1/verify {type: "signup", token}`: o e-mail é confirmado e a resposta é uma sessão.','Until then, password sign-in answers `400 email_not_confirmed`, only after a\ncorrect password. `POST /auth/v1/resend {type: "signup", email}` sends a new\nlink to an unconfirmed account (same cooldown and `200 {}` as recovery).':'Até lá, o login por senha responde `400 email_not_confirmed`, apenas após uma senha correta. `POST /auth/v1/resend {type: "signup", email}` envia um novo link para uma conta não confirmada (mesmo intervalo e `200 {}` da recuperação).','Opening a magic or recovery link also confirms the email. Accounts that were\nalready unconfirmed when the flow was turned on are held as well; mark them\nwith "Confirm email" on the panel\'s Users page (or `UPDATE auth.users SET\nemail_confirmed_at = now()`) if they should keep signing in. Accounts created\nin the panel are confirmed from the start.':'Abrir um link mágico ou de recuperação também confirma o e-mail. Contas já não confirmadas quando o fluxo foi ativado também são bloqueadas; marque-as com "Confirmar e-mail" na página Usuários do painel (ou `UPDATE auth.users SET email_confirmed_at = now()`) se devem continuar entrando. Contas criadas no painel são confirmadas desde o início.',"When recovery first confirms an account, it removes provider identities and\npending OAuth/email codes established before that inbox proof, revokes previous\nsessions and installs the owner's new password in the same transaction.\nRecovery of an already confirmed account preserves its linked providers while\nstill changing the password and revoking the existing sessions.":`Quando a recuperação confirma uma conta pela primeira vez, remove identidades de provedores e códigos OAuth/e-mail pendentes estabelecidos antes dessa prova de acesso à caixa de entrada, revoga sessões anteriores e instala a nova senha do proprietário na mesma transação. A recuperação de uma conta já confirmada preserva seus provedores vinculados, ainda alterando a senha e revogando as sessões existentes.`,"Magic link":`Link mágico`,"Passwordless sign-in for existing accounts, on when its page is configured:":`Login sem senha para contas existentes, ativado quando sua página é configurada:`,'`POST /auth/v1/magiclink {email}` always answers `200 {}`. If the account\nexists, an email ("Your sign-in link") carries\n`https://app.shop.com/signed-in#type=magiclink&token=...`, valid for 15\nminutes.':'`POST /auth/v1/magiclink {email}` sempre responde `200 {}`. Se a conta existir, um e-mail ("Your sign-in link") contém `https://app.shop.com/signed-in#type=magiclink&token=...`, válido por 15 minutos.','The page calls `POST /auth/v1/verify {type: "magiclink", token}` and gets a\nsession; the email counts as confirmed.':'A página chama `POST /auth/v1/verify {type: "magiclink", token}` e recebe uma sessão; o e-mail é considerado confirmado.',"On the first proof of inbox ownership, a magic link clears any password from\nthe unconfirmed signup and revokes its earlier sessions, provider identities,\npending OAuth codes and email links. Someone else may have registered that\naddress. The inbox owner can set\na new password through recovery. Already confirmed accounts keep their\npassword and sessions; signup confirmation still approves its signup password.\nRevoked sessions cannot refresh, while previously issued access JWTs retain\ntheir normal expiry (as for logout and password recovery).":`Na primeira prova de propriedade da caixa de entrada, um link mágico limpa qualquer senha do cadastro não confirmado e revoga sessões anteriores, identidades de provedores, códigos OAuth pendentes e links de e-mail. Outra pessoa pode ter cadastrado esse endereço. O proprietário da caixa de entrada pode definir uma nova senha pela recuperação. Contas já confirmadas mantêm sua senha e sessões; a confirmação de cadastro ainda aprova a senha do cadastro. Sessões revogadas não podem renovar, enquanto JWTs de acesso emitidos anteriormente mantêm sua expiração normal (como no logout e na recuperação de senha).`,"It does not create accounts: an email request would otherwise let anyone\nreserve addresses before their owners sign up. Same guarantees as recovery:\ntoken only in the fragment, one use, one email per minute per account,\nsending in the background.":`Não cria contas: uma solicitação de e-mail permitiria que qualquer pessoa reservasse endereços antes de seus proprietários se cadastrarem. Mesmas garantias da recuperação: token apenas no fragmento, uso único, um e-mail por minuto por conta e envio em segundo plano.`,"Sign-in with Google or GitHub":`Login com Google ou GitHub`,"Off until a provider is configured. Register an OAuth app at the provider with\nthe callback `https://<api domain>/auth/v1/callback`, then:":"Desativado até um provedor ser configurado. Cadastre um aplicativo OAuth no provedor com o callback `https://<api domain>/auth/v1/callback`, depois:","A half-configured provider, or a provider without the two URLs, stops the\nserver from starting.":`Um provedor parcialmente configurado, ou sem as duas URLs, impede o servidor de iniciar.`,"The app creates a PKCE pair: a random `code_verifier` (43 to 128\ncharacters) kept in the browser and `code_challenge =\nbase64url(SHA-256(code_verifier))`. It sends the person to\n`GET /auth/v1/authorize?provider=github&redirect_to=https://shop.com/auth&code_challenge=...&code_challenge_method=S256`.":"O aplicativo cria um par PKCE: um `code_verifier` aleatório (43 a 128 caracteres) mantido no navegador e `code_challenge = base64url(SHA-256(code_verifier))`. Envia a pessoa para `GET /auth/v1/authorize?provider=github&redirect_to=https://shop.com/auth&code_challenge=...&code_challenge_method=S256`.","After the provider, the person lands on\n`https://shop.com/auth?code=...` (or `?error=...`).":"Após o provedor, a pessoa chega a `https://shop.com/auth?code=...` (ou `?error=...`).","The page calls `POST /auth/v1/token?grant_type=pkce {auth_code,\ncode_verifier}` and gets a session (same format as login).":"A página chama `POST /auth/v1/token?grant_type=pkce {auth_code, code_verifier}` e recebe uma sessão (mesmo formato do login).","Errors on `redirect_to`: `access_denied` (the person declined),\n`provider_error`, `email_conflict` (the provider did not verify an email that\nbelongs to an account), `email_required` (the provider gave no email),\n`signup_disabled`. `/authorize` answers `400 redirect_not_allowed`, `400\ninvalid_code_challenge` or `403 provider_disabled`; `/callback` answers `400\ninvalid_state` for an unknown, expired or already answered sign-in.":"Erros em `redirect_to`: `access_denied` (a pessoa recusou), `provider_error`, `email_conflict` (o provedor não verificou um e-mail que pertence a uma conta), `email_required` (o provedor não forneceu e-mail), `signup_disabled`. `/authorize` responde `400 redirect_not_allowed`, `400 invalid_code_challenge` ou `403 provider_disabled`; `/callback` responde `400 invalid_state` para um login desconhecido, expirado ou já respondido.","Which account opens:":`Qual conta abre:`,"a provider account already linked: its user, even if the email changed at\nthe provider;":`uma conta de provedor já vinculada: seu usuário, mesmo se o e-mail mudou no provedor;`,"an email the provider **verified** that matches a confirmed account: that\naccount, which gains the identity (its password keeps working);":`um e-mail **verificado** pelo provedor que corresponde a uma conta confirmada: essa conta, que recebe a identidade (sua senha continua funcionando);`,"a verified email that matches an **unconfirmed** account: the verified owner\ntakes it over; the previous password, sessions, provider identities and\npending email/OAuth codes are removed, then the verified identity is linked,\nsince whoever created it may not own the address;":`um e-mail verificado que corresponde a uma conta **não confirmada**: o proprietário verificado assume a conta; senha anterior, sessões, identidades de provedores e códigos pendentes de e-mail/OAuth são removidos, depois a identidade verificada é vinculada, pois quem criou a conta pode não ser dono do endereço;`,"an unverified email that matches an account: refused (`email_conflict`);":"um e-mail não verificado que corresponde a uma conta: recusado (`email_conflict`);","no account: a new one without password, confirmed when the provider verified\nthe email, with `user_metadata` `name` and `avatar_url` from the provider.":"nenhuma conta: uma nova, sem senha, confirmada quando o provedor verificou o e-mail, com `user_metadata` `name` e `avatar_url` do provedor.","Guarantees: `redirect_to` must sit under one of `NELCOTA_OAUTH_REDIRECT_URLS`\n(same origin, path below), so the endpoint cannot redirect elsewhere. The\ncode in the app's URL works once, for 5 minutes, and only with the verifier\nthe app kept. Nelcota uses its own PKCE and `state` toward the provider and\ntalks to it only server to server.":"Garantias: `redirect_to` deve estar sob uma das `NELCOTA_OAUTH_REDIRECT_URLS` (mesma origem, caminho abaixo), então o endpoint não pode redirecionar para outro lugar. O código na URL do aplicativo funciona uma vez, por 5 minutos, e apenas com o verificador guardado pelo aplicativo. Nelcota usa seu próprio PKCE e `state` com o provedor e se comunica com ele apenas de servidor para servidor.","Related guides":`Guias relacionados`,"See [JWT/roles](jwt-and-roles.md), [REST API](api.md) and [troubleshooting](troubleshooting.md).":`Veja [JWT/papéis](jwt-and-roles.md), [API REST](api.md) e [solução de problemas](troubleshooting.md).`,"Password: 8 to 256 characters. Password login has hard limits of\n`NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` per IP (default 30) and per normalized\nemail/IP pair. All attempts count, including successful and unknown-account\nattempts. Each bucket allows a burst of that size and refills continuously\nat that many attempts per minute; the shared per-IP budget remains unchanged.":"Senha: 8 a 256 caracteres. O login por senha tem limites rígidos de `NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` por IP (padrão 30) e por par de email normalizado/IP. Todas as tentativas contam, incluindo as bem-sucedidas e de contas desconhecidas. Cada bucket permite uma rajada desse tamanho e repõe continuamente essa quantidade de tentativas por minuto; o orçamento compartilhado por IP permanece igual.","The account aggregate uses the same quota for backpressure, rather than hard\nrejection: excess attempts wait 125, 250, 500, 1,000, then at most 2,000 ms.\nA refill admission resets the delay progression. Waiting holds neither a DB\nconnection nor a password worker. A correct login from an independent source\nwith available IP/pair budgets inherits at most two seconds of throttle delay,\neven during continuing account-targeted abuse. Normal request deadlines,\nworker admission/overload responses and bounded limiter capacity still apply.":`O agregado da conta usa a mesma cota para conter pressão, em vez de rejeição rígida: tentativas excedentes aguardam 125, 250, 500, 1.000 e, no máximo, 2.000 ms. Uma admissão após reposição reinicia a progressão. A espera não retém conexão de banco nem trabalhador de senha. Um login correto de uma origem independente com orçamento de IP/par disponível herda no máximo dois segundos de atraso, mesmo com abuso contínuo direcionado à conta. Os prazos normais das requisições, admissão dos trabalhadores/respostas de sobrecarga e capacidade limitada do limitador continuam valendo.`,"Trade-off: a strict account-wide verification ceiling cannot also guarantee\nadmission of an unrecognized legitimate source when attackers continuously\nspend that ceiling. Distributed sources can now exceed the former aggregate\nceiling; each source and email/source pair retain the original hard quota.\nThe aggregate delay is backpressure, not a distributed brute-force ceiling.\nKeep trusted proxy configuration and upstream abuse controls; limits are per\nprocess and shared NAT users still share their IP budget.":`Compromisso: um teto rígido de verificações por conta não pode também garantir a admissão de uma origem legítima desconhecida quando atacantes consomem continuamente esse teto. Origens distribuídas agora podem exceder o antigo teto agregado; cada origem e par email/origem mantêm a cota rígida original. O atraso agregado contém pressão e não é um teto contra força bruta distribuída. Mantenha a configuração de proxy confiável e os controles de abuso na entrada; os limites são por processo e usuários atrás de NAT compartilham o orçamento do IP.`,"Refreshes and PKCE redemptions (`grant_type=refresh_token` / `pkce`) draw from\na separate per-IP budget of 10 times that (300 by default), so open tabs\nrefreshing do not use up the password sign-in budget.":"Renovações e resgates PKCE (`grant_type=refresh_token` / `pkce`) usam um orçamento separado por IP, dez vezes maior (300 por padrão), para que abas renovando não consumam o orçamento de login por senha.","When SMTP is disabled, there is no self-service email reset. An operator must\nverify the account owner's identity through a separate trusted channel, sign\nin to the project panel, open **Users**, select the account and reset its\npassword. Deliver the replacement privately. This ends refresh sessions but\ndoes not erase IP/pair throttle state or revoke existing access JWTs before\nexpiry. Stop abusive sources at the trusted ingress, then retry from an\nindependent source or allow at most 60 seconds without new attempts for full\nbucket refill. There is no persistent account lock to unlock. Do not restart\nthe service or disable limits as a recovery shortcut.":`Quando o SMTP está desativado, não existe redefinição por email de autoatendimento. Um operador deve verificar a identidade do titular por um canal confiável separado, entrar no painel do projeto, abrir **Users**, selecionar a conta e redefinir sua senha. Entregue a nova senha de forma privada. Isso encerra sessões de renovação, mas não apaga o estado dos limites por IP/par nem revoga JWTs de acesso antes de expirarem. Bloqueie origens abusivas na entrada confiável e tente novamente de uma origem independente ou aguarde até 60 segundos sem novas tentativas para repor integralmente os buckets. Não existe bloqueio persistente de conta para remover. Não reinicie o serviço nem desative os limites como atalho de recuperação.`,"Password replacement through the signed-in account, recovery completion or\npanel administration retires that user's pending email credentials and OAuth\ncodes in the same transaction. Existing token issuance history remains for\nemail send cooldowns; unrelated accounts are unchanged. Account-row locking\nserializes replacement with credential redemption. A database error rolls\nback the password, session and pending-credential changes together.":`A substituição da senha pela conta autenticada, conclusão de recuperação ou administração do painel invalida as credenciais de email e os códigos OAuth pendentes desse usuário na mesma transação. O histórico de emissão permanece para os intervalos entre emails; outras contas não são alteradas. O bloqueio da linha da conta serializa a substituição com o resgate de credenciais. Um erro de banco desfaz conjuntamente as alterações de senha, sessão e credenciais pendentes.`},ut={"Backup and restore":`Backup e restauração`,"Capture and restore a database together with its disk-file snapshot. You need\na selected initialized host/project, PostgreSQL tools through its runtime,\nsufficient disk space and a private offsite destination when configured.":`Capture e restaure um banco junto de seu snapshot de arquivos em disco. Você precisa de host/projeto inicializado e selecionado, ferramentas PostgreSQL pelo runtime, espaço em disco suficiente e destino externo privado quando configurado.`,"Source fixes after 0.4.0 are unpublished: use matching release guidance and\nverify the actual artifact. Take a compatible verified pair before destructive\nrecovery; database PITR has different guarantees from a dump restore.":`Correções na fonte após 0.4.0 ainda não foram publicadas: use a orientação da versão correspondente e verifique o artefato real. Mantenha um par compatível verificado antes de recuperação destrutiva; PITR do banco tem garantias diferentes de restauração de dump.`,Backup:`Backup`,"`backup` uploads on its own whenever the S3 variables are in `host.env`, so\nadding a bucket after `init` needs no other change. `--upload` forces it and\nfails without one.":"`backup` faz upload automaticamente sempre que as variáveis S3 estão em `host.env`, então adicionar um bucket após `init` não exige outra alteração. `--upload` força o upload e falha se não houver um bucket.","The first `init` (as root) installs a daily cron job at 03:00\n(`/etc/cron.d/nelcota-backup`):":"O primeiro `init` (como root) instala uma tarefa cron diária às 03:00 (`/etc/cron.d/nelcota-backup`):","A broken project does not stop the others from being backed up; the command\nlists the failures and exits non-zero. `nelcota status` shows the age of each\nproject's last backup, and `nelcota doctor` reports a missing cron job or a\nbackup older than 26 hours.":"Um projeto com problemas não impede o backup dos outros; o comando lista as falhas e termina com código diferente de zero. `nelcota status` mostra a idade do último backup de cada projeto, e `nelcota doctor` informa uma tarefa cron ausente ou um backup com mais de 26 horas.","With disk storage, every dump has a sibling `<dump>.files/` directory containing\nthe immutable object versions and a SHA-256 manifest. The dump and file list\nshare one exported Postgres snapshot. A SHARE lock on `storage.objects` prevents\nmetadata changes during capture; reads continue, but file writes may wait.":"Com armazenamento em disco, cada dump tem um diretório irmão `<dump>.files/` com as versões imutáveis dos objetos e um manifesto SHA-256. O dump e a lista de arquivos compartilham um único snapshot exportado do Postgres. Um bloqueio SHARE em `storage.objects` impede alterações de metadados durante a captura; leituras continuam, mas escritas de arquivos podem aguardar.","The upload publishes that directory to `s3://<bucket>/<project>/<dump>.files/`\nbefore uploading the dump. Later replacements and deletions cannot change an\nolder snapshot. Keep each dump together with its file directory; `--keep` prunes\nboth locally. Configure remote lifecycle rules for both members of the pair.":"O upload publica esse diretório em `s3://<bucket>/<project>/<dump>.files/` antes de enviar o dump. Substituições e exclusões posteriores não podem alterar um snapshot antigo. Mantenha cada dump junto de seu diretório de arquivos; `--keep` remove ambos localmente. Configure regras de ciclo de vida remoto para os dois membros do par.","On Unix, dumps, snapshot files, manifests and environment files are created\nwith mode **0600**, before writing data. Backup and archive directories use\n**0700**. Copies retain the private policy rather than the source's mode;\ndownloads run with umask 077 and their bundles are sealed afterward. Existing\nenvironment files are restricted before overwriting them. Windows keeps the\nfilesystem's ACL policy; Unix modes are not simulated there.":`No Unix, dumps, arquivos de snapshot, manifestos e arquivos de ambiente são criados com modo **0600**, antes de escrever dados. Diretórios de backup e arquivo usam **0700**. Cópias mantêm a política privada em vez do modo da origem; downloads executam com umask 077 e seus conjuntos de arquivos são protegidos depois. Arquivos de ambiente existentes têm suas permissões restringidas antes de serem sobrescritos. Windows mantém a política de ACL do sistema de arquivos; os modos Unix não são simulados nele.`,"The dump uses `pg_dump`'s custom format: it includes schema, data, RLS\npolicies, functions and the `auth` schema (users with their argon2id hashes).\nCluster roles (`anon`, `authenticated`...) are not in the dump, but Nelcota's\nmigrations recreate them on any new install.":"O dump usa o formato personalizado de `pg_dump`: inclui esquema, dados, políticas RLS, funções e o esquema `auth` (usuários com seus hashes argon2id). Papéis do cluster (`anon`, `authenticated`...) não estão no dump, mas as migrações do Nelcota os recriam em qualquer nova instalação.","S3-compatible":`Compatível com S3`,"Any service with an S3 API: AWS S3, Backblaze B2, Cloudflare R2, Wasabi,\nMinIO. Variables in `host.env` (they apply to every project):":"Qualquer serviço com API S3: AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO. Variáveis em `host.env` (valem para todos os projetos):","Docker uploads use the `amazon/aws-cli` image. Systemd hosts execute native\nAWS CLI v2, which you must install separately. Set private bucket access and\nexplicit remote lifecycle rules for both dumps and file snapshots. Test readback\nand off-host restore; a successful upload alone does not prove recoverability.":"Uploads no Docker usam a imagem `amazon/aws-cli`. Hosts systemd executam AWS CLI v2 nativo, que você precisa instalar separadamente. Defina acesso privado ao bucket e regras explícitas de retenção remota para dumps e snapshots de arquivos. Teste readback e restauração em outro host; um upload bem-sucedido não prova recuperabilidade.","**Keep `host.env` and each project's `.env` somewhere safe, apart from the\nbucket.** They are not in the backup (they hold secrets). Without the\nproject's `.env` a restore still works, but the JWT key changes and every\nuser has to sign in again (passwords keep working).":"**Guarde `host.env` e o `.env` de cada projeto em um lugar seguro, separado do bucket.** Eles não estão no backup (contêm segredos). Sem o `.env` do projeto, a restauração ainda funciona, mas a chave JWT muda e todos os usuários precisam se autenticar novamente (as senhas continuam funcionando).",Restore:`Restauração`,"The restore asks for confirmation (`--yes` skips it), puts the project's\nCaddy site in maintenance (HTTP 503 with `Retry-After`), stops the app and\ntakes a **safety backup** of the current state, printing its path. Then it\nruns `pg_restore --clean --if-exists` in **a single transaction** (if anything\nfails, the database stays as it was), starts the app and reopens traffic once\nit is healthy. If the app does not become healthy, the site stays in\nmaintenance and the error shows how to go back:":"A restauração pede confirmação (`--yes` a dispensa), coloca o site Caddy do projeto em manutenção (HTTP 503 com `Retry-After`), para o aplicativo e faz um **backup de segurança** do estado atual, mostrando seu caminho. Depois executa `pg_restore --clean --if-exists` em **uma única transação** (se algo falhar, o banco permanece como estava), inicia o aplicativo e reabre o tráfego quando ele está saudável. Se o aplicativo não ficar saudável, o site permanece em manutenção e o erro mostra como voltar:","A restore also takes over a maintenance gate left closed by a failed upgrade\nor restore, since it is how such a project recovers.":`Uma restauração também assume o controle de um bloqueio de manutenção deixado fechado por uma atualização ou restauração que falhou, pois é assim que esse projeto se recupera.`,"Use `--files` to restore the matching disk snapshot. It uses the local sibling\ndirectory when present, otherwise fetches that dump's snapshot from the backup\nbucket. The manifest, file sizes and hashes are checked before stopping the app.\nThe immutable versions are copied before restoring the database, so a file-copy\nfailure leaves the database untouched. Existing unrelated versions remain for\nthe normal orphan collector. Backups made with the former shared storage mirror\nhave no historical file manifest; they remain usable for database-only restores.":"Use `--files` para restaurar o snapshot correspondente do disco. Usa o diretório irmão local quando disponível; caso contrário, busca o snapshot desse dump no bucket de backup. O manifesto, os tamanhos e os hashes dos arquivos são verificados antes de parar o aplicativo. As versões imutáveis são copiadas antes de restaurar o banco, então uma falha na cópia de arquivos deixa o banco intacto. Versões existentes sem relação com o snapshot permanecem para o coletor normal de órfãos. Backups feitos com o antigo espelho compartilhado de armazenamento não têm manifesto histórico de arquivos; continuam utilizáveis para restaurações apenas do banco.","Restore on a new VPS":`Restaurar em uma nova VPS`,"This restores the matching disk snapshot too; fetch its directory/manifest or\nconfigure the host backup bucket so the CLI can fetch it. Omit `--files` only\nfor an intentional database-only restore. Preserve and reconcile the private\nproject/host configuration, including credentials and SSO settings. The direct\n`aws` download above requires an installed AWS CLI and configured private access.":"Isso também restaura o snapshot de disco correspondente; baixe seu diretório/manifesto ou configure o bucket de backup do host para o CLI buscá-lo. Omita `--files` apenas em uma restauração intencional só do banco. Preserve e reconcilie a configuração privada do projeto/host, incluindo credenciais e SSO. O download direto com `aws` acima exige AWS CLI instalado e acesso privado configurado.","The acceptance test (`scripts/acceptance.sh --local`) takes a backup, writes\nmore data, restores and checks that the state went back to the backup's.":"O teste de aceitação (`scripts/acceptance.sh --local`) faz um backup, escreve mais dados, restaura e verifica que o estado voltou ao do backup.","When a project is removed (`nelcota -p <name> remove`), a final backup is kept\nin `archive/`, in the host folder. If its Postgres is stopped, `remove` starts\nit for the backup and refuses to delete anything when it cannot;\n`--no-backup` removes without one.\nDisk snapshots are archived alongside the final dump.":"Quando um projeto é removido (`nelcota -p <name> remove`), um backup final é mantido em `archive/`, na pasta do host. Se o Postgres estiver parado, `remove` o inicia para o backup e se recusa a excluir qualquer coisa quando não consegue; `--no-backup` remove sem backup. Snapshots do disco são arquivados junto do dump final.","PITR (point-in-time recovery)":`PITR (recuperação para um ponto no tempo)`,"Daily dumps lose up to 24 h of writes in the worst case. With PITR on,\nPostgres sends every WAL segment to the S3-compatible storage as it fills (and\nat least once a minute), next to periodic base backups, so the project can go\nback to **any second** the archive covers: just before a bad migration or a\n`DELETE` without a `WHERE`.":"Dumps diários perdem até 24 h de escritas no pior caso. Com PITR ativado, o Postgres envia cada segmento WAL para o armazenamento compatível com S3 conforme ele se preenche (e pelo menos uma vez por minuto), junto de backups-base periódicos, permitindo voltar a **qualquer segundo** coberto pelo arquivo: imediatamente antes de uma migração ruim ou de um `DELETE` sem `WHERE`.","It uses [pgBackRest](https://pgbackrest.org/), installed in the project's\nPostgres image (`postgres/Dockerfile`: the official `postgres:17-alpine` plus\nthe Alpine package, so the data directory is unchanged). Everything goes to\n`s3://<bucket>/<project>/pitr/`, beside the dumps.":"Usa [pgBackRest](https://pgbackrest.org/), instalado na imagem Postgres do projeto (`postgres/Dockerfile`: a imagem oficial `postgres:17-alpine` mais o pacote Alpine, portanto o diretório de dados não muda). Tudo vai para `s3://<bucket>/<project>/pitr/`, ao lado dos dumps.","It needs the S3 settings in `host.env` (the same ones the backup upload uses).\npgBackRest only talks to S3 over HTTPS. For your own MinIO/SeaweedFS with a\nprivate certificate authority, install its trusted CA for the runtime.\n`NELCOTA_BACKUP_S3_VERIFY_TLS=false` disables verification and should not\nbe used for production recovery. For providers requiring path-style URLs,\nset `NELCOTA_BACKUP_S3_URI_STYLE=path`.":"Exige as configurações S3 em `host.env` (as mesmas usadas pelo upload de backup). pgBackRest usa S3 apenas sobre HTTPS. Para MinIO/SeaweedFS com autoridade certificadora privada, instale a CA confiável no runtime. `NELCOTA_BACKUP_S3_VERIFY_TLS=false` desativa a verificação e não deve ser usado na recuperação em produção. Para provedores que exigem URLs path-style, defina `NELCOTA_BACKUP_S3_URI_STYLE=path`.","`enable` writes `pgbackrest.env` in the project folder (mode 600, it holds\nthe S3 keys). After changing the S3 settings in `host.env`, run `enable`\nagain to regenerate it.":"`enable` escreve `pgbackrest.env` na pasta do projeto (modo 600, contém as chaves S3). Após alterar as configurações S3 em `host.env`, execute `enable` novamente para regenerá-lo.","The daily `backup --all` also takes a base backup for projects with PITR:\nfull on Sundays, differential on the other days. Two full backups are kept,\nso the window reaches back one to two weeks. Fewer WAL segments to replay\nmeans a faster restore.":"O `backup --all` diário também faz um backup-base para projetos com PITR: completo aos domingos, diferencial nos outros dias. Dois backups completos são mantidos, então a janela alcança de uma a duas semanas atrás. Menos segmentos WAL para reproduzir significam uma restauração mais rápida.","PITR restores PostgreSQL only. It does not rewind disk/S3 object bytes.\nOlder metadata can refer to versions already deleted; maintain provider\nversioning/history or a separately verified file-recovery plan. Paired\ndump/file snapshots are a different recovery mechanism.":`PITR restaura apenas PostgreSQL. Não retorna bytes de objetos disco/S3 ao estado anterior. Metadados antigos podem referenciar versões já excluídas; mantenha histórico/versionamento no provedor ou um plano verificado de recuperação de arquivos. Pares de dump/snapshot de arquivos são outro mecanismo de recuperação.`,"`restore` stops the project, rewrites the data directory from the closest\nbase backup, replays the WAL up to the target and starts everything again.\nIt discards every write after the target, so it asks for confirmation\n(`--yes` skips it). Then it takes a new full backup, because the restored\ndatabase continues on a new timeline that older backups cannot serve.":"`restore` para o projeto, reescreve o diretório de dados a partir do backup-base mais próximo, reproduz o WAL até o alvo e inicia tudo novamente. Descarta todas as escritas posteriores ao alvo, então pede confirmação (`--yes` a dispensa). Depois faz um novo backup completo, pois o banco restaurado continua em uma nova linha do tempo que os backups antigos não podem atender.","Recovery is destructive. Some configuration/archive problems are rejected\nearly, but an unreachable target can be detected during WAL replay after\nfiles were restored. Before changing data, the CLI persists a recovery fence\noutside the data directory. An error or interrupted restore retains it across\nCLI exit, service restart and machine reboot. Do not assume the old database\nis unchanged or automatically restored. Use the explicit recovery steps below.":`A recuperação é destrutiva. Alguns problemas de configuração/arquivo WAL são recusados cedo, mas um alvo inalcançável pode ser detectado durante o replay de WAL após a restauração dos arquivos. Antes de alterar os dados, a CLI persiste uma trava de recuperação fora do diretório de dados. Um erro ou uma restauração interrompida mantém essa trava após a saída da CLI, o reinício dos serviços e o reboot da máquina. Não suponha que o banco anterior ficou intacto ou será restaurado automaticamente. Use os passos de recuperação explícita abaixo.`,"Projects created before PITR are updated by `enable`: Postgres switches to\nthe image built from `postgres/Dockerfile` and gets an `egress` network to\nreach S3 (the `internal` network has no way out). If `docker-compose.yml`\nwas edited by hand, `enable` prints the changes to make.":"Projetos criados antes do PITR são atualizados por `enable`: o Postgres passa para a imagem construída a partir de `postgres/Dockerfile` e recebe uma rede `egress` para alcançar o S3 (a rede `internal` não tem saída). Se `docker-compose.yml` foi editado manualmente, `enable` mostra as alterações necessárias.","The acceptance test (`scripts/acceptance-pitr.sh`) runs the whole cycle\nagainst a local S3 server with TLS.":"O teste de aceitação (`scripts/acceptance-pitr.sh`) executa o ciclo completo com um servidor S3 local com TLS.","PITR recovery fence":`Trava de recuperação PITR`,"Inspect the fence and preserve the failed restore's diagnostics:":`Inspecione a trava e preserve os diagnósticos da restauração que falhou:`,"When files may have been replaced or WAL recovery was interrupted, retry a\nrestore with a target covered by the archive. This explicit operation keeps\nordinary starts fenced while a temporary recovery-only PostgreSQL instance\nreplays WAL, without a TCP listener or autostart. Only verified promotion and\na stopped recovery instance release the fence:":`Quando arquivos podem ter sido substituídos ou a recuperação de WAL foi interrompida, repita a restauração com um alvo coberto pelo arquivo WAL. Essa operação explícita mantém as inicializações comuns bloqueadas enquanto uma instância temporária do PostgreSQL, exclusiva para recuperação, reproduz o WAL sem listener TCP nem autostart. Somente a promoção verificada e a parada da instância de recuperação liberam a trava:`,"To intentionally retain the current directory, first establish from the error\nand backup history that retaining it is appropriate. Then run verification:":`Para manter intencionalmente o diretório atual, primeiro confirme pelo erro e pelo histórico de backups que essa decisão é adequada. Depois execute a verificação:`,"`recover` stops any owned leftover recovery instance, requires a cleanly stopped\nPG17 directory without recovery signals or a backup label, verifies the control\nfile and enabled page checksums, then checks heaps, TOAST and B-tree indexes\nwith `pg_amcheck` using at most two parallel workers. It can install the missing `amcheck`\nextension in `pg_catalog`. This temporary PostgreSQL instance has no TCP\nlistener and cannot autostart; ordinary services remain blocked. After a clean\nstop, the offline checks run again before the fence is durably cleared.\n`--yes` skips the question, never verification. Failed checks retain the fence;\nuse a covered restore instead of removing it manually.":"`recover` para qualquer instância de recuperação pertencente ao projeto que tenha permanecido ativa, exige um diretório PG17 desligado de forma limpa, sem sinais de recuperação nem rótulo de backup, verifica o arquivo de controle e os checksums de páginas habilitados e então verifica heaps, TOAST e índices B-tree com `pg_amcheck`, usando no máximo dois workers paralelos. Pode instalar a extensão `amcheck` ausente em `pg_catalog`. Essa instância temporária do PostgreSQL não tem listener TCP e não pode iniciar automaticamente; os serviços comuns permanecem bloqueados. Após uma parada limpa, as verificações offline são repetidas antes da remoção durável da trava. `--yes` dispensa a pergunta, nunca a verificação. Verificações que falham mantêm a trava; use uma restauração com alvo coberto em vez de removê-la manualmente.","These checks cannot prove application-level correctness, preservation of every\nacknowledged write or byte identity when checksums were disabled. Reconcile\ndata with your verified backup/history. After starting, verify an authorized\nread, another user's RLS isolation, anonymous rejection and a private-file 404\nbefore reopening external traffic. Recovery checks do not replace an off-host\nrestore rehearsal or paired file recovery.":`Essas verificações não comprovam a correção das regras da aplicação, a preservação de cada escrita confirmada nem a identidade dos bytes quando os checksums estavam desabilitados. Reconcilie os dados com seu backup/histórico verificado. Após iniciar, verifique uma leitura autorizada, o isolamento RLS de outro usuário, a recusa de acesso anônimo e um 404 para arquivo privado antes de reabrir o tráfego externo. As verificações de recuperação não substituem um ensaio de restauração em outro host nem a recuperação do par de arquivos.`,Troubleshooting:`Solução de problemas`,"A missing offsite destination fails `--upload`; a partially configured bucket\nalso fails rather than silently skipping transfer. Check available space,\nprovider permissions/TLS and the full dump/files pair. On failed recovery, keep\nmaintenance and private diagnostics intact and inspect the selected runtime;\ndo not discard the safety backup. Use a disposable host to rehearse recovery.":"Sem destino externo, `--upload` falha; um bucket parcialmente configurado também falha, em vez de ignorar a transferência. Confira espaço disponível, permissões/TLS do provedor e o par completo de dump/arquivos. Após falha de recuperação, preserve manutenção e diagnósticos privados e inspecione o runtime selecionado; não descarte o backup de segurança. Use um host descartável para ensaiar a recuperação.","Related: [deploy](deploy.md), [storage](storage.md), [leaving](leaving.md). Controlled-update recovery has a separate repository\nguide at `docs/panel-updates.md`.":"Relacionados: [deploy](deploy.md), [armazenamento](storage.md), [exportação](leaving.md). Recuperação de atualizações controladas tem outro guia no repositório em `docs/panel-updates.md`.","This is an Unreleased source capability; use a matching CLI and app artifact.\nRun fence mutations and recovery on the Linux host. Docker refuses a restore\nbefore changing data if the app image does not support the guard. Native recovery\nalso requires the matching installed app binary. Custom entrypoints, app commands\nor data-directory locations require reviewed integration; they are refused\nrather than silently left unprotected.":`Este recurso pertence ao código Unreleased; use artefatos compatíveis da CLI e da aplicação. Execute alterações da trava e a recuperação no host Linux. O Docker recusa a restauração antes de alterar dados se a imagem da aplicação não oferecer suporte à trava. A recuperação nativa também exige o binário instalado da aplicação na versão correspondente. Entrypoints, comandos da aplicação ou locais do diretório de dados personalizados exigem integração revisada; são recusados em vez de ficarem desprotegidos silenciosamente.`,"The durable fence is `active.json` (or a partially committed `recovery.json`)\nunder `/var/lib/nelcota-pitr/` on systemd, or\n`projects/<project>/pitr-fence/` on Docker. Private receipts bind the fence to\nits owning project and directory. Docker's `active.json` holds the exact original\nCompose bytes for atomic release; do not print or publish its contents. The fence\nhas no timeout and is never removed at boot. Do not delete these files, move the\nhost directory, bypass entrypoints or disable the start guards.":"A trava durável é `active.json` (ou um `recovery.json` parcialmente confirmado) em `/var/lib/nelcota-pitr/` no systemd, ou em `projects/<project>/pitr-fence/` no Docker. Registros privados vinculam a trava ao projeto e diretório proprietários. No Docker, `active.json` contém os bytes exatos do Compose original para a liberação atômica; não imprima nem publique seu conteúdo. A trava não expira e nunca é removida durante o boot. Não exclua esses arquivos, mova o diretório do host, contorne entrypoints nem desative as verificações de inicialização.","Docker temporarily rewrites `docker-compose.yml` and removes old containers\nwithout removing their data volumes before any restore writes. The fenced\nCompose mounts the project directory read-only so a substituted fence-directory\nsymlink remains visible to both entrypoint guards; its restart policy is\n`no`. This prevents old `unless-stopped` or `always` containers from reopening\nafter a daemon or host restart. A manual container start still exits at the\nguard, even if its restart policy is changed. Docker starts asynchronously:\ninspect its exit status and logs, not only the exit code of `docker start`.\nSuccessful recovery restores the exact original Compose bytes and `up` applies\nits original restart policies.":"O Docker reescreve temporariamente `docker-compose.yml` e remove os containers antigos sem remover seus volumes de dados antes de qualquer escrita de restauração. O Compose bloqueado monta o diretório do projeto somente para leitura, para que a substituição do diretório da trava por um link simbólico permaneça visível às verificações de ambos os entrypoints; sua política de reinício fica em `no`. Isso impede que containers antigos com `unless-stopped` ou `always` reabram após o reinício do daemon ou do host. Uma inicialização manual do container ainda encerra na verificação da trava, mesmo que sua política de reinício seja alterada. O Docker inicia de forma assíncrona: inspecione o status de saída e os logs, não apenas o código de saída de `docker start`. A recuperação bem-sucedida restaura os bytes exatos do Compose original e `up` aplica suas políticas originais de reinício.","Recovery validates directory components and every state file without following\nsymlinks, and rejects wrong owners, hardlinks or unexpected types before changing\nPITR state or services. A refusal names the rejected path; preserve every marker\nand investigate the ownership/layout instead of deleting it.":`A recuperação valida os componentes do diretório e todos os arquivos de estado sem seguir links simbólicos e recusa proprietários incorretos, hardlinks ou tipos inesperados antes de alterar o estado PITR ou os serviços. A recusa informa o caminho rejeitado; preserve todos os marcadores e investigue a propriedade e a estrutura em vez de excluí-los.`,"After verification and a clean recovery-server stop, Docker persists an\nowner-bound `release.verified.json`, prepares `active.json` with the original\nCompose bytes and removes `recovery.json`. One atomic rename then removes the\nlast marker and restores `docker-compose.yml` together; both directories are\nsynced. Failure before that commit leaves markers and guarded Compose. Failure\nafter it leaves no markers and the original Compose. Native guards remain\ninstalled while markers are removed and synced. Repeating `pitr recover --yes`\nre-verifies a fenced directory or finishes an already committed release; a\nfailed final sync does not require manual edits. The retained verification\nreceipt is metadata, not an active fence, and never authorizes automatic cleanup.":"Após a verificação e a parada limpa do servidor de recuperação, o Docker persiste um `release.verified.json` vinculado ao proprietário, prepara `active.json` com os bytes do Compose original e remove `recovery.json`. Um único rename atômico remove o último marcador e restaura `docker-compose.yml` ao mesmo tempo; ambos os diretórios são sincronizados. Uma falha antes dessa confirmação mantém os marcadores e o Compose protegido. Uma falha após ela deixa o Compose original sem marcadores. Os guards nativos permanecem instalados enquanto os marcadores são removidos e sincronizados. Repetir `pitr recover --yes` verifica novamente um diretório bloqueado ou conclui uma liberação já confirmada; uma falha na sincronização final não exige edições manuais. O registro de verificação mantido é metadado, não uma trava ativa, e nunca autoriza limpeza automática.","Native PostgreSQL and app units check the fence in `ExecStartPre`, including\nboot, manual `systemctl start` and cluster starts redirected through systemd.\nThe guard invokes a dedicated check-only copy at\n`/usr/local/lib/nelcota/pitr-check`, retained across app binary rollback, without\nfollowing a script inside the fence directory. The CLI refuses `up`, service starts/restarts\nand direct serving while fenced. Plain `up` is not a recovery action: use\n`pitr recover` or a covered restore. Each refusal identifies the fence and\nrecovery command; systemd records its message in the service journal. A refused\nunit can be `failed` with PID zero.":"As units nativas do PostgreSQL e da aplicação verificam a trava em `ExecStartPre`, inclusive no boot, em `systemctl start` manual e na inicialização de clusters redirecionada pelo systemd. A verificação executa uma cópia dedicada em modo somente de validação em `/usr/local/lib/nelcota/pitr-check`, preservada durante o rollback do binário da aplicação, sem seguir um script dentro do diretório da trava. A CLI recusa `up`, inicializações/reinícios de serviços e execução direta do servidor enquanto a trava está ativa. Apenas executar `up` não é uma ação de recuperação: use `pitr recover` ou uma restauração com alvo coberto. Cada recusa identifica a trava e o comando de recuperação; o systemd registra a mensagem no journal do serviço. Uma unit recusada pode ficar `failed` com PID zero.","If native recovery refuses an older installed app binary, keep services stopped\nand install your already verified matching artifact atomically before retrying.\nDo not replace it with an unverified download:":`Se a recuperação nativa recusar um binário instalado da aplicação mais antigo, mantenha os serviços parados e instale atomicamente seu artefato correspondente já verificado antes de repetir. Não o substitua por um download não verificado:`,"Supported PostgreSQL startup configuration":`Configuração suportada de inicialização do PostgreSQL`,'Docker PITR supports the PostgreSQL 17 image generated from `postgres/Dockerfile`\nand the data directory `/var/lib/postgresql/data`. The resolved\n`services.postgres.command` must be absent/null, exactly `["postgres"]`, or the\ncomplete, unchanged command generated by `nelcota init` for a `1gb`, `2gb`,\n`4gb` or `8gb` profile. All four generated tuning profiles remain supported.\nAn empty command, wrappers, extra flags, reordered arguments or hand-edited\ntuning commands are refused; restore does not try to classify individual flags.':'O PITR no Docker oferece suporte à imagem PostgreSQL 17 gerada a partir de `postgres/Dockerfile` e ao diretório de dados `/var/lib/postgresql/data`. O `services.postgres.command` resolvido deve estar ausente/null, ser exatamente `["postgres"]` ou ser o comando completo e inalterado gerado por `nelcota init` para um perfil `1gb`, `2gb`, `4gb` ou `8gb`. Os quatro perfis de tuning gerados continuam suportados. Comandos vazios, wrappers, flags extras, argumentos reordenados ou comandos de tuning editados à mão são recusados; a restauração não tenta classificar flags individualmente.',"`services.postgres.environment.PGDATA` must be omitted or exactly\n`/var/lib/postgresql/data`. A null/inherited value or an unresolved environment\nrepresentation is refused. For example, this explicit default is supported:":"`services.postgres.environment.PGDATA` deve ser omitido ou ser exatamente `/var/lib/postgresql/data`. Um valor null/herdado ou uma representação de ambiente não resolvida é recusado. Por exemplo, este padrão explícito é suportado:","Commands containing `-D`/`--pgdata`, `-c data_directory=...` or\n`-c config_file=...` are unsupported, including alternate spellings and flags\nappended to a generated profile. A custom configuration file could redirect\nthe data directory indirectly. Preflight resolves Compose and refuses unknown\nsettings before stopping services, writing a fence or running any restore\nadapter. The error names the setting and supported configuration. Existing\nfences remain in place if a retry has unsupported settings.":"Comandos com `-D`/`--pgdata`, `-c data_directory=...` ou `-c config_file=...` não são suportados, inclusive grafias alternativas e flags acrescentadas a um perfil gerado. Um arquivo de configuração personalizado pode redirecionar indiretamente o diretório de dados. O preflight resolve o Compose e recusa configurações desconhecidas antes de parar serviços, gravar uma trava ou executar qualquer adaptador de restauração. O erro informa a configuração recusada e a configuração suportada. Travas existentes permanecem ativas se uma nova tentativa tiver configurações não suportadas.","Native PITR supports the packaged `postgresql@17-main` unit with\n`/usr/bin/pg_ctlcluster --skip-systemctl-redirect 17-main start`, no systemd\nenvironment overrides and `/etc/postgresql/17/main/postgresql.conf`.\n`pg_ctl_options` in `/etc/postgresql/17/main/pg_ctl.conf` must be empty or\nunset. The cluster's `environment` file must be empty/comments or contain only\n`PGDATA=/var/lib/postgresql/17/main`. `PG_CLUSTER_CONF_ROOT` must be unset or\n`/etc/postgresql`. PostgreSQL itself resolves the effective `data_directory`,\nincluding configuration includes and `postgresql.auto.conf`; it must be exactly\n`/var/lib/postgresql/17/main`. Unreadable, indeterminate or customized startup\nsettings are refused before mutation. The generated native tuning profiles\ncontinue to work; native recovery supplies fixed `-D` and `config_file` arguments.":"O PITR nativo oferece suporte à unit empacotada `postgresql@17-main` com `/usr/bin/pg_ctlcluster --skip-systemctl-redirect 17-main start`, sem sobrescritas de ambiente no systemd e com `/etc/postgresql/17/main/postgresql.conf`. `pg_ctl_options` em `/etc/postgresql/17/main/pg_ctl.conf` deve estar vazio ou não definido. O arquivo `environment` do cluster deve estar vazio/com comentários ou conter apenas `PGDATA=/var/lib/postgresql/17/main`. `PG_CLUSTER_CONF_ROOT` deve estar ausente ou ser `/etc/postgresql`. O próprio PostgreSQL resolve o `data_directory` efetivo, incluindo arquivos de configuração incluídos e `postgresql.auto.conf`; ele deve ser exatamente `/var/lib/postgresql/17/main`. Configurações de inicialização ilegíveis, indeterminadas ou personalizadas são recusadas antes de qualquer alteração. Os perfis de tuning nativos gerados continuam funcionando; a recuperação nativa fornece argumentos fixos para `-D` e `config_file`."},dt={Changelog:`Histórico de alterações`,"Package releases use Semantic Versioning and Keep a Changelog categories.\nDates identify release entries; registry availability requires a successful publish.":`Os pacotes usam Semantic Versioning e categorias de Keep a Changelog. As datas identificam entradas de versão; a disponibilidade no registro exige publicação bem-sucedida.`,Unreleased:`Não lançado`,Fixed:`Corrigido`,"Cancel queued sign-up, password login, verification and OAuth exchange waits\nwithout interrupting another caller's refresh or an accepted publication.":`Cancelar esperas de cadastro, login por senha, verificação e troca OAuth na fila
sem interromper a renovação de outro chamador nem uma publicação aceita.`,"Type bucket size limits as `number | string | null` and send exact decimal\nstrings as JSON integers, so reading then updating a large int64 limit does\nnot change its value or send a quoted number. Existing server validation\nstill rejects invalid settings. Use strings before JavaScript rounds a value.":`Tipar os limites de tamanho de bucket como \`number | string | null\` e enviar strings
decimais exatas como inteiros JSON, para que ler e atualizar um limite int64 grande
não altere seu valor nem envie um número entre aspas. A validação existente no servidor
continua recusando configurações inválidas. Use strings antes que o JavaScript arredonde um valor.`,"Keep usage diagnostics concise without changing error codes or statuses.":`Manter os diagnósticos de uso concisos sem alterar códigos de erro nem status.`,"Prepared package candidate. Version metadata and this changelog do not publish\nthe package; use a local archive until registry publication completes.":`Candidato do pacote preparado. Os metadados de versão e este changelog não publicam o pacote; use um arquivo local até concluir a publicação no registro.`,"Clear pending OAuth verification state on sign-out, including the native\njournal and storage mirror, absent sessions and failed server revocation.":`Limpa o estado de verificação OAuth pendente ao sair, incluindo o journal nativo e o espelho de armazenamento, sessões ausentes e falhas na revogação no servidor.`,"Keep default server-memory clients' coordination queues independent so\none pending sign-in cannot block another request's cached session read.\nShared adapters and browser sessions retain their existing coordination scope.":`Manter independentes as filas de coordenação dos clientes de servidor com o armazenamento padrão em memória, para que um login pendente não bloqueie a leitura da sessão em cache de outra requisição. Adaptadores compartilhados e sessões no navegador preservam seu escopo de coordenação existente.`,"Coalesce native browser refresh calls that arrive while another tab is\nrotating, preserving the original comparison snapshot before waiting on\nWeb Locks. Authoritative journal checks still guard every accepted rotation;\nlater explicit refreshes remain independent.":`Unificar chamadas de renovação no navegador que chegam enquanto outra aba está renovando a sessão, preservando o estado original para comparação antes de aguardar o Web Locks. O registro autoritativo continua verificando cada renovação aceita; renovações explícitas posteriores continuam independentes.`,"Release cancelled shared-operation waiters immediately while accepted rotation\nfinishes and persists its result; prevent retained AbortSignal/listener graphs.":`Libere imediatamente os consumidores cancelados de operações compartilhadas enquanto a rotação aceita termina e persiste seu resultado; evite reter grafos de AbortSignal/listeners.`,"Coordinate native browser sessions through committed IndexedDB receipts,\npreventing queued tabs from rotating a token from a stale localStorage view.\nReserve rotations before HTTP and prevent late responses from undoing logout.\nNative persistence now requires IndexedDB; reload all tabs when upgrading.\nInterrupted rotations require the owning client to retry or a new sign-in.":`Coordenar sessões nativas do navegador por registros confirmados no IndexedDB, impedindo que abas na fila rotacionem um token de uma visão desatualizada do localStorage. Reservar rotações antes do HTTP e impedir que respostas atrasadas desfaçam o logout. A persistência nativa agora exige IndexedDB; recarregue todas as abas ao atualizar. Rotações interrompidas exigem uma nova tentativa pelo cliente proprietário ou um novo login.`,"Preserve failed sign-in/logout state over an unchanged foreign receipt;\nunique committed revisions distinguish old state from later decisions.":`Preservar o estado de login ou logout cuja gravação falhou sobre um registro inalterado de outro proprietário; revisões confirmadas únicas distinguem o estado antigo de decisões posteriores.`,"Journal native PKCE verifiers and consume them atomically. An already\ncancelled exchange leaves the verifier available; a claimed exchange keeps\nownership until its accepted session is persisted even if a waiter cancels.":`Registrar verificadores PKCE nativos e consumi-los atomicamente. Uma troca já cancelada deixa o verificador disponível; uma troca iniciada mantém a responsabilidade até que sua sessão aceita seja persistida, mesmo se um chamador cancelar a espera.`,"Preserve unsafe integers and decimal digits in JSON responses as strings,\nincluding nested values and RPC results. Ordinary numbers remain numeric.\nRegenerate schema types: Postgres numeric types that may exceed JavaScript\nprecision now use `number | string`. Use strings for exact filters and writes.":"Preserva inteiros fora da faixa segura e dígitos decimais nas respostas JSON como strings, inclusive em valores aninhados e resultados de RPC. Números comuns continuam numéricos. Gere novamente os tipos do esquema: tipos numéricos Postgres que podem exceder a precisão do JavaScript agora usam `number | string`. Use strings para filtros e escritas exatos.","Generated arrays allow null elements independently of column nullability,\nincluding enum arrays and RPC arguments and results.":`Arrays gerados permitem elementos nulos independentemente de a coluna aceitar nulos, inclusive arrays de enums e argumentos e resultados de RPC.`,"Bound HTTP error bodies to 64 KiB while preserving status and `Retry-After`.":"Limita os corpos de erros HTTP a 64 KiB, preservando o estado e `Retry-After`.","Preserve newer in-memory sessions when storage writes or removal fail; stale\nstorage and cross-tab reloads cannot restore a spent token or signed-out state.":`Preserva sessões mais recentes em memória quando a gravação ou remoção no armazenamento falha; dados antigos e recargas entre abas não podem restaurar um token já usado ou uma sessão encerrada.`,"Expose the optional `auth.onBackgroundError` handler for background adapter\nfailures. Automatic refresh pauses until persistence succeeds; handler\nexceptions are isolated.":"Disponibiliza o callback opcional `auth.onBackgroundError` para falhas do adaptador em segundo plano. A renovação automática fica pausada até que a persistência tenha sucesso; exceções do callback são isoladas.","Ignore coordination messages after disposal and keep cancellation cleanup\nbounded when transport cancellation does not settle.":`Ignora mensagens de coordenação após o descarte e limita a limpeza do cancelamento quando o cancelamento do transporte não termina.`,"Verify the package and real-server contract against Nelcota 0.4.0. The minimum\nsupported server remains 0.3.0; no webhook-management SDK API is introduced.":`Verifica o pacote e o contrato com o servidor real contra o Nelcota 0.4.0. A versão mínima suportada do servidor continua sendo 0.3.0; não é introduzida uma API de gestão de webhooks no SDK.`,Changed:`Alterado`,"Update repository and documentation links to `Nelcota/Nelcota` after the\norganization transfer. The client API and server compatibility are unchanged.":"Atualiza os links do repositório e da documentação para `Nelcota/Nelcota` após a transferência para a organização. A API do cliente e a compatibilidade com o servidor permanecem iguais.","Publish from the organization with GitHub Actions trusted publishing (OIDC).":`Publica pela organização usando publicação confiável do GitHub Actions (OIDC).`,Added:`Adicionado`,"First npm release. Changes since the release candidate:":`Primeira publicação no npm. Alterações desde a versão candidata:`,"Add `auth.updateUser({ password?, currentPassword?, data? })` for the new\n`PUT /auth/v1/user`: change the password (other sessions end) or merge\n`user_metadata`. Needs a server with that endpoint.":"Adiciona `auth.updateUser({ password?, currentPassword?, data? })` para o novo `PUT /auth/v1/user`: altera a senha (as outras sessões são encerradas) ou mescla `user_metadata`. Requer um servidor com esse endpoint.","Know the server's newer codes: `invalid_email`, `weak_password`,\n`bad_request`, `method_not_allowed`, `payload_too_large`,\n`unsupported_media_type`, `range_not_satisfiable` and a server `timeout`.":"Reconhece os códigos mais recentes do servidor: `invalid_email`, `weak_password`, `bad_request`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`, `range_not_satisfiable` e `timeout` do servidor.","Expose the optional Postgres fields of server errors (`sqlstate`, `details`,\n`hint`, `constraint`) on `NelcotaError`, and export `NelcotaErrorCode` and\n`ServerErrorCode` for autocompletion of known codes.":"Expõe os campos opcionais de erros do Postgres (`sqlstate`, `details`, `hint`, `constraint`) em `NelcotaError` e exporta `NelcotaErrorCode` e `ServerErrorCode` para completar automaticamente os códigos conhecidos.","Bodyless error responses (HEAD counts) keep a meaningful code:\n`unauthorized`, `forbidden`, `not_found`, `rate_limited` or `unavailable`\ninstead of `http_<status>`.":"Respostas de erro sem corpo (incluindo HEAD) mantêm um código significativo: `unauthorized`, `forbidden`, `not_found`, `rate_limited` ou `unavailable`, em vez de `http_<status>`.","Add `offset(n)` (parity with the Rust client), a `range` field on query\nresults (the returned rows, from `Content-Range`) so a server row cap is\nvisible, and a `pages(size)` async iterator that walks every row.":"Adiciona `offset(n)` (em paridade com o cliente Rust), um campo `range` nos resultados de consultas (as linhas retornadas, a partir de `Content-Range`) para tornar visível o limite de linhas do servidor, e um iterador assíncrono `pages(size)` que percorre todas as linhas.","Add `.throwOnError()` on queries and an exported `unwrap(result)` helper\nfor code that prefers exceptions; the examples use them instead of a local\nhelper.":"Adiciona `.throwOnError()` às consultas e uma função auxiliar exportada `unwrap(result)` para código que prefere exceções; os exemplos usam essas funções em vez de uma função auxiliar local.","Cancel auth/request waits independently while accepted refresh rotation\ncompletes and persists the replacement token.":`Cancela esperas de autenticação/requisição de forma independente enquanto a rotação de renovação já aceita termina e persiste o token substituto.`,"Type HEAD data as null and require row representation for single/maybeSingle;\nreject malformed REST row representations with invalid_response.":`Define o tipo dos dados de HEAD como null e exige representação de linhas para single/maybeSingle; rejeita representações de linhas REST malformadas com invalid_response.`,"Require complete bucket settings on update, with explicit null to clear\nlimits. Existing partial updateBucket calls must supply all three fields.":`Exige todas as configurações do bucket na atualização, com null explícito para remover limites. Chamadas parciais existentes a updateBucket devem fornecer os três campos.`,"Add regressions for cancellation, result types, cardinality and bucket limits\nagainst both mock transports and the production HTTP/Postgres contract.":`Adiciona testes de regressão para cancelamento, tipos de resultado, cardinalidade e limites de buckets tanto com transportes simulados quanto com o contrato HTTP/Postgres de produção.`,"0.1.0 release candidate":`Versão candidata 0.1.0`,"JavaScript ESM and TypeScript declarations with no runtime dependencies.":`JavaScript ESM e declarações TypeScript sem dependências de execução.`,"REST queries, writes, upserts, filters, embeds, pagination, counts and RPC.":`Consultas REST, escritas, upserts, filtros, relacionamentos embutidos, paginação, contagens e RPC.`,"Password, email-link and OAuth PKCE authentication; persistent browser\nsessions and coordinated refresh rotation.":`Autenticação por senha, link de e-mail e OAuth PKCE; sessões persistentes no navegador e rotação coordenada de tokens de renovação.`,"Storage uploads, downloads, streaming responses, ranges, ETags and URLs.":`Uploads, downloads, respostas em streaming, intervalos, ETags e URLs de armazenamento.`,"Independent `createRestClient`, `createAuthClient` and `createStorageClient`\nfactories, with a caller-supplied token source for sharing auth.":"Fábricas independentes `createRestClient`, `createAuthClient` e `createStorageClient`, com uma fonte de tokens fornecida pelo chamador para compartilhar a autenticação.","Buffered response failures return structured errors; read retries include\ninterrupted bodies and never retry earlier than `Retry-After`.":"Falhas em respostas carregadas em memória retornam erros estruturados; novas tentativas de leitura incluem corpos interrompidos e nunca ocorrem antes de `Retry-After`.","Auth request cancellation, logout/refresh coordination and client disposal.":`Cancelamento de requisições de autenticação, coordenação de logout/renovação e descarte do cliente.`,"Session keys isolate projects served under different URL base paths.":`Chaves de sessão isolam projetos servidos em caminhos-base de URL diferentes.`,"Packed-package checks in clean JavaScript and TypeScript consumers, contract\ntests against Postgres and Nelcota, and browser/runtime checks.":`Verificações do pacote empacotado em consumidores JavaScript e TypeScript limpos, testes de contrato com Postgres e Nelcota e verificações em navegadores e ambientes de execução.`,"Runnable browser, Node and per-request server examples; Portuguese quickstart.":`Exemplos executáveis para navegador, Node e servidor por requisição; guia de início rápido em português.`,"The candidate becomes a public release only after a successful npm publish.":`A versão candidata só se torna uma versão pública após uma publicação bem-sucedida no npm.`,"Release notes describe the package version, not the server. Candidate 0.2.0\nchanges are absent from registry 0.1.2; installing them requires the new client\npackage after its publication, or a reviewed local archive.":`As notas descrevem a versão do pacote, não a do servidor. As alterações do candidato 0.2.0 não estão no registro 0.1.2; instalá-las exige o novo pacote após sua publicação ou um arquivo local revisado.`},ft={"Decision log":`Registro de decisões`,"Historical decisions made while building Nelcota, with the why. Newest at the\nend. Earlier milestones are snapshots: current server source requires Rust 1.99,\nthe Rust SDK supports 1.88, and a bare CLI without server configuration prints\nhelp. Use current operating guides and release notes over superseded choices.\nDecision numbers and historical rationale remain intact.":`Decisões históricas durante a construção do Nelcota, com seus motivos. As mais recentes ficam no fim. Marcos anteriores são snapshots: a fonte atual do servidor exige Rust 1.99, o SDK Rust suporta 1.88, e um CLI sem configuração de servidor mostra ajuda. Prefira guias atuais e notas de versão a escolhas substituídas. Números das decisões e justificativas históricas permanecem intactos.`,"Milestone 1":`Marco 1`,"**D1. Apache-2.0 license.** Chosen by the maintainer (2026-10-06).":`**D1. Licença Apache-2.0.** Escolhida pelo mantenedor (2026-10-06).`,"**D2. Name and binary.** The project is called Nelcota; the single binary is\n`nelcota` (crate `nelcota-server`). In Milestone 4 it gains subcommands\n(`nelcota init`, `nelcota up`...); without arguments it starts the server.":"**D2. Nome e binário.** O projeto se chama Nelcota; o binário único é `nelcota` (crate `nelcota-server`). No Marco 4, recebe subcomandos (`nelcota init`, `nelcota up`...); sem argumentos, inicia o servidor.","**D3. The `admin` and `cli` crates only arrive in Milestones 4/5.** Avoids\nempty crates.":"**D3. Os crates `admin` e `cli` só chegam nos Marcos 4/5.** Evita crates vazios.","**D4. Integration tests in `crates/server/tests/`.** The workspace is virtual\n(there is no package at the root), and Cargo integration tests must belong to a\npackage. `server` exposes the `Router` in a lib so the tests use the same code\nas production.":"**D4. Testes de integração em `crates/server/tests/`.** O workspace é virtual (não há pacote na raiz), e testes de integração do Cargo devem pertencer a um pacote. `server` expõe o `Router` em uma lib para que os testes usem o mesmo código da produção.","**D5. A single URL.** `NELCOTA_DATABASE_URL` points to a role that owns the\nschema (the `postgres` superuser in Docker) and is used only for migrations and\nto set the `authenticator` password. The API uses the same host/database,\nswapping user/password for `authenticator` / `NELCOTA_AUTHENTICATOR_PASSWORD`.":"**D5. Uma única URL.** `NELCOTA_DATABASE_URL` aponta para um papel proprietário do esquema (o superusuário `postgres` no Docker) e é usada apenas para migrações e para definir a senha de `authenticator`. A API usa o mesmo host/banco, trocando usuário/senha por `authenticator` / `NELCOTA_AUTHENTICATOR_PASSWORD`.","**D6. The `authenticator` password stays out of migrations.** Migrations hold\nno secrets. At startup the server computes the SCRAM-SHA-256 verifier on the\nclient side and runs `ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'`: the plain\npassword never travels over the wire nor shows up in Postgres' statement log.":"**D6. A senha de `authenticator` fica fora das migrações.** Migrações não contêm segredos. Na inicialização, o servidor calcula o verificador SCRAM-SHA-256 no lado do cliente e executa `ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'`: a senha em texto puro nunca trafega na rede nem aparece no log de instruções do Postgres.","**D7. `set_config('role', $1, true)` instead of `SET LOCAL ROLE x`.** Both are\nequivalent (`SET LOCAL ROLE` is sugar for `set_config('role', ..., true)`), but\n`set_config` takes a parameter, sets role and claims in a single round trip and\navoids any SQL built as a string. The role value comes from a closed `enum`.":"**D7. `set_config('role', $1, true)` em vez de `SET LOCAL ROLE x`.** Ambos são equivalentes (`SET LOCAL ROLE` é açúcar sintático para `set_config('role', ..., true)`), mas `set_config` recebe um parâmetro, define papel e claims em uma única ida e volta e evita SQL construído como string. O valor do papel vem de um `enum` fechado.","**D8. Pool with `RecyclingMethod::Fast`.** Role and claims are\ntransaction-scoped and die on COMMIT/ROLLBACK (including a drop without commit,\nwhich sends ROLLBACK). No `DISCARD ALL` is needed on each checkout. Covered by\nthe pool-leak and rollback tests in `crates/server/tests/rls.rs`.":"**D8. Pool com `RecyclingMethod::Fast`.** Papel e claims têm escopo de transação e terminam no COMMIT/ROLLBACK (incluindo descarte sem commit, que envia ROLLBACK). Não é necessário `DISCARD ALL` a cada retirada. Coberto pelos testes de vazamento do pool e rollback em `crates/server/tests/rls.rs`.","**D9. Internal migrations in `nelcota.schema_migrations`.** A schema of its\nown, without GRANTs to the API roles, so it does not show up in `public`\n(which the automatic API exposes). An advisory lock serializes bootstrap\nacross instances.":"**D9. Migrações internas em `nelcota.schema_migrations`.** Um esquema próprio, sem GRANTs para os papéis da API, para não aparecer em `public` (exposto pela API automática). Um bloqueio consultivo serializa a inicialização entre instâncias.","**D10. The example table stays out of migrations.** `examples/todos.sql` is\napplied by the tests and optionally in dev. Nelcota's migrations create no\nbusiness tables in anyone's database.":"**D10. A tabela de exemplo fica fora das migrações.** `examples/todos.sql` é aplicado pelos testes e opcionalmente em desenvolvimento. As migrações do Nelcota não criam tabelas de negócio no banco de ninguém.","**D11. Extensions in the `extensions` schema.** `pgcrypto` and\n`pg_stat_statements` stay out of `public`. `pg_stat_statements` requires\n`shared_preload_libraries=pg_stat_statements` (already in the dev compose and\nin the tests).":"**D11. Extensões no esquema `extensions`.** `pgcrypto` e `pg_stat_statements` ficam fora de `public`. `pg_stat_statements` exige `shared_preload_libraries=pg_stat_statements` (já presente no compose de desenvolvimento e nos testes).","**D12. Provisional HS256 JWT** (superseded by D20). Milestone 1 uses HS256\nwith a shared secret (≥ 32 characters) behind the `JwtVerifier` trait.\nMilestone 2 adds EdDSA + JWKS as the default, and HS256 stays as a simple mode.":"**D12. JWT HS256 provisório** (substituído por D20). O Marco 1 usa HS256 com segredo compartilhado (≥ 32 caracteres) por trás do trait `JwtVerifier`. O Marco 2 adiciona EdDSA + JWKS como padrão, e HS256 permanece como modo simples.","**D13. Claim rules.** `role` is required and must be `anon`, `authenticated`\nor `service_role`. `authenticated` requires a uuid `sub` (so `auth.uid()` never\nfails the cast). `aud` is not verified yet (it joins the contract in Milestone\n2). 30 s leeway on `exp`.":"**D13. Regras das claims.** `role` é obrigatória e deve ser `anon`, `authenticated` ou `service_role`. `authenticated` exige um `sub` UUID (para que `auth.uid()` nunca falhe na conversão). `aud` ainda não é verificada (entra no contrato no Marco 2). Tolerância de 30 s em `exp`.","**D14. No token = `anon`; invalid token = 401.** An `Authorization` header\nthat is present but invalid (expired, wrong signature, scheme other than\n`Bearer`, unknown role) never silently becomes `anon`.":"**D14. Sem token = `anon`; token inválido = 401.** Um cabeçalho `Authorization` presente, mas inválido (expirado, assinatura incorreta, esquema diferente de `Bearer`, papel desconhecido) nunca se torna `anon` silenciosamente.","**D15. 401 vs 403 on missing permission.** `insufficient_privilege` (42501)\nbecomes 401 for `anon` (needs to sign in) and 403 for the other roles, as in\nPostgREST.":"**D15. 401 versus 403 em permissão ausente.** `insufficient_privilege` (42501) se torna 401 para `anon` (precisa se autenticar) e 403 para os demais papéis, como no PostgREST.",'**D16. `rsa` ignored in `cargo audit`/`cargo deny` (RUSTSEC-2023-0071).** It\ncomes through `jsonwebtoken`\'s `rust_crypto` backend. The Marvin Attack affects\noperations with the RSA **private** key; Nelcota never signs with RSA. The\n`aws_lc_rs` backend would avoid the dependency, but requires a C/CMake\ntoolchain in the build, which hurts the "simple static binary". Revisit if\nRS256 is ever used for signing.':'**D16. `rsa` ignorado em `cargo audit`/`cargo deny` (RUSTSEC-2023-0071).** Vem pelo backend `rust_crypto` de `jsonwebtoken`. O Marvin Attack afeta operações com a chave RSA **privada**; Nelcota nunca assina com RSA. O backend `aws_lc_rs` evitaria a dependência, mas exige ferramentas C/CMake na compilação, o que prejudica o "binário estático simples". Reavaliar se RS256 for usado para assinatura.',"**D17. Libraries outside the prompt's table.**":`**D17. Bibliotecas fora da tabela do prompt.**`,"`uuid`: validates the `sub` claim and is Postgres' native type for ids.":"`uuid`: valida a claim `sub` e é o tipo nativo do Postgres para IDs.","`postgres-protocol`: already a transitive dependency of `tokio-postgres`;\nused to compute the SCRAM verifier (D6).":"`postgres-protocol`: já é dependência transitiva de `tokio-postgres`; usado para calcular o verificador SCRAM (D6).","`http-body-util` (dev only): reads response bodies in tests.":"`http-body-util` (apenas desenvolvimento): lê corpos de resposta nos testes.","**D18. Postgres without TLS on the internal network.** The database is only\nreachable over Docker's internal network (or localhost in dev). TLS to the\ndatabase waits for a remote-database scenario.":`**D18. Postgres sem TLS na rede interna.** O banco só é acessível pela rede interna do Docker (ou localhost em desenvolvimento). TLS para o banco aguarda um cenário de banco remoto.`,"**D19. Edition 2024, MSRV 1.88.** The current `testcontainers-modules` already\nrequires 1.88.":"**D19. Edition 2024, MSRV 1.88.** O `testcontainers-modules` atual já exige 1.88.","Milestone 2":`Marco 2`,"**D20. EdDSA (Ed25519) as the default; HS256 as legacy.** The private key comes\nfrom `NELCOTA_JWT_PRIVATE_KEY` (PKCS#8 PEM or the one-line base64, which fits\nin a `.env`). With an EdDSA key **and** an HS256 secret configured, the server\nsigns with EdDSA and accepts both when verifying (zero-downtime migration). The\n`kid` is the RFC 7638 thumbprint.":"**D20. EdDSA (Ed25519) como padrão; HS256 como legado.** A chave privada vem de `NELCOTA_JWT_PRIVATE_KEY` (PKCS#8 PEM ou base64 em uma linha, que cabe em um `.env`). Com chave EdDSA **e** segredo HS256 configurados, o servidor assina com EdDSA e aceita ambos na verificação (migração sem indisponibilidade). O `kid` é a impressão digital RFC 7638.","**D21. Internal `nelcota_auth` role for the `auth` schema.** Auth handlers run\nwith `SET LOCAL ROLE nelcota_auth` (a fixed string). No JWT can assume it (the\n`Role` enum does not contain it), and the API roles have no GRANT on `auth.*`.\nDiscarded alternative: `SECURITY DEFINER` functions, which would spread logic\ninto PL/pgSQL with no real gain.":"**D21. Papel interno `nelcota_auth` para o esquema `auth`.** Handlers de autenticação executam com `SET LOCAL ROLE nelcota_auth` (string fixa). Nenhum JWT pode assumi-lo (o enum `Role` não o contém), e os papéis da API não têm GRANT em `auth.*`. Alternativa descartada: funções `SECURITY DEFINER`, que espalhariam lógica em PL/pgSQL sem ganho real.","**D22. 32-byte opaque refresh token, stored only as SHA-256.** SHA-256 (not\nargon2) because the token already has 256 bits of entropy; lookup is through a\nunique index, with no comparison in the application.":`**D22. Token de renovação opaco de 32 bytes, armazenado apenas como SHA-256.** SHA-256 (sem argon2) porque o token já tem 256 bits de entropia; a busca ocorre por índice único, sem comparação no aplicativo.`,"**D23. Reuse detection revokes the session (family), not the user.** Other\nsessions stay valid. No grace window for now (documented).":`**D23. A detecção de reutilização revoga a sessão (família), não o usuário.** Outras sessões permanecem válidas. Sem janela de tolerância por enquanto (documentado).`,"**D24. Logout revokes the session; the access JWT is valid until `exp`.**\nAccess tokens are stateless and short (15 min by default). Checking revocation\non every request would cost an extra database round trip.":"**D24. Logout revoga a sessão; o JWT de acesso é válido até `exp`.** Tokens de acesso não mantêm estado e são curtos (15 min por padrão). Verificar revogação em cada requisição custaria uma ida e volta extra ao banco.","**D25. Argon2id with RustCrypto's default parameters (m=19 MiB, t=2, p=1).**\nRuns in `spawn_blocking`, with at most `min(cores, 4)` concurrent hashes (peak\n< 80 MiB). Logging in with an unknown email verifies against a dummy hash, so\nthe response time does not reveal whether the account exists.":"**D25. Argon2id com os parâmetros padrão do RustCrypto (m=19 MiB, t=2, p=1).** Executa em `spawn_blocking`, com no máximo `min(cores, 4)` hashes concorrentes (pico < 80 MiB). Login com e-mail desconhecido verifica um hash fictício para que o tempo de resposta não revele se a conta existe.","**D26. In-memory rate limit, fixed 1-minute window** (the window became a GCRA in D69), per IP (signup/token)\nand per email (login). One binary per install makes Redis unnecessary. The IP\ncomes from `X-Forwarded-For` (rightmost entry) only with\n`NELCOTA_TRUST_PROXY=true`.":"**D26. Limite de requisições em memória, janela fixa de 1 minuto** (a janela se tornou GCRA em D69), por IP (cadastro/token) e por e-mail (login). Um binário por instalação dispensa Redis. O IP vem de `X-Forwarded-For` (entrada mais à direita) apenas com `NELCOTA_TRUST_PROXY=true`.","**D27. Signing up with a duplicate email answers 409.** Without email\nconfirmation in the MVP, hiding the account's existence at signup would bring\nno real protection (login still does not reveal it).":`**D27. Cadastro com e-mail duplicado responde 409.** Sem confirmação de e-mail no MVP, ocultar a existência da conta no cadastro não traria proteção real (o login continua sem revelá-la).`,"**D28. New libraries.** `argon2` (it was in the table); `sha2`, `base64` and\n`getrandom` were already transitive dependencies (`jsonwebtoken`/RustCrypto)\nand are used directly at the same versions, without growing the tree. The ISC\nlicense is allowed in `cargo deny` (it comes from `simple_asn1`, used to read\nPEM).":"**D28. Novas bibliotecas.** `argon2` (estava na tabela); `sha2`, `base64` e `getrandom` já eram dependências transitivas (`jsonwebtoken`/RustCrypto) e são usadas diretamente nas mesmas versões, sem aumentar a árvore. A licença ISC é permitida em `cargo deny` (vem de `simple_asn1`, usado para ler PEM).","Milestone 3":`Marco 3`,"**D29. Dynamic SQL with our own builder, no `sea-query`.** Every URL value\nbecomes a **text** parameter, and Postgres converts it to the column type\n(`$1::text::<catalog type>`); inserts and updates use\n`json_populate_recordset`/`json_populate_record`, and RPC uses `json_to_record`.\nThat way Postgres validates types as it would a literal, and the application\ndoes not need to map types. `sea-query` binds each value to a Rust type (and\n`sea-query-postgres` would require that mapping), besides not expressing these\npatterns well. The builder is ~400 lines with three auditable rules:\nidentifiers only from the catalog and always quoted; cast types only from the\ncatalog; values always parameters. Unit and integration tests cover injection\non both sides.":"**D29. SQL dinâmico com construtor próprio, sem `sea-query`.** Todo valor da URL se torna um parâmetro **text**, e o Postgres o converte para o tipo da coluna (`$1::text::<catalog type>`); inserções e atualizações usam `json_populate_recordset`/`json_populate_record`, e RPC usa `json_to_record`. Assim o Postgres valida tipos como faria com um literal, e o aplicativo não precisa mapear tipos. `sea-query` vincula cada valor a um tipo Rust (e `sea-query-postgres` exigiria esse mapeamento), além de não expressar bem esses padrões. O construtor tem ~400 linhas com três regras auditáveis: identificadores apenas do catálogo e sempre entre aspas; tipos de conversão apenas do catálogo; valores sempre parametrizados. Testes unitários e de integração cobrem injeção nos dois lados.","**D30. OpenAPI built with `serde_json`, no `utoipa`.** `utoipa` generates the\nspecification at compile time from Rust types; ours comes from the catalog at\nrun time. The document is filtered by the request role's privileges (like\nPostgREST's `follow-privileges` mode).":"**D30. OpenAPI construído com `serde_json`, sem `utoipa`.** `utoipa` gera a especificação em tempo de compilação a partir de tipos Rust; a nossa vem do catálogo em tempo de execução. O documento é filtrado pelos privilégios do papel da requisição (como o modo `follow-privileges` do PostgREST).","**D31. Catalog reload through an event trigger + `LISTEN nelcota`.** The\ntrigger runs on `ddl_command_end` and `sql_drop` (including GRANT/REVOKE). The\nlistener batches bursts (100 ms), reconnects with backoff and reloads on every\nreconnect. Without a superuser, the migration proceeds without the trigger and\nreloading is manual (`NOTIFY`).":"**D31. Recarga do catálogo por event trigger + `LISTEN nelcota`.** O trigger executa em `ddl_command_end` e `sql_drop` (incluindo GRANT/REVOKE). O listener agrupa rajadas (100 ms), reconecta com espera progressiva e recarrega a cada reconexão. Sem superusuário, a migração prossegue sem o trigger e a recarga é manual (`NOTIFY`).","**D32. PATCH/DELETE require a filter.** Unlike PostgREST (which allows it and\nlets RLS limit it), we refuse with 400. The cost is an explicit filter when\nthe intent really is to hit everything.":`**D32. PATCH/DELETE exigem filtro.** Diferentemente do PostgREST (que permite e deixa a RLS limitar), recusamos com 400. O custo é um filtro explícito quando a intenção realmente é atingir tudo.`,"**D33. Batches with different keys respect DEFAULT.** Rows are grouped by\ncolumn set and each group becomes an INSERT (CTEs in one statement). In\nPostgREST, without `Prefer: missing=default`, missing columns become NULL; we\nfind DEFAULT the least surprising behaviour.":"**D33. Lotes com chaves diferentes respeitam DEFAULT.** Linhas são agrupadas por conjunto de colunas e cada grupo se torna um INSERT (CTEs em uma instrução). No PostgREST, sem `Prefer: missing=default`, colunas ausentes se tornam NULL; consideramos DEFAULT o comportamento menos surpreendente.","**D34. `statement_timeout` on the `authenticator` role.** `ALTER ROLE anon SET\n...` has no effect with `SET ROLE` (Postgres only applies a role's settings at\nlogin). Bootstrap applies `NELCOTA_STATEMENT_TIMEOUT_SECS` (default 10 s) to\n`authenticator`, and the error becomes 504.":"**D34. `statement_timeout` no papel `authenticator`.** `ALTER ROLE anon SET ...` não tem efeito com `SET ROLE` (o Postgres só aplica as configurações do papel no login). A inicialização aplica `NELCOTA_STATEMENT_TIMEOUT_SECS` (padrão 10 s) a `authenticator`, e o erro se torna 504.","**D35. Postgres' default kept for `EXECUTE` on functions (PUBLIC).** Changing\nthe default privileges would hide plain Postgres behaviour; the documentation\nand the panel warn about it.":"**D35. Mantido o padrão do Postgres para `EXECUTE` em funções (PUBLIC).** Alterar os privilégios padrão ocultaria o comportamento normal do Postgres; a documentação e o painel avisam sobre isso.","**D36. New libraries.** `form_urlencoded`, `futures-util` and `bytes` were\nalready transitive dependencies (axum/tokio-postgres); tower-http's\n`compression-gzip` adds `flate2`.":"**D36. Novas bibliotecas.** `form_urlencoded`, `futures-util` e `bytes` já eram dependências transitivas (axum/tokio-postgres); `compression-gzip` do tower-http adiciona `flate2`.","Milestone 4":`Marco 4`,"**D37. One binary, two roles.** `nelcota` without arguments (or `serve`)\nstarts the server; the subcommands operate the install. On a host,\n`migrate`/`types`/`token` are forwarded to the `app` container (`docker compose\nexec`), which is what can reach Postgres on an `internal: true` network; with\n`NELCOTA_DATABASE_URL` in the environment, they run directly.":"**D37. Um binário, duas funções.** `nelcota` sem argumentos (ou `serve`) inicia o servidor; os subcomandos operam a instalação. Em um host, `migrate`/`types`/`token` são encaminhados ao contêiner `app` (`docker compose exec`), que consegue alcançar o Postgres em uma rede `internal: true`; com `NELCOTA_DATABASE_URL` no ambiente, executam diretamente.","**D38. Postgres profiles become `-c key=value` in the compose file.** The\n`deploy/postgres/profiles/*.conf` files are the source; `init` turns them into\narguments of the `postgres` command. Using `config_file` would replace the\nimage's whole `postgresql.conf` (and change the default `pg_hba.conf`\ndirectory).":"**D38. Perfis do Postgres se tornam `-c key=value` no compose.** Os arquivos `deploy/postgres/profiles/*.conf` são a origem; `init` os transforma em argumentos do comando `postgres`. Usar `config_file` substituiria todo o `postgresql.conf` da imagem (e mudaria o diretório padrão de `pg_hba.conf`).","**D39. Backups with `pg_dump -Fc`; S3 uploads with the `amazon/aws-cli`\nimage.** Nothing to install on the host and no home-grown S3 signing (SigV4).\nRestore in a single transaction (`--single-transaction --exit-on-error`). PITR\nwith WAL-G is pending (daily dumps: an RPO of up to 24 h).":"**D39. Backups com `pg_dump -Fc`; uploads S3 com a imagem `amazon/aws-cli`.** Nada para instalar no host e nenhuma assinatura S3 própria (SigV4). Restauração em uma única transação (`--single-transaction --exit-on-error`). PITR com WAL-G está pendente (dumps diários: RPO de até 24 h).",'**D40. Upgrade with rollback = previous image + restore of the pre-upgrade\nbackup.** The new version may have applied internal migrations the previous\none does not know (refinery refuses to start with an "unknown" migration).\nThat is why the rollback also restores the database and the matching disk-file\nsnapshot. The proxy stays in maintenance from before the old app stops until\nthe upgraded or restored app is healthy, so successful public writes cannot\nbe lost between capture and rollback. Failure-path tests cover this sequencing.':`**D40. Atualização com reversão = imagem anterior + restauração do backup anterior à atualização.** A nova versão pode ter aplicado migrações internas desconhecidas pela anterior (refinery recusa iniciar com uma migração "desconhecida"). Por isso, a reversão também restaura o banco e o snapshot correspondente dos arquivos em disco. O proxy permanece em manutenção desde antes de parar o aplicativo antigo até que o aplicativo atualizado ou restaurado esteja saudável, para que escritas públicas bem-sucedidas não se percam entre captura e reversão. Testes de falhas cobrem essa sequência.`,"**D41. `scratch` image with a musl binary; built-in healthcheck.** No shell or\ncurl in the image: `nelcota healthcheck` performs `GET /health` over plain TCP.":"**D41. Imagem `scratch` com binário musl; verificação de saúde embutida.** Sem shell ou curl na imagem: `nelcota healthcheck` executa `GET /health` por TCP simples.","**D42. User migrations in refinery's format (`V<n>__<name>.sql`)**, in\n`nelcota.user_migrations`, separate from the internal ones\n(`nelcota.schema_migrations`). CRLF is normalized before the checksum (a\nWindows checkout does not diverge).":"**D42. Migrações de usuário no formato do refinery (`V<n>__<name>.sql`)**, em `nelcota.user_migrations`, separadas das internas (`nelcota.schema_migrations`). CRLF é normalizado antes do checksum (um checkout Windows não diverge).",'**D43. `install.sh` installs Docker with the official script if it is\nmissing** (as root and without `NELCOTA_SKIP_DOCKER=1`): that is what makes\nthe "3 commands" possible on a fresh VPS. The binary\'s SHA-256 checksum is\nalways verified.':'**D43. `install.sh` instala Docker com o script oficial se estiver ausente** (como root e sem `NELCOTA_SKIP_DOCKER=1`): isso torna os "3 comandos" possíveis em uma VPS nova. O checksum SHA-256 do binário é sempre verificado.',"**D44. `init` does not enable the firewall without `--firewall`.** Enabling\n`ufw` remotely with the wrong SSH port locks the owner out of the machine. By\ndefault it only recommends it.":"**D44. `init` não ativa o firewall sem `--firewall`.** Ativar `ufw` remotamente com a porta SSH errada bloqueia o acesso do proprietário à máquina. Por padrão, apenas recomenda a ativação.","Milestone 5":`Marco 5`,"**D45. Panel with server-side HTML + ~2 KB of our own JS, no HTMX**\n(superseded by D50). Pages are ordinary forms; the only interactive part (the\nSQL editor) fits in a few lines of `fetch`. CSP `script-src 'self'` without\n`unsafe-inline`. Assets embedded with `rust-embed`.":"**D45. Painel com HTML no servidor + ~2 KB de JS próprio, sem HTMX** (substituído por D50). Páginas são formulários comuns; a única parte interativa (o editor SQL) cabe em poucas linhas de `fetch`. CSP `script-src 'self'` sem `unsafe-inline`. Assets embutidos com `rust-embed`.","**D46. Panel login separate from end users.** Email + argon2id hash in the\n`.env` (generated by `init`; the password is shown once). In-memory sessions\n(restarting the server signs the admin out), `HttpOnly; SameSite=Strict`\ncookie (`Secure` behind the proxy), login rate limit and an\n`Origin`/`Sec-Fetch-Site` check on every POST (CSRF).":"**D46. Login do painel separado dos usuários finais.** E-mail + hash argon2id no `.env` (gerados por `init`; senha exibida uma vez). Sessões em memória (reiniciar o servidor desconecta o administrador), cookie `HttpOnly; SameSite=Strict` (`Secure` atrás do proxy), limite de login e verificação de `Origin`/`Sec-Fetch-Site` em todo POST (CSRF).","**D47. The panel uses the admin connection.** The admin owns the database, as\nin `psql`. Table writes reuse the API's SQL builder (catalog identifiers,\nparameterized values). The SQL editor opens a **new** connection per run:\n`BEGIN` without `COMMIT` or `SET ROLE` do not contaminate the pool. The SQL\ntext does not go to the log.":"**D47. O painel usa a conexão administrativa.** O administrador é dono do banco, como em `psql`. Escritas em tabelas reutilizam o construtor SQL da API (identificadores do catálogo, valores parametrizados). O editor SQL abre uma **nova** conexão por execução: `BEGIN` sem `COMMIT` ou `SET ROLE` não contaminam o pool. O texto SQL não vai para o log.","**D48. Panel values keep Postgres' text** (`RawValue`), without going through\n`f64`: `numeric(30,10)` shows and is edited with every digit.":"**D48. Valores do painel mantêm o texto do Postgres** (`RawValue`), sem passar por `f64`: `numeric(30,10)` é mostrado e editado com todos os dígitos.","Panel design":`Design do painel`,"**D49 (superseded by D50).** A panel with a database-console look (dark by\ndefault, emerald accent), inspired by Supabase but with its own name, brand\nand icons. Inter + JetBrains Mono typography, embedded in the binary (~88 KB,\nOFL, see `crates/admin/assets/FONTS.md`): no Google Fonts, to keep the CSP at\n`'self'` and work offline. Light mode via `prefers-color-scheme`. Hand-drawn\nSVG icons (no icon package). On the overview, the row count is exact for\ntables under 10 thousand estimated rows and uses the planner's estimate (`≈`)\nfor large ones.":"**D49 (substituído por D50).** Painel com aparência de console de banco (escuro por padrão, destaque esmeralda), inspirado no Supabase, mas com nome, marca e ícones próprios. Tipografia Inter + JetBrains Mono, embutida no binário (~88 KB, OFL, veja `crates/admin/assets/FONTS.md`): sem Google Fonts, para manter a CSP em `'self'` e funcionar offline. Modo claro via `prefers-color-scheme`. Ícones SVG desenhados à mão (sem pacote de ícones). Na visão geral, a contagem de linhas é exata para tabelas com menos de 10 mil linhas estimadas e usa a estimativa do planejador (`≈`) para as grandes.","Panel in Svelte":`Painel em Svelte`,"**D50. Panel in Svelte 5 + shadcn-svelte + Tailwind v4 + CodeMirror 6**,\nbuilt with Vite (the maintainer's choice, 2026-10-06). The goal is the\ninteractivity server-side HTML did not deliver well: inline editing in the\ngrid, side sheets, multiple selection, column sorting, a SQL editor with\nsyntax highlighting and autocomplete for the database's tables and columns. An\nSPA with Vite, **no SvelteKit**: it injects inline script into the page, which\nwould break the CSP `script-src 'self'`. Our own routing (~60 lines, history\nAPI).":"**D50. Painel em Svelte 5 + shadcn-svelte + Tailwind v4 + CodeMirror 6**, compilado com Vite (escolha do mantenedor, 2026-10-06). O objetivo é a interatividade que o HTML no servidor não entregava bem: edição inline na grade, painéis laterais, seleção múltipla, ordenação de colunas, editor SQL com destaque de sintaxe e preenchimento automático das tabelas e colunas do banco. Uma SPA com Vite, **sem SvelteKit**: ele injeta script inline na página, o que quebraria a CSP `script-src 'self'`. Roteamento próprio (~60 linhas, history API).","**D51. The build (`crates/admin/ui/dist`) is versioned in git** and embedded\nwith `rust-embed`. That way `cargo build`, `cargo install` and the Dockerfile\nstill need no Node: only whoever works on the panel needs Node. CI's\n`admin-ui` job runs `npm ci`, `npm audit`, `svelte-check`, `vite build` and\nfails if the versioned `dist` is out of date.":"**D51. A compilação (`crates/admin/ui/dist`) é versionada no git** e embutida com `rust-embed`. Assim, `cargo build`, `cargo install` e o Dockerfile continuam sem precisar de Node: apenas quem trabalha no painel precisa dele. O job `admin-ui` da CI executa `npm ci`, `npm audit`, `svelte-check`, `vite build` e falha se o `dist` versionado estiver desatualizado.","**D52. CSP: `style-src` now accepts `'unsafe-inline'`; `script-src` stays at\n`'self'` only.** Svelte transitions, CodeMirror and menu positioning\n(floating-ui) inject styles at run time. Inline style runs no code; inline\nscripts remain forbidden (there is a test).":"**D52. CSP: `style-src` agora aceita `'unsafe-inline'`; `script-src` continua apenas com `'self'`.** Transições Svelte, CodeMirror e posicionamento de menus (floating-ui) injetam estilos em tempo de execução. Estilo inline não executa código; scripts inline continuam proibidos (há teste).","**D53. The panel becomes a JSON API at `/admin/api/*`.** Same session, same\norigin check (CSRF) and the same SQL builder as the REST API. Values travel as\nPostgres' exact text (`RawValue`). Batch deletes in a single transaction. The\nSPA is served at any `/admin/*` (fallback to `index.html`). Hashed assets get\nimmutable caching; `index.html`, `no-cache`.":"**D53. O painel se torna uma API JSON em `/admin/api/*`.** Mesma sessão, mesma verificação de origem (CSRF) e mesmo construtor SQL da API REST. Valores trafegam como texto exato do Postgres (`RawValue`). Exclusões em lote em uma transação. A SPA é servida em qualquer `/admin/*` (fallback para `index.html`). Assets com hash recebem cache imutável; `index.html`, `no-cache`.","**D54. CodeMirror loaded on demand.** The main bundle stays around 130 KB\ngzip; the SQL editor (~145 KB gzip) is only downloaded when its page opens.\nThe Inter and JetBrains Mono fonts come from `@fontsource-variable` (OFL),\nserved by the binary itself.":"**D54. CodeMirror carregado sob demanda.** O pacote principal fica em cerca de 130 KB gzip; o editor SQL (~145 KB gzip) só é baixado ao abrir sua página. As fontes Inter e JetBrains Mono vêm de `@fontsource-variable` (OFL), servidas pelo próprio binário.",'**D55. A panel without ornaments.** Removed the generic template patterns:\nstat cards with icons, gradients, a glowing login, a logo in a colored square,\npills and dots on every status, avatars with initials, skeletons, colored\ntoasts, an icon before every title, subtitles explaining the obvious and the\n"Postgres 17" pill (which was hardcoded, not read from the database).\nCriterion: color only for problems (no RLS, RLS without policies, error,\ndestructive action); short texts. Inter/JetBrains Mono swapped for IBM Plex\nSans/Mono, less ubiquitous and with the feel of a technical tool. Security\nwarnings stay, as plain text.':`**D55. Painel sem ornamentos.** Removidos padrões de modelos genéricos: cartões de estatísticas com ícones, gradientes, login brilhante, logo em quadrado colorido, etiquetas arredondadas e pontos em todo status, avatares com iniciais, esqueletos, notificações coloridas, ícone antes de cada título, subtítulos explicando o óbvio e a etiqueta "Postgres 17" (que era fixa, sem ler do banco). Critério: cor apenas para problemas (sem RLS, RLS sem políticas, erro, ação destrutiva); textos curtos. Inter/JetBrains Mono trocadas por IBM Plex Sans/Mono, menos comuns e com aparência de ferramenta técnica. Avisos de segurança permanecem, como texto simples.`,"Several projects per host":`Vários projetos por host`,"**D56. One host, N isolated projects.** A shared Caddy (the only one to\npublish 80/443) and, per project, an app and a Postgres on an exclusive\ninternal network. A single project is a host with one project: there are not\ntwo models to maintain. The registry (`nelcota-host.json`) is the source of\ntruth; the Caddyfile and the public list (`shared/projects.json`) are\ngenerated from it.":"**D56. Um host, N projetos isolados.** Um Caddy compartilhado (o único a publicar 80/443) e, por projeto, um aplicativo e um Postgres em rede interna exclusiva. Um único projeto é um host com um projeto: não há dois modelos para manter. O registro (`nelcota-host.json`) é a fonte de verdade; o Caddyfile e a lista pública (`shared/projects.json`) são gerados a partir dele.","**D57. One Postgres per project.** Postgres roles apply to the whole server;\nin a shared Postgres, projects would share `anon`, `authenticated`,\n`service_role` and the `authenticator` password. The cost (~50 MB of RAM per\nproject) buys physical isolation, per-project backup/restore and leaving, and\nindependent upgrades.":"**D57. Um Postgres por projeto.** Papéis do Postgres valem para todo o servidor; em um Postgres compartilhado, projetos compartilhariam `anon`, `authenticated`, `service_role` e a senha de `authenticator`. O custo (~50 MB de RAM por projeto) oferece isolamento físico, backup/restauração e saída por projeto e atualizações independentes.",'**D58. Own domain or a subdomain of the base domain.** `init api.shop.com`\nderives the name "shop"; `init --project blog` uses `blog.<base-domain>`.\nLocally: `<project>.localhost` (browsers resolve `*.localhost` to the\nmachine).':'**D58. Domínio próprio ou subdomínio do domínio-base.** `init api.shop.com` deriva o nome "shop"; `init --project blog` usa `blog.<base-domain>`. Localmente: `<project>.localhost` (navegadores resolvem `*.localhost` para a máquina).',"**D59. Single sign-on through an SSO handoff, with a per-project login\noption.** Cookies do not cross domains, so the origin panel issues an HS256\nJWT (host's shared secret, `aud` = target project, 60 s, single-use `jti`)\nthat travels in the URL fragment and is traded for a session at the target.\nIn per-project mode there is no shared secret and the handoff does not exist.\nOnly `panel_login.rs` writes admin credentials into the `.env` files;\nswitching modes regenerates and restarts the apps.":"**D59. Login único por transferência SSO, com opção de login por projeto.** Cookies não atravessam domínios, então o painel de origem emite um JWT HS256 (segredo compartilhado do host, `aud` = projeto-alvo, 60 s, `jti` de uso único) que viaja no fragmento da URL e é trocado por uma sessão no destino. No modo por projeto, não há segredo compartilhado nem transferência. Apenas `panel_login.rs` escreve credenciais administrativas nos arquivos `.env`; trocar de modo regenera e reinicia os aplicativos.","**D60. The project list is mounted as a folder and reread on every request.**\nThe app receives `shared/` read-only (a folder bind, not a file bind, so the\nCLI's atomic rename is visible). New projects show up in the switcher without\nrestarting anyone. Each project's state comes from `GET /health` over the\n`nelcota_edge` network, which now includes the version.":"**D60. A lista de projetos é montada como pasta e relida em cada requisição.** O aplicativo recebe `shared/` apenas para leitura (bind de pasta, sem bind de arquivo, para tornar visível a renomeação atômica da CLI). Novos projetos aparecem no seletor sem reiniciar ninguém. O estado de cada projeto vem de `GET /health` pela rede `nelcota_edge`, que agora inclui a versão.","**D61. Removal always with a final backup** in `archive/` before deleting\ncontainers and volumes; the site leaves Caddy with `caddy reload` (without\ntaking the others down).":"**D61. Remoção sempre com backup final** em `archive/` antes de excluir contêineres e volumes; o site sai do Caddy com `caddy reload` (sem parar os outros).","Identity and account in the panel":`Identidade e conta no painel`,"**D62. The mascot is the panel's identity, the only exception to D55.** It\ncomes from the NelcotaScreenShare atlas (`src/assets/mascot/`), cropped with\nthe poses anchored at the feet and right arm so the figure does not jump when\nthe expression changes. It is not decoration because it reacts to the login\nscreen's state: it waves on open, follows the pointer with its eyes, closes\nits eyes while the password is typed and looks sad after a refused login. The\neyes are a vector layer over the PNG's (only the pupil moves); with\n`prefers-reduced-motion` the gaze jumps straight to the target.":"**D62. A mascote é a identidade do painel, a única exceção a D55.** Vem do atlas NelcotaScreenShare (`src/assets/mascot/`), recortada com poses ancoradas nos pés e no braço direito para não saltar ao mudar a expressão. Não é decoração porque reage ao estado da tela de login: acena ao abrir, segue o ponteiro com os olhos, fecha os olhos durante a digitação da senha e fica triste após um login recusado. Os olhos são uma camada vetorial sobre os do PNG (só a pupila se move); com `prefers-reduced-motion`, o olhar salta direto para o alvo.",'**D63. Full-height sidebar.** Project at the top (same height and border as\nthe topbar), pages in the middle, account at the bottom; the topbar covers\nonly the content area. Pinned, it takes 240px from `xl` up; collapsed, it\nbecomes an icon rail that expands over the content. "Projects" left the menu:\nthe project switcher already leads there.':'**D63. Barra lateral de altura completa.** Projeto no topo (mesma altura e borda da barra superior), páginas no meio, conta embaixo; a barra superior cobre apenas o conteúdo. Fixada, ocupa 240px a partir de `xl`; recolhida, vira uma faixa de ícones que expande sobre o conteúdo. "Projetos" saiu do menu: o seletor de projetos já leva até lá.',"**D64. The admin photo lives in the project's database, in the `nelcota`\nschema** (migration V4, `nelcota.admin_avatar`). The admin login only exists\nin environment variables, so there was nowhere to keep data about them; the\ninternal schema has no USAGE for any API role. The photo is per project (each\none has its own Postgres). The browser center-crops and scales it to 256px in\nWebP; the server only accepts PNG, JPEG or WebP recognized by their leading\nbytes, up to 256 KB. The URL carries the version (`?v=`), so the image can be\ncached.":"**D64. A foto do administrador fica no banco do projeto, no esquema `nelcota`** (migração V4, `nelcota.admin_avatar`). O login administrativo só existe em variáveis de ambiente, então não havia onde guardar seus dados; o esquema interno não tem USAGE para nenhum papel da API. A foto é por projeto (cada um tem seu Postgres). O navegador recorta no centro e redimensiona para 256px em WebP; o servidor só aceita PNG, JPEG ou WebP reconhecidos pelos bytes iniciais, até 256 KB. A URL inclui a versão (`?v=`), então a imagem pode ter cache.","**D65. `nelcota-core` recompiles when `migrations/` changes.**\n`embed_migrations!` reads the folder without telling the compiler; a\n`build.rs` with `rerun-if-changed` avoids incremental builds with the old\nlist.":"**D65. `nelcota-core` recompila quando `migrations/` muda.** `embed_migrations!` lê a pasta sem avisar o compilador; um `build.rs` com `rerun-if-changed` evita compilações incrementais com a lista antiga.","**D66. Password recovery by email, with the project's SMTP.** Nelcota runs no\nmail server: `NELCOTA_SMTP_URL`, `NELCOTA_SMTP_FROM` and\n`NELCOTA_PASSWORD_RECOVERY_URL` (all three or none; half-configured, the\nserver does not start). The link goes to the app's page with the token in the\nfragment; tokens live in `auth.one_time_tokens` (migration V5) only as\nSHA-256, are valid for 1 hour and once, with at most one email per minute per\naccount. Sending happens in the background so the response time does not\nreveal whether the account exists. Using the link changes the password, ends\nthe sessions and marks the email as confirmed. Sent with `lettre` over rustls":"**D66. Recuperação de senha por e-mail, com o SMTP do projeto.** Nelcota não executa servidor de e-mail: `NELCOTA_SMTP_URL`, `NELCOTA_SMTP_FROM` e `NELCOTA_PASSWORD_RECOVERY_URL` (as três ou nenhuma; com configuração incompleta, o servidor não inicia). O link vai para a página do aplicativo com o token no fragmento; tokens ficam em `auth.one_time_tokens` (migração V5) apenas como SHA-256, são válidos por 1 hora e uma vez, com no máximo um e-mail por minuto por conta. O envio ocorre em segundo plano para que o tempo de resposta não revele se a conta existe. Usar o link altera a senha, encerra sessões e marca o e-mail como confirmado. Enviado com `lettre` sobre rustls","ring, with Mozilla's roots embedded (`webpki-roots`): the `scratch` image has\nno system certificates and the musl build stays free of OpenSSL. This brought\ntwo permissive licenses into `deny.toml`: CDLA-Permissive-2.0 (the root list,\nwhich is data) and 0BSD (`quoted_printable`).":"ring, com as raízes Mozilla embutidas (`webpki-roots`): a imagem `scratch` não tem certificados do sistema e a compilação musl permanece sem OpenSSL. Isso trouxe duas licenças permissivas para `deny.toml`: CDLA-Permissive-2.0 (a lista de raízes, que são dados) e 0BSD (`quoted_printable`).",'**D67. Panel DDL becomes a migration, registered as already applied.** Every\nDDL the panel applies goes through `apply.rs` and is recorded in\n`nelcota.panel_changes` (migration V6), in the same transaction. "Generate\nmigration" bundles the pending ones into a file and inserts the matching row\ninto `nelcota.user_migrations` with refinery\'s checksum\n(`Migration::unapplied(..).checksum()`): `migrate` does not reapply the file\nand, with `abort_divergent`, refuses an edited copy. The generated text is\nstored (`nelcota.panel_migrations`) so it downloads again byte for byte. The\nversion goes past the highest number in the database, in the folder and among\nearlier exports; the folder comes from `NELCOTA_MIGRATIONS_DIR` or from the\n`/migrations` mount in the container. The SQL editor is left out: it can run\nanything, including DML, and separating schema changes would require parsing\nthe SQL.':'**D67. DDL do painel se torna migração, registrada como já aplicada.** Todo DDL aplicado pelo painel passa por `apply.rs` e é registrado em `nelcota.panel_changes` (migração V6), na mesma transação. "Gerar migração" reúne as pendentes em um arquivo e insere a linha correspondente em `nelcota.user_migrations` com o checksum do refinery (`Migration::unapplied(..).checksum()`): `migrate` não reaplica o arquivo e, com `abort_divergent`, recusa uma cópia editada. O texto gerado é armazenado (`nelcota.panel_migrations`) para baixar novamente byte por byte. A versão supera o maior número no banco, na pasta e entre exportações anteriores; a pasta vem de `NELCOTA_MIGRATIONS_DIR` ou da montagem `/migrations` no contêiner. O editor SQL fica de fora: pode executar qualquer coisa, inclusive DML, e separar alterações de esquema exigiria analisar o SQL.','**D68. English codebase, translated panel.** Code, identifiers, comments,\ntests, server messages (REST, auth and admin API errors), CLI output, the\nrecovery email, the README and these docs are English. Only the panel\ninterface is translated: Portuguese (pt-BR) and English, through typed\nper-area catalogs (`crates/admin/ui/src/lib/i18n/messages`) where the English\nobject is typed against the Portuguese one, so a missing key fails the type\ncheck. The panel picks the browser language on the first visit and remembers\nthe choice made in the account menu. Admin API errors carry `code` and\n`params` (`{"error", "code", "params"}`), so the panel shows them in the\nchosen language and falls back to the server\'s English text (raw Postgres\nerrors, for instance). Migrations V1–V6 keep their Portuguese file names and\ncomments: refinery checksums name and content, and editing them would make\nevery existing install refuse to start.':'**D68. Código-fonte em inglês, painel traduzido.** Código, identificadores, comentários, testes, mensagens do servidor (erros REST, de autenticação e da API administrativa), saída da CLI, e-mail de recuperação, README e esta documentação são em inglês. Apenas a interface do painel é traduzida: português (pt-BR) e inglês, por catálogos tipados por área (`crates/admin/ui/src/lib/i18n/messages`), nos quais o objeto em inglês é tipado a partir do português, então uma chave ausente falha na verificação de tipos. O painel escolhe o idioma do navegador na primeira visita e lembra a escolha do menu da conta. Erros da API administrativa contêm `code` e `params` (`{"error", "code", "params"}`), para o painel mostrá-los no idioma escolhido e usar o texto em inglês do servidor como alternativa (erros brutos do Postgres, por exemplo). Migrações V1–V6 mantêm nomes de arquivo e comentários em português: refinery calcula checksums do nome e conteúdo, e editá-los faria toda instalação existente se recusar a iniciar.',"**D69. Libraries instead of four hand-written pieces.** A review of what\nthe code reimplemented kept the deliberate ones (the SQL builder of D29, the\nOpenAPI of D30, the PostgREST-style parser, TypeScript generation, CSV,\nsecret generation, image sniffing) and replaced four:":`**D69. Bibliotecas em vez de quatro partes escritas à mão.** Uma revisão do que o código reimplementava manteve as partes deliberadas (construtor SQL de D29, OpenAPI de D30, parser no estilo PostgREST, geração TypeScript, CSV, geração de segredos, identificação de imagens) e substituiu quatro:`,"**Rate limit:** `governor`'s keyed GCRA instead of a fixed window. The budget\nrefills continuously, so a client can no longer spend almost twice the limit\nacross the turn of a minute, and `Retry-After` is the real wait. Still in\nmemory per process; only the `std` and `dashmap` features.":"**Limite de requisições:** GCRA por chave de `governor` em vez de janela fixa. O orçamento se recompõe continuamente, então um cliente não pode mais gastar quase o dobro do limite na virada do minuto, e `Retry-After` é a espera real. Ainda em memória por processo; apenas os recursos `std` e `dashmap`.","**Session cookie:** the `cookie` crate parses the `Cookie` header and builds\n`Set-Cookie` in one place, instead of `split(';')` and `format!`. No signing\nor encryption features: the value is an opaque token.":"**Cookie de sessão:** o crate `cookie` analisa o cabeçalho `Cookie` e constrói `Set-Cookie` em um lugar, em vez de `split(';')` e `format!`. Sem recursos de assinatura ou criptografia: o valor é um token opaco.","**Health probe:** `hyper-util`'s client instead of a hand-written HTTP/1.1\nrequest and response split; a chunked body no longer breaks it. hyper was\nalready in the tree through axum.":"**Sonda de saúde:** cliente de `hyper-util` em vez de requisição HTTP/1.1 e separação de resposta escritas à mão; um corpo em chunks não o quebra mais. hyper já estava na árvore via axum.","**Identifier quoting:** `postgres_protocol::escape::escape_identifier`, already\na dependency. String literals in generated DDL keep the hand-written `''`\ndoubling: `escape_literal` would emit ` E'...'` for backslashes and change the\ntext of panel-generated migrations.":"**Aspas de identificadores:** `postgres_protocol::escape::escape_identifier`, já uma dependência. Literais de string no DDL gerado mantêm a duplicação manual de `''`: `escape_literal` emitiria ` E'...'` para barras invertidas e mudaria o texto das migrações geradas pelo painel.","**D70. `or=`/`and=` as PostgREST logic trees.** The request's filters are\na tree (`Condition`): leaves are the existing filters and groups join their\nitems with OR/AND, optionally negated; the top level stays ANDed, so existing\nURLs mean the same. Each group renders as a parenthesized expression, so\nprecedence never depends on its surroundings, and leaves keep the D29 rules\n(catalog columns, quoted identifiers, values as parameters). Depth is capped at\n8 and a tree at 100 filters, which bounds the recursive parser on hostile\ninput. As in PostgREST, `or`/`and` are reserved query keys.":"**D70. `or=`/`and=` como árvores lógicas do PostgREST.** Os filtros da requisição formam uma árvore (`Condition`): folhas são os filtros existentes e grupos unem seus itens com OR/AND, opcionalmente negados; o nível superior continua combinado com AND, então URLs existentes mantêm o significado. Cada grupo é renderizado como expressão entre parênteses, para a precedência nunca depender do entorno, e folhas mantêm as regras D29 (colunas do catálogo, identificadores entre aspas, valores parametrizados). A profundidade é limitada a 8 e uma árvore a 100 filtros, limitando o parser recursivo em entradas hostis. Como no PostgREST, `or`/`and` são chaves reservadas de consulta.","**D71. Upsert through `Prefer: resolution` and `on_conflict`, as in\nPostgREST.** Each INSERT group (D33) gets `ON CONFLICT (key)`: `DO UPDATE SET`\nfor the columns the object sent, except the key, or `DO NOTHING`; a merge with\nnothing left to update falls back to `DO NOTHING`. The key is the primary key\nor `on_conflict`, whose columns are checked against the catalog; whether they\nform a unique key is left to Postgres, and its `42P10` and `21000` errors now\nmap to 400 instead of 500. RLS needs no special handling: Postgres applies the\nINSERT policy to the new row and the UPDATE policy to the existing one.":"**D71. Upsert por `Prefer: resolution` e `on_conflict`, como no PostgREST.** Cada grupo INSERT (D33) recebe `ON CONFLICT (key)`: `DO UPDATE SET` para as colunas enviadas pelo objeto, exceto a chave, ou `DO NOTHING`; uma mesclagem sem nada para atualizar usa `DO NOTHING`. A chave é a primária ou `on_conflict`, cujas colunas são verificadas no catálogo; decidir se formam chave única fica com o Postgres, e seus erros `42P10` e `21000` agora mapeiam para 400 em vez de 500. RLS não precisa de tratamento especial: o Postgres aplica a política INSERT à nova linha e a UPDATE à existente.","**D72. Relation embedding through foreign keys, one level, as correlated\nsubqueries.** `select=` accepts `[alias:]table[!hint](columns)`. The relation\ncomes only from the catalog's foreign keys inside the exposed schema, in\neither direction: this table's key gives an object (`to_json` of a subquery\nthat matches at most one row, since the key references a unique one), the\nother table's key gives an array (`json_agg`). Each embed is a subquery in the\nselect list, so it runs in the same transaction with the request's role and\nthe related table's RLS filters it like a direct read; there is no separate\npermission logic. Ambiguous links ask for a hint (column or constraint name);\nnesting and self-references are refused for now. The panel's parser keeps\nrefusing embeds (`parse_request`), the API uses\n`parse_request_with_relations`.":"**D72. Relacionamentos embutidos por chaves estrangeiras, um nível, como subconsultas correlacionadas.** `select=` aceita `[alias:]table[!hint](columns)`. O relacionamento vem apenas das chaves estrangeiras do catálogo dentro do esquema exposto, nas duas direções: a chave desta tabela dá um objeto (`to_json` de uma subconsulta que corresponde a no máximo uma linha, pois a chave referencia uma única), a chave da outra dá um array (`json_agg`). Cada relacionamento embutido é uma subconsulta na lista select, então executa na mesma transação com o papel da requisição e a RLS da tabela relacionada o filtra como uma leitura direta; não há lógica de permissão separada. Ligações ambíguas pedem uma indicação (coluna ou nome da restrição); aninhamento e autorreferências são recusados por enquanto. O parser do painel continua recusando relacionamentos embutidos (`parse_request`); a API usa `parse_request_with_relations`.","**D73. Nested embeds and per-embed filters, as in PostgREST.** An embed's\ncolumn list is a full `select`, so embeds nest, at most 4 levels (each level\nis one more correlated subquery per parent row; the cap bounds what a single\nURL can stack). Parameters prefixed with an embed's key (`items.qty=gt.1`,\n`orders.items.order=...`) go to that embed: filters and `or`/`and` trees join\nthe foreign key in the subquery's `WHERE`, and `order`/`limit`/`offset` page\nthe embedded array (refused on a single-row embed). They narrow the embedded\nrows only; the parent rows stay, with `null` or `[]`. `select` is parsed first,\nso the parameter order in the URL does not matter. Filters now carry their\ncolumn type, so the same SQL builder serves any row alias. Nested subqueries\nare aliased by their path (`_e0_1`) so a child never shadows its parent.\nSelf-references stay refused, and filtering parents by their embeds\n(PostgREST's `!inner`) is not implemented.":"**D73. Relacionamentos embutidos aninhados e filtros por relacionamento, como no PostgREST.** A lista de colunas de um relacionamento é um `select` completo, permitindo aninhamento de no máximo 4 níveis (cada nível é mais uma subconsulta correlacionada por linha pai; o teto limita o que uma única URL pode acumular). Parâmetros prefixados pela chave do relacionamento (`items.qty=gt.1`, `orders.items.order=...`) vão para ele: filtros e árvores `or`/`and` se juntam à chave estrangeira no `WHERE` da subconsulta, e `order`/`limit`/`offset` paginam o array embutido (recusados para linha única). Restringem apenas linhas embutidas; linhas pai permanecem, com `null` ou `[]`. `select` é analisado primeiro, então a ordem dos parâmetros na URL não importa. Filtros agora contêm o tipo da coluna, para o mesmo construtor SQL atender a qualquer alias de linha. Subconsultas aninhadas recebem aliases pelo caminho (`_e0_1`) para um filho nunca ocultar seu pai. Autorreferências continuam recusadas, e filtrar pais pelos relacionamentos embutidos (`!inner` do PostgREST) não está implementado.","**D74. PITR with pgBackRest, inside the project's Postgres container.**\npgBackRest instead of WAL-G: Alpine packages it (2.58), so the image stays\n`postgres:17-alpine` plus one `apk add`. WAL-G only ships glibc binaries, and\nmoving to a Debian image would change the libc and with it text collation,\nsilently invalidating the indexes of existing projects. The image is built\nlocally from `postgres/Dockerfile` (no second image to publish). Settings\ntravel as `PGBACKREST_*` variables from `pgbackrest.env` (mode 600) through\n`env_file` with `required: false`, so no config file has to be readable by the\ncontainer's postgres user and \"PITR on\" is just that file existing; archiving\nitself is `ALTER SYSTEM` (archive_mode, archive_command, `archive_timeout =\n60s`), which the profile's `-c` flags do not touch. Postgres gets a\nper-project `egress` network: the `internal` one has no route out, and nothing\ncan connect in through either. Base backups ride on the existing daily\n`backup --all` (full on Sundays, differential otherwise, two fulls kept). A\nrestore recreates the Postgres container, so its restart count tells a failed\nrecovery (a target past the archive makes Postgres exit) apart, and ends with\na full backup: the new timeline forks before any later backup on the old one,\nwhich pgBackRest would otherwise refuse to restore from.":'**D74. PITR com pgBackRest, dentro do contêiner Postgres do projeto.** pgBackRest em vez de WAL-G: Alpine o empacota (2.58), então a imagem permanece `postgres:17-alpine` mais um `apk add`. WAL-G só distribui binários glibc, e mudar para Debian alteraria a libc e, com ela, a ordenação de texto, invalidando silenciosamente os índices de projetos existentes. A imagem é construída localmente de `postgres/Dockerfile` (sem segunda imagem para publicar). Configurações trafegam como variáveis `PGBACKREST_*` de `pgbackrest.env` (modo 600) por `env_file` com `required: false`, então nenhum arquivo de configuração precisa ser legível pelo usuário postgres do contêiner e "PITR ativado" significa apenas esse arquivo existir; o arquivamento em si usa `ALTER SYSTEM` (archive_mode, archive_command, `archive_timeout = 60s`), sem interferência das opções `-c` do perfil. O Postgres recebe uma rede `egress` por projeto: a `internal` não tem rota de saída, e nada pode entrar por nenhuma delas. Backups-base usam o `backup --all` diário existente (completo aos domingos, diferencial nos demais dias, dois completos mantidos). Uma restauração recria o contêiner Postgres, para sua contagem de reinícios distinguir uma recuperação com falha (um alvo além do arquivo faz o Postgres encerrar), e termina com backup completo: a nova linha do tempo se ramifica antes de qualquer backup posterior na antiga, do qual o pgBackRest recusaria restaurar.','**D75. Hosts without Docker: one project, systemd units, apt packages.**\n`init --runtime systemd` (Debian/Ubuntu, as root) gets Postgres 17 and\npgBackRest from PGDG and Caddy from its repository: the versions match the\nDocker hosts and security updates come with `apt upgrade`. One project per\nmachine: N isolated projects would mean N clusters on N ports and N system\nusers, and that isolation is what Docker already gives. The runtime lives in\nthe registry (`"runtime"`, Docker when absent), and every operation goes\nthrough `Project`, which turns "start the app", "run this as postgres",\n"is Postgres healthy" into `docker compose` or `systemctl`/`runuser`/\n`journalctl`; `ops` and `pitr` no longer know which. The app runs a copy of\nthe binary (`/usr/local/lib/nelcota/nelcota`) so `upgrade` can swap it and\nkeep the previous one for the rollback, in a unit with `DynamicUser`,\n`ProtectSystem=strict`, no capabilities and only the loopback port. Commands\nthat need the app\'s configuration (`migrate`, `types`, `token`) run this\nbinary as a child process with the project\'s `.env`, rather than setting\nvariables in the CLI\'s own process. pgBackRest reads the same settings as on\nDocker, written as `/etc/pgbackrest/pgbackrest.conf` (archive_command runs\nunder the Postgres unit, which does not get the `.env`).':'**D75. Hosts sem Docker: um projeto, unidades systemd, pacotes apt.** `init --runtime systemd` (Debian/Ubuntu, como root) obtém Postgres 17 e pgBackRest do PGDG e Caddy de seu repositório: versões correspondem às dos hosts Docker e atualizações de segurança vêm com `apt upgrade`. Um projeto por máquina: N projetos isolados significariam N clusters em N portas e N usuários do sistema, e esse isolamento já é fornecido pelo Docker. O ambiente de execução fica no registro (`"runtime"`, Docker quando ausente), e toda operação passa por `Project`, que transforma "iniciar aplicativo", "executar como postgres", "Postgres está saudável" em `docker compose` ou `systemctl`/`runuser`/`journalctl`; `ops` e `pitr` não sabem mais qual é. O aplicativo executa uma cópia do binário (`/usr/local/lib/nelcota/nelcota`) para `upgrade` poder trocá-lo e manter o anterior para reversão, em uma unidade com `DynamicUser`, `ProtectSystem=strict`, sem capabilities e apenas porta loopback. Comandos que precisam da configuração do aplicativo (`migrate`, `types`, `token`) executam esse binário como processo filho com o `.env` do projeto, em vez de definir variáveis no próprio processo da CLI. pgBackRest lê as mesmas configurações do Docker, escritas como `/etc/pgbackrest/pgbackrest.conf` (archive_command executa sob a unidade Postgres, que não recebe o `.env`).',"**D76. The image is `ghcr.io/nelcota/nelcota-server`.** The name that\nmatches the repository, `ghcr.io/hanielcota/nelcota`, is a package from an\nearlier project (now NelcotaScreenShare) whose production still pulls its\n`latest` tag. Pushing there would overwrite that tag, and deleting it would\nbreak that deploy, so this project publishes under another name. The release\nimage is the released musl binaries copied into `scratch`\n(`deploy/release.Dockerfile`), linked to this repository by the\n`org.opencontainers.image.source` label.":"**D76. A imagem é `ghcr.io/nelcota/nelcota-server`.** O nome correspondente ao repositório, `ghcr.io/hanielcota/nelcota`, é um pacote de um projeto anterior (agora NelcotaScreenShare) cuja produção ainda usa a tag `latest`. Publicar lá sobrescreveria essa tag, e excluí-la quebraria a implantação, então este projeto publica sob outro nome. A imagem de publicação contém os binários musl publicados copiados para `scratch` (`deploy/release.Dockerfile`), vinculados a este repositório pelo rótulo `org.opencontainers.image.source`.",Storage:`Armazenamento`,"**D77. Metadata in Postgres under RLS, bytes in an object store.** A\n`storage` schema holds `storage.buckets` and `storage.objects` (bucket, name,\nowner `DEFAULT auth.uid()`, size, type, etag). Who may read, write or delete\na file is decided by RLS policies on `storage.objects`, written in plain SQL\nlike any other policy; the server never decides it. The bytes live behind the\n`object_store` crate (Apache Arrow) with two backends: the local disk (the\ndefault, nothing to configure after `nelcota up`) and any S3-compatible\nservice (recommended for production: R2, B2, AWS...). `object_store` is used\nwith `aws-base` + `ring`, never `aws-lc-rs`, for the same reason as D16. No\nbundled object server: Garage on a single node keeps the files on the same\ndisk as a plain directory would, for one more service to run, and MinIO's\ncommunity edition went into maintenance mode in 2025. The routes follow the\nshape of Supabase Storage (`/storage/v1/object/{bucket}/{path}`), without\npromising compatibility with its client; the route words (`public`, `sign`,\n`list`) cannot be bucket names.":"**D77. Metadados no Postgres sob RLS, bytes em armazenamento de objetos.** Um esquema `storage` contém `storage.buckets` e `storage.objects` (bucket, nome, proprietário `DEFAULT auth.uid()`, tamanho, tipo, etag). Quem pode ler, escrever ou excluir um arquivo é decidido por políticas RLS em `storage.objects`, escritas em SQL simples como qualquer política; o servidor nunca decide isso. Os bytes ficam por trás do crate `object_store` (Apache Arrow) com dois backends: disco local (padrão, sem configuração após `nelcota up`) e qualquer serviço compatível com S3 (recomendado para produção: R2, B2, AWS...). `object_store` é usado com `aws-base` + `ring`, nunca `aws-lc-rs`, pelo mesmo motivo de D16. Sem servidor de objetos embutido: Garage em um nó mantém arquivos no mesmo disco que um diretório simples, adicionando mais um serviço para executar, e a edição comunitária do MinIO entrou em manutenção em 2025. As rotas seguem o formato do Supabase Storage (`/storage/v1/object/{bucket}/{path}`), sem prometer compatibilidade com seu cliente; as palavras das rotas (`public`, `sign`, `list`) não podem ser nomes de buckets.","**D78. Uploads stream through the server; keys are versioned.** The client\nsends the file to Nelcota, which streams it to the store: one endpoint, the\nusual `Bearer`, no CORS on a second origin, and size, type and quota checked\nin the same flow. Before taking the bytes, a rolled-back `INSERT` under the\ncaller's role checks the policy, so a caller without permission cannot fill\nthe disk. The bytes go to `{bucket}/{version}` (a UUIDv7), not to the\nobject's name; only after the upload completes does a short transaction\ninsert or update the row under RLS. Holding no connection while bytes flow\nkeeps slow clients from draining the pool; versioned keys make an overwrite\natomic (readers see the old file or the new one, never half) and keep a\nfailed upload from clobbering anything. Deleting or replacing a file removes\nthe old bytes right after the commit: a delete means the file is gone, which\nalso means a database restore does not bring deleted files back. A periodic\ncollector removes bytes no row points to (left by a crash mid-upload) once\nthey are a day old, so it never races an upload in flight. A plain upload\nneeds only an `INSERT` policy; overwriting and deleting also need `SELECT`,\nas `UPDATE`/`DELETE` with a `WHERE` do in Postgres. Storage routes run\noutside the request timeout and the gzip layer.":"**D78. Uploads passam pelo servidor em streaming; chaves são versionadas.** O cliente envia o arquivo ao Nelcota, que o transmite ao armazenamento: um endpoint, o `Bearer` usual, sem CORS em segunda origem, com tamanho, tipo e cota verificados no mesmo fluxo. Antes de receber os bytes, um `INSERT` com rollback sob o papel do chamador verifica a política, então um chamador sem permissão não pode encher o disco. Os bytes vão para `{bucket}/{version}` (UUIDv7), e não para o nome do objeto; apenas após concluir o upload uma transação curta insere ou atualiza a linha sob RLS. Não manter conexão durante o fluxo de bytes impede clientes lentos de esgotar o pool; chaves versionadas tornam a substituição atômica (leitores veem o arquivo antigo ou o novo, nunca uma parte) e impedem um upload com falha de destruir algo. Excluir ou substituir remove os bytes antigos logo após o commit: excluir significa que o arquivo se foi, então uma restauração do banco não traz arquivos excluídos de volta. Um coletor periódico remove bytes sem referência de linha (deixados por falha no meio do upload) após um dia, para nunca disputar com upload em andamento. Um upload simples precisa apenas de política `INSERT`; substituir e excluir também precisam de `SELECT`, como `UPDATE`/`DELETE` com `WHERE` no Postgres. Rotas de armazenamento executam fora do timeout de requisição e da camada gzip.","**D79. User files are served as inert content.** Every object response\ncarries `X-Content-Type-Options: nosniff` and `Content-Security-Policy:\nsandbox`; only raster images, audio, video and plain text are served\n`inline`, everything else (HTML, SVG, PDF...) as an `attachment`. The type is\nsniffed from the first bytes, not taken from the client. Paths reject `..`,\nempty segments, control characters and over-long names, and are normalized\nto Unicode NFC. Signed URLs are short-lived JWTs signed with the project's\nkeys and bound to one bucket and path. On the S3 backend a download is a\n`302` to a presigned URL on the provider's domain; on disk the server\nstreams it with `Range` and `ETag`. `NELCOTA_STORAGE_PUBLIC_URL` can move\npublic files to their own origin (e.g. `files.shop.com`).":"**D79. Arquivos de usuários são servidos como conteúdo inerte.** Toda resposta de objeto inclui `X-Content-Type-Options: nosniff` e `Content-Security-Policy: sandbox`; apenas imagens rasterizadas, áudio, vídeo e texto simples são servidos como `inline`, todo o restante (HTML, SVG, PDF...) como `attachment`. O tipo é identificado pelos primeiros bytes, sem usar o valor do cliente. Caminhos rejeitam `..`, segmentos vazios, caracteres de controle e nomes longos demais e são normalizados para Unicode NFC. URLs assinadas são JWTs de curta duração assinados com as chaves do projeto e vinculados a um bucket e caminho. No backend S3, um download é `302` para URL pré-assinada no domínio do provedor; em disco, o servidor transmite com `Range` e `ETag`. `NELCOTA_STORAGE_PUBLIC_URL` pode mover arquivos públicos para uma origem própria (por exemplo `files.shop.com`).","**D80. Storage cannot take the database down.** On a single VPS the files and\nPostgres share a disk. Every upload has a size cap (per bucket, and a global\n`NELCOTA_STORAGE_MAX_FILE_SIZE`, 50 MiB by default); an optional total quota\ncovers all buckets; and on the disk backend an upload is refused when free\nspace would fall under `NELCOTA_STORAGE_MIN_FREE_BYTES` (1 GiB by default).\nIn-flight uploads reserve their capacity, and publication checks the resulting\ntotal under a database transaction lock across instances. Replacements credit\ntheir old logical size while reserving disk space for the new version.\nPer-user quotas are left to policies, which see the final row (with its\nsize) on insert. Image transformations and resumable (TUS) uploads stay out:\ndecoding untrusted images is a steady source of CVEs.":"**D80. O armazenamento não pode derrubar o banco.** Em uma VPS única, arquivos e Postgres compartilham disco. Todo upload tem teto de tamanho (por bucket e global `NELCOTA_STORAGE_MAX_FILE_SIZE`, 50 MiB por padrão); uma cota total opcional cobre todos os buckets; e no backend em disco um upload é recusado quando o espaço livre ficaria abaixo de `NELCOTA_STORAGE_MIN_FREE_BYTES` (1 GiB por padrão). Uploads em andamento reservam capacidade, e a publicação verifica o total resultante sob um bloqueio transacional do banco entre instâncias. Substituições descontam seu tamanho lógico anterior ao reservar espaço para a nova versão. Cotas por usuário ficam com as políticas, que veem a linha final (com tamanho) na inserção. Transformações de imagem e uploads retomáveis (TUS) ficam de fora: decodificar imagens não confiáveis é uma fonte constante de CVEs.","**D81. New projects store files on their disk; backups mirror them**\n(the shared backup mirror is superseded by D82).\n`nelcota init` writes `NELCOTA_STORAGE_BACKEND=disk`: on Docker the app\nmounts `projects/<name>/storage` (owned by the image's user 65532), on\nsystemd the unit's `StateDirectory`. Storage works right after `nelcota up`,\nand moving to S3 is two lines in `.env`. A file on the same disk as the\ndatabase is lost with it, so `backup --upload` also runs `aws s3 sync\n--delete` of that directory to `<bucket>/<project>/storage/`: keys never\nchange once written (D78), so each run only sends new files, and\n`restore --files` brings them back. Caddy stops compressing `/storage/*`,\nwhich would break byte ranges. Projects created before storage keep it off\nuntil they add the two lines and the volume (docs/storage.md).":"**D81. Novos projetos armazenam arquivos no disco; backups os espelham** (o espelho compartilhado de backup é substituído por D82). `nelcota init` escreve `NELCOTA_STORAGE_BACKEND=disk`: no Docker, o aplicativo monta `projects/<name>/storage` (pertencente ao usuário 65532 da imagem); no systemd, o `StateDirectory` da unidade. O armazenamento funciona logo após `nelcota up`, e mover para S3 exige duas linhas no `.env`. Um arquivo no mesmo disco do banco é perdido junto dele, então `backup --upload` também executa `aws s3 sync --delete` desse diretório para `<bucket>/<project>/storage/`: chaves nunca mudam após a escrita (D78), então cada execução só envia arquivos novos, e `restore --files` os traz de volta. O Caddy deixa de comprimir `/storage/*`, o que quebraria intervalos de bytes. Projetos criados antes do armazenamento o mantêm desativado até adicionar as duas linhas e o volume (docs/storage.md).","Panel and backup reliability":`Confiabilidade do painel e dos backups`,"**D82. Disk backups capture immutable files beside each dump.** A shared\nmirror loses old versions when later uploads replace or delete them, so it\ncannot restore the files referenced by a historical database dump. Each dump\nnow has its own `.files/` directory and SHA-256 manifest. An exported Postgres\nsnapshot and a SHARE lock on `storage.objects` keep the copied versions and\ndump metadata consistent. Upload files before publishing the dump; retain and\narchive the pair together. Restore validates the manifest before stopping the\napp and copies immutable versions before restoring the database. Older dumps\nremain usable for database-only restores (docs/backup.md).":"**D82. Backups de disco capturam arquivos imutáveis junto de cada dump.** Um espelho compartilhado perde versões antigas quando uploads posteriores as substituem ou excluem, então não pode restaurar arquivos referenciados por um dump histórico do banco. Cada dump agora tem seu próprio diretório `.files/` e manifesto SHA-256. Um snapshot exportado do Postgres e bloqueio SHARE em `storage.objects` mantêm as versões copiadas e metadados do dump consistentes. Envie os arquivos antes de publicar o dump; retenha e arquive o par junto. A restauração valida o manifesto antes de parar o aplicativo e copia versões imutáveis antes de restaurar o banco. Dumps antigos continuam utilizáveis para restaurações apenas do banco (docs/backup.md).","**D83. The panel validates wire contracts generated from Rust.** `ts-rs` and\n`schemars` export TypeScript and JSON Schema from the server DTOs; Ajv emits\nstandalone browser validators so the existing CSP needs no runtime code\ngeneration. Drift checks run in CI. Database cell values stay text or NULL\n(D48). Resource state and upload queues own cancellation, result ordering and\nthe captured upload destination, with unit and browser regression tests.":"**D83. O painel valida contratos de comunicação gerados do Rust.** `ts-rs` e `schemars` exportam TypeScript e JSON Schema dos DTOs do servidor; Ajv emite validadores independentes para o navegador, então a CSP existente não precisa de geração de código em tempo de execução. Verificações de divergência executam na CI. Valores de células do banco continuam texto ou NULL (D48). Estado de recursos e filas de upload cuidam de cancelamento, ordenação de resultados e destino capturado do upload, com testes unitários e de regressão no navegador.","**D84. SQL display limits bound memory without changing batch semantics.**\nDedicated editor connections (D47) allow at most four runs with a 30-second\nstatement timeout. The client retains up to 1000 rows per result, 8 MiB of\nvalues and 32 displayed results, while the server drains the remaining batch\nso later statements still execute. Dropping a request sends Postgres\ncancellation and closes its connection. DDL reports `applied` separately from\n`catalog_pending`: a failed refresh after COMMIT retries with backoff instead\nof asking the user to replay an already committed mutation.":"**D84. Limites de exibição SQL restringem memória sem alterar a semântica do lote.** Conexões dedicadas do editor (D47) permitem no máximo quatro execuções com timeout de instrução de 30 segundos. O cliente retém até 1000 linhas por resultado, 8 MiB de valores e 32 resultados exibidos, enquanto o servidor consome o restante do lote para instruções posteriores ainda executarem. Descartar uma requisição envia cancelamento ao Postgres e fecha sua conexão. DDL informa `applied` separado de `catalog_pending`: uma atualização com falha após COMMIT repete com espera progressiva em vez de pedir ao usuário para repetir uma mutação já confirmada.","**D85. Modules follow independent reasons for change.** Authentication shares\nsession/token operations and auth-role transactions independently of its HTTP\nhandlers. Panel route composition does not own cookies, response headers or\nasset serving. Storage operations accept a byte stream and explicit options\nand return typed results; the public routes and panel share the HTTP adapter.\nCLI lifecycle, backup sequencing, remote transport and version upgrades have\nseparate owners. The table editor's row module owns loading and write\nreconciliation while the page owns navigation and presentation. Existing\ntransaction, RLS and snapshot guarantees remain coordinated inside their\noperation modules (docs/architecture.md).":`**D85. Módulos seguem motivos independentes de mudança.** Autenticação compartilha operações de sessão/token e transações do papel de autenticação independentemente de seus handlers HTTP. A composição de rotas do painel não cuida de cookies, cabeçalhos de resposta ou entrega de assets. Operações de armazenamento aceitam stream de bytes e opções explícitas e retornam resultados tipados; rotas públicas e painel compartilham o adaptador HTTP. Ciclo de vida da CLI, sequência de backup, transporte remoto e atualizações de versão têm responsáveis separados. O módulo de linhas do editor de tabelas cuida de carregamento e reconciliação de escritas, enquanto a página cuida de navegação e apresentação. Garantias existentes de transação, RLS e snapshot continuam coordenadas dentro de seus módulos de operação (docs/architecture.md).`,"**D86. Operation interfaces own complete lifetimes.** Recovery and migration\nworkflows return data without HTTP extraction or response construction. Their\natomic database changes stay under one transaction owner. The SQL executor\nowns its connection, cancellation and display budgets behind one execution\nmethod; the route chooses the HTTP response. REST execution returns the JSON\nalready built by PostgreSQL and response metadata, preserving RLS and error\nordering. Catalog model, introspection and refresh workers remain internal to\nthe existing facade. Panel SQL and storage modules accept transport adapters\nand own cancellation, captured destinations and mutation refreshes. Native\nprovisioning and PITR configuration/process adapters are separate from restore\nsequencing, with no new deployment runtime or command contract.":`**D86. Interfaces de operação cuidam de ciclos de vida completos.** Fluxos de recuperação e migração retornam dados sem extração HTTP nem construção de respostas. Suas alterações atômicas no banco permanecem sob um único responsável pela transação. O executor SQL cuida de conexão, cancelamento e limites de exibição por um método de execução; a rota escolhe a resposta HTTP. A execução REST retorna JSON já construído pelo PostgreSQL e metadados de resposta, preservando RLS e ordem de erros. Modelo do catálogo, introspecção e workers de atualização permanecem internos à fachada existente. Módulos SQL e de armazenamento do painel aceitam adaptadores de transporte e cuidam de cancelamento, destinos capturados e atualizações após mutações. Provisionamento nativo e adaptadores de configuração/processos PITR são separados da sequência de restauração, sem novo ambiente de implantação ou contrato de comandos.`,"**D87. Feature ownership determines source location.** Panel pages, state,\nadapters, components and unit tests live with their feature. The shell and\nshared schema/presentation helpers have named locations; generated wire\ncontracts remain authoritative. Admin backend facades group table, policy and\naccount handlers and explicitly export their interface. Integration tests\nshare panel request helpers and keep feature scenarios under one admin suite.\nThis changes source navigation without introducing another runtime, crate\nlayer, HTTP contract or transaction owner (docs/architecture.md).":`**D87. A responsabilidade pelo recurso determina a localização do código.** Páginas, estado, adaptadores, componentes e testes unitários do painel ficam junto do recurso. A estrutura do aplicativo e as funções compartilhadas de esquema/apresentação têm locais nomeados; contratos gerados de comunicação continuam sendo a referência oficial. Fachadas administrativas do backend agrupam handlers de tabelas, políticas e contas e exportam explicitamente sua interface. Testes de integração compartilham funções auxiliares de requisição do painel e mantêm cenários de recursos em uma suíte administrativa. Isso muda a navegação do código sem introduzir outro ambiente de execução, camada de crates, contrato HTTP ou responsável por transações (docs/architecture.md).`,"**D88. Facades expose complete operations in the modular monolith.** The\nexisting capability crates and single binary remain the architecture. Bucket\nreads and mutations now have one storage owner shared by the public API and\npanel, with typed records and errors. HTTP adapters keep their existing wire\ncontracts and input normalization; PostgreSQL still enforces privileges, RLS\nand nonempty-bucket deletion through its foreign key. Panel account operations\nown validation, SQL and password/session transactions independently of HTTP.\nReuse the existing disk/S3 and mail adapters where implementations vary; add no\ngeneric repository, dependency container or extra crate layer. Integration\ntests exercise bucket policies through the operation interface and prove that\na failed session revocation rolls back the password change.":`**D88. Fachadas expõem operações completas no monólito modular.** Os crates de recursos existentes e o binário único permanecem como arquitetura. Leituras e mutações de buckets agora têm um único responsável no armazenamento, compartilhado pela API pública e pelo painel, com registros e erros tipados. Adaptadores HTTP mantêm seus contratos de comunicação e normalização de entradas; PostgreSQL ainda aplica privilégios, RLS e impede exclusão de buckets não vazios pela chave estrangeira. Operações de contas do painel cuidam de validação, SQL e transações de senha/sessão independentemente do HTTP. Reutilize os adaptadores existentes de disco/S3 e e-mail onde as implementações variam; não adicione repositório genérico, contêiner de dependências ou camada extra de crates. Testes de integração exercitam políticas de buckets pela interface de operações e comprovam que uma revogação de sessão com falha reverte a troca de senha.`,"Email links":`Links de e-mail`,'**D89. Signup confirmation and magic links reuse the recovery link.** Two\noptional pages, `NELCOTA_EMAIL_CONFIRMATION_URL` and `NELCOTA_MAGIC_LINK_URL`,\nneed the D66 SMTP and turn on one flow each; without them nothing changes.\nTheir tokens share `auth.one_time_tokens` (V9 widens the `kind` CHECK to\n`signup` and `magiclink`), the token in the URL fragment, the one email per\nminute per account and kind, and background sending. A token only works as\nthe kind it was issued for. With confirmation on, signup answers `201 {user}`\nwithout a session, and password sign-in answers `400 email_not_confirmed`\n(only after a correct password, so it reveals nothing) until a signup, magic\nor recovery link is opened; `POST /auth/v1/resend {type: "signup"}` sends a\nnew link to unconfirmed accounts only. Turning confirmation on in a project\nwith unconfirmed accounts holds them too: they confirm through `resend` or a\nmagic link, or the operator runs `UPDATE auth.users SET email_confirmed_at =\nnow()`. A magic link only signs in existing accounts: creating accounts from\nan unauthenticated email request would let anyone fill `auth.users` and\nsquat addresses before their owners sign up. Lifetimes: recovery 1 hour,\nconfirmation 24 hours, magic link 15 minutes (it signs in by itself). The\n`links` module owns the link lifecycle (token storage, email text, sending,\nsign-in by link); `recovery` keeps only the password change, `confirmation`\nthe signup policy and `verify` the routing by `type`.':'**D89. Confirmação de cadastro e links mágicos reutilizam o link de recuperação.** Duas páginas opcionais, `NELCOTA_EMAIL_CONFIRMATION_URL` e `NELCOTA_MAGIC_LINK_URL`, precisam do SMTP de D66 e ativam um fluxo cada; sem elas nada muda. Seus tokens compartilham `auth.one_time_tokens` (V9 amplia o CHECK `kind` para `signup` e `magiclink`), token no fragmento da URL, um e-mail por minuto por conta e tipo e envio em segundo plano. Um token só funciona como o tipo para o qual foi emitido. Com confirmação ativada, o cadastro responde `201 {user}` sem sessão, e o login por senha responde `400 email_not_confirmed` (apenas após senha correta, sem revelar nada) até abrir um link de cadastro, mágico ou de recuperação; `POST /auth/v1/resend {type: "signup"}` envia um novo link apenas para contas não confirmadas. Ativar confirmação em um projeto com contas não confirmadas também as bloqueia: confirmam por `resend` ou link mágico, ou o operador executa `UPDATE auth.users SET email_confirmed_at = now()`. Um link mágico só autentica contas existentes: criar contas a partir de solicitação de e-mail não autenticada permitiria encher `auth.users` e reservar endereços antes do cadastro dos proprietários. Validades: recuperação 1 hora, confirmação 24 horas, link mágico 15 minutos (autentica sozinho). O módulo `links` cuida do ciclo do link (armazenamento do token, texto do e-mail, envio, login por link); `recovery` mantém apenas a troca de senha, `confirmation` a política de cadastro e `verify` o encaminhamento por `type`.','**D90. Panel accounts count as confirmed.** An account the administrator\ncreates is marked confirmed at once: the operator vouches for the address,\nand with signup confirmation on it would otherwise be held until a magic\nlink or `resend`. The users page marks unconfirmed accounts and offers\n"Confirm email" for them (`POST /admin/api/users/{id}/confirm`, idempotent),\nwhich replaces the SQL `UPDATE` of D89 for projects that turn confirmation\non with older accounts. It sends no email: the panel has no mailer and an\ninvitation flow is a separate decision.':'**D90. Contas do painel são consideradas confirmadas.** Uma conta criada pelo administrador é marcada como confirmada imediatamente: o operador avaliza o endereço, e com confirmação de cadastro ativada ela ficaria bloqueada até um link mágico ou `resend`. A página de usuários marca contas não confirmadas e oferece "Confirmar e-mail" (`POST /admin/api/users/{id}/confirm`, idempotente), substituindo o `UPDATE` SQL de D89 para projetos que ativam confirmação com contas antigas. Não envia e-mail: o painel não tem serviço de envio e um fluxo de convites é uma decisão separada.',"Sign-in providers":`Provedores de login`,"**D91. OAuth/OIDC sign-in with PKCE on both legs, and verified-email\nlinking.** Google (OpenID Connect userinfo) and GitHub (REST profile plus its\nemail list, the only place that says an address is verified) sit behind one\n`Provider` type, each in its own module; another provider is another module.\nThe app starts at `GET /auth/v1/authorize` with its own S256 challenge;\nNelcota keeps the sign-in in `auth.flow_states` (V10) with a separate PKCE\nverifier toward the provider, redeems the provider's code server to server,\nand sends the person to `redirect_to?code=...`. The app trades that code and\nits verifier for a session at `POST /auth/v1/token?grant_type=pkce`, so a code\nread from a URL, a log or a `Referer` is useless alone; a code is tried once.\n`redirect_to` must sit under one of `NELCOTA_OAUTH_REDIRECT_URLS` (same origin,\npath below), so `/authorize` is no open redirect; the callback is\n`NELCOTA_API_URL/auth/v1/callback`. A provider account is identified by its\nown id (`auth.identities`, unique per provider), never by email. A first\nsign-in links an existing account only when the provider verified the email:\na confirmed account is linked as is; an unconfirmed one is taken over by the\nverified owner, losing the password, sessions and links someone else may have\nset up with the address (the pre-registration takeover); an unverified email\nthat matches an account is refused (`email_conflict`). New accounts get no\npassword and are confirmed when the provider verified the email. Refusals and\nprovider errors go back to the app as `?error=<code>`, and an unknown `state`\nis an error page, since there is no trusted place to return to. The HTTPS\nclient is the `reqwest` already in the tree for S3, on rustls with `ring`\n(D16), with a 10 s timeout, no redirects and bounded response bodies.":"**D91. Login OAuth/OIDC com PKCE nas duas etapas e vinculação por e-mail verificado.** Google (userinfo do OpenID Connect) e GitHub (perfil REST mais lista de e-mails, o único lugar que informa se um endereço foi verificado) ficam por trás de um tipo `Provider`, cada um em seu módulo; outro provedor é outro módulo. O aplicativo começa em `GET /auth/v1/authorize` com seu desafio S256; Nelcota mantém o login em `auth.flow_states` (V10) com um verificador PKCE separado para o provedor, resgata o código do provedor de servidor para servidor e envia a pessoa para `redirect_to?code=...`. O aplicativo troca esse código e seu verificador por sessão em `POST /auth/v1/token?grant_type=pkce`, então um código lido de URL, log ou `Referer` é inútil sozinho; um código é tentado uma vez. `redirect_to` deve estar sob uma das `NELCOTA_OAUTH_REDIRECT_URLS` (mesma origem, caminho abaixo), então `/authorize` não é um redirecionamento aberto; o callback é `NELCOTA_API_URL/auth/v1/callback`. Uma conta de provedor é identificada por seu ID (`auth.identities`, único por provedor), nunca pelo e-mail. Um primeiro login vincula uma conta existente apenas quando o provedor verificou o e-mail: uma conta confirmada é vinculada como está; uma não confirmada é assumida pelo proprietário verificado, perdendo senha, sessões e links que outra pessoa possa ter criado com o endereço (tomada de conta pré-cadastrada); um e-mail não verificado correspondente a uma conta é recusado (`email_conflict`). Novas contas não recebem senha e são confirmadas quando o provedor verificou o e-mail. Recusas e erros do provedor voltam ao aplicativo como `?error=<code>`, e um `state` desconhecido gera página de erro, pois não há destino confiável para retornar. O cliente HTTPS é o `reqwest` já presente na árvore para S3, sobre rustls com `ring` (D16), com timeout de 10 s, sem redirecionamentos e corpos de resposta limitados.",Panel:`Painel`,"**D92. Code gets syntax colours, the second exception to D55.** The SQL\neditor colours keywords, function calls, types, strings, numbers and\ncomments; table and column names keep the text colour. Colour there carries\nmeaning (it is how people read code) rather than decorating the page. The\npalette follows GitHub's light and dark syntax themes, a tested and\nreadable reference, as `--syntax-*` tokens next to the other theme colours.\nThe SQL grammar does not mark function calls, so a small view plugin tints an\nidentifier right before `(` and a built-in keyword glued to it (`count(`),\nbut not keywords that open a clause or a list (`in (`, `exists(`). Only the\nlazily loaded editor changes (D54); read-only SQL blocks stay plain.":"**D92. Código recebe cores de sintaxe, a segunda exceção a D55.** O editor SQL colore palavras-chave, chamadas de funções, tipos, strings, números e comentários; nomes de tabelas e colunas mantêm a cor do texto. A cor transmite significado (é como as pessoas leem código) em vez de decorar a página. A paleta segue os temas de sintaxe claro e escuro do GitHub, referência testada e legível, como tokens `--syntax-*` junto das outras cores de tema. A gramática SQL não marca chamadas de função, então um pequeno plugin de visualização colore um identificador imediatamente antes de `(` e uma palavra-chave embutida ligada a ele (`count(`), mas não palavras-chave que abrem uma cláusula ou lista (`in (`, `exists(`). Apenas o editor carregado sob demanda muda (D54); blocos SQL somente leitura continuam simples.",'**D93. Plain language first, technical on demand; the overview guides.**\nAccess rules read as what they mean for the app\'s users: a table is\nProtected, Locked (protection on, no rules) or Unprotected; grants become\n"Read only" or "Read and write" for Visitors and Signed-in users; a policy is\na sentence ("Each user only sees and changes their own rows") when it matches\na known shape (public or signed-in reading, owner by `auth.uid()`), and\n"Custom rule" with its SQL in view otherwise. A "Technical details" toggle,\nremembered per browser, brings back RLS, roles, grants and SQL. The overview\nopens with what needs action (unprotected and locked tables, each linked to\nits policies) and a next-steps list that is only ever ticked by the project\'s\nstate: a first table, every API table protected, a user, and a first sign-in\nthrough the API (`signed_in_users`), which means an app is connected. Counts\nshrink to one line. Navigation and the accent colour stay (D55, D63).':'**D93. Linguagem simples primeiro, técnica sob demanda; a visão geral orienta.** Regras de acesso são lidas pelo significado para os usuários do aplicativo: uma tabela é Protegida, Bloqueada (proteção ativada, sem regras) ou Desprotegida; grants viram "Somente leitura" ou "Leitura e escrita" para Visitantes e Usuários autenticados; uma política é uma frase ("Cada usuário só vê e altera suas próprias linhas") quando corresponde a um formato conhecido (leitura pública ou autenticada, proprietário por `auth.uid()`), e "Regra personalizada" com SQL visível nos demais casos. Um seletor "Detalhes técnicos", lembrado por navegador, traz de volta RLS, papéis, grants e SQL. A visão geral começa pelo que precisa de ação (tabelas desprotegidas e bloqueadas, cada uma ligada às políticas) e lista de próximos passos marcada apenas pelo estado do projeto: primeira tabela, todas as tabelas da API protegidas, um usuário e primeiro login pela API (`signed_in_users`), indicando aplicativo conectado. Contagens se reduzem a uma linha. Navegação e cor de destaque permanecem (D55, D63).','**D94. The SQL editor can run as a visitor or a signed-in user.** By default\nit still runs as the database owner, without RLS, which the toolbar shows as an\namber "Full access" notice. The notice is also the picker: "Visitor" runs as\n`anon`, and "Signed-in user..." runs as `authenticated` with the claims of a\nreal account chosen by email (`sub`, `email`), so `auth.uid()`, `auth.jwt()`,\ngrants and policies behave as they do for that person through the API. The\neditor\'s connection is dedicated to one run, so the executor sets the role and\n`request.jwt.claims` for the session before the SQL, as the API does per\nrequest. It is a way to test rules, not a security boundary: the administrator\ncan always run anything as the owner, and the SQL may even `RESET ROLE`. The\nchoice is not persisted, so a reload goes back to the owner.':'**D94. O editor SQL pode executar como visitante ou usuário autenticado.** Por padrão, ainda executa como proprietário do banco, sem RLS, indicado na barra de ferramentas pelo aviso âmbar "Acesso total". O aviso também é o seletor: "Visitante" executa como `anon`, e "Usuário autenticado..." executa como `authenticated` com as claims de uma conta real escolhida por e-mail (`sub`, `email`), então `auth.uid()`, `auth.jwt()`, grants e políticas se comportam como para essa pessoa pela API. A conexão do editor é dedicada a uma execução, então o executor define papel e `request.jwt.claims` para a sessão antes do SQL, como a API faz por requisição. É uma forma de testar regras, não um limite de segurança: o administrador sempre pode executar qualquer coisa como proprietário, e o SQL pode até executar `RESET ROLE`. A escolha não persiste, então recarregar retorna ao proprietário.',"Client SDK":`SDK do cliente`,"**D95. Nelcota ships its own TypeScript client, a thin layer over HTTP.**\n`@nelcota/client` lives in `sdk/typescript/` so its contract tests run in the\nsame CI against the real binary; it borrows no third-party BaaS client.\nEvery method is one HTTP request with no hidden cache, and access stays with\nRLS: the client never decides permissions. It has no runtime dependencies\n(only `fetch`, `URL`, Web Crypto, `AbortSignal`, Web Locks and\n`BroadcastChannel`), so it runs in browsers, Node 22+, Deno, Bun and edge\nruntimes, is ESM with subpath exports and side-effect free, and keeps the\nsupply chain to the TypeScript compiler. Results are values (`{ data, error }`)\ncarrying the server's `code` untouched; only programming mistakes throw.\nUntrusted input never becomes syntax: identifiers are validated, values in\n`or`/`and` groups and `in` lists are always quoted, storage paths are encoded\nper segment with `..` refused, and a `service_role` token in a browser is\nrefused because it bypasses RLS. Refresh is single-flight in a process and,\nin browsers, serialized across tabs with a Web Lock, because refresh rotation\nends a session whose token is reused (D23). Retries only cover idempotent\nrequests on 429/503 and honour `Retry-After`. Types come from\n`nelcota types`, which now also emits each table's `Relationships` so a\n`select` string can be typed down to its embeds. The server exposes\n`Retry-After`, `Preference-Applied` and `Last-Modified` through CORS so a\nbrowser can read them. The SDK follows its own semver and states the minimum\nserver version it needs.":"**D95. Nelcota distribui seu próprio cliente TypeScript, uma camada fina sobre HTTP.** `@nelcota/client` fica em `sdk/typescript/` para seus testes de contrato executarem na mesma CI com o binário real; não usa cliente BaaS de terceiros. Cada método é uma requisição HTTP sem cache oculto, e o acesso permanece com a RLS: o cliente nunca decide permissões. Não tem dependências de execução (apenas `fetch`, `URL`, Web Crypto, `AbortSignal`, Web Locks e `BroadcastChannel`), então executa em navegadores, Node 22+, Deno, Bun e ambientes de borda, é ESM com exportações por subcaminho e sem efeitos colaterais e limita a cadeia de dependências ao compilador TypeScript. Resultados são valores (`{ data, error }`) que contêm o `code` do servidor intacto; apenas erros de programação lançam exceções. Entrada não confiável nunca se torna sintaxe: identificadores são validados, valores de grupos `or`/`and` e listas `in` sempre ficam entre aspas, caminhos de armazenamento são codificados por segmento com `..` recusado e um token `service_role` no navegador é recusado porque ignora RLS. Há uma única renovação em andamento por processo e, nos navegadores, serialização entre abas por Web Lock, pois a rotação encerra uma sessão cujo token foi reutilizado (D23). Novas tentativas cobrem apenas requisições idempotentes em 429/503 e respeitam `Retry-After`. Tipos vêm de `nelcota types`, que agora também emite `Relationships` de cada tabela para tipar uma string `select` até seus relacionamentos embutidos. O servidor expõe `Retry-After`, `Preference-Applied` e `Last-Modified` por CORS para o navegador poder lê-los. O SDK segue seu próprio versionamento semântico e informa a versão mínima de servidor necessária.",Tooling:`Ferramentas`,'**D96. Tooling follows the newest stable releases.** The MSRV moves from\n1.88 (D19) to 1.99, the stable toolchain CI, the Docker image and the\nrelease build already use, so `cargo update` picks the newest crates\ninstead of the newest that build on an old compiler. TypeScript is 7, the\nnative compiler: the SDK and the panel\'s plain TypeScript projects check\nwith it. svelte-check still needs the TypeScript 6 compiler API (TS 7 has\nno stable JS API yet), so the panel keeps it as `typescript`, from\n`@typescript/typescript6`, while `tsc` comes from `typescript-7` and the\nscripts call it by path, since both packages ship a `tsc` binary. Drop the\nTS 6 package once svelte-check supports 7. Updates still wait seven days\nafter release (Dependabot cooldown), so "newest" means newest that has\nbeen out for a week.':'**D96. As ferramentas seguem as versões estáveis mais recentes.** A MSRV muda de 1.88 (D19) para 1.99, a versão estável que a CI, a imagem Docker e a compilação de publicação já usam, para `cargo update` escolher os crates mais recentes em vez dos mais recentes que compilam em um compilador antigo. TypeScript é 7, o compilador nativo: os projetos TypeScript simples do SDK e do painel o usam na verificação. svelte-check ainda precisa da API de compilador TypeScript 6 (TS 7 ainda não tem API JS estável), então o painel o mantém como `typescript`, de `@typescript/typescript6`, enquanto `tsc` vem de `typescript-7` e os scripts o chamam pelo caminho, pois ambos os pacotes distribuem um binário `tsc`. Remova o pacote TS 6 quando svelte-check suportar 7. Atualizações ainda aguardam sete dias após a publicação (intervalo de espera do Dependabot), então "mais recente" significa a versão mais recente disponível há uma semana.',"Connecting apps and access":`Conectar aplicativos e acesso`,"**D97. The panel connects apps and explains refusals.** The API page leads\nwith the SDK: install, a `database.ts` download generated by the same code as\n`nelcota types`, and examples typed for the chosen table. Three tools answer\n\"why can't my app see this?\": the table grid can be read as a visitor or a\nuser (the D94 executor's role and claims, in a rolled-back transaction,\nread-only); each bucket lists the `storage.objects` policies that name it (or\nno bucket at all) and adds new ones from five server-side templates, so no\nbrowser text becomes SQL and the panel recognizes them back in plain words;\nand the server records API calls answered with 401, 403 or 429 in a\n100-entry ring buffer for the policies page. That log is in memory on\npurpose: no write per refused request, nothing to retain or purge, and it is\nper process, which matches one panel per project. It keeps the path, not the\nquery string or token, and reads the role by verifying the token again only\nfor refused calls. The sign-in page is read-only because those settings come\nfrom the environment. Pages off the main path (policies, a bucket, sign-in)\nload on demand so the main chunk stays inside its 900 kB budget.":'**D97. O painel conecta aplicativos e explica recusas.** A página API começa com o SDK: instalação, download de `database.ts` gerado pelo mesmo código de `nelcota types` e exemplos tipados para a tabela escolhida. Três ferramentas respondem "por que meu aplicativo não vê isso?": a grade pode ser lida como visitante ou usuário (papel e claims do executor D94, em transação com rollback, somente leitura); cada bucket lista políticas de `storage.objects` que o nomeiam (ou que não nomeiam nenhum bucket) e adiciona novas a partir de cinco modelos no servidor, para nenhum texto do navegador se tornar SQL e o painel reconhecê-las em palavras simples; e o servidor registra chamadas da API respondidas com 401, 403 ou 429 em buffer circular de 100 entradas para a página de políticas. Esse log fica em memória intencionalmente: nenhuma escrita por requisição recusada, nada para reter ou remover e por processo, correspondendo a um painel por projeto. Mantém o caminho, sem query string ou token, e lê o papel verificando novamente o token apenas nas chamadas recusadas. A página de login é somente leitura porque as configurações vêm do ambiente. Páginas fora do caminho principal (políticas, bucket, login) carregam sob demanda para o pacote principal permanecer no orçamento de 900 kB.',"Panel redesign":`Redesign do painel`,"**D98. A dashboard look with real traffic, replacing D55's restraint and\nD63's sidebar.** The panel follows a reference dashboard the user maintains:\nits tokens (oklch page and card tones, a bright green for actions, a 0.75rem\nbase radius giving 26.4px cards), a three-column top bar with the pages as\nshort pills and an account chip, full-width pages with 32px gutters, 24px\ntitles inside and a large one on the overview, borderless cards, pill\nsearches and lighter tables. The overview mirrors the reference layout: one\nperiod selector for the page, the period's traffic as the headline with\nmeters, stat cards beside a chart, and three cards below (rows per table,\nrecently blocked calls, what needs attention). The charts need data over\ntime, so the server counts API requests per minute (refused, server errors,\na latency histogram for p95) for 24 hours in memory, alongside the D97 log:\nno write per request, gone on restart, which the overview says. As in the\nreference, requests are a green area and refused calls a grey one; a grey\nseries alone would fail a colour-vision check, so values stay reachable\nthrough the series filters, the tooltip, a keyboard crosshair (a slider for\nassistive technology) and a table view. The mascot and the syntax colours\n(D62, D92) stay; plain language first (D93) stays.":`**D98. Aparência de dashboard com tráfego real, substituindo a contenção de D55 e a barra lateral de D63.** O painel segue um dashboard de referência mantido pelo usuário: seus tokens (tons oklch de página e cartão, verde vivo para ações, raio-base de 0.75rem que produz cartões de 26.4px), barra superior de três colunas com páginas em botões arredondados curtos e indicador de conta, páginas de largura completa com margens de 32px, títulos internos de 24px e um grande na visão geral, cartões sem borda, buscas arredondadas e tabelas mais leves. A visão geral espelha o layout da referência: um seletor de período para a página, tráfego do período como destaque com medidores, cartões estatísticos ao lado do gráfico e três cartões abaixo (linhas por tabela, chamadas bloqueadas recentemente, o que precisa de atenção). Gráficos precisam de dados ao longo do tempo, então o servidor conta requisições da API por minuto (recusadas, erros de servidor, histograma de latência para p95) por 24 horas em memória, junto do log D97: nenhuma escrita por requisição, desaparece ao reiniciar, como a visão geral informa. Como na referência, requisições são uma área verde e recusas uma cinza; uma série cinza sozinha falharia em verificação de visão de cores, então valores continuam acessíveis por filtros de série, dica, cursor de teclado (controle deslizante para tecnologia assistiva) e visualização em tabela. A mascote e as cores de sintaxe (D62, D92) permanecem; linguagem simples primeiro (D93) permanece.`,"Later passes settled the rules new screens follow:":`Revisões posteriores definiram as regras seguidas por novas telas:`,'**Surfaces, darkest to lightest in dark mode:** page (graphite, a step\nlighter than the reference at the user\'s request), card (rounded-3xl),\nwell (rounded-2xl insets inside a card: code, tiles, rows, empty states),\nfield (inputs, a step above the well). In light mode the page is grey,\ncards and fields white, wells light grey. Boxes are filled, not outlined;\na dashed border marks only drop zones and "add" tiles, and a tinted fill\n(destructive or warning at 10%) marks danger and alerts.':`**Superfícies, da mais escura à mais clara no modo escuro:** página (grafite, um tom mais claro que a referência a pedido do usuário), cartão (rounded-3xl), área interna (rounded-2xl dentro do cartão: código, blocos, linhas, estados vazios), campo (entradas, um tom acima da área interna). No modo claro, a página é cinza, cartões e campos brancos, áreas internas cinza-claro. Caixas são preenchidas, sem contorno; borda tracejada marca apenas áreas de arraste e blocos de "adicionar", e preenchimento com tom (destrutivo ou aviso a 10%) marca perigo e alertas.`,"**Top bar:** a project chip (mascot, project, environment, a dot for\nwhether the server answers) and the account chip balance the six centred\npills; search is a round button. Tables, SQL and Migrations share the\nDatabase pill, with tabs between them inside.":`**Barra superior:** indicador do projeto (mascote, projeto, ambiente, ponto informando se o servidor responde) e indicador de conta equilibram os seis botões arredondados centrais; a busca é um botão redondo. Tabelas, SQL e Migrações compartilham o botão Banco de dados, com abas entre elas dentro das páginas.`,"**Page grid:** pages cap at 1440px. Figures lead pages that have them, on\nthe same tracks as the columns below; side columns are 24rem. Grids start\nat the container's width, so nothing scrolls sideways on phones.":`**Grade da página:** páginas têm largura máxima de 1440px. Números abrem páginas que os possuem, nas mesmas faixas das colunas abaixo; colunas laterais têm 24rem. Grades começam pela largura do contêiner, para nada rolar lateralmente em celulares.`,"**Contrast:** text tones are checked against every surface in both themes\n(4.5:1 or more for body text), not eyeballed.":`**Contraste:** tons de texto são verificados contra toda superfície nos dois temas (4.5:1 ou mais para texto de corpo), sem depender de estimativa visual.`,"Established libraries for protocols and panel infrastructure":`Bibliotecas consolidadas para os protocolos e a infraestrutura do painel`,"The panel uses TanStack Query for concurrent read deduplication and optional\nfreshness windows. Explicit reloads still fetch from the server. Mutations\ninvalidate reads; session changes clear both cached and pending results, and\ncallers receive independent clones so editing a row cannot edit shared data.\nTanStack Table owns row selection and column visibility using stable primary\nkeys; the existing keyboard editing, server ordering and permissions remain\npart of the grid.":`O painel usa TanStack Query para compartilhar leituras simultâneas e permitir janelas opcionais de validade dos dados. Recargas explícitas continuam consultando o servidor. Alterações invalidam as leituras; trocas de sessão limpam os resultados em cache e os pendentes, e cada chamada recebe uma cópia independente para que editar uma linha não altere dados compartilhados. TanStack Table gerencia a seleção de linhas e a visibilidade das colunas usando chaves primárias estáveis; a edição por teclado, a ordenação no servidor e as permissões existentes continuam fazendo parte da grade.`,"Uppy and XHRUpload handle raw-body storage uploads and progress. Automatic\nretries are disabled because a failed connection can follow an already committed\nupload. Destination snapshots and conflict decisions stay in the upload queue.\nShiki replaces regular-expression highlighting with lazy-loaded language\ngrammars and its JavaScript engine. Tokens remain escaped Svelte text; no\nruntime `eval`, WebAssembly or Node APIs are needed in the browser.":"Uppy e XHRUpload cuidam dos uploads de arquivos com corpo bruto e do progresso. As tentativas automáticas estão desativadas porque a conexão pode falhar depois que o upload já foi salvo. O destino capturado no início e as decisões sobre conflitos continuam na fila de uploads. Shiki substitui o realce por expressões regulares por gramáticas carregadas sob demanda e seu mecanismo JavaScript. Os tokens continuam como texto escapado pelo Svelte; o navegador dispensa `eval` em execução, WebAssembly e APIs do Node.","Scalar renders the anonymous OpenAPI catalog in a same-origin frame, isolating\nits styles and hash navigation from the panel. Its assets are included in the\nRust binary; external fonts, telemetry, the agent and request proxy are disabled.\nOnly that reference document permits same-origin framing. The rest of the panel\nkeeps its frame restrictions. Scalar is loaded only when the reference is opened.":`Scalar apresenta o catálogo OpenAPI anônimo em um frame da mesma origem, isolando seus estilos e a navegação por fragmentos do painel. Seus arquivos estão incluídos no binário Rust; fontes externas, telemetria, o agente e o proxy de requisições ficam desativados. Somente esse documento de referência permite frames da mesma origem. O restante do painel mantém suas restrições de frames. Scalar só é carregado quando a referência é aberta.`,"The Rust oauth2 library builds authorization URLs, S256 PKCE and token exchanges;\nopenidconnect parses Google's typed user-info claims. Both use the existing\nbounded reqwest transport, without adding a second HTTP stack. Nelcota retains\nits one-time state, account linking and session policies. These dependencies\ndo not add a JavaScript server: Rust serves the compiled panel and backend.":`A biblioteca Rust oauth2 monta URLs de autorização, PKCE S256 e trocas de tokens; openidconnect interpreta as informações tipadas do usuário fornecidas pelo Google. Ambas usam o transporte reqwest existente com respostas limitadas, sem adicionar outra pilha HTTP. Nelcota mantém suas políticas de estado de uso único, vinculação de contas e sessões. Essas dependências dispensam um servidor JavaScript: Rust serve o painel compilado e o backend.`,"**D99. Client conversions preserve Postgres value identity.** JSON numbers\nremain numeric when conversion preserves their decimal value. The TypeScript\nSDK keeps unsafe integers and decimals that would lose digits as strings,\nincluding nested JSON values and RPC results. Generated numeric types that\ncan exceed JavaScript precision use `number | string`, so callers must handle\nboth forms and can reuse exact values in filters and writes. This preserves\nthe existing HTTP protocol and needs no runtime dependency or JSON reviver\nsource support. PostgreSQL array elements can be null even in NOT NULL columns;\ngenerated scalar and enum arrays therefore use `(T | null)[]`. Column\nnullability remains separate. Regenerate schema types after updating the SDK.":"**D99. Conversões do cliente preservam a identidade dos valores do Postgres.** Números JSON continuam numéricos quando a conversão preserva o valor decimal. O SDK TypeScript mantém como strings os inteiros fora da faixa segura e decimais que perderiam dígitos, inclusive em valores JSON aninhados e resultados de RPC. Tipos numéricos gerados que podem exceder a precisão do JavaScript usam `number | string`, para que o código trate ambas as formas e reutilize os valores exatos em filtros e escritas. Isso preserva o protocolo HTTP existente e não exige dependência de runtime nem suporte ao texto original no reviver de JSON. Elementos de arrays PostgreSQL podem ser nulos mesmo em colunas NOT NULL; por isso arrays escalares e de enums gerados usam `(T | null)[]`. A nulabilidade da coluna continua separada. Gere novamente os tipos do esquema após atualizar o SDK.","**D100. Panel database work has bounded budgets and indexed storage pages.**\nTable previews reuse one admin connection and roll back the caller's role before\nreading owner metadata. Small-table counts probe at most 10,001 rows with a\n250 ms statement timeout. When a table outgrows its small estimate, its total\nbecomes unknown until statistics provide a larger estimate.":`**D100. O trabalho de banco do painel tem limites definidos e páginas de storage indexadas.** As prévias de tabelas reutilizam uma conexão administrativa e revertem o papel do chamador antes de ler os metadados como dono. As contagens de tabelas pequenas examinam no máximo 10.001 linhas com limite de 250 ms por comando. Quando uma tabela cresce além da estimativa pequena, seu total fica desconhecido até que as estatísticas forneçam uma estimativa maior.`,"Table exports use two dedicated connection slots shared by all panel sessions,\nwith a 30-second statement timeout and a two-minute response lifetime. Dropping\na response cancels its query. Completion checks the deadline directly and\narbitrates atomically with interruption, so a delayed watchdog cannot report a\nlate export as complete. Admission stays occupied during bounded cancellation.":`As exportações de tabelas usam duas vagas de conexões dedicadas, compartilhadas por todas as sessões do painel, com limite de 30 segundos por comando e duração de dois minutos para a resposta. Descartar uma resposta cancela sua consulta. A conclusão verifica o prazo diretamente e disputa atomicamente com a interrupção, para que um watchdog atrasado não informe que uma exportação fora do prazo está completa. A vaga continua ocupada durante o cancelamento com prazo limitado.`,"Storage directory pages seek through a generated parent-path byte key and skip\neach returned folder's subtree. Immediate files use an ordered generated\nscope-fingerprint/name index; exact bucket and parent checks reject collisions.\nEvery seek remains subject to the caller's object RLS. Listing transactions\ndisable bitmap scans locally to favor ordered seeks before statistics catch up.\nThe pure key helpers allow public execution to preserve custom SQL writers;\ntheir generated values convey no additional access privileges.":`As páginas de diretórios do storage buscam por uma chave de bytes gerada a partir do caminho pai e pulam a subárvore de cada pasta retornada. Os arquivos diretamente na pasta usam um índice ordenado por hash de escopo gerado e nome; verificações exatas de bucket e caminho pai rejeitam colisões. Cada busca continua sujeita ao RLS de objetos do chamador. As transações de listagem desabilitam varreduras por bitmap localmente para favorecer buscas ordenadas antes que as estatísticas sejam atualizadas. As funções puras de chave permitem execução pública para preservar os escritores SQL customizados; seus valores gerados não concedem privilégios adicionais de acesso.`,"V14 indexes the stable creation-time/ID user order. V15 computes stored directory\nkeys and scope fingerprints and builds their indexes under the migration lock.\nLarge installations need time for this one-time metadata rewrite. Upgrade tests\nverify original rows, schema objects, policies and files, including legacy SQL\npaths whose multibyte names exceed the HTTP byte limit.":`A V14 indexa a ordenação estável de usuários por data de criação e ID. A V15 calcula chaves de diretório e hashes de escopo armazenados e cria seus índices sob o lock de migração. Instalações grandes precisam de tempo para essa reescrita única dos metadados. Os testes de upgrade verificam linhas originais, objetos de esquema, políticas e arquivos, incluindo caminhos SQL antigos cujos nomes multibyte excedem o limite de bytes do HTTP.`,"**D101. Updates use a separately enrolled native control plane.** The same\nbinary runs an unprivileged HTTP/UI role and a restricted root IPC worker, on a\nmanagement origin independent of project traffic. Project/SSO/service-role\ncredentials grant no host authority; root-owned enrollment binds operator scope\nto a project incarnation. Only official, ready, digested and attested stable\nartifacts are eligible. The deployment capability owns typed receipts, shared\nhost leases and durable transitions; CLI adapters own runtime effects and the\nadmin crate owns HTTP/embedded UI. Both public-traffic commit and restarting a\nrestored version are irreversible data boundaries. Candidate routes/background\neffects stay gated by an operation identity. Production installation starts\ndisabled until exact-binary VPS fault/offsite evidence passes. See\nthe repository-only operating guide at `docs/panel-updates.md` and G03 at\n`docs/goals/panel-updates-and-recovery.md`. These are not registered panel guides.":"**D101. Atualizações usam um plano de controle nativo autorizado separadamente.** O mesmo binário executa uma função HTTP/UI sem privilégios e um worker IPC root restrito, em uma origem de gestão independente do tráfego dos projetos. Credenciais de projeto/SSO/service-role não concedem autoridade sobre o host; a autorização pertencente a root vincula o escopo do operador à identidade de uma instância de projeto. Apenas artefatos oficiais, prontos, com digest e atestação, de versões estáveis são elegíveis. A capacidade de deployment é dona de recibos tipados, leases compartilhados do host e transições duráveis; adaptadores CLI cuidam dos efeitos do runtime e admin do HTTP/UI incorporado. Confirmar tráfego público e reiniciar uma versão restaurada são fronteiras irreversíveis dos dados. Rotas/efeitos em segundo plano do candidato ficam bloqueados pela identidade da operação. A instalação em produção começa desativada até a evidência de falhas/recuperação externa em VPS com o binário exato passar. Veja o guia exclusivo do repositório em `docs/panel-updates.md` e G03 em `docs/goals/panel-updates-and-recovery.md`. Eles não são guias registrados do painel.","Known pending items":`Pendências conhecidas`,"Filtering parent rows by their embeds (`!inner`) and self-referencing embeds.":"Filtrar linhas pai pelos relacionamentos embutidos (`!inner`) e relacionamentos autorreferentes.","`nelcota.com/install` should redirect to\n`https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh`.":"`nelcota.com/install` deve redirecionar para `https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh`."},pt={Deploy:`Implantação`,"Provision PostgreSQL, the Rust app and Caddy for HTTPS on a VPS. You need\na supported Linux host, administrative access, DNS and open ports 80/443.\nUse an explicitly selected published CLI/image version; source-only features\nrequire their own release and acceptance. Node is not required.":`Provisione PostgreSQL, o app Rust e Caddy para HTTPS em uma VPS. Você precisa de Linux suportado, acesso administrativo, DNS e portas 80/443 abertas. Escolha explicitamente uma versão publicada do CLI/imagem; recursos exclusivos da fonte exigem publicação e validação próprias. Node não é necessário.`,"First create a DNS **A** record for the domain pointing at the VPS IP. Caddy\nissues the certificate on its own on the first request. After starting\neverything, `up` polls `https://<domain>/health` for up to a minute; if the\npublic URL does not answer, it lists what to check (DNS, firewall, Caddy logs)\nand exits non-zero. Local hosts (`--local`) skip this check.":"Primeiro crie um registro DNS **A** para o domínio apontando para o IP da VPS. O Caddy emite o certificado automaticamente na primeira requisição. Após iniciar tudo, `up` consulta `https://<domain>/health` por até um minuto; se a URL pública não responder, lista o que verificar (DNS, firewall, logs do Caddy) e termina com código diferente de zero. Hosts locais (`--local`) pulam essa verificação.","Without `curl | sh`: download `nelcota-<architecture>` and\n`nelcota-<architecture>.sha256` from the releases page, run `sha256sum -c` and\ncopy it to `/usr/local/bin`. The [script](../scripts/install.sh) does just\nthat.":"Sem `curl | sh`: baixe `nelcota-<architecture>` e `nelcota-<architecture>.sha256` da página de versões, execute `sha256sum -c` e copie para `/usr/local/bin`. O [script](../scripts/install.sh) faz exatamente isso.","The built-in database connector uses private-network `NoTls`; an `sslmode`\nURL is not a TLS connector. Keep database ports private. Production secrets\nshould be stable/private; do not use dev credentials or service tokens in apps.":"O conector nativo usa `NoTls` em rede privada; uma URL com `sslmode` não é um conector TLS. Mantenha portas do banco privadas. Segredos de produção devem ser estáveis/privados; não use credenciais de desenvolvimento ou tokens de serviço em aplicativos.","Host and projects":`Host e projetos`,"A VPS can hold **several projects**, each one isolated: its own Postgres,\nusers, JWT keys, panel and backups. A single project is simply a host with one\nproject.":`Uma VPS pode hospedar **vários projetos**, cada um isolado: seu próprio Postgres, usuários, chaves JWT, painel e backups. Um único projeto é simplesmente um host com um projeto.`,"Only Caddy publishes ports. Each project's Postgres sits on its own\n`internal: true` network; apps talk to Caddy over the `nelcota_edge` network.\nPostgres also joins an `egress` network of its own, outbound only, to\narchive WAL to S3 when PITR is on.":"Apenas o Caddy publica portas. O Postgres de cada projeto fica em sua própria rede `internal: true`; os aplicativos se comunicam com o Caddy pela rede `nelcota_edge`. O Postgres também participa de uma rede `egress` própria, apenas de saída, para arquivar WAL no S3 quando PITR está ativado.","One Postgres per project, not a shared one: Postgres roles (`anon`,\n`authenticated`, `authenticator`...) apply to the whole server, and separate\nservers keep the physical isolation and a per-project `pg_dump` for leaving.":"Um Postgres por projeto, sem compartilhamento: os papéis do Postgres (`anon`, `authenticated`, `authenticator`...) valem para todo o servidor, e servidores separados mantêm o isolamento físico e um `pg_dump` por projeto para permitir a saída.","Own domain or subdomain":`Domínio próprio ou subdomínio`,"The project name comes from the domain (`api.shop.com` → `shop`), or from\n`--project`. It shows up in the panel's project switcher and in the commands'\n`-p`.":"O nome do projeto vem do domínio (`api.shop.com` → `shop`) ou de `--project`. Ele aparece no seletor de projetos do painel e em `-p` nos comandos.","Arguments are validated before provisioning. A package, filesystem or service\nfailure during provisioning can still leave files/services behind; inspect the\nreported stage before retrying.":`Os argumentos são validados antes do provisionamento. Uma falha de pacote, filesystem ou serviço durante o provisionamento ainda pode deixar arquivos/serviços; inspecione a etapa indicada antes de repetir.`,"`init` flags":"Opções de `init`",Flag:`Opção`,"What it does":`O que faz`,"project name (default: derived from the domain)":`nome do projeto (padrão: derivado do domínio)`,"saves the host's base domain: `--project shop` becomes `shop.<base>`":"salva o domínio-base do host: `--project shop` se torna `shop.<base>`","local host without a public domain (`https://<project>.localhost`, internal certificate); only when the host is created":"host local sem domínio público (`https://<project>.localhost`, certificado interno); apenas na criação do host","panel login mode when the host is created (default `shared`)":"modo de login do painel na criação do host (padrão `shared`)","administrator email (default `admin@<domain>`)":"e-mail do administrador (padrão `admin@<domain>`)","asks no questions (defaults and flags only)":`não faz perguntas (apenas padrões e opções)`,"app image (default `ghcr.io/nelcota/nelcota-server`, or `NELCOTA_IMAGE`)":"imagem do aplicativo (padrão `ghcr.io/nelcota/nelcota-server` ou `NELCOTA_IMAGE`)","image tag (default: the CLI's version)":`tag da imagem (padrão: versão da CLI)`,"Postgres profile (default: by the RAM split across the projects)":`perfil do Postgres (padrão: conforme a RAM dividida entre os projetos)`,"backup bucket, written to `host.env` (all four or none; region defaults to `us-east-1`). Without them, an interactive `init` asks, reading the secret key without echo":"bucket de backup, escrito em `host.env` (as quatro opções ou nenhuma; região padrão `us-east-1`). Sem elas, um `init` interativo pergunta, lendo a chave secreta sem exibi-la","how projects run (only when the host is created; see below)":`como os projetos executam (apenas na criação do host; veja abaixo)`,"configures `ufw` (SSH, 80 and 443)":"configura `ufw` (SSH, 80 e 443)","skips the Docker, ports, RAM and DNS checks":`pula verificações de Docker, portas, RAM e DNS`,Commands:`Comandos`,"With a single project, `-p` is optional. With several, commands that act on a\nproject ask for `-p <name>`.":"Com um único projeto, `-p` é opcional. Com vários, comandos que atuam sobre um projeto exigem `-p <name>`.",Command:`Comando`,"lists projects, state and version":`lista projetos, estado e versão`,"starts every project and Caddy (`-p` for just one), then checks public HTTPS":"inicia todos os projetos e o Caddy (`-p` para apenas um), depois verifica o HTTPS público","app and Postgres health, last backup age, version and free disk":`saúde do aplicativo e do Postgres, idade do último backup, versão e espaço livre em disco`,"checks Docker, Caddy/ports 80 and 443, free disk, DNS, the backup cron, a backup younger than 26 h per project, S3 and service health; exits non-zero on any problem":`verifica Docker, Caddy/portas 80 e 443, espaço livre, DNS, cron de backup, um backup com menos de 26 h por projeto, S3 e saúde dos serviços; termina com código diferente de zero em qualquer problema`,"project logs / the shared proxy's logs":`logs do projeto / logs do proxy compartilhado`,"stops (`--volumes` DELETES the data after a confirmation, `--yes` skips it; Docker only)":"para (`--volumes` EXCLUI os dados após confirmação, `--yes` a dispensa; apenas Docker)","applies `projects/shop/migrations/V<n>__<name>.sql`":"aplica `projects/shop/migrations/V<n>__<name>.sql`","TypeScript (default) or Rust types of the schema":`tipos TypeScript (padrão) ou Rust do esquema`,"service JWT (**bypasses RLS**)":`JWT de serviço (**ignora RLS**)`,"dump into `backups/`, uploaded to S3 when `host.env` has a bucket ([backup.md](backup.md))":"dump em `backups/`, enviado para S3 quando `host.env` tem um bucket ([backup.md](backup.md))","restores a dump, after a safety backup of the current state":`restaura um dump, após um backup de segurança do estado atual`,"point-in-time recovery with WAL archived to S3 ([backup.md](backup.md#pitr-point-in-time-recovery))":`recuperação para um ponto no tempo com WAL arquivado em S3 ([backup.md](backup.md#pitr-point-in-time-recovery))`,"upgrades with a backup and automatic rollback (`--dry-run` shows current → target; downgrades need `--allow-downgrade`)":"atualiza com backup e reversão automática (`--dry-run` mostra atual → alvo; retrocessos exigem `--allow-downgrade`)","final backup in `archive/` (starting Postgres if needed; `--no-backup` skips it), removes containers, data and the Caddy site":"backup final em `archive/` (iniciando Postgres se necessário; `--no-backup` o dispensa), remove contêineres, dados e o site Caddy","panel login: single or per project":`login do painel: único ou por projeto`,"new panel password (`-p` with per-project login)":"nova senha do painel (`-p` com login por projeto)","On a host, `migrate`, `types` and `token` run inside the project's `app`\ncontainer, which is what can reach Postgres. Outside a host, they use\n`NELCOTA_DATABASE_URL`.":"Em um host, `migrate`, `types` e `token` executam dentro do contêiner `app` do projeto, que é quem consegue alcançar o Postgres. Fora de um host, usam `NELCOTA_DATABASE_URL`.","Without Docker (systemd)":`Sem Docker (systemd)`,"On a small VPS that will only ever hold one project, Nelcota can skip Docker:":`Em uma VPS pequena que terá apenas um projeto, o Nelcota pode dispensar o Docker:`,"As root on Debian or Ubuntu, `init` installs Postgres 17 and pgBackRest from\nthe PostgreSQL project's apt repository (PGDG) and Caddy from its own, then:":"Como root no Debian ou Ubuntu, `init` instala Postgres 17 e pgBackRest do repositório apt do projeto PostgreSQL (PGDG) e Caddy de seu próprio repositório, depois:",What:`O quê`,Where:`Onde`,"Postgres profile (by RAM)":`Perfil do Postgres (por RAM)`,"The app":`O aplicativo`,"`nelcota-<name>.service`, running `/usr/local/lib/nelcota/nelcota serve` on `127.0.0.1:8000` with the project's `.env`":"`nelcota-<name>.service`, executando `/usr/local/lib/nelcota/nelcota serve` em `127.0.0.1:8000` com o `.env` do projeto",Caddy:`Caddy`,"the `caddy` service, `/etc/caddy/Caddyfile` generated from the registry":"o serviço `caddy`, `/etc/caddy/Caddyfile` gerado a partir do registro","PITR settings":`Configurações PITR`,"`/etc/pgbackrest/pgbackrest.conf` (with `pitr enable`)":"`/etc/pgbackrest/pgbackrest.conf` (com `pitr enable`)","Install AWS CLI v2 on the host before using offsite dump/file backups.\nNative package provisioning installs Postgres, pgBackRest and Caddy, not AWS CLI.":`Instale AWS CLI v2 no host antes de usar backups externos de dumps/arquivos. O provisionamento nativo instala Postgres, pgBackRest e Caddy, não AWS CLI.`,"Every command works the same way (`up`, `down`, `status`, `logs`, `migrate`,\n`backup`, `restore`, `pitr`, `upgrade`, `remove`); they drive `systemctl`,\n`journalctl` and `runuser -u postgres` instead of `docker compose`.":"Todos os comandos funcionam da mesma forma (`up`, `down`, `status`, `logs`, `migrate`, `backup`, `restore`, `pitr`, `upgrade`, `remove`); usam `systemctl`, `journalctl` e `runuser -u postgres` em vez de `docker compose`.","The app's unit runs as a throwaway user (`DynamicUser`) with no write\naccess to the system (`ProtectSystem=strict`) and no capabilities.":"A unidade do aplicativo executa como um usuário temporário (`DynamicUser`), sem acesso de escrita ao sistema (`ProtectSystem=strict`) e sem capabilities.","`upgrade` swaps the binary the unit runs for the one you are running (so\ninstall the new version first: `NELCOTA_VERSION=x.y.z install.sh`), keeps the\nprevious one and, if the app does not become healthy, puts it back and\nrestores the pre-upgrade backup.":"`upgrade` troca o binário executado pela unidade pelo que você está executando (portanto, instale primeiro a nova versão: `NELCOTA_VERSION=x.y.z install.sh`), mantém o anterior e, se o aplicativo não ficar saudável, coloca o anterior de volta e restaura o backup anterior à atualização.","`remove` takes the final backup, then deletes the unit and the Postgres\ncluster with its data (`pg_dropcluster`).":"`remove` faz o backup final, depois exclui a unidade e o cluster Postgres com seus dados (`pg_dropcluster`).","`down --volumes` is Docker-only.":"`down --volumes` funciona apenas com Docker.","Panel login":`Login do painel`,"**Single** (default): one email and password for every panel on the host.\nSigning in to one panel and switching projects with the switcher does not ask\nfor the password again.":`**Único** (padrão): um e-mail e uma senha para todos os painéis do host. Ao entrar em um painel e trocar de projeto pelo seletor, a senha não é pedida novamente.`,"**Per project**: each panel has its own credentials; the switcher just takes\nyou to the other panel, which asks for its own login.":`**Por projeto**: cada painel tem suas próprias credenciais; o seletor apenas leva ao outro painel, que pede seu próprio login.`,"Security details in [panel.md](panel.md).":`Detalhes de segurança em [panel.md](panel.md).`,"What the first `init` does":"O que o primeiro `init` faz","**Checks** Docker and the compose plugin (a user outside the `docker`\ngroup is told to use sudo or `usermod -aG docker $USER`), free ports 80/443\n(in use = error, with how to find the process; `--skip-checks` continues\nanyway), RAM and the domain's DNS.":"**Verifica** Docker e o plugin compose (um usuário fora do grupo `docker` recebe a orientação de usar sudo ou `usermod -aG docker $USER`), portas 80/443 livres (em uso = erro, com orientação para encontrar o processo; `--skip-checks` continua mesmo assim), RAM e DNS do domínio.","**Generates** the host secrets: admin credentials (password shown **once**;\n`host.env` keeps only the argon2id hash) and the single sign-on secret.":"**Gera** os segredos do host: credenciais de administrador (senha exibida **uma vez**; `host.env` guarda apenas o hash argon2id) e o segredo de login único.","**Backup:** asks for the S3-compatible destination (or use `--s3-*`) and,\nas root, installs the daily cron job for every project (03:00, keeps 7).\nThe job uploads whenever `host.env` has a bucket, so S3 can be added later.":"**Backup:** pergunta o destino compatível com S3 (ou use `--s3-*`) e, como root, instala a tarefa cron diária para todos os projetos (03:00, mantém 7). A tarefa faz upload sempre que `host.env` tem um bucket, então S3 pode ser adicionado depois.","**Machine:** with `--firewall`, configures `ufw` (SSH, 80 and 443).":"**Máquina:** com `--firewall`, configura `ufw` (SSH, 80 e 443).","Each later `init` only creates the project: its own secrets (Postgres,\n`authenticator`, Ed25519 key), a Postgres profile from the RAM split between\nprojects, and the Caddy site (reloaded without taking the others down).":"Cada `init` posterior cria apenas o projeto: seus próprios segredos (Postgres, `authenticator`, chave Ed25519), um perfil Postgres conforme a RAM dividida entre projetos e o site Caddy (recarregado sem parar os outros).","Project capacity depends on queries, data, hashing, uploads and PostgreSQL\nworking sets. Select a profile, measure your workload and monitor headroom.\nThe benchmark guide records specific fixtures; it does not establish a\nprojects-per-GB guarantee.":`A capacidade de projetos depende de consultas, dados, hashing, uploads e conjuntos de trabalho do PostgreSQL. Escolha um perfil, meça sua carga e monitore a margem disponível. O guia de benchmark registra fixtures específicas; não garante projetos por GB.`,Migrations:`Migrações`,"Plain SQL in `projects/<name>/migrations/`, named `V1__create_tables.sql`,\n`V2__indexes.sql`... Each file runs in a transaction. Tracking lives in\n`nelcota.user_migrations` (version, name, date, checksum): if an already\napplied file is edited, `migrate` refuses. After applying, the API reloads the\ncatalog on its own.":"SQL simples em `projects/<name>/migrations/`, com nomes `V1__create_tables.sql`, `V2__indexes.sql`... Cada arquivo executa em uma transação. O acompanhamento fica em `nelcota.user_migrations` (versão, nome, data, checksum): se um arquivo já aplicado for editado, `migrate` recusa. Após aplicar, a API recarrega o catálogo automaticamente.","Changes made in the panel":`Alterações feitas no painel`,'Tables, columns and policies created in the panel go straight to the project\'s\ndatabase, but they do not exist in any other environment (staging, another\nmachine, a fresh database) until they become a file. The panel records each\none and lists the pending ones under **Migrations**; "Generate migration"\ndownloads `V<n>__<name>.sql` with them and already registers it as applied in\nthis database, with the same checksum `migrate` computes. Put the file in\n`migrations/` and commit it: nothing runs again here, and `migrate` applies it\nin the other environments.':'Tabelas, colunas e políticas criadas no painel vão direto para o banco do projeto, mas não existem em outro ambiente (staging, outra máquina, banco novo) até se tornarem um arquivo. O painel registra cada alteração e lista as pendentes em **Migrações**; "Gerar migração" baixa `V<n>__<name>.sql` com elas e já a registra como aplicada neste banco, com o mesmo checksum calculado por `migrate`. Coloque o arquivo em `migrations/` e faça commit: nada executa novamente aqui, e `migrate` o aplica nos outros ambientes.',"The chosen number goes past everything in the database and in the folder (the\ncontainer reads `./migrations`, mounted at `/migrations`), so a file not yet\napplied is never overtaken. Outside the container, point to the folder with\n`NELCOTA_MIGRATIONS_DIR`. What you run in the SQL editor is not recorded: copy\nthat SQL into a migration by hand.":"O número escolhido fica além de tudo no banco e na pasta (o contêiner lê `./migrations`, montado em `/migrations`), então um arquivo ainda não aplicado nunca é ultrapassado. Fora do contêiner, indique a pasta com `NELCOTA_MIGRATIONS_DIR`. O que você executa no editor SQL não é registrado: copie esse SQL manualmente para uma migração.",Upgrade:`Atualização`,"`nelcota -p shop upgrade` makes the target image available before changing the\nrunning project. It then puts that project's Caddy site in maintenance (HTTP\n503 with `Retry-After`), stops the app to drain existing requests, and captures\nthe database and disk files together. Only then does it change\n`NELCOTA_VERSION` in `.env`, start the new version and wait for its healthcheck.":"`nelcota -p shop upgrade` disponibiliza a imagem-alvo antes de alterar o projeto em execução. Depois coloca o site Caddy desse projeto em manutenção (HTTP 503 com `Retry-After`), para o aplicativo para concluir requisições existentes e captura o banco e os arquivos de disco juntos. Só então altera `NELCOTA_VERSION` em `.env`, inicia a nova versão e aguarda sua verificação de saúde.","If the new version does not become healthy, the CLI restores the previous\nversion, database and paired disk snapshot before reopening traffic. If backup\ncreation fails, it restarts the unchanged previous version. A failed or\ninterrupted recovery leaves the maintenance gate closed; after fixing the\ncause, `nelcota -p shop up` checks health and reopens it. Other projects keep\nserving traffic; `upgrade --all` upgrades one at a time, keeps going when one\nproject fails (it was rolled back) and lists the failures at the end.":"Se a nova versão não ficar saudável, a CLI restaura a versão anterior, o banco e o snapshot de disco correspondente antes de reabrir o tráfego. Se a criação do backup falhar, reinicia a versão anterior sem alterações. Uma recuperação que falhe ou seja interrompida mantém o bloqueio de manutenção fechado; após corrigir a causa, `nelcota -p shop up` verifica a saúde e o reabre. Os outros projetos continuam atendendo tráfego; `upgrade --all` atualiza um por vez, continua quando um projeto falha (ele foi revertido) e lista as falhas ao final.","Without `--version`, the target is the CLI's own version. The CLI compares it\nwith the project's `NELCOTA_VERSION` first:":"Sem `--version`, o alvo é a versão da própria CLI. A CLI a compara primeiro com `NELCOTA_VERSION` do projeto:","same version: nothing to do (`--reinstall` redeploys it anyway, e.g. a rebuilt\nbinary on a systemd host);":"mesma versão: nada a fazer (`--reinstall` a reimplanta mesmo assim, por exemplo, um binário recompilado em um host systemd);","older target: refused, because the older app does not know the newer\nmigrations. When the CLI itself is the older one, reinstall it\n(`curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh`); to go back on purpose, pass\n`--allow-downgrade`;":"alvo mais antigo: recusado, pois o aplicativo antigo não conhece as migrações mais recentes. Quando a própria CLI é a antiga, reinstale-a (`curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh`); para voltar intencionalmente, passe `--allow-downgrade`;","`--dry-run` prints `current → target` for each project and changes nothing.":"`--dry-run` mostra `current → target` para cada projeto sem alterar nada.","Local development":`Desenvolvimento local`,"The development secrets (panel and Postgres passwords, JWT key) live in\n`.nelcota/dev.env`, readable only by you; the startup banner says where they\nare instead of printing them. `nelcota token service-role --days 30` issues a\n`service_role` token for that environment.":"Os segredos de desenvolvimento (senhas do painel e do Postgres, chave JWT) ficam em `.nelcota/dev.env`, legível apenas por você; a mensagem de inicialização diz onde estão em vez de exibi-los. `nelcota token service-role --days 30` emite um token `service_role` para esse ambiente.","`--db-port <port>` moves the development Postgres to another local port. The\nnew port is saved in `.nelcota/dev.env`; it gets its own container and data,\nand the old container is left as it was.":"`--db-port <port>` move o Postgres de desenvolvimento para outra porta local. A nova porta é salva em `.nelcota/dev.env`; recebe seu próprio contêiner e dados, e o contêiner antigo permanece como estava.","To test the full deploy locally (several projects, Caddy, HTTPS with an\ninternal certificate): `nelcota init --local --project shop` and open\n`https://shop.localhost/admin/`.":"Para testar a implantação completa localmente (vários projetos, Caddy, HTTPS com certificado interno): `nelcota init --local --project shop` e abra `https://shop.localhost/admin/`.","Acceptance test":`Teste de aceitação`,"Last local run (2026-10-06, Windows 11 + Docker Desktop, cached images): **two\nprojects with HTTPS in 28 s**. Also passing: migrate (idempotent), signup and\nRLS through Caddy, isolation between projects (one project's JWT is not valid\non the other; one project's tables do not exist on the other), single sign-on\nbetween panels with a single-use token, switching to per-project login and\nback, `types`, backup → write → restore, automatic upgrade rollback without\naffecting the other project, and project removal with a backup in `archive/`.":"Última execução local (2026-10-06, Windows 11 + Docker Desktop, imagens em cache): **dois projetos com HTTPS em 28 s**. Também passaram: migrate (idempotente), cadastro e RLS pelo Caddy, isolamento entre projetos (o JWT de um projeto não é válido no outro; as tabelas de um projeto não existem no outro), login único entre painéis com token de uso único, troca para login por projeto e volta, `types`, backup → escrita → restauração, reversão automática de atualização sem afetar o outro projeto e remoção de projeto com backup em `archive/`.","This dated local run is historical evidence. It does not validate a current\nVPS, public DNS/TLS, the native systemd runtime or controlled updates. Published\nreleases now exist; run acceptance on your target host/version before relying\non production behavior.":`Essa execução local datada é evidência histórica. Ela não valida uma VPS atual, DNS/TLS público, runtime systemd nativo ou atualizações controladas. Versões publicadas já existem; execute a validação no host/versão alvo antes de confiar no comportamento em produção.`,"Optional host management":`Gerenciamento opcional do host`,"The Unreleased controller can provision and manage isolated Docker projects\nafter explicit SSH enrollment. Approve an official image, domain scope and VPS\naddresses before enabling creation; inspect operation reviews and retain\nrecovery access. See `docs/host-management.md` for supported layouts and\nproduction acceptance.":"O controlador ainda não lançado pode provisionar e gerenciar projetos Docker isolados após cadastro explícito por SSH. Aprove uma imagem oficial, o escopo de domínios e os endereços da VPS antes de habilitar a criação; examine as revisões das operações e mantenha acesso de recuperação. Consulte `docs/host-management.md` para layouts aceitos e aceitação em produção.","Native PostgreSQL uses the local `17/main` cluster on port 5432. A differently\nconfigured `17/main`, or another PostgreSQL cluster reserving 5432, is rejected\nbefore packages or new host/project configuration are written, including with\n`--skip-checks`. Other ports are not selected by native database commands. Native\nadministrative clients explicitly select this cluster and local socket;\nambient `PGCLUSTER`, `PGHOST`, `PGHOSTADDR`, `PGPORT` or service settings cannot\nredirect a backup, restore or credential update to a different database.":"O PostgreSQL nativo usa o cluster local `17/main` na porta 5432. Um `17/main`\nconfigurado de outra forma, ou outro cluster PostgreSQL reservando a porta 5432,\né rejeitado antes de instalar pacotes ou escrever a nova configuração do host\nou projeto, inclusive com `--skip-checks`. Comandos nativos de banco de dados\nnão selecionam outras portas. Os clientes administrativos nativos selecionam\nexplicitamente esse cluster e o socket local; configurações herdadas de\n`PGCLUSTER`, `PGHOST`, `PGHOSTADDR`, `PGPORT` ou de serviços não podem redirecionar\num backup, uma restauração ou uma atualização de credencial para outro banco de dados.","One project per machine: a second `init` is refused, including from another\ndirectory and with `--skip-checks`. A machine-wide lease serializes native\ninit/removal; `/var/lib/nelcota-native/owner.json` keeps the host-directory\nclaim across interrupted commands. Only a completely successful `remove`\nreleases it. Do not delete this record to bypass an interrupted installation:\ninspect and recover the original host over SSH. Legacy installations without\na record are adopted only when their existing unit points unambiguously to\nthe selected host's absolute `.env` path; conflicting or incomplete state\nrequires explicit recovery. For multiple projects, use Docker.":"Um projeto por máquina: um segundo `init` é recusado, inclusive a partir de outro\ndiretório e com `--skip-checks`. Uma trava de máquina serializa\ninit/remoção; `/var/lib/nelcota-native/owner.json` mantém a propriedade do diretório\ndo host entre comandos interrompidos. Somente um `remove` concluído com sucesso\na libera. Não exclua esse registro para contornar uma instalação interrompida:\ninspecione e recupere o host original por SSH. Instalações anteriores sem\nregistro só são reconhecidas quando sua unit existente aponta sem ambiguidade para\no caminho absoluto do `.env` do host selecionado; estado conflitante ou incompleto\nexige recuperação explícita. Para vários projetos, use Docker."},mt={"Leaving Nelcota (no lock-in)":`Sair do Nelcota sem dependência da plataforma`,"Export your schema, policies, identities and files to another backend. You need\nowner access, PostgreSQL tools and a verified destination. Database metadata is\nSQL; file bytes and deployment secrets must be exported separately. Completion\ntime depends on dataset size and destination compatibility.":`Exporte schema, políticas, identidades e arquivos para outro backend. Você precisa de acesso de proprietário, ferramentas PostgreSQL e destino verificado. Metadados do banco são SQL; bytes dos arquivos e segredos do deploy precisam ser exportados separadamente. O tempo depende do tamanho dos dados e da compatibilidade do destino.`,"For the Docker commands below, enter `projects/<name>/` inside your host folder\nso Compose selects that project. Systemd hosts use native PostgreSQL tools.\nKeep dumps, user/password-hash exports, file mappings and configuration private.":"Para os comandos Docker abaixo, entre em `projects/<name>/` na pasta do host para Compose selecionar esse projeto. Hosts systemd usam ferramentas PostgreSQL nativas. Mantenha dumps, exportações de usuários/hashes de senha, mapeamentos de arquivos e configuração privados.","1. The whole database (schema, data, policies, functions, users)":`1. O banco inteiro (schema, dados, políticas, funções e usuários)`,"The roles `anon`, `authenticated`, `service_role`, `authenticator` and\n`nelcota_auth` are global and not part of `pg_dump`. Create them on the target\nfirst (the file `migrations/V1__roles_e_auth.sql` does that and is idempotent)\nor use `pg_restore --no-acl` if you will not use them.":"Os papéis `anon`, `authenticated`, `service_role`, `authenticator` e `nelcota_auth` são globais e não fazem parte do `pg_dump`. Crie-os primeiro no destino (o arquivo `migrations/V1__roles_e_auth.sql` faz isso de forma idempotente) ou use `pg_restore --no-acl` se não for utilizá-los.","2. Just the users (with their hashes)":`2. Só os usuários, com seus hashes`,"`encrypted_password` uses the standard PHC argon2id format\n(`$argon2id$v=19$m=19456,t=2,p=1$...`). Any argon2 library verifies these\nhashes without conversion: users **do not need to change their passwords**.\nDetails in [schema-auth.md](schema-auth.md).":"`encrypted_password` usa o formato PHC padrão do argon2id (`$argon2id$v=19$m=19456,t=2,p=1$...`). Qualquer biblioteca argon2 verifica esses hashes sem conversão: os usuários **não precisam trocar suas senhas**. Detalhes em [schema-auth.md](schema-auth.md).","3. The JWTs":`3. Os JWTs`,"The format is in [jwt-and-roles.md](jwt-and-roles.md). To switch auth\nproviders without rewriting the policies, the new provider only has to issue\ntokens with `role` and `sub`. The `auth.uid()`/`auth.jwt()` functions stay the\nsame.":"O formato está em [jwt-and-roles.md](jwt-and-roles.md). Para trocar de provedor de autenticação sem reescrever as políticas, o novo provedor só precisa emitir tokens com `role` e `sub`. As funções `auth.uid()`/`auth.jwt()` continuam iguais.","4. The files":`4. Os arquivos`,"`storage.objects` is part of the dump above. The bytes are plain files in\n`projects/<name>/storage/` (disk) or objects in your own bucket (S3), stored\nas `<bucket>/<version>`. The name of each one:":"`storage.objects` faz parte do dump acima. Os bytes são arquivos comuns em `projects/<name>/storage/` (disco) ou objetos no seu próprio bucket (S3), armazenados como `<bucket>/<version>`. O nome de cada arquivo:","5. What stays behind":`5. O que fica para trás`,"Only the `nelcota` binary: the automatic REST API and the panel. Without\nNelcota, Postgres keeps serving exactly the same data with the same policies,\nand you can point PostgREST, Hasura or your own backend at it.":"Apenas o binário `nelcota`: a API REST automática e o painel. Sem o Nelcota, o Postgres continua servindo exatamente os mesmos dados com as mesmas políticas, e você pode conectar PostgREST, Hasura ou seu próprio backend a ele."},ht={"Nelcota REST API":`API REST do Nelcota`,"API generated from the Postgres schema. Authorization: RLS. Requests without a token use `anon`. For a signed-in user or your backend, send `Authorization: Bearer <jwt>`.":"API gerada a partir do esquema do Postgres. Autorização: RLS. Requisições sem token usam `anon`. Para um usuário logado ou seu backend, envie `Authorization: Bearer <jwt>`.","Postgres type: {}":`Tipo Postgres: {}`,"return=representation | return=minimal; count=exact; on POST, resolution=merge-duplicates | resolution=ignore-duplicates (upsert)":`return=representation | return=minimal; count=exact; em POST, resolution=merge-duplicates | resolution=ignore-duplicates (upsert)`,"Filter: eq, neq, gt, gte, lt, lte, like, ilike, in, is (e.g. eq.value, in.(a,b), not.is.null)":`Filtro: eq, neq, gt, gte, lt, lte, like, ilike, in, is (por exemplo eq.value, in.(a,b), not.is.null)`,"Group of filters joined with {}: ({logic}=(col.op.value,...)); nests with and(...)/or(...), negate with not.{logic}":`Grupo de filtros combinados com {}: ({logic}=(col.op.value,...)); aninha com and(...)/or(...), nega com not.{logic}`,"Columns: `col1,col2` or `*`; embed related rows through foreign keys: `customers(name)`, `items(*)`, `alias:table!fk_column(...)`, nested: `orders(id,items(*))`; filter, order and page embedded rows with `items.qty=gt.1`, `items.order=qty.desc`, `items.limit=5`":"Colunas: `col1,col2` ou `*`; inclua linhas relacionadas por chaves estrangeiras: `customers(name)`, `items(*)`, `alias:table!fk_column(...)`, aninhadas: `orders(id,items(*))`; filtre, ordene e pagine linhas embutidas com `items.qty=gt.1`, `items.order=qty.desc`, `items.limit=5`","col.asc|desc[.nullsfirst|nullslast],...":`col.asc|desc[.nullsfirst|nullslast],...`,"Visible rows (RLS)":`Linhas visíveis (RLS)`,"Upsert key: col1,col2 (a unique constraint); defaults to the primary key. Needs Prefer: resolution=...":`Chave do upsert: col1,col2 (uma restrição única); usa a chave primária por padrão. Exige Prefer: resolution=...`,"Created (body only with return=representation)":`Criado (corpo apenas com return=representation)`,"Updated (return=representation)":`Atualizado (return=representation)`,Updated:`Atualizado`,"Deleted (return=representation)":`Excluído (return=representation)`,Deleted:`Excluído`,Result:`Resultado`},gt={Panel:`Painel`,"At `https://<project-domain>/admin/`. Its own login, separate from end users:\nthe email and password generated by the first `nelcota init` (the password is\nshown only once).":"Em `https://<project-domain>/admin/`. Tem login próprio, separado dos usuários finais: o e-mail e a senha gerados pelo primeiro `nelcota init` (a senha é exibida apenas uma vez).","The panel is available in **Portuguese and English**. On the first visit it\nfollows the browser language (any Portuguese locale gets Portuguese, anything\nelse English); the choice in the account menu (Language) is remembered in that\nbrowser. Server messages and error texts are English; the panel shows errors\nin the chosen language by their error code.":`O painel está disponível em **português e inglês**. Na primeira visita, segue o idioma do navegador (qualquer variante de português recebe português; os demais idiomas recebem inglês); a escolha no menu da conta (Idioma) é lembrada nesse navegador. Mensagens do servidor e textos de erro são em inglês; o painel mostra os erros no idioma escolhido pelo código do erro.`,Prerequisites:`Pré-requisitos`,"Use an initialized project with panel credentials and access to its API origin.\nThe project administrator can run privileged SQL; this is not an end-user token\nor an enrolled update-operator login. This reference describes current source.":`Use um projeto inicializado com credenciais do painel e acesso à origem da API. O administrador do projeto pode executar SQL privilegiado; essa identidade não é um token de usuário nem um login de operador de atualizações autorizado. Esta referência descreve a fonte atual.`,"Several projects":`Vários projetos`,'Each project has its own panel, on its own domain, showing only its data. At\nthe top left, next to the mascot, the **project switcher** (current project name) lists\nthe other projects on the host and leads to "All projects": name, domain,\nstate (up / down), version and a button to open each panel.':`Cada projeto tem seu próprio painel, em seu domínio, mostrando apenas seus dados. No canto superior esquerdo, junto da mascote, o **seletor de projetos** (nome do projeto atual) lista os outros projetos do host e leva a "Todos os projetos": nome, domínio, estado (ativo / parado), versão e um botão para abrir cada painel.`,"With **single sign-on** (default), switching projects in the switcher does not\nask for a password. With **per-project login** (`nelcota panel-login\nper-project`), the switcher just takes you to the other panel, which asks for\nits own login. The login screen always shows which project the panel belongs\nto.":"Com **login único** (padrão), trocar de projeto no seletor não pede senha. Com **login por projeto** (`nelcota panel-login per-project`), o seletor apenas leva ao outro painel, que pede seu próprio login. A tela de login sempre mostra a qual projeto o painel pertence.","How single sign-on works":`Como funciona o login único`,"Cookies do not cross different domains (`api.shop.com` → `api.blog.com`), so\nthe origin panel performs a *handoff*:":"Cookies não atravessam domínios diferentes (`api.shop.com` → `api.blog.com`), então o painel de origem faz uma *transferência*:",'The admin, already signed in to the shop\'s panel, picks "blog" in the\nswitcher.':`O administrador, já autenticado no painel da loja, escolhe "blog" no seletor.`,"The shop's panel issues a token for the blog: an HS256 JWT signed with the\nhost's shared secret, `aud` = blog, valid for 60 s, unique `jti`.":"O painel da loja emite um token para o blog: um JWT HS256 assinado com o segredo compartilhado do host, `aud` = blog, válido por 60 s, com `jti` único.","The browser opens `https://<blog>/admin/#sso=<token>`. The token travels in\nthe URL **fragment**, which does not show up in server logs or the\n`Referer`.":"O navegador abre `https://<blog>/admin/#sso=<token>`. O token viaja no **fragmento** da URL, que não aparece nos logs do servidor nem no `Referer`.","The blog's panel validates signature, audience, validity and the admin\nemail, refuses already-used tokens and creates its own session. The token\nleaves the URL immediately.":`O painel do blog valida assinatura, destinatário, validade e e-mail do administrador, recusa tokens já usados e cria sua própria sessão. O token sai da URL imediatamente.`,"With per-project login there is no shared secret: the handoff does not exist,\nand each panel only accepts its own credentials.":`Com login por projeto não há segredo compartilhado: a transferência não existe, e cada painel aceita apenas suas próprias credenciais.`,"An SPA in **Svelte 5 + shadcn-svelte + Tailwind v4**, with **CodeMirror 6** in\nthe SQL editor, Manrope for the interface and IBM Plex Mono for code. The build\nis embedded in the binary: no CDN and no Node in production (fonts too,\nbecause of the CSP `font-src 'self'`). Dark theme by default; theme and\nlanguage are in the account menu, at the top right.":"Uma SPA em **Svelte 5 + shadcn-svelte + Tailwind v4**, com **CodeMirror 6** no editor SQL, Manrope para a interface e IBM Plex Mono para código. A compilação é embutida no binário: sem CDN e sem Node em produção (inclusive as fontes, por causa da CSP `font-src 'self'`). Tema escuro por padrão; tema e idioma ficam no menu da conta, no canto superior direito.","The pages are pills across the top (on narrow screens, in their own row; on\nphones, in the menu). **Database** groups Tables, SQL and Migrations, with\ntabs between them inside each page; **User sign-in** is reached from the\nUsers page. The project chip at the top left shows the project, whether it\nruns locally or on which host, and a dot for whether the server answers\n(checked every minute and when the window regains focus). Search (Ctrl K)\nsits beside the account chip. The\n**overview** leads with the API's traffic: requests in the last 24 hours,\nthe share refused and the share that failed, then cards for tables (how\nmany are protected), users (how many have signed in from the app) and\nrefused calls, beside a chart of requests and refused calls over the last\nhour or day, with a table view. The counts are kept in memory per minute\nfor 24 hours: restarting the server starts them again.":`As páginas são botões arredondados no topo (em telas estreitas, em uma linha própria; em celulares, no menu). **Banco de dados** agrupa Tabelas, SQL e Migrações, com abas entre elas dentro de cada página; **Login de usuários** é acessado pela página Usuários. O indicador de projeto no canto superior esquerdo mostra o projeto, se executa localmente ou em qual host e um ponto que informa se o servidor responde (verificado a cada minuto e quando a janela recupera o foco). A busca (Ctrl K) fica ao lado do indicador da conta. A **visão geral** começa pelo tráfego da API: requisições nas últimas 24 horas, proporção recusada e proporção com falha, depois cartões para tabelas (quantas estão protegidas), usuários (quantos entraram pelo aplicativo) e chamadas recusadas, ao lado de um gráfico de requisições e recusas da última hora ou dia, com visualização em tabela. As contagens são mantidas em memória por minuto durante 24 horas: reiniciar o servidor as reinicia.`,"RLS state shows as a colored badge: green (RLS with policies), amber (RLS on\nwithout policies) and red (table exposed without RLS).":`O estado da RLS aparece como uma etiqueta colorida: verde (RLS com políticas), âmbar (RLS ativada sem políticas) e vermelho (tabela exposta sem RLS).`,Feature:`Recurso`,"How to use it":`Como usar`,"Edit a cell":`Editar uma célula`,"double click; Enter saves, Esc cancels, NULL button for nulls":`clique duplo; Enter salva, Esc cancela, botão NULL para valores nulos`,"Edit or insert a full row":`Editar ou inserir uma linha inteira`,'expand button next to the row\'s checkbox / "Insert row" (side panel). Closing an altered form asks whether to keep editing or discard':`botão de expandir ao lado da caixa de seleção da linha / "Inserir linha" (painel lateral). Fechar um formulário alterado pergunta se deseja continuar editando ou descartar`,"Delete several rows":`Excluir várias linhas`,'tick the boxes and "Delete N" (a single transaction)':`marque as caixas e "Excluir N" (uma única transação)`,Sort:`Ordenar`,"click the column header (asc → desc → unsorted)":`clique no cabeçalho da coluna (crescente → decrescente → sem ordenação)`,Filter:`Filtrar`,'"Filter" in the grid: equals, not equal, contains, greater/less, is/is not NULL. Filters live in the URL in the REST API format (`/admin/tables/orders?status=eq.paid`). Page, page size and sort use `_page`, `_size`, `_sort` and `_desc`; the complete view survives switching between Data and Structure, refresh and browser navigation':'"Filtrar" na grade: igual, diferente, contém, maior/menor, é/não é NULL. Filtros ficam na URL no formato da API REST (`/admin/tables/orders?status=eq.paid`). Página, tamanho da página e ordenação usam `_page`, `_size`, `_sort` e `_desc`; a visão completa persiste ao alternar entre Dados e Estrutura, recarregar e navegar pelo navegador',"Export a table":`Exportar uma tabela`,'"Export" → CSV or JSON, with the grid\'s order and filters. The server streams with bounded buffers and no collection row cap; exports have a two-minute lifetime and can fail on timeout/cancellation. CSV has a BOM for Excel accents':`"Exportar" → CSV ou JSON, com a ordenação e os filtros da grade. O servidor transmite com buffers limitados e sem limite de linhas de coleção; exportações têm duração máxima de dois minutos e podem falhar por timeout/cancelamento. CSV inclui BOM para acentos no Excel`,"Follow a foreign key":`Seguir uma chave estrangeira`,"the arrow in an FK cell opens the referenced row in the other table; the header shows `→ table`":"a seta em uma célula FK abre a linha referenciada na outra tabela; o cabeçalho mostra `→ table`","Run SQL":`Executar SQL`,"Ctrl+Enter; table and column autocomplete; templates and history":`Ctrl+Enter; preenchimento automático de tabelas e colunas; modelos e histórico`,"Save queries":`Salvar consultas`,'Ctrl+S or "Save"; they show in the editor\'s sidebar and in the palette. Each query has its own draft; opening another query, template or new query keeps previous work. Saved queries and drafts are stored in this browser, per project':`Ctrl+S ou "Salvar"; aparecem na barra lateral do editor e na paleta. Cada consulta tem seu próprio rascunho; abrir outra consulta, modelo ou nova consulta mantém o trabalho anterior. Consultas salvas e rascunhos são armazenados neste navegador, por projeto`,"Read long values":`Ler valores longos`,'"View full content" in long grid and SQL result cells; copy from the detail dialog':`"Ver conteúdo completo" em células longas da grade e dos resultados SQL; copie pelo diálogo de detalhes`,"Resize SQL results":`Redimensionar resultados SQL`,"drag the separator between the editor and results, or focus it and use the arrow keys. The split is remembered in the browser":`arraste o separador entre editor e resultados ou coloque o foco nele e use as setas. A divisão é lembrada no navegador`,"Export a SQL result":`Exportar um resultado SQL`,'"Export" above each result → CSV or JSON':`"Exportar" acima de cada resultado → CSV ou JSON`,"Command palette":`Paleta de comandos`,"Ctrl+K (⌘K on Mac) or the search button at the top right: pages, tables, saved queries, templates and actions":`Ctrl+K (⌘K no Mac) ou botão de busca no canto superior direito: páginas, tabelas, consultas salvas, modelos e ações`,"Create a table":`Criar uma tabela`,'"New table" in the table list: columns (type, default, PK, identity, UNIQUE, foreign key), RLS on by default and a GRANTs matrix. Shows the SQL before creating':`"Nova tabela" na lista de tabelas: colunas (tipo, padrão, PK, identidade, UNIQUE, chave estrangeira), RLS ativada por padrão e matriz de GRANTs. Mostra o SQL antes de criar`,"Edit the structure":`Editar a estrutura`,"the table's **Structure** tab (`/admin/tables/<name>/structure`): add, edit and delete columns; rename the table; description; turn RLS on/off; GRANTs per role; delete the table (by typing its name)":"aba **Estrutura** da tabela (`/admin/tables/<name>/structure`): adicionar, editar e excluir colunas; renomear a tabela; descrição; ativar/desativar RLS; GRANTs por papel; excluir a tabela (digitando seu nome)",Policies:`Políticas`,'search tables and filter their RLS status; "New policy" on each table, with templates (public read, signed-in users read, owner reads/creates/updates/deletes); edit and delete; "Enable RLS" on tables without it. Long expressions expand on demand':`busque tabelas e filtre seu estado de RLS; "Nova política" em cada tabela, com modelos (leitura pública, leitura por usuários autenticados, proprietário lê/cria/atualiza/exclui); editar e excluir; "Ativar RLS" em tabelas sem ela. Expressões longas expandem sob demanda`,"service_role token":`Token service_role`,"**API** page, expandable token section after the examples: issues a token with the chosen validity; shown once and never stored":`página **API**, seção expansível de token após os exemplos: emite um token com a validade escolhida; exibido uma vez e nunca armazenado`,"Create a user / reset a password":`Criar usuário / redefinir senha`,'**Users** page: "New user" and "Reset password…" in each user\'s menu, with a password generator. Same rules as public signup. Accounts created here count as confirmed and the panel sends no invitations; end users can recover their own password by email when the project has SMTP configured ([schema-auth.md](schema-auth.md#password-recovery))':`página **Usuários**: "Novo usuário" e "Redefinir senha…" no menu de cada usuário, com gerador de senhas. Mesmas regras do cadastro público. Contas criadas aqui são consideradas confirmadas e o painel não envia convites; usuários finais podem recuperar a própria senha por e-mail quando o projeto tem SMTP configurado ([schema-auth.md](schema-auth.md#password-recovery))`,"Generate migration":`Gerar migração`,'**Migrations** page: schema changes made in the panel (tables, columns, policies) that are not in any file yet, and the project\'s migrations (applied or only in the folder). "Generate migration" downloads `V<n>__<name>.sql` and registers it as applied in this database; the file goes into `migrations/` (see [deploy](deploy.md#changes-made-in-the-panel))':'página **Migrações**: alterações de esquema feitas no painel (tabelas, colunas, políticas) que ainda não estão em arquivo, e migrações do projeto (aplicadas ou apenas na pasta). "Gerar migração" baixa `V<n>__<name>.sql` e a registra como aplicada neste banco; o arquivo vai para `migrations/` (veja [implantação](deploy.md#changes-made-in-the-panel))',"Profile photo":`Foto de perfil`,'account menu, at the top right: "Add photo…". The image is center-cropped and scaled to 256px in the browser; the server accepts PNG, JPEG or WebP up to 256 KB. It lives in the project\'s database (`nelcota.admin_avatar`, out of reach of the API roles), so it works in any browser, but it is per project':'menu da conta, no canto superior direito: "Adicionar foto…". A imagem é recortada no centro e redimensionada para 256px no navegador; o servidor aceita PNG, JPEG ou WebP até 256 KB. Fica no banco do projeto (`nelcota.admin_avatar`, fora do alcance dos papéis da API), então funciona em qualquer navegador, mas é por projeto',"Dates in the grid":`Datas na grade`,"`timestamptz` shows in the viewer's time zone and language; `timestamp` and `date` as stored. The exact value is in the tooltip, in edit mode and in exports":"`timestamptz` aparece no fuso horário e idioma de quem visualiza; `timestamp` e `date`, como armazenados. O valor exato está na dica, no modo de edição e nas exportações","CSV exports protect spreadsheet imports: formula-like cells and headers receive\na quoted tab prefix, including formulas hidden behind whitespace or control\ncharacters. Negative numeric literals keep their digits and numeric form.\nUse JSON export when you need the original text without this neutralization.":`Exportações CSV protegem importações em planilhas: células e cabeçalhos que parecem fórmulas recebem um prefixo de tabulação entre aspas, inclusive fórmulas escondidas atrás de espaços ou caracteres de controle. Literais numéricos negativos mantêm seus dígitos e formato numérico. Use exportação JSON quando precisar do texto original sem essa neutralização.`,Page:`Página`,"What it has":`O que contém`,"**Overview**":`**Visão geral**`,'what needs action (unprotected or locked tables), next steps ticked by the project\'s state (first table, data protected, a user, a first sign-in through the app), a one-line summary and the table list with who can read and write. Pages that show access rules read in plain language; "Technical details" shows RLS, roles, grants and SQL':`o que precisa de ação (tabelas desprotegidas ou bloqueadas), próximos passos marcados conforme o estado do projeto (primeira tabela, dados protegidos, um usuário, primeiro login pelo aplicativo), resumo de uma linha e lista de tabelas com quem pode ler e escrever. Páginas com regras de acesso usam linguagem simples; "Detalhes técnicos" mostra RLS, papéis, grants e SQL`,"**Tables**":`**Tabelas**`,"every table in the exposed schema, estimated rows, `anon`/`authenticated` GRANTs and RLS status. List, insert, edit and delete rows (tables with a primary key); create tables and edit the structure":"todas as tabelas do esquema exposto, estimativa de linhas, GRANTs de `anon`/`authenticated` e estado da RLS. Listar, inserir, editar e excluir linhas (tabelas com chave primária); criar tabelas e editar a estrutura","**SQL editor**":`**Editor SQL**`,'runs as the database owner (bypasses RLS, shown as a "Full access" notice), or as a visitor or a chosen signed-in user to try the access rules (D94); Ctrl+Enter runs the query, or only the selection; a failed statement is underlined in the editor; a status bar with cursor position and run limits; results fold away until the first run; drafts are named by what they do ("Query on orders"); saved queries are renamed by clicking their title':`executa como proprietário do banco (ignora RLS, mostrado no aviso "Acesso total"), ou como visitante ou usuário autenticado escolhido para testar as regras de acesso (D94); Ctrl+Enter executa a consulta ou apenas a seleção; uma instrução com falha é sublinhada no editor; barra de status com posição do cursor e limites de execução; resultados ficam recolhidos até a primeira execução; rascunhos recebem nomes conforme o que fazem ("Consulta em orders"); consultas salvas são renomeadas clicando no título`,"**Migrations**":`**Migrações**`,'panel changes not yet in a migration and the project\'s migrations, with "Generate migration"':`alterações do painel ainda fora de uma migração e migrações do projeto, com "Gerar migração"`,"**Storage**":`**Armazenamento**`,"buckets with file count, size, limit and accepted types (create, edit, delete when empty); a file browser by folder: upload by selection or drop, per-file progress (asks before replacing), preview, download, copy the public URL, delete. Passive image formats and PDFs up to 20 MB can be previewed; plain text, CSV and JSON up to 1 MB. PDFs open in the browser viewer. Files go through the same checks as the API ([storage.md](storage.md))":`buckets com contagem de arquivos, tamanho, limite e tipos aceitos (criar, editar, excluir quando vazio); navegador de arquivos por pasta: upload por seleção ou arraste, progresso por arquivo (pergunta antes de substituir), prévia, download, copiar URL pública, excluir. Formatos passivos de imagem e PDFs até 20 MB têm prévia; texto simples, CSV e JSON até 1 MB. PDFs abrem no visualizador do navegador. Arquivos passam pelas mesmas verificações da API ([storage.md](storage.md))`,"**Users**":`**Usuários**`,"search by email, how each account signs in (password, Google, GitHub, or email links only), last sign-in, active sessions, unconfirmed emails; create a user, confirm an email, reset a password (ends their sessions), end sessions or delete a user":`busca por e-mail, como cada conta entra (senha, Google, GitHub ou apenas links de e-mail), último login, sessões ativas, e-mails não confirmados; criar usuário, confirmar e-mail, redefinir senha (encerra as sessões), encerrar sessões ou excluir usuário`,"**Policies**":`**Políticas**`,"each table's policies (`USING`/`WITH CHECK`): create, edit and delete; tables without RLS; functions `anon` can execute":"políticas de cada tabela (`USING`/`WITH CHECK`): criar, editar e excluir; tabelas sem RLS; funções que `anon` pode executar","**API**":`**API**`,"section navigation, project address, how each role calls the API, curl and JavaScript examples generated from each table's columns, service_role token. Topic, language and table are shareable through the URL":`navegação por seções, endereço do projeto, como cada papel chama a API, exemplos curl e JavaScript gerados a partir das colunas de cada tabela, token service_role. Tema, linguagem e tabela podem ser compartilhados pela URL`,"Connecting an app and understanding access":`Conectar um aplicativo e entender o acesso`,"**API → Connect with the SDK**: install command, a **Download database.ts**\nbutton (the same file `nelcota types` writes) and the `createClient` lines\nfor this project. The examples switch between the TypeScript SDK (default),\ncurl and plain `fetch`, generated from the chosen table's columns.":"**API → Conectar com o SDK**: comando de instalação, botão **Baixar database.ts** (o mesmo arquivo escrito por `nelcota types`) e linhas de `createClient` para este projeto. Os exemplos alternam entre o SDK TypeScript (padrão), curl e `fetch` simples, gerados a partir das colunas da tabela escolhida.","**User sign-in**: which ways in are on (sign-up, email confirmation,\npassword recovery, magic link, Google, GitHub), and for each one that is off\nthe environment variables that turn it on. With a provider on, it shows the\ncallback address to register with Google or GitHub and the app pages a\nsign-in may return to. Read-only: these settings live in the server's\n`.env`.":"**Login de usuários**: quais formas de entrada estão ativas (cadastro, confirmação de e-mail, recuperação de senha, link mágico, Google, GitHub) e, para cada uma desativada, as variáveis de ambiente que a ativam. Com um provedor ativo, mostra o endereço de callback para cadastrar no Google ou GitHub e as páginas do aplicativo às quais um login pode retornar. Apenas leitura: essas configurações ficam no `.env` do servidor.","**Tables → View as**: reads the grid as a visitor or as a chosen user, with\nthe same role, claims, grants and RLS the API applies, in a transaction that\nis rolled back. It is read-only; a role without a GRANT gets a plain\nexplanation instead of rows.":`**Tabelas → Ver como**: lê a grade como visitante ou usuário escolhido, com o mesmo papel, claims, grants e RLS aplicados pela API, em uma transação que sofre rollback. É apenas leitura; um papel sem GRANT recebe uma explicação simples em vez de linhas.`,'**Storage → a bucket → Who reaches the files**: the policies on\n`storage.objects` that apply to the bucket, in plain language, and templates\nto add more (anyone or signed-in users download, signed-in users upload,\neach user only their own folder or their own files). They are created like\nany panel change, so "Generate migration" includes them. A private bucket\nwithout rules is flagged: only the panel and `service_role` reach it.':'**Armazenamento → um bucket → Quem acessa os arquivos**: as políticas de `storage.objects` aplicáveis ao bucket, em linguagem simples, e modelos para adicionar mais (qualquer pessoa ou usuários autenticados baixam, usuários autenticados enviam, cada usuário apenas sua própria pasta ou arquivos). São criadas como qualquer alteração do painel, então "Gerar migração" as inclui. Um bucket privado sem regras é sinalizado: apenas o painel e `service_role` o acessam.',"**Policies → Recently blocked**: the last 100 API calls answered with 401,\n403 or 429, who made them and why, in plain language. They are kept in\nmemory only (gone on restart), with the path but never the query string or\nthe token. Reads that RLS filters are not refusals (they return fewer rows)\nand do not show here.":`**Políticas → Bloqueios recentes**: as últimas 100 chamadas à API respondidas com 401, 403 ou 429, quem as fez e por quê, em linguagem simples. Ficam apenas em memória (somem ao reiniciar), com o caminho, mas nunca a query string ou o token. Leituras filtradas pela RLS não são recusas (retornam menos linhas) e não aparecem aqui.`,"Guides and references":`Guias e referências`,"The book icon in the top bar opens **Guides and references** at `/admin/guides`.\nThe reader includes its registered project guides, JavaScript/TypeScript and\nRust SDK references, SQL examples and server recipes. Repository-only references\nand historical reports are not automatically added to the reader. Search matches the full text,\ncode blocks have copy buttons, and a table of contents links to each section.\nOn phones, a guide selector replaces the sidebar. Guides and references follow\nthe panel language, with Portuguese translations of the English sources. Code\nexamples, inline code, URLs and section identifiers remain unchanged. Translations\nlive in `docs/i18n/pt-BR/`; `npm run guides:check` verifies every prose fragment\nagainst its source and fails on missing or outdated translations. Code-only\nchanges flow straight from the source without requiring a translation update.":"O ícone de livro na barra superior abre **Guias e referências** em `/admin/guides`. O leitor inclui os guias registrados do projeto, referências JavaScript/TypeScript e Rust, exemplos SQL e receitas de servidor. Referências exclusivas do repositório e relatórios históricos não são adicionados automaticamente. A busca consulta o texto completo, blocos de código têm botão de cópia e um índice leva a cada seção. No celular, um seletor substitui a barra lateral. Guias e referências seguem o idioma do painel, com traduções dos textos ingleses para português. Exemplos, código inline, URLs e identificadores de seção permanecem iguais. As traduções ficam em `docs/i18n/pt-BR/`; `npm run guides:check` verifica cada fragmento contra sua fonte e falha se faltar tradução ou ela estiver desatualizada. Alterações apenas no código são incorporadas diretamente, sem atualizar a tradução.","SDK help on the API page and the S3 guide on the Storage page open in this\nreader. Links between repository documents stay in the panel, including\nsection links that can be shared and survive a reload. Registered sources and images are bundled, so reading those needs no GitHub\naccess. The longer Notes staging guide opens on GitHub. Some unregistered\nrepository links are not supported by the current reader; consult the repository\nfor them.":`A ajuda do SDK na página da API e o guia S3 na página de armazenamento abrem neste leitor. Links entre documentos registrados ficam no painel, incluindo seções compartilháveis que sobrevivem a recarregamentos. Fontes e imagens registradas são incorporadas e não exigem acesso ao GitHub. O guia completo de staging Notes abre no GitHub. Alguns links para documentos não registrados não são suportados pelo leitor atual; consulte-os no repositório.`,"**API → OpenAPI documentation**, also available from the command palette,\nopens the live reference inside the panel. It fetches `/rest/v1/` as `anon`,\nshows available routes, parameters, request bodies, responses and schema models,\nand can download the complete JSON. The panel administrator session does not\ngrant extra API privileges. An empty catalog points to the table access screen;\na failed request can be retried.":"**API → Documentação OpenAPI**, também disponível na paleta de comandos, abre a referência atual dentro do painel. Busca `/rest/v1/` como `anon`, mostra rotas disponíveis, parâmetros, corpos de requisição, respostas e modelos do esquema e permite baixar o JSON completo. A sessão administrativa do painel não concede privilégios extras na API. Um catálogo vazio indica a tela de acesso da tabela; uma requisição com falha pode ser repetida.","RLS warnings":`Avisos de RLS`,"**without RLS**: a regular table with a GRANT to `anon` or `authenticated`\nand RLS off. Whoever has the GRANT sees and changes **every** row. Shown\nprominently at the top of the panel and on the policies page.":"**sem RLS**: uma tabela comum com GRANT para `anon` ou `authenticated` e RLS desativada. Quem tiver o GRANT vê e altera **todas** as linhas. Mostrado em destaque no topo do painel e na página de políticas.","**RLS without policies**: RLS on and no policy. Nobody but `service_role`\n(and the owner) has access: it is safe, but maybe not what you want.":"**RLS sem políticas**: RLS ativada e nenhuma política. Apenas `service_role` (e o proprietário) tem acesso: é seguro, mas talvez não seja o que você quer.","Changing the admin password":`Alterar a senha do administrador`,"You can also use an argon2id hash (PHC format) generated by any tool:\n`NELCOTA_ADMIN_PASSWORD_HASH='$argon2id$...'` in the `.env` (in single quotes\nbecause of the `$`), followed by `docker compose up -d --force-recreate app`.":"Você também pode usar um hash argon2id (formato PHC) gerado por qualquer ferramenta: `NELCOTA_ADMIN_PASSWORD_HASH='$argon2id$...'` no `.env` (entre aspas simples por causa do `$`), seguido de `docker compose up -d --force-recreate app`.",Security:`Segurança`,"Session cookie `HttpOnly`, `SameSite=Strict` and `Secure` behind Caddy;\nin-memory sessions valid for 12 h (restarting the server signs everyone out).":"Cookie de sessão `HttpOnly`, `SameSite=Strict` e `Secure` atrás do Caddy; sessões em memória válidas por 12 h (reiniciar o servidor desconecta todos).","Login attempts limited to 10 per minute.":`Tentativas de login limitadas a 10 por minuto.`,"The page itself contains no data: everything comes from `/admin/api/*`,\nwhich requires the session. Every state-changing request must come from the\nsame origin.":"A página em si não contém dados: tudo vem de `/admin/api/*`, que exige sessão. Toda requisição que altera estado deve vir da mesma origem.","CSP without inline scripts (`script-src 'self'`), `X-Frame-Options: DENY`.":"CSP sem scripts inline (`script-src 'self'`), `X-Frame-Options: DENY`.","Svelte escapes interface text. The guide reader renders Markdown with raw HTML\nescaped and unsafe links rejected; code examples are rendered as text.":`Svelte escapa o texto da interface. O leitor renderiza Markdown escapando HTML bruto e rejeitando links inseguros; exemplos de código são renderizados como texto.`,"DDL made by the panel (tables, columns, policies): the interface sends a\ntyped specification, and the server builds the SQL with identifiers always\nquoted and types from a closed list. Expressions (`DEFAULT`, `USING`,\n`WITH CHECK`) are SQL by nature: each statement goes through the extended\nprotocol, which refuses a second statement hidden in the expression, and\neverything runs in one transaction (or nothing is applied). The SQL is shown\nbefore running.":"DDL feito pelo painel (tabelas, colunas, políticas): a interface envia uma especificação tipada, e o servidor constrói o SQL com identificadores sempre entre aspas e tipos de uma lista fechada. Expressões (`DEFAULT`, `USING`, `WITH CHECK`) são SQL por natureza: cada instrução passa pelo protocolo estendido, que recusa uma segunda instrução escondida na expressão, e tudo executa em uma transação (ou nada é aplicado). O SQL é mostrado antes de executar.","Foreign keys from the form only point into the exposed schema (for\n`auth.users`, use the SQL editor).":"Chaves estrangeiras do formulário apontam apenas para o esquema exposto (para `auth.users`, use o editor SQL).","The SQL editor uses a new connection per run and the SQL text does not go to\nthe log.":`O editor SQL usa uma nova conexão por execução e o texto SQL não vai para o log.`,"`service_role` tokens issued by the panel are neither stored nor logged\n(only the fact and the validity).":"Tokens `service_role` emitidos pelo painel não são armazenados nem registrados em logs (apenas o fato e a validade).","Without `NELCOTA_ADMIN_EMAIL` and `NELCOTA_ADMIN_PASSWORD_HASH`, the panel is\noff (the `/admin` routes do not even exist).":"Sem `NELCOTA_ADMIN_EMAIL` e `NELCOTA_ADMIN_PASSWORD_HASH`, o painel fica desativado (as rotas `/admin` nem existem).","Panel development":`Desenvolvimento do painel`,"After bundled guide/UI changes, run `npm run build` and rebuild the binary\n(`cargo build --locked -p nelcota-server`). Commit generated `dist/` in its own\nbuild commit. CI checks it for drift. Set `NELCOTA_API_URL` when Vite should\nproxy another backend.":"Após alterar guias incorporados/UI, execute `npm run build` e recompile o binário (`cargo build --locked -p nelcota-server`). Faça commit do `dist/` gerado em um commit de build próprio. A CI verifica divergências. Defina `NELCOTA_API_URL` para o Vite usar outro backend.","Interface texts live in `src/lib/i18n/messages/<area>.ts`, with a Portuguese\n(`pt-BR`) and an English (`en`) object; the English one is typed against the\nPortuguese one, so a missing key fails `npm run check`. Never hardcode a\nuser-facing string in a component.":"Textos da interface ficam em `src/lib/i18n/messages/<area>.ts`, com um objeto em português (`pt-BR`) e outro em inglês (`en`); o inglês é tipado a partir do português, então uma chave ausente faz `npm run check` falhar. Nunca escreva diretamente uma string visível ao usuário em um componente.","Related guides":`Guias relacionados`,"See [deploy](deploy.md), [auth](schema-auth.md), [storage](storage.md) and [troubleshooting](troubleshooting.md).":`Veja [deploy](deploy.md), [autenticação](schema-auth.md), [armazenamento](storage.md) e [solução de problemas](troubleshooting.md).`,"Host projects in the controller":`Projetos do host no controlador`,"The Unreleased host controller adds project creation, paired backups, restore\nand removal with visual review, typed confirmation, operator reauthentication\nand durable recovery. It uses a separate HTTPS origin and SSH-granted host\nauthority. The Projects page links to this controller when enrolled.\nDeployment, supported layouts and activation are described in `docs/host-management.md`.":"O controlador de host ainda não lançado adiciona criação de projetos, backups pareados, restauração e remoção com revisão visual, confirmação digitada, nova autenticação do operador e recuperação persistente. Ele usa uma origem HTTPS separada e autoridade de host concedida por SSH. A página Projetos oferece acesso a esse controlador quando cadastrado. A implantação, os layouts aceitos e a ativação estão descritos em `docs/host-management.md`.","Handoff redemption writes a SHA-256 digest of the signed `jti` to the project's\ninternal PostgreSQL replay table before creating a panel session. All processes\nand instances sharing that database use the same atomic single-use boundary;\ndatabase failures refuse the handoff. Receipts cover the 5-second validation\nleeway and remain for at least another day. Each successful redemption removes\nat most 5,000 older receipts; idle tables are cleaned on the next redemption.\nKeep instance clocks synchronized. A panel session never grants host-controller\nauthority. Internal migration `V16` installs this owner-only table; it is not\npart of the standalone auth migration selection.":"O resgate do handoff grava um digest SHA-256 do `jti` assinado na tabela interna de replays do PostgreSQL do projeto antes de criar uma sessão do painel. Todos os processos e instâncias que compartilham esse banco usam a mesma fronteira atômica de uso único; falhas de banco recusam o handoff. Os registros cobrem a tolerância de validação de 5 segundos e permanecem por pelo menos mais um dia. Cada resgate bem-sucedido remove no máximo 5.000 registros mais antigos; tabelas ociosas são limpas no próximo resgate. Mantenha os relógios das instâncias sincronizados. Uma sessão do painel nunca concede autoridade no controlador do host. A migração interna `V16` instala essa tabela acessível apenas ao proprietário; ela não faz parte da seleção de migrações de autenticação independente."},_t={"Quickstart: local development":`Primeiros passos: desenvolvimento local`,"Create a local application, make an authenticated request and read your own\nrows through PostgreSQL RLS. For production HTTPS, use [deploy.md](deploy.md).":`Crie um aplicativo local, faça uma requisição autenticada e leia suas próprias linhas com RLS do PostgreSQL. Para HTTPS em produção, use [deploy.md](deploy.md).`,"You need Docker, `curl` and `jq`. The optional JavaScript client needs Node 22+;\nRust client development needs Rust 1.88+. Building the server from source needs\nthe pinned Rust 1.99.0 toolchain. The binary needs no Node runtime.":"Você precisa de Docker, `curl` e `jq`. O cliente JavaScript opcional exige Node 22+; o desenvolvimento do cliente Rust exige Rust 1.88+. Compilar o servidor a partir da fonte exige o Rust 1.99.0 fixado no projeto. O binário não precisa de Node em execução.","1. Install the binary":`1. Instale o binário`,"On Linux with Docker already installed:":`No Linux com Docker já instalado:`,"This installs the latest published release, currently 0.4.0. To build that\nrelease on macOS/Windows with Rust 1.99+:":`Isso instala a versão publicada mais recente, atualmente 0.4.0. Para compilar essa versão no macOS/Windows com Rust 1.99+:`,"For this checkout, run `cargo build --locked -p nelcota-server` and use the\nabsolute path to `target/debug/nelcota` in place of `nelcota`. Unreleased features\nare listed in the server changelog. See [Notes staging](onboarding/notes.md)\nfor separate published/candidate acceptance.":"Para este checkout, execute `cargo build --locked -p nelcota-server` e use o caminho absoluto de `target/debug/nelcota` no lugar de `nelcota`. Recursos não publicados estão no changelog do servidor. Veja [Notes staging](onboarding/notes.md) para validar separadamente versões publicadas e candidatas.","2. Start the development environment":`2. Inicie o ambiente de desenvolvimento`,"Use a fresh application directory outside Nelcota's repository:":`Use um diretório novo para o aplicativo, fora do repositório do Nelcota:`,"The command starts PostgreSQL 17 in `nelcota-dev-postgres-54322`, stores data\nin a Docker volume, applies internal migrations and serves the API in the\nforeground. The API is at `http://127.0.0.1:8000`, and the panel is at `/admin/`.\nIts account is `admin@localhost`; read `ADMIN_PASSWORD` locally from\n`.nelcota/dev.env`. Do not share that file.":"O comando inicia PostgreSQL 17 em `nelcota-dev-postgres-54322`, mantém os dados em um volume Docker, aplica migrações internas e serve a API em primeiro plano. A API fica em `http://127.0.0.1:8000`, e o painel em `/admin/`. Sua conta é `admin@localhost`; leia `ADMIN_PASSWORD` localmente em `.nelcota/dev.env`. Não compartilhe esse arquivo.","Generated database passwords, signing keys and panel credentials persist in\nthat owner-readable, Git-ignored file. Repeating `dev` reuses them. Use\n`--listen 127.0.0.1:9000` or `--db-port 54323` for free ports; changing the database\nport selects another container/volume, rather than moving data. Ctrl+C stops\nthe API; the database container and its data remain until you stop/remove them.":"Senhas do banco, chaves de assinatura e credenciais do painel permanecem nesse arquivo legível pelo proprietário e ignorado pelo Git. Repetir `dev` reutiliza esses valores. Use `--listen 127.0.0.1:9000` ou `--db-port 54323` para portas livres; mudar a porta do banco seleciona outro contêiner/volume, sem mover os dados. Ctrl+C para a API; o contêiner do banco e seus dados permanecem até você pará-los/removê-los.","`dev` enables disk storage and leaves SMTP/email confirmation off. Signup\ntherefore returns a session immediately. It uses generated settings, not your\napplication's `.env` overrides.":"`dev` ativa armazenamento em disco e deixa SMTP/confirmação de email desativados. O cadastro retorna uma sessão imediatamente. Ele usa configurações geradas, não as substituições do `.env` do aplicativo.","3. Write a migration":`3. Escreva uma migração`,"Keep `dev` running. Open a second terminal in `notes-app`. This file contains\nthe schema used by the SDK examples, including `extra` and the private `files`\nbucket. Do this once in a fresh database:":"Mantenha `dev` em execução. Abra outro terminal em `notes-app`. Este arquivo contém o schema dos exemplos dos SDKs, incluindo `extra` e o bucket privado `files`. Faça isso uma vez em um banco novo:","For an existing schema, use the repeatable [examples/notes.sql](../examples/notes.sql)\nor a new migration adding missing columns. `CREATE TABLE IF NOT EXISTS` does\nnot add columns to an existing table. A GRANT permits an operation, RLS enables\nrow filtering, and a policy defines accessible rows.":"Para um schema existente, use [examples/notes.sql](../examples/notes.sql), que pode ser repetido, ou uma nova migração adicionando colunas ausentes. `CREATE TABLE IF NOT EXISTS` não adiciona colunas a uma tabela existente. Um GRANT permite uma operação, RLS ativa a filtragem de linhas, e uma política define as linhas acessíveis.","4. Apply it":`4. Aplique a migração`,"The first run applies the file and records its checksum in\n`nelcota.user_migrations`; the second is a no-op. The API reloads its catalog\nwithout restarting. Never edit an applied migration: add `V2__...` instead.\nThe repository-root `migrations/` contains internal SQL, not your app schema.":"A primeira execução aplica o arquivo e registra seu checksum em `nelcota.user_migrations`; a segunda não altera nada. A API recarrega seu catálogo sem reiniciar. Nunca edite uma migração aplicada: adicione `V2__...`. O `migrations/` da raiz do repositório contém SQL interno, não o schema do aplicativo.","5. Generate types":`5. Gere os tipos`,"Regenerate after schema changes. Generators describe the running server's schema;\nconsumer compilation does not connect to your database.":`Gere novamente após alterações no schema. Os geradores descrevem o schema do servidor em execução; compilar o consumidor não conecta ao seu banco.`,"6. Use it from the client":`6. Use o cliente`,"First make an authenticated request using only `curl` and `jq`:":"Primeiro faça uma requisição autenticada usando apenas `curl` e `jq`:","Use this password only for the local example. If the account exists, sign in\nwith `POST /auth/v1/token?grant_type=password` and the same JSON body instead\nof signing up again. Another user's token returns none of Ana's notes.\nOn a project with confirmation enabled, confirm the email and sign in before\nextracting an access token.":"Use essa senha apenas no exemplo local. Se a conta existir, entre com `POST /auth/v1/token?grant_type=password` e o mesmo JSON, em vez de cadastrar novamente. O token de outro usuário não retorna nenhuma nota de Ana. Se o projeto exige confirmação, confirme o email e entre antes de extrair um token de acesso.","For a runnable JavaScript client, install the published package:":`Para um cliente JavaScript executável, instale o pacote publicado:`,"In a TypeScript application, import `Database` from the generated file and use\n`createClient<Database>(url)` with your framework's TypeScript build configuration.\nThe [TypeScript SDK](../sdk/typescript/README.md) explains published versus source\nbehavior. The [Rust SDK](../sdk/rust/README.md) uses the same Notes schema.":"Em um aplicativo TypeScript, importe `Database` do arquivo gerado e use `createClient<Database>(url)` com a configuração de compilação TypeScript do seu framework. O [SDK TypeScript](../sdk/typescript/README.md) explica diferenças entre pacote publicado e fonte. O [SDK Rust](../sdk/rust/README.md) usa o mesmo schema Notes.","**Warning:** `service_role` bypasses RLS. Never use it in a browser or mobile\nclient; use each user's access token.":"**Aviso:** `service_role` ignora RLS. Nunca o use em um navegador ou cliente móvel; use o token de acesso de cada usuário.",Troubleshooting:`Solução de problemas`,"For occupied ports, select free API/database ports before startup. For\n`user_already_exists`, sign in to the existing account. For empty rows, 401/403\nor missing columns, check [troubleshooting.md](troubleshooting.md).\nCreating `.env` alone does not configure `nelcota serve`: it reads process\nvariables and optional TOML. Host Compose/systemd and `dev` load their own settings.":"Se as portas estiverem ocupadas, escolha portas livres para a API/banco antes de iniciar. Para `user_already_exists`, entre na conta existente. Para linhas vazias, 401/403 ou colunas ausentes, veja [troubleshooting.md](troubleshooting.md). Criar apenas `.env` não configura `nelcota serve`: ele lê variáveis do processo e TOML opcional. Compose/systemd do host e `dev` carregam suas próprias configurações.",Next:`Próximos passos`,"Query syntax and errors: [api.md](api.md).":`Sintaxe de consultas e erros: [api.md](api.md).`,"Files and policies: [storage.md](storage.md).":`Arquivos e políticas: [storage.md](storage.md).`,"SDKs: [TypeScript](../sdk/typescript/README.md) and [Rust](../sdk/rust/README.md).":`SDKs: [TypeScript](../sdk/typescript/README.md) e [Rust](../sdk/rust/README.md).`,"Production: [deploy.md](deploy.md). Installation/restart checks: [Notes staging](onboarding/notes.md).":`Produção: [deploy.md](deploy.md). Verificações de instalação/reinício: [Notes staging](onboarding/notes.md).`,"The catalog reloads asynchronously after migration. The bounded read below\nwaits for `notes` before sending a write; an error other than 404 stops the\nexample. Mutations are sent once.":"O catálogo recarrega de forma assíncrona após a migração. A leitura limitada abaixo aguarda `notes` antes de enviar uma escrita; um erro diferente de 404 interrompe o exemplo. Mutações são enviadas uma vez."},vt={"JWT and roles":`JWT e papéis`,"Public contract. The JWT format is ours and documented here; no library\ndictates it.":`Contrato público. O formato do JWT é nosso e está documentado aqui; nenhuma biblioteca o determina.`,Prerequisites:`Pré-requisitos`,"You need an initialized private PostgreSQL database and a signing key or\ncompatible verifier. This page describes built-in token/role behavior; issuer\nand audience policy are not enforced by the built-in verifier.":`Você precisa de um banco PostgreSQL privado inicializado e uma chave de assinatura ou verificador compatível. Esta página descreve tokens/papéis nativos; o verificador nativo não exige uma política de emissor e audiência.`,"Postgres roles":`Papéis do Postgres`,Role:`Papel`,Login:`Login`,"Used by":`Usado por`,RLS:`RLS`,yes:`sim`,"the API connection (pool)":`a conexão da API (pool)`,"n/a":`não se aplica`,no:`não`,"requests without `Authorization`":"requisições sem `Authorization`",enforced:`aplicada`,"signed-in end users":`usuários finais autenticados`,"trusted backend":`backend confiável`,"**bypassed** (`BYPASSRLS`)":"**ignorada** (`BYPASSRLS`)","internal: the server reading `auth.*`":"interno: o servidor lendo `auth.*`","n/a (no JWT can assume it)":`não se aplica (nenhum JWT pode assumir esse papel)`,"`authenticator` is `NOINHERIT`: on its own it has no privilege at all. It is a\nmember of the other roles and assumes one of them in each request.":"`authenticator` é `NOINHERIT`: por si só, não tem nenhum privilégio. Ele é membro dos outros papéis e assume um deles a cada requisição.","**Warning:** **A JWT with `role: service_role` bypasses all RLS. It must\nNEVER go to the frontend, a mobile app or anywhere outside your server.**":"**Aviso:** **Um JWT com `role: service_role` ignora toda a RLS. Ele NUNCA deve ir para o frontend, um aplicativo móvel ou qualquer lugar fora do seu servidor.**","What happens in each request":`O que acontece em cada requisição`,"The API reads `Authorization: Bearer <jwt>` (the scheme is case-insensitive:\n`bearer <jwt>` works too).":"A API lê `Authorization: Bearer <jwt>` (o esquema não diferencia maiúsculas de minúsculas: `bearer <jwt>` também funciona).","Without the header: the request becomes `anon`.":"Sem o cabeçalho: a requisição assume `anon`.","Opens **one** transaction and runs, with parameters:":`Abre **uma** transação e executa, com parâmetros:`,"Runs the query. Postgres RLS decides what the role sees.":`Executa a consulta. A RLS do Postgres decide o que o papel pode ver.`,"COMMIT (or ROLLBACK on error). Role and claims die with the transaction.":`COMMIT (ou ROLLBACK em caso de erro). O papel e as claims terminam com a transação.`,Signing:`Assinatura`,"**EdDSA (Ed25519)**, the default. Private key in `NELCOTA_JWT_PRIVATE_KEY`\n(PKCS#8 in PEM, or the one-line base64). The public key is published at\n`GET /auth/v1/.well-known/jwks.json` (`kty: OKP`, `crv: Ed25519`, `kid` =\nRFC 7638 thumbprint). Each token's header carries the `kid`.":"**EdDSA (Ed25519)**, o padrão. Chave privada em `NELCOTA_JWT_PRIVATE_KEY` (PKCS#8 em PEM ou base64 em uma única linha). A chave pública é publicada em `GET /auth/v1/.well-known/jwks.json` (`kty: OKP`, `crv: Ed25519`, `kid` = impressão digital RFC 7638). O cabeçalho de cada token contém o `kid`.","**HS256**, the simple/legacy mode, with `NELCOTA_JWT_SECRET` (≥ 32\ncharacters). When there is an EdDSA key, the HS256 secret is only used to\n**verify** old tokens, which allows migrating without signing anyone out.":"**HS256**, o modo simples/legado, com `NELCOTA_JWT_SECRET` (≥ 32 caracteres). Quando há uma chave EdDSA, o segredo HS256 serve apenas para **verificar** tokens antigos, permitindo migrar sem encerrar a sessão de ninguém.","Generate a key: `openssl genpkey -algorithm ed25519` (or `nelcota init`, which\ngenerates one).":"Gere uma chave: `openssl genpkey -algorithm ed25519` (ou `nelcota init`, que gera uma).","Claims of user tokens (issued by `/auth/v1`)":"Claims dos tokens de usuário (emitidos por `/auth/v1`)","Validation rules (any issuer)":`Regras de validação (qualquer emissor)`,Claim:`Claim`,Required:`Obrigatória`,Rule:`Regra`,"`anon`, `authenticated` or `service_role`. Any other value → 401.":"`anon`, `authenticated` ou `service_role`. Qualquer outro valor → 401.","only for `authenticated`":"apenas para `authenticated`","the user's uuid (`auth.uid()`).":"o UUID do usuário (`auth.uid()`).","epoch in seconds; 30 s of leeway.":`época em segundos; tolerância de 30 s.`,"Other claims are passed through untouched to `auth.jwt()`. Logout revokes the\nsession and the refresh tokens; the access JWT, which is stateless, stays valid\nuntil `exp` (default: 15 minutes, `NELCOTA_JWT_EXPIRY_SECS`).":"As outras claims são repassadas sem alterações para `auth.jwt()`. O logout revoga a sessão e os tokens de renovação; o JWT de acesso, que não mantém estado, continua válido até `exp` (padrão: 15 minutos, `NELCOTA_JWT_EXPIRY_SECS`).","Switching auth providers":`Trocar de provedor de autenticação`,"Since policies only depend on `auth.uid()`, `auth.role()` and `auth.jwt()`,\nany issuer producing a JWT with the claims above works. Verification sits\nbehind the `JwtVerifier` trait; accepting an external JWKS (Auth0, Keycloak,\nZitadel...) is a new implementation of that trait.":"Como as políticas dependem apenas de `auth.uid()`, `auth.role()` e `auth.jwt()`, qualquer emissor que produza um JWT com as claims acima funciona. A verificação fica por trás do trait `JwtVerifier`; aceitar um JWKS externo (Auth0, Keycloak, Zitadel...) requer uma nova implementação desse trait.","SQL functions":`Funções SQL`,"Policy example:":`Exemplo de política:`,"HTTP status codes":`Códigos de status HTTP`,Situation:`Situação`,Status:`Status`,"Invalid or expired JWT, unknown role or a scheme other than Bearer":`JWT inválido ou expirado, papel desconhecido ou esquema diferente de Bearer`,"`anon` without permission on the table":"`anon` sem permissão na tabela","`authenticated` without permission / policy violated on write":"`authenticated` sem permissão / violação de política na escrita","Table does not exist":`A tabela não existe`,"The body is the API's error JSON (`code`, `message` and, for database errors,\n`sqlstate`/`details`/`hint`/`constraint`); see [api.md](api.md#errors).":"O corpo é o JSON de erro da API (`code`, `message` e, para erros do banco, `sqlstate`/`details`/`hint`/`constraint`); veja [api.md](api.md#errors).",'Every 401 carries `WWW-Authenticate`: `Bearer error="invalid_token"` when a\ntoken was presented and rejected, plain `Bearer` when the request had no\ntoken (an `anon` request that needs to sign in).':'Toda resposta 401 inclui `WWW-Authenticate`: `Bearer error="invalid_token"` quando um token foi apresentado e rejeitado, ou apenas `Bearer` quando a requisição não tinha token (uma requisição `anon` que precisa se autenticar).',"Related guides":`Guias relacionados`,"See [auth schema](schema-auth.md), [REST API](api.md) and [deploy](deploy.md).":`Veja [schema de autenticação](schema-auth.md), [API REST](api.md) e [deploy](deploy.md).`,"Application row access is determined by PostgreSQL GRANTs and RLS. The server\nalso validates authentication, query/path syntax and operation boundaries before\nexecuting the request.":`O acesso às linhas do aplicativo é determinado por GRANTs e RLS do PostgreSQL. O servidor também valida autenticação, sintaxe de consulta/caminho e fronteiras da operação antes de executar a requisição.`,"Header present but invalid (signature, `exp`, `nbf`, `iat`, scheme, unknown `kid` or\nrole): **401**. It never silently becomes `anon`.":"Cabeçalho presente, mas inválido (assinatura, `exp`, `nbf`, `iat`, esquema, `kid` ou papel desconhecido): **401**. Nunca se torna `anon` silenciosamente.","informative: not required or matched by verification.":`informativas: não são exigidas nem comparadas pela verificação.`,"if present, whole non-negative epoch seconds; reject values more than 30 s in the future.":`se presentes, segundos inteiros não negativos desde a época; rejeita valores mais de 30 s no futuro.`,"The same built-in `Keys` validator checks EdDSA and HS256 API tokens and signed\nraw payloads. Standalone auth consumers inherit these checks. The Rust and\nTypeScript SDKs forward tokens to the server; they do not verify signatures or\nmake authorization decisions from decoded claims. Keep issuer/audience policy\nin a custom verifier when required; `iss`/`aud` remain informative.":"O mesmo validador integrado `Keys` verifica tokens de API EdDSA e HS256 e payloads brutos assinados. Consumidores de autenticação independentes herdam essas verificações. Os SDKs Rust e TypeScript encaminham tokens ao servidor; não verificam assinaturas nem tomam decisões de autorização a partir de claims decodificadas. Mantenha a política de emissor/público em um validador personalizado quando necessário; `iss`/`aud` continuam informativas."},yt={"Rust SDK contract":`Contrato do SDK Rust`,"`nelcota-client` 0.1.x supports Nelcota server 0.3.0 or later; release 0.1.2 is\nverified against server 0.4.0. The released v0.2.0 tag is a legacy baseline\nwithout the newer OAuth routes and generators; see the README compatibility\nmatrix. Package and server versions are independent. Native Tokio on Linux,\nWindows and macOS is the supported target; blocking and WASM interfaces are\nnot part of 0.1.":"`nelcota-client` 0.1.x suporta o servidor Nelcota 0.3.0 ou posterior; a versão 0.1.2 é verificada contra o servidor 0.4.0. A tag v0.2.0 publicada é uma base legada sem as rotas OAuth e os geradores mais recentes; veja a matriz de compatibilidade no README. As versões do pacote e do servidor são independentes. Tokio nativo em Linux, Windows e macOS é o alvo suportado; interfaces bloqueantes e WASM não fazem parte da versão 0.1.",Module:`Módulo`,"HTTP contract":`Contrato HTTP`,"REST read":`Leitura REST`,"GET/HEAD `/rest/v1/{table}`; select/filter/order/paging, Prefer count, Content-Range":"GET/HEAD `/rest/v1/{table}`; select/filter/order/paging, Prefer count, Content-Range","REST write":`Escrita REST`,"POST/PATCH/DELETE `/rest/v1/{table}`; minimal/representation, upsert resolution/on_conflict":"POST/PATCH/DELETE `/rest/v1/{table}`; minimal/representation, resolução de upsert/on_conflict",RPC:`RPC`,"POST `/rest/v1/rpc/{name}` with named JSON arguments":"POST `/rest/v1/rpc/{name}` com argumentos JSON nomeados",Auth:`Autenticação`,"POST signup; token grants password/refresh_token/pkce; GET user; POST logout":`POST signup; concessões de token password/refresh_token/pkce; GET user; POST logout`,Email:`E-mail`,"POST recover/magiclink/resend/verify":`POST recover/magiclink/resend/verify`,OAuth:`OAuth`,"Authorization URL with S256 PKCE; one-use code exchange":`URL de autorização com PKCE S256; troca de código de uso único`,Objects:`Objetos`,"POST/PUT/GET/DELETE `/storage/v1/object/{bucket}/{path}`, raw bytes":"POST/PUT/GET/DELETE `/storage/v1/object/{bucket}/{path}`, bytes brutos","Sharing/listing":`Compartilhamento/listagem`,"POST object/list and object/sign; local object/public URL construction":`POST object/list e object/sign; construção local de URL object/public`,Buckets:`Buckets`,"GET/POST bucket; GET/PUT/DELETE bucket/{id}":`GET/POST bucket; GET/PUT/DELETE bucket/{id}`,"The query grammar and server capabilities match the TypeScript contract.\nResponses become Rust Result values; empty bodies become JSON null (decode to\nunit or an appropriate Option). `Response<T>` carries status, count and headers.\nAuth/storage convenience methods return the decoded model or structured error.":"A gramática das consultas e os recursos do servidor correspondem ao contrato TypeScript. As respostas se tornam valores Result em Rust; corpos vazios se tornam JSON null (decodifique para unit ou um Option adequado). `Response<T>` contém status, contagem e cabeçalhos. Os métodos auxiliares de autenticação/armazenamento retornam o modelo decodificado ou um erro estruturado.","Unreleased cardinality preflight rejects HEAD and minimal writes with\n`single`/`maybe_single` before HTTP. Request write rows with `.select(...)`;\narray-returning RPC calls remain supported. Published 0.1.3 predates this guard.":"A validação prévia Unreleased de cardinalidade recusa HEAD e escritas mínimas com\n`single`/`maybe_single` antes de HTTP. Solicite as linhas de uma escrita com `.select(...)`;\nchamadas RPC que retornam arrays continuam aceitas. O 0.1.3 publicado é anterior a essa guarda.","HTTP error bodies larger than 64 KiB are discarded; status, a generic error\ncode and Retry-After remain available. Successful responses keep their existing\nbuffering or streaming contract.":`Corpos de erro HTTP maiores que 64 KiB são descartados; o status, um código
de erro genérico e Retry-After continuam disponíveis. Respostas bem-sucedidas mantêm
o contrato existente de leitura em memória ou streaming.`,"One Client and its clones share lifecycle coordination. Explicit token clones\ncontrol REST/storage and get_user only; other auth methods manage the shared\nlogin session. Refresh waiters share one background rotation task; cancelling\nor dropping them does not leave a task per waiter or stop an accepted rotation.\nDefault sessions never persist outside memory. Shared stores across independently\nconstructed clients/processes require their own coordination.":`Um Client e seus clones compartilham a coordenação do ciclo de vida. Clones com tokens explícitos controlam apenas REST/armazenamento e get_user; os outros métodos de autenticação gerenciam a sessão de login compartilhada. As chamadas de renovação compartilham uma tarefa em segundo plano; cancelar ou descartar essas chamadas não deixa uma tarefa por chamada nem interrompe a rotação já aceita. As sessões padrão nunca persistem fora da memória. Armazenamentos compartilhados entre clientes/processos construídos de forma independente exigem coordenação própria.`,"Unreleased token cancellation also covers authentication waiting for the lifecycle\ngate and session reads. It does not interrupt persistence of an accepted session;\ndetached refresh rotation keeps its existing owner. Logout still waits for that\nowner and clears locally even if revocation fails.\nThese changes require a new client package; server installation does not add them.":`O cancelamento de token Unreleased também cobre a autenticação que aguarda a trava
do ciclo de vida e as leituras de sessão. Ele não interrompe a persistência de uma sessão aceita;
a rotação de renovação desacoplada mantém seu responsável existente. O logout ainda espera por
esse responsável e limpa o estado local mesmo se a revogação falhar.
Essas alterações exigem um novo pacote do cliente; instalar o servidor não as adiciona.`,"On-demand and background refresh cap the configured margin at half the token\nlifetime. Short-lived fresh sessions and oversized margins do not cause a\nrotation on every request or timer tick; explicit refresh remains available.":`A renovação sob demanda e em segundo plano limita a margem configurada à metade da validade do token. Sessões novas de curta duração e margens muito grandes não provocam uma rotação a cada requisição ou disparo do temporizador; a renovação explícita continua disponível.`,"Generated models provide serde shapes, not compile-time verification of string\nqueries. Missing required selected columns fail decoding. Numeric precision is\npreserved by arbitrary_precision; write null and omitted fields differ.":`Os modelos gerados fornecem estruturas serde, sem verificar consultas em strings durante a compilação. A ausência de colunas selecionadas obrigatórias causa falha na decodificação. A precisão numérica é preservada por arbitrary_precision; campos omitidos e null na escrita são diferentes.`,"REST writes and RPC reject non-finite floating-point input, including nested\nfields, before HTTP. Serde must not silently turn NaN or infinity into JSON\nnull. Explicit null and omitted fields retain their existing semantics, and\nserialization runs once without adding dependencies.":`Escritas REST e RPC rejeitam valores de ponto flutuante não finitos, inclusive em campos aninhados, antes do HTTP. Serde não deve transformar NaN ou infinito em JSON null silenciosamente. Valores null explícitos e campos omitidos mantêm sua semântica, e a serialização ocorre uma única vez sem adicionar dependências.`,"Acceptance checks: SDK tests/doctests/examples, server HTTP contract tests,\nRust generator snapshot and generated model compile/serialization tests,\nClippy/rustfmt, docs, package verification and an external consumer smoke test.":`Verificações de aceitação: testes/doctests/exemplos do SDK, testes de contrato HTTP do servidor, snapshot do gerador Rust e testes de compilação/serialização dos modelos gerados, Clippy/rustfmt, documentação, verificação do pacote e teste básico com consumidor externo.`,"Prepared 0.1.3 retains the core HTTP contract and minimum versions of 0.1.2.\nIts refresh-margin/finite-input corrections and expanded lifecycle checks need\na new client build/package. Registry availability requires successful\npublication; server and SDK releases remain independent.":`O candidato preparado 0.1.3 mantém o contrato HTTP principal e as versões mínimas de 0.1.2. Suas correções de margem de renovação/entrada finita e verificações ampliadas de ciclo de vida exigem novo build/pacote do cliente. A disponibilidade no registro exige publicação bem-sucedida; as versões do servidor e SDK permanecem independentes.`},bt={"Releasing nelcota-client":`Publicar nelcota-client`,"The Rust package has independent semver. A release targets the documented\nserver protocol, rather than requiring matching server/package versions.":`O pacote Rust tem versionamento semântico independente. Uma publicação tem como alvo o protocolo documentado do servidor, sem exigir versões iguais do servidor e do pacote.`,"The maintainer needs ownership of `nelcota-client` on crates.io. Configure its\ntrusted publisher for GitHub owner `Nelcota`, repository `Nelcota`, workflow\n`sdk-rust-release.yml`, and environment `crates-io`. The GitHub-hosted publish\njob exchanges its OIDC identity for a short-lived token with\n`rust-lang/crates-io-auth-action`; it does not use a stored registry token.\nAfter a repository transfer, update the publisher's owner before releasing.\nThis repository does not contain registry credentials.":"O mantenedor precisa ser proprietário de `nelcota-client` no crates.io. Configure seu publicador confiável para o proprietário GitHub `Nelcota`, repositório `Nelcota`, workflow `sdk-rust-release.yml` e ambiente `crates-io`. O job de publicação hospedado pelo GitHub troca sua identidade OIDC por um token de curta duração com `rust-lang/crates-io-auth-action`; ele não usa um token de registro armazenado. Após transferir um repositório, atualize o proprietário do publicador antes de publicar. Este repositório não contém credenciais de registro.","Run SDK checks and `cargo test -p nelcota-server --test sdk_rust` with Docker.":"Execute as verificações do SDK e `cargo test -p nelcota-server --test sdk_rust` com Docker.","Run the Rust generator tests and external package consumer check.":`Execute os testes do gerador Rust e a verificação com um consumidor externo do pacote.`,"Update the package version, compatibility contract and changelog.":`Atualize a versão do pacote, o contrato de compatibilidade e o histórico de alterações.`,"Run `cargo publish -p nelcota-client --dry-run` from a clean checkout.":"Execute `cargo publish -p nelcota-client --dry-run` em um checkout limpo.","Push an intentional `rust-sdk-v<version>` tag to invoke sdk-rust-release.yml.":"Envie uma tag intencional `rust-sdk-v<version>` para acionar sdk-rust-release.yml.","The release workflow checks tag/version equality, repeats SDK checks and the\nreal HTTP/Postgres contracts, verifies the package and publishes in the\n`crates-io` environment. Publishing requires maintainer registry configuration;\nlocal implementation/testing does not publish or create tags.":"O workflow de publicação verifica se a tag corresponde à versão, repete as verificações do SDK e os contratos HTTP/Postgres reais, verifica o pacote e o publica no ambiente `crates-io`. A publicação exige a configuração do registro pelo mantenedor; implementar/testar localmente não publica nem cria tags.","Example external package check (after `cargo package -p nelcota-client`):":"Exemplo de verificação externa do pacote (após `cargo package -p nelcota-client`):","The consumer resolves the archive under Cargo's effective `target_directory`,\nincluding `CARGO_TARGET_DIR` and Cargo configuration. Use the same configuration\nfor packaging and verification. To run the archive-selection regressions:":"O consumidor resolve o arquivo no `target_directory` efetivo do Cargo,\nincluindo `CARGO_TARGET_DIR` e a configuração do Cargo. Use a mesma configuração\npara empacotar e verificar. Para executar as regressões de seleção do arquivo:","To intentionally verify default HTTPS outside the workspace:":`Para verificar intencionalmente o HTTPS padrão fora do workspace:`,"That makes one anonymous GET to example.com; an HTTP response proves TLS\ninitialized in the consumer process without Nelcota server startup.":`Isso faz um GET anônimo para example.com; uma resposta HTTP comprova que o TLS foi inicializado no processo consumidor sem iniciar o servidor Nelcota.`},xt={"Client contract":`Contrato do cliente`,"`@nelcota/client` 0.2.x targets the Nelcota HTTP protocol implemented by this\nrepository. The package has its own version; server compatibility is determined\nby the endpoints and features below, not by matching package version numbers.":"`@nelcota/client` 0.2.x usa o protocolo HTTP do Nelcota implementado neste repositório. O pacote tem versão própria; a compatibilidade com o servidor é determinada pelos endpoints e recursos abaixo, não por números de versão iguais.","Version scope":`Escopo de versão`,"The Unreleased fixes in this checkout require a new package: published 0.2.0\ndoes not include queued-login cancellation or exact bucket-limit writes below.":`As correções Unreleased deste checkout exigem um novo pacote: o 0.2.0 publicado
não inclui o cancelamento de logins na fila nem as escritas exatas de limites de bucket abaixo.`,"This is the 0.2.0 source/package candidate contract. Registry installation\nrequires successful publication; a server update does not install the client.\nPublished 0.1.2 predates native IndexedDB journaling and exact numeric\npreservation below; consult its bundled documentation for that release.":`Este é o contrato da fonte/pacote candidato 0.2.0. A instalação pelo registro exige publicação bem-sucedida; atualizar o servidor não instala o cliente. O pacote publicado 0.1.2 é anterior ao journal nativo no IndexedDB e à preservação numérica exata abaixo; consulte a documentação incluída nessa versão.`,Interface:`Interface`,Module:`Módulo`,Methods:`Métodos`,"HTTP contract":`Contrato HTTP`,REST:`REST`,"`from().select()`, filters, order, limit, range, single, maybeSingle":"`from().select()`, filtros, ordenação, limit, range, single, maybeSingle","`GET/HEAD /rest/v1/{table}`; encoded query; optional `Prefer: count=exact`; `Content-Range`":"`GET/HEAD /rest/v1/{table}`; consulta codificada; `Prefer: count=exact` opcional; `Content-Range`","REST writes":`Escritas REST`,"insert, update, delete, upsert, optional select":`insert, update, delete, upsert, select opcional`,"`POST/PATCH/DELETE /rest/v1/{table}`; JSON body; `Prefer: return=minimal/representation`; upsert resolution and `on_conflict`":"`POST/PATCH/DELETE /rest/v1/{table}`; corpo JSON; `Prefer: return=minimal/representation`; resolução de upsert e `on_conflict`",RPC:`RPC`,"`POST /rest/v1/rpc/{name}`; named JSON arguments; caller's role":"`POST /rest/v1/rpc/{name}`; argumentos JSON nomeados; papel do chamador",Auth:`Autenticação`,signUp:`signUp`,"`POST /auth/v1/signup`; session or `{user}` awaiting confirmation":"`POST /auth/v1/signup`; sessão ou `{user}` aguardando confirmação","password login, refresh, exchangeCode":`login por senha, renovação, exchangeCode`,"getUser, signOut":`getUser, signOut`,"Auth links":`Links de autenticação`,"recover, magic link, resend, verify/reset":`recuperação, link mágico, reenvio, verificação/redefinição`,OAuth:`OAuth`,"signInWithOAuth, handleRedirect":`signInWithOAuth, handleRedirect`,"`GET /auth/v1/authorize`; S256 PKCE; callback `?code=` exchanged once":"`GET /auth/v1/authorize`; PKCE S256; callback `?code=` trocado uma única vez",Storage:`Armazenamento`,"upload, replace, open/download, remove":`upload, replace, open/download, remove`,"`POST/PUT/GET/DELETE /storage/v1/object/{bucket}/{path}`; raw bytes":"`POST/PUT/GET/DELETE /storage/v1/object/{bucket}/{path}`; bytes brutos","list, signed URL, public URL":`listagem, URL assinada, URL pública`,Buckets:`Buckets`,"list, get, create, update, delete":`list, get, create, update, delete`,"`/storage/v1/bucket` and `/storage/v1/bucket/{id}`":"`/storage/v1/bucket` e `/storage/v1/bucket/{id}`","`schema` selects the generated TypeScript schema; the server's configured\nexposed schema determines the HTTP resource. It does not switch database schemas\nat runtime. RLS and GRANTs always remain server/Postgres decisions.":"`schema` seleciona o esquema TypeScript gerado; o esquema exposto configurado no servidor determina o recurso HTTP. Isso não troca esquemas do banco em tempo de execução. RLS e GRANTs continuam sendo decisões do servidor/Postgres.","Results and failures":`Resultados e falhas`,"Auth and storage return `{data,error}`. REST adds `status` and `count`; RPC\nadds `status`. Writes without `.select()` and HEAD responses return null.\nHEAD is typed as null, including chained selects. `single`/`maybeSingle`\nrequire a row representation and refuse minimal writes or HEAD before HTTP.\nA requested row representation that is empty or not a JSON array returns\n`invalid_response`; it never succeeds with null or another shape.":"Autenticação e armazenamento retornam `{data,error}`. REST adiciona `status` e `count`; RPC adiciona `status`. Escritas sem `.select()` e respostas HEAD retornam null. HEAD tem o tipo null, incluindo selects encadeados. `single`/`maybeSingle` exigem uma representação de linhas e rejeitam escritas mínimas ou HEAD antes do HTTP. Uma representação de linhas solicitada que esteja vazia ou não seja um array JSON retorna `invalid_response`; nunca é considerada bem-sucedida com null ou outro formato.","HTTP failures preserve server `code`, `message` and status. Network, abort,\ntimeout and interrupted buffered bodies return status 0 and client codes.":"Falhas HTTP preservam `code`, `message` e status do servidor. Rede, cancelamento, timeout e corpos interrompidos durante a leitura em memória retornam status 0 e códigos do cliente.","HTTP error bodies larger than 64 KiB are discarded; status, a generic code\nand Retry-After remain available.":`Corpos de erro HTTP maiores que 64 KiB são descartados; o status, um código genérico
e Retry-After continuam disponíveis.`,"Invalid JSON returns `invalid_response` with the response's HTTP status.":"JSON inválido retorna `invalid_response` com o status HTTP da resposta.","JSON numbers stay numeric when their decimal digits survive JavaScript\nconversion. Unsafe integers and decimals that would lose digits become\nstrings, including nested JSON values and RPC results. Generated `bigint`,\n`numeric`, `real` and `double precision` fields use `number | string`; regenerate\nschema types after upgrading. Pass exact values as strings in filters and\nwrites. PostgreSQL array elements may be null independently of column\nnullability; generated arrays therefore use `(T | null)[]`.":"Números JSON continuam numéricos quando seus dígitos decimais são preservados pela conversão em JavaScript. Inteiros fora da faixa segura e decimais que perderiam dígitos viram strings, inclusive em valores JSON aninhados e resultados de RPC. Campos gerados de tipos `bigint`, `numeric`, `real` e `double precision` usam `number | string`; gere novamente os tipos do esquema após atualizar. Passe valores exatos como strings em filtros e escritas. Elementos de arrays PostgreSQL podem ser nulos independentemente de a coluna aceitar nulos; por isso os arrays gerados usam `(T | null)[]`.","Scalar RPC result sets also allow null elements and group numeric unions as\n`(number | string | null)[]`. Functions returning view rows reference the\ngenerated `Views` section, while table rows reference `Tables`.":"Conjuntos de resultados escalares de RPC também permitem elementos nulos e agrupam uniões numéricas como `(number | string | null)[]`. Funções que retornam linhas de views referenciam a seção `Views` gerada, enquanto linhas de tabelas referenciam `Tables`.","Non-finite JSON input (`NaN` and infinities) throws `NelcotaUsageError` before\nauthentication or HTTP, instead of silently becoming null. Explicit nulls\nremain valid. Sessions require the complete session/user shape, with\n`expires_at` and `expires_in` as safe, non-negative integers;\n`refreshMargin` must be finite and non-negative.":"Valores JSON não finitos (`NaN` e infinitos) lançam `NelcotaUsageError` antes da autenticação ou do HTTP, em vez de virarem null silenciosamente. Valores null explícitos continuam válidos. Sessões exigem o formato completo de sessão e usuário, com `expires_at` e `expires_in` como inteiros seguros e não negativos; `refreshMargin` deve ser finito e não negativo.","Invalid developer configuration and unsafe identifiers/paths throw\n`NelcotaUsageError`. Errors thrown by user-supplied token/storage/fetch\nconfiguration outside the HTTP operation remain the caller's responsibility.":"Configurações inválidas do desenvolvedor e identificadores/caminhos inseguros lançam `NelcotaUsageError`. Erros lançados por configurações de token/armazenamento/fetch fornecidas pelo usuário fora da operação HTTP continuam sendo responsabilidade do chamador.","GET and HEAD retry network failures, body-read failures, 429 and 503; mutations,\nauth token exchange, storage listing and RPC are not automatically retried.":`GET e HEAD repetem tentativas após falhas de rede, leitura do corpo, 429 e 503; mutações, troca de tokens de autenticação, listagem de armazenamento e RPC não são repetidos automaticamente.`,"Timeout covers each attempt and its buffered body, excluding session refresh\nand the wait between retries. Retry-After up to 30 seconds is respected;\nlonger delays return the error immediately with `retryAfter` for the caller.":"O timeout cobre cada tentativa e seu corpo carregado em memória, excluindo a renovação de sessão e a espera entre tentativas. Retry-After de até 30 segundos é respeitado; atrasos maiores retornam o erro imediatamente com `retryAfter` para o chamador.","`storage.open()` hands the raw response to the caller. Subsequent stream\nerrors must be handled by the caller; `download()` buffers into a Blob and\nreturns body failures in its result.":"`storage.open()` entrega a resposta bruta ao chamador. Erros posteriores no stream devem ser tratados pelo chamador; `download()` carrega o corpo em um Blob e retorna falhas de leitura no resultado.","Sessions and lifecycle":`Sessões e ciclo de vida`,"Each client owns its session adapter. Native localStorage uses an IndexedDB\njournal as authoritative session state, with localStorage as a compatibility\nmirror. Elsewhere the default is a separate in-memory adapter. A custom adapter\ncan be sync or async. Instantiate a server client per request or supply a per-request token.\nThe default storage key includes the host and base path, so projects under\ndifferent paths cannot overwrite each other's sessions in a shared adapter.":`Cada cliente possui seu adaptador de sessão. O localStorage nativo usa um registro transacional no IndexedDB como estado oficial da sessão, com localStorage como espelho de compatibilidade. Nos demais ambientes, o padrão é um adaptador separado em memória. Um adaptador personalizado pode ser síncrono ou assíncrono. Instancie um cliente de servidor por requisição ou forneça um token por requisição. A chave padrão de armazenamento inclui o host e o caminho-base, para que projetos em caminhos diferentes não sobrescrevam as sessões uns dos outros em um adaptador compartilhado.`,"Default server-memory clients use independent coordination queues. A pending\nsign-in on another client cannot delay reading an unrelated request's session.":`Clientes de servidor com o armazenamento padrão em memória usam filas de coordenação independentes. Um login pendente em outro cliente não atrasa a leitura da sessão de uma requisição independente.`,"Refresh calls on one auth client share a promise. Clients sharing an adapter\nand storage key are serialized with Web Locks, with a module-local queue as a\nfallback. Native browser sessions also commit a refresh reservation before HTTP\nand read the replacement only after the IndexedDB transaction commits. Web Locks\nalone do not order another tab's localStorage visibility. Without Web Locks,\nthe journal rejects competing owners instead of waiting for their replacement.\nCustom shared adapters require Web Locks or external coordination; otherwise use\nper-tab sessionStorage. The module-local queue cannot coordinate separate tabs.":`Chamadas de renovação em um cliente de autenticação compartilham uma promise. Clientes que compartilham um adaptador e uma chave de armazenamento são serializados com Web Locks, com uma fila local ao módulo como alternativa. Sessões nativas do navegador também confirmam uma reserva de renovação antes do HTTP e leem a sessão substituta somente após a confirmação da transação do IndexedDB. Web Locks sozinhos não ordenam a visibilidade do localStorage em outra aba. Sem Web Locks, o registro rejeita proprietários concorrentes em vez de aguardar a sessão substituta. Adaptadores compartilhados personalizados exigem Web Locks ou coordenação externa; caso contrário, use sessionStorage por aba. A fila local ao módulo não coordena abas separadas.`,"Native persistence requires IndexedDB and bounds each database open and\ntransaction to five seconds. Connections close after every operation. A foreign\nunfinished reservation requires a new sign-in, an owning-client retry, or\nsignOut; it never falls back to the potentially spent token in localStorage.\nA committed logout supersedes dirty state in other clients and late refresh\nresponses cannot overwrite it. Broadcasts carry change notifications, not tokens.":`A persistência nativa exige IndexedDB e limita cada abertura do banco e transação a cinco segundos. As conexões fecham após cada operação. Uma reserva não concluída de outro proprietário exige um novo login, uma nova tentativa pelo cliente proprietário ou signOut; ela nunca recorre ao token possivelmente já usado do localStorage. Um logout confirmado substitui o estado não persistido em outros clientes, e respostas atrasadas de renovação não podem sobrescrevê-lo. As transmissões entre abas levam notificações de alteração, sem tokens.`,"Each native publication has a unique revision. Explicit sign-in captures the\nprior receipt before HTTP; failed publication retains the local replacement\nor logout while that exact receipt remains current, even with a foreign owner.\nA later committed revision supersedes it even when the value is identical.":`Cada publicação nativa possui uma revisão única. O login explícito captura o registro anterior antes do HTTP; falhas na publicação preservam a sessão substituta local ou o logout enquanto esse registro exato permanece atual, mesmo com outro proprietário. Uma revisão confirmada posterior a substitui mesmo quando o valor é idêntico.`,"The journal imports existing localStorage state once per storage key. Reload all\ntabs when upgrading to avoid mixing SDK coordination protocols. Use `signOut()`\nor clear all site data to remove sessions; editing only localStorage no longer\nchanges the authoritative session. Custom adapters retain their existing semantics.":"O registro importa o estado existente do localStorage uma vez por chave de armazenamento. Recarregue todas as abas ao atualizar para evitar misturar protocolos de coordenação do SDK. Use `signOut()` ou limpe todos os dados do site para remover sessões; editar apenas localStorage não altera mais a sessão oficial. Adaptadores personalizados preservam seu comportamento existente.","The refresh margin is capped at half the token lifetime, so short-lived tokens\nand large configured margins do not rotate fresh sessions repeatedly. Background\njitter stays within the scheduled delay. An already expired token waits ten\nseconds before a background attempt; explicit session reads still refresh it\nimmediately.":`A margem de renovação fica limitada à metade da validade do token, para que tokens de curta duração e margens configuradas altas não renovem sessões recém-criadas repetidamente. A variação aleatória em segundo plano permanece dentro do atraso programado. Um token já expirado espera dez segundos antes de uma tentativa em segundo plano; leituras explícitas da sessão ainda o renovam imediatamente.`,"Auth methods that perform HTTP accept `{signal,timeout}` as the last argument.\nSignals also cancel queued authentication before HTTP starts; withdrawing a\nwait never cancels another operation's lifecycle ownership. Once a response is\naccepted, its session publication can finish after the caller stops waiting.\nConcurrent refresh callers share the first caller's timeout. Signals cancel\neach caller's wait independently; rotation continues and persists its result\neven when a waiter cancels. An already aborted caller does not start rotation.\nREST/storage signals also cover waiting for the token source or session\nrefresh, without aborting an operation shared by other callers. `signOut()` waits\nfor a pending refresh and clears locally even when server revocation fails.\n`dispose()` stops timers, closes channels and clears listeners; it neither\nrevokes the session nor aborts requests already in flight.":`Os métodos de auth que fazem HTTP aceitam \`{signal,timeout}\` como último argumento.
Os sinais também cancelam a autenticação na fila antes de iniciar HTTP; deixar de
esperar nunca cancela a responsabilidade de outra operação pelo ciclo de vida. Quando uma resposta
é aceita, a publicação da sessão pode terminar depois que o chamador deixa de esperar.
Chamadores de renovação concorrentes compartilham o timeout do primeiro chamador. Os sinais cancelam
a espera de cada chamador de forma independente; a rotação continua e persiste seu resultado
mesmo quando alguém cancela a espera. Um chamador já cancelado não inicia uma rotação.
Os sinais de REST/storage também cobrem a espera pela fonte de token ou pela renovação
da sessão, sem cancelar uma operação compartilhada com outros chamadores. \`signOut()\` espera
por uma renovação pendente e limpa o estado local mesmo quando a revogação no servidor falha.
\`dispose()\` para timers, fecha canais e limpa listeners; não revoga a sessão
nem cancela requisições já em andamento.`,"Native PKCE verifiers use the same journal with a separate key. Consumption\ncommits a tombstone atomically, preventing stale native views from exchanging\nwith an older or already consumed verifier. Cancellation before consumption\nkeeps the verifier; once consumption starts, cancellation ends the caller's\nwait while the bounded exchange finishes and persists an accepted session.\nCustom adapters keep their existing storage API and keyed-lock coordination.":`Verificadores PKCE nativos usam o mesmo registro com uma chave separada. O consumo confirma atomicamente uma marca de remoção, impedindo que visões nativas desatualizadas façam trocas com um verificador antigo ou já consumido. O cancelamento antes do consumo preserva o verificador; após o início do consumo, o cancelamento encerra a espera do chamador enquanto a troca com prazo limitado termina e persiste uma sessão aceita. Adaptadores personalizados preservam a API de armazenamento existente e a coordenação por locks de chave.`,"Failed session writes keep the newer state in memory: this client never reloads\na spent refresh token or restores a signed-out session from stale storage.\nStorage errors still reject explicit auth methods. Unexpected background\nadapter errors are observed through the optional `auth.onBackgroundError`\nhandler; automatic refresh pauses until a session is written successfully.\nHandler exceptions are isolated. Network errors returned in results keep the\nexisting bounded refresh retry. Native clients block on another owner's\nunfinished reservation; an accepted replacement remains with its owner until\nit can be persisted or a newer committed session or logout supersedes it.\nCustom adapters require repair before sharing state that failed to persist.":"Falhas ao salvar a sessão preservam o estado mais recente na memória: este cliente nunca relê um token de renovação já usado nem restaura uma sessão encerrada a partir de dados antigos. Erros de armazenamento continuam rejeitando os métodos explícitos de autenticação. Erros inesperados dos adaptadores em segundo plano são observados pelo callback opcional `auth.onBackgroundError`; a renovação automática pausa até que uma sessão seja salva com sucesso. Exceções do callback ficam isoladas. Erros de rede retornados nos resultados mantêm as tentativas limitadas de renovação. Clientes nativos bloqueiam ao encontrar uma reserva não concluída de outro proprietário; uma sessão substituta aceita permanece com seu proprietário até ser persistida ou substituída por uma sessão ou logout confirmado mais recente. Adaptadores personalizados exigem correção antes de compartilhar estado que não foi persistido.","An explicit `accessToken` controls REST/storage requests and disables automatic\nsession refresh in the combined client. Auth methods remain available and may\nstore a session when called explicitly.":"Um `accessToken` explícito controla requisições REST/armazenamento e desativa a renovação automática de sessão no cliente combinado. Métodos de autenticação continuam disponíveis e podem armazenar uma sessão quando chamados explicitamente.","Bucket settings":`Configurações de buckets`,"Creation accepts `BucketSettings` with optional fields. Updating uses\n`BucketUpdateSettings`, requires `public`, `file_size_limit` and\n`allowed_mime_types`, and replaces the entire settings object with PUT.\nUse explicit null to clear a limit. Missing fields throw `NelcotaUsageError`\nbefore any HTTP request, including in JavaScript consumers.":"A criação aceita `BucketSettings` com campos opcionais. A atualização usa `BucketUpdateSettings`, exige `public`, `file_size_limit` e `allowed_mime_types` e substitui todo o objeto de configurações com PUT. Use null explícito para remover um limite. Campos ausentes lançam `NelcotaUsageError` antes de qualquer requisição HTTP, inclusive em consumidores JavaScript.","`Bucket.file_size_limit` is `number | string | null`. Limits beyond JavaScript's\nsafe integer range are returned as exact decimal strings, and bucket settings\naccept those strings for read-modify-write. Pass a positive canonical decimal\nstring for large int64 limits; the SDK sends it as an unquoted JSON integer.\nDo not first convert an exact string to `number`: JavaScript rounding cannot\nbe recovered. The server retains its positive-int64 range and settings validation;\ninvalid values return their existing HTTP errors. Non-finite numbers still throw\nbefore HTTP. Noncanonical decimal strings remain JSON-escaped and quoted.":`\`Bucket.file_size_limit\` é \`number | string | null\`. Limites além da faixa de inteiros
seguros do JavaScript são retornados como strings decimais exatas, e as configurações do bucket
aceitam essas strings para leitura, alteração e escrita. Passe uma string decimal canônica
positiva para limites int64 grandes; o SDK a envia como inteiro JSON sem aspas.
Não converta primeiro uma string exata para \`number\`: não é possível recuperar o arredondamento
do JavaScript. O servidor mantém as validações de int64 positivo e das configurações;
valores inválidos retornam os erros HTTP existentes. Números não finitos continuam lançando erro
antes de HTTP. Strings decimais não canônicas continuam escapadas e entre aspas no JSON.`,"Release acceptance":`Aceitação da publicação`,"Run `check`, unit/type tests, `build`, `size`, `test:package`, runtime smoke tests\nand `test:contract -- --browser`. CI tests Node 22/24/26, Bun, Deno and\nChromium/Firefox/WebKit. Edge hosts may consume the Web API implementation but\nare not included in this compatibility guarantee until tested on that host.":"Execute `check`, testes unitários/de tipos, `build`, `size`, `test:package`, testes básicos de ambientes de execução e `test:contract -- --browser`. A CI testa Node 22/24/26, Bun, Deno e Chromium/Firefox/WebKit. Hosts de borda podem consumir a implementação baseada em Web APIs, mas não fazem parte desta garantia de compatibilidade até serem testados nesse host."},St={"Releasing @nelcota/client":`Publicar @nelcota/client`,"The release workflow validates the tagged commit against the real server before\npublishing. Its reusable verification job runs the same package, runtime and\nbrowser checks as pull-request CI. A failing check prevents the publish job.":`O workflow de publicação valida o commit da tag com o servidor real antes de publicar. Seu job reutilizável de verificação executa as mesmas verificações de pacote, ambiente de execução e navegador da CI de pull requests. Uma falha em qualquer verificação impede o job de publicação.`,"Local candidate":`Versão candidata local`,"From `sdk/typescript`:":"Em `sdk/typescript`:","Set `NELCOTA_SDK_BROWSERS=chromium,firefox,webkit` to run all browser engines\nlocally. The default contract run uses Chromium. Bun and Deno smoke commands are\nlisted in the README. `npm pack` builds first, and the tarball contains only\ncompiled code, declarations, license, docs and examples. Inspect the candidate\nwith `npm pack --dry-run` before publishing.":"Defina `NELCOTA_SDK_BROWSERS=chromium,firefox,webkit` para executar todos os navegadores localmente. A execução padrão do contrato usa Chromium. Os comandos de teste básico para Bun e Deno estão no README. `npm pack` compila primeiro, e o tarball contém apenas código compilado, declarações, licença, documentação e exemplos. Inspecione a versão candidata com `npm pack --dry-run` antes de publicar.","npm account setup":`Configuração da conta npm`,"The maintainer needs access to the `@nelcota` scope. Authenticate locally with\n`npm login` and verify with `npm whoami`; never put a token in this repository.\nIf npm does not yet expose package settings, complete the initial authenticated\npublish of the validated candidate before configuring subsequent OIDC releases.\nUse `npm publish --access public` from this directory for that first publish.\nThe publication hook runs local checks; the integration gate must also have\npassed for the same source before this manual bootstrap.":"O mantenedor precisa de acesso ao escopo `@nelcota`. Autentique-se localmente com `npm login` e verifique com `npm whoami`; nunca coloque um token neste repositório. Se o npm ainda não disponibilizar as configurações do pacote, conclua a primeira publicação autenticada da versão candidata validada antes de configurar as próximas publicações com OIDC. Use `npm publish --access public` neste diretório para essa primeira publicação. O hook de publicação executa as verificações locais; a etapa de integração também deve ter passado para o mesmo código-fonte antes dessa configuração manual inicial.","Configure npm trusted publishing using:":`Configure a publicação confiável do npm com:`,"Owner: `Nelcota`":"Proprietário: `Nelcota`","Repository: `Nelcota`":"Repositório: `Nelcota`","Workflow filename: `sdk-release.yml`":"Nome do arquivo de workflow: `sdk-release.yml`","Environment: `npm`":"Ambiente: `npm`","The GitHub-hosted publish job uses `id-token: write`, not a stored npm token.\nSee the [official trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/)\nfor current account/setup requirements. Configure it when ready to publish:\nnew configurations require a first successful publish within two days.":"O job de publicação hospedado no GitHub usa `id-token: write`, sem armazenar um token npm. Veja as [instruções oficiais de publicação confiável](https://docs.npmjs.com/trusted-publishers/) para os requisitos atuais de conta/configuração. Configure quando estiver pronto para publicar: novas configurações exigem uma primeira publicação bem-sucedida em até dois dias.","Versioned release":`Publicação versionada`,"Update `package.json` and the lockfile version, and add a dated changelog\nentry. Keep server compatibility accurate; do not infer it from SemVer alone.":"Atualize `package.json` e a versão no arquivo de lock e adicione uma entrada datada ao histórico de alterações. Mantenha a compatibilidade com o servidor precisa; não a deduza apenas do SemVer.","Commit the reviewed SDK and workflow changes. Run/inspect CI on that commit.":`Faça commit das alterações revisadas do SDK e do workflow. Execute/inspecione a CI nesse commit.`,"Create `sdk-v<package version>` on that commit and push the tag. The workflow\nchecks that the tag matches package.json, verifies the commit and publishes.":"Crie `sdk-v<package version>` nesse commit e envie a tag. O workflow verifica se a tag corresponde ao package.json, verifica o commit e publica.","Confirm the workflow's publish succeeded and `npm view @nelcota/client version`\nreturns the new version. Install it in a fresh consumer before announcing it.":"Confirme que a publicação do workflow foi bem-sucedida e que `npm view @nelcota/client version` retorna a nova versão. Instale-a em um consumidor novo antes de anunciar.","Do not overwrite a published version. Fix a bad release with a new patch version\nand, when appropriate, deprecate the bad version with a concrete migration note.":`Não sobrescreva uma versão publicada. Corrija uma publicação com problemas usando uma nova versão de patch e, quando apropriado, marque a versão com problemas como obsoleta com uma nota concreta de migração.`},Ct={"nelcota-client":`nelcota-client`,"Async Rust SDK for Nelcota: REST tables/views and RPC, auth sessions and OAuth,\nand file storage under PostgreSQL RLS. For native applications using Tokio.":`SDK Rust assíncrono para Nelcota: tabelas/views REST e RPC, sessões de autenticação e OAuth e armazenamento de arquivos sob RLS do PostgreSQL. Para aplicativos nativos usando Tokio.`,"Requires Rust 1.88+ (checked in CI) and Nelcota server 0.3.0 or later.":`Requer Rust 1.88+ (verificado na CI) e servidor Nelcota 0.3.0 ou posterior.`,SDK:`SDK`,"Server baseline":`Versão-base do servidor`,Support:`Suporte`,"0.1.x":`0.1.x`,"Server `v0.3.0` or later":"Servidor `v0.3.0` ou posterior","Full HTTP/Postgres contract suite, OAuth, `update_user` and generated Rust models":"Suíte completa de contratos HTTP/Postgres, OAuth, `update_user` e modelos Rust gerados","Server `v0.2.0`":"Servidor `v0.2.0`","Not supported: lacks the OAuth routes, `PUT /auth/v1/user`, the JSON error contract and the Rust generator":"Não suportado: faltam as rotas OAuth, `PUT /auth/v1/user`, o contrato JSON de erros e o gerador Rust","Version scope":`Escopo de versão`,REST:`REST`,"Builders are local and consume `self`; clone a base query to reuse it. Only\n`execute` sends HTTP. Results are `Result<Response<T>, Error>`; response metadata\nincludes HTTP status, count and headers. Decode into your own `Deserialize`\nstructs or `serde_json::Value`. Column names and select expressions are checked\nby the server against its current catalog; these strings are not compile-time\nschema validation.":"Builders são locais e consomem `self`; clone uma consulta-base para reutilizá-la. Apenas `execute` envia HTTP. Resultados são `Result<Response<T>, Error>`; metadados de resposta incluem status HTTP, contagem e cabeçalhos. Decodifique para suas próprias structs `Deserialize` ou `serde_json::Value`. Nomes de colunas e expressões select são verificados pelo servidor com seu catálogo atual; essas strings não validam o esquema em tempo de compilação.","Filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in_values`,\n`not_in`, `is`/`is_null`, `not_is`, `not`, `matches`, `and`, `or`.\nConditions are constructed, never assembled from untrusted syntax strings.\nEmbedded filters use paths such as `items.qty`; `order_on`, `limit_on`,\n`range_on`, `and_on`, `or_on` target embedded rows. `order` calls accumulate.":"Filtros: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in_values`, `not_in`, `is`/`is_null`, `not_is`, `not`, `matches`, `and`, `or`. Condições são construídas, nunca montadas a partir de strings de sintaxe não confiáveis. Filtros de relacionamentos embutidos usam caminhos como `items.qty`; `order_on`, `limit_on`, `range_on`, `and_on`, `or_on` atuam sobre linhas embutidas. Chamadas de `order` se acumulam.","Writes return an empty body by default (`execute::<()>()`); call `select` for\nrepresentation. `single` requires exactly one row; `maybe_single` returns null\nfor zero rows (decode to `Option<T>`). Use `head().count_exact().execute::<()>()`\nfor count-only reads. Update/delete require a parent filter before any HTTP is\nsent. Exact counts scan all matching rows; only request them when needed.":"Escritas retornam corpo vazio por padrão (`execute::<()>()`); chame `select` para obter representação. `single` exige exatamente uma linha; `maybe_single` retorna null para zero linhas (decodifique para `Option<T>`). Use `head().count_exact().execute::<()>()` para leituras apenas de contagem. Atualizações/exclusões exigem filtro no recurso pai antes de enviar qualquer HTTP. Contagens exatas varrem todas as linhas correspondentes; solicite-as apenas quando necessário.","Each read returns at most `NELCOTA_MAX_ROWS` rows (1000 by default), even\nwithout `limit`. Page with `range(start, end)` or `limit` + `offset`, ordered\nby a unique column, until a page comes back empty; `count_exact()` gives the\ntotal when you need it.":"Cada leitura retorna no máximo `NELCOTA_MAX_ROWS` linhas (1000 por padrão), mesmo sem `limit`. Pagine com `range(start, end)` ou `limit` + `offset`, ordenando por uma coluna única, até uma página voltar vazia; `count_exact()` fornece o total quando necessário.",Auth:`Autenticação`,"Session storage defaults to memory. For a CLI or desktop app,\n`auth::FileStorage::new(path)` keeps the session in a JSON file, written\natomically and readable by its owner only (0600 on Unix). Implement\n`auth::SessionStorage` for a keychain, encrypted file or per-request cookie\nstore.":"O armazenamento de sessões usa memória por padrão. Para uma CLI ou aplicativo desktop, `auth::FileStorage::new(path)` mantém a sessão em arquivo JSON, escrito atomicamente e legível apenas pelo proprietário (0600 no Unix). Implemente `auth::SessionStorage` para um chaveiro, arquivo criptografado ou armazenamento de cookies por requisição."," Clones share one session,\nlifecycle lock and refresh result. Independent clients/processes sharing a\npersistent store need external coordination: the store interface alone does\nnot serialize refresh. A spent refresh token terminates its server session.":`Clones compartilham uma sessão, um bloqueio de ciclo de vida e o resultado da renovação. Clientes/processos independentes compartilhando armazenamento persistente precisam de coordenação externa: a interface de armazenamento, por si só, não serializa renovações. Um token de renovação já usado encerra sua sessão no servidor.`,"Refresh runs before expiry when a request needs a token. Opt-in background\nrefresh stops when its handle is dropped. Both paths cap the configured refresh\nmargin at half the token lifetime, avoiding repeated rotation of fresh\nshort-lived tokens. Rotation continues if a waiter is\ncancelled/dropped, so a consumed refresh token can still be replaced locally.\nA transient failure keeps the previous identity; an invalid grant clears the\nsession and returns the failure to the initiating request. Logout waits for\nrotation and clears locally even if server revocation fails. Existing access\ntokens may remain valid until expiry.":`A renovação ocorre antes da expiração quando uma requisição precisa de um token. A renovação opcional em segundo plano para quando seu handle é descartado. Ambos os caminhos limitam a margem configurada de renovação à metade da validade do token, evitando rotações repetidas de tokens novos de curta duração. A rotação continua se um chamador for cancelado ou descartado, para que um token de renovação consumido ainda possa ser substituído localmente. Uma falha transitória mantém a identidade anterior; uma concessão inválida limpa a sessão e retorna a falha à requisição que a iniciou. O logout aguarda a rotação e limpa a sessão local mesmo se a revogação no servidor falhar. Tokens de acesso existentes podem continuar válidos até a expiração.`,"In a backend, scope a caller token to a clone; this does not alter the shared\nsession or refresh the supplied token:":`Em um backend, restrinja um token do chamador a um clone; isso não altera a sessão compartilhada nem renova o token fornecido:`,"OAuth uses PKCE S256 with Google/GitHub. `begin_oauth` returns `PkceFlow { url,\nverifier }`; keep it private, open its URL in your application's browser flow,\nand consume it with `handle_redirect(&mut callback_url, flow)` or exchange the\ncode/verifier explicitly. The SDK does not open a browser or create a callback\nserver. `redirect_to` must be in `NELCOTA_OAUTH_REDIRECT_URLS`.":"OAuth usa PKCE S256 com Google/GitHub. `begin_oauth` retorna `PkceFlow { url, verifier }`; mantenha-o privado, abra sua URL no fluxo de navegador do aplicativo e consuma-o com `handle_redirect(&mut callback_url, flow)` ou troque explicitamente o código/verificador. O SDK não abre um navegador nem cria um servidor de callback. `redirect_to` deve estar em `NELCOTA_OAUTH_REDIRECT_URLS`.","Email links carry `#type=...&token=...`. `EmailLink::parse(&mut url)` extracts\nthe token and clears the fragment. Pass signup/magic links to\n`verify_email_link`; use `reset_password(token, password)` for recovery.\nSession, flow and link Debug implementations omit secret tokens.":"Links de e-mail contêm `#type=...&token=...`. `EmailLink::parse(&mut url)` extrai o token e limpa o fragmento. Passe links de cadastro/mágicos para `verify_email_link`; use `reset_password(token, password)` para recuperação. As implementações Debug de sessão, fluxo e link omitem tokens secretos.",Storage:`Armazenamento`,"Without an explicit `content_type`, uploads guess it from the name's extension\n(`json`, `csv`, `txt`, `html`, `css`, `js`, `svg`, `png`, `jpg`, `gif`, `webp`,\n`pdf`, `mp4` and other common types; see `storage::guess_content_type`) and\nfall back to `application/octet-stream`. `upload_reader` streams a Tokio reader. `open` returns a streaming\n`reqwest::Response`; handle 206, 304, ETag and stream failures yourself after it\nreturns. `download` buffers the file and reports body failures in its Result.\nUploads/downloads default to no deadline; scope a `RequestOptions` timeout when\nneeded. S3 redirects are followed; bearer tokens are stripped across origins.\nObject names are NFC-normalized and encoded per segment. Empty/dot segments,\nbackslashes and control characters are rejected.":"Sem `content_type` explícito, uploads inferem o tipo pela extensão do nome (`json`, `csv`, `txt`, `html`, `css`, `js`, `svg`, `png`, `jpg`, `gif`, `webp`, `pdf`, `mp4` e outros tipos comuns; veja `storage::guess_content_type`) e usam `application/octet-stream` como alternativa. `upload_reader` transmite um leitor Tokio. `open` retorna uma `reqwest::Response` em streaming; trate 206, 304, ETag e falhas do stream por conta própria após o retorno. `download` carrega o arquivo em memória e informa falhas no corpo em seu Result. Uploads/downloads não têm prazo por padrão; restrinja um timeout com `RequestOptions` quando necessário. Redirecionamentos S3 são seguidos; tokens bearer são removidos ao mudar de origem. Nomes de objetos são normalizados em NFC e codificados por segmento. Segmentos vazios/ponto, barras invertidas e caracteres de controle são rejeitados.","Buckets support list/get/create/update/delete, usually with `service_role`.\n`update_bucket` replaces all settings, so it takes a `BucketUpdate`, which has\nno `Default`: every field is explicit, and `None` clears a limit on purpose.\nStart from the current bucket to change one setting:":"Buckets suportam list/get/create/update/delete, geralmente com `service_role`. `update_bucket` substitui todas as configurações, então recebe um `BucketUpdate`, que não tem `Default`: cada campo é explícito, e `None` remove um limite intencionalmente. Parta do bucket atual para alterar uma configuração:","Authorization belongs to server RLS; a `service_role` token bypasses it and\nbelongs only in a trusted application.":"A autorização pertence à RLS do servidor; um token `service_role` a ignora e pertence apenas a um aplicativo confiável.","Rust schema types":`Tipos Rust do esquema`,"Generated modules expose `schema::table::{Row, Insert, Update, NAME,\nPRIMARY_KEY}` and `schema::rpc::function::{Args, Returns, NAME}`. Enum columns\nhave serde-renamed enums. Generated/identity-always columns are omitted from\nwrite models; views have write models except materialized views. Projections\nand embeds need structs matching their selected shape.":"Módulos gerados expõem `schema::table::{Row, Insert, Update, NAME, PRIMARY_KEY}` e `schema::rpc::function::{Args, Returns, NAME}`. Colunas enum têm enums renomeados pelo serde. Colunas geradas/identity-always são omitidas dos modelos de escrita; views têm modelos de escrita, exceto views materializadas. Projeções e relacionamentos embutidos precisam de structs que correspondam ao formato selecionado.","`Field::Omit` skips a write field, keeping its default/current value;\n`Field::Value(None)` sends explicit null for nullable columns. UUID/date/time\nand unknown scalar types use strings. Bigint uses i64, numeric uses\n`serde_json::Number` with arbitrary precision, and arrays allow null elements.\nRPC return aliases allow null; optional arguments distinguish omission from\nexplicit null. Types are generated from the configured exposed schema, without\nrequiring a DB connection when compiling consumer applications.":"`Field::Omit` omite um campo de escrita, mantendo seu valor padrão/atual; `Field::Value(None)` envia null explícito para colunas anuláveis. UUID/data/hora e tipos escalares desconhecidos usam strings. Bigint usa i64, numeric usa `serde_json::Number` com precisão arbitrária e arrays permitem elementos null. Aliases de retorno RPC permitem null; argumentos opcionais distinguem omissão de null explícito. Tipos são gerados a partir do esquema exposto configurado, sem exigir conexão com o banco ao compilar aplicativos consumidores.","Errors, deadlines and retries":`Erros, prazos e novas tentativas`,"`Error::code()`, `status()` and `retry_after()` preserve server facts.\nOther variants distinguish invalid input, network, timeout, cancellation,\ninvalid response, cardinality and session storage failures. No panic is used\nfor caller configuration or HTTP failures. Signed request URLs are omitted\nfrom transport error text. A response without a JSON body (a `head()` count, a\nproxy page) gets `unauthorized`, `forbidden`, `not_found`, `rate_limited`,\n`unavailable` or `http_<status>` as its code.":"`Error::code()`, `status()` e `retry_after()` preservam informações do servidor. Outras variantes distinguem entrada inválida, rede, timeout, cancelamento, resposta inválida, cardinalidade e falhas de armazenamento de sessão. Não há panic para configuração do chamador ou falhas HTTP. URLs assinadas de requisição são omitidas do texto de erro de transporte. Uma resposta sem corpo JSON (contagem com `head()`, página de proxy) recebe `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `unavailable` ou `http_<status>` como código.","When the server reports them, `sqlstate()`, `details()`, `hint()` and\n`constraint()` expose what Postgres said about a `db_error`; older servers send\nnone. Helpers classify common cases: `is_not_found()`, `is_conflict()`,\n`is_unique_violation()`, `is_rate_limited()`, `is_unauthorized()`,\n`is_forbidden()` and `is_retryable()`.":"Quando o servidor os informa, `sqlstate()`, `details()`, `hint()` e `constraint()` expõem o que o Postgres disse sobre um `db_error`; servidores antigos não enviam esses campos. Funções auxiliares classificam casos comuns: `is_not_found()`, `is_conflict()`, `is_unique_violation()`, `is_rate_limited()`, `is_unauthorized()`, `is_forbidden()` e `is_retryable()`.","Only GET/HEAD retry network/body-read failures and 429/503, default two retries.\nThe backoff has jitter and respects Retry-After (seconds or HTTP date); a delay\nover 30 seconds returns immediately. Mutations, auth exchange, RPC and POST\nstorage listings never retry automatically. Timeouts cover each attempt and\nbuffered body; refresh and backoff are separate. Drop a request future or use\n`CancellationToken` to cancel; an already accepted server write cannot be undone\nby cancelling the client. Raw stream lifetime is managed by reqwest/caller.":"Apenas GET/HEAD repetem tentativas após falhas de rede/leitura do corpo e 429/503, com duas novas tentativas por padrão. A espera progressiva tem variação aleatória e respeita Retry-After (segundos ou data HTTP); um atraso superior a 30 segundos retorna imediatamente. Mutações, troca de autenticação, RPC e listagens POST de armazenamento nunca se repetem automaticamente. Timeouts cobrem cada tentativa e o corpo carregado em memória; renovação e espera progressiva são separadas. Descarte o future da requisição ou use `CancellationToken` para cancelar; uma escrita já aceita pelo servidor não pode ser desfeita pelo cancelamento do cliente. O ciclo de vida do stream bruto é gerenciado pelo reqwest/chamador.",'`Client::builder(url).header("x-app", "notes")` adds a header to every request;\n`build` refuses invalid headers and `Authorization`, which comes from\n`access_token` or the session. Custom `http_client` instances must disable\ntheir own auth/mutation retries.\nThe default client uses explicit rustls/ring and Mozilla roots without a global\ncrypto-provider initialization. It can be reused across tasks.':'`Client::builder(url).header("x-app", "notes")` adiciona um cabeçalho a cada requisição; `build` recusa cabeçalhos inválidos e `Authorization`, que vem de `access_token` ou da sessão. Instâncias personalizadas de `http_client` devem desativar suas próprias novas tentativas de autenticação/mutação. O cliente padrão usa rustls/ring explícitos e raízes Mozilla sem inicialização global de provedor criptográfico. Pode ser reutilizado entre tarefas.',"Start with the [quickstart](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md)\n(local server, migration, generated types). The examples in `examples/` use\nthe shared [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql)\nschema. Empty results, 401/403 or a 1000-row cap? See\n[troubleshooting](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md).\nPortuguese guide: [quickstart.pt-BR.md](docs/quickstart.pt-BR.md).\nContract: [contract.md](docs/contract.md). Release: [releasing.md](docs/releasing.md).":"Comece pelo [início rápido](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md) (servidor local, migração, tipos gerados). Os exemplos em `examples/` usam o esquema compartilhado [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql). Resultados vazios, 401/403 ou limite de 1000 linhas? Veja [solução de problemas](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md). Guia em português: [quickstart.pt-BR.md](docs/quickstart.pt-BR.md). Contrato: [contract.md](docs/contract.md). Publicação: [releasing.md](docs/releasing.md).","This checkout prepares 0.1.3. The registry dependency above requires successful\npublication; use a local path/archive until then. Published 0.1.2 lacks the\nrefresh-margin/finite-input fixes and expanded lifecycle checks. Installing a\nserver release does not update clients. The minimum Rust/server versions and\nHTTP contract remain unchanged.":`Este checkout prepara 0.1.3. A dependência de registro acima exige publicação bem-sucedida; use path/arquivo local até lá. O pacote publicado 0.1.2 não contém as correções de margem de renovação/entrada finita e as verificações ampliadas de ciclo de vida. Instalar uma versão do servidor não atualiza clientes. As versões mínimas de Rust/servidor e o contrato HTTP permanecem iguais.`},wt={"@nelcota/client":`@nelcota/client`,"JavaScript and TypeScript client for [Nelcota](https://github.com/Nelcota/Nelcota/): the\nREST API under RLS, auth and storage.":`Cliente JavaScript e TypeScript para [Nelcota](https://github.com/Nelcota/Nelcota/): API REST sob RLS, autenticação e armazenamento.`,"Start with the [quickstart](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md)\n(also in [Portuguese](docs/quickstart.pt-BR.md)), the\n[runnable examples](examples/) (their schema is\n[examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql))\nor the [client contract](docs/contract.md). Empty results, 401/403 or a\n1000-row cap? See [troubleshooting](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md).":`Comece pelo [início rápido](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md) (também em [português](docs/quickstart.pt-BR.md)), pelos [exemplos executáveis](examples/) (seu esquema é [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql)) ou pelo [contrato do cliente](docs/contract.md). Resultados vazios, 401/403 ou limite de 1000 linhas? Veja [solução de problemas](https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md).`,"**Thin.** Operations map directly to HTTP; session refresh and read retries\nmay add requests. There is no hidden data cache, and\nPostgres (GRANTs and RLS) decides what a call may do.":`**Enxuto.** Operações correspondem diretamente ao HTTP; renovação de sessão e novas tentativas de leitura podem adicionar requisições. Não há cache oculto de dados, e o Postgres (GRANTs e RLS) decide o que uma chamada pode fazer.`,"**No runtime dependencies.** It uses `fetch`, Web Crypto, `AbortSignal`,\nWeb Locks and `BroadcastChannel`, and runs in browsers, Node 22+, Deno,\nBun. Edge hosts need the same Web APIs and host-specific validation.\nESM only, side-effect free, with subpath exports\n(`/rest`, `/auth`, `/storage`).":"**Sem dependências de execução.** Usa `fetch`, Web Crypto, `AbortSignal`, Web Locks e `BroadcastChannel` e executa em navegadores, Node 22+, Deno e Bun. Hosts de borda precisam das mesmas Web APIs e de validação específica do host. Apenas ESM, sem efeitos colaterais, com exportações por subcaminho (`/rest`, `/auth`, `/storage`).","**Typed from your schema** by `nelcota types`, down to the embeds in a\n`select` string.":"**Tipado a partir do seu esquema** por `nelcota types`, incluindo os relacionamentos embutidos em uma string `select`.","**Safe by construction.** Input never becomes query syntax, storage paths\ncannot climb out of their bucket, and a `service_role` token is refused in\na browser.":"**Seguro por construção.** Entradas nunca se tornam sintaxe de consulta, caminhos de armazenamento não podem sair do bucket e um token `service_role` é recusado no navegador.","In plain JavaScript, omit the generated type and generic parameter:":`Em JavaScript puro, omita o tipo gerado e o parâmetro genérico:`,"Version scope":`Escopo de versão`,"Independent modules":`Módulos independentes`,"Each entry includes its transport without importing the other feature modules.\n`createRestClient<Database>(url)` also accepts generated schema types.":"Cada entrada inclui seu transporte sem importar os outros módulos de recursos. `createRestClient<Database>(url)` também aceita tipos de esquema gerados.","Results and errors":`Resultados e erros`,"Every call resolves to `{ data, error }` and never throws for HTTP or\nnetwork failures. `error` is a `NelcotaError`:":"Cada chamada resolve para `{ data, error }` e nunca lança exceções por falhas HTTP ou de rede. `error` é um `NelcotaError`:","`status`: the HTTP status, or `0` when no response arrived.":"`status`: o status HTTP ou `0` quando nenhuma resposta chegou.","`code`: the server's code untouched (`user_already_exists`,\n`invalid_grant`, `db_error`, `rate_limited`...), or a client code:\n`network_error`, `timeout`, `aborted`, `invalid_response`, `not_single`,\n`session_missing`, `pkce_missing`. A response without a JSON body (a HEAD\ncount, a proxy page) gets `unauthorized`, `forbidden`, `not_found`,\n`rate_limited`, `unavailable` or `http_<status>`. The `NelcotaErrorCode`\ntype lists the known codes and still accepts any string.":"`code`: o código do servidor intacto (`user_already_exists`, `invalid_grant`, `db_error`, `rate_limited`...) ou um código do cliente: `network_error`, `timeout`, `aborted`, `invalid_response`, `not_single`, `session_missing`, `pkce_missing`. Uma resposta sem corpo JSON (contagem HEAD, página de proxy) recebe `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `unavailable` ou `http_<status>`. O tipo `NelcotaErrorCode` lista os códigos conhecidos e ainda aceita qualquer string.","`retryAfter`: seconds to wait, after a 429 or 503.":"`retryAfter`: segundos a esperar após um 429 ou 503.","`sqlstate`, `details`, `hint`, `constraint`: what Postgres reported for a\n`db_error` (`23505`, `Key (slug)=(a) already exists.`, `notes_slug_key`),\nwhen the server sends them; `undefined` otherwise.":"`sqlstate`, `details`, `hint`, `constraint`: o que o Postgres informou para um `db_error` (`23505`, `Key (slug)=(a) already exists.`, `notes_slug_key`), quando o servidor os envia; `undefined` caso contrário.","A programming mistake (an invalid column name, a `..` in a file path, a\n`service_role` token in a browser) throws a `NelcotaUsageError` before\nanything is sent.":"Um erro de programação (nome de coluna inválido, `..` no caminho de arquivo, token `service_role` no navegador) lança `NelcotaUsageError` antes de qualquer envio.","Custom token/storage adapters may throw their own errors. A response returned\nby `storage.open()` is caller-owned: handle errors while reading its stream.":"Adaptadores personalizados de token/armazenamento podem lançar seus próprios erros. Uma resposta retornada por `storage.open()` pertence ao chamador: trate erros ao ler seu stream.","To use exceptions instead, call `.throwOnError()` on a query (its result\ntype then has no error branch) or pass any result to `unwrap`, which\nreturns `data` or throws the `NelcotaError`:":"Para usar exceções, chame `.throwOnError()` em uma consulta (seu tipo de resultado passa a não ter ramo de erro) ou passe qualquer resultado para `unwrap`, que retorna `data` ou lança o `NelcotaError`:","Tables, views and functions":`Tabelas, views e funções`,"Filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`,\n`is` (`null`, `true`, `false`, `'unknown'`), `not(column, op, value)`,\n`match({...})`, `or(...)` and `and(...)`. A column path such as\n`orders.total` filters an embed. Builders are immutable, so a base query can\nbe reused.":"Filtros: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is` (`null`, `true`, `false`, `'unknown'`), `not(column, op, value)`, `match({...})`, `or(...)` e `and(...)`. Um caminho de coluna como `orders.total` filtra um relacionamento embutido. Builders são imutáveis, então uma consulta-base pode ser reutilizada.",'`like`/`ilike` read `*` (or `%`) as "any text". Wrap text a person typed in\n`escapeLike` so `%` and `_` match literally:':'`like`/`ilike` interpretam `*` (ou `%`) como "qualquer texto". Envolva o texto digitado por uma pessoa em `escapeLike` para que `%` e `_` correspondam literalmente:',"`update` and `delete` need at least one filter; the server refuses them\notherwise. `count: 'exact'` scans every matching row, so ask for it only\nwhen you show it.":"`update` e `delete` precisam de pelo menos um filtro; caso contrário, o servidor os recusa. `count: 'exact'` varre todas as linhas correspondentes, então solicite apenas quando for mostrar a contagem.","HEAD queries return `data: null`. `single()` and `maybeSingle()` require\nrows: use `.select()` on writes first, and omit `head: true`.":"Consultas HEAD retornam `data: null`. `single()` e `maybeSingle()` exigem linhas: use `.select()` primeiro nas escritas e omita `head: true`.",Paging:`Paginação`,"The server returns at most `NELCOTA_MAX_ROWS` rows per request (1000 by\ndefault), even without a `limit`. Page with `range(from, to)` or\n`limit(n)` + `offset(n)`, and read `range` (the rows returned, from\n`Content-Range`) and `count` (with `count: 'exact'`) to know whether more\nrows exist:":"O servidor retorna no máximo `NELCOTA_MAX_ROWS` linhas por requisição (1000 por padrão), mesmo sem `limit`. Pagine com `range(from, to)` ou `limit(n)` + `offset(n)` e leia `range` (as linhas retornadas, de `Content-Range`) e `count` (com `count: 'exact'`) para saber se há mais linhas:","To walk every row, `pages(size)` requests one page after another until an\nempty one, so a server cap below `size` cannot cut it short. Order by a\nunique column so pages neither overlap nor skip rows; a failed page throws\nits `NelcotaError`:":"Para percorrer todas as linhas, `pages(size)` solicita uma página após a outra até uma vazia, então um limite do servidor menor que `size` não encerra a leitura antes da hora. Ordene por uma coluna única para que páginas não se sobreponham nem pulem linhas; uma página com falha lança seu `NelcotaError`:",Auth:`Autenticação`,"**Sessions.** In browsers, native `localStorage` uses an IndexedDB journal\nas the authoritative session state and mirrors committed sessions to\n`localStorage`. Elsewhere sessions stay in memory. Pass `auth: { storage }`\nto use a custom adapter, for example a cookie adapter for server-side\nrendering. Anything with `getItem`/`setItem`/`removeItem` works, sync or async.":"**Sessões.** Em navegadores, o `localStorage` nativo usa um registro transacional no IndexedDB como estado oficial da sessão e espelha as sessões confirmadas no `localStorage`. Nos demais ambientes, as sessões ficam em memória. Passe `auth: { storage }` para usar um adaptador personalizado, como um adaptador de cookies para renderização no servidor. Qualquer implementação com `getItem`/`setItem`/`removeItem` funciona, de forma síncrona ou assíncrona.","Browser storage can be read by any script on the page, so the usual XSS\nhygiene applies (a Content Security Policy, no untrusted HTML). The session\nholds a short-lived access token (15 minutes by default) and a refresh\ntoken that rotates on every use.":`O armazenamento do navegador pode ser lido por qualquer script da página, então se aplicam os cuidados usuais contra XSS: uma Content Security Policy e nenhum HTML não confiável. A sessão contém um token de acesso de curta duração, por padrão de 15 minutos, e um token de renovação que é rotacionado a cada uso.`,"**Refresh.** The access token is refreshed in the background before it\nexpires, and again right before a request when needed.":`**Renovação.** O token de acesso é renovado em segundo plano antes de expirar e novamente logo antes de uma requisição, quando necessário.`,"The server ends a session whose refresh token is used twice, so refreshes\nare coordinated:":`O servidor encerra uma sessão cujo token de renovação é usado duas vezes, então as renovações são coordenadas:`,"One refresh at a time in a process, however many requests are waiting.":`Uma renovação por vez em um processo, independentemente de quantas requisições aguardam.`,"Across tabs, a Web Lock serializes refreshes. A committed IndexedDB\nreceipt hands the replacement to the next owner even when its\n`localStorage` view is stale. A reservation is committed before HTTP.":"Entre abas, um Web Lock serializa as renovações. Um registro confirmado no IndexedDB entrega a sessão substituta ao próximo proprietário mesmo quando sua visão do `localStorage` está desatualizada. Uma reserva é confirmada antes do HTTP.","Native browser persistence requires IndexedDB. Storage failures reject\nexplicit auth calls; observe automatic refresh failures with\n`auth.onBackgroundError`. If an owner disappears during rotation or cannot\nsave its replacement, another client refuses to reuse the reserved token.\nRetry from the owning client, sign in again, or call `signOut()` to clear it.":"A persistência nativa no navegador exige IndexedDB. Falhas de armazenamento rejeitam chamadas explícitas de autenticação; observe falhas de renovação automática com `auth.onBackgroundError`. Se um proprietário desaparecer durante a rotação ou não conseguir salvar a sessão substituta, outro cliente se recusa a reutilizar o token reservado. Repita a tentativa pelo cliente proprietário, faça login novamente ou chame `signOut()` para limpar a sessão.","Without Web Locks, a local queue coordinates clients in the same module\ninstance. The native journal prevents competing owners from spending a\nreserved token, but cannot make them wait for the replacement. Custom shared\nadapters need Web Locks or external coordination; use\n`auth: { storage: sessionStorage }` for separate per-tab sessions.\nKeep the same storage key when sharing a session adapter.":"Sem Web Locks, uma fila local coordena clientes na mesma instância do módulo. O registro nativo impede que proprietários concorrentes usem um token reservado, mas não faz com que aguardem a sessão substituta. Adaptadores compartilhados personalizados precisam de Web Locks ou coordenação externa; use `auth: { storage: sessionStorage }` para sessões separadas por aba. Mantenha a mesma chave de armazenamento ao compartilhar um adaptador de sessão.","Failed sign-in/logout publication keeps the newer local state while the exact\nprior journal revision remains current, even if another client wrote that\nprior revision. A new committed revision supersedes it, including an explicit\npublication of the same value.":`Falhas ao publicar login ou logout preservam o estado local mais recente enquanto a revisão anterior exata do registro permanece atual, mesmo se outro cliente tiver gravado essa revisão anterior. Uma nova revisão confirmada a substitui, incluindo uma publicação explícita do mesmo valor.`,"If a refresh fails for a transient reason, the old token is still sent. The\nrequest then fails with 401 instead of silently running as a visitor.":`Se uma renovação falhar por motivo transitório, o token antigo ainda é enviado. A requisição então falha com 401 em vez de executar silenciosamente como visitante.`,"**OAuth (Google, GitHub)** uses PKCE, with the verifier kept in this\nbrowser:":`**OAuth (Google, GitHub)** usa PKCE, com o verificador mantido neste navegador:`,"`redirectTo` must be listed in the server's `NELCOTA_OAUTH_REDIRECT_URLS`.\nEach storage key holds one pending OAuth verifier: starting another sign-in\nreplaces the previous attempt. Verifier publication, navigation and callback\nconsumption use the same lock so asynchronous work cannot reorder them. Use\nseparate storage keys for independent login flows.":`\`redirectTo\` deve estar listado em \`NELCOTA_OAUTH_REDIRECT_URLS\` do servidor.
Cada chave de storage mantém um verificador OAuth pendente: iniciar outro login
substitui a tentativa anterior. A gravação do verificador, o redirecionamento e
o consumo no callback usam o mesmo bloqueio para impedir que operações
assíncronas invertam essa ordem. Use chaves de storage diferentes para fluxos
de login independentes.`,"Native PKCE publication and consumption also use the IndexedDB journal, so\nstale localStorage cannot supply an older verifier or reuse a consumed one.\nAn already cancelled exchange keeps its verifier. Once consumption begins,\nthe bounded exchange persists an accepted session even if its caller cancels\nthe wait; the first exchange's timeout still applies.":`A publicação e o consumo nativos de PKCE também usam o registro no IndexedDB, para que um localStorage desatualizado não forneça um verificador antigo nem reutilize um já consumido. Uma troca já cancelada preserva seu verificador. Após o início do consumo, a troca com prazo limitado persiste uma sessão aceita mesmo se o chamador cancelar a espera; o timeout da primeira troca continua valendo.`,"**Email links** arrive as `https://your.app/page#type=...&token=...`.\n`readEmailLink()` takes the token and removes it from the address bar and\nhistory:":"**Links de e-mail** chegam como `https://your.app/page#type=...&token=...`. `readEmailLink()` extrai o token e o remove da barra de endereço e do histórico:","**On a server**, forward the caller's token instead of keeping a session:":`**No servidor**, encaminhe o token do chamador em vez de manter uma sessão:`,"Auth HTTP methods take `{ signal, timeout }` as their last argument. Concurrent\nrefresh calls share the first caller's timeout; each caller can cancel its own\nwait independently. Once rotation starts, it finishes and saves the new token\neven if a waiter cancels. REST/storage cancellation also covers waiting for a\ntoken or session refresh. `signOut()` waits for a\npending refresh. Call `nelcota.dispose()` (or `auth.dispose()` for the standalone\nclient) to stop timers and close channels when the client is no longer used.":"Métodos HTTP de autenticação recebem `{ signal, timeout }` como último argumento. Chamadas concorrentes de renovação compartilham o timeout do primeiro chamador; cada chamador pode cancelar sua própria espera de forma independente. Após iniciar, a rotação termina e salva o novo token mesmo se uma espera for cancelada. O cancelamento REST/armazenamento também cobre a espera por um token ou renovação de sessão. `signOut()` aguarda uma renovação pendente. Chame `nelcota.dispose()` (ou `auth.dispose()` para o cliente independente) para parar timers e fechar canais quando o cliente não for mais usado.","A `service_role` token bypasses RLS. Use it only on a trusted server; in a\nbrowser the client refuses it.":"Um token `service_role` ignora a RLS. Use-o apenas em servidor confiável; no navegador, o cliente o recusa.",Storage:`Armazenamento`,"**Uploads** send the bytes as they are (no multipart). A `ReadableStream`\nis streamed without buffering where the runtime supports it (Node, Deno,\nBun; browsers over HTTP/2).":"**Uploads** enviam os bytes como estão (sem multipart). Um `ReadableStream` é transmitido sem carregar tudo em memória onde o ambiente suporta isso (Node, Deno, Bun; navegadores por HTTP/2).","**`open(name, { range, ifNoneMatch, download })`** returns the raw\n`Response`, for streaming `response.body`, resuming with ranges (206) or\nrevalidating with ETags (304).":"**`open(name, { range, ifNoneMatch, download })`** retorna a `Response` bruta, para transmitir `response.body`, retomar com intervalos (206) ou revalidar com ETags (304).","**Names** are normalized to NFC and encoded segment by segment. Empty,\n`.` and `..` segments, control characters and backslashes are refused.":"**Nomes** são normalizados em NFC e codificados segmento por segmento. Segmentos vazios, `.` e `..`, caracteres de controle e barras invertidas são recusados.","**Buckets** are managed with `createBucket`, `updateBucket`,\n`deleteBucket`, `getBucket` and `listBuckets`, usually as `service_role`.\n`updateBucket` replaces every setting and requires all three fields:":"**Buckets** são gerenciados com `createBucket`, `updateBucket`, `deleteBucket`, `getBucket` e `listBuckets`, geralmente como `service_role`. `updateBucket` substitui todas as configurações e exige os três campos:","Use explicit `null` to clear a size or MIME limit. Partial updates are refused\nbefore HTTP, so an omitted field cannot silently clear an existing restriction.":"Use `null` explícito para remover um limite de tamanho ou MIME. Atualizações parciais são recusadas antes do HTTP, para que um campo omitido não remova silenciosamente uma restrição existente.","Who may read or write which file is up to the policies on\n`storage.objects`; see the server's\n[storage docs](https://github.com/Nelcota/Nelcota/blob/main/docs/storage.md).":"Quem pode ler ou escrever cada arquivo depende das políticas de `storage.objects`; veja a [documentação de armazenamento](https://github.com/Nelcota/Nelcota/blob/main/docs/storage.md) do servidor.",Recipes:`Receitas`,"Polling for changes":`Consultar alterações periodicamente`,"There is no realtime channel. For a UI showing the latest 100 notes, refresh a\nbounded snapshot. This example assumes an initialized `nelcota` client and a\n`render` function that replaces the displayed list:":"Não há canal realtime. Para uma UI mostrando as 100 notas mais recentes, atualize um snapshot limitado. O exemplo pressupõe um cliente `nelcota` inicializado e uma função `render` que substitui a lista exibida:","This refreshes visible UI state; it is not durable event delivery or a complete\nhistory export. Do not infer exactly-once delivery from timestamps or increasing\nIDs: equal timestamps, page caps and transaction commit order can skip rows in\ncursor recipes. Use stable ordering for pagination. For committed changes, use\nthe server's webhook contract with durable receiver deduplication.":`Isso atualiza o estado visível da UI; não é entrega durável de eventos nem exportação de todo o histórico. Timestamps ou IDs crescentes não garantem entrega exatamente uma vez: timestamps iguais, limites de página e ordem de commit das transações podem fazer receitas com cursor perderem linhas. Use ordenação estável na paginação. Para mudanças confirmadas, use o contrato de webhooks do servidor com deduplicação durável no receptor.`,"Server-side rendering with cookies":`Renderização no servidor com cookies`,"On a server that renders pages for signed-in users, keep the session in\ncookies instead of memory, with a client created **per request**. The adapter\nbelow works with any framework's cookie API (Next.js `cookies()`, Express\n`req.cookies`/`res.cookie`, Hono, SvelteKit...):":"Em um servidor que renderiza páginas para usuários autenticados, mantenha a sessão em cookies em vez de memória, com um cliente criado **por requisição**. O adaptador abaixo funciona com a API de cookies de qualquer framework (Next.js `cookies()`, Express `req.cookies`/`res.cookie`, Hono, SvelteKit...):","`httpOnly` keeps tokens away from page scripts. This adapter is illustrative:\nuser metadata can make a session exceed the browser's cookie-size limit, and\npercent encoding increases its size. Use bounded sessions or a server-side store\nwith an opaque cookie identifier; handle decoding and storage failures. Framework\nhandlers must be allowed to write/delete cookies with matching path/domain flags.\nProtect state-changing routes from CSRF. Never authorize from cached user metadata\nalone; the server must verify the caller's token.":"`httpOnly` mantém tokens longe dos scripts da página. Este adaptador é ilustrativo: metadados do usuário podem exceder o limite de tamanho de cookies do navegador, e percent encoding aumenta seu tamanho. Use sessões limitadas ou armazenamento no servidor com um identificador opaco no cookie; trate falhas de decodificação e armazenamento. Handlers do framework precisam poder gravar/excluir cookies com path/domain correspondentes. Proteja rotas que alteram estado contra CSRF. Nunca autorize apenas com metadados de usuário em cache; o servidor deve verificar o token do solicitante.","Refreshes from separate requests need shared coordination. An in-process lock\ncannot serialize several server instances; centralize rotation in a shared\ncoordinator and let handlers reuse the accepted replacement.\n`autoRefresh: false` (already the default outside browsers) keeps background\ntimers out of a request-scoped client; a token about to expire is still\nrefreshed before a request.":"Renovações de requisições diferentes precisam de coordenação compartilhada. Um bloqueio dentro do processo não serializa várias instâncias do servidor; centralize a rotação em um coordenador compartilhado e permita que handlers reutilizem a substituição aceita. `autoRefresh: false` (já padrão fora de navegadores) evita timers em segundo plano em um cliente por requisição; um token perto de expirar ainda é renovado antes da requisição.",Options:`Opções`,"Every builder takes `.abortSignal(signal)` and `.timeout(ms)`; the other\ncalls take `{ signal, timeout }`.":"Cada builder aceita `.abortSignal(signal)` e `.timeout(ms)`; as outras chamadas aceitam `{ signal, timeout }`.","Retries wait up to 30 seconds for `Retry-After`. A longer delay returns the\nerror immediately with `retryAfter`, allowing the app to decide when to retry.":"Novas tentativas aguardam até 30 segundos por `Retry-After`. Um atraso maior retorna o erro imediatamente com `retryAfter`, permitindo ao aplicativo decidir quando tentar novamente.",Compatibility:`Compatibilidade`,"Server baseline":`Versão-base do servidor`,Support:`Suporte`,"Server `v0.3.0` or later":"Servidor `v0.3.0` ou posterior","Full contract suite, OAuth routes, `updateUser`, exposed CORS headers and generated `Relationships`":"Suíte completa de contratos, rotas OAuth, `updateUser`, cabeçalhos CORS expostos e `Relationships` gerados","Server `v0.2.0`":"Servidor `v0.2.0`","Not supported: lacks the OAuth routes, `PUT /auth/v1/user`, the JSON error contract, generated `Relationships` and the newer exposed headers":"Não suportado: faltam as rotas OAuth, `PUT /auth/v1/user`, o contrato JSON de erros, `Relationships` gerados e os cabeçalhos expostos mais recentes","Release verification covers Node 22/24/26, Bun, Deno and the Chromium, Firefox\nand WebKit engines. Other runtimes need their own validation.":`A verificação de publicação cobre Node 22/24/26, Bun, Deno e os motores Chromium, Firefox e WebKit. Outros ambientes de execução precisam de validação própria.`,Development:`Desenvolvimento`,"The contract run starts Postgres and Mailpit in containers and the server\nfrom `target/debug`, applies `test/contract/fixture.sql` and generates the\ntypes with `nelcota types`. It then runs the contract tests (including a\nfuzz of the query encoding) and, with `--browser`, a Chromium page on\nanother origin.":"A execução do contrato inicia Postgres e Mailpit em contêineres e o servidor a partir de `target/debug`, aplica `test/contract/fixture.sql` e gera os tipos com `nelcota types`. Depois executa os testes de contrato (incluindo fuzz da codificação de consultas) e, com `--browser`, uma página Chromium em outra origem.","Set `NELCOTA_SDK_BROWSERS=chromium,firefox,webkit` to exercise all browser\nengines. Browser checks include the runnable demo, simultaneous refresh across\ntwo real tabs and sign-out broadcasts. Each run owns unique container names\nand dynamically assigned ports, so it can coexist with development services.":"Defina `NELCOTA_SDK_BROWSERS=chromium,firefox,webkit` para exercitar todos os navegadores. As verificações incluem a demonstração executável, renovação simultânea em duas abas reais e broadcasts de logout. Cada execução tem nomes únicos de contêineres e portas atribuídas dinamicamente, então pode coexistir com serviços de desenvolvimento.","See [releasing.md](https://github.com/Nelcota/Nelcota/blob/main/sdk/typescript/docs/releasing.md) (in the repository) for the account setup, candidate checks\nand tagged release procedure. [CHANGELOG.md](CHANGELOG.md) tracks SDK changes.":`Veja [releasing.md](https://github.com/Nelcota/Nelcota/blob/main/sdk/typescript/docs/releasing.md) (no repositório) para configuração da conta, verificações da versão candidata e procedimento de publicação por tag. [CHANGELOG.md](CHANGELOG.md) acompanha as alterações do SDK.`,"Create this client per request. `validatedCallerToken` is a token or null from\nmiddleware that validates Bearer syntax and returns 401 for malformed headers.\nOnly an absent header means anonymous; do not turn malformed auth into a visitor.\nThe runnable [server example](examples/server.mjs) demonstrates validation and\nforwarding to RLS. `accessToken` disables automatic session refresh; explicitly\ncalled auth methods still store sessions.":"Crie esse cliente por requisição. `validatedCallerToken` é um token ou null vindo de middleware que valida a sintaxe Bearer e retorna 401 para cabeçalhos malformados. Apenas a ausência de cabeçalho significa acesso anônimo; não transforme autenticação inválida em visitante. O [exemplo de servidor](examples/server.mjs) demonstra validação e encaminhamento para RLS. `accessToken` desativa renovação automática; métodos de autenticação chamados explicitamente ainda armazenam sessões.","On upgrade, the journal imports the existing `localStorage` session once.\nReload all open tabs to avoid mixing old and new coordination protocols.\nUse `signOut()` or clear all site data to remove native sessions; editing\nonly `localStorage` no longer changes authoritative session state.\nSigning out also clears the pending OAuth verifier from the journal and\nits storage mirror, including when no session exists or server logout fails.":"Na atualização, o registro importa uma vez a sessão existente do `localStorage`. Recarregue todas as abas abertas para evitar misturar os protocolos de coordenação antigo e novo. Use `signOut()` ou limpe todos os dados do site para remover sessões nativas; editar apenas `localStorage` não altera mais o estado oficial da sessão.\nSair também limpa o verificador OAuth pendente do journal e de seu espelho de armazenamento, inclusive quando não existe sessão ou o logout no servidor falha.","This checkout prepares 0.2.0; the registry command above requires its successful\npublication. Until then, install a locally packed archive. Published 0.1.2 lacks\nnative IndexedDB session/PKCE journaling, exact numeric preservation and the\nlatest cancellation/sign-out cleanup fixes. Read each package's bundled README\nfor its contract. Updating the server does not update installed clients.\nNode is SDK tooling/runtime, not a backend requirement.":`Este checkout prepara 0.2.0; o comando de registro acima exige sua publicação bem-sucedida. Até lá, instale um arquivo empacotado localmente. O pacote publicado 0.1.2 não contém o journal nativo de sessões/PKCE no IndexedDB, preservação numérica exata e as correções recentes de cancelamento/limpeza ao sair. Leia o README incluído em cada pacote para seu contrato. Atualizar o servidor não atualiza clientes instalados. Node é ferramenta/runtime do SDK, não requisito do backend.`,"0.2.x":`0.2.x`},Tt={Storage:`Armazenamento`,"Files with the same rule as everything else: **Postgres decides access.**\nEach file is a row in `storage.objects`; RLS policies on that table say who\nmay upload, read, replace or delete it. The bytes live on the server's disk\nor in any S3-compatible bucket. The design and its reasons are D77–D80 in\n[decisions.md](decisions.md).":"Os arquivos seguem a mesma regra de todo o sistema: **o Postgres decide o acesso.** Cada arquivo é uma linha em `storage.objects`; as políticas RLS dessa tabela determinam quem pode enviar, ler, substituir ou apagar o arquivo. Os bytes ficam no disco do servidor ou em qualquer bucket compatível com S3. O projeto e seus motivos estão nas decisões D77–D80 em [decisions.md](decisions.md).",Prerequisites:`Pré-requisitos`,"You need initialized storage metadata, an enabled disk/S3 backend and policies\nfor your caller. Examples assume an authenticated user and explicit bucket setup.\nThis page describes source behavior; check the matching release for published\nlimits and fixes. Keep provider secrets in the private deployment configuration.":`Você precisa de metadados de armazenamento inicializados, backend disco/S3 ativo e políticas para seu solicitante. Os exemplos pressupõem usuário autenticado e criação explícita do bucket. Esta página descreve a fonte; confira a versão correspondente para limites e correções publicados. Mantenha segredos do provedor na configuração privada do deploy.`,"Turning it on":`Como ativar`,"New projects (`nelcota init`) keep files on the project's disk:":"Projetos novos (`nelcota init`) guardam os arquivos no disco do projeto:","In production, an S3-compatible bucket keeps files off a single disk\n(Cloudflare R2, Backblaze B2, AWS S3, Wasabi...):":`Em produção, um bucket compatível com S3 evita depender de um único disco (Cloudflare R2, Backblaze B2, AWS S3, Wasabi...):`,"Then `nelcota -p <name> up`. Without `NELCOTA_STORAGE_BACKEND` storage is off\nand `/storage/v1` does not exist. A project created before storage existed\nturns it on by adding the two `disk` lines to its `.env` and\n`- ./storage:/storage` to the app's `volumes` in `docker-compose.yml`\n(`mkdir storage && chown 65532:65532 storage` first).":"Depois, execute `nelcota -p <name> up`. Sem `NELCOTA_STORAGE_BACKEND`, o armazenamento fica desligado e `/storage/v1` não existe. Para ativá-lo em um projeto criado antes desse recurso, adicione as duas linhas de `disk` ao `.env` e `- ./storage:/storage` aos `volumes` do app em `docker-compose.yml` (antes, execute `mkdir storage && chown 65532:65532 storage`).","On Unix, the CLI creates the disk storage root with mode **0700**, owned by\nthe app's UID 65532 on Docker hosts. The server also enforces 0700 at startup\non existing roots, before opening the store. This prevents other host users\nfrom reading or enumerating private files, including staged uploads and old\nfiles, regardless of their individual modes. The server must own the root\nand be allowed to change its permissions. Windows deployments require the\nequivalent directory ACL; Unix modes do not configure Windows ACLs.":`No Unix, a CLI cria a pasta raiz do armazenamento em disco com permissões **0700**, pertencente ao UID 65532 do app nos hosts Docker. O servidor também aplica 0700 às pastas existentes na inicialização, antes de abrir o armazenamento. Isso impede outros usuários do host de ler ou listar arquivos privados, incluindo envios em preparação e arquivos antigos, independentemente das permissões individuais. O servidor deve ser dono da pasta e poder alterar suas permissões. No Windows, configure a ACL equivalente na pasta; permissões Unix não configuram ACLs do Windows.`,Variable:`Variável`,Default:`Padrão`,"50 MiB":`50 MiB`,"largest file; a bucket can only lower it":`maior tamanho por arquivo; um bucket só pode diminuir esse limite`,none:`nenhum`,"cap on all buckets together, in bytes":`limite total de todos os buckets, em bytes`,"1 GiB":`1 GiB`,"disk backend: refuse uploads that would leave less free space":`armazenamento em disco: recusa envios que deixariam menos espaço livre`,"shared deadline for admission, database/policy waits and receiving bytes":`prazo compartilhado para admissão, esperas pelo banco/políticas e recebimento dos bytes`,"the API's":`o da API`,"origin of public file URLs, e.g. `https://files.shop.com`":"origem das URLs de arquivos públicos, por exemplo `https://files.shop.com`","Uploads reserve capacity while their bodies are being received. A request\nwithout `Content-Length` reserves up to its allowed file size or the remaining\ncapacity; another upload may receive 507 until that reservation is released.\nThe committed total is checked in a serialized database transaction, including\nwhen several server instances share the same database. Replacements receive\ncredit for their old bytes against the total quota, but still need disk space\nfor the new version while it is being written.":"Os envios reservam capacidade enquanto seus corpos são recebidos. Uma requisição sem `Content-Length` reserva até o tamanho permitido para o arquivo ou a capacidade restante; outro envio pode receber 507 até a liberação da reserva. O total confirmado é verificado em uma transação serializada no banco, inclusive quando várias instâncias do servidor compartilham o mesmo banco. Nas substituições, os bytes antigos são descontados da cota total, mas ainda é necessário espaço em disco para gravar a nova versão.","At most **32 uploads** may be active in a process. Excess attempts return\n`503 upload_busy` immediately. Admission and byte reception share the configured\ndeadline, including pool and quota waits (`408 upload_timeout`); metadata\npublication then settles with database timeouts so cancellation cannot delete\nbytes after an ambiguous commit.":"Um processo pode ter no máximo **32 envios** ativos. Tentativas excedentes recebem `503 upload_busy` imediatamente. A admissão e o recebimento dos bytes compartilham o prazo configurado, incluindo esperas pelo pool e pela cota (`408 upload_timeout`); a publicação dos metadados é concluída com os limites de tempo do banco, para que um cancelamento não apague bytes após um commit de resultado incerto.","Canceled or timed-out multipart uploads abort their uploaded parts in a bounded\ncleanup task. Creation and cleanup share the 32-upload capacity; creation may\nsettle for up to 30 seconds and abort for up to 10 seconds after cancellation.\nConfigure an S3 `AbortIncompleteMultipartUpload` lifecycle rule as well: process\ncrashes, unavailable providers or an initiation response lost before its upload\nID arrives cannot be cleaned up reliably by the server. Object garbage\ncollection only sees completed objects, not unfinished multipart parts.":"Uploads multipart cancelados ou que excedem o prazo abortam as partes enviadas em uma tarefa de limpeza limitada. A criação e a limpeza compartilham a capacidade de 32 uploads; a criação pode levar até 30 segundos e o abortamento até 10 segundos após o cancelamento. Configure também uma regra de ciclo de vida S3 `AbortIncompleteMultipartUpload`: quedas do processo, provedores indisponíveis ou a perda da resposta de criação antes de receber o ID do upload impedem uma limpeza confiável pelo servidor. A coleta de objetos órfãos só enxerga objetos concluídos, não partes multipart incompletas.","`storage.usage` holds the committed byte total. Statement-level triggers update\nit transactionally for inserts, updates, deletes, upserts and truncation,\nincluding administrative SQL; bulk statements aggregate their changes once.\nOnly the internal storage role can read it. No caller role can modify it.\nThe migration initializes it while metadata writes are locked. If an operator\ndisabled triggers during maintenance, reconcile before resuming writes:":"`storage.usage` guarda o total de bytes confirmado. Triggers por instrução o atualizam de forma transacional em inserções, atualizações, exclusões, upserts e truncamentos, incluindo SQL administrativo; operações em lote agregam suas mudanças uma única vez. Só o papel interno do armazenamento pode lê-lo. Nenhum papel de quem chama a API pode alterá-lo. A migração inicializa esse total enquanto as gravações de metadados estão bloqueadas. Se um operador desativou triggers durante a manutenção, faça a reconciliação antes de retomar as gravações:","Buckets and policies":`Buckets e políticas`,"A bucket is a row in `storage.buckets`. Create it in a migration (or with\n`POST /storage/v1/bucket` as `service_role`):":"Um bucket é uma linha em `storage.buckets`. Crie-o em uma migração (ou com `POST /storage/v1/bucket` como `service_role`):","**Until a policy says otherwise, nobody but `service_role` reaches any file.**\n`public` only opens reads through `/object/public/`; writes to a public bucket\nstill go through the policies.":"**Até que uma política permita, apenas `service_role` acessa qualquer arquivo.** `public` libera somente leituras por `/object/public/`; gravações em um bucket público continuam sujeitas às políticas.",Operation:`Operação`,"Policies needed":`Políticas necessárias`,"upload (`POST`)":"envio (`POST`)","replace (`PUT`)":"substituição (`PUT`)","download, sign, list":`download, assinatura e listagem`,delete:`exclusão`,"`owner` is filled with `auth.uid()` on upload, so `owner = auth.uid()` is the\nsimplest private-files policy. Helpers for paths:\n`storage.foldername('a/b/c.png')` → `{a,b}`, `storage.filename(...)` →\n`c.png`, `storage.extension(...)` → `png`. A policy sees the final row,\nincluding `size`, so a per-user quota is a policy too:":"`owner` recebe `auth.uid()` no envio, por isso `owner = auth.uid()` é a política mais simples para arquivos privados. Funções auxiliares para caminhos: `storage.foldername('a/b/c.png')` → `{a,b}`, `storage.filename(...)` → `c.png`, `storage.extension(...)` → `png`. A política vê a linha final, incluindo `size`, portanto uma cota por usuário também pode ser uma política:","Bucket names: lowercase letters, digits, `-` and `_`; `public`, `sign` and\n`list` are reserved. A bucket with files cannot be dropped.":"Nomes de buckets: letras minúsculas, números, `-` e `_`; `public`, `sign` e `list` são reservados. Um bucket com arquivos não pode ser apagado.","HTTP API":`API HTTP`,"Every route takes the usual `Authorization: Bearer <jwt>` (none = `anon`).\nPaths are percent-encoded; segments cannot be empty, `.` or `..`.":"Todas as rotas aceitam o cabeçalho habitual `Authorization: Bearer <jwt>` (sem ele = `anon`). Os caminhos usam codificação percentual; os segmentos não podem estar vazios nem ser `.` ou `..`.",Route:`Rota`,"upload a new file (201)":`enviar um arquivo novo (201)`,"upload or replace (200 replaced, 201 created)":`enviar ou substituir (200 para substituição, 201 para criação)`,"download under the caller's policies":`baixar conforme as políticas de quem faz a chamada`,"download from a public bucket, no token":`baixar de um bucket público, sem token`,'`{"expires_in": 3600}` → `{"signed_url": "..."}` (up to 7 days)':'`{"expires_in": 3600}` → `{"signed_url": "..."}` (até 7 dias)',"download with a signed URL, no token":`baixar com uma URL assinada, sem token`,"delete (204)":`apagar (204)`,"buckets (writes: `service_role`)":"buckets (gravações: `service_role`)","Listing applies `limit` and `offset` independently to the sorted `folders` and\n`objects` arrays. Advance the offset by the requested limit while either array\nfills a page; a page containing only folders can still have a next page.":"A listagem aplica `limit` e `offset` separadamente aos arrays ordenados `folders` e `objects`. Avance o deslocamento pelo limite solicitado enquanto qualquer um dos arrays preencher uma página; uma página só com pastas ainda pode ter uma próxima página.",'A file the caller may not see answers 404, as if it did not exist. Downloads\ntake `?download` to force a "save as". Errors: 400 `invalid_path`, 404\n`bucket_not_found`/`object_not_found`, 409 `object_exists`, 413\n`file_too_large`, 415 `mime_type_not_allowed`, 507 `storage_full`. The JSON\nendpoints (bucket writes, list, sign) answer 400/422 `invalid_body` for a\nmalformed body and 415 `unsupported_media_type` without `Content-Type:\napplication/json`; a range that cannot be served is 416\n`range_not_satisfiable` (with `Content-Range: bytes */<size>`). Every error\nhas the API\'s JSON shape (see [api.md](api.md#errors)).':"Um arquivo que a pessoa não pode ver responde 404, como se não existisse. Downloads aceitam `?download` para forçar “salvar como”. Erros: 400 `invalid_path`, 404 `bucket_not_found`/`object_not_found`, 409 `object_exists`, 413 `file_too_large`, 415 `mime_type_not_allowed`, 507 `storage_full`. Os endpoints JSON (gravação de buckets, listagem e assinatura) respondem 400/422 `invalid_body` para um corpo malformado e 415 `unsupported_media_type` sem `Content-Type: application/json`; um intervalo que não pode ser servido recebe 416 `range_not_satisfiable` (com `Content-Range: bytes */<size>`). Todos os erros usam o formato JSON da API (veja [api.md](api.md#errors)).","How files are served":`Como os arquivos são servidos`,'**The type comes from the bytes**, not from the client: a "PNG" that is\nreally HTML is stored as `text/html` (and refused by an `image/*` bucket).':"**O tipo vem dos bytes**, não do cliente: um “PNG” que na verdade é HTML é armazenado como `text/html` (e recusado por um bucket `image/*`).","**Files are inert.** Every response has `X-Content-Type-Options: nosniff` and\n`Content-Security-Policy: sandbox`. Only images (not SVG), audio, video and\nplain text open in the browser; HTML, SVG, PDF and the rest download.\nFor public files on their own origin, point `NELCOTA_STORAGE_PUBLIC_URL` at\na second domain that proxies `/storage/v1/object/public/*` to the app.":"**Os arquivos são inertes.** Todas as respostas incluem `X-Content-Type-Options: nosniff` e `Content-Security-Policy: sandbox`. Apenas imagens (exceto SVG), áudio, vídeo e texto simples abrem no navegador; HTML, SVG, PDF e os demais formatos são baixados. Para servir arquivos públicos em uma origem própria, aponte `NELCOTA_STORAGE_PUBLIC_URL` para um segundo domínio que encaminhe `/storage/v1/object/public/*` ao app.","**Disk:** `Range` (video seeking, resumed downloads), `ETag` and\n`If-None-Match`. Public files are cacheable for 60 s; private ones are\nrevalidated each time.":"**Disco:** `Range` (busca em vídeos e retomada de downloads), `ETag` e `If-None-Match`. Arquivos públicos podem ficar em cache por 60 s; os privados são revalidados a cada acesso.","**S3:** downloads are a `302` to a presigned URL valid for at most 5 minutes;\nthe bytes come straight from the provider.":"**S3:** os downloads recebem um `302` para uma URL pré-assinada válida por no máximo 5 minutos; os bytes vêm diretamente do provedor.",Consistency:`Consistência`,"A file's bytes are stored under a new key (`<bucket>/<uuidv7>`) on every\nupload, and the row is written only after the bytes are complete. Readers\nnever see a half-written file, and an upload that fails or is refused leaves\nnothing behind. Replacing or deleting a file removes the old bytes right\naway: **a database restore does not bring deleted files back**. An hourly\ncollector removes bytes no row points to once they are a day old (left by a\ncrash mid-upload).":"Os bytes de um arquivo são armazenados sob uma nova chave (`<bucket>/<uuidv7>`) em cada envio, e a linha só é gravada quando todos os bytes chegam. Quem lê nunca vê um arquivo incompleto, e um envio que falha ou é recusado não deixa resíduos. Substituir ou apagar um arquivo remove os bytes antigos imediatamente: **restaurar o banco não recupera arquivos apagados**. Um coletor executado a cada hora remove bytes sem referência em nenhuma linha quando eles completam um dia (resíduos de uma falha durante o envio).",Backups:`Backups`,"With the disk backend, every dump has its own `<dump>.files/` snapshot and\nSHA-256 manifest. `nelcota backup --upload` uploads that immutable snapshot to\n`s3://<backup bucket>/<project>/<dump>.files/`. Later file deletions leave older\nsnapshots intact. After losing the server:":"No armazenamento em disco, cada dump tem seu próprio snapshot `<dump>.files/` e manifesto SHA-256. `nelcota backup --upload` envia esse snapshot imutável para `s3://<backup bucket>/<project>/<dump>.files/`. Exclusões posteriores não alteram os snapshots antigos. Após perder o servidor:","`--files` verifies and restores that dump's snapshot, locally or from the backup\nbucket. Keep the `.dump` and `.dump.files/` directory together. With the S3 backend the\nfiles never leave the provider; use its versioning or replication if you need\nmore copies.":"`--files` verifica e restaura o snapshot desse dump, localmente ou a partir do bucket de backup. Mantenha o `.dump` e a pasta `.dump.files/` juntos. No armazenamento S3, os arquivos permanecem no provedor; use versionamento ou replicação se precisar de mais cópias.",Leaving:`Exportação`,"The metadata is plain SQL (`storage.objects`), the bytes are ordinary files or\nS3 objects. To get them back under their names:":"Os metadados são SQL comum (`storage.objects`), e os bytes são arquivos comuns ou objetos S3. Para recuperá-los com seus nomes:","Related guides":`Guias relacionados`,"See [REST API](api.md), [backup](backup.md), [JWT/roles](jwt-and-roles.md) and [troubleshooting](troubleshooting.md).":`Veja [API REST](api.md), [backup](backup.md), [JWT/papéis](jwt-and-roles.md) e [solução de problemas](troubleshooting.md).`},Et={Troubleshooting:`Resolver problemas`,'The usual surprises, what causes them and how to fix them. Errors are\n`{"code", "message"}` JSON; the SDKs expose them as `error.code` /\n`Error::code()`. Newer servers also send `sqlstate`, `details`, `hint` and\n`constraint` for database errors.':'As dúvidas mais comuns, suas causas e como resolvê-las. Os erros são JSON no formato `{"code", "message"}`; os SDKs os expõem como `error.code` / `Error::code()`. Servidores mais recentes também enviam `sqlstate`, `details`, `hint` e `constraint` nos erros do banco.',"A query returns `[]`, but the rows exist":"A consulta retorna `[]`, mas as linhas existem","Row-level security filtered them. RLS never fails a read: rows the policies\ndo not allow simply are not there for this caller. Check:":`A segurança por linha filtrou os dados. A RLS não faz uma leitura falhar: as linhas que as políticas não permitem simplesmente não existem para quem faz a chamada. Confira:`,"**Who is asking.** Without a session the request runs as `anon`; with one,\nas `authenticated` with `auth.uid()` = the user's id. A row owned by\nanother user is invisible, as intended.":"**Quem está consultando.** Sem sessão, a requisição roda como `anon`; com sessão, como `authenticated`, com `auth.uid()` = id do usuário. Uma linha pertencente a outro usuário fica invisível, como esperado.","**The policy.** `USING (owner = auth.uid())` only matches rows whose\n`owner` was set. Rows inserted from the SQL editor or a migration have the\n`owner` you gave them (or `NULL`, since `auth.uid()` is empty there).":"**A política.** `USING (owner = auth.uid())` só corresponde a linhas cujo `owner` foi definido. Linhas inseridas pelo editor SQL ou por uma migração têm o `owner` que você atribuiu (ou `NULL`, pois `auth.uid()` fica vazio nesses contextos).","**Policies for the role.** A policy `TO authenticated` does not apply to\n`anon`. With RLS enabled and no policy for a role, that role sees nothing.":"**As políticas do papel.** Uma política `TO authenticated` não se aplica a `anon`. Com RLS ativada e nenhuma política para um papel, ele não vê nenhuma linha.","The same goes for `update` and `delete`: changing zero rows is a success, not\nan error. To be sure a row changed, ask for it back\n(`.update({...}).eq('id', id).select('id')`) and check the result.":"O mesmo vale para `update` e `delete`: alterar zero linhas é um sucesso, não um erro. Para confirmar a alteração, peça a linha de volta (`.update({...}).eq('id', id).select('id')`) e confira o resultado.","A write that violates a policy's `WITH CHECK` *is* an error: 401/403\n`db_error` with `new row violates row-level security policy` (`42501`).":"Uma gravação que viola o `WITH CHECK` de uma política *é* um erro: 401/403 `db_error` com `new row violates row-level security policy` (`42501`).","401 or 403 with a valid token":`401 ou 403 com um token válido`,"The role has no **GRANT** on the table, so Postgres refuses before RLS is\neven consulted: `db_error`, `permission denied for table notes (42501)`.\nVisitors (`anon`) get 401 (signing in may help); signed-in users get 403.":"O papel não tem **GRANT** na tabela, então o Postgres recusa o acesso antes mesmo de consultar a RLS: `db_error`, `permission denied for table notes (42501)`. Visitantes (`anon`) recebem 401 (entrar pode resolver); usuários logados recebem 403.","Functions called through `rpc` need `GRANT EXECUTE`. Storage needs policies on\n`storage.objects` ([storage.md](storage.md)).":"Funções chamadas por `rpc` precisam de `GRANT EXECUTE`. O armazenamento precisa de políticas em `storage.objects` ([storage.md](storage.md)).","A 401 `invalid_token` is different: the token is malformed, expired or\nsigned by another key (a token from another project, or from before\n`nelcota dev` was reset). Sign in again; the SDKs refresh tokens on their\nown while the refresh token is valid.":"Um 401 `invalid_token` é diferente: o token está malformado, expirado ou assinado com outra chave (de outro projeto ou anterior à redefinição de `nelcota dev`). Entre novamente; os SDKs renovam os tokens sozinhos enquanto o refresh token for válido.","`email_not_confirmed` on sign-in":"`email_not_confirmed` ao entrar","The server has `NELCOTA_EMAIL_CONFIRMATION_URL` set, so a new account must\nopen the link sent by email before it can sign in with a password. Sign-up\nanswers with the user and no session while it waits. Send the link again\nwith `resendConfirmation(email)` (`resend_confirmation` in Rust). Locally,\n`nelcota dev` leaves confirmation off.":"O servidor tem `NELCOTA_EMAIL_CONFIRMATION_URL` configurado, então uma conta nova precisa abrir o link enviado por email antes de entrar com senha. Enquanto aguarda, o cadastro retorna o usuário sem uma sessão. Reenvie o link com `resendConfirmation(email)` (`resend_confirmation` no Rust). Localmente, `nelcota dev` deixa a confirmação desligada.","`redirect_not_allowed` when starting an OAuth sign-in":"`redirect_not_allowed` ao iniciar um login OAuth","`redirectTo` must match one of the comma-separated\n`NELCOTA_OAUTH_REDIRECT_URLS`: same scheme, host and port, and a path equal\nto or under the listed one. `http://localhost:5173/auth/callback` and\n`http://127.0.0.1:5173/auth/callback` are different origins. Restart the\nserver after changing the variable.":"`redirectTo` deve corresponder a uma das `NELCOTA_OAUTH_REDIRECT_URLS`, separadas por vírgula: mesmo protocolo, host e porta, e um caminho igual ou abaixo do configurado. `http://localhost:5173/auth/callback` e `http://127.0.0.1:5173/auth/callback` são origens diferentes. Reinicie o servidor após alterar a variável.","Types do not match the database":`Os tipos não correspondem ao banco`,"`nelcota types` writes a snapshot of the schema. After a migration, run it\nagain (`nelcota types -o src/database.ts`, or `--lang rust`), otherwise new\ncolumns are unknown to the compiler and removed ones still compile, failing\nonly at run time with `invalid_query` or `db_error`. Running it in CI and\nfailing on a diff catches stale files.":"`nelcota types` gera um retrato do schema. Após uma migração, execute novamente (`nelcota types -o src/database.ts` ou `--lang rust`); caso contrário, o compilador não conhece colunas novas e continua aceitando as removidas, com falhas só em execução: `invalid_query` ou `db_error`. Executar isso no CI e falhar quando houver diferenças detecta arquivos desatualizados.","The server itself reloads its catalog on every DDL. On a managed Postgres\nwithout the event trigger, reload it by hand: `NOTIFY nelcota, 'reload schema';`.":"O servidor recarrega seu catálogo a cada DDL. Em um Postgres gerenciado sem event trigger, recarregue manualmente: `NOTIFY nelcota, 'reload schema';`.","`service_role` refused in the browser":"`service_role` é recusado no navegador","`@nelcota/client` throws `NelcotaUsageError: A service_role token bypasses\nRLS and must never reach a browser` when it sees such a token in a page. That\ntoken skips every policy, so anyone who opens the developer tools would own\nthe database. Use it only on a server (for example from\n`nelcota token service-role --days 30`); in the browser, sign users in and\nlet RLS decide.":"`@nelcota/client` lança `NelcotaUsageError: A service_role token bypasses RLS and must never reach a browser` ao encontrar esse token em uma página. Ele ignora todas as políticas; qualquer pessoa que abrisse as ferramentas de desenvolvimento teria controle do banco. Use-o apenas em um servidor (por exemplo, com `nelcota token service-role --days 30`); no navegador, faça o login dos usuários e deixe a RLS decidir.","Only 1000 rows come back":`Só voltam 1000 linhas`,"Each read returns at most `NELCOTA_MAX_ROWS` rows (1000 by default), even\nwithout a `limit` and even if the `limit` is larger. Page through the rest:":"Cada leitura retorna no máximo `NELCOTA_MAX_ROWS` linhas (1000 por padrão), mesmo sem `limit` ou quando o `limit` é maior. Use paginação para ler o restante:","TypeScript: `range(from, to)` or `limit` + `offset`; the result's `range`\nand `count` (with `count: 'exact'`) tell whether more rows exist, and\n`pages(size)` walks every row.":"TypeScript: `range(from, to)` ou `limit` + `offset`; `range` e `count` no resultado (com `count: 'exact'`) indicam se existem mais linhas, e `pages(size)` percorre todas elas.","Rust: `range(start, end)` or `limit` + `offset`, with `count_exact()`.":"Rust: `range(start, end)` ou `limit` + `offset`, com `count_exact()`.","HTTP: `Content-Range: 0-999/*` (or `/total` with `Prefer: count=exact`).":"HTTP: `Content-Range: 0-999/*` (ou `/total` com `Prefer: count=exact`).","Order by a unique column when paging. Raising the cap makes every large read\ncost more memory; responses also have an 8 MiB budget\n(`413 response_too_large`).":"Ordene por uma coluna única ao paginar. Aumentar o limite faz cada leitura grande consumir mais memória; as respostas também têm um limite de 8 MiB (`413 response_too_large`).","Password sign-in, signup, email links and provider sign-in use per-endpoint\nIP budgets based on `NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` (30 by default).\nPassword login also has a per-email budget. Refresh and PKCE redemption share\na separate per-IP budget of ten times that value (300 by default). Quotas are\nper process, not distributed across server instances. Clients behind a NAT can\nshare an IP budget. The response carries `Retry-After`; SDKs expose it as\n`error.retryAfter` (seconds) / `Error::retry_after()`. Enable\n`NELCOTA_TRUST_PROXY=true` only behind a trusted forwarding proxy: the rightmost\n`X-Forwarded-For` value is used. Restrict direct API access and configure CDN/proxy\nhops deliberately; otherwise the quota may identify the proxy instead of a user.":"Login com senha, cadastro, links de email e login com provedor usam orçamentos por endpoint/IP baseados em `NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` (30 por padrão). Login com senha também tem orçamento por email. Renovação e resgate PKCE compartilham outro orçamento por IP, dez vezes maior (300 por padrão). As cotas são por processo, não distribuídas entre instâncias. Clientes atrás de NAT podem compartilhar um orçamento por IP. A resposta contém `Retry-After`; SDKs expõem `error.retryAfter` (segundos) / `Error::retry_after()`. Ative `NELCOTA_TRUST_PROXY=true` apenas atrás de um proxy confiável: usa-se o valor mais à direita de `X-Forwarded-For`. Restrinja acesso direto à API e configure os saltos CDN/proxy; caso contrário, a cota pode identificar o proxy em vez do usuário.","A 503 `unavailable` means the database could not be reached or is\noverloaded; it may also carry `Retry-After`. The SDKs retry reads on 429 and\n503 by themselves; writes are never retried automatically.":"Um 503 `unavailable` indica que o banco não pôde ser acessado ou está sobrecarregado; ele também pode incluir `Retry-After`. Os SDKs repetem leituras em 429 e 503 automaticamente; gravações nunca são repetidas de forma automática."},Dt={"Events and webhooks":`Eventos e webhooks`,"Send committed database changes to an HTTP endpoint. Configuration, signing keys and delivery history are under **Events** in the panel. The same Rust binary dispatches deliveries; Postgres stores the queue, so a restart does not lose pending work.":`Envie alterações confirmadas do banco para um endpoint HTTP. Configuração, chaves de assinatura e histórico de entregas ficam em **Eventos** no painel. O mesmo binário Rust envia as entregas; o Postgres armazena a fila, então reiniciar não perde trabalhos pendentes.`,Prerequisites:`Pré-requisitos`,"Use server 0.4.0+ with administrator access and a trusted receiver. The receiver\nneeds bounded raw-body signature verification and durable event-ID deduplication.\nSource-only scheduler/lifecycle changes are listed in Unreleased.":`Use servidor 0.4.0+ com acesso administrativo e receptor confiável. O receptor precisa de verificação de assinatura no corpo bruto com tamanho limitado e deduplicação durável por ID de evento. Mudanças não publicadas de agendamento/ciclo de vida ficam em Unreleased.`,"Create a webhook":`Criar um webhook`,"Open **Events → New webhook**.":`Abra **Eventos → Novo webhook**.`,"Name it, choose a table and select `INSERT`, `UPDATE` and/or `DELETE`.":"Dê um nome, escolha uma tabela e selecione `INSERT`, `UPDATE` e/ou `DELETE`.","Enter the public HTTPS URL that receives JSON POST requests.":`Informe a URL HTTPS pública que recebe requisições POST com JSON.`,"Keep the default six attempts, or choose one to ten.":`Mantenha as seis tentativas padrão ou escolha de uma a dez.`,"Save and copy the signing key to your receiving service. It appears only once.":`Salve e copie a chave de assinatura para o serviço que receberá os eventos. Ela aparece uma única vez.`,"Only ordinary tables in the exposed schema are supported in this version. Views, partitioned tables, storage metadata and authentication tables are excluded. A table rename keeps its webhooks, because capture follows its PostgreSQL object identity. Dropping and recreating a table requires a new webhook.":`Esta versão aceita apenas tabelas comuns do schema exposto. Views, tabelas particionadas, metadados de arquivos e tabelas de autenticação ficam de fora. Renomear uma tabela preserva seus webhooks, pois a captura acompanha a identidade do objeto no PostgreSQL. Excluir e recriar a tabela exige um novo webhook.`,"Pausing stops capturing new changes and holds existing pending deliveries. Reactivating resumes the queue; changes made while paused are not replayed. Deleting cancels pending work and removes the key, while keeping terminal delivery history. A send already in progress may still arrive after a pause, deletion or key rotation.":`Pausar interrompe a captura de novas alterações e retém as entregas pendentes. Reativar retoma a fila; alterações feitas durante a pausa não são recuperadas. Excluir cancela trabalhos pendentes e remove a chave, preservando o histórico concluído. Um envio já iniciado ainda pode chegar depois de uma pausa, exclusão ou troca de chave.`,"Editing a URL affects new events. Queued deliveries keep their original destination. Resending uses the webhook's current URL, key and attempt limit. Key rotation takes effect on newly started sends; update the receiver before resuming a paused webhook.":`Editar a URL afeta os novos eventos. Entregas na fila mantêm o destino original. Reenviar usa a URL, a chave e o limite de tentativas atuais do webhook. A troca de chave vale para envios iniciados depois dela; atualize o serviço receptor antes de reativar um webhook pausado.`,"Event payload":`Dados do evento`,"The receiver gets a JSON object. The event ID is stable across retries, resends and destinations receiving the same database change. Each destination and manual resend has its own delivery ID.":`O serviço receptor recebe um objeto JSON. O ID do evento permanece igual em novas tentativas, reenvios e destinos que recebem a mesma alteração do banco. Cada destino e reenvio manual tem seu próprio ID de entrega.`,"For `INSERT`, `old_record` is null. For `DELETE`, `record` is null. Changes made through REST, RPC, the panel or direct SQL are captured by the same trigger. The event commits with the changed row; a rolled-back transaction creates no delivery. Capture never makes a network call.":"Em `INSERT`, `old_record` é nulo. Em `DELETE`, `record` é nulo. Alterações por REST, RPC, painel ou SQL direto são capturadas pelo mesmo trigger. O evento é confirmado junto com a linha alterada; uma transação revertida não cria entrega. A captura nunca faz chamadas de rede.","The destination receives the full changed row and, for updates/deletes, the previous row. Only project administrators configure destinations. Public API roles cannot inspect the queue or keys; RLS continues to decide which business rows those roles can change. Webhooks are privileged server-to-server integrations, not subscriptions filtered for individual users.":`O destino recebe a linha alterada completa e, em atualizações e exclusões, a linha anterior. Apenas administradores do projeto configuram destinos. Os papéis da API pública não podem consultar a fila ou as chaves; RLS continua decidindo quais linhas esses papéis podem alterar. Webhooks são integrações privilegiadas entre servidores, e não assinaturas filtradas por usuário.`,"Verify signatures":`Verificar assinaturas`,"Each request includes these headers:":`Cada requisição inclui estes cabeçalhos:`,Header:`Cabeçalho`,Meaning:`Significado`,"Stable event UUID; use it for durable deduplication":`UUID estável do evento; use para evitar processamento duplicado de forma persistente`,"Delivery identifier shown in the panel":`Identificador da entrega mostrado no painel`,"Unix timestamp in seconds for this send":`Horário Unix em segundos deste envio`,"`v1=` followed by the lowercase HMAC-SHA256 hex digest":"`v1=` seguido pelo resumo HMAC-SHA256 hexadecimal em letras minúsculas","The signed bytes are the event ID, a period, the timestamp, another period and the exact request body. The HMAC key is the literal signing-key string, including its prefix. Use the raw body before parsing JSON, reject timestamps more than five minutes from your server clock, compare in constant time, then check that the payload ID matches the signed header.":`Os bytes assinados são o ID do evento, um ponto, o horário, outro ponto e o corpo exato da requisição. A chave HMAC é a string literal da chave de assinatura, incluindo seu prefixo. Use o corpo bruto antes de interpretar o JSON, recuse horários distantes mais de cinco minutos do relógio do servidor, compare em tempo constante e confira se o ID do conteúdo corresponde ao cabeçalho assinado.`,"Keep the receiving body bounded to 256 KiB. After verifying, parse JSON and process once per event ID in a database transaction with a unique constraint. Record acceptance durably before replying with 2xx. A repeated event should also receive 2xx, without repeating the action. For multiple independent consumers sharing a database, deduplicate by consumer and event ID.":`Limite o corpo recebido a 256 KiB. Depois de verificar, interprete o JSON e processe uma vez por ID de evento em uma transação no banco com uma restrição de unicidade. Registre a aceitação de forma persistente antes de responder com 2xx. Um evento repetido também deve receber 2xx, sem repetir a ação. Para vários consumidores independentes que compartilham um banco, evite duplicação por consumidor e ID do evento.`,"Retries and delivery history":`Novas tentativas e histórico de entregas`,"Any 2xx response acknowledges delivery. Network errors, timeouts, HTTP 408, 425, 429 and 5xx retry automatically. Other statuses, including redirects, are terminal failures. The receiver has ten seconds to answer; a separate twelve-second deadline also bounds DNS and connection setup.":`Qualquer resposta 2xx confirma a entrega. Erros de rede, timeouts, HTTP 408, 425, 429 e 5xx recebem novas tentativas automaticamente. Os demais estados, incluindo redirecionamentos, encerram a entrega com falha. O receptor tem dez segundos para responder; um prazo separado de doze segundos também limita DNS e conexão.`,"Retry delays start at approximately 5 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes and 1 hour, with jitter and a one-hour cap. A numeric `Retry-After` is respected up to one hour without reducing the normal delay. Six attempts by default means the initial send and five retries. A lost worker lease is recovered after two minutes and still counts as an attempt.":"Os intervalos começam em aproximadamente 5 segundos, 30 segundos, 2 minutos, 10 minutos, 30 minutos e 1 hora, com variação e limite de uma hora. Um cabeçalho numérico `Retry-After` é respeitado até uma hora, sem reduzir o intervalo normal. As seis tentativas padrão incluem o primeiro envio e cinco repetições. Um trabalho perdido pelo worker é recuperado após dois minutos e ainda conta como tentativa.","Delivery is **at least once**, with no ordering guarantee. A receiver may process an event whose acknowledgement never reaches Nelcota; the next attempt may send it again. Multiple workers claim queue rows with short leases and do not hold a database connection during HTTP calls.":`A entrega ocorre **pelo menos uma vez**, sem garantia de ordem. Um receptor pode processar um evento cuja confirmação nunca chega ao Nelcota; a próxima tentativa pode enviá-lo novamente. Vários workers assumem linhas da fila por períodos curtos e não retêm uma conexão com o banco durante chamadas HTTP.`,"The history shows status, HTTP code, attempts, timestamps and the exact payload. A delivery detail shows every attempt, including sends interrupted by a restart. **Resend** creates a new delivery, preserving the original history and stable event ID. Active deliveries cannot be resent; the webhook must be enabled. Receiver response bodies and signing keys never appear in history.":`O histórico mostra estado, código HTTP, tentativas, horários e o conteúdo exato. Os detalhes da entrega mostram cada tentativa, incluindo envios interrompidos por um reinício. **Reenviar** cria uma nova entrega, preservando o histórico original e o ID estável do evento. Entregas ativas não podem ser reenviadas; o webhook precisa estar ativo. Corpos das respostas do receptor e chaves de assinatura nunca aparecem no histórico.`,"Limits and retention":`Limites e retenção`,"There are at most 50 active configurations per project and ten per table. The queue holds at most 10,000 outstanding deliveries and 100,000 retained deliveries. Admission is transactional: if a limit is reached, the business write fails with a retryable database-capacity error instead of silently losing its event. The panel shows usage and warns at 80%.":`Cada projeto aceita até 50 configurações ativas e dez por tabela. A fila aceita até 10.000 entregas pendentes e 100.000 entregas retidas. A admissão é transacional: ao atingir um limite, a gravação falha com um erro de capacidade que permite nova tentativa, em vez de perder silenciosamente seu evento. O painel mostra o uso e avisa aos 80%.`,"Terminal history is kept for up to seven days and cleaned in bounded batches. Pending deliveries are never deleted by age. **Clear history** removes only terminal deliveries and their payloads. To free a stalled queue, fix or enable its destinations, or delete unwanted webhooks to cancel their pending work. Keep database backups private: they contain signing keys and event payloads.":`O histórico concluído é mantido por até sete dias e limpo em lotes limitados. Entregas pendentes nunca são excluídas por idade. **Limpar histórico** remove apenas entregas concluídas e seus conteúdos. Para liberar uma fila parada, corrija ou ative seus destinos, ou exclua webhooks indesejados para cancelar seus trabalhos pendentes. Mantenha os backups do banco privados: eles contêm chaves de assinatura e conteúdos de eventos.`,"A payload larger than 256 KiB produces a visibly failed delivery with omitted contents, while the business row still commits. Such a delivery cannot be resent; reduce the row size or use another integration for large values. Changes to a hook configuration are project configuration, separate from schema migration exports.":`Um conteúdo maior que 256 KiB produz uma entrega visivelmente falha com dados omitidos, enquanto a linha de negócio ainda é confirmada. Essa entrega não pode ser reenviada; reduza o tamanho da linha ou use outra integração para valores grandes. Alterações na configuração de um webhook são configurações do projeto, separadas da exportação de migrações do schema.`,"Destination safety and local development":`Segurança dos destinos e desenvolvimento local`,"Public destinations require HTTPS with certificate verification. Credentials, query parameters and fragments in URLs are rejected. Redirects and environment proxy settings are disabled. Private, loopback, link-local, metadata, carrier-grade NAT, multicast and reserved IP ranges are blocked, including DNS answers at connection time. All addresses in a DNS answer must pass the policy, preventing DNS rebinding into internal services.":`Destinos públicos exigem HTTPS com verificação de certificado. Credenciais, parâmetros e fragmentos nas URLs são recusados. Redirecionamentos e proxies do ambiente ficam desativados. IPs privados, de loopback, link-local, metadados, NAT compartilhado, multicast e faixas reservadas são bloqueados, incluindo respostas DNS no momento da conexão. Todos os endereços de uma resposta DNS precisam passar pela política, impedindo mudanças de DNS que direcionem chamadas a serviços internos.`,"For local development only, set `NELCOTA_WEBHOOKS_ALLOW_LOOPBACK=true` and restart. This permits HTTP or HTTPS to `localhost`, `127.0.0.1` and `::1`; it never opens private networks or metadata addresses. Inside Docker, loopback refers to the Nelcota container, not the host. Use a public HTTPS development tunnel when the receiver runs outside that container.":"Apenas no desenvolvimento local, defina `NELCOTA_WEBHOOKS_ALLOW_LOOPBACK=true` e reinicie. Isso permite HTTP ou HTTPS para `localhost`, `127.0.0.1` e `::1`; nunca libera redes privadas ou endereços de metadados. Dentro do Docker, loopback aponta para o contêiner do Nelcota, não para o host. Use um túnel HTTPS público de desenvolvimento quando o receptor estiver fora desse contêiner.","No Redis, HTTP extension, extra server or Node process is required for dispatch. The queue worker uses a small pool separate from API and panel connections. A graceful shutdown stops claiming work and gives started deliveries time to finish; unfinished leases remain recoverable after startup.":`O envio não exige Redis, extensão HTTP, outro servidor ou processo Node. O worker da fila usa um pool pequeno separado das conexões da API e do painel. O encerramento normal para de assumir trabalhos e dá tempo para terminar as entregas iniciadas; trabalhos incompletos continuam recuperáveis na próxima inicialização.`,"Related guides":`Guias relacionados`,"See [REST API](api.md), [panel](panel.md), [backup](backup.md) and [architecture](architecture.md).":`Veja [API REST](api.md), [painel](panel.md), [backup](backup.md) e [arquitetura](architecture.md).`},Ot=[`start`,`develop`,`operate`,`internals`],R=[{id:`sdk-start`,group:`start`,source:`sdk/typescript/docs/quickstart.pt-BR.md`,language:`pt-BR`,action:`/connect`},{id:`quickstart`,group:`start`,source:`docs/quickstart.md`,action:`/connect`},{id:`panel`,group:`start`,source:`docs/panel.md`,action:`/`},{id:`sdk`,group:`develop`,source:`sdk/typescript/README.md`,action:`/connect`},{id:`api`,group:`develop`,source:`docs/api.md`,action:`/connect`},{id:`openapi`,group:`develop`,source:``,action:`/policies`},{id:`auth`,group:`develop`,source:`docs/schema-auth.md`,action:`/sign-in`},{id:`roles`,group:`develop`,source:`docs/jwt-and-roles.md`,action:`/policies`},{id:`storage`,group:`develop`,source:`docs/storage.md`,action:`/storage`},{id:`webhooks`,group:`develop`,source:`docs/webhooks.md`,action:`/webhooks`},{id:`sdk-rust`,group:`develop`,source:`sdk/rust/README.md`,action:`/connect`},{id:`rust-start`,group:`develop`,source:`sdk/rust/docs/quickstart.pt-BR.md`,language:`pt-BR`,action:`/connect`},{id:`example`,group:`develop`,source:`examples/notes.sql`,code:`sql`,action:`/sql`},{id:`ssr`,group:`develop`,source:`sdk/typescript/examples/server.mjs`,code:`ts`,action:`/connect`},{id:`troubleshooting`,group:`operate`,source:`docs/troubleshooting.md`,action:`/policies`},{id:`deploy`,group:`operate`,source:`docs/deploy.md`,action:`/migrations`},{id:`backup`,group:`operate`,source:`docs/backup.md`,action:`/storage`},{id:`leaving`,group:`operate`,source:`docs/leaving.md`,action:`/tables`},{id:`sdk-contract`,group:`internals`,source:`sdk/typescript/docs/contract.md`,action:`/connect`},{id:`rust-contract`,group:`internals`,source:`sdk/rust/docs/contract.md`,action:`/connect`},{id:`sdk-releasing`,group:`internals`,source:`sdk/typescript/docs/releasing.md`,action:`/connect`},{id:`rust-releasing`,group:`internals`,source:`sdk/rust/docs/releasing.md`,action:`/connect`},{id:`changelog`,group:`internals`,source:`sdk/typescript/CHANGELOG.md`,action:`/connect`},{id:`architecture`,group:`internals`,source:`docs/architecture.md`,action:`/`},{id:`decisions`,group:`internals`,source:`docs/decisions.md`,action:`/`}],z=(e,t)=>`/guides/${e}${t?`?section=${encodeURIComponent(t)}`:``}`;function kt(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var B=kt();function At(e){B=e}var V={exec:()=>null};function H(e){let t=[];return n=>{let r=Math.max(0,Math.min(3,n-1)),i=t[r];return i||(i=e(r),t[r]=i),i}}function U(e,t=``){let n=typeof e==`string`?e:e.source,r={replace:(e,t)=>{let i=typeof t==`string`?t:t.source;return i=i.replace(W.caret,`$1`),n=n.replace(e,i),r},getRegex:()=>new RegExp(n,t)};return r}var jt=((e=``)=>{try{return!!RegExp(`(?<=1)(?<!1)`+e)}catch{return!1}})(),W={codeRemoveIndent:/^(?: {0,3}\t| {1,4})/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,endingSpaceTabChar:/[ \t]$/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,leadingSpaceTab:/^[ \t]+/,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,numericCharacterReference:/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:H(e=>RegExp(`^ {0,${e}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)),hrRegex:H(e=>RegExp(`^ {0,${e}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)),fencesBeginRegex:H(e=>RegExp(`^ {0,${e}}(?:\`\`\`|~~~)`)),headingBeginRegex:H(e=>RegExp(`^ {0,${e}}#`)),htmlBeginRegex:H(e=>RegExp(`^ {0,${e}}(?:</?(?:${Gt})(?: +|$|/?>)|<(?:script|pre|style|textarea|!--))`,`i`)),blockquoteBeginRegex:H(e=>RegExp(`^ {0,${e}}>`))},Mt=/^(?:[ \t]*(?:\n|$))+/,Nt=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,Pt=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,G=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,Ft=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,It=/ {0,3}(?:[*+-]|\d{1,9}[.)])/,Lt=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Rt=U(Lt).replace(/bull/g,It).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}(?:\s|$)/).replace(/hr/g,/ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,``).getRegex(),zt=U(Lt).replace(/bull/g,It).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}(?:\s|$)/).replace(/hr/g,/ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),Bt=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/,Vt=/^[^\n]+/,Ht=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,Ut=U(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace(`label`,Ht).replace(`title`,/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),Wt=U(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g,It).getRegex(),Gt=`address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul`,Kt=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,qt=U(`^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))`,`i`).replace(`comment`,Kt).replace(`tag`,Gt).replace(`attribute`,/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),Jt=e=>U(Bt).replace(`hr`,G).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace(`list`,e).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,Gt).getRegex(),Yt=Jt(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/),Xt=Jt(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/),Zt={blockquote:U(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace(`paragraph`,Xt).getRegex(),code:Nt,def:Ut,fences:Pt,heading:Ft,hr:G,html:qt,lheading:Rt,list:Wt,newline:Mt,paragraph:Yt,table:V,text:Vt},Qt=U(`^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)`).replace(`hr`,G).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`blockquote`,` {0,3}>`).replace(`code`,`(?: {4}| {0,3}	)[^\\n]`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,Gt).getRegex(),$t={...Zt,lheading:zt,table:Qt,paragraph:U(Bt).replace(`hr`,G).replace(`heading`,` {0,3}#{1,6}(?:\\s|$)`).replace(`|lheading`,``).replace(`table`,Qt).replace(`blockquote`,` {0,3}>`).replace(`fences`," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace(`list`,` {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]`).replace(`html`,`</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)`).replace(`tag`,Gt).getRegex()},en={...Zt,html:U(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace(`comment`,Kt).replace(/tag/g,`(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b`).getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:V,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:U(Bt).replace(`hr`,G).replace(`heading`,` *#{1,6} *[^
]`).replace(`lheading`,Rt).replace(`|table`,``).replace(`blockquote`,` {0,3}>`).replace(`|fences`,``).replace(`|list`,``).replace(`|html`,``).replace(`|tag`,``).getRegex()},tn=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,nn=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,rn=/^( {2,}|\\)\n(?!\s*$)[ \t]*/,an=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,K=/[\p{P}\p{S}]/u,q=/[\s\p{P}\p{S}]/u,on=/[^\s\p{P}\p{S}]/u,sn=U(/^((?![*_])punctSpace)/,`u`).replace(/punctSpace/g,q).getRegex(),cn=/[\p{Pi}\p{Ps}"']/u,ln=/(?!~)[\p{P}\p{S}]/u,un=/(?!~)[\s\p{P}\p{S}]/u,dn=/(?:[^\s\p{P}\p{S}]|~)/u,fn=U(/link|precode-code|html/,`g`).replace(`link`,/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace(`precode-`,jt?"(?<!`)()":"(^^|[^`])").replace(`code`,/(?<b>`+)[^`]+\k<b>(?!`)/).replace(`html`,/<(?! )[^<>]*?>/).getRegex(),pn=/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,mn=U(pn,`u`).replace(/punct/g,K).getRegex(),hn=U(pn,`u`).replace(/punct/g,ln).getRegex(),gn=U(/^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/,`u`).replace(/openQuote/g,cn).replace(/punct/g,K).getRegex(),_n=`^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)`,vn=U(_n,`gu`).replace(/notPunctSpace/g,on).replace(/punctSpace/g,q).replace(/punct/g,K).getRegex(),yn=U(_n,`gu`).replace(/notPunctSpace/g,dn).replace(/punctSpace/g,un).replace(/punct/g,ln).getRegex(),bn=U(`^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)`,`gu`).replace(/notPunctSpace/g,on).replace(/punctSpace/g,q).replace(/punct/g,K).getRegex(),xn=U(`^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`,`gu`).replace(/notPunctSpace/g,on).replace(/punctSpace/g,q).replace(/punct/g,K).getRegex(),Sn=U(`^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)`,`gu`).replace(/notPunctSpace/g,on).replace(/punctSpace/g,q).replace(/punct/g,K).getRegex(),Cn=U(/^~~?(?:((?!~)punct)|[^\s~])/,`u`).replace(/punct/g,K).getRegex(),wn=U(`^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`,`gu`).replace(/notPunctSpace/g,on).replace(/punctSpace/g,q).replace(/punct/g,K).getRegex(),Tn=U(/\\(punct)/,`gu`).replace(/punct/g,K).getRegex(),En=U(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace(`scheme`,/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace(`email`,/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),Dn=U(Kt).replace(`(?:-->|$)`,`-->`).getRegex(),On=U(`^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`).replace(`comment`,Dn).replace(`attribute`,/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),kn=/\[(?:\\[\s\S]|[^\[\]\\])*\]/,An=U(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace(`brackets`,kn).getRegex(),jn=U(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace(`label`,An).replace(`href`,/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace(`title`,/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),Mn=U(/^!?\[(label)\]\[(ref)\]/).replace(`label`,An).replace(`ref`,Ht).getRegex(),Nn=U(/^!?\[(ref)\](?:\[\])?/).replace(`ref`,Ht).getRegex(),Pn=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/,Fn=U(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace(`brackets`,kn).getRegex(),In=U(`reflink|nolink(?!\\()`,`g`).replace(`reflink`,U(/^!?\[(label)\]\[(ref)\]/).replace(`label`,Fn).replace(`ref`,Pn).getRegex()).replace(`nolink`,U(/^!?\[(ref)\](?:\[\])?/).replace(`ref`,Pn).getRegex()).getRegex(),Ln=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,Rn=U(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g,/[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(),zn={_backpedal:V,anyPunctuation:Tn,autolink:En,blockSkip:fn,br:rn,code:nn,del:V,delLDelim:V,delRDelim:V,emStrongLDelim:mn,emStrongRDelimAst:vn,emStrongRDelimUnd:xn,escape:tn,link:jn,nolink:Nn,punctuation:sn,reflink:Mn,reflinkSearch:In,tag:On,text:an,url:V},Bn={...zn,emStrongLDelim:gn,emStrongRDelimAst:bn,emStrongRDelimUnd:Sn,link:U(/^!?\[(label)\]\((.*?)\)/).replace(`label`,An).getRegex(),reflink:U(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace(`label`,An).getRegex()},Vn={...zn,emStrongRDelimAst:yn,emStrongLDelim:hn,delLDelim:Cn,delRDelim:wn,url:U(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace(`emailProtocol`,Rn).replace(`protocol`,Ln).replace(`email`,/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:U(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace(`protocol`,Ln).replace(/emailProtocol/g,/(?:mailto|xmpp):/).getRegex()},Hn={...Vn,br:U(rn).replace(`{2,}`,`*`).getRegex(),text:U(Vn.text).replace(`\\b_`,`\\b_| {2,}\\n`).replace(/\{2,\}/g,`*`).getRegex()},Un={normal:Zt,gfm:$t,pedantic:en},Wn={normal:zn,gfm:Vn,breaks:Hn,pedantic:Bn},Gn={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`},Kn=e=>Gn[e];function J(e,t){if(t){if(W.escapeTest.test(e))return e.replace(W.escapeReplace,Kn)}else if(W.escapeTestNoEncode.test(e))return e.replace(W.escapeReplaceNoEncode,Kn);return e}function qn(e){return e.replace(W.numericCharacterReference,(e,t,n)=>{let r=t===void 0?Number.parseInt(n,16):Number.parseInt(t,10);return r===0||r>1114111||r>=55296&&r<=57343?`�`:String.fromCodePoint(r)})}function Jn(e){try{e=encodeURI(e).replace(W.percentDecode,`%`)}catch{return null}return e}function Yn(e,t){let n=e.replace(W.findPipe,(e,t,n)=>{let r=!1,i=t;for(;--i>=0&&n[i]===`\\`;)r=!r;return r?`|`:` |`}).split(W.splitPipe),r=0;if(n[0].trim()||n.shift(),n.length>0&&!n.at(-1)?.trim()&&n.pop(),t){if(n.length>t)n.splice(t);else for(;n.length<t;)n.push(``)}for(;r<n.length;r++)n[r]=n[r].trim().replace(W.slashPipe,`|`);return n}function Y(e,t,n){let r=e.length;if(r===0)return``;let i=0;for(;i<r;){let a=e.charAt(r-i-1);if(a===t&&!n)i++;else if(a!==t&&n)i++;else break}return e.slice(0,r-i)}function Xn(e){let t=e.split(`
`),n=t.length-1;for(;n>=0&&W.blankLine.test(t[n]);)n--;return t.length-n<=2?e:t.slice(0,n+1).join(`
`)}function Zn(e){return e.trim().toLowerCase().toUpperCase().toLowerCase()}function Qn(e,t){if(e.indexOf(t[0])===-1&&e.indexOf(t[1])===-1)return-1;let n=0;for(let r=0;r<e.length;r++)if(e[r]===`\\`)r++;else if(e[r]===t[0])n++;else if(e[r]===t[1]&&(n--,n<0))return r;return n>0?-2:-1}function $n(e,t=0){let n=t,r=``;for(let t of e)if(t===`	`){let e=4-n%4;r+=` `.repeat(e),n+=e}else r+=t,n++;return r}function er(e,t,n,r,i){let a=t.href,o=t.title||null,s=e[1].replace(i.other.outputLinkReplace,`$1`),c=e[0].charAt(0)===`!`;r.state.inLink=!0;let l=r.state.linkEmitted,u=r.state.inRawBlock;r.state.linkEmitted=!1;let d=r.inlineTokens(s),f=r.state.linkEmitted;if(r.state.linkEmitted=l,r.state.inLink=!1,!c){if(f){r.state.inRawBlock=u;return}r.state.linkEmitted=!0}return{type:c?`image`:`link`,raw:n,href:a,title:o,text:s,tokens:d}}function tr(e,t,n){let r=e.match(n.other.indentCodeCompensation);if(r===null)return t;let i=r[1];return t.split(`
`).map(e=>{let t=e.match(n.other.beginningSpace);if(t===null)return e;let[r]=t;return e.slice(Math.min(r.length,i.length))}).join(`
`)}function nr(e,t,n,r){if(!t.includes(`<`))return!1;for(let i=0;i<t.length;i++){if(t[i]===`\\`){i++;continue}if(t[i]==="`"){let e=r.inline.code.exec(t.slice(i));if(e){i+=e[0].length-1;continue}}if(t[i]!==`<`)continue;let a=e.slice(n+i),o=r.inline.tag.exec(a)||r.inline.autolink.exec(a);if(o){if(o[0].length>t.length-i)return!0;i+=o[0].length-1}}return!1}var rr=class{options;rules;lexer;constructor(e){this.options=e||B}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:`space`,raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let e=this.options.pedantic?t[0]:Xn(t[0]);return{type:`code`,raw:e,codeBlockStyle:`indented`,text:e.replace(this.rules.other.codeRemoveIndent,``)}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let e=t[0],n=tr(e,t[3]||``,this.rules);return{type:`code`,raw:e,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,`$1`):t[2],text:n}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let e=t[2].trim();if(this.rules.other.endingHash.test(e)){let t=Y(e,`#`);(this.options.pedantic||!t||this.rules.other.endingSpaceTabChar.test(t))&&(e=t.trim())}return{type:`heading`,raw:Y(t[0],`
`),depth:t[1].length,text:e,tokens:this.lexer.inline(e)}}}hr(e){let t=this.rules.block.hr.exec(e);if(t)return{type:`hr`,raw:Y(t[0],`
`)}}blockquote(e){let t=this.rules.block.blockquote.exec(e);if(t){let e=Y(t[0],`
`).split(`
`),n=``,r=``,i=[];for(;e.length>0;){let t=!1,a=[],o=0;for(;o<e.length;o++)if(this.rules.other.blockquoteStart.test(e[o]))a.push(e[o]),t=!0;else if(!t)a.push(e[o]);else break;e=e.slice(o);let s=a.join(`
`),c=s.replace(this.rules.other.blockquoteSetextReplace,`
    $1`).replace(this.rules.other.blockquoteSetextReplace2,``);n=n?`${n}
${s}`:s,r=r?`${r}
${c}`:c;let l=this.lexer.state.top;if(this.lexer.state.top=!0,this.lexer.blockTokens(c,i,!0),this.lexer.state.top=l,e.length===0)break;let u=i.at(-1);if(u?.type===`code`)break;if(u?.type===`blockquote`){let t=u,a=e.join(`
`),o=t.raw+`
`+a.replace(this.rules.other.blockquoteSetextReplace2,``),s=this.blockquote(o);i[i.length-1]=s;let c=o.substring(s.raw.length).replace(/^\n/,``),l=c?c.split(`
`).length:0,d=l?e.slice(0,-l):e;d.length>0&&(n=`${n}
${d.join(`
`)}`),r=r.substring(0,r.length-t.text.length)+s.text;break}if(u?.type===`list`){let t=u,a=t.raw+`
`+e.join(`
`),o=this.list(a);i[i.length-1]=o,n=n.substring(0,n.length-u.raw.length)+o.raw,r=r.substring(0,r.length-t.raw.length)+o.raw,e=a.substring(i.at(-1).raw.length).split(`
`)}}return{type:`blockquote`,raw:n,tokens:i,text:r}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=t[1].trim(),r=n.length>1,i={type:`list`,raw:``,ordered:r,start:r?+n.slice(0,-1):``,loose:!1,items:[]};n=r?`\\d{1,9}\\${n.slice(-1)}`:`\\${n}`,this.options.pedantic&&(n=r?n:`[*+-]`);let a=this.rules.other.listItemRegex(n),o=!1;for(;e;){let n=!1,r=``,s=``;if(!(t=a.exec(e))||this.rules.block.hr.test(e))break;r=t[0],e=e.substring(r.length);let c=t[2].split(`
`,1)[0],l=t[1].length,u=this.options.pedantic?$n(c,l):c.replace(this.rules.other.leadingSpaceTab,e=>$n(e,l)),d=e.split(`
`,1)[0],f=!u.trim(),p=0;if(this.options.pedantic?(p=2,s=u.trimStart()):f?p=l+1:(p=u.search(this.rules.other.nonSpaceChar),p=p>4?1:p,s=u.slice(p),p+=l),f&&this.rules.other.blankLine.test(d)&&(r+=d+`
`,e=e.substring(d.length+1),n=!0),!n){let t=this.rules.other.nextBulletRegex(p),n=this.rules.other.hrRegex(p),i=this.rules.other.fencesBeginRegex(p),a=this.rules.other.headingBeginRegex(p),o=this.rules.other.htmlBeginRegex(p),c=this.rules.other.blockquoteBeginRegex(p);for(;e;){let l=e.split(`
`,1)[0],m;if(d=l,this.options.pedantic?(d=d.replace(this.rules.other.listReplaceNesting,`  `),m=d):m=d.replace(this.rules.other.leadingSpaceTab,e=>e.replace(this.rules.other.tabCharGlobal,`    `)),i.test(d)||a.test(d)||o.test(d)||c.test(d)||t.test(d)||n.test(d))break;if(m.search(this.rules.other.nonSpaceChar)>=p||!d.trim())s+=`
`+m.slice(p);else{if(f||u.replace(this.rules.other.tabCharGlobal,`    `).search(this.rules.other.nonSpaceChar)>=4||i.test(u)||a.test(u)||n.test(u))break;s+=`
`+d}f=!d.trim(),r+=l+`
`,e=e.substring(l.length+1),u=m.slice(p)}}i.loose||(o?i.loose=!0:this.rules.other.doubleBlankLine.test(r)&&(o=!0)),i.items.push({type:`list_item`,raw:r,task:!!this.options.gfm&&this.rules.other.listIsTask.test(s),loose:!1,text:s,tokens:[]}),i.raw+=r}let s=i.items.at(-1);if(s)s.raw=s.raw.trimEnd(),s.text=s.text.trimEnd();else return;i.raw=i.raw.trimEnd();for(let e of i.items)if(this.lexer.state.top=!1,e.tokens=this.lexer.blockTokens(e.text,[]),!i.loose){let t=e.tokens.filter(e=>e.type===`space`);i.loose=t.length>0&&t.some(e=>this.rules.other.anyLine.test(e.raw))}for(let e of i.items){let t=e.tokens[0];if(e.task&&(t?.type===`text`||t?.type===`paragraph`)){e.text=e.text.replace(this.rules.other.listReplaceTask,``),t.raw=t.raw.replace(this.rules.other.listReplaceTask,``),t.text=t.text.replace(this.rules.other.listReplaceTask,``);for(let e=this.lexer.inlineQueue.length-1;e>=0;e--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[e].src)){this.lexer.inlineQueue[e].src=this.lexer.inlineQueue[e].src.replace(this.rules.other.listReplaceTask,``);break}let n=this.rules.other.listTaskCheckbox.exec(e.raw);if(n){let t={type:`checkbox`,raw:n[0]+` `,checked:n[0]!==`[ ]`};e.checked=t.checked,i.loose?e.tokens[0]&&[`paragraph`,`text`].includes(e.tokens[0].type)&&`tokens`in e.tokens[0]&&e.tokens[0].tokens?(e.tokens[0].raw=t.raw+e.tokens[0].raw,e.tokens[0].text=t.raw+e.tokens[0].text,e.tokens[0].tokens.unshift(t)):e.tokens.unshift({type:`paragraph`,raw:t.raw,text:t.raw,tokens:[t]}):e.tokens.unshift(t)}}else e.task&&=!1}if(i.loose)for(let e of i.items){e.loose=!0;for(let t of e.tokens)t.type===`text`&&(t.type=`paragraph`)}return i}}html(e){let t=this.rules.block.html.exec(e);if(t){let e=Xn(t[0]);return{type:`html`,block:!0,raw:e,pre:t[1]===`pre`||t[1]===`script`||t[1]===`style`,text:e}}}def(e){let t=this.rules.block.def.exec(e);if(t){if(!this.rules.other.startAngleBracket.test(t[2])&&Qn(t[2],`()`)!==-1)return;let e=Zn(t[1]).replace(this.rules.other.multipleSpaceGlobal,` `),n=t[2]?t[2].replace(this.rules.other.hrefBrackets,`$1`).replace(this.rules.inline.anyPunctuation,`$1`):``,r=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,`$1`):t[3];return{type:`def`,tag:e,raw:Y(t[0],`
`),href:n,title:r}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=Yn(t[1]),r=t[2].replace(this.rules.other.tableAlignChars,``).split(`|`),i=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,``).split(`
`):[],a={type:`table`,raw:Y(t[0],`
`),header:[],align:[],rows:[]};if(n.length===r.length){for(let e of r)this.rules.other.tableAlignRight.test(e)?a.align.push(`right`):this.rules.other.tableAlignCenter.test(e)?a.align.push(`center`):this.rules.other.tableAlignLeft.test(e)?a.align.push(`left`):a.align.push(null);for(let e=0;e<n.length;e++)a.header.push({text:n[e],tokens:this.lexer.inline(n[e]),header:!0,align:a.align[e]});for(let e of i)a.rows.push(Yn(e,a.header.length).map((e,t)=>({text:e,tokens:this.lexer.inline(e),header:!1,align:a.align[t]})));return a}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t){let e=t[1].trim();return{type:`heading`,raw:Y(t[0],`
`),depth:t[2].charAt(0)===`=`?1:2,text:e,tokens:this.lexer.inline(e)}}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let e=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:`paragraph`,raw:t[0],text:e,tokens:this.lexer.inline(e)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:`text`,raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:`escape`,raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:`html`,raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){if(this.lexer.state.linkParenPossible===!1)return;let t=this.rules.inline.link.exec(e);if(t){let n=t[0].charAt(0)===`!`?2:1;if(!this.options.pedantic&&nr(e,t[1],n,this.rules))return;let r=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(r)){if(!this.rules.other.endAngleBracket.test(r))return;let e=Y(r.slice(0,-1),`\\`);if((r.length-e.length)%2==0)return}else{let e=Qn(t[2],`()`);if(e===-2)return;if(e>-1){let n=(t[0].indexOf(`!`)===0?5:4)+t[1].length+e;t[2]=t[2].substring(0,e),t[0]=t[0].substring(0,n).trim(),t[3]=``}}let i=t[2],a=``;if(this.options.pedantic){let e=this.rules.other.pedanticHrefTitle.exec(i);e&&(i=e[1],a=e[3])}else a=t[3]?t[3].slice(1,-1):``;return i=i.trim(),this.rules.other.startAngleBracket.test(i)&&(i=this.options.pedantic&&!this.rules.other.endAngleBracket.test(r)?i.slice(1):i.slice(1,-1)),er(t,{href:i&&i.replace(this.rules.inline.anyPunctuation,`$1`),title:a&&a.replace(this.rules.inline.anyPunctuation,`$1`)},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let r=n[0].charAt(0)===`!`?2:1;if(!this.options.pedantic&&nr(e,n[1],r,this.rules))return;let i=t[Zn((n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal,` `))];if(!i){let e=n[0].charAt(0);return{type:`text`,raw:e,text:e}}return er(n,i,n[0],this.lexer,this.rules)}}emStrong(e,t,n=``){let r=this.rules.inline.emStrongLDelim.exec(e);if(!(!r||!r[1]&&!r[2]&&!r[3]&&!r[4]||r[4]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(r[1]||r[3])||!n||this.rules.inline.punctuation.exec(n))){let i=[...r[0]].length-1,a,o,s=i,c=0,l=r[0][0],u=n===l,d=l===`*`?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(d.lastIndex=0,t=t.slice(-1*e.length+i);(r=d.exec(t))!==null;){if(a=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!a)continue;if(o=[...a].length,r[3]||r[4]){s+=o;continue}if(r[5]||r[6]){if(i%3&&!((i+o)%3)){c+=o;continue}if(u)break}if(s-=o,s>0)continue;o=Math.min(o,o+s+c);let t=[...r[0]][0].length,n=e.slice(0,i+r.index+t+o);if(Math.min(i,o)%2){let e=n.slice(1,-1);return{type:`em`,raw:n,text:e,tokens:this.lexer.inlineTokens(e)}}let l=n.slice(2,-2);return{type:`strong`,raw:n,text:l,tokens:this.lexer.inlineTokens(l)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let e=t[2].replace(this.rules.other.newLineCharGlobal,` `),n=this.rules.other.nonSpaceChar.test(e),r=this.rules.other.startingSpaceChar.test(e)&&this.rules.other.endingSpaceChar.test(e);return n&&r&&(e=e.substring(1,e.length-1)),{type:`codespan`,raw:t[0],text:e}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:`br`,raw:t[0]}}del(e,t,n=``){let r=this.rules.inline.delLDelim.exec(e);if(r&&(!r[1]||!n||this.rules.inline.punctuation.exec(n))){let n=[...r[0]].length-1,i,a,o=n,s=this.rules.inline.delRDelim;for(s.lastIndex=0,t=t.slice(-1*e.length+n);(r=s.exec(t))!==null;){if(i=r[1]||r[2]||r[3]||r[4]||r[5]||r[6],!i||(a=[...i].length,a!==n))continue;if(r[3]||r[4]){o+=a;continue}if(o-=a,o>0)continue;a=Math.min(a,a+o);let t=[...r[0]][0].length,s=e.slice(0,n+r.index+t+a),c=s.slice(n,-n);return{type:`del`,raw:s,text:c,tokens:this.lexer.inlineTokens(c)}}}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let e,n;return t[2]===`@`?(e=t[1],n=`mailto:`+e):(e=t[1],n=e),{type:`link`,raw:t[0],text:e,href:n,autolink:!0,tokens:[{type:`text`,raw:e,text:e}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let e,n;if(t[2]===`@`)e=t[0],n=`mailto:`+e;else{let r;do r=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??``;while(r!==t[0]);e=t[0],n=t[1]===`www.`?`http://`+t[0]:t[0]}return{type:`link`,raw:t[0],text:e,href:n,autolink:!0,tokens:[{type:`text`,raw:e,text:e}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let e=this.lexer.state.inRawBlock;return{type:`text`,raw:t[0],text:e?t[0]:qn(t[0]),escaped:e}}}},X=class e{tokens;options;state;inlineQueue;tokenizer;constructor(e){this.tokens=[],this.tokens.links=Object.create(null),this.options=e||B,this.options.tokenizer=this.options.tokenizer||new rr,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,linkEmitted:!1,linkParenPossible:!0,top:!0};let t={other:W,block:Un.normal,inline:Wn.normal};this.options.pedantic?(t.block=Un.pedantic,t.inline=Wn.pedantic):this.options.gfm&&(t.block=Un.gfm,t.inline=this.options.breaks?Wn.breaks:Wn.gfm),this.tokenizer.rules=t}static get rules(){return{block:Un,inline:Wn}}static lex(t,n){return new e(n).lex(t)}static lexInline(t,n){return new e(n).inlineTokens(t)}lex(e){e=e.replace(W.carriageReturn,`
`),this.blockTokens(e,this.tokens);for(let e=0;e<this.inlineQueue.length;e++){let t=this.inlineQueue[e];this.inlineTokens(t.src,t.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(e,t=[],n=!1){this.tokenizer.lexer=this,this.options.pedantic&&(e=e.replace(W.tabCharGlobal,`    `).replace(W.spaceLine,``));let r=1/0;for(;e;){if(e.length<r)r=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}let i;if(this.options.extensions?.block?.some(n=>(i=n.call({lexer:this},e,t))?(e=e.substring(i.raw.length),t.push(i),!0):!1))continue;if(i=this.tokenizer.space(e)){e=e.substring(i.raw.length);let n=t.at(-1);i.raw.length===1&&n!==void 0?n.raw+=`
`:t.push(i);continue}if(i=this.tokenizer.code(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type===`paragraph`||n?.type===`text`?(n.raw+=(n.raw.endsWith(`
`)?``:`
`)+i.raw,n.text+=`
`+i.text,this.inlineQueue.at(-1).src=n.text):t.push(i);continue}if((i=this.tokenizer.fences(e))||(i=this.tokenizer.heading(e))||(i=this.tokenizer.hr(e))||(i=this.tokenizer.blockquote(e))||(i=this.tokenizer.list(e))||(i=this.tokenizer.html(e))){e=e.substring(i.raw.length),t.push(i);continue}if(i=this.tokenizer.def(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type===`paragraph`||n?.type===`text`?(n.raw+=(n.raw.endsWith(`
`)?``:`
`)+i.raw,n.text+=`
`+i.raw,this.inlineQueue.at(-1).src=n.text):this.tokens.links[i.tag]||(this.tokens.links[i.tag]={href:i.href,title:i.title},t.push(i));continue}if((i=this.tokenizer.table(e))||(i=this.tokenizer.lheading(e))){e=e.substring(i.raw.length),t.push(i);continue}let a=e;if(this.options.extensions?.startBlock){let t=1/0,n=e.slice(1),r;this.options.extensions.startBlock.forEach(e=>{r=e.call({lexer:this},n),typeof r==`number`&&r>=0&&(t=Math.min(t,r))}),t<1/0&&t>=0&&(a=e.substring(0,t+1))}if(this.state.top&&(i=this.tokenizer.paragraph(a))){let r=t.at(-1);n&&r?.type===`paragraph`?(r.raw+=(r.raw.endsWith(`
`)?``:`
`)+i.raw,r.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=r.text):t.push(i),n=a.length!==e.length,e=e.substring(i.raw.length)}else if(i=this.tokenizer.text(e)){e=e.substring(i.raw.length);let n=t.at(-1);n?.type===`text`?(n.raw+=(n.raw.endsWith(`
`)?``:`
`)+i.raw,n.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=n.text):t.push(i)}else if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return this.state.top=!0,t}inline(e,t=[]){return this.inlineQueue.push({src:e,tokens:t}),t}linkInText(e){if(!e.includes(`[`))return!1;let t=this.tokenizer.rules.inline.link;for(let n of e.matchAll(this.tokenizer.rules.inline.blockSkip))if(t.test(n[0])&&e.charAt(n.index-1)!==`!`)return!0;for(let t of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)){let e=t[0],n=e.lastIndexOf(`[`);if(e.charAt(0)!==`!`&&Object.hasOwn(this.tokens.links,Zn(e.slice(n+1,-1)))&&!(n>1&&this.linkInText(e.slice(1,n-1))))return!0}return!1}inlineTokens(e,t=[]){this.tokenizer.lexer=this;let n=this.state.linkParenPossible;this.state.linkParenPossible=n&&e.includes(`)`);try{return this.#e(e,t)}finally{this.state.linkParenPossible=n}}#e(e,t){let n=e;if(this.tokens.links&&e.includes(`[`)){let e=this.tokenizer.rules.inline.reflinkSearch,t=n=>{let r=n.lastIndexOf(`[`);if(!Object.hasOwn(this.tokens.links,Zn(n.slice(r+1,-1))))return n;if(r>1&&n.charAt(0)!==`!`){let i=n.slice(1,r-1);if(this.linkInText(i))return`[`+i.replace(e,t)+`][`+`a`.repeat(n.length-r-2)+`]`}return`[`+`a`.repeat(n.length-2)+`]`};n=n.replace(e,t)}n=n.replace(this.tokenizer.rules.inline.anyPunctuation,e=>`+`.repeat(e.length)),n=n.replace(this.tokenizer.rules.inline.blockSkip,(e,t,n)=>{let r=n?n.length:0;return e.slice(0,r)+`[`+`a`.repeat(e.length-r-2)+`]`}),n=this.options.hooks?.emStrongMask?.call({lexer:this},n)??n;let r=!1,i=``,a=1/0;for(;e;){if(e.length<a)a=e.length;else{this.infiniteLoopError(e.charCodeAt(0));break}r||(i=``),r=!1;let o;if(this.options.extensions?.inline?.some(n=>(o=n.call({lexer:this},e,t))?(e=e.substring(o.raw.length),t.push(o),!0):!1))continue;if((o=this.tokenizer.escape(e))||(o=this.tokenizer.tag(e))||(o=this.tokenizer.link(e))){e=e.substring(o.raw.length),t.push(o);continue}if(o=this.tokenizer.reflink(e,this.tokens.links)){e=e.substring(o.raw.length);let n=t.at(-1);o.type===`text`&&n?.type===`text`?(n.raw+=o.raw,n.text+=o.text):t.push(o);continue}if((o=this.tokenizer.emStrong(e,n,i))||(o=this.tokenizer.codespan(e))||(o=this.tokenizer.br(e))||(o=this.tokenizer.del(e,n,i))||(o=this.tokenizer.autolink(e))||!this.state.inLink&&(o=this.tokenizer.url(e))){e=e.substring(o.raw.length),t.push(o);continue}let s=e;if(this.options.extensions?.startInline){let t=1/0,n=e.slice(1),r;this.options.extensions.startInline.forEach(e=>{r=e.call({lexer:this},n),typeof r==`number`&&r>=0&&(t=Math.min(t,r))}),t<1/0&&t>=0&&(s=e.substring(0,t+1))}if(o=this.tokenizer.inlineText(s)){e=e.substring(o.raw.length),o.raw.slice(-1)!==`_`&&(i=o.raw.slice(-1)),r=!0;let n=t.at(-1);n?.type===`text`?(n.raw+=o.raw,n.text+=o.text):t.push(o)}else if(e){this.infiniteLoopError(e.charCodeAt(0));break}}return t}infiniteLoopError(e){let t=`Infinite loop on byte: `+e;if(this.options.silent)console.error(t);else throw Error(t)}},ir=class{options;parser;constructor(e){this.options=e||B}space(e){return``}code({text:e,lang:t,escaped:n}){let r=(t||``).match(W.notSpaceStart)?.[0],i=e?e.replace(W.endingNewline,``)+`
`:``;return r?`<pre><code class="language-`+J(r)+`">`+(n?i:J(i,!0))+`</code></pre>
`:`<pre><code>`+(n?i:J(i,!0))+`</code></pre>
`}blockquote({tokens:e}){return`<blockquote>
${this.parser.parse(e)}</blockquote>
`}html({text:e}){return e}def(e){return``}heading({tokens:e,depth:t}){return`<h${t}>${this.parser.parseInline(e)}</h${t}>
`}hr(e){return`<hr>
`}list(e){let t=e.ordered,n=e.start,r=``;for(let t=0;t<e.items.length;t++){let n=e.items[t];r+=this.listitem(n)}let i=t?`ol`:`ul`,a=t&&n!==1?` start="`+n+`"`:``;return`<`+i+a+`>
`+r+`</`+i+`>
`}listitem(e){return`<li>${this.parser.parse(e.tokens)}</li>
`}checkbox({checked:e}){return`<input `+(e?`checked="" `:``)+`disabled="" type="checkbox"> `}paragraph({tokens:e}){return`<p>${this.parser.parseInline(e)}</p>
`}table(e){let t=``,n=``;for(let t=0;t<e.header.length;t++)n+=this.tablecell(e.header[t]);t+=this.tablerow({text:n});let r=``;for(let t=0;t<e.rows.length;t++){let i=e.rows[t];n=``;for(let e=0;e<i.length;e++)n+=this.tablecell(i[e]);r+=this.tablerow({text:n})}return r&&=`<tbody>${r}</tbody>`,`<table>
<thead>
`+t+`</thead>
`+r+`</table>
`}tablerow({text:e}){return`<tr>
${e}</tr>
`}tablecell(e){let t=this.parser.parseInline(e.tokens),n=e.header?`th`:`td`;return(e.align?`<${n} align="${e.align}">`:`<${n}>`)+t+`</${n}>
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${J(e,!0)}</code>`}br(e){return`<br>`}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,text:n,tokens:r,autolink:i}){let a=i?J(n,!0):this.parser.parseInline(r),o=Jn(e);if(o===null)return a;e=J(o,i);let s=`<a href="`+e+`"`;return t&&(s+=` title="`+J(t)+`"`),s+=`>`+a+`</a>`,s}image({href:e,title:t,text:n,tokens:r}){r&&(n=this.parser.parseInline(r,this.parser.textRenderer));let i=Jn(e);if(i===null)return J(n);e=i;let a=`<img src="${J(e)}" alt="${J(n)}"`;return t&&(a+=` title="${J(t)}"`),a+=`>`,a}text(e){return`tokens`in e&&e.tokens?this.parser.parseInline(e.tokens):`escaped`in e&&e.escaped?e.text:J(e.text)}},ar=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return``+e}image({text:e}){return``+e}br(){return``}checkbox({raw:e}){return e}},Z=class e{options;renderer;textRenderer;constructor(e){this.options=e||B,this.options.renderer=this.options.renderer||new ir,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new ar}static parse(t,n){return new e(n).parse(t)}static parseInline(t,n){return new e(n).parseInline(t)}parse(e){this.renderer.parser=this;let t=``;for(let n=0;n<e.length;n++){let r=e[n];if(this.options.extensions?.renderers?.[r.type]){let e=r,n=this.options.extensions.renderers[e.type].call({parser:this},e);if(n!==!1||![`space`,`hr`,`heading`,`code`,`table`,`blockquote`,`list`,`checkbox`,`html`,`def`,`paragraph`,`text`].includes(e.type)){t+=n||``;continue}}let i=r;switch(i.type){case`space`:t+=this.renderer.space(i);break;case`hr`:t+=this.renderer.hr(i);break;case`heading`:t+=this.renderer.heading(i);break;case`code`:t+=this.renderer.code(i);break;case`table`:t+=this.renderer.table(i);break;case`blockquote`:t+=this.renderer.blockquote(i);break;case`list`:t+=this.renderer.list(i);break;case`checkbox`:t+=this.renderer.checkbox(i);break;case`html`:t+=this.renderer.html(i);break;case`def`:t+=this.renderer.def(i);break;case`paragraph`:t+=this.renderer.paragraph(i);break;case`text`:t+=this.renderer.text(i);break;default:{let e=`Token with "`+i.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return t}parseInline(e,t=this.renderer){this.renderer.parser=this;let n=``;for(let r=0;r<e.length;r++){let i=e[r];if(this.options.extensions?.renderers?.[i.type]){let e=this.options.extensions.renderers[i.type].call({parser:this},i);if(e!==!1||![`escape`,`html`,`link`,`image`,`checkbox`,`strong`,`em`,`codespan`,`br`,`del`,`text`].includes(i.type)){n+=e||``;continue}}let a=i;switch(a.type){case`escape`:n+=t.text(a);break;case`html`:n+=t.html(a);break;case`link`:n+=t.link(a);break;case`image`:n+=t.image(a);break;case`checkbox`:n+=t.checkbox(a);break;case`strong`:n+=t.strong(a);break;case`em`:n+=t.em(a);break;case`codespan`:n+=t.codespan(a);break;case`br`:n+=t.br(a);break;case`del`:n+=t.del(a);break;case`text`:n+=t.text(a);break;default:{let e=`Token with "`+a.type+`" type was not found.`;if(this.options.silent)return console.error(e),``;throw Error(e)}}}return n}},or=class{options;block;constructor(e){this.options=e||B}static passThroughHooks=new Set([`preprocess`,`postprocess`,`processAllTokens`,`emStrongMask`]);static passThroughHooksRespectAsync=new Set([`preprocess`,`postprocess`,`processAllTokens`]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(e=this.block){return e?X.lex:X.lexInline}provideParser(e=this.block){return e?Z.parse:Z.parseInline}},sr=class{defaults=kt();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=Z;Renderer=ir;TextRenderer=ar;Lexer=X;Tokenizer=rr;Hooks=or;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(let r of e)switch(n=n.concat(t.call(this,r)),r.type){case`table`:{let e=r;for(let r of e.header)n=n.concat(this.walkTokens(r.tokens,t));for(let r of e.rows)for(let e of r)n=n.concat(this.walkTokens(e.tokens,t));break}case`list`:{let e=r;n=n.concat(this.walkTokens(e.items,t));break}default:{let e=r;this.defaults.extensions?.childTokens?.[e.type]?this.defaults.extensions.childTokens[e.type].forEach(r=>{let i=e[r].flat(1/0);n=n.concat(this.walkTokens(i,t))}):e.tokens&&(n=n.concat(this.walkTokens(e.tokens,t)))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(e=>{let n={...e};if(n.async=this.defaults.async||n.async||!1,e.extensions&&(e.extensions.forEach(e=>{if(!e.name)throw Error(`extension name required`);if(`renderer`in e){let n=t.renderers[e.name];n?t.renderers[e.name]=function(...t){let r=e.renderer.apply(this,t);return r===!1&&(r=n.apply(this,t)),r}:t.renderers[e.name]=e.renderer}if(`tokenizer`in e){if(!e.level||e.level!==`block`&&e.level!==`inline`)throw Error(`extension level must be 'block' or 'inline'`);let n=t[e.level];n?n.unshift(e.tokenizer):t[e.level]=[e.tokenizer],e.start&&(e.level===`block`?t.startBlock?t.startBlock.push(e.start):t.startBlock=[e.start]:e.level===`inline`&&(t.startInline?t.startInline.push(e.start):t.startInline=[e.start]))}`childTokens`in e&&e.childTokens&&(t.childTokens[e.name]=e.childTokens)}),n.extensions=t),e.renderer){let t=this.defaults.renderer||new ir(this.defaults);for(let n in e.renderer){if(!(n in t))throw Error(`renderer '${n}' does not exist`);if([`options`,`parser`].includes(n))continue;let r=n,i=e.renderer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n||``}}n.renderer=t}if(e.tokenizer){let t=this.defaults.tokenizer||new rr(this.defaults);for(let n in e.tokenizer){if(!(n in t))throw Error(`tokenizer '${n}' does not exist`);if([`options`,`rules`,`lexer`].includes(n))continue;let r=n,i=e.tokenizer[r],a=t[r];t[r]=(...e)=>{let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.tokenizer=t}if(e.hooks){let t=this.defaults.hooks||new or;for(let n in e.hooks){if(!(n in t))throw Error(`hook '${n}' does not exist`);if([`options`,`block`].includes(n))continue;let r=n,i=e.hooks[r],a=t[r];t[r]=or.passThroughHooks.has(n)?e=>{if(this.defaults.async&&or.passThroughHooksRespectAsync.has(n))return(async()=>{let n=await i.call(t,e);return a.call(t,n)})();let r=i.call(t,e);return a.call(t,r)}:(...e)=>{if(this.defaults.async)return(async()=>{let n=await i.apply(t,e);return n===!1&&(n=await a.apply(t,e)),n})();let n=i.apply(t,e);return n===!1&&(n=a.apply(t,e)),n}}n.hooks=t}if(e.walkTokens){let t=this.defaults.walkTokens,r=e.walkTokens;n.walkTokens=function(e){let n=[];return n.push(r.call(this,e)),t&&(n=n.concat(t.call(this,e))),n}}this.defaults={...this.defaults,...n}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return X.lex(e,t??this.defaults)}parser(e,t){return Z.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let r={...n},i={...this.defaults,...r},a=this.onError(!!i.silent,!!i.async);if(this.defaults.async===!0&&r.async===!1)return a(Error(`marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise.`));if(typeof t>`u`||t===null)return a(Error(`marked(): input parameter is undefined or null`));if(typeof t!=`string`)return a(Error(`marked(): input parameter is of type `+Object.prototype.toString.call(t)+`, string expected`));if(i.hooks&&(i.hooks.options=i,i.hooks.block=e),i.async)return(async()=>{let n=i.hooks?await i.hooks.preprocess(t):t,r=await(i.hooks?await i.hooks.provideLexer(e):e?X.lex:X.lexInline)(n,i),a=i.hooks?await i.hooks.processAllTokens(r):r;i.walkTokens&&await Promise.all(this.walkTokens(a,i.walkTokens));let o=await(i.hooks?await i.hooks.provideParser(e):e?Z.parse:Z.parseInline)(a,i);return i.hooks?await i.hooks.postprocess(o):o})().catch(a);try{i.hooks&&(t=i.hooks.preprocess(t));let n=(i.hooks?i.hooks.provideLexer(e):e?X.lex:X.lexInline)(t,i);i.hooks&&(n=i.hooks.processAllTokens(n)),i.walkTokens&&this.walkTokens(n,i.walkTokens);let r=(i.hooks?i.hooks.provideParser(e):e?Z.parse:Z.parseInline)(n,i);return i.hooks&&(r=i.hooks.postprocess(r)),r}catch(e){return a(e)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let e=`<p>An error occurred:</p><pre>`+J(n.message+``,!0)+`</pre>`;return t?Promise.resolve(e):e}if(t)return Promise.reject(n);throw n}}},Q=new sr;function $(e,t){return Q.parse(e,t)}$.options=$.setOptions=function(e){return Q.setOptions(e),$.defaults=Q.defaults,At($.defaults),$},$.getDefaults=kt,$.defaults=B;function cr(...e){return Q.use(...e),$.defaults=Q.defaults,At($.defaults),$}$.use=cr,$.walkTokens=function(e,t){return Q.walkTokens(e,t)},$.parseInline=Q.parseInline,$.Parser=Z,$.parser=Z.parse,$.Renderer=ir,$.TextRenderer=ar,$.Lexer=X,$.lexer=X.lex,$.Tokenizer=rr,$.Hooks=or,$.parse=$,$.options,$.setOptions,$.walkTokens,$.parseInline,Z.parse,X.lex;function lr(e){let t=e=>e.map(e=>e.type===`codespan`||e.type===`html`?``:`tokens`in e&&e.tokens?t(e.tokens):`text`in e?e.text:``).join(``);return/\p{L}/u.test(t(X.lexInline(e)))}function ur(e,t){for(let n of e)if(n.type===`heading`||n.type===`paragraph`||n.type===`text`&&n.tokens)t(n);else if(n.type===`table`){let e=n;for(let n of[...e.header,...e.rows.flat()])t(n)}else if(n.type===`list`)for(let e of n.items)ur(e.tokens,t);else n.type===`blockquote`&&ur(n.tokens,t)}function dr(e){let t=[];return ur(X.lex(e),e=>{lr(e.text)&&t.push(e.text)}),[...new Set(t)]}function fr(e,t){ur(e,e=>{if(!lr(e.text))return;let n=t[e.text];if(n===void 0)throw Error(`Missing guide translation: ${e.text}`);e.text=n,e.tokens=X.lexInline(n)})}var pr=Object.assign({"../../../../../../../docs/README.md":Ae,"../../../../../../../docs/api.md":je,"../../../../../../../docs/architecture.md":Me,"../../../../../../../docs/auth-integration.md":Ne,"../../../../../../../docs/backup.md":Pe,"../../../../../../../docs/cli.md":Fe,"../../../../../../../docs/configuration.md":Ie,"../../../../../../../docs/decisions.md":Le,"../../../../../../../docs/deploy.md":Re,"../../../../../../../docs/glossary.md":ze,"../../../../../../../docs/host-management.md":Be,"../../../../../../../docs/jwt-and-roles.md":Ve,"../../../../../../../docs/leaving.md":He,"../../../../../../../docs/panel-updates.md":Ue,"../../../../../../../docs/panel.md":We,"../../../../../../../docs/quickstart.md":Ge,"../../../../../../../docs/schema-auth.md":Ke,"../../../../../../../docs/storage.md":qe,"../../../../../../../docs/troubleshooting.md":Je,"../../../../../../../docs/webhooks.md":Ye,"../../../../../../../examples/notes.sql":Xe,"../../../../../../../sdk/rust/README.md":Ze,"../../../../../../../sdk/rust/docs/contract.md":Qe,"../../../../../../../sdk/rust/docs/quickstart.pt-BR.md":$e,"../../../../../../../sdk/rust/docs/releasing.md":et,"../../../../../../../sdk/typescript/CHANGELOG.md":tt,"../../../../../../../sdk/typescript/README.md":nt,"../../../../../../../sdk/typescript/docs/contract.md":rt,"../../../../../../../sdk/typescript/docs/quickstart.pt-BR.md":it,"../../../../../../../sdk/typescript/docs/releasing.md":at,"../../../../../../../sdk/typescript/examples/server.mjs":ot}),mr=Object.assign({"../../../../../../../docs/i18n/pt-BR/api.json":st,"../../../../../../../docs/i18n/pt-BR/architecture.json":ct,"../../../../../../../docs/i18n/pt-BR/auth.json":lt,"../../../../../../../docs/i18n/pt-BR/backup.json":ut,"../../../../../../../docs/i18n/pt-BR/changelog.json":dt,"../../../../../../../docs/i18n/pt-BR/decisions.json":ft,"../../../../../../../docs/i18n/pt-BR/deploy.json":pt,"../../../../../../../docs/i18n/pt-BR/leaving.json":mt,"../../../../../../../docs/i18n/pt-BR/openapi.json":ht,"../../../../../../../docs/i18n/pt-BR/panel.json":gt,"../../../../../../../docs/i18n/pt-BR/quickstart.json":_t,"../../../../../../../docs/i18n/pt-BR/roles.json":vt,"../../../../../../../docs/i18n/pt-BR/rust-contract.json":yt,"../../../../../../../docs/i18n/pt-BR/rust-releasing.json":bt,"../../../../../../../docs/i18n/pt-BR/sdk-contract.json":xt,"../../../../../../../docs/i18n/pt-BR/sdk-releasing.json":St,"../../../../../../../docs/i18n/pt-BR/sdk-rust.json":Ct,"../../../../../../../docs/i18n/pt-BR/sdk.json":wt,"../../../../../../../docs/i18n/pt-BR/storage.json":Tt,"../../../../../../../docs/i18n/pt-BR/troubleshooting.json":Et,"../../../../../../../docs/i18n/pt-BR/webhooks.json":Dt});function hr(e){return pr[`../../../../../../../${e.source}`]??``}function gr(e,t){if(t!==`pt-BR`||`language`in e||`code`in e||e.id===`openapi`)return;let n=mr[`../../../../../../../docs/i18n/pt-BR/${e.id}.json`];if(!n)throw Error(`Missing Portuguese guide: ${e.source}`);return n}var _r=new Map;function vr(e,t){let n=`${t}:${e.id}`;if(!_r.has(n)){let r=hr(e),i=gr(e,t);_r.set(n,`${r}\n${i?dr(r).map(e=>i[e]).join(`
`):``}`)}return _r.get(n)}function yr(e,t){if(e.startsWith(`#`)){let n=R.find(e=>e.source===t);return n?`/admin${z(n.id,e.slice(1))}`:null}let n;try{n=new URL(e,`https://nelcota.local/${t}`)}catch{return null}if(n.protocol!==`https:`&&n.protocol!==`http:`)return null;let r;try{r=decodeURIComponent(n.pathname).replace(/^\//,``)}catch{return null}if(n.hostname!==`github.com`&&n.hostname!==`nelcota.local`)return n.href;if(n.hostname===`github.com`){let e=[`Nelcota/Nelcota/`,`HanielCota/Nelcota/`].find(e=>r.startsWith(e));if(!e)return null;if(r=r.slice(e.length).replace(/^(?:blob|tree)\/[^/]+\//,``),!r)return`/admin/guides`}let i=R.find(e=>e.source===r);return i?`/admin${z(i.id,n.hash.slice(1))}`:r===`docs/onboarding/notes.md`?`https://github.com/Nelcota/Nelcota/blob/main/${r}${n.hash}`:r===`sdk/typescript/examples/`?`/admin/guides/example`:r===`scripts/install.sh`?`/admin/guides/quickstart`:null}var br=Object.assign({"../../../../../../../docs/assets/panel-overview-dark.png":`/admin/assets/panel-overview-dark-BObdUVf0.png`,"../../../../../../../docs/assets/panel-overview-light.png":`/admin/assets/panel-overview-light-1XY7TBjz.png`,"../../../../../../../docs/assets/panel-table-dark.png":`/admin/assets/panel-table-dark-8Og_-0IR.png`,"../../../../../../../docs/assets/panel-table-light.png":`/admin/assets/panel-table-light-DhR0LNNV.png`}),xr=e=>e.replaceAll(`&`,`&amp;`).replaceAll(`<`,`&lt;`).replaceAll(`>`,`&gt;`).replaceAll(`"`,`&quot;`).replaceAll(`'`,`&#39;`),Sr=e=>e.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu,``).replace(/\s/g,`-`),Cr=(e=``)=>[`ts`,`js`,`typescript`,`javascript`].includes(e)?`ts`:[`sh`,`shell`,`bash`].includes(e)?`sh`:e===`sql`||e===`env`?e:void 0;function wr(e,t,n){let r=new Map,i=new sr({renderer:{html({text:e}){return xr(e)},link({href:e,tokens:n}){let r=this.parser.parseInline(n),i=yr(e,t);if(!i)return r;let a=/^https?:/.test(i);return`<a href="${xr(i)}"${a?` target="_blank" rel="noopener noreferrer"`:``}>${r}</a>`},image({href:e,text:n}){let r=new URL(e,`https://nelcota.local/${t}`),i=r.hostname===`nelcota.local`?br[`../../../../../../../${r.pathname.slice(1)}`]:void 0;return i?`<img src="${xr(i)}" alt="${xr(n)}" loading="lazy" />`:xr(n)},table(e){return`<div class="guide-table" tabindex="0">${ir.prototype.table.call(this,e)}</div>`}}}),a=i.lexer(e),o=new Map;for(let[e,t]of a.entries()){if(t.type!==`heading`||e===0&&t.depth===1)continue;let n=t,i=Sr(n.text),a=r.get(i)??0;r.set(i,a+1),o.set(n,a?`${i}-${a}`:i)}return n&&fr(a,n),a.flatMap((e,t)=>{if(e.type===`space`||e.type===`def`||t===0&&e.type===`heading`&&e.depth===1)return[];if(e.type===`code`)return[{type:`code`,code:e.text,lang:Cr(e.lang)}];if(e.type===`heading`){let t=e,n=i.parseInline(t.text,{async:!1});return[{type:`heading`,id:o.get(t),text:t.text.replace(/[`*_]/g,``),html:n,level:Math.max(2,t.depth)}]}return[{type:`html`,html:i.parser([e])}]})}var Tr=ht,Er=Object.keys(ht).find(e=>e.startsWith(`Group of filters`)),Dr=(e,t)=>e.replace(`{}`,t.toUpperCase()).replaceAll(`{logic}`,t);function Or(e){if(typeof e!=`string`)return e;if(Object.hasOwn(Tr,e))return Tr[e];for(let t of[`and`,`or`])if(e===Dr(Er,t))return Dr(Tr[Er],t);return e}function kr(e,t){if(t!==`pt-BR`)return e;let n=structuredClone(e),r=P(n.info);for(let e of[`title`,`description`])e in r&&(r[e]=Or(r[e]));for(let{operation:e}of F(n)){for(let t of Array.isArray(e.parameters)?e.parameters:[]){let e=P(t);`description`in e&&(e.description=Or(e.description))}for(let t of Object.values(P(e.responses))){let e=P(t);`description`in e&&(e.description=Or(e.description))}}function i(e){let t=he(e.description);t&&(e.description=t.replace(/(^|\n\n)Postgres type: ([^\n]+)$/,(e,t,n)=>`${t}${Tr[`Postgres type: {}`].replace(`{}`,n)}`));for(let t of Object.values(P(e.properties)))i(P(t));e.items&&i(P(e.items));for(let t of[`oneOf`,`anyOf`,`allOf`])if(Array.isArray(e[t]))for(let n of e[t])i(P(n))}for(let e of Object.values(P(P(n.components).schemas)))i(P(e));return n}var Ar=k(`<!> `,1),jr=k(`<!><!>`,1),Mr=k(`<iframe src="/admin/assets/reference.html" class="h-[75dvh] min-h-96 w-full rounded-xl border"></iframe>`),Nr=k(`<!> <!>`,1),Pr=k(`<div class="grid min-w-0 gap-5"><p class="rounded-2xl bg-well p-4 text-sm leading-relaxed text-muted-foreground"> </p> <div class="flex flex-wrap items-center gap-2"><!> <!></div> <!> <!> <!></div>`);function Fr(n,s){f(s,!0);let d=new L,h=t(void 0);function g(){if(!d.data)return;let e=o(d.data);x(h)?.contentWindow?.postMessage({type:`nelcota:openapi`,document:kr(e,C.locale),dark:document.documentElement.classList.contains(`dark`),locale:C.locale},location.origin)}A(()=>{d.data&&g()});async function _(){await d.load(async e=>{let t=await fetch(`/rest/v1/`,{signal:e,headers:{Accept:`application/json`},credentials:`omit`,cache:`no-store`});if(!t.ok)throw Error(D(`guides.openapi.unavailable`));let n=await t.json();if(!ge(n))throw Error(D(`guides.openapi.invalid`));return n})}y(()=>{_();let e=new MutationObserver(g);return e.observe(document.documentElement,{attributes:!0,attributeFilter:[`class`]}),()=>{e.disconnect(),d.cancel()}});var S=Pr(),ne=p(S),ie=j(ne,!0),k=m(ne,2),oe=p(k);te(oe,{variant:`outline`,size:`sm`,onclick:_,get disabled(){return d.loading},children:(t,n)=>{var r=Ar(),a=i(r);M(a,{});var o=m(a,1,!0);b(e=>v(o,e),[()=>D(`guides.openapi.reload`)]),e(t,r)},$$slots:{default:!0}});var se=m(oe,2),ce=t=>{var n=jr(),r=i(n);te(r,{variant:`outline`,size:`sm`,onclick:()=>De(`openapi.json`,JSON.stringify(d.data,null,2),`application/json`),children:(t,n)=>{var r=Ar(),a=i(r);I(a,{});var o=m(a,1,!0);b(e=>v(o,e),[()=>D(`guides.openapi.download`)]),e(t,r)},$$slots:{default:!0}});var a=m(r);Ee(a,{variant:`secondary`,children:(t,n)=>{ee();var r=re();b(()=>v(r,`OpenAPI ${d.data.openapi??``}`)),e(t,r)},$$slots:{default:!0}}),e(t,n)};E(se,e=>{d.data&&e(ce)}),a(k);var le=m(k,2),ue=e=>{{let t=l(()=>T(d.error));pe(e,{get message(){return x(t)},onretry:_,get busy(){return d.loading}})}};E(le,e=>{d.error&&e(ue)});var de=m(le,2),fe=e=>{ye(e,{class:`h-48 rounded-2xl`})};E(de,e=>{d.loading&&e(fe)});var N=m(de,2),me=t=>{var n=Nr(),a=i(n),o=t=>{var n=Mr();r(n,e=>u(h,e),()=>x(h)),b(e=>w(n,`title`,e),[()=>D(`guides.entries.openapi.title`)]),O(`load`,n,g),ae(n),e(t,n)},s=l(()=>F(d.data).length);E(a,e=>{x(s)&&e(o)});var c=m(a,2),f=e=>{{let t=l(()=>D(`guides.openapi.empty`)),n=l(()=>D(`guides.openapi.emptyHint`));Se(e,{get icon(){return ve},get title(){return x(t)},get description(){return x(n)}})}},p=l(()=>!F(d.data).length);E(c,e=>{x(p)&&e(f)}),e(t,n)};E(N,e=>{!d.loading&&d.data&&e(me)}),a(S),b(e=>v(ie,e),[()=>D(`guides.openapi.hint`)]),e(n,S),c()}var Ir=k(`<span class="truncate"> </span>`),Lr=k(`<!> <!>`,1),Rr=k(`<a> </a>`),zr=k(`<div class="grid gap-1"><h2 class="px-3 pb-1 text-xs font-semibold text-muted-foreground"> </h2> <!></div>`),Br=k(` <!>`,1),Vr=k(`<a class="text-sm text-muted-foreground hover:text-foreground"> </a>`),Hr=k(`<details class="rounded-2xl bg-well p-4 xl:hidden"><summary class="cursor-pointer text-sm font-medium"> </summary> <nav class="mt-3 grid gap-2"></nav></details>`),Ur=k(`<div class="guide-prose min-w-0 svelte-k0ze7g"></div>`),Wr=k(`<!> <!> <!>`,1),Gr=k(`<!> <div class="grid min-w-0 gap-4"></div>`,1),Kr=k(`<a class="border-l py-2 pl-3 text-xs leading-relaxed text-muted-foreground transition-colors hover:border-brand hover:text-foreground"> </a>`),qr=k(`<nav class="sticky top-4 hidden max-h-[80dvh] overflow-y-auto xl:grid"><h2 class="pb-3 text-xs font-semibold text-muted-foreground"> </h2> <!></nav>`),Jr=k(`<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 sm:px-6 lg:px-8 [&amp;>:first-child]:mb-0"><!> <div class="grid items-start gap-6 md:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_12rem]"><aside class="grid gap-4 md:sticky md:top-4"><!> <div class="md:hidden"><!></div> <nav><!> <!></nav></aside> <article class="guide-reader grid min-w-0 gap-5 rounded-3xl bg-card p-5 sm:p-7 lg:p-8 svelte-k0ze7g"><header class="grid gap-3 border-b pb-5"><div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><!> </div> <h2 class="text-xl font-semibold tracking-tight sm:text-2xl"> </h2> <p class="text-sm text-muted-foreground"> </p> <!></header> <!> <!> <!></article> <!></div></div>`);function Yr(o,y){f(y,!0);let ae=t(``),T=t(void 0),O=l(()=>fe.path.replace(/\/$/,``)),k=l(()=>x(O)!==`/guides`&&!R.some(e=>x(O)===z(e.id))),M=l(()=>R.find(e=>x(O)===z(e.id))??R.find(e=>e.id===(C.locale===`pt-BR`?`sdk-start`:`quickstart`))),pe=l(()=>hr(x(M))),he=l(()=>`code`in x(M)?[]:wr(x(pe),x(M).source,gr(x(M),C.locale))),P=l(()=>x(he).filter(e=>e.type===`heading`)),F=l(()=>R.filter(e=>ke(`${D(`guides.entries.${e.id}.title`)} ${D(`guides.entries.${e.id}.description`)} ${vr(e,C.locale)}`,x(ae))>0));A(()=>{let e=fe.query.get(`section`),t=x(M).id;ne().then(()=>{if(x(M).id!==t)return;let n=e&&x(T)?Array.from(x(T).querySelectorAll(`[id]`)).find(t=>t.id===e):null;n?n.scrollIntoView({block:`start`}):document.getElementById(`conteudo`)?.scrollTo({top:0})})});var ge=Lr(),ve=i(ge),I=e=>{Oe(e,{})};E(ve,e=>{x(k)&&e(I)});var ye=m(ve,2),L=t=>{var o=Jr(),c=p(o);{let e=l(()=>D(`guides.title`)),t=l(()=>D(`guides.description`));be(c,{get title(){return x(e)},get description(){return x(t)}})}var f=m(c,2),y=p(f),ne=p(y);{let e=l(()=>D(`guides.search`));Te(ne,{get label(){return x(e)},get value(){return x(ae)},set value(e){u(ae,e,!0)}})}var O=m(ne,2),k=p(O);g(k,()=>de,(t,n)=>{n(t,{type:`single`,get value(){return x(M).id},onValueChange:e=>{e&&me(`/guides/${e}`)},children:(t,n)=>{var r=Lr(),a=i(r);{let t=l(()=>D(`guides.choose`));g(a,()=>ce,(n,r)=>{r(n,{class:`w-full`,get"aria-label"(){return x(t)},children:(t,n)=>{var r=Ir(),i=j(r,!0);b(e=>v(i,e),[()=>D(`guides.entries.${x(M).id}.title`)]),e(t,r)},$$slots:{default:!0}})})}var o=m(a,2);g(o,()=>le,(t,n)=>{n(t,{children:(t,n)=>{var r=S(),a=i(r);_(a,16,()=>Ot,e=>e,(t,n)=>{var r=S(),a=i(r);g(a,()=>se,(t,r)=>{r(t,{children:(t,r)=>{var a=Lr(),o=i(a);g(o,()=>oe,(t,r)=>{r(t,{children:(t,r)=>{ee();var i=re();b(e=>v(i,e),[()=>D(`guides.groups.${n}`)]),e(t,i)},$$slots:{default:!0}})});var s=m(o,2);_(s,17,()=>x(F).filter(e=>e.group===n),e=>e.id,(t,n)=>{var r=S(),a=i(r);g(a,()=>ue,(t,r)=>{r(t,{get value(){return x(n).id},children:(t,r)=>{ee();var i=re();b(e=>v(i,e),[()=>D(`guides.entries.${x(n).id}.title`)]),e(t,i)},$$slots:{default:!0}})}),e(t,r)}),e(t,a)},$$slots:{default:!0}})}),e(t,r)}),e(t,r)},$$slots:{default:!0}})}),e(t,r)},$$slots:{default:!0}})}),a(O);var A=m(O,2),fe=p(A);_(fe,16,()=>Ot,e=>e,(t,n)=>{let r=l(()=>x(F).filter(e=>e.group===n));var o=S(),c=i(o),u=t=>{var i=zr(),o=p(i),c=j(o,!0),l=m(o,2);_(l,17,()=>x(r),e=>e.id,(t,n)=>{var r=Rr(),i=j(r,!0);b((e,t)=>{s(r,1,d([`rounded-xl px-3 py-2 text-sm transition-colors`,x(M).id===x(n).id?`bg-nav-active font-medium text-nav-active-foreground`:`text-muted-foreground hover:bg-nav hover:text-foreground`])),w(r,`href`,e),w(r,`aria-current`,x(M).id===x(n).id?`page`:void 0),v(i,t)},[()=>N(z(x(n).id)),()=>D(`guides.entries.${x(n).id}.title`)]),e(t,r)}),a(i),b(e=>v(c,e),[()=>D(`guides.groups.${n}`)]),e(t,i)};E(c,e=>{x(r).length&&e(u)}),e(t,o)});var ge=m(fe,2),ve=e=>{{let t=l(()=>D(`guides.noResults`)),n=l(()=>D(`guides.noResultsHint`));Se(e,{get icon(){return we},get title(){return x(t)},get description(){return x(n)}})}};E(ge,e=>{x(F).length||e(ve)}),a(A),a(y);var I=m(y,2),ye=p(I),L=p(ye),Ee=p(L);_e(Ee,{class:`size-4`,"aria-hidden":`true`});var De=m(Ee,1,!0);a(L);var Oe=m(L,2),ke=j(Oe,!0),Ae=m(Oe,2),je=j(Ae,!0),Me=m(Ae,2);{let t=l(()=>N(x(M).action));te(Me,{variant:`outline`,size:`sm`,class:`w-fit`,get href(){return x(t)},children:(t,n)=>{ee();var r=Br(),a=i(r,!0),o=m(a);Ce(o,{"data-icon":`inline-end`,"aria-hidden":`true`}),b(e=>v(a,e),[()=>D(`guides.openPanel`)]),e(t,r)},$$slots:{default:!0}})}a(ye);var Ne=m(ye,2),Pe=e=>{Fr(e,{})};E(Ne,e=>{x(M).id===`openapi`&&e(Pe)});var Fe=m(Ne,2),Ie=e=>{xe(e,{get code(){return x(pe)},get lang(){return x(M).code}})};E(Fe,e=>{x(M).id!==`openapi`&&`code`in x(M)&&e(Ie)});var Le=m(Fe,2),Re=t=>{var r=Gr(),o=i(r),s=t=>{var n=Hr(),r=p(n),i=j(r,!0),o=m(r,2);_(o,21,()=>x(P).filter(e=>e.level===2),e=>e.id,(t,n)=>{var r=Vr(),i=j(r,!0);b(e=>{w(r,`href`,e),v(i,x(n).text)},[()=>N(z(x(M).id,x(n).id))]),e(t,r)}),a(o),a(n),b((e,t)=>{v(i,e),w(o,`aria-label`,t)},[()=>D(`guides.contents`),()=>D(`guides.contents`)]),e(t,n)};E(o,e=>{x(P).length&&e(s)});var c=m(o,2);_(c,23,()=>x(he),(e,t)=>`${x(M).id}:${t}`,(t,r)=>{var o=Wr(),s=i(o),c=e=>{xe(e,{get code(){return x(r).code},get lang(){return x(r).lang}})};E(s,e=>{x(r).type===`code`&&e(c)});var l=m(s,2),u=t=>{var a=S(),o=i(a);n(o,()=>`h${Math.min(x(r).level+1,6)}`,!1,(t,n)=>{ie(t,()=>({id:x(r).id,class:[`scroll-mt-6 pt-5 font-semibold`,x(r).level===2?`text-lg`:`text-base`]}));var a=S(),o=i(a);h(o,()=>x(r).html),e(n,a)}),e(t,a)};E(l,e=>{x(r).type!==`code`&&x(r).type===`heading`&&e(u)});var d=m(l,2),f=t=>{var n=Ur();h(n,()=>x(r).html,!0),a(n),e(t,n)};E(d,e=>{x(r).type!==`code`&&x(r).type!==`heading`&&e(f)}),e(t,o)}),a(c),b(()=>w(c,`lang`,`language`in x(M)?x(M).language:C.locale)),e(t,r)};E(Le,e=>{x(M).id!==`openapi`&&!(`code`in x(M))&&e(Re)}),a(I),r(I,e=>u(T,e),()=>x(T));var ze=m(I,2),Be=t=>{var n=qr(),r=p(n),i=j(r,!0),o=m(r,2);_(o,17,()=>x(P).filter(e=>e.level===2),e=>e.id,(t,n)=>{var r=Kr(),i=j(r,!0);b(e=>{w(r,`href`,e),v(i,x(n).text)},[()=>N(z(x(M).id,x(n).id))]),e(t,r)}),a(n),b((e,t)=>{w(n,`aria-label`,e),v(i,t)},[()=>D(`guides.contents`),()=>D(`guides.contents`)]),e(t,n)};E(ze,e=>{x(P).length&&e(Be)}),a(f),a(o),b((e,t,n,r)=>{w(A,`aria-label`,e),s(A,1,d([x(ae)?`grid`:`hidden md:grid`,`max-h-[65dvh] gap-5 overflow-y-auto pr-1`])),v(De,t),v(ke,n),v(je,r)},[()=>D(`guides.navigation`),()=>D(`guides.groups.${x(M).group}`),()=>D(`guides.entries.${x(M).id}.title`),()=>D(`guides.entries.${x(M).id}.description`)]),e(t,o)};E(ye,e=>{x(k)||e(L)}),e(o,ge),c()}export{Yr as default};