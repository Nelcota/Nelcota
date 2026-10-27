# Changelog

This history uses Keep a Changelog categories and Semantic Versioning.
Dates use UTC.

Server releases are listed here. The [TypeScript SDK](sdk/typescript/CHANGELOG.md)
[Rust SDK](sdk/rust/CHANGELOG.md) and [Next.js integration](sdk/nextjs/CHANGELOG.md)
have independent package versions. See [current status](docs/current-status.md)
for the October 27 server scope and independent SDK publication checkpoint.

## [Unreleased]

### Changed

- The Webhooks page no longer repeats the sidebar's "Webhooks" and "Delivery
  history" items as tabs inside the page (D103 rules out duplicating sidebar
  links in tab bars); the sidebar is the only navigation between the two views,
  as for the database and users groups. The API page's example toggles are
  grouped buttons rather than navigation landmarks.
- The shortcut rail shows only on tablets (768–1023px), where the sidebar is a
  menu. On wider screens it repeated the sidebar's links and theme toggle; the
  brand mark now sits atop the sidebar (D111).
- The three summary cards on Access policies share the row equally; the third
  was narrower because it lined up with the side column below.
- Panel pages share one frame: the same gap under every page title, the same
  stat card sizes, one badge style for statuses (webhooks, deliveries, sign-in
  options), equal side columns on the database and storage pages, and the
  Updates page in the standard container.
- Overview cards have a single link each, named like the sidebar, and the
  "Needs you" list appears once. The API page drops its "Connect my app"
  button, which repeated the sidebar link (D103).
- Delivery details lists attempts as rows on phones and keeps its way back in a
  phone-only breadcrumb, like the storage pages; the delivery history hides its
  pager when everything fits on one page. Webhook card menus sit next to the
  status.
- The Migrations title is the page's main heading on phones, and its list is
  called "History".

### Fixed

- SQL JSON exports keep every column of a join that selects two columns with
  the same name (`id`, `id_2`), as the grid and CSV already did.
- The SQL error marker and line point at the right place when the query has an
  emoji or other character outside the Basic Multilingual Plane before the
  error.
- Deleting the last rows of a page past the first, or opening a stale page
  link, moves the table or user list to its last page instead of reading
  "empty".
- Webhook delivery paging is disabled while a new filter loads, so it can no
  longer send the previous filter's cursor.
- Users and Access policies searches no longer drop a trailing space while
  typing.
- The table export menu says that "View as" does not apply to downloads, which
  use full access.
- Generated SQL quotes column and table names that are reserved words
  (`order`, `user`), which used to make the statement fail.
- Counts in the panel follow the language's number format (`1.234 usuários`),
  and the alert summary and review countdown use singular and plural forms.
- Screen readers hear the alert summary once instead of every timestamp,
  which limit fields are invalid, the confirmation phrase to type, the current
  updates page in the rail and links that open a new tab. Failed uploads show a
  translated message instead of the library's English text.
- Portuguese texts use "apagar" and "e-mail" consistently and explain
  "worker", "heartbeat" and "magic link" in plain words.
- The page's main scroll area no longer draws an outline after mouse or touch
  navigation; keyboard navigation still shows it.

### Security

- Signing out in one tab signs out the panel's other tabs, and signing out
  forgets the SQL history and open queries kept in the browser (saved queries
  stay).
- A project's sign-in handoff only follows links to that project's own
  address.

## [0.5.6] — 2026-10-27

### Changed

- Panel and `nelcota dev` passwords no longer use characters that look alike
  when copied by eye (0/O, 1/l/I); they stay 20 random characters, about 116
  bits. The note under printed passwords names the exact command that prints a
  new one (`nelcota -C <host> admin-password`, with `-p` for a per-project
  login), and the installer's final messages repeat it.
- The one-command VPS setup turns the firewall on by default (`--no-firewall`
  leaves it off; D110). It adds HTTP and HTTPS to an already active firewalld
  or ufw, which used to block HTTPS without any error. It enables automatic
  security updates on Debian/Ubuntu and adds a 2 GB swap file below 2 GB of
  RAM. When `nelcota up` stops at the public HTTPS check, the installer says how
  to finish once DNS points at the machine.

### Security

- The installer runs nothing until the whole script has downloaded, compares
  the binary with the published SHA-256 itself (a checksum file that names
  another file is refused), downloads over HTTPS only with timeouts and
  retries, and no longer repeats arguments such as `--s3-secret-key` in its
  root error.

### Fixed

- A failed backup destination, SMTP or alert test in the host controller no
  longer leaves the host waiting for attention. Wrong S3 keys used to block
  every later operation, including the one that would fix them, until it was
  repaired over SSH. A test that fails now ends `failed`. A test already stuck
  by 0.5.5 keeps its record: fix the keys in `host.env` over SSH, then recover
  it from the panel.
