# Troubleshooting

The usual surprises, what causes them and how to fix them. Errors are
`{"code", "message"}` JSON; the SDKs expose them as `error.code` /
`Error::code()`. Newer servers also send `sqlstate`, `details`, `hint` and
`constraint` for database errors.

## A query returns `[]`, but the rows exist

Row-level security filtered them. RLS never fails a read: rows the policies
do not allow simply are not there for this caller. Check:

- **Who is asking.** Without a session the request runs as `anon`; with one,
  as `authenticated` with `auth.uid()` = the user's id. A row owned by
  another user is invisible, as intended.
- **The policy.** `USING (owner = auth.uid())` only matches rows whose
  `owner` was set. Rows inserted from the SQL editor or a migration have the
  `owner` you gave them (or `NULL`, since `auth.uid()` is empty there).
- **Policies for the role.** A policy `TO authenticated` does not apply to
  `anon`. With RLS enabled and no policy for a role, that role sees nothing.

The same goes for `update` and `delete`: changing zero rows is a success, not
an error. To be sure a row changed, ask for it back
(`.update({...}).eq('id', id).select('id')`) and check the result.

A write that violates a policy's `WITH CHECK` *is* an error: 401/403
`db_error` with `new row violates row-level security policy` (`42501`).

## 401 or 403 with a valid token

The role has no **GRANT** on the table, so Postgres refuses before RLS is
even consulted: `db_error`, `permission denied for table notes (42501)`.
Visitors (`anon`) get 401 (signing in may help); signed-in users get 403.

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;
GRANT SELECT ON public.notes TO anon;   -- only if visitors may read it
```

For an upsert with column-level grants, `UPDATE` must include every payload
column, including the conflict column. For `upsert({ id, name })`,
`GRANT INSERT (id, name), UPDATE (name)` is insufficient: grant
`UPDATE (id, name)` instead. The generated `ON CONFLICT ... DO UPDATE SET`
assigns both columns. `upsert(rows, { ignoreDuplicates: true })` uses
`DO NOTHING`, keeps existing rows and avoids that UPDATE requirement.
The caller still needs the applicable SELECT grants and RLS policies.

Functions called through `rpc` need `GRANT EXECUTE`. Storage needs policies on
`storage.objects` ([storage.md](storage.md)).

A 401 `invalid_token` is different: the token is malformed, expired or
signed by another key (a token from another project, or from before
`nelcota dev` was reset). Sign in again; the SDKs refresh tokens on their
own while the refresh token is valid.

## `email_not_confirmed` on sign-in

The server has `NELCOTA_EMAIL_CONFIRMATION_URL` set, so a new account must
open the link sent by email before it can sign in with a password. Sign-up
answers with the user and no session while it waits. Send the link again
with `resendConfirmation(email)` (`resend_confirmation` in Rust). Locally,
`nelcota dev` leaves confirmation off; use `nelcota dev --mail` to test it locally.

## `redirect_not_allowed` when starting an OAuth sign-in

`redirectTo` must match one of the comma-separated
`NELCOTA_OAUTH_REDIRECT_URLS`: same scheme, host and port, and a path equal
to or under the listed one. `http://localhost:5173/auth/callback` and
`http://127.0.0.1:5173/auth/callback` are different origins. Restart the
server after changing the variable.

## Types do not match the database

`nelcota types` writes a snapshot of the schema. After a migration, run it
again (`nelcota types -o src/database.ts`, or `--lang rust`), otherwise new
columns are unknown to the compiler and removed ones still compile, failing
only at run time with `invalid_query` or `db_error`. Running it in CI and
failing on a diff catches stale files.

Function arguments and returns preserve enum unions and relation row types.
Standalone composite types appear in `Database[schema]["CompositeTypes"]`;
RPC-only enums appear in `Enums` even when no table column uses them.

The server itself reloads its catalog on every DDL. On a managed Postgres
without the event trigger, reload it by hand: `NOTIFY nelcota, 'reload schema';`.

## `service_role` refused in the browser

`@nelcota/client` throws `NelcotaUsageError: A service_role token bypasses
RLS and must never reach a browser` when it sees such a token in a page. That
token skips every policy, so anyone who opens the developer tools would own
the database. Use it only on a server (for example from
`nelcota token service-role --days 30`); in the browser, sign users in and
let RLS decide.

## Only 1000 rows come back

Each read returns at most `NELCOTA_MAX_ROWS` rows (1000 by default), even
without a `limit` and even if the `limit` is larger. Page through the rest:

- TypeScript: `range(from, to)` or `limit` + `offset`; the result's `range`
  and `count` (with `count: 'exact'`) tell whether more rows exist, and
  `pages(size)` walks every row.
- Rust: `range(start, end)` or `limit` + `offset`, with `count_exact()`.
- HTTP: `Content-Range: 0-999/*` (or `/total` with `Prefer: count=exact`).

Order by a unique column when paging. Raising the cap makes every large read
cost more memory; responses also have an 8 MiB budget
(`413 response_too_large`).

## 429 `rate_limited`

