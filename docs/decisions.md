# Decision log

Historical decisions made while building Nelcota, with the why. Newest at the
end. Earlier milestones are snapshots: current server source requires Rust 1.99,
the Rust SDK supports 1.88, and a bare CLI without server configuration prints
help. Use current operating guides and release notes over superseded choices.
Decision numbers and historical rationale remain intact.

## Milestone 1

**D1. Apache-2.0 license.** Chosen by the maintainer (2026-10-06).

**D2. Name and binary.** The project is called Nelcota; the single binary is
`nelcota` (crate `nelcota-server`). In Milestone 4 it gains subcommands
(`nelcota init`, `nelcota up`...); without arguments it starts the server.

**D3. The `admin` and `cli` crates only arrive in Milestones 4/5.** Avoids
empty crates.

**D4. Integration tests in `crates/server/tests/`.** The workspace is virtual
(there is no package at the root), and Cargo integration tests must belong to a
package. `server` exposes the `Router` in a lib so the tests use the same code
as production.

**D5. A single URL.** `NELCOTA_DATABASE_URL` points to a role that owns the
schema (the `postgres` superuser in Docker) and is used only for migrations and
to set the `authenticator` password. The API uses the same host/database,
swapping user/password for `authenticator` / `NELCOTA_AUTHENTICATOR_PASSWORD`.

**D6. The `authenticator` password stays out of migrations.** Migrations hold
no secrets. At startup the server computes the SCRAM-SHA-256 verifier on the
client side and runs `ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'`: the plain
password never travels over the wire nor shows up in Postgres' statement log.

**D7. `set_config('role', $1, true)` instead of `SET LOCAL ROLE x`.** Both are
equivalent (`SET LOCAL ROLE` is sugar for `set_config('role', ..., true)`), but
`set_config` takes a parameter, sets role and claims in a single round trip and
avoids any SQL built as a string. The role value comes from a closed `enum`.

**D8. Pool with `RecyclingMethod::Fast`.** Role and claims are
transaction-scoped and die on COMMIT/ROLLBACK (including a drop without commit,
which sends ROLLBACK). No `DISCARD ALL` is needed on each checkout. Covered by
the pool-leak and rollback tests in `crates/server/tests/rls.rs`.

**D9. Internal migrations in `nelcota.schema_migrations`.** A schema of its
own, without GRANTs to the API roles, so it does not show up in `public`
(which the automatic API exposes). An advisory lock serializes bootstrap
across instances.

**D10. The example table stays out of migrations.** `examples/todos.sql` is
applied by the tests and optionally in dev. Nelcota's migrations create no
business tables in anyone's database.

**D11. Extensions in the `extensions` schema.** `pgcrypto` and
`pg_stat_statements` stay out of `public`. `pg_stat_statements` requires
`shared_preload_libraries=pg_stat_statements` (already in the dev compose and
in the tests).

**D12. Provisional HS256 JWT** (superseded by D20). Milestone 1 uses HS256
with a shared secret (≥ 32 characters) behind the `JwtVerifier` trait.
Milestone 2 adds EdDSA + JWKS as the default, and HS256 stays as a simple mode.

**D13. Claim rules.** `role` is required and must be `anon`, `authenticated`
or `service_role`. `authenticated` requires a uuid `sub` (so `auth.uid()` never
fails the cast). `aud` is not verified yet (it joins the contract in Milestone
2). 30 s leeway on `exp`.

**D14. No token = `anon`; invalid token = 401.** An `Authorization` header
that is present but invalid (expired, wrong signature, scheme other than
`Bearer`, unknown role) never silently becomes `anon`.

**D15. 401 vs 403 on missing permission.** `insufficient_privilege` (42501)
becomes 401 for `anon` (needs to sign in) and 403 for the other roles, as in
PostgREST.

**D16. `rsa` ignored in `cargo audit`/`cargo deny` (RUSTSEC-2023-0071).** It
comes through `jsonwebtoken`'s `rust_crypto` backend. The Marvin Attack affects
operations with the RSA **private** key; Nelcota never signs with RSA. The
`aws_lc_rs` backend would avoid the dependency, but requires a C/CMake
toolchain in the build, which hurts the "simple static binary". Revisit if
RS256 is ever used for signing.

**D17. Libraries outside the prompt's table.**
- `uuid`: validates the `sub` claim and is Postgres' native type for ids.
- `postgres-protocol`: already a transitive dependency of `tokio-postgres`;
  used to compute the SCRAM verifier (D6).
- `http-body-util` (dev only): reads response bodies in tests.

**D18. Postgres without TLS on the internal network.** The database is only
reachable over Docker's internal network (or localhost in dev). TLS to the
database waits for a remote-database scenario.

**D19. Edition 2024, MSRV 1.88.** The current `testcontainers-modules` already
requires 1.88.

## Milestone 2

**D20. EdDSA (Ed25519) as the default; HS256 as legacy.** The private key comes
from `NELCOTA_JWT_PRIVATE_KEY` (PKCS#8 PEM or the one-line base64, which fits
in a `.env`). With an EdDSA key **and** an HS256 secret configured, the server
signs with EdDSA and accepts both when verifying (zero-downtime migration). The
`kid` is the RFC 7638 thumbprint.

**D21. Internal `nelcota_auth` role for the `auth` schema.** Auth handlers run
with `SET LOCAL ROLE nelcota_auth` (a fixed string). No JWT can assume it (the
`Role` enum does not contain it), and the API roles have no GRANT on `auth.*`.
Discarded alternative: `SECURITY DEFINER` functions, which would spread logic
into PL/pgSQL with no real gain.

**D22. 32-byte opaque refresh token, stored only as SHA-256.** SHA-256 (not
argon2) because the token already has 256 bits of entropy; lookup is through a
unique index, with no comparison in the application.

**D23. Reuse detection revokes the session (family), not the user.** Other
sessions stay valid. No grace window for now (documented).

**D24. Logout revokes the session; the access JWT is valid until `exp`.**
Access tokens are stateless and short (15 min by default). Checking revocation
on every request would cost an extra database round trip.

**D25. Argon2id with RustCrypto's default parameters (m=19 MiB, t=2, p=1).**
Runs in `spawn_blocking`, with at most `min(cores, 4)` concurrent hashes (peak
< 80 MiB). Logging in with an unknown email verifies against a dummy hash, so
the response time does not reveal whether the account exists.

**D26. In-memory rate limit, fixed 1-minute window** (the window became a GCRA in D69), per IP (signup/token)
and per email (login). One binary per install makes Redis unnecessary. The IP
comes from `X-Forwarded-For` (rightmost entry) only with
`NELCOTA_TRUST_PROXY=true`.

**D27. Signing up with a duplicate email answers 409.** Without email
confirmation in the MVP, hiding the account's existence at signup would bring
no real protection (login still does not reveal it).

