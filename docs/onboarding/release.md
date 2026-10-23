# Release handoff after Notes acceptance

The 0.5.3 release refines panel branding, grouped navigation and the operator console,
and improves bounded diagnostic logging
in the [server changelog](../../CHANGELOG.md). A local acceptance pass proves
the selected binary and its Notes workflow; it does not publish binaries,
container images, Rust crates or either SDK package.

The completed local checks and artifact hashes are in
[Notes acceptance evidence](validation.md).

## Candidate evidence

Build from the reviewed checkout with `cargo build --locked -p nelcota-server`
and run the [Notes acceptance](notes.md) twice, including the browser example
when the frontend dependencies are installed. Keep the sanitized reports with
their binary SHA-256 and test outcomes. CI runs the native acceptance against
the PR's binary, while SDK CI covers Chromium, Firefox and WebKit.

The architecture/performance campaign has its own
[execution report](../goals/execution-report.md). Its long soak predates the
later TTL, SDK persistence and resource-sampler corrections. It is evidence
for the measured binary, not a new soak of every subsequent release candidate.
Repeat a soak on the final candidate if sustained-load certification is part
of the release scope.

## Upgrade an existing project

The 0.5.2 → 0.5.3 patch retains internal schema V16 with no new migration.
Rehearse that exact upgrade and a paired database/file restore on a disposable
installation before publishing. Existing legacy-upgrade CI also covers
0.3.1 → this checkout; that result does not substitute for the 0.5.1 baseline.

SMTP now requires implicit TLS or mandatory STARTTLS, and Linux initialization
checks privileges, the cron scheduler and requested UFW operations. Review
[the deployment prerequisites](../deploy.md) and [configuration](../configuration.md).

1. Take a database backup and, for disk storage, its paired file snapshot.
   Keep the `.dump` and `.dump.files/` together and test their restore in a
   separate project. Use [backup.md](../backup.md) for the commands.
2. Allow a maintenance window for internal migrations `V14`, `V15` and `V16`
   when upgrading from the published `0.4.0`. V14/V15 index user listing and
   storage directories; adding stored columns and indexes can lock or rewrite
   a large storage metadata table. V16 adds durable panel SSO redemption receipts
   and is not part of the standalone auth migration selection. Measure the
   upgrade on a representative staging copy before changing existing projects.
3. Once the target version is published, install its CLI and use
   `nelcota -p <project> upgrade --version <version>`. Check health, existing
   user login/refresh, RLS, an existing file download and webhook delivery.
4. Keep the previous version and pre-upgrade database/file backup available.
   The CLI has automatic rollback on failed health, documented in
   [deploy.md](../deploy.md#upgrade). A manual downgrade must also restore the
   compatible database and paired disk snapshot.

Auth refresh lifetime validation now rejects values that cannot fit a
PostgreSQL timestamp. Keep the normal `NELCOTA_REFRESH_TOKEN_TTL_DAYS=30`,
or choose a positive representable value. Hash worker and webhook scheduling
changes preserve the HTTP contract and password hashing parameters.

## Publish a version

After review and green CI on the final commit, select the server version,
update its workspace version and Cargo lockfile, and replace **Unreleased**
with a dated changelog entry. Core/auth path dependencies must retain matching
version requirements when the workspace version changes. Build and verify
that final commit before creating its `v<version>` tag.

The server [release workflow](../../.github/workflows/release.yml) builds
checksum-protected Linux amd64/arm64 musl binaries and publishes
`ghcr.io/nelcota/nelcota-server:<version>`. Verify the released binary checksum,
image availability and the Notes installation before updating a public
staging project. Tags and registry packages are separate publication actions;
none is performed by the local acceptance runner.

Auth/core publication and the SDKs have independent gates. Keep the TypeScript
cross-tab persistence fix in its own package changelog and version before
publishing it; upgrading the server does not update installed browser SDKs.
See [TypeScript releasing](../../sdk/typescript/docs/releasing.md),
[Rust SDK releasing](../../sdk/rust/docs/releasing.md) and
[auth integration](../auth-integration.md).

## Current limits

- Local staging binds HTTP to loopback and does not exercise a public TLS
  proxy, DNS, SMTP, email confirmation, OAuth or an external backup provider.
  Those features need acceptance using the deployment's actual configuration.
- The Notes acceptance uses disk storage. S3 and upgrade/backup compatibility
  have separate CI checks; a Notes pass does not replace them.
- Logout retires the refresh session. Existing access JWTs remain valid until
  expiry; the default lifetime is 900 seconds. Do not promise immediate access
  JWT revocation.
- Auth rate limits are per process. Published auth/core archives require
  compatible matched versions; a separate auth service is not deployed here.
- Resource measurements from shared hardware establish regression evidence,
  not guaranteed VPS capacity or a production SLA.
