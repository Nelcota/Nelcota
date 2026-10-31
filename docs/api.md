# REST API

Generated from the exposed schema (`NELCOTA_DB_SCHEMA`, default `public`). Every
table, view and function in the schema becomes an endpoint, and **Postgres
decides access**: GRANTs say which roles may use each object and RLS says which
rows each user sees. Functions are exposed only when every input argument is
named; procedures, trigger functions and functions that belong to extensions
are not exposed.

Functions with polymorphic or other pseudo-type input arguments, or `VARIADIC`
parameters, are also excluded from the catalog. JSON argument conversion cannot
call those signatures reliably.

Partitions, and tables that inherit from another table without enabling row
level security of their own, are not exposed either (nor listed in the panel):
use their parent, whose GRANTs and row policies apply to every child's rows.
Read directly, such a child would skip the parent's policies.

Partitions stay hidden even when they enable row level security. An
inheritance child that enables row level security is treated as deliberately
exposed: it gets its own endpoint (and panel entry), where only the child's
own GRANTs and policies apply, not the parent's. Reading the parent still
returns the child's rows under the parent's policies, so give such a child
policies at least as strict as its parent's, or revoke its GRANTs.

## Prerequisites

You need an initialized server, tables/functions in its exposed schema and
GRANTs for the caller. Query examples use illustrative orders/products schemas;
create your own matching SQL first. This reference describes current source;
use release-tag documentation for older binaries.

> New tables have no GRANT for `anon`/`authenticated`: until you grant it, the
> API answers 401/403. This is intentional.
>
> ```sql
> GRANT SELECT, INSERT, UPDATE, DELETE ON public.my_table TO authenticated;
> ALTER TABLE public.my_table ENABLE ROW LEVEL SECURITY;
> CREATE POLICY ... ;
> ```

## Reads: `GET /rest/v1/{table}`

| Parameter | Example | Effect |
|---|---|---|
| `select` | `select=id,title` | columns (default `*`) and embedded relations, see below |
| `{column}` | `price=gt.10` | filter (several are combined with AND) |
| `or`, `and` | `or=(status.eq.paid,status.eq.shipped)` | group of filters, see below |
| `order` | `order=created_at.desc.nullslast,id` | ordering |
| `limit`, `offset` | `limit=20&offset=40` | pagination |

A read runs in a `READ ONLY` transaction, as in PostgREST: a view, policy or
function that tries to write during a `GET` fails with `400 db_error`
(`sqlstate` `25006`) and changes nothing. Function calls (`POST /rpc`) and
writes run read-write.

### Operators

| Operator | SQL | Example |
|---|---|---|
| `eq`, `neq` | `=`, `<>` | `status=eq.active` |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` | `age=gte.18` |
| `like`, `ilike` | `LIKE`, `ILIKE` (`*` becomes `%`) | `name=ilike.*silva*` |
| `in` | `= ANY(...)` | `id=in.(1,2,3)`, `name=in.("a,b",c)` |
| `is` | `IS NULL/TRUE/FALSE/UNKNOWN` | `deleted_at=is.null` |
| `not.` | `NOT (...)` | `status=not.eq.cancelled`, `x=not.is.null` |

Values reach Postgres as parameters and Postgres itself converts them to the
column type (`$1::text::<type>`). A value invalid for the type gives 400.

Fixed-width `char(n)` and `bit(n)` filters compare the complete supplied value
without truncating it to one element. For array columns, `in` accepts quoted
array literals such as `items=in.("{1,2}","{3}")` and compares whole arrays.

### Embedding related rows

`select` follows foreign keys in either direction, so one request returns an
order with its customer and items:

```
GET /rest/v1/orders?select=id,total,customers(name),items(product,qty)

[{ "id": 10, "total": 30.00,
   "customers": { "name": "Ana" },
   "items": [{ "product": "Pen", "qty": 2 }, { "product": "Ruler", "qty": 1 }] }]
