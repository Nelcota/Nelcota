# Releasing nelcota-client

The Rust package has independent semver. A release targets the documented
server protocol, rather than requiring matching server/package versions.

The maintainer needs ownership of `nelcota-client` on crates.io. Configure its
trusted publisher for GitHub owner `Nelcota`, repository `Nelcota`, workflow
`sdk-rust-release.yml`, and environment `crates-io`. The GitHub-hosted publish
job exchanges its OIDC identity for a short-lived token with
`rust-lang/crates-io-auth-action`; it does not use a stored registry token.
After a repository transfer, update the publisher's owner before releasing.
This repository does not contain registry credentials.

1. Run SDK checks and `cargo test -p nelcota-server --test sdk_rust` with Docker.
2. Run the Rust generator tests and external package consumer check.
3. Update the package version, compatibility contract and changelog.
4. Run `cargo publish -p nelcota-client --dry-run` from a clean checkout.
5. Push an intentional `rust-sdk-v<version>` tag to invoke sdk-rust-release.yml.

The release workflow checks tag/version equality, repeats SDK checks and the
real HTTP/Postgres contracts, verifies the package and publishes in the
`crates-io` environment. Publishing requires maintainer registry configuration;
local implementation/testing does not publish or create tags.

Example external package check (after `cargo package -p nelcota-client`):

```sh
python sdk/rust/scripts/package-test.py
```

The consumer resolves the archive under Cargo's effective `target_directory`,
including `CARGO_TARGET_DIR` and Cargo configuration. Use the same configuration
for packaging and verification. To run the archive-selection regressions:

```sh
python3 sdk/rust/scripts/test_package.py
```

To intentionally verify default HTTPS outside the workspace:

```sh
cargo run -p nelcota-client --example https_smoke
```

That makes one anonymous GET to example.com; an HTTP response proves TLS
initialized in the consumer process without Nelcota server startup.


Real-server tests in the current workspace validate the current server source,
not every historical version in the compatibility matrix. For each historical
baseline, start an isolated server of that exact version and run the packaged
consumer against it. Record the server version/digest and supported capability
coverage; a mock transport, MSRV build or package install alone is insufficient.