- The installer replaces the binary atomically after checking that it runs and
  reports the requested version, starts Docker before `nelcota init` (the
  Docker script leaves it stopped on Fedora/RHEL), waits for the apt lock held
  by unattended upgrades on a fresh VPS, resolves `latest` once for both
  downloads, and refuses an invalid version, repository, `PREFIX`, `--dir` or
  `NELCOTA_SKIP_DOCKER` before changing anything.
- The VPS setup stops before changing anything on a system without apt-get or
  dnf, instead of opening firewall ports and enabling Docker before `init`
  failed on the missing cron service, and it reads `free`, `df` and `ufw status`
  in English, so a translated system no longer breaks the swap check.
- Passing `--yes` (or `-y`) to the installer skips every `nelcota init`
  question, such as the S3 backup one, and no longer makes init fail with a
  repeated `--yes` when there is no terminal.

## [0.5.5] — 2026-10-27

### Security

- Check host alert webhooks with the same address policy as project webhooks.
  Alert destinations no longer accept the 6to4 relay (192.88.99.0/24),
  discard-only 100::/64, IPv6 benchmarking and other IETF blocks in 2001::/23,
  IPv6 documentation 3fff::/20 or any IPv6 address outside 2000::/3. The
  host-management policy also refuses 240.0.0.0/4 and IPv6 addresses that embed
  an IPv4 address (IPv4-compatible, NAT64, 6to4, Teredo).
- Trust a client-declared `image/*`, `audio/*` or `video/*` type only when the
  file's bytes confirm it (SVG must look like SVG); other uploads in those
  families are stored as `application/octet-stream` and downloaded instead of
  shown inline.
- Keep a policy's custom roles when it is edited in the panel: saving a policy
  created in SQL with `TO editor` no longer widens it to `TO PUBLIC`.
- Reject state-changing admin requests whose `Origin` header is not valid
  text or that send `Sec-Fetch-Site: same-site`.

### Added

- A "Context for AI" section on the API page builds an `llms.txt`-style
  document (project address, SDK usage, RLS policies, buckets and the generated
  `database.ts`, with no secrets) to copy or download for coding assistants.

### Changed

- The panel loads faster: the sign-in screen downloads about 31% less, each
  language and guide loads only when used (the Guides page went from 397 KB to
  23 KB gzip), a returning browser starts in 4 sequential requests instead of 6,
  and the server sends brotli-precompressed assets from the binary instead of
  compressing them on every request.
- SQL results with more than 200 rows are virtualized, so a 1000-row result
  renders in about 0.2 s instead of 2 s; table grids and JSON previews do less
  work per cell, and JSON previews keep every digit of large numbers.
- The host and updates consoles validate controller replies with validators
  generated from the Rust types, like the rest of the panel.
- Host memory, disk and file sizes are shown in binary units (KiB, MiB, GiB)
  with the reader's number format.

### Fixed

- Deliver alerts to endpoints written as an IPv6 literal (`https://[…]/hook`),
  which previously failed every delivery.
- Validate the operator email at enrollment with the same rules used when an
  alert email is sent.
- Restore terminal echo after a hidden password prompt if the CLI panics while
  reading it.
- Confirm a linked OAuth account's email once the provider verifies it, and
  drop stale `code`/`error` parameters from the OAuth `redirect_to`.
- Load the schema catalog in one snapshot so concurrent DDL cannot produce a
  torn catalog, and order overloaded functions deterministically.
- Return `400` for NUL bytes in select aliases and malformed quotes in
  `in`/`or`/`and` filters, refuse `order`/`limit`/`offset` on `POST`, and return
  `404` when a bucket is deleted during an upload.
- Prune expired one-time tokens and OAuth flow states, apply the free-space
  guard to empty uploads and release the quota before old versions are deleted.
- Panel: negated filters keep their `not`, saved SQL queries follow other tabs,
  a malformed blocked path no longer breaks Overview and Policies, and a
  non-JSON `200` reply shows an error instead of an endless spinner.
- Check that the caller's session is still active before verifying
  `current_password` on `PUT /auth/v1/user`, so a logged-out access token can no
  longer test passwords until it expires.
- Keep custom SSH ports open with `init --firewall`: allow every port reported by
  `sshd -T` and the session's port, since `sudo` usually drops `SSH_CONNECTION`
  and the `OpenSSH` rule only covers port 22. The installer no longer duplicates
  this rule.

## [0.5.4] — 2026-10-25

### Changed

- Refresh Rust 1.99.1, Rust and JavaScript dependencies, native Oxlint 1.89.0,
  and pinned CI actions; retain the Rust SDK minimum supported version of 1.88.