Password sign-in, signup, email links and provider sign-in use per-endpoint
IP budgets based on `NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` (30 by default).
Password login also has a per-account budget of ten times that value across
all addresses. Over it, only networks where the account has an open session
from the last 30 days (same IPv4 /24 or IPv6 /64) still get through, after a
short delay and up to a second budget of the same size; others receive 429
until it refills. Refresh and PKCE redemption
share a separate per-IP budget of ten times that value (300 by default).

The REST and storage APIs allow `NELCOTA_API_RATE_LIMIT_PER_MINUTE` requests
(600 by default, 0 turns it off): per account with a user token, per IP without
one. `service_role` tokens and public or signed file downloads are exempt.
Server-side rendering with the anonymous key shares the server's IP budget;
raise the value or send user tokens.

IPv6 addresses count by their /64; signup also counts per /48, and the /64s
of one /48 can be tracked for at most 781 keys at a time, past which its new
/64s get 429 on auth endpoints. Quotas are per process, not distributed
across server instances. Clients behind a NAT can share an IP budget. The
response carries `Retry-After`, rounded up to whole seconds; SDKs expose it as
`error.retryAfter` (seconds) / `Error::retry_after()`.

Enable `NELCOTA_TRUST_PROXY=true` only behind a trusted forwarding proxy and
restrict direct API access. Each trusted proxy appends to `X-Forwarded-For`, so
`NELCOTA_TRUSTED_PROXY_HOPS` says how many there are: 1 (the default) for Caddy
alone, 2 for a CDN in front of Caddy. With a CDN, Caddy must also trust the
CDN's address ranges (`trusted_proxies` in its global `servers` options);
otherwise Caddy replaces the header, too few entries remain and every user is
counted as Caddy's own address. Never count more hops than trusted proxies
actually add: entries further left are written by the client.

A 503 `unavailable` means the database could not be reached or is
overloaded; it may also carry `Retry-After`. The SDKs retry reads on 429 and
503 by themselves; writes are never retried automatically.

## Operational logs and safe support bundles

Use `NELCOTA_LOG_FORMAT=json` for structured server output and `RUST_LOG=info,tower_http=info` for normal operation. The existing text format remains available. Keep UTC timestamps and record the server version, project and incident time window before investigating.

Read only the affected service first. These commands select the project in the existing host layout; replace the example project name before running them. They do not change configuration or restart services.

```sh
nelcota -C /opt/nelcota -p base logs app
nelcota -C /opt/nelcota -p base logs postgres
```

The server records method, route template, status and `latency_ms` to the response head. This is not the time to finish streaming a download. The `path` field contains a route such as `/rest/v1/{table}`, not a table name, object key or query string; unmatched routes use `[unmatched]` and extension methods use `OTHER`.

Correlate the response `x-request-id` with the request span. Ordinary non-secret proxy IDs remain usable; log values are limited to 128 ASCII letters, digits, dots, underscores, colons and hyphens. Other IDs appear as `[redacted]` in logs; the response header is unchanged. Never put credentials or personal data in a request ID.

Database failures use stable `event` categories and SQLSTATE `code`; pool failures include `error_kind` and a `sqlstate` when available. Opaque database/provider text is not required to classify these database events. Authorized client error responses retain their existing fields; never paste those bodies into public reports without review.

For `database.pool_acquire_failed`, distinguish `wait_timeout` (pool pressure), `create_timeout` or `recycle_timeout` (connection lifecycle), `backend` (inspect SQLSTATE), and `closed` (shutdown). For `database.transient_failure`, inspect contention, connection limits and recovery state before a controlled retry. A log is diagnostic evidence, not authorization to retry a mutation or clear a restore fence.

`database.cancel_failed` and `database.cancel_timed_out` mean that the statement of a dropped request (a disconnected client or a request timeout) could not be cancelled. It may keep running in Postgres until `statement_timeout` while the pool opens a replacement connection; repeated events point to an unreachable or overloaded database.

Logs, panel incident state and external alerts have different purposes. Host jobs already have operation/job IDs and explicit approval. Keep that durable state as the source of truth; a browser tab or a successful log write does not establish that a backup, restore or update completed.

Restrict log access to operators. Server output goes to its existing stdout/stderr sink; systemd and Docker control storage and rotation. Inspect `journalctl --disk-usage` and the container logging driver before choosing a retention policy. Configure and test size, age and disk reserves in the deployment owner; this guide does not assert automatic rotation or change the host daemon. Do not give the panel a privileged raw-log endpoint.

Collect only a short incident window into a private file with `umask 077`. Include version, UTC interval, sanitized request/job IDs, event categories, status and counts. Review every line before sharing: remove credentials, cookies, signed URLs, email/IP/account identifiers, SQL values and file contents. A grep filter or hashing identifiers alone does not guarantee anonymization. Do not include environment dumps, configuration files, raw database dumps or complete browser storage.

Enable detailed logging only briefly on an owned staging reproduction. Existing auth/storage/provider diagnostics and external sinks still require a privacy review; structured JSON alone does not make all messages safe. This bounded logging review does not establish a complete audit ledger, a compliance guarantee or measured zero overhead.


Mail delivery failures retain a stable event, message kind and `error_type`; storage failures retain a stable event, error type and typed `io_kind` where available. Missing-byte diagnostics retain the opaque object version, not its bucket name. These events omit opaque provider messages and storage keys/paths. Type names are implementation context, not a public parsing contract; investigate provider-specific causes through a private reproduction.
