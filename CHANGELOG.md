# Changelog

This history uses Keep a Changelog categories and Semantic Versioning.
Dates use UTC.

Server releases are listed here. The [TypeScript SDK](sdk/typescript/CHANGELOG.md)
[Rust SDK](sdk/rust/CHANGELOG.md) and [Next.js integration](sdk/nextjs/CHANGELOG.md)
have independent package versions. See [current status](docs/current-status.md)
for the October 27 server scope and independent SDK publication checkpoint.

## [Unreleased]

### Added

- The TypeScript, Rust, SSR and Next.js SDKs send the signup `code_challenge`
  and confirm signup links with its `code_verifier`, so SDK users who confirm
  by email keep the password they chose (D117).
- The profile photo editor supports drag-to-frame, touch pinch and keyboard
  positioning, zoom, quarter-turn rotation and live avatar previews. A bounded,
  metadata-free source and its framing are saved privately for later editing
  across browsers; removing the avatar deletes its source. Internal migration
  V18 preserves existing photos and adds private editor fields.
- Automatic pre-migration backups through a project-scoped host agent, with
  database/disk-file verification, configured external readback, production
  enforcement, and a durable host fence across cancellation and agent recovery.
  `migration-backup enable` installs the restricted Linux service and socket.

- Deploy repository migrations through scoped, revocable deployment tokens and
  the project API, with project links, named environments, status/dry-run and
  TypeScript downloads. V17 stores token digests and migration audit records.
- The panel can preview/apply uploaded repository migration files and manage
  deployment tokens. Production projects can block direct panel schema changes.
- Development applies/watches application migrations and offers an explicitly
  confirmed local database reset with optional seed.sql. A composite GitHub
  Action builds the locked CLI and applies migrations without database credentials.

- AI context records the latest applied migration, warns about an empty schema,
  and detects changed versions before copying or downloading a stale snapshot.

- REST inserts and upserts honor `Prefer: count=exact`, matching PATCH/DELETE
  affected-row counts and retaining duplicate-resolution response metadata.

- `nelcota dev --mail` runs a project-owned Mailpit inbox and enables email
  confirmation, recovery and magic links over verified local STARTTLS.

- `nelcota update` discovers a stable release, previews the CLI/project versions,
  asks once, preserves the previous CLI and runs the existing backup-backed
  project upgrades. `install.sh --update` provides the same flow for older CLIs;
  both support version/project selection, `--dry-run` and `--yes`, and leave
  controller-enrolled hosts to their existing update workflow.
- REST and storage requests have a rate limit,
  `NELCOTA_API_RATE_LIMIT_PER_MINUTE`, **on by default** at 600 per minute
  (0 turns it off): per account with a user token, per IP without one.
  `service_role` tokens and public or signed file downloads are exempt.
  Behind a proxy without `NELCOTA_TRUST_PROXY`, or when pages are rendered on
  a server with the anonymous key, many visitors share one budget: raise it
  or turn it off when upgrading.
- `NELCOTA_TRUSTED_PROXY_HOPS` (default 1) reads the real client IP behind a
  CDN in front of Caddy (set 2, and list the CDN ranges in Caddy's
  `trusted_proxies`).

### Changed

- Extend the project journey through access verification, migrations, named-environment
  deployment and recovery. Render typed migration previews/results, retain explicit
  approval, and show actionable backup/history errors with the deployment time budget.
- Show recovery scope, the backup timestamp when available and application-level
  verification steps without treating a healthy service as a completed data rehearsal.

- Separate host/update panel state from presentation and split privileged CLI
  admission, execution, validation and process supervision into explicit owners.
  Preserve controller protocols, durable receipts and recovery ordering.

- Remove unused panel policy templates and their catalog entries, the legacy
  avatar crop helper and unused retained URL field, and a redundant alert parser.
  Keep owner-column inference and validate alert settings through the active
  status response boundary.
- The sidebar is wider and uses short labels where the Portuguese page title
  did not fit ("Access", "Webhooks", "Connect", "Sign-in methods"). List
  filters moved from in-page tab bars to sidebar sub-items: Tables (all,
  attention, views) and Access (all, protected, unprotected, attention), kept
  in the URL (D111). "API" is called "Connect" everywhere.
- Page headers keep the primary action on the right at every width; the
  overview, Migrations and Access policies use the shared header too.
