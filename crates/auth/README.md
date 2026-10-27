# nelcota-auth

Authentication for Rust, Axum 0.8 and PostgreSQL 17. Authorization belongs to
PostgreSQL RLS. This package depends on `nelcota-core`, without importing the
Nelcota server, CLI, panel, REST, storage or webhook capabilities.

The public facade includes `bootstrap`, `AuthState::new`, `AuthSettings`, `router`,
`Keys`, `JwtVerifier`, `Claims`, `Role`, `Passwords`, mail/OAuth adapters and the
owned `pruner_task`. HTTP errors use `ApiError`; construction fails with typed
configuration, key or bootstrap errors. Secrets must be generated at runtime.

See [the integration guide](https://github.com/Nelcota/Nelcota/blob/main/docs/auth-integration.md)
and the standalone `examples/auth-consumer` application. No Node runtime is
required. Packaging is tested from `.crate` archives; registry publication is a
separate release step, with core released before auth at matching versions.

## Version scope and prerequisites

This facade and archive workflow ship in the server 0.5.0+ source tree
(workspace version 0.5.5) and are not published to a registry.
Use Rust 1.99+, Axum 0.8, private PostgreSQL 17 and matched auth/core versions.
Do not infer registry availability from the workspace version. The integration
guide covers bootstrap, private keys, no-TLS database topology, adapters and
owned background-task shutdown.
