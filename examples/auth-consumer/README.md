# Standalone authentication consumer

This example hosts authentication with Axum, Tokio and PostgreSQL. Its graph
includes auth/core, not the other server capabilities. It demonstrates
source/archive packaging (introduced in server 0.5.0; workspace version 0.5.6),
not a deployed auth service.
Auth/core registry publication remains separate from the server release.

## Prerequisites

Use Rust 1.99+, private disposable PostgreSQL 17 with `pg_stat_statements`
preloaded, and permission to create roles/extensions. The connector is `NoTls`;
do not use it across an untrusted network. Independent installations need
separate clusters or coordinated cluster-global roles/passwords.

## Build and run

From the repository root:

```sh
cargo build --manifest-path examples/auth-consumer/Cargo.toml
```

Provide process variables through a private service manager/environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `AUTH_DATABASE_URL` | Yes | Administrator URL to the private example database. |
| `AUTH_DATABASE_PASSWORD` | Yes | Generated authenticator password, separate from the admin password. |
| `AUTH_PRIVATE_KEY` | Yes | Generated Ed25519 PKCS#8 key as PEM/base64. |
| `AUTH_BIND` | No | Bind address, default `127.0.0.1:8080`. |

Generate an Ed25519 key with `openssl genpkey -algorithm Ed25519 -outform DER`
and base64-encode it. Keep credentials out of history/Git. Run the built example
with those variables, or `cargo run --manifest-path examples/auth-consumer/Cargo.toml`.

It bootstraps auth-only migrations, uses a separate request pool and owns its
pruner until Ctrl+C. Signup/token/JWKS use `/auth/v1`; SMTP/OAuth need adapters
and settings. See the integration guide for budgets and compatibility.

The standalone workspace ships its own Cargo.lock. Review lockfile changes
when changing the matched core/auth source or archives, and use `--locked`
once the selected source and its lockfile agree.

## Package validation

Create candidate archives before running the external consumer regression:

```sh
cargo package -p nelcota-core -p nelcota-auth --allow-dirty --no-verify
python3 scripts/check-boundaries.py
python3 scripts/test-auth-package.py --run
```

Local `--allow-dirty --no-verify` packaging does not publish or prove a release.
The subsequent regression builds extracted archives offline and tests owned
PostgreSQL with generated credentials. It needs Docker, OpenSSL and Python
3.11.8+. Publish matched core before auth only after separate release review;
workspace version 0.5.6 does not establish registry availability.

## Troubleshooting

History/checksum errors require compatible package/migration history, not removed
checksums. Unexpected privileged shared roles need administrator review. An
`sslmode` URL alone does not install a TLS connector. Refresh revocation does
not universally retract issued access JWTs.

Related: [integration](../../docs/auth-integration.md), [auth](../../docs/schema-auth.md)
and [security](../../docs/security/README.md).