- The overview leads with what needs attention (unprotected or locked tables
  and the first steps, hidden once done), then the traffic card with its
  period, totals and series, then plain area cards and the recent blocks.
  The rows-per-table block, the quick-action row and the percentage rings
  are gone.
- Access policies list the problems first, each with its fix beside it
  (turn protection on, create a rule, open the SQL editor for owner views),
  then every table with the urgent ones first; the legend is folded at the
  end. The rule sheet is one screen: the choices as cards, a live sentence
  of what the rule does, and the name and SQL under a folded section.
- Migrations is one timeline: the next version with the panel changes that
  have no file yet, then the applied migrations, newest first; the steps for
  other environments are folded inside the next version.
- "Insert row" always shows its label. "New column" uses the table wizard's
  words (field name, kind of information, required) and keeps default,
  UNIQUE, identity, references and description under "Advanced options".
- Webhooks show a one-line summary instead of two limit cards, keep the
  card menu for secret rotation and removal only, and open the endpoint form
  as a side sheet. The user list drops the id column (it stays in "Copy ID")
  and names the sessions column "Active sessions". Storage folds its notes
  into a collapsible section; Updates has an empty state for hosts not
  enrolled; the account menu no longer repeats "Updates".
- The Webhooks page no longer repeats the sidebar's "Webhooks" and "Delivery
  history" items as tabs inside the page (D103 rules out duplicating sidebar
  links in tab bars); the sidebar is the only navigation between the two views,
  as for the database and users groups. The API page's example toggles are
  grouped buttons rather than navigation landmarks.
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
- **Breaking (Rust):** `AuthSettings::trust_proxy` and
  `AdminState::trust_proxy` became `proxy_hops: u8` (0 ignores
  `X-Forwarded-For`), and `client_ip` takes that count instead of a `bool`.
  `nelcota_server::AppState` gained `api_limit` (built with
  `ApiRateLimit::new`) and `Config` gained `api_rate_limit_per_minute` and
  `trusted_proxy_hops`. `ip_key` and `retry_after_secs` are now public.

### Fixed

- The table editor's JSON `null` handling no longer rewrites the SQL text the
  REST query compiler generates, which failed with a 500 if that text ever
  changed shape. The compiler now offers it as explicit options that only the
  panel uses: per-column `IS NULL` flags on reads and a typed JSON `null`
  write value. REST API statements and responses are unchanged.
- A refresh retry inside the ten-second grace window no longer signs out a
  holder that did receive the rotated answer. The retry now returns the same
  successor refresh token (with a new access token) instead of minting a new
  pair and revoking that successor, so two tabs or instances racing with one
  token keep the session. Internal migration V21 adds the encrypted successor
  column to `auth.refresh_tokens` and is part of the standalone auth selection.
- A webhook delivery claim only takes the claim lock of webhooks with a due
  delivery and room in flight. While one server instance's claim was open,
  it held the lock of every enabled webhook, so other instances sharing the
  database claimed nothing.
- When the statement of a dropped request cannot be cancelled in time, the
  server logs `database.cancel_failed` or `database.cancel_timed_out`. It may
  keep running until `statement_timeout` while the pool opens a replacement.
- Storage uploads keep the real message of a refusal that is not a row-level
  security decision, such as `permission denied for table objects` from a
  missing grant. Only an existing name and policy refusals of names the
  caller cannot see are still answered as a plain policy refusal.
- An upload of unknown length that grows into scarce quota or disk space no
  longer takes the storage admission lock and queries the database on every
  chunk. It reserves half of the remaining room beyond its size, so checks
  stay logarithmic while concurrent uploads still share the room.
- The panel labels webhook deliveries deferred with `dns_busy` and a resend
  refused with `webhook_queue_full` in English and Portuguese instead of
  showing the raw codes.
- The table editor tells a JSON `null` in a json/jsonb column apart from SQL
  NULL: it shows as the text `null`, and saving the text `null` stores a JSON
  `null` instead of SQL NULL, so edits round-trip.
- Migrations generated by the panel no longer show as Diverged on deploy when
  a change contained CRLF line breaks (for example a comment set through the
  panel). The file and its recorded checksum use the same CRLF-to-LF reading
  as `nelcota migrate`, and comment literals keep carriage returns as `E'\r'`
  escapes so their content survives that normalization.
- REST `like`/`ilike` filters can match a literal `*`: an unescaped `*` is still
  the `%` wildcard, while `\*` now means `*`. Other backslash escapes (`\%`,
  `\_`, `\\`) keep their SQL LIKE meaning. Previously every `*` became `%`.
