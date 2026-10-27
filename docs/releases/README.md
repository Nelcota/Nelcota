# Versions and upgrades

This checkout targets server **0.5.6**; confirm published artifacts and readiness
on its [release page](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.6).
SDKs are distributed independently: installing
or updating the server does not update dependencies in a client application.
This checkout documents the following versions; a version number in source
does not itself publish a package.

| Component | Documented version | Distribution and availability |
| --- | --- | --- |
| Server | 0.5.6 | [Official release](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.6), verified binary or OCI image |
| TypeScript SDK | 0.2.5 | [npm version](https://www.npmjs.com/package/@nelcota/client/v/0.2.5); confirm with `npm view @nelcota/client@0.2.5 version` |
| Rust SDK | 0.1.7 | [crates.io version](https://crates.io/crates/nelcota-client/0.1.7); confirm the version before updating Cargo.lock |
| Next.js integration | 0.1.2 | [npm version](https://www.npmjs.com/package/@nelcota/nextjs/v/0.1.2); [release procedure](../../sdk/nextjs/docs/releasing.md) and [verification evidence](../goals/sdk-release-completion.md) |

TypeScript 0.2.5 (October 27) parses JSON in large responses about 8 to 12
times faster with the same results; [registry receipts](https://github.com/Nelcota/Nelcota/pull/202#issuecomment-6445288705) record its
tagged workflow, integrity and a fresh consumer. The previous published
TypeScript baseline is 0.2.4.

The October 26 patches are TypeScript 0.2.4, Rust 0.1.7 and Next.js 0.1.2.
TypeScript and Rust retry an uncertain background refresh inside the server's
10-second reuse window; TypeScript also rejects invalid `Date`/`bigint` JSON
bodies, and Rust runs the shared refresh under the client's timeout. Next.js 0.1.2
stops its proxy from clearing a row-less cookie that a sign-in may have replaced.
[Registry receipts](https://github.com/Nelcota/Nelcota/pull/181#issuecomment-6423930169) record the tagged workflows,
integrity and fresh consumers. Previous published baselines are TypeScript 0.2.3,
Rust 0.1.6 and Next.js 0.1.1, with their
[publication receipts](https://github.com/Nelcota/Nelcota/pull/167#issuecomment-6391372294).

Next.js **0.1.1** fixed PostgreSQL connection-pool starvation
and cross-instance lock contention. Its [acceptance ledger](https://github.com/Nelcota/Nelcota/issues/151)
records registry verification, runtime/framework consumers and the two explicitly
skipped external-provider gates. The package peer range targets Next 16; pinned
Next 15.5.28 consumers also passed with the documented adaptations.

The [original October 24 checkpoint](../goals/sdk-release-completion.md#publication-checkpoint--2026-10-24)
retains the historical TypeScript 0.2.2, Rust 0.1.5 and Next.js 0.1.0 evidence.
Future source-only changes require a new package release before registry
consumers can use them.

## Update an application

For TypeScript, install the exact selected version and commit the dependency
and lockfile changes:

```sh
npm install --save-exact @nelcota/client@0.2.5
npm ls @nelcota/client
```

For Rust, update the dependency to `nelcota-client = "0.1.7"`, then:

```sh
cargo update -p nelcota-client --precise 0.1.7
cargo tree -p nelcota-client
```

For a supported Next.js App Router application, install the adapter and its base
SDK together (the production PostgreSQL store also needs application-owned `pg`):

```sh
npm install --save-exact @nelcota/nextjs@0.1.2 @nelcota/client@0.2.5
npm install pg
npm ls @nelcota/nextjs @nelcota/client
```

Follow [the Next.js guide](../../sdk/nextjs/README.md) for the dedicated session
schema, encryption keys, same-origin auth routes and supported pooling mode.
Installing the adapter alone does not configure server-side sessions.

Run the application's type/build/tests and exercise sign-in, refresh/sign-out,
row writes and a file transfer against staging. Read the
[TypeScript upgrade notes](../../sdk/typescript/docs/contract.md#upgrading-from-020)
and [Rust upgrade notes](../../sdk/rust/docs/contract.md#upgrading-from-016).
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

Review the [0.5.6 notes in English](0.5.6.en.md) or
[Portuguese](0.5.6.pt-BR.md). The 0.5.5 → 0.5.6 patch adds no internal
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

## Source and published artifacts

The 0.5.6 source incorporates changes developed after the 0.5.5 tag, including
readable panel passwords and the controller test fix; the hardened one-command
installer is served from `main` for every version. Selecting `--version 0.5.5` still selects
that older release. Confirm the exact binary/image and signed readiness receipt
for the version being installed. Future [Unreleased](../../CHANGELOG.md#unreleased)
changes require another artifact before deployed projects receive them. See
[current status](../current-status.md) for the dated source and validation scope.

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
