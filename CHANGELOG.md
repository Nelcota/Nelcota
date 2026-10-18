# Changelog

This history uses Keep a Changelog categories and Semantic Versioning.
Dates are published release dates in UTC.

Server releases are listed here. The [TypeScript SDK](sdk/typescript/CHANGELOG.md)
and [Rust SDK](sdk/rust/CHANGELOG.md) have independent package versions.

## [Unreleased]

### Added

- Add explicitly enrolled host project management with visual operation review,
  typed confirmation and reauthentication, durable idempotent jobs, bounded
  project status/logs, Docker namespace collision checks, paired backups and
  guarded restore/removal recovery, including partial recreation and missing
  safety-backup protection.
- Opt-in native panel update management with a separate operator origin, scoped
  host authorization, verified release readiness, durable jobs and SSH recovery.
  Production activation requires the exact-binary VPS acceptance gates in
  [the update operating guide](docs/panel-updates.md).
- A [complete Notes staging guide](docs/onboarding/notes.md) and isolated
  native acceptance runner covering installation, migrations, generated types,
  panel login, two-user RLS, private files, logout and restart persistence.
- Reusable auth/core package boundaries, scoped database bootstrap and an
  external archive consumer; integration and release evidence under `docs/goals/`.

### Fixed

- Keep password login usable from independent sources during account-targeted
  abuse, with hard IP/account-source quotas and at most two seconds of aggregate
  delay. Document the distributed-guessing trade-off and operator recovery.

- Enforce optional JWT `nbf` and `iat` with 30 seconds of clock leeway across
  built-in verifiers. Issuer and audience remain informative.

- Clear pending TypeScript SDK OAuth verification state on sign-out, including
  native browser journal state and failed or sessionless logout.

- Redact authentication adapter credentials and email message content from
  `Debug` diagnostics, including validated mail/OAuth configuration views.
- Reject account passwords above the documented 256-character maximum before
  database admission or Argon2 verification, including current-password checks.
  Keep invalid-credential responses and supported Unicode passwords unchanged.