- Webhook queue limits no longer abort writes to watched tables. Beyond 10,000
  outstanding deliveries for one webhook, a change is recorded as a failed
  `queue_full` delivery with omitted contents and the row still commits.
  Terminal history is pruned to the newest 100,000 deliveries instead of
  blocking writes, and concurrent writers and the delivery worker no longer
  wait on one shared counter row. Internal migration V19 replaces the counter.
- One slow webhook destination no longer starves the others. Each webhook has
  at most two sends in flight, claims take the oldest due delivery of every
  webhook in turn, and a send blocked by saturated local DNS lookups is retried
  shortly without using an attempt. Internal migration V20 adds the indexes.
- REST embed keys starting with `_` (`select=id,_r:customers(name)`) are
  refused with `400 invalid_query`; they shadowed the generated SQL's own
  subquery names and changed the response shape.
- Generate panel CRUD examples from complete primary keys and required columns,
  including UUID/composite keys and declared enum values; omit unsafe keyless mutations.
- Align onboarding and CLI guides with published versus current-checkout capabilities.

- REST pages and `Prefer: count=exact` totals use one database snapshot,
  preventing contradictory pagination metadata during concurrent writes.

- Panel row updates and deletes preserve literal primary-key column names,
  including REST modifier names and punctuation, so only selected rows change.

- Generated TypeScript RPC arguments and results retain named enums, composite
  fields and table rows, including arrays and enums used only by functions.

- Document column-level UPDATE grants on upsert conflict keys and the
  `ignoreDuplicates` alternative in the SDK and authorization troubleshooting.

- Local PostgreSQL containers and volumes belong to a canonical project folder,
  with ownership checks and an actionable error when another project owns the port.

- Development environment values are shell-quoted, include a URL-encoded
  `DATABASE_URL`, and preserve unreadable state instead of replacing credentials.

- Interrupted updates before snapshot capture remain recoverable across repeated
  failures. SSH recovery can explicitly restore a verified snapshot after commit;
  the operator's data-loss decision is durable and never selected by HTTP recovery.
- Signup confirmation retires unverified OAuth identities, pending codes and old
  sessions. Proxy IP extraction handles repeated forwarded headers, concurrent
  provider sign-ins avoid duplicate account races, and public email-link requests
  queue account work without exposing lookup time.
- REST filters compare complete `char`/`bit` values and accept array-valued `in`
  lists. Write/RPC JSON preserves long decimals; unsupported polymorphic and
  variadic RPC signatures are excluded. Pool recycling clears unowned transactions.
- Panel deadlines allow database statements to finish; CORS excludes the panel
  and framework errors keep its JSON shape. User search totals match results,
  policy URLs reject truncated identifiers, batched UNIQUE actions track their
  constraints, and exported migrations separate trailing line comments safely.
- Disk collection removes stale multipart staging files and logs failed deletes.
  Unknown-length uploads reserve bytes incrementally instead of consuming the
  full remaining quota.
- CLI mutation checks ignore unrelated journal files, reject duplicate migration
  versions, report proxy shutdown failures and sync dumps before publication.
  Interrupted enrollment can resume its private plan without replacing identities.
- Panel list selection, filter history, repeated SQL shortcuts, navigation during
  saves, malformed guide images and modal search shortcuts retain the current state.
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
- `Retry-After` on rate-limited auth requests rounds up, so clients no longer
  retry a second early and get another 429.
- Uploads without `Content-Length` no longer read the storage total from the
  database for every received chunk while holding the process-wide admission
  lock. Their reservation grows up to 1 MiB ahead of the bytes received, never
  past half of the remaining capacity; the committed total is still checked
  at publication.