**D28. New libraries.** `argon2` (it was in the table); `sha2`, `base64` and
`getrandom` were already transitive dependencies (`jsonwebtoken`/RustCrypto)
and are used directly at the same versions, without growing the tree. The ISC
license is allowed in `cargo deny` (it comes from `simple_asn1`, used to read
PEM).

## Milestone 3

**D29. Dynamic SQL with our own builder, no `sea-query`.** Every URL value
becomes a **text** parameter, and Postgres converts it to the column type
(`$1::text::<catalog type>`); inserts and updates use
`json_populate_recordset`/`json_populate_record`, and RPC uses `json_to_record`.
That way Postgres validates types as it would a literal, and the application
does not need to map types. `sea-query` binds each value to a Rust type (and
`sea-query-postgres` would require that mapping), besides not expressing these
patterns well. The builder is ~400 lines with three auditable rules:
identifiers only from the catalog and always quoted; cast types only from the
catalog; values always parameters. Unit and integration tests cover injection
on both sides.

**D30. OpenAPI built with `serde_json`, no `utoipa`.** `utoipa` generates the
specification at compile time from Rust types; ours comes from the catalog at
run time. The document is filtered by the request role's privileges (like
PostgREST's `follow-privileges` mode).

**D31. Catalog reload through an event trigger + `LISTEN nelcota`.** The
trigger runs on `ddl_command_end` and `sql_drop` (including GRANT/REVOKE). The
listener batches bursts (100 ms), reconnects with backoff and reloads on every
reconnect. Without a superuser, the migration proceeds without the trigger and
reloading is manual (`NOTIFY`).

**D32. PATCH/DELETE require a filter.** Unlike PostgREST (which allows it and
lets RLS limit it), we refuse with 400. The cost is an explicit filter when
the intent really is to hit everything.

**D33. Batches with different keys respect DEFAULT.** Rows are grouped by
column set and each group becomes an INSERT (CTEs in one statement). In
PostgREST, without `Prefer: missing=default`, missing columns become NULL; we
find DEFAULT the least surprising behaviour.

**D34. `statement_timeout` on the `authenticator` role.** `ALTER ROLE anon SET
...` has no effect with `SET ROLE` (Postgres only applies a role's settings at
login). Bootstrap applies `NELCOTA_STATEMENT_TIMEOUT_SECS` (default 10 s) to
`authenticator`, and the error becomes 504.

**D35. Postgres' default kept for `EXECUTE` on functions (PUBLIC).** Changing
the default privileges would hide plain Postgres behaviour; the documentation
and the panel warn about it.

**D36. New libraries.** `form_urlencoded`, `futures-util` and `bytes` were
already transitive dependencies (axum/tokio-postgres); tower-http's
`compression-gzip` adds `flate2`.

## Milestone 4

**D37. One binary, two roles.** `nelcota` without arguments (or `serve`)
starts the server; the subcommands operate the install. On a host,
`migrate`/`types`/`token` are forwarded to the `app` container (`docker compose
exec`), which is what can reach Postgres on an `internal: true` network; with
`NELCOTA_DATABASE_URL` in the environment, they run directly.

**D38. Postgres profiles become `-c key=value` in the compose file.** The
`deploy/postgres/profiles/*.conf` files are the source; `init` turns them into
arguments of the `postgres` command. Using `config_file` would replace the
image's whole `postgresql.conf` (and change the default `pg_hba.conf`
directory).

**D39. Backups with `pg_dump -Fc`; S3 uploads with the `amazon/aws-cli`
image.** Nothing to install on the host and no home-grown S3 signing (SigV4).
Restore in a single transaction (`--single-transaction --exit-on-error`). PITR
with WAL-G is pending (daily dumps: an RPO of up to 24 h).

**D40. Upgrade with rollback = previous image + restore of the pre-upgrade
backup.** The new version may have applied internal migrations the previous
one does not know (refinery refuses to start with an "unknown" migration).
That is why the rollback also restores the database and the matching disk-file
snapshot. The proxy stays in maintenance from before the old app stops until
the upgraded or restored app is healthy, so successful public writes cannot
be lost between capture and rollback. Failure-path tests cover this sequencing.

**D41. `scratch` image with a musl binary; built-in healthcheck.** No shell or
curl in the image: `nelcota healthcheck` performs `GET /health` over plain TCP.

**D42. User migrations in refinery's format (`V<n>__<name>.sql`)**, in
`nelcota.user_migrations`, separate from the internal ones
(`nelcota.schema_migrations`). CRLF is normalized before the checksum (a
Windows checkout does not diverge).

**D43. `install.sh` installs Docker with the official script if it is
missing** (as root and without `NELCOTA_SKIP_DOCKER=1`): that is what makes
the "3 commands" possible on a fresh VPS. The binary's SHA-256 checksum is
always verified.

**D44. `init` does not enable the firewall without `--firewall`.** Enabling
`ufw` remotely with the wrong SSH port locks the owner out of the machine. By
default it only recommends it.

## Milestone 5

**D45. Panel with server-side HTML + ~2 KB of our own JS, no HTMX**
(superseded by D50). Pages are ordinary forms; the only interactive part (the
SQL editor) fits in a few lines of `fetch`. CSP `script-src 'self'` without
`unsafe-inline`. Assets embedded with `rust-embed`.

**D46. Panel login separate from end users.** Email + argon2id hash in the
`.env` (generated by `init`; the password is shown once). In-memory sessions
(restarting the server signs the admin out), `HttpOnly; SameSite=Strict`
cookie (`Secure` behind the proxy), login rate limit and an
`Origin`/`Sec-Fetch-Site` check on every POST (CSRF).

**D47. The panel uses the admin connection.** The admin owns the database, as
in `psql`. Table writes reuse the API's SQL builder (catalog identifiers,
parameterized values). The SQL editor opens a **new** connection per run:
`BEGIN` without `COMMIT` or `SET ROLE` do not contaminate the pool. The SQL
text does not go to the log.

**D48. Panel values keep Postgres' text** (`RawValue`), without going through
`f64`: `numeric(30,10)` shows and is edited with every digit.

## Panel design

**D49 (superseded by D50).** A panel with a database-console look (dark by
default, emerald accent), inspired by Supabase but with its own name, brand
and icons. Inter + JetBrains Mono typography, embedded in the binary (~88 KB,
OFL, see `crates/admin/assets/FONTS.md`): no Google Fonts, to keep the CSP at
`'self'` and work offline. Light mode via `prefers-color-scheme`. Hand-drawn
SVG icons (no icon package). On the overview, the row count is exact for
tables under 10 thousand estimated rows and uses the planner's estimate (`≈`)
for large ones.

## Panel in Svelte