- Reject Docker PITR PostgreSQL command/data-directory overrides before stopping
  services or writing a fence. Allow only the default command or an exact
  generated tuning profile, with default PGDATA; reject indeterminate settings.
  Validate the packaged native startup command and effective data directory too.
  See [supported PITR configuration](docs/backup.md#supported-postgresql-startup-configuration).
- Release Docker PITR fences with one atomic rename that restores original
  Compose bytes while removing the final marker; keep interrupted recovery
  retryable and reject symlinked, foreign-owned or unexpected fence paths.
- Plain `up` is no longer PITR recovery: use `pitr recover` or a covered restore.
  Docker PITR temporarily rewrites Compose and removes containers, not volumes.
  Unsupported custom entrypoints/app commands/PGDATA and older app images are
  refused; native recovery requires the matching installed binary.
  `pitr recover` may install the missing `amcheck` extension in `pg_catalog`.
- Persist a PITR recovery fence before data-directory changes, blocking native
  and Docker service startup across CLI exit, daemon restart and host reboot.
  Release it only through verified restore promotion or explicit `pitr recover`;
  see [backup recovery](docs/backup.md#pitr-recovery-fence).
- Bind native app subprocesses to their project directory so migrations from
  the host's cwd or `NELCOTA_ROOT` do not reacquire their parent's host lease.
- Resolve the host directory before generating native systemd configuration,
  allowing the documented installation from the current application directory
  without a relative `EnvironmentFile` and repeated application startup failure.
- Release catalog retry/listener owners and cancelled client/read waiters; clear
  closed upload/preview resources while accepted shared operations finish.

- Prevent privileged backup reads and restores from following application-owned
  bucket/object symlinks outside the project's storage directory.
- Allow installation into a writable user-owned `PREFIX` without sudo while
  preserving checksum verification before replacing the existing binary.
- Bound password hashing workers and refill completed webhook delivery slots
  promptly. Rotate refresh sessions with one database statement.
- Reject refresh lifetimes outside PostgreSQL's timestamp range before
  persisting tokens.
- Index user and storage directory listings, cap panel pagination inputs and
  remove cyclic imports in the embedded panel.

### Security

- Serialize native initialization/removal with a machine-wide lease and a
  durable host-directory owner, preventing a second native host from replacing
  the first project's database credentials, Caddy configuration or units.
- Reject native PostgreSQL cluster/port collisions before provisioning and pin
  administrative clients to local `17/main:5432`, preventing initialization or
  ambient libpq settings from changing another cluster. Send the generated
  database password through bounded private stdin instead of command arguments.
- Update rustls to 0.23.46 for RUSTSEC-2026-0346, 0347, 0348 and 0349.
  Published 0.4.0 predates this source correction.

### Upgrade notes

- Startup applies internal migrations `V14__user_listing_index.sql` and
  `V15__storage_directory_index.sql` when upgrading from `0.4.0`. Plan a
  maintenance window for large user or storage metadata tables.
- Keep database backups and their paired disk snapshots before upgrading.
  See [release handoff](docs/onboarding/release.md) for validation and rollback.
- The TypeScript SDK's cross-tab storage publication correction needs a
  separate SDK package release; installing the server does not update clients.
- This section describes an unpublished candidate. The published `0.4.0`
  binaries and image do not contain these changes.

## [0.4.0] — 2026-10-11

### Added

- [Events and webhooks](docs/webhooks.md): capture committed `INSERT`, `UPDATE`
  and `DELETE` changes in PostgreSQL and dispatch signed HTTP deliveries from
  the existing Rust server. Rolled-back writes do not enqueue events.
- Panel configuration, one-time signing keys, key rotation, pause/resume,
  delivery history and manual resends, with English and Portuguese guides.
- Persistent delivery leases, bounded concurrency, retries, recovery after
  restart, queue admission limits and seven-day terminal-history retention.
- Verified HTTPS destinations with connection-time DNS/address checks,
  disabled redirects and proxies, and an explicit loopback-only development
  option. System DNS work stays bounded after request cancellation.

### Fixed

- Bound catalog notifications, project-health probes and SMTP delivery work
  so stalled services cannot create an unbounded backlog or retain permits.
- Limit panel and SDK HTTP error bodies to 64 KiB while preserving HTTP status
  and retry metadata. Bound upload acknowledgements and cancel failed uploads
  without leaving queue work running.
- Preserve rotated or signed-out sessions when an adapter fails to write or
  remove stored state. Observe background auth failures and avoid refreshing
  stale state from another tab.
- Share one Rust SDK refresh worker across cancelled callers and wait for
  aborted webhook worker cleanup during shutdown.
- Generate validators for every webhook response and keep unused organization
  avatar drafts out of the embedded panel.
- Correct SMTP fixtures and quote disposable database names during test cleanup.

### Upgrade notes

- Back up each project before upgrading. Startup applies the new internal
  `V13__webhooks.sql` migration; existing released migrations are unchanged.
- Webhooks require administrator configuration and send full changed rows.
  Receivers must verify signatures and deduplicate event IDs: delivery is at
  least once, with no ordering guarantee.
- Queue-capacity errors roll back the business write rather than lose its
  event. Oversized event payloads are recorded as failed with omitted contents.
- Public destinations require HTTPS. `NELCOTA_WEBHOOKS_ALLOW_LOOPBACK=true`
  permits local development receivers without opening private networks.
- The corrected SDK packages are `@nelcota/client` 0.1.2 and `nelcota-client`
  0.1.2. Their package versions remain independent of the server version.

## [0.3.1] — 2026-10-11

### Changed

- Publish server binaries and images from the Nelcota organization, using
  `ghcr.io/nelcota/nelcota-server` for generated Docker deployments.
- Update repository, documentation and installer links to `Nelcota/Nelcota`.
- Include embedded English/Portuguese guides, anonymous OpenAPI fixes and
  maintained dependency updates. SDK 0.1.1 releases update organization metadata.

## [0.3.0] — 2026-10-10

### Added

- Google/GitHub OAuth PKCE, independent TypeScript/Rust SDKs and generated Rust models.
- Signed-in user password/metadata updates and exposed relationship types.
- JSON errors/request IDs and database error details, with transient errors mapped to 503.
- Separate refresh/PKCE budgets, ten-second retry grace and REST body configuration.

### Changed

- Redesign panel navigation/access guidance and improve SQL/grid/account workflows.

## [0.2.0] — 2026-10-08

### Added

- Disk/S3 file storage under RLS, buckets, signed URLs, quotas and panel file management.
- Signup email confirmation, resend and magic-link sign-in.
- Release build provenance and private vulnerability reporting.

### Fixed

- Keep development credentials private; improve panel drafts/uploads, streamed SQL
  budgets and Rust-generated wire validation.

## [0.1.0] — 2026-10-07

### Added

- Initial public server: schema-derived REST/RPC/OpenAPI, Ed25519/HS256 auth,
  password login, rotating refresh tokens and email recovery.
- Embedded administrator panel and Docker/systemd deployment CLI with
  project isolation, backups, upgrades and database PITR.
- Application storage and OAuth/magic links were not part of this release.

[Unreleased]: https://github.com/Nelcota/Nelcota/compare/v0.4.0...main
[0.4.0]: https://github.com/Nelcota/Nelcota/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Nelcota/Nelcota/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Nelcota/Nelcota/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Nelcota/Nelcota/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nelcota/Nelcota/tree/v0.1.0