- The storage guide no longer claims that every download carries
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`:
  S3 downloads redirect to presigned URLs that cannot set them. It now asks S3
  deployments to add both on the provider or a CDN in front of the bucket.
- `nelcota-server` builds on Windows again: the host update controller's
  worker call is Unix-only and now reports that it is unavailable elsewhere.
- The panel grid and CSV export show json/jsonb values as their JSON text.
  A stored JSON string such as `"42"` no longer appears as `42`, so editing
  it keeps it a string instead of saving a number.
- A host update no longer stops for an operator when a brief host-lock
  holder (an alert check, a scheduled backup starting) wins the race as the
  update starts: the update waits up to 30 seconds for the lock, and a job that
  ends before changing the host is recorded as failed before change instead of
  blocking host changes until `updates recover`.
- The host update worker logs and keeps serving after a failed connection
  accept or caller lookup instead of exiting.
- Native (systemd) installs and upgrades flush the new and previous binaries
  and their directory, so a power loss during `init` or `upgrade` cannot leave
  a truncated or non-executable server binary.
- Each backup first removes what an interrupted backup left in `backups/`: a
  `.dump.partial` file, a `.dump.files` snapshot without its dump, and
  verification scratch directories that held a copy of the project's `.env`.
- `NELCOTA_STATEMENT_TIMEOUT_SECS` and `NELCOTA_STORAGE_UPLOAD_TIMEOUT_SECS`
  are capped at 86400 (one day) at startup. Larger values made startup fail
  while configuring PostgreSQL, or panicked on the first upload.
- Dropping a view, materialized view or foreign table from the panel emits
  the matching `DROP VIEW`, `DROP MATERIALIZED VIEW` or `DROP FOREIGN TABLE`
  instead of a `DROP TABLE` that PostgreSQL rejects.
- Signing out of the panel works again: the panel returns to the sign-in
  screen, other tabs sign out, and executed SQL and open drafts are removed
  from the browser. The request's own session change had made the
  sign-out stop early, leaving the panel open until a later request got 401.
- A panel tab no longer writes back SQL drafts that a sign-out in another tab
  removed.
- Stopping a running SQL query no longer underlines the previous query's error
  position in the new text.
- Applying migrations sends exactly the SQL the preview checked, even if a
  selected file changes on disk in between.
- An upload whose body sends nothing for a minute is dropped with
  `upload_timeout`, so slow uploads can no longer hold every upload slot for
  the whole upload timeout.
- `@nelcota/ssr`: a write whose rotation lease ran close to its timeout no
  longer fails after the new session row and lineage head are durable.
  Retiring the rotated-away row now runs after the lease with its own budget
  and reports failures through `onBackgroundError`.
- `@nelcota/client`: a browser refresh request that never settles (with
  `timeout: 0`) no longer holds its refresh reservation while the tab stays
  open; renewal stops after the request timeout or two minutes, whichever is
  shorter, and other tabs take the reservation over once its lease lapses.
- `@nelcota/client`: browser tabs running SDK 0.2.1 or older hear sign-outs and
  refreshes from newer tabs again; each change also sends the legacy
  `"changed"` broadcast, which current tabs skip as a duplicate.
- `@nelcota/client`: a browser tab no longer signs the user out when it reads
  a session an older SDK tab has committed to IndexedDB but not yet copied to
  `localStorage`; untimed receipts settle five seconds after first sight.
- `@nelcota/ssr`: re-saving the same upstream session during sign-in no longer
  revokes it. Replaced sessions are compared by the access token's `session_id`
  claim instead of their stored JSON.
- `nelcota-client` (Rust): `get_session` honors the refresh backoff after a
  transient failure, returning the still-valid session instead of starting a
  rotation on every call until Retry-After (or 2 s) has elapsed.

### Security

- The OpenAPI document no longer shows a role the names and comments of
  columns it may only insert or update in its row and response schemas. Rows
  list readable columns; `POST` and `PATCH` bodies list the insertable and
  updatable ones, and keep referencing the row schema when they match it.
- The panel also forgets the SQL history and open queries kept in the browser
  when the session expires or another tab signs out, not only on an explicit
  sign-out (saved queries stay).
- Panel session cookies are marked `Secure` whenever `NELCOTA_API_URL` is an
  `https://` origin, not only with `NELCOTA_TRUST_PROXY`, so an HTTPS proxy
  that is not trusted for client IPs no longer gets cookies without `Secure`.
- Password sign-in to an email without an account now spends a decoy budget
  of that email's own, the same size as an account's, in a separate bounded
  store. Before, made-up emails shared 4,096 decoy budgets, so spending one
  email's budget and probing others for a `429` on the shared slot showed that
  the first email had no account.
- One IPv6 /48 can no longer fill the in-memory rate-limit store and so make
  every new client's auth request fail with 429: the /64s of one /48 may hold
  at most 1/64 of the per-IP keys (781 of 50,000), past which only that /48's
  new /64s are refused. Signup also has a budget per /48, so a /48 cannot
  create accounts (and their account-budget keys) at 65,536 times the per-IP
  rate.