```

- When this table has the foreign key (`orders.customer_id → customers`), the
  embed is an **object**, or `null` when nothing matches. When the other table
  points here (`items.order_id → orders`), it is an **array**, `[]` when empty.
- `items(*)` takes every column. `purchases:orders(*)` renames the key.
- Two foreign keys to the same table (`buyer_id`, `seller_id` → `users`) are
  ambiguous: pick one with the column or the constraint name,
  `buyer:users!buyer_id(email),seller:users!seller_id(email)`. The error lists
  the options.
- Embeds nest, up to 4 levels: `customers?select=name,orders(id,items(product))`.
  A table cannot be embedded into itself (self-reference). A key that repeats
  a selected column is a 400: rename it with an alias. Plain columns cannot be
  aliased (`alias:column` is a 400); only embeds can be renamed. An embed key
  (its alias, or the table name) cannot start with `_`, which the generated SQL
  reserves: rename such a table with an alias.
- **RLS applies to the embedded table** too: each embed runs with the request's
  role, so it shows exactly what a direct read of that table would. A related
  row the user cannot see becomes `null` or is left out of the array.
- Works in the representation of writes (`return=representation`).
- Each embed is a correlated subquery: index the foreign key columns on the
  "many" side (Postgres does not create those indexes on its own).

### Filtering, ordering and paging embedded rows

A parameter prefixed with the embed's key (its alias, when it has one) applies
to the embedded rows; a deeper embed adds its key to the path:

```
GET /rest/v1/customers?select=name,orders(id,total,items(product))
    &orders.total=gte.5
    &orders.order=total.desc
    &orders.limit=2
    &orders.items.or=(qty.eq.1,qty.gt.5)
```

- Every filter operator and `or`/`and` work, plus `order`, `limit` and
  `offset`. Paging only applies to arrays: on a single-row embed it is a 400.
- These narrow the **embedded rows only**: the parent rows stay, with `[]` or
  `null` where nothing matched. Filters on the parent table (`?id=eq.1`) still
  pick the parent rows.
- The order of the parameters in the URL does not matter.

### Combining filters: `or` and `and`

Same syntax as PostgREST. Inside the parentheses each filter is written
`column.operator.value`:

```
?or=(status.eq.paid,status.eq.shipped)
?or=(stock.eq.0,and(price.gt.100,featured.is.true))
?not.or=(status.eq.cancelled,deleted_at.not.is.null)
?or=(price.gt.100,price.lt.3)&stock=gt.0      # the group is ANDed with the rest
```

- `and(...)` and `or(...)` nest; `not.` before a group negates it, and
  `column.not.operator.value` negates one filter.
- A value with commas or parentheses goes in double quotes, with `\"` and `\\`
  as escapes: `or=(name.eq."Ruler, 30cm",name.eq."f(x)")`. `in` lists keep
  their own quoting.
- At most 8 nested levels, and at most 100 items (filters and nested groups,
  counted across the whole tree) in each `or`/`and` parameter; beyond that, 400.
- A column literally named `or` or `and` cannot be used as a direct filter,
  only inside a group (`and=(or.eq.1)`), as in PostgREST.
- RLS still applies: a group can only narrow what the policies allow, never
  widen it, on reads and on `PATCH`/`DELETE`.

### Responses

- Body: a JSON array built by Postgres (`json_agg`).
- `Content-Range: 0-19/*`, or `0-19/137` with `Prefer: count=exact` (`*/*` or
  `*/0` when no row is returned).
- `NELCOTA_MAX_ROWS` defaults to **1000** and must be positive. It caps the root
  read, each embedded collection, and set-returning RPCs, including explicit
  limits larger than the cap. Embedded collections in write representations
  have a fixed cap of 1000. Paginate collections to reach subsequent rows.
- JSON has an **8 MiB serialization budget**, checked in PostgreSQL before each
  row enters an aggregate, also on write representations and scalar RPCs.
  Intermediate embedded values count towards the same budget, so deeply nested
  results can reach it with less than 8 MiB of final output. Oversized results
  return `413 response_too_large`; a write requesting such a representation
  rolls back. A single database value must still be serialized before its size
  can be checked. Administrative streaming exports remain available for large data.
- `select` accepts at most 128 items across the relation tree, and at most 16
  embedded relations per request, nested ones included. Repeated columns are
  rejected; `*` already includes explicitly selected columns.

### Concurrent requests

Each caller runs at most `NELCOTA_API_CONCURRENCY_PER_CALLER` REST requests at
a time; by default that is half of `NELCOTA_DB_POOL_SIZE`, at least 1 (5 with
the default pool of 10). The caller is the user of a signed-in token, and
otherwise the client address (the forwarded one with `NELCOTA_TRUST_PROXY`),
with IPv6 addresses grouped by /64 network. `service_role` is not limited. A
request beyond the limit waits up to one second for a slot, then gets
`429 rate_limited` with `Retry-After: 1`; `0` turns the limit off. A server
that renders pages with the anonymous key is one caller, and so are visitors
behind one NAT, or behind a proxy without `NELCOTA_TRUST_PROXY`: send user
tokens, configure the proxy, or raise the limit.

When the client disconnects or the request times out, the server cancels the
statement still running in Postgres instead of letting it run until
`statement_timeout`.

## Writes

JSON numbers in insert, patch and RPC bodies retain all supplied decimal digits
when PostgreSQL converts them to `numeric`. Clients must serialize the original
value accurately; the server cannot recover digits already rounded by a client.

