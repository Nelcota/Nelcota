# Routine administration through the panel

## Goal and authority

After installation and explicit host enrollment, routine administration should
not require SSH. This is the full approved scope, not a promise that every stage
below is already available. Initial host trust, root credentials, enrollment
grants and emergency recovery remain outside the ordinary panel.

Project sessions must never acquire host authority. Host changes use the
separately authenticated controller and its enrolled project scope, typed plans,
confirmation, lease, private journal, verification and explicit recovery. A
configuration rollback restores configuration, never a database snapshot.

## Delivery and acceptance ledger

| Stage | Deliverable | Status |
| --- | --- | --- |
| 1 | Non-secret configuration catalog; batch auth/session, API/performance and global storage limits; saved/effective/source projection; conflict checks; localized review/apply UI | Source implemented; local unit/browser checks passed; Linux/Docker acceptance pending |
| 2 | Public API CORS allowlist, preserving separate panel same-origin checks | Source implemented; local unit/browser checks passed; Linux/Docker acceptance pending |
| 3 | Email subjects, templates, language, preview and link lifetimes with bounded private persistence | Pending |
| 4 | Application S3 settings and credential testing, durable disk/S3 migration with object/version reconciliation and recovery | Pending |
| 5 | Domain transitions with enrolled DNS scope, DNS/TLS preflight, proxy changes, OAuth/URL impact and recovery | Pending |
| 6 | Per-project backup policies, richer schedules, retention and verified offsite recovery | Pending |
| 7 | Visual PITR planning/execution with fencing, timeline validation and explicit database/file consistency limits | Pending |
| 8 | Administrator/operator MFA, enrollment/recovery codes, step-up authentication and finer access permissions | Pending |
| 9 | Safe credential rotation and overlapping signing-key rings, expiry, revocation and recovery | Pending |
| 10 | Persistent metrics/audit history, bounded retention, query/export and credential-free records | Pending |
| 11 | Guided indexes, views, functions and triggers using reviewed migrations, not arbitrary privileged HTTP commands | Pending |
| 12 | Native/systemd, application S3 and PITR controller adapters with runtime-specific verification/recovery | Pending |

Every stage needs backend behavior, authorization, persistence, UI, English and
Portuguese messages, contracts and regression coverage. Merely adding form
fields, toggles or removing an existing safety blocker does not complete it.

### Stage 1 acceptance

- One allowlisted catalog owns types, defaults, bounds, scope, sensitivity,
  dependencies and restart semantics for the newly editable routine settings.
- No raw `Config`, environment file, database URL, signing key or provider
  credential is serialized into a public configuration response.
- Validate the complete candidate without inheriting the controller process's
  environment, and without temporary environment-variable mutation.
- Prepare a bounded batch against the reviewed source revision. Unknown keys,
  wrong types, invalid combinations, stale source and no-op batches fail closed.
- Keep host/project identity checks, service grants, durable receipts and foreign
  edit detection during apply and rollback. Restart only the affected app once.
- Distinguish saved/default values from effective runtime values; report
  unavailable runtime information honestly. Do not equate a container's
  environment with a server loaded from an uninspected TOML file.
- Show source, pending differences, restart impact and host-operator authority.
  Browser values are not an authorization or validation boundary.
- Tests cover invalid combinations, injection, privilege escalation, secret
  projection, concurrency and interrupted application/rollback.

### Remaining stage acceptance

- CORS changes must exercise actual preflight and response headers; they must not
  loosen administrator CSRF protection or be described as API authorization.
- Email templates need intentional multiline encoding, bounded placeholders and
  header-injection protection; link tokens stay single-use and out of logs.
- Storage migration must preserve metadata, versions and signed-URL semantics;
  verify copied bytes before cutover and never delete the source automatically.
- Domain changes must preserve an independently reachable controller/recovery
  path, verify public TLS, and disclose external OAuth/DNS provider work.
- Backup/PITR UI must expose real host workflows, not pretend database WAL can
  restore external object history. Test interrupted recovery and fencing.
- MFA and permissions must be enforced on the backend, with revocable sessions,
  protected recovery and regression tests against bypasses.