- With email confirmation on, signup no longer tells whether an email has an
  account: an existing email gets the same `201 {user}` as a new signup (with a
  random `id`) and the account stays as it is. Its inbox gets a new
  confirmation link while unconfirmed, never bound to the second caller, or at
  most one "Your account already exists" notice a minute once confirmed. With
  confirmation off, signup still answers `409 user_already_exists`, now
  documented as revealing existing accounts (D117).
- Opening a signup confirmation link no longer approves the password chosen
  at signup unless the client that signed up proves itself: signup accepts an
  S256 `code_challenge` and `POST /auth/v1/verify {type: "signup"}` its
  `code_verifier`. Without that proof the confirmation clears the signup
  password, as a first magic link does, and the person sets one while signed
  in. Before, anyone could register someone else's address with their own
  password, have the link resent, and sign in once the owner confirmed.
  Internal migration V22 stores the challenge with the link (D117).
- Signing out in one tab signs out the panel's other tabs, and signing out
  forgets the SQL history and open queries kept in the browser (saved queries
  stay).
- A project's sign-in handoff only follows links to that project's own
  address.
- The server refuses to start with both `NELCOTA_WEBHOOKS_ALLOW_LOOPBACK=true`
  and `NELCOTA_PRODUCTION=true`, so a production project cannot send plain-HTTP
  webhooks to local ports.
- Changing a webhook's URL now also moves its queued deliveries and retries to
  the new destination. Previously a paused backlog was still released to the
  old, possibly no longer trusted, host after resuming, signed with the
  current key. A send already in progress finishes against the previous URL.
- A REST request dropped mid-statement (client disconnect or request timeout)
  cancels its PostgreSQL statement and closes that connection, so the pool
  opens a fresh one instead of waiting for `statement_timeout`.
- One caller can no longer keep every REST connection busy: each signed-in
  user, or each client address (IPv6 per /64), runs at most
  `NELCOTA_API_CONCURRENCY_PER_CALLER` requests at a time, half of the
  pool by default. Extras wait up to one second, then get `429 rate_limited`
  with `Retry-After: 1`; `service_role` is exempt and `0` disables it (D115).
- A REST `select` embeds at most 16 related tables per request, nested ones
  included; each embed is a correlated subquery per parent row, and up to 127
  were accepted before.
- REST reads (`GET`/`HEAD`) run in a `READ ONLY` transaction, so a view or
  policy that calls a writing function cannot change data during a read; such
  a read now fails with `400 db_error` (`25006`). Function calls and writes
  are unchanged.
- Partitions, and inheritance children without row-level security of their
  own, are no longer exposed as REST tables (or listed in the panel). Read
  directly they skipped their parent's row policies, so a broadly granted
  partition returned every row; use the parent, or enable RLS on the child.
- The REST OpenAPI document lists only the columns, column comments and filters
  the requesting role may use, and includes tables it can reach through
  column-level GRANTs only.
- The role guide explains why application functions must never build SQL from
  their arguments: the API's login role can switch to `service_role` and the
  internal roles, so injected SQL could too.
- Auth and panel rate limits group IPv6 clients by their /64, so rotating
  addresses inside one block no longer buys a fresh budget.
- Made-up emails can no longer fill the rate limiter and lock new visitors
  out of sign-up, sign-in and email links: only existing accounts get an
  account budget, in a store of its own.
- Password sign-in has an account-wide budget of ten times the per-IP one,
  so many addresses can no longer guess one account's password in parallel,
  and one address cannot spend it alone. Over it, only networks (IPv4 /24,
  IPv6 /64) where the account has an open session from the last 30 days get
  through, after a delay and up to a second budget of the same size; other
  networks receive 429 until the budget refills. The per-email-and-IP budget, which the per-IP budget always
  reached first, is gone.
- Signed file URLs are bound to the version that was signed (D113). After a
  file is replaced, or deleted and uploaded again under the same name, an
  earlier URL answers 404 instead of serving the new bytes. URLs signed before
  this upgrade name no version and stop working (403 `invalid_signature`);
  sign them again.
- An upload (`POST`) or replacement (`PUT`) to a name taken by a file the
  caller's policies hide answers exactly like a policy refusal (403, or 401
  for `anon`) instead of 409 `object_exists` or a distinct RLS message, which
  revealed that the hidden file exists. Callers who can see the file still get
  409.
- The migration backup agent serves up to 8 connections at once and drops a
  caller that has not presented the project capability within 1 second, so
  local users who can reach its socket can no longer stall a migration's
  backup. The capability is compared in constant time.

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