**D50. Panel in Svelte 5 + shadcn-svelte + Tailwind v4 + CodeMirror 6**,
built with Vite (the maintainer's choice, 2026-10-06). The goal is the
interactivity server-side HTML did not deliver well: inline editing in the
grid, side sheets, multiple selection, column sorting, a SQL editor with
syntax highlighting and autocomplete for the database's tables and columns. An
SPA with Vite, **no SvelteKit**: it injects inline script into the page, which
would break the CSP `script-src 'self'`. Our own routing (~60 lines, history
API).

**D51. The build (`crates/admin/ui/dist`) is versioned in git** and embedded
with `rust-embed`. That way `cargo build`, `cargo install` and the Dockerfile
still need no Node: only whoever works on the panel needs Node. CI's
`admin-ui` job runs `npm ci`, `npm audit`, `svelte-check`, `vite build` and
fails if the versioned `dist` is out of date.

**D52. CSP: `style-src` now accepts `'unsafe-inline'`; `script-src` stays at
`'self'` only.** Svelte transitions, CodeMirror and menu positioning
(floating-ui) inject styles at run time. Inline style runs no code; inline
scripts remain forbidden (there is a test).

**D53. The panel becomes a JSON API at `/admin/api/*`.** Same session, same
origin check (CSRF) and the same SQL builder as the REST API. Values travel as
Postgres' exact text (`RawValue`). Batch deletes in a single transaction. The
SPA is served at any `/admin/*` (fallback to `index.html`). Hashed assets get
immutable caching; `index.html`, `no-cache`.

**D54. CodeMirror loaded on demand.** The login screen loads about 135 KB
gzip; the SQL editor (~145 KB gzip) is only downloaded when its page opens.
The Inter and JetBrains Mono fonts come from `@fontsource-variable` (OFL),
served by the binary itself.

**D55. A panel without ornaments.** Removed the generic template patterns:
stat cards with icons, gradients, a glowing login, a logo in a colored square,
pills and dots on every status, avatars with initials, skeletons, colored
toasts, an icon before every title, subtitles explaining the obvious and the
"Postgres 17" pill (which was hardcoded, not read from the database).
Criterion: color only for problems (no RLS, RLS without policies, error,
destructive action); short texts. Inter/JetBrains Mono swapped for IBM Plex
Sans/Mono, less ubiquitous and with the feel of a technical tool. Security
warnings stay, as plain text. (D102 later replaced the typeface with Manrope.)

## Several projects per host

**D56. One host, N isolated projects.** A shared Caddy (the only one to
publish 80/443) and, per project, an app and a Postgres on an exclusive
internal network. A single project is a host with one project: there are not
two models to maintain. The registry (`nelcota-host.json`) is the source of
truth; the Caddyfile and the public list (`shared/projects.json`) are
generated from it.

**D57. One Postgres per project.** Postgres roles apply to the whole server;
in a shared Postgres, projects would share `anon`, `authenticated`,
`service_role` and the `authenticator` password. The cost (~50 MB of RAM per
project) buys physical isolation, per-project backup/restore and leaving, and
independent upgrades.

**D58. Own domain or a subdomain of the base domain.** `init api.shop.com`
derives the name "shop"; `init --project blog` uses `blog.<base-domain>`.
Locally: `<project>.localhost` (browsers resolve `*.localhost` to the
machine).

**D59. Single sign-on through an SSO handoff, with a per-project login
option.** Cookies do not cross domains, so the origin panel issues an HS256
JWT (host's shared secret, `aud` = target project, 60 s, single-use `jti`)
that travels in the URL fragment and is traded for a session at the target.
In per-project mode there is no shared secret and the handoff does not exist.
Only `panel_login.rs` writes admin credentials into the `.env` files;
switching modes regenerates and restarts the apps.

**D60. The project list is mounted as a folder and reread on every request.**
The app receives `shared/` read-only (a folder bind, not a file bind, so the
CLI's atomic rename is visible). New projects show up in the switcher without
restarting anyone. Each project's state comes from `GET /health` over the
`nelcota_edge` network, which now includes the version.

**D61. Removal always with a final backup** in `archive/` before deleting
containers and volumes; the site leaves Caddy with `caddy reload` (without
taking the others down).

## Identity and account in the panel

**D62. The mascot is the panel's identity, the only exception to D55**
(superseded by D102). It
comes from the NelcotaScreenShare atlas (`src/assets/mascot/`), cropped with
the poses anchored at the feet and right arm so the figure does not jump when
the expression changes. It is not decoration because it reacts to the login
screen's state: it waves on open, follows the pointer with its eyes, closes
its eyes while the password is typed and looks sad after a refused login. The
eyes are a vector layer over the PNG's (only the pupil moves); with
`prefers-reduced-motion` the gaze jumps straight to the target.

**D63. Full-height sidebar** (superseded by D98 and D103). Project at the top (same height and border as
the topbar), pages in the middle, account at the bottom; the topbar covers
only the content area. Pinned, it takes 240px from `xl` up; collapsed, it
becomes an icon rail that expands over the content. "Projects" left the menu:
the project switcher already leads there.

**D64. The admin photo lives in the project's database, in the `nelcota`
schema** (migration V4, `nelcota.admin_avatar`). The admin login only exists
in environment variables, so there was nowhere to keep data about them; the
internal schema has no USAGE for any API role. The photo is per project (each
one has its own Postgres). The browser center-crops and scales it to 256px in
WebP; the server only accepts PNG, JPEG or WebP recognized by their leading
bytes, up to 256 KB. The URL carries the version (`?v=`), so the image can be
cached.

**D65. `nelcota-core` recompiles when `migrations/` changes.**
`embed_migrations!` reads the folder without telling the compiler; a
`build.rs` with `rerun-if-changed` avoids incremental builds with the old
list.

**D66. Password recovery by email, with the project's SMTP.** Nelcota runs no
mail server: `NELCOTA_SMTP_URL`, `NELCOTA_SMTP_FROM` and
`NELCOTA_PASSWORD_RECOVERY_URL` (all three or none; half-configured, the
server does not start). The link goes to the app's page with the token in the
fragment; tokens live in `auth.one_time_tokens` (migration V5) only as
SHA-256, are valid for 1 hour and once, with at most one email per minute per
account. Sending happens in the background so the response time does not
reveal whether the account exists. Using the link changes the password, ends
the sessions and marks the email as confirmed. Sent with `lettre` over rustls
+ ring, with Mozilla's roots embedded (`webpki-roots`): the `scratch` image has
no system certificates and the musl build stays free of OpenSSL. This brought
two permissive licenses into `deny.toml`: CDLA-Permissive-2.0 (the root list,
which is data) and 0BSD (`quoted_printable`).

**D67. Panel DDL becomes a migration, registered as already applied.** Every
DDL the panel applies goes through `apply.rs` and is recorded in
`nelcota.panel_changes` (migration V6), in the same transaction. "Generate
migration" bundles the pending ones into a file and inserts the matching row
into `nelcota.user_migrations` with refinery's checksum
(`Migration::unapplied(..).checksum()`): `migrate` does not reapply the file
and, with `abort_divergent`, refuses an edited copy. The generated text is
stored (`nelcota.panel_migrations`) so it downloads again byte for byte. The
version goes past the highest number in the database, in the folder and among
earlier exports; the folder comes from `NELCOTA_MIGRATIONS_DIR` or from the
`/migrations` mount in the container. The SQL editor is left out: it can run
anything, including DML, and separating schema changes would require parsing
the SQL.

**D68. English codebase, translated panel.** Code, identifiers, comments,
tests, server messages (REST, auth and admin API errors), CLI output, the
recovery email, the README and these docs are English. Only the panel
interface is translated: Portuguese (pt-BR) and English, through typed
per-area catalogs (`crates/admin/ui/src/lib/i18n/messages`) where the English
object is typed against the Portuguese one, so a missing key fails the type
check. The panel picks the browser language on the first visit and remembers
the choice made in the account menu. Admin API errors carry `code` and
`params` (`{"error", "code", "params"}`), so the panel shows them in the
chosen language and falls back to the server's English text (raw Postgres
errors, for instance). Migrations V1–V6 keep their Portuguese file names and
comments: refinery checksums name and content, and editing them would make
every existing install refuse to start.

**D69. Libraries instead of four hand-written pieces.** A review of what
the code reimplemented kept the deliberate ones (the SQL builder of D29, the
OpenAPI of D30, the PostgREST-style parser, TypeScript generation, CSV,
secret generation, image sniffing) and replaced four:
- **Rate limit:** `governor`'s keyed GCRA instead of a fixed window. The budget
  refills continuously, so a client can no longer spend almost twice the limit
  across the turn of a minute, and `Retry-After` is the real wait. Still in
  memory per process; only the `std` and `dashmap` features.
- **Session cookie:** the `cookie` crate parses the `Cookie` header and builds
  `Set-Cookie` in one place, instead of `split(';')` and `format!`. No signing
  or encryption features: the value is an opaque token.
- **Health probe:** `hyper-util`'s client instead of a hand-written HTTP/1.1
  request and response split; a chunked body no longer breaks it. hyper was
  already in the tree through axum.
- **Identifier quoting:** `postgres_protocol::escape::escape_identifier`, already
  a dependency. String literals in generated DDL keep the hand-written `''`
  doubling: `escape_literal` would emit ` E'...'` for backslashes and change the
  text of panel-generated migrations.

**D70. `or=`/`and=` as PostgREST logic trees.** The request's filters are
a tree (`Condition`): leaves are the existing filters and groups join their
items with OR/AND, optionally negated; the top level stays ANDed, so existing
URLs mean the same. Each group renders as a parenthesized expression, so
precedence never depends on its surroundings, and leaves keep the D29 rules
(catalog columns, quoted identifiers, values as parameters). Depth is capped at
8 and a tree at 100 filters, which bounds the recursive parser on hostile
input. As in PostgREST, `or`/`and` are reserved query keys.

**D71. Upsert through `Prefer: resolution` and `on_conflict`, as in
PostgREST.** Each INSERT group (D33) gets `ON CONFLICT (key)`: `DO UPDATE SET`
for the columns the object sent, except the key, or `DO NOTHING`; a merge with
nothing left to update falls back to `DO NOTHING`. The key is the primary key
or `on_conflict`, whose columns are checked against the catalog; whether they
form a unique key is left to Postgres, and its `42P10` and `21000` errors now
map to 400 instead of 500. RLS needs no special handling: Postgres applies the
INSERT policy to the new row and the UPDATE policy to the existing one.

**D72. Relation embedding through foreign keys, one level, as correlated
subqueries.** `select=` accepts `[alias:]table[!hint](columns)`. The relation
comes only from the catalog's foreign keys inside the exposed schema, in
either direction: this table's key gives an object (`to_json` of a subquery
that matches at most one row, since the key references a unique one), the
other table's key gives an array (`json_agg`). Each embed is a subquery in the
select list, so it runs in the same transaction with the request's role and
the related table's RLS filters it like a direct read; there is no separate
permission logic. Ambiguous links ask for a hint (column or constraint name);
nesting and self-references are refused for now. The panel's parser keeps
refusing embeds (`parse_request`), the API uses
`parse_request_with_relations`.

**D73. Nested embeds and per-embed filters, as in PostgREST.** An embed's
column list is a full `select`, so embeds nest, at most 4 levels (each level
is one more correlated subquery per parent row; the cap bounds what a single
URL can stack). Parameters prefixed with an embed's key (`items.qty=gt.1`,
`orders.items.order=...`) go to that embed: filters and `or`/`and` trees join
the foreign key in the subquery's `WHERE`, and `order`/`limit`/`offset` page
the embedded array (refused on a single-row embed). They narrow the embedded
rows only; the parent rows stay, with `null` or `[]`. `select` is parsed first,
so the parameter order in the URL does not matter. Filters now carry their
column type, so the same SQL builder serves any row alias. Nested subqueries
are aliased by their path (`_e0_1`) so a child never shadows its parent.
Self-references stay refused, and filtering parents by their embeds
(PostgREST's `!inner`) is not implemented.

**D74. PITR with pgBackRest, inside the project's Postgres container.**
pgBackRest instead of WAL-G: Alpine packages it (2.58), so the image stays
`postgres:17-alpine` plus one `apk add`. WAL-G only ships glibc binaries, and
moving to a Debian image would change the libc and with it text collation,
silently invalidating the indexes of existing projects. The image is built
locally from `postgres/Dockerfile` (no second image to publish). Settings
travel as `PGBACKREST_*` variables from `pgbackrest.env` (mode 600) through
`env_file` with `required: false`, so no config file has to be readable by the
container's postgres user and "PITR on" is just that file existing; archiving
itself is `ALTER SYSTEM` (archive_mode, archive_command, `archive_timeout =
60s`), which the profile's `-c` flags do not touch. Postgres gets a
per-project `egress` network: the `internal` one has no route out, and nothing
can connect in through either. Base backups ride on the existing daily
`backup --all` (full on Sundays, differential otherwise, two fulls kept). A
restore recreates the Postgres container, so its restart count tells a failed
recovery (a target past the archive makes Postgres exit) apart, and ends with
a full backup: the new timeline forks before any later backup on the old one,
which pgBackRest would otherwise refuse to restore from.

**D75. Hosts without Docker: one project, systemd units, apt packages.**
`init --runtime systemd` (Debian/Ubuntu, as root) gets Postgres 17 and
pgBackRest from PGDG and Caddy from its repository: the versions match the
Docker hosts and security updates come with `apt upgrade`. One project per
machine: N isolated projects would mean N clusters on N ports and N system
users, and that isolation is what Docker already gives. The runtime lives in
the registry (`"runtime"`, Docker when absent), and every operation goes
through `Project`, which turns "start the app", "run this as postgres",
"is Postgres healthy" into `docker compose` or `systemctl`/`runuser`/
`journalctl`; `ops` and `pitr` no longer know which. The app runs a copy of
the binary (`/usr/local/lib/nelcota/nelcota`) so `upgrade` can swap it and
keep the previous one for the rollback, in a unit with `DynamicUser`,
`ProtectSystem=strict`, no capabilities and only the loopback port. Commands
that need the app's configuration (`migrate`, `types`, `token`) run this
binary as a child process with the project's `.env`, rather than setting
variables in the CLI's own process. pgBackRest reads the same settings as on
Docker, written as `/etc/pgbackrest/pgbackrest.conf` (archive_command runs
under the Postgres unit, which does not get the `.env`).

**D76. The image is `ghcr.io/nelcota/nelcota-server`.** The name that
matches the repository, `ghcr.io/hanielcota/nelcota`, is a package from an
earlier project (now NelcotaScreenShare) whose production still pulls its
`latest` tag. Pushing there would overwrite that tag, and deleting it would
break that deploy, so this project publishes under another name. The release
image is the released musl binaries copied into `scratch`
(`deploy/release.Dockerfile`), linked to this repository by the
`org.opencontainers.image.source` label.

## Storage

**D77. Metadata in Postgres under RLS, bytes in an object store.** A
`storage` schema holds `storage.buckets` and `storage.objects` (bucket, name,
owner `DEFAULT auth.uid()`, size, type, etag). Who may read, write or delete
a file is decided by RLS policies on `storage.objects`, written in plain SQL
like any other policy; the server never decides it. The bytes live behind the
`object_store` crate (Apache Arrow) with two backends: the local disk (the
default, nothing to configure after `nelcota up`) and any S3-compatible
service (recommended for production: R2, B2, AWS...). `object_store` is used
with `aws-base` + `ring`, never `aws-lc-rs`, for the same reason as D16. No
bundled object server: Garage on a single node keeps the files on the same
disk as a plain directory would, for one more service to run, and MinIO's
community edition went into maintenance mode in 2025. The routes follow the
shape of Supabase Storage (`/storage/v1/object/{bucket}/{path}`), without
promising compatibility with its client; the route words (`public`, `sign`,
`list`) cannot be bucket names.

**D78. Uploads stream through the server; keys are versioned.** The client
sends the file to Nelcota, which streams it to the store: one endpoint, the
usual `Bearer`, no CORS on a second origin, and size, type and quota checked
in the same flow. Before taking the bytes, a rolled-back `INSERT` under the
caller's role checks the policy, so a caller without permission cannot fill
the disk. The bytes go to `{bucket}/{version}` (a UUIDv7), not to the
object's name; only after the upload completes does a short transaction
insert or update the row under RLS. Holding no connection while bytes flow
keeps slow clients from draining the pool; versioned keys make an overwrite
atomic (readers see the old file or the new one, never half) and keep a
failed upload from clobbering anything. Deleting or replacing a file removes
the old bytes right after the commit: a delete means the file is gone, which
also means a database restore does not bring deleted files back. A periodic
collector removes bytes no row points to (left by a crash mid-upload) once
they are a day old, so it never races an upload in flight. A plain upload
needs only an `INSERT` policy; overwriting and deleting also need `SELECT`,
as `UPDATE`/`DELETE` with a `WHERE` do in Postgres. Storage routes run
outside the request timeout and the gzip layer.

**D79. User files are served as inert content.** Every object response
carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
sandbox` (on the S3 backend the redirected download cannot, see `storage.md`); only raster images, audio, video and plain text are served
`inline`, everything else (HTML, SVG, PDF...) as an `attachment`. The type is
sniffed from the first bytes, not taken from the client. Paths reject `..`,
empty segments, control characters and over-long names, and are normalized
to Unicode NFC. Signed URLs are short-lived JWTs signed with the project's
keys and bound to one bucket and path. On the S3 backend a download is a
`302` to a presigned URL on the provider's domain; on disk the server
streams it with `Range` and `ETag`. `NELCOTA_STORAGE_PUBLIC_URL` can move
public files to their own origin (e.g. `files.shop.com`).

**D80. Storage cannot take the database down.** On a single VPS the files and
Postgres share a disk. Every upload has a size cap (per bucket, and a global
`NELCOTA_STORAGE_MAX_FILE_SIZE`, 50 MiB by default); an optional total quota
covers all buckets; and on the disk backend an upload is refused when free
space would fall under `NELCOTA_STORAGE_MIN_FREE_BYTES` (1 GiB by default).
In-flight uploads reserve their capacity, and publication checks the resulting
total under a database transaction lock across instances. Replacements credit
their old logical size while reserving disk space for the new version.
Per-user quotas are left to policies, which see the final row (with its
size) on insert. Image transformations and resumable (TUS) uploads stay out:
decoding untrusted images is a steady source of CVEs.

**D81. New projects store files on their disk; backups mirror them**
(the shared backup mirror is superseded by D82).
`nelcota init` writes `NELCOTA_STORAGE_BACKEND=disk`: on Docker the app
mounts `projects/<name>/storage` (owned by the image's user 65532), on
systemd the unit's `StateDirectory`. Storage works right after `nelcota up`,
and moving to S3 is two lines in `.env`. A file on the same disk as the
database is lost with it, so `backup --upload` also runs `aws s3 sync
--delete` of that directory to `<bucket>/<project>/storage/`: keys never
change once written (D78), so each run only sends new files, and
`restore --files` brings them back. Caddy stops compressing `/storage/*`,
which would break byte ranges. Projects created before storage keep it off
until they add the two lines and the volume (docs/storage.md).

## Panel and backup reliability

**D82. Disk backups capture immutable files beside each dump.** A shared
mirror loses old versions when later uploads replace or delete them, so it
cannot restore the files referenced by a historical database dump. Each dump
now has its own `.files/` directory and SHA-256 manifest. An exported Postgres
snapshot and a SHARE lock on `storage.objects` keep the copied versions and
dump metadata consistent. Upload files before publishing the dump; retain and
archive the pair together. Restore validates the manifest before stopping the
app and copies immutable versions before restoring the database. Older dumps
remain usable for database-only restores (docs/backup.md).

**D83. The panel validates wire contracts generated from Rust.** `ts-rs` and
`schemars` export TypeScript and JSON Schema from the server DTOs; Ajv emits
standalone browser validators so the existing CSP needs no runtime code
generation. Drift checks run in CI. Database cell values stay text or NULL
(D48). Resource state and upload queues own cancellation, result ordering and
the captured upload destination, with unit and browser regression tests.

**D84. SQL display limits bound memory without changing batch semantics.**
Dedicated editor connections (D47) allow at most four runs with a 30-second
statement timeout. The client retains up to 1000 rows per result, 8 MiB of
values and 32 displayed results, while the server drains the remaining batch
so later statements still execute. Dropping a request sends Postgres
cancellation and closes its connection. DDL reports `applied` separately from
`catalog_pending`: a failed refresh after COMMIT retries with backoff instead
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
optional pages, `NELCOTA_EMAIL_CONFIRMATION_URL` and `NELCOTA_MAGIC_LINK_URL`,
need the D66 SMTP and turn on one flow each; without them nothing changes.
Their tokens share `auth.one_time_tokens` (V9 widens the `kind` CHECK to
`signup` and `magiclink`), the token in the URL fragment, the one email per
minute per account and kind, and background sending. A token only works as
the kind it was issued for. With confirmation on, signup answers `201 {user}`
without a session, and password sign-in answers `400 email_not_confirmed`
(only after a correct password, so it reveals nothing) until a signup, magic
or recovery link is opened; `POST /auth/v1/resend {type: "signup"}` sends a
new link to unconfirmed accounts only. Turning confirmation on in a project
with unconfirmed accounts holds them too: they confirm through `resend` or a
magic link, or the operator runs `UPDATE auth.users SET email_confirmed_at =
now()`. A magic link only signs in existing accounts: creating accounts from
an unauthenticated email request would let anyone fill `auth.users` and
squat addresses before their owners sign up. Lifetimes: recovery 1 hour,
confirmation 24 hours, magic link 15 minutes (it signs in by itself). The
`links` module owns the link lifecycle (token storage, email text, sending,
sign-in by link); `recovery` keeps only the password change, `confirmation`
the signup policy and `verify` the routing by `type`.

**D90. Panel accounts count as confirmed.** An account the administrator
creates is marked confirmed at once: the operator vouches for the address,
and with signup confirmation on it would otherwise be held until a magic
link or `resend`. The users page marks unconfirmed accounts and offers
"Confirm email" for them (`POST /admin/api/users/{id}/confirm`, idempotent),
which replaces the SQL `UPDATE` of D89 for projects that turn confirmation
on with older accounts. It sends no email: the panel has no mailer and an
invitation flow is a separate decision.

## Sign-in providers

**D91. OAuth/OIDC sign-in with PKCE on both legs, and verified-email
linking.** Google (OpenID Connect userinfo) and GitHub (REST profile plus its
email list, the only place that says an address is verified) sit behind one
`Provider` type, each in its own module; another provider is another module.
The app starts at `GET /auth/v1/authorize` with its own S256 challenge;
Nelcota keeps the sign-in in `auth.flow_states` (V10) with a separate PKCE
verifier toward the provider, redeems the provider's code server to server,
and sends the person to `redirect_to?code=...`. The app trades that code and
its verifier for a session at `POST /auth/v1/token?grant_type=pkce`, so a code
read from a URL, a log or a `Referer` is useless alone; a code is tried once.
`redirect_to` must sit under one of `NELCOTA_OAUTH_REDIRECT_URLS` (same origin,
path below), so `/authorize` is no open redirect; the callback is
`NELCOTA_API_URL/auth/v1/callback`. A provider account is identified by its
own id (`auth.identities`, unique per provider), never by email. A first
sign-in links an existing account only when the provider verified the email:
a confirmed account is linked as is; an unconfirmed one is taken over by the
verified owner, losing the password, sessions and links someone else may have
set up with the address (the pre-registration takeover); an unverified email
that matches an account is refused (`email_conflict`). New accounts get no
password and are confirmed when the provider verified the email. Refusals and
provider errors go back to the app as `?error=<code>`, and an unknown `state`
is an error page, since there is no trusted place to return to. The HTTPS
client is the `reqwest` already in the tree for S3, on rustls with `ring`
(D16), with a 10 s timeout, no redirects and bounded response bodies.

## Panel

**D92. Code gets syntax colours, the second exception to D55.** The SQL
editor colours keywords, function calls, types, strings, numbers and
comments; table and column names keep the text colour. Colour there carries
meaning (it is how people read code) rather than decorating the page. The
palette follows GitHub's light and dark syntax themes, a tested and
readable reference, as `--syntax-*` tokens next to the other theme colours.
The SQL grammar does not mark function calls, so a small view plugin tints an
identifier right before `(` and a built-in keyword glued to it (`count(`),
but not keywords that open a clause or a list (`in (`, `exists(`). Only the
lazily loaded editor changes (D54); read-only SQL blocks stay plain.

**D93. Plain language first, technical on demand; the overview guides.**
Access rules read as what they mean for the app's users: a table is
Protected, Locked (protection on, no rules) or Unprotected; grants become
"Read only" or "Read and write" for Visitors and Signed-in users; a policy is
a sentence ("Each user only sees and changes their own rows") when it matches
a known shape (public or signed-in reading, owner by `auth.uid()`), and
"Custom rule" with its SQL in view otherwise. A "Technical details" toggle,
remembered per browser, brings back RLS, roles, grants and SQL. The overview
opens with what needs action (unprotected and locked tables, each linked to
its policies) and a next-steps list that is only ever ticked by the project's
state: a first table, every API table protected, a user, and a first sign-in
through the API (`signed_in_users`), which means an app is connected. Counts
shrink to one line. Navigation and the accent colour stay (D55, D63).

**D94. The SQL editor can run as a visitor or a signed-in user.** By default
it still runs as the database owner, without RLS, which the toolbar shows as an
amber "Full access" notice. The notice is also the picker: "Visitor" runs as
`anon`, and "Signed-in user..." runs as `authenticated` with the claims of a
real account chosen by email (`sub`, `email`), so `auth.uid()`, `auth.jwt()`,
grants and policies behave as they do for that person through the API. The
editor's connection is dedicated to one run, so the executor sets the role and
`request.jwt.claims` for the session before the SQL, as the API does per
request. It is a way to test rules, not a security boundary: the administrator
can always run anything as the owner, and the SQL may even `RESET ROLE`. The
choice is not persisted, so a reload goes back to the owner.

## Client SDK

**D95. Nelcota ships its own TypeScript client, a thin layer over HTTP.**
`@nelcota/client` lives in `sdk/typescript/` so its contract tests run in the
same CI against the real binary; it borrows no third-party BaaS client.
Every method is one HTTP request with no hidden cache, and access stays with
RLS: the client never decides permissions. It has no runtime dependencies
(only `fetch`, `URL`, Web Crypto, `AbortSignal`, Web Locks and
`BroadcastChannel`), so it runs in browsers, Node 22+, Deno, Bun and edge
runtimes, is ESM with subpath exports and side-effect free, and keeps the
supply chain to the TypeScript compiler. Results are values (`{ data, error }`)
carrying the server's `code` untouched; only programming mistakes throw.
Untrusted input never becomes syntax: identifiers are validated, values in
`or`/`and` groups and `in` lists are always quoted, storage paths are encoded
per segment with `..` refused, and a `service_role` token in a browser is
refused because it bypasses RLS. Refresh is single-flight in a process and,
in browsers, serialized across tabs with a Web Lock, because refresh rotation
ends a session whose token is reused (D23). Retries only cover idempotent
requests on 429/503 and honour `Retry-After`. Types come from
`nelcota types`, which now also emits each table's `Relationships` so a
`select` string can be typed down to its embeds. The server exposes
`Retry-After`, `Preference-Applied` and `Last-Modified` through CORS so a
browser can read them. The SDK follows its own semver and states the minimum
server version it needs.

## Tooling

**D96. Tooling follows the newest stable releases.** The MSRV moves from
1.88 (D19) to 1.99, the stable toolchain CI, the Docker image and the
release build already use, so `cargo update` picks the newest crates
instead of the newest that build on an old compiler. TypeScript is 7, the
native compiler: the SDK and the panel's plain TypeScript projects check
with it. svelte-check still needs the TypeScript 6 compiler API (TS 7 has
no stable JS API yet), so the panel keeps it as `typescript`, from
`@typescript/typescript6`, while `tsc` comes from `typescript-7` and the
scripts call it by path, since both packages ship a `tsc` binary. Drop the
TS 6 package once svelte-check supports 7. Updates still wait seven days
after release (Dependabot cooldown), so "newest" means newest that has
been out for a week.

**D105. Bun is the primary JavaScript runtime and tool; Node stays
supported.** Bun installs dependencies (`bun.lock`), runs the scripts, the
panel's Vite and tests, the examples and the main CI jobs. The SDKs target
both runtimes: published code uses only the web and `node:` APIs that Bun and
Node share, never `Bun.*` or `bun:*`, and every SDK suite also runs on Node
22/24/26 (`test:node`). Tests stay on Vitest, run by Bun: `bun test` lacks
`vi.stubGlobal` and the async fake timers the suites rely on, and the same
suite must keep running on Node. The garbage-collection leak checks run on
Node only, because JavaScriptCore's conservative collector can keep an
unreachable object alive and so cannot prove that nothing leaks. npm still
packs and publishes (trusted publishing with provenance) and drives the
npm-consumer smokes. New releases wait 14 days, through the Dependabot
cooldown and `minimumReleaseAge` in each `bunfig.toml`, replacing the week
in D96. TypeScript 7 now also checks `@nelcota/ssr`, `@nelcota/nextjs` and
the App Router example; only svelte-check keeps TypeScript 6.

## Connecting apps and access

**D97. The panel connects apps and explains refusals.** The API page leads
with the SDK: install, a `database.ts` download generated by the same code as
`nelcota types`, and examples typed for the chosen table. Three tools answer
"why can't my app see this?": the table grid can be read as a visitor or a
user (the D94 executor's role and claims, in a rolled-back transaction,
read-only); each bucket lists the `storage.objects` policies that name it (or
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
runtime `eval`, WebAssembly or Node APIs are needed in the browser.

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
can exceed JavaScript precision use `number | string`, so callers must handle
both forms and can reuse exact values in filters and writes. This preserves
the existing HTTP protocol and needs no runtime dependency or JSON reviver
source support. PostgreSQL array elements can be null even in NOT NULL columns;
generated scalar and enum arrays therefore use `(T | null)[]`. Column
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
the repository-only operating guide at `docs/panel-updates.md` and G03 at
`docs/goals/panel-updates-and-recovery.md`. These are not registered panel guides.

**D102. The official SVG identity replaces the panel mascot.** This supersedes
D62 and the mascot retained in D98. The maintainer retains graphite surfaces and orange contextual accents, with
cobalt blue primary buttons. Use black
marks on light surfaces and white on dark surfaces. Apply the October 2026
brand guide to proportions, clear space and unchanged
SVG masters. Retain Manrope for the interface and IBM Plex Mono for code. Use a single brand placement per screen, a horizontal logo at 240 px or
larger where space permits, and a symbol at 40 px or larger in compact areas.
Keep at least 25% of the emblem height as clear space. Project cards and context
selectors use functional icons instead of repeating the logo. Remove animated
mascot assets and gaze tracking; authentication and update confirmations remain
unchanged. Semantic success, warning and error colors retain their meanings.

**D103. Group page navigation in the sidebar.** Database, Users, Events and
webhooks, and API expose expandable subcategories in the workspace sidebar and
the same mobile menu. Only the selected child carries the current-page marker;
parents expose their expanded state. API sections follow scroll position.
The controller places server areas in its own sidebar, preserving the existing
unsaved-change and operation guards. Do not duplicate these links in horizontal
tab bars. Keep table-specific views, example languages and filters beside the
content they control, using one compact neutral segmented style.
Blue primary actions remain distinct from neutral selection, secondary controls
and destructive actions. Contextual icons supplement visible labels and remain
hidden from assistive technology.

**D104. `crypto-bigint` 0.5 ignored in `cargo audit`/`cargo deny`
(RUSTSEC-2026-0387).** It comes through `p256`/`p384` 0.13, which the latest
`jsonwebtoken` and `openidconnect` still require; the fix exists only in
`crypto-bigint` 0.7. The timing issues affect operations on secret integers.
Nelcota signs with EdDSA or HS256 (D16) and uses these curves only to verify
provider signatures with public keys. Remove the ignore once both crates move to
`elliptic-curve` 0.14, or revisit if ECDSA is ever used for signing.

**D106. One outbound address policy for user-supplied destinations.** Project
webhooks and host alert webhooks share `nelcota_core::net::is_public_address`:
IPv4 refuses private, shared, reserved, benchmarking and documentation ranges;
IPv6 is an allowlist of 2000::/3 minus the IETF, documentation and 6to4 blocks.
The host-management policy check stays looser on purpose, because its
addresses are the operator's own servers and installed policies must keep
loading, but it refuses reserved IPv4 and IPv6 forms that embed an IPv4 address.

**D107. The panel's assets are brotli-precompressed at build time.**
`crates/admin/build.rs` compresses the embedded `ui/dist` at quality 11 and
embeds only the brotli copy (about 2 MB more binary); clients without br get the
existing runtime gzip. Variants are cached by content hash, so a rebuilt but
unchanged `dist` is not compressed again. HTML entry points carry an ETag and
answer 304; hashed assets stay immutable (D53).

**D108. The panel loads only what the first screen needs.** Each language's
texts are a separate chunk loaded before mount, with no fallback to the other
language (the types already require every key in both). Guides load one at a
time and index their text only when someone searches. A browser that was signed
in last time prefetches the shell and the current page alongside `/session`;
a first visit downloads only the sign-in screen. Response validators load on
first use, always before the request is sent, so a failed download can never
follow a committed write.

**D109. Internal tooling scripts are TypeScript run by Bun.** Scripts that
only maintainers run (`scripts/*.ts` in the TypeScript SDK and the panel) are
type-checked by `bun run check`. Consumer smokes and `package-test.mjs` stay
JavaScript because they stand in for a JavaScript user of the published package
on every supported Node version; examples stay copy-paste JavaScript; generated
validators, framework configs and k6 benchmarks keep the format their tools
expect.

**D110. The one-command VPS setup turns the firewall on.** D44 still holds
for `init` run by hand. The installer, though, prepares a whole public VPS, and
a missing firewall or an active one that blocks 80/443 are the usual failed
setups. It adds HTTP/HTTPS to an already active firewalld or ufw; otherwise it
passes `--firewall` to `init`, which allows SSH on 22 and the ports `sshd -T`
reports. `--no-firewall` opts out, and a `--local` host is left alone. Below
2 GB of RAM without swap it adds a 2 GB swap file, and on Debian/Ubuntu it
enables unattended-upgrades.

**D111. List filters live in the sidebar.** Amends D103: a page whose main
content is a filtered list (Tables, Access policies) exposes its filters as
sidebar sub-items, kept in the URL (`?filter=`), and keeps only the search on
the page. Sidebar items may carry a short label when the page title does not
fit the sidebar; the page itself keeps the full title. Views of one object
(a table's data and structure) and example languages stay beside the content.

**D112. Rate limits cover the whole public API and every account.** Amends
D26 and D69. Keys group IPv6 by /64. Existing accounts get an account-wide
password budget of ten times the per-IP one, in a store of their own; over it,
only networks (IPv4 /24, IPv6 /64) where the account has an open recent
session in `auth.sessions` get through, up to a second budget of the same
size. This trades admission from new networks under a sustained distributed
attack for a hard cap on distributed guessing: one address cannot lock anyone
out, but about ten addresses (or IPv6 /64s) can keep an account closed to new
networks. Loopback, private and link-local addresses, which a proxy or
server-side renderer presents for many users, never count as known. The REST and storage
APIs have a per-account or per-IP budget (`NELCOTA_API_RATE_LIMIT_PER_MINUTE`,
`service_role` exempt). The client IP skips `NELCOTA_TRUSTED_PROXY_HOPS`
trusted proxies from the right.

**D113. Signed URLs are bound to one stored version.** Amends D79: a signed
URL names the version (the key of the bytes, D78) the signer could read, not
only the bucket and path. Replacing a file, or deleting it and uploading again
under the same name, creates another version, which the old URL answers with
404 as if the file were gone; a grant that names no version is refused.
Sharing a file does not share whatever is stored under its name later.

**D114. Webhook admission never aborts the business write.** V13 counted the
queue in one `webhook_queue_usage` row and raised `53300` above 10,000
outstanding or 100,000 retained deliveries. Every captured write locked that row
until commit, and healthy history or one stalled destination froze writes on all
watched tables. V19 counts outstanding work per webhook in sixteen shard rows: a
transaction updates a shard no other transaction holds (`SKIP LOCKED`, its
backend's shard first). When all sixteen are held, it inserts its own overflow
row under a fresh key instead of waiting, so a writer never queues behind
another on a counter and writers on two watched tables cannot deadlock there;
the worker folds committed overflow rows back. Capture sums every row. Beyond
10,000 outstanding deliveries for one webhook, the event is stored as a failed
`queue_full` delivery with omitted contents, like an oversized payload, and the
row commits; resends are refused at the same limit. Concurrent transactions
cannot see each other's uncommitted work, so the limit is approximate by what
they add together. History is bounded by retention instead: the worker deletes
terminal deliveries older than seven days or beyond the newest 100,000,
continuing while batches come back full. `nelcota.webhook_queue_usage` remains
as a read-only view.

**D115. One caller cannot hold the REST pool.** The request pool is small and
RLS says which rows a query may see, not how much it may cost, so the server
bounds who uses the pool: each REST request takes one of its caller's slots
(the signed-in user, otherwise the client address with IPv6 grouped per /64;
`service_role` is exempt), `NELCOTA_API_CONCURRENCY_PER_CALLER` at a time and
half of the pool by default. Extras wait one second, then get 429. A request
that is dropped cancels its PostgreSQL statement, and its connection is closed
instead of returning to the pool, so a late cancel cannot reach another
request. This limits
concurrency, not request rate; a per-minute rate limit is a separate control.

**D116. A refresh retry returns the successor it repeats.** Amends D23 and the
ten-second retry grace: a retry of the latest rotation used to mint a new
pair and revoke the lost successor, so a second holder that did receive that
successor later presented it as reuse and lost the session. Now a retry
answers with the same successor and a new access token. Because only token
hashes are stored, each rotation keeps its successor on the rotated token's
row, XORed with an HKDF-SHA256 key derived from the rotated token (one-time:
a token rotates at most once) and checked against the successor's hash on
the way out. Holding the rotated token already gave that power within the
window. The next rotation and hourly pruning clear it. Rotations from before
V21 keep the previous behaviour; reuse outside the window is unchanged.

**D117. A signup confirmation proves the inbox, not the signup password.**
Amends D27, D89 and D112. Opening a signup link shows only that someone reads
the inbox; whoever signed up may have registered someone else's address with a
password of their own. The link keeps the signup password only when the client
confirming presents the PKCE verifier of the S256 `code_challenge` it sent with
the signup (V22 stores the challenge with the link and joins the auth-only
migration set). Otherwise the confirmation claims the account like a first
magic link: the password is cleared, earlier access is revoked, and the person,
signed in by the link, sets a password. Resent links are never bound. With
confirmation on, signup no longer reveals accounts: an existing email gets the
same `201 {user}` as a new one, with a random `id`, and the account does not
change; its inbox gets an unbound confirmation link while unconfirmed, or at
most one notice a minute once confirmed. Without confirmation the answer is a
session, which cannot be faked, so `409 user_already_exists` remains there and
reveals accounts. The /64s of one IPv6 /48 may hold at most 1/64 of the per-IP
limiter store, and signup also has a per-/48 budget. Each email without an
account gets an account-sized decoy budget of its own, in a separate store that
drops its oldest key when full, instead of D112's 4,096 shared decoys.

### Known pending items

- Filtering parent rows by their embeds (`!inner`) and self-referencing embeds.
- `nelcota.com/install` should redirect to
  `https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh`.