- Key rotation must support old-token verification during an explicit overlap,
  protect private material and explain service-role token expiry/revocation.
- Observability must have bounded durable storage and redact secrets before
  persistence. Retention changes cannot delete unrelated operational receipts.
- Guided DDL must preserve production migration policy and database safety limits.
- Additional runtime adapters require their own disposable and real-host
  acceptance; Docker doubles do not establish systemd or public-provider support.

## Architecture constraints

The catalog belongs with core configuration, without introducing a dependency
from the runtime-independent deployment crate to HTTP or databases. Deployment
wire contracts remain explicit and browser-safe. Generated contracts/validators
must go through the established exporter.

Controlled restarts are the initial application mechanism. Selective hot reload
is optional later work, not a substitute for correctly applying saved values.
Host operator policy must remain enforced even when settings are visible from a
project panel. Unsupported environments stay blocked until adapters exist.

The initial catalog covers 17 fields, including CORS. Its private runtime
protocol has a schema and exact key/type checks. The application captures a safe
projection of its loaded Config at startup. A fixed, bounded, no-proxy loopback
probe reads it from within the container; the endpoint requires a real loopback
socket, the fixed probe Host, and absence of browser/forwarding headers.
Generated Caddy sites also refuse the private path. No raw Config or credential
is returned, including over this local protocol. A server that cannot provide
this evidence cannot accept a batch. Verification runs before preparation and
after apply/rollback. Effective values include derived defaults; changing the
pool also reviews its implicit effect on automatic per-caller concurrency.

## Recovery and validation evidence

Keep the CLI/SSH rescue path and private before/after journal available when the
application panel is down. Never overwrite a foreign edit during recovery.
Document the exact tests run below as implementation lands; a source build or
local mock is not production acceptance.

- Current branch: `feat/panel-configuration` (based on `6771e853`).
- No Docker/PostgreSQL, native/systemd, real VPS, DNS/TLS, S3 or PITR acceptance
  has been claimed for these changes.
- Full root JavaScript quality checks require the generated real SDK database
  fixture; do not fabricate a replacement schema to bypass that prerequisite.

### Local checks (2026-11-04, Windows x64)

Completed sequentially, without PostgreSQL integration fixtures:

| Check | Result |
| --- | --- |
| Core `settings::tests` | 5 passed |
| CLI `configuration::tests` | 8 passed |
| CLI `caddy::tests` | 3 passed |
| API `max_rows_caps_the_limit` | 1 passed |
| Server `cors::tests` / `settings::tests` | 4 / 1 passed |
| Admin `contracts::tests` / `updates::tests` | 6 / 5 passed |
| Admin embedded `assets::tests` after rebuilding the panel | 7 passed |
| UI contracts, project-settings model and host controller | 20 Vitest tests passed |
| `project-settings.spec.ts` and `server-operations.spec.ts` | 8 Chromium scenarios passed, one worker |
| Panel typecheck / guide translations | Passed, no Svelte errors or warnings |
| Clippy for core/API/deployment/CLI/admin/server, all targets | Passed with `-D warnings` on Windows |
| Scoped NelcotaRules lint for changed TS/Svelte, including typed Svelte mirror | Passed without diagnostics |
| Knip / source package size / capability boundaries | Passed; Knip retained existing configuration hints |
| Panel production build | Passed; reference startup 1,088,062 B gzip, below 1,100,000 B |
| `cargo build --locked -p nelcota-server` after panel rebuild | Passed; Windows debug binary embeds the rebuilt assets |

`bun run lint` remains blocked by the absent real CLI-generated
`sdk/typescript/test/contract/generated/database.ts`. The full Svelte mirror
command also exceeds the Windows argument limit; the same maintained compiler,
configuration and source-map checks were run on all five changed components.
Neither targeted check is reported as a passing full root quality run.

The Docker daemon was unreachable, including after the agent-server restart.
The Linux-only controller wiring and the extended real-host fault-injection
campaign have not been compiled/executed locally. PostgreSQL/CORS-panel
integration, actual restarts/rollback, systemd, real VPS, provider, TLS and PITR
acceptance remain pending. Do not deploy this branch on the strength of local
UI mocks or these unit checks alone.