An insert accepts at most **1000 rows** and **128 distinct column sets** per
request. Split larger batches into requests. A request body (writes and RPC
arguments) can have at most `NELCOTA_MAX_BODY_BYTES` bytes, **2 MiB** by
default; a larger one gets `413 payload_too_large`. The body is buffered and
parsed whole, so raise the limit only as far as the server's memory allows. Each accepted request keeps its
transactional behavior and missing columns still receive their defaults.

| Verb | Body | Filters | Without `return=representation` | With `return=representation` |
|---|---|---|---|---|
| `POST` | object or array | not accepted | 201 empty | 201 + array |
| `PATCH` | object | **required** | 204 | 200 + array |
| `DELETE` | - | **required** | 204 | 200 + array |

- `select=` also picks the columns of the representation.
- On `POST`, missing columns get their `DEFAULT`, even in a batch whose
  objects have different keys.
- An empty body on `POST`/`PATCH` is refused (400 `invalid_body`); to insert
  a row of defaults, send `{}`. An `/rpc` call without a body has no arguments.
- `PATCH`/`DELETE` without a filter are refused (400), to avoid changing or
  deleting the whole table by mistake. To do that on purpose, use an explicit
  filter (`?id=not.is.null`).
- `order`, `limit` and `offset` are refused on `PATCH`/`DELETE` (400
  `invalid_query`): they change every row the filters match, so narrow the
  filters instead.
- With `Prefer: count=exact`, `PATCH`/`DELETE` answer `Content-Range: */<n>`
  with the number of rows changed (and `Preference-Applied: count=exact`),
  with or without `return=representation`.
- `return=representation` runs `RETURNING`, which requires `SELECT`
  permission (GRANT + policy) on the written rows.

### Upsert: create or update in one call

```
POST /rest/v1/products
Prefer: resolution=merge-duplicates
[{ "id": 1, "price": 3.00 }, { "id": 99, "name": "Eraser", "price": 1.00 }]
```

- `Prefer: resolution=merge-duplicates` updates a row whose key already exists,
  with the columns the object sent (the others keep their values; the key
  itself is never changed). `resolution=ignore-duplicates` keeps the existing
  row; with `return=representation`, only the rows actually written come back.
- The key is the primary key, or `?on_conflict=col1,col2`, which must match a
  unique constraint (otherwise 400). `on_conflict` without `resolution` is a
  400. The response confirms with `Preference-Applied`.
- A batch that repeats a key gets a 400 from Postgres (a row cannot be updated
  twice in one statement).
- A `GENERATED ALWAYS AS IDENTITY` column cannot receive values, so it cannot
  be the upsert key: use `BY DEFAULT`, or another unique column with
  `on_conflict`.
- RLS still decides: on a conflict, the existing row must pass the `UPDATE`
  policy. A user cannot take over someone else's row through an upsert (403).

## Functions: `POST /rest/v1/rpc/{function}`

Body: an object with the **named** arguments (`{"a": 1, "b": 2}`); arguments
with a `DEFAULT` are optional. With overloads, the signature whose names match
the keys wins.

| Function returns | Response |
|---|---|
| `SETOF`/`TABLE` | JSON array |
| scalar or composite | JSON value |
| `void` | 204 |