- Redesign the admin login with a centered wordmark, an inset gradient frame,
  larger fields, and language and theme controls in the footer.
- Align SDK install/upgrade guides with published TypeScript 0.2.3, Rust 0.1.6
  and Next.js 0.1.1. Make the App Router example a locked registry consumer,
  document its standalone setup, and keep Rust REST demo identities separate.

- `install.sh` sets up a whole VPS when given `nelcota init` arguments:
  `curl ... | sudo sh -s -- api.yourdomain.com` installs cron, Docker and the
  CLI, then runs `init` and `up` in `/opt/nelcota`.
- `nelcota upgrade --without-controller` upgrades projects on a host enrolled in
  the updates controller while installation from the panel is unavailable. It is
  refused while a controller job is unresolved, for projects the controller
  already activated and when run from the controller's own binary.
- Show the panel's startup as animated steps (connecting to the server, then
  opening the panel) around the brand mark, with a note when it takes longer
  than usual. Fast starts skip the screen instead of flashing it.
- Apply the saved light or dark theme before the first paint, through a hashed
  script file allowed by the CSP, instead of flashing the dark default.
- Share the login's header with the offline screen and preload the panel font.
- Return primary buttons to the regular size; the large size is now opt-in
  for the login and onboarding. Positive states (on, active, delivered) are
  green instead of brand orange, and a zero error meter is neutral.
- Ask before issuing a `service_role` token or making a bucket public, keep
  webhook signing keys open until copied, and mask issued tokens on screen.
- Give webhooks in-page tabs, phone-friendly delivery cards, a "table
  missing" state and specific confirmations. Use "Storage", "access rules"
  and "row protection (RLS)" consistently, explain RLS states on the policies
  page and replace database jargon with plain language.
- Fit the table toolbar and migrations list to common desktop widths, show
  the tables overview and file details on phones, show where SQL results
  appear, and make the table cell editor clearly visible.

### Fixed

- Bind automatic file collection to a persistent database identity. Keep bytes
  when independent databases share a physical store or existing versions cannot
  be attributed, and keep collection disabled after a restart.
- Exclude private host configuration and nested SDK build/dependency folders
  from Docker build contexts while retaining example configuration and assets.
- Retain immutable storage bytes when metadata publication cannot be
  acknowledged, and reconcile unreferenced versions through the existing
  garbage collector instead of risking a committed row with missing bytes.
- Preserve special PostgreSQL column/type names in the panel's row editor,
  and display early calendar years and unrecognized dates without silently
  changing their values.
- Keep structured panel filters, sort terms and primary-key ordering literal
  when PostgreSQL column names contain reserved words or punctuation.
- Serialize refresh rotations by session before token-row ownership to avoid
  deadlocks between retries and their successors. Reuse the fixed ownership
  and state query plans per connection to avoid recurring prepare round trips.
- Bound JSON preview indentation and allow keyboard users to reach and scroll
  pages whose contents are entirely read-only.
- Give scrollable code samples a supported accessible name while preserving
  keyboard focus and copying.
- Return `400 invalid_grant` for oversized present refresh tokens, allowing SDKs
  to discard invalid sessions; absent/empty tokens retain their required-field
  validation response.

## [0.5.3] — 2026-10-23

### Changed

- Refresh the operator console with clearer release, approval, recovery and
  history sections. Use official SVG logos in both panels, retain Manrope,
  remove the mascot and use cobalt primary actions on graphite surfaces.
- Simplify the empty table editor and standardize contextual controls, icons
  and responsive primary buttons.
- Move database, user, webhook and API navigation into expandable sidebar
  subcategories, shared with the mobile menu. Move server areas into the
  operator sidebar while preserving unsaved-change confirmations. Keep
  table views, example languages and filters beside their content.
- Keep mailer and storage failure context without opaque provider text or
  identifying storage paths; preserve typed IO metadata and cleanup behavior.
- Bound request diagnostics and record route templates instead of identifying path
  values. Keep normal request correlation and HTTP responses unchanged.
- Classify database/pool failures using stable events and SQLSTATE without opaque
  database messages in diagnostic logs.

## [0.5.2] — 2026-10-23

### Added

- Add operator-approved operational email and HTTPS webhook digests for service
  health, low disk, certificate expiry and overdue/failed backups. Persist incident
  confirmation, recovery, cooldown and bounded delivery retries independently of
  browser sessions; support a separately configured external heartbeat observer.
- Record private backup outcomes so partial dump mtimes cannot imply success.
  Matching CLI/controller versions and an independent missed-heartbeat rehearsal
  are required before operational activation.

