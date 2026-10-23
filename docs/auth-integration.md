# Integrating authentication in another Rust application

The supported stack is Rust 1.99+, Axum 0.8 and PostgreSQL 17. The runnable
consumer in `examples/auth-consumer` has its own workspace. Its Nelcota
dependency is `nelcota-auth`; `nelcota-core` is the only internal transitive
dependency. Server, CLI, REST, panel, storage and webhooks are absent from its
dependency graph. No Node runtime is required.

This archive/facade workflow is included in the server 0.5.0 source tree.
A workspace version does not establish registry availability; use matched
candidate archives until core/auth receive a separately reviewed release.

## Build and distribution

From the repository:

```sh
cargo build --manifest-path examples/auth-consumer/Cargo.toml
python3 scripts/check-boundaries.py
cargo package -p nelcota-core -p nelcota-auth --allow-dirty --no-verify
python3 scripts/test-auth-package.py --run
```

The last command extracts both real `.crate` archives into a temporary directory,
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
| `AUTH_DATABASE_URL` | Administrator URL to a private, disposable development database. |
| `AUTH_DATABASE_PASSWORD` | Runtime-generated password for the cluster's `authenticator` role. |
| `AUTH_PRIVATE_KEY` | Runtime-generated Ed25519 PKCS#8 key, base64 or PEM. |
| `AUTH_BIND` | Optional listener; defaults to `127.0.0.1:8080`. |

Generate a development key with `openssl genpkey -algorithm Ed25519 -outform DER`
and base64-encode its bytes. Keep it and the database password out of Git, logs
and browser bundles. In production, inject stable keys from the host's secret
store so restarts and cooperating instances verify the same tokens.

The startup order is explicit in `main.rs`: connect as the administrator for
`bootstrap`; configure a separate request pool as `authenticator`; construct
`Keys`, one shared `Passwords` worker pool and `AuthState::new`; own a pruner
handle; mount `router` with a request deadline; serve with Ctrl-C shutdown.
The example closes the pool after aborting and awaiting its pruner.

Example budgets are four DB connections, two password threads, a five-second
pool wait/create budget and PostgreSQL statement timeout, a ten-second request
deadline and a thirty-second startup deadline. Each hash retains the existing
Argon2id strength: 19 MiB, two iterations, one lane. Dedicated workers bound
thread count and allocator arenas. Cancelling a caller does not release its
running hash slot before computation finishes. Share one `Passwords` instance
per host rather than constructing a pool per request.

`AuthSettings::validate` and `AuthState::new` reject empty issuers, zero or
unrepresentable lifetimes, unsafe link pages and zero request budgets. Defaults
in the example are a 900-second access token, 30-day refresh token, enabled
signup, disabled proxy trust and disabled email/OAuth flows. If a host manually
assembles the public state fields, it owns the equivalent configuration checks.

## Routes and optional adapters

The existing `/auth/v1` routes are preserved: `signup`, `token`, `logout`, `user`,
`recover`, `resend`, `magiclink`, `verify`, `authorize`, `callback` and
`.well-known/jwks.json`. The token endpoint supports password, refresh and PKCE
grants. Errors keep the existing JSON vocabulary and HTTP statuses through
`ApiError`. Both existing SDKs can use the external host's auth routes.

The router marks auth handler responses `Cache-Control: no-store` and
`Pragma: no-cache`, including errors and OAuth redirects. The separate public
JWKS route keeps its five-minute cache policy. Preserve these headers when
adding host middleware or a reverse proxy.

Assign `state.mailer`, configure `state.settings.links` before constructing
the final state, and use the shared `MailDelivery` admission/deadline for mail
flows. Missing adapters leave the corresponding flows disabled. Provider
integration uses `OAuth`, `Provider`, `ProviderKind` and explicit redirect
allowlists. Google and GitHub flows retain the existing verified-email and
PKCE contracts. Provider HTTP transport initializes its TLS provider internally.

`SmtpMailer::new` accepts implicit TLS via `smtps://` or mandatory STARTTLS via
`smtp://` with one `tls=required`. The only query option is a single
`tls=required` (optional for SMTPS); fragments, duplicates and other query/TLS
settings are refused before delivery, including on loopback. Custom `Mailer`
implementations remain responsible for their transport security.

`Keys`, `JwtVerifier`, `SharedVerifier`, `Auth`, `Claims`, `Role` and `VerifyError`
are reachable from the auth facade. EdDSA is preferred; JWKS exposes only public
key material. HS256 requires at least 32 bytes and publishes no shared secret.
With EdDSA and HS256 configured, signing uses EdDSA and legacy HS256 verification
continues. Unknown algorithms/keys and malformed/expired claims fail closed.
Optional `nbf` and `iat` must be whole non-negative epoch seconds and cannot be
more than 30 seconds in the future, using the same leeway as expiration.
This applies to both algorithms and raw-payload verification.
`aud` remains informative and issuer validation is not enforced by `Keys`:
applications needing stricter policies must supply a verifier for their own
protected routes and middleware around auth routes. The built-in auth router
uses its configured `Keys` verifier. Do not silently
assume an issuer/audience policy that the existing contract does not enforce.

Access JWTs remain stateless until expiry. Logout/revocation prevents refresh;
it does not retract an already-issued access token. Refresh rotation preserves
the documented short retry grace: competing requests can both return a response,
but only the newest successor remains usable. Recovery, confirmation, magic-link
and PKCE credentials retain their single-use database consumption boundaries.
Password/link changes and revocation must not resurrect an ended session.
Retry grace never extends a refresh token's expiration: the exact deadline is
expired, and an expired, rotated token follows the existing reuse handling.

## Database lifecycle and authorization

`nelcota_auth::bootstrap` installs canonical versions 1, 2, 5, 9, 10 and 14.
These are the auth tables, shared roles/context functions, single-use links,
OAuth identities and the user-listing index. Shared infrastructure includes
`nelcota.schema_migrations`, `extensions`, pgcrypto and pg_stat_statements.
Panel tables, catalog triggers, storage and webhook objects are absent.
Bootstrap needs an administrator able to create roles and the extensions.

The canonical SQL in root `migrations/` remains unchanged. The core archive
contains byte-identical copies, enforced by `scripts/check-boundaries.py`.
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
on the five shared/auth roles; existing `nelcota_storage` and
`nelcota_webhooks` roles receive the same checks. It does not silently downgrade
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

The included connector uses `NoTls`, matching Nelcota's private PostgreSQL
topology. Do not expose that database connection over an untrusted network.
A host requiring a managed database's TLS connector needs an additional
connector integration; it is not demonstrated by this example.

## Compatibility and operation

Auth/core versions travel together. The current source manifests use 0.5.3;
subsequent compatible fixes preserve constructors, routes, error vocabulary,
claims and additive database history. Breaking Rust changes during 0.x require
a new minor version and a migration/upgrade note. After 1.0, breaking public
changes require a major version. Released SQL is never edited in place.
An older package must not initialize a database containing unknown newer
migrations: upgrade the package before retrying that initialization.

Own `pruner_task` for application shutdown, or call `prune` from the host's
scheduler. Legacy `spawn_pruner` remains a detached compatibility helper.
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

`cargo bench -p nelcota-auth --bench operations` records password hashing and
EdDSA verification separately, without database/network latency. The release
campaign measures login and refresh end to end, with RLS and resource checks.

See `docs/goals/execution-report.md` for compatibility, isolation, concurrency,
packaging and resource evidence from the complete implementation review.