`RAISE EXCEPTION` becomes 400 with the message, also with a custom SQLSTATE of
class `P0` (`USING ERRCODE = 'P0002'`) and for a failed `ASSERT`; its `DETAIL`
and `HINT` come back as `details` and `hint` (see [Errors](#errors)). The
function runs with the JWT's role (unless it is `SECURITY DEFINER`):
`auth.uid()` works inside it.

> **Warning:** By default, Postgres grants `EXECUTE` on new functions to
> `PUBLIC` (including `anon`). For sensitive functions:
> `REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC; GRANT EXECUTE ON FUNCTION f() TO authenticated;`

A function must never build SQL from its arguments: injected SQL can switch
to `service_role` even inside an `anon` request. See
[JWT and roles](jwt-and-roles.md#functions-must-not-build-sql-from-their-arguments).

## OpenAPI: `GET /rest/v1/`

An OpenAPI 3.0 document generated from the catalog and **filtered by the
request's role**: `anon` only sees what `anon` may use. A table appears when
the role holds a table or column GRANT on it. Its row schema, used by the
responses and filters, lists only the columns (and their comments) the role may
read; the `POST` and `PATCH` bodies list only the columns it may insert or
update, respectively.

Schema models: `nelcota types -o database.ts` (TypeScript, default), or
`nelcota types --lang rust -o database.rs` for the
[Rust SDK](../sdk/rust/README.md). The Rust models distinguish omitted write
fields from explicit nulls and keep Postgres numeric precision.

Views run with their owner's underlying privileges by default and can bypass
the caller's row policies even when the source table enables RLS. For views
that should apply the caller's policies, use `security_invoker = true` and grant
the caller the required access to the underlying tables. The panel warns about
exposed owner views; changing that option or revoking their GRANT clears the
warning. Materialized views and foreign tables have no local row policies and
also need explicit access controls.

## Catalog reload

The API keeps the introspection in memory. An event trigger (migration V3)
notifies the server after DDL. Reloads are coalesced/serialized and failed
refreshes retry with bounded backoff; there is no fixed completion guarantee. Without a
superuser (some managed Postgres services), reload by hand:

```sql
NOTIFY nelcota, 'reload schema';
```

## Errors

Every error from the server (REST, auth, storage, unknown routes, wrong
methods, body limits and timeouts) is JSON with the same shape:

```json
{"code": "db_error", "message": "duplicate key value violates unique constraint \"products_pkey\" (23505)",
 "sqlstate": "23505", "details": "Key (id)=(1) already exists.", "constraint": "products_pkey"}
```

- `code` and `message` are always present. `code` is stable and meant for
  programs; `message` is English text for people.
- Errors that come from Postgres add `sqlstate` (the 5-character SQLSTATE)
  and, when Postgres provides them, `details`, `hint` and `constraint`
  (`DETAIL`, `HINT` and the violated constraint's name). Absent fields are
  omitted, never `null`. For `db_error`, `message` stays `"<text> (<sqlstate>)"`.
- Every response carries `x-request-id` (see [Request IDs](#request-ids)):
  quote it when reporting an error.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_query` | invalid column/operator/order in the URL; `order`/`limit`/`offset` on `PATCH`/`DELETE` |
| 400 | `invalid_body` | the body is not valid JSON, or is empty on `POST`/`PATCH` |
| 400 | `db_error` | value invalid for the type, check, not null, generated column, `RAISE EXCEPTION` (any SQLSTATE of class `P0`) |
| 401 | `invalid_token` | invalid or expired JWT (`WWW-Authenticate: Bearer error="invalid_token"`) |
| 401 | `db_error` | `anon` without permission: sign in (`WWW-Authenticate: Bearer`) |
| 403 | `db_error` | role without permission, or a policy violated on write |
| 404 | `not_found` | table/function outside the exposed schema, or an unknown route |
| 405 | `method_not_allowed` | the route exists but not with this method (`Allow` lists the methods) |
| 409 | `db_error` | unique key, foreign key or exclusion constraint violated |
| 413 | `payload_too_large` | request body over `NELCOTA_MAX_BODY_BYTES` (default 2 MiB) |
| 413 | `response_too_large` | the JSON response would exceed the 8 MiB budget |
| 415 | `unsupported_media_type` | an auth or storage JSON endpoint without `Content-Type: application/json` |
| 422 | `invalid_body` | an auth or storage JSON body with a missing field or a field of the wrong type |
| 429 | `rate_limited` | too many attempts or API requests, or too many concurrent requests from one caller (`Retry-After`) |
| 500 | `internal` | unexpected error; details only in the server log |
| 503 | `unavailable` | database unreachable or pool exhausted (no `Retry-After`, no `sqlstate`), or a transient failure reported by Postgres: serialization failure (`40001`), deadlock (`40P01`), lock not available (`55P03`), too many connections (`53300`), server shutting down or starting (`57P01`, `57P02`, `57P03`); these come with `Retry-After: 1` and `sqlstate`. Retry the request |
| 504 | `db_error` | `statement_timeout` (`NELCOTA_STATEMENT_TIMEOUT_SECS`, default 10 s; `sqlstate` `57014`) |
| 504 | `timeout` | the whole request took longer than `NELCOTA_REQUEST_TIMEOUT_SECS` (default 15 s, must exceed the statement timeout) |

Auth and storage add their own codes; see [schema-auth.md](schema-auth.md) and
[storage.md](storage.md).

## Request IDs

Each response carries an `x-request-id` header: the one the request came with
(for example from a proxy in front), or a new UUID. The server logs one line
per response at `INFO` with the method, the route template (for example
`/rest/v1/{table}`; never the concrete path or query string), status, latency
and that id (an incoming id that is not 1–128 characters of `[A-Za-z0-9-_.:]`
is logged as `[redacted]`), so an error a user reports can be found in the log.
Browsers can read the header (it is in `Access-Control-Expose-Headers`).

## Out of the MVP

Filtering parent rows by their embeds (PostgREST's `!inner`),
self-referencing embeds, `GET` on `/rpc`, `Accept: application/vnd.pgrst.object+json`.

## Related guides

See [auth](schema-auth.md), [JWT/roles](jwt-and-roles.md), [storage](storage.md) and [troubleshooting](troubleshooting.md).
