# nelcota-core

Shared HTTP errors, claims, configuration and PostgreSQL transaction primitives
for Nelcota capability crates. Request role and JWT claims are transaction-local:
commit, rollback and cancellation do not authorize the next pool borrower.

`db::bootstrap` installs the full canonical schema. Auth consumers should call
`nelcota_auth::bootstrap` instead. Bootstrap requires a PostgreSQL administrator;
request pools connect as `authenticator`, never as the administrator.

The packaged `migrations/` directory mirrors the repository's canonical SQL
byte for byte. Run `python3 scripts/check-boundaries.py` before packaging.
Released migrations and their refinery checksums must remain unchanged.

No Node runtime is required. This crate uses PostgreSQL 17 and Axum 0.8.
See the repository integration guide for packaging and compatibility guarantees.

## Version scope

The standalone auth/core distribution is an unpublished source deliverable.
The workspace version is 0.5.4; that does not prove a registry release.
Use matched archives and Rust 1.99+ for this workflow. The complete
[integration guide](https://github.com/Nelcota/Nelcota/blob/main/docs/auth-integration.md)
explains promotion, role ownership, private database topology and shutdown.