- Add an operator-only Server workspace with bounded health/resource diagnostics,
  typed SMTP/OAuth and external backup settings, daily schedule/local retention,
  panel-administrator password changes and application restart. Reuse durable
  host plans, explicit approval, project identities and recovery; keep secrets
  outside public receipts and preserve the separate update acceptance gate.
- Record a distinct configuration-rollback result and resume interrupted rollback
  without restoring database data or replaying a verified application restart.
- Add external backup write/read/delete tests and verified-copy freshness bound
  to the current recovery configuration.

### Changed

- Refresh the panel with a graphite workspace, orange action accents, a compact
  navigation rail/sidebar and contextual breadcrumbs. Keep light mode, keyboard
  navigation and mobile controls; show real project resources above API traffic.
- Update the transitive `ctutils` dependency to 0.4.4 for RUSTSEC-2026-0385.
- Require HTTPS external backup endpoints and read back database/files plus
  AES256-encrypted recovery configuration before CLI/scheduled backup success or
  local retention. Failed verification preserves the local backup pair.


### Fixed

- Keep pending panel confirmations visible until their operation settles, expose
  mobile menu state and focus, and distinguish failed overview/project loading
  from ongoing work. Improve small-text and positive-state contrast in both themes.
- Reflow resource cards using available workspace width, and wrap error feedback
  before retry controls compress its message into a narrow column.
- Read operational alert secrets from one bounded, private, owner-checked file
  descriptor without following symlinks; reject shared-address webhook routes.
- Refuse inconsistent backup completion receipts and show persistent monitor
  errors before stale-check notices. End the loading notice after a failed read.

## [0.5.1] — 2026-10-21

### Fixed

- Update TLS certificate verification and root-store dependencies for
  RUSTSEC-2026-0381, RUSTSEC-2026-0382 and RUSTSEC-2026-0383.
- Bound ordinary panel JSON requests and response reads to 60 seconds, release
  pending forms on timeout and preserve drafts. Warn that a write may already
  have completed and require checking the data before a manual retry.
- Reject overflowing admin table/user page offsets before querying PostgreSQL,
  and refuse update-controller status responses with a non-boolean `host_busy`.
- Preserve exact bucket file-size limits when editing other settings, including
  limits smaller than 0.01 MiB.
- Protect panel form drafts during navigation and browser history changes; keep
  global search in the active modal's focus context and within short viewports.
- Keep account/project controls, long dialog identities and password entry usable
  on narrow screens and with enlarged text. Improve light-theme status contrast
  and distinguish update loading, enrollment and retryable error states.
- Require encrypted auth email transport: implicit TLS or mandatory STARTTLS.
  Refuse plain/opportunistic SMTP, ambiguous URL options and fragments before
  delivery; keep supported encrypted configurations and certificate verification.
- Bound refresh retry grace by token expiration, including the exact deadline,
  while preserving session revocation and reuse detection.
- Prevent caching of auth handler responses with `no-store`/`no-cache`, retaining
  the public JWKS cache policy and existing response payloads.
- Reject host initialization without the privileges required for storage ownership
  before writing credentials, including with `--skip-checks`.
- Require an active, boot-enabled cron scheduler for Linux host installation;
  validate it in `doctor` and abort init if the daily job cannot be installed.
- Refuse unavailable or inapplicable `--firewall` requests and propagate ufw rule
  failures before writing new host credentials. Document VPS prerequisites.

## [0.5.0] — 2026-10-19

Server 0.5.0 is [published](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.0).
Verify checksums/provenance and readiness for the selected artifacts before
installation. Independently versioned SDK patches and application upgrade steps
are listed in the [version guide](docs/releases/README.md).

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

- Harden session invalidation.
- Persist panel SSO replay protection.

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

- Startup applies internal migrations `V14__user_listing_index.sql`,
  `V15__storage_directory_index.sql` and `V16__panel_sso_replays.sql` when
  upgrading from `0.4.0`. V14/V15 index user and storage listings; V16 adds
  durable panel SSO redemption receipts. Plan a maintenance window for large
  metadata tables and keep the paired database/file backup available.
- Keep database backups and their paired disk snapshots before upgrading.
  See [release handoff](docs/onboarding/release.md) for validation and rollback.
- The TypeScript SDK's cross-tab storage publication correction needs a
  separate SDK package release; installing the server does not update clients.
- The published `0.4.0` binaries and image do not contain these changes.
  Publication requires exact-source checks and final artifact verification.
- Client candidates have independent versions: TypeScript `0.2.0` and Rust
  `0.1.3`. Preparing these versions does not publish either package.

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

[0.5.0]: https://github.com/Nelcota/Nelcota/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Nelcota/Nelcota/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Nelcota/Nelcota/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Nelcota/Nelcota/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Nelcota/Nelcota/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nelcota/Nelcota/tree/v0.1.0
