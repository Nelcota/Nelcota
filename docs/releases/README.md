# Versions and upgrades

This checkout targets server **0.5.3**; confirm published artifacts and readiness
on its [release page](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.3).
SDKs are distributed independently: installing
or updating the server does not update dependencies in a client application.
This checkout documents the following versions; a version number in source
does not itself publish a package.

| Component | Documented version | Distribution and availability |
| --- | --- | --- |
| Server | 0.5.3 | [Official release](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.3), verified binary or OCI image |
| TypeScript SDK | 0.2.1 | [npm version](https://www.npmjs.com/package/@nelcota/client/v/0.2.1); confirm with `npm view @nelcota/client@0.2.1 version` |
| Rust SDK | 0.1.4 | [crates.io version](https://crates.io/crates/nelcota-client/0.1.4); confirm the version before updating Cargo.lock |

TypeScript 0.2.0 and Rust 0.1.3 are the previous published SDK baselines. The
patches above include the subsequent corrections from PRs #109, #112 and #113
and the internal organization from #111. Release workflows verify the tagged
source before publication. Before a new package is available, use a reviewed
local archive rather than assuming an older package contains these changes.

## Update an application

For TypeScript, install the exact selected version and commit the dependency
and lockfile changes:

```sh
npm install --save-exact @nelcota/client@0.2.1
npm ls @nelcota/client
```

For Rust, update the dependency to `nelcota-client = "0.1.4"`, then:

```sh
cargo update -p nelcota-client --precise 0.1.4
cargo tree -p nelcota-client
```

Run the application's type/build/tests and exercise sign-in, refresh/sign-out,
row writes and a file transfer against staging. Read the
[TypeScript upgrade notes](../../sdk/typescript/docs/contract.md#upgrading-from-020)
and [Rust upgrade notes](../../sdk/rust/docs/contract.md#upgrading-from-013).
Portuguese application instructions are maintained in the
[TypeScript quickstart](../../sdk/typescript/docs/quickstart.pt-BR.md) and
[Rust quickstart](../../sdk/rust/docs/quickstart.pt-BR.md).

TypeScript's corrected bucket limit type includes exact decimal strings;
applications must narrow `number | string | null` instead of rounding a large
value. Invalid email arguments now reject their Promise. Both SDKs refuse
invalid cardinality before HTTP, and preserve valid null fields and empty files.
No HTTP route, SDK entrypoint, minimum Rust version or server requirement is
changed by these patch releases.

## Update a server

Review the [0.5.3 notes in English](0.5.3.en.md) or
[Portuguese](0.5.3.pt-BR.md). The 0.5.2 → 0.5.3 patch adds no internal
migrations; the schema remains at V16. Upgrading from 0.4.0 applies internal migrations
V14–V16. Take and restore-test a paired database/file backup and allow a
maintenance window for large metadata tables. Verify the exact binary/image,
not just its version text. Follow [the release handoff](../onboarding/release.md).

Controlled updates and host project management are included in 0.5.0. Activation
still requires explicit SSH enrollment and the host-specific acceptance gates
in [the update guide](../panel-updates.md#enablement-and-acceptance-evidence).
PITR fencing uses matching CLI/app artifacts and explicit `pitr recover`;
ordinary `up` does not clear a restore fence. The controller's V1 layout limits
and the existing F07 rate-limit trade-off remain unchanged.

## Documentation source and historical evidence

The [website](https://nelcota.github.io/NelcotaWebsite/docs/) is maintained in
`Nelcota/NelcotaWebsite`. It imports these Markdown files and the existing
Portuguese catalogs from a pinned Nelcota commit, verifies their SHA-256 hashes,
and renders them at build time. Correct the canonical file here, then sync that
reviewed revision; do not maintain a second hand-written guide in the website.

Current guides describe their documented package versions. A release snapshot
keeps the original tag's prose and its source identity, including statements
dated before publication. Historical goal results remain bound to their original
artifact/date; they do not certify a later release or a production VPS.
