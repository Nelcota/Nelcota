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
| 1 | Non-secret configuration catalog; batch auth/session, API/performance and global storage limits; saved/effective/source projection; conflict checks; localized review/apply UI | Initial 17-setting slice merged in #253; all 44 checks passed at `30175418`, then main CI passed at `04bc36b0`; real-host acceptance pending |
| 2 | Public API CORS allowlist, preserving separate panel same-origin checks | Merged in #253 with complete CI, including owned Docker lifecycle/fault acceptance; real-host acceptance pending |
| 3 | Email subjects, templates, language, preview and link lifetimes with bounded private persistence | Source implemented; Windows/Linux unit and real-PostgreSQL checks, browser scenarios, owned Docker controller recovery and verified-STARTTLS panel delivery passed; complete feature CI pending |
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

- Initial implementation branch: `feat/panel-configuration` (based on `6771e853`),
  preserved in replacement PR [#253](https://github.com/Nelcota/Nelcota/pull/253)
  after the follow-up review of superseded PR #251.
- The initial Windows evidence below did not include Docker/PostgreSQL, S3,
  native/systemd, real VPS, DNS/TLS or PITR acceptance. Later remote evidence is
  recorded separately with its exact commit and run.
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

At this initial local checkpoint, `bun run lint` was blocked by the absent real
CLI-generated `sdk/typescript/test/contract/generated/database.ts`. The full Svelte mirror
command also exceeds the Windows argument limit; the same maintained compiler,
configuration and source-map checks were run on all five changed components.
Neither targeted check is reported as a passing full root quality run.

The Docker daemon was unreachable, including after the agent-server restart.
The Linux-only controller wiring and the extended owned-container fault-injection
campaign were not compiled/executed locally. PostgreSQL/CORS-panel integration
and actual restarts/rollback required remote validation at this checkpoint.
Systemd, real VPS, public-provider, TLS and PITR acceptance remain separate gates.
Do not deploy on the strength of local UI mocks or these unit checks alone.

### Follow-up PR review (2026-11-04)

The first remote CI run for PR #251 passed the Rust partitions, PostgreSQL/S3
integration, panel, SDKs and full Linux NelcotaRules checks, but **failed** the
Docker host-lifecycle campaign during preparation. That run is not a passing
acceptance result. A fresh `configuration-state` process had not installed the
pinned ring provider before constructing reqwest's `rustls-no-provider` client.
The fix initializes that provider without relying on another client in the same
process. A subprocess regression failed before the fix and passes afterwards.

Review also reproduced and corrected two boundary mismatches:

- The shared CORS contract permits 12 KiB, but literal environment persistence
  rejected values above 8 KiB. The source reader and writer now share the CORS
  limit; unrelated credentials retain their original limit. A 32-origin batch
  above 8 KiB roundtrips and remains editable; oversized literals still fail.
- The draft model preserves unchanged legacy integer settings outside the
  panel's tighter range, but native HTML constraints prevented submitting an
  unrelated edit. Input bounds now admit the existing saved value, while the
  model and backend still reject newly changed out-of-range values. A browser
  regression failed before the fix and passes afterwards.

Follow-up Windows checks: 10 CLI configuration tests, 3 environment-file tests, 20 scoped UI
unit tests, 9 Chromium scenarios (one worker), panel typecheck, scoped lint and CLI Clippy
with all targets and `-D warnings` passed. Docker remained unavailable locally;
the corrected real-container campaign required the successful remote run below.
These local results do not complete the remaining roadmap or real-provider/VPS gates.

### Corrected remote CI (2026-11-04)

PR #253 passed complete CI at
`ba1b61a14d5e7b5132d4dbe0dda3bc6974218792`, before integration of the remaining
dependency PRs. This is historical evidence for that commit, not validation of a
later synchronized branch or a production deployment.

| Run | Result and scope |
| --- | --- |
| [CI 41878236174](https://github.com/Nelcota/Nelcota/actions/runs/41878236174) | All jobs passed: owned Docker host-lifecycle/fault campaign, PostgreSQL/S3 integration, Rust partitions, panel/browser checks, SDKs, full Linux NelcotaRules, upgrades and supply-chain checks |
| [CodeQL 41878232116](https://github.com/Nelcota/Nelcota/actions/runs/41878232116) | All configured analyses passed |
| [Rust SDK 41878236282](https://github.com/Nelcota/Nelcota/actions/runs/41878236282) | Linux, Windows, macOS and MSRV checks passed |

The owned Docker campaign exercised the corrected fresh-process configuration
probe and controller apply/restart/rollback/recovery paths. Its DNS/provenance,
public TLS, proxy reload and unused PITR image-extension boundaries remain
explicit doubles, as documented in [host management](../host-management.md).
Disposable S3 integration is not acceptance of application-storage migration or
an operator's external provider.

At this historical checkpoint, the final integrated head still needed fresh
complete CI and stages 3–12 were pending. Native/systemd, real VPS, public
DNS/TLS, external-provider and PITR acceptance remained unexecuted. No release
or production deployment is established by these results.

### Dependency integration checkpoint (2026-11-04, Windows x64)

The review branch was synchronized with `main` at `f9f4942c`, after complete CI
and squash merges of #248, #249 and #252. The combined dependency set passed
10 CLI configuration tests, 3 environment-file tests, 20 scoped panel unit tests,
9 Chromium configuration/recovery scenarios, panel and script typechecks, Knip,
native lint and all 224 typed Svelte mirrors. The mirror invocations were batched
only to fit Windows command limits; the maintained compiler, configuration and
source mapping were unchanged. The real SDK contract artifact supplied the
previously missing local fixture.

This checkpoint also reproduced a Windows-only check-bootstrap defect: reading
the existing relative Next.js self-link returned backslashes and was rejected
as a foreign installation. Comparing its resolved target fixes repeated setup
without replacing foreign links or installed directories. All three filesystem
regressions passed on Windows. This local evidence does not replace fresh CI
for the synchronized head.

### Final configuration integration (2026-11-04)

PR [#253](https://github.com/Nelcota/Nelcota/pull/253) was squash-merged only
after all **44 individual checks** passed for
`3017541828d14506b958472fd320d2cb1f96e418`:

- [CI 41889264028](https://github.com/Nelcota/Nelcota/actions/runs/41889264028):
  complete Linux quality, owned Docker lifecycle/fault acceptance, PostgreSQL/S3,
  panel/browser, SDKs, packaging, upgrade and supply-chain jobs passed.
- [CodeQL 41889255258](https://github.com/Nelcota/Nelcota/actions/runs/41889255258),
  [Rust SDK 41889263711](https://github.com/Nelcota/Nelcota/actions/runs/41889263711)
  and [SSR SDK 41889263696](https://github.com/Nelcota/Nelcota/actions/runs/41889263696)
  passed. The macOS SDK job twice failed to acquire a hosted runner; the unchanged
  third attempt ran and passed. Cancelled jobs were not accepted as green.
- The resulting main commit `04bc36b02c14d18fc49f74acd80d318e2c098ae0` passed all
  43 post-merge checks, including
  [CI 41897488760](https://github.com/Nelcota/Nelcota/actions/runs/41897488760).

This validates the integrated configuration/CORS delivery, not stage 3's later
source changes, remaining roadmap stages or a production deployment.

### Email implementation checkpoint (2026-11-04, Windows x64)

The separate `feat/panel-email` work adds ten email fields to the catalog (27
total), English/Portuguese defaults, bounded single-pass plain-text templates,
explicit UTF-8/base64 persistence, fictional previews, fixed-administrator SMTP
tests and actual configured expiration for newly issued links. It preserves the
host/project authority split, write-only SMTP credentials and configuration-only
recovery. Existing `AuthSettings` and `AdminState` construction remains compatible.

Related checks ran sequentially against the final source:

| Check | Result |
| --- | --- |
| Core configuration / email / settings | 18 / 5 / 5 tests passed |
| Auth link rendering / mail delivery | 4 / 8 tests passed |
| CLI configuration | 12 tests passed, including escaped email/CORS request bounds |
| Real PostgreSQL email configuration | 4 scenarios passed, including valid service-role JWT denial, CSRF, fixed recipient, no issued test token, sanitized SMTP failure and all three configured-lifetime/single-use flows |
| Existing recovery / signup / magic-link PostgreSQL regressions | 5 / 7 / 4 passed |
| Admin contracts / email renderer / embedded assets | 6 / 1 / 7 passed |
| Settings/controller/response and guide/catalog Vitest | 77 passed across 7 related files |
| Email/settings/recovery Chromium | 12 passed, one worker, including narrow-screen inert previews and unsaved drafts |
| Native lint / all typed Svelte mirrors | No diagnostics; all 225 mirrors checked in Windows-sized batches using the maintained compiler/configuration |
| Formatting, script/rule/panel typechecks, Knip, package size, boundaries and documentation versions | Passed; Knip retains its 12 existing non-blocking configuration hints |
| Generated contracts and browser validators | Rust contract drift tests passed; regenerating browser validators was byte-for-byte unchanged |
| Panel production build / Windows server rebuild | Passed; reference startup remains 1,088,062 B gzip within the 1,100,000 B gate |

The real database scenarios used the shared disposable PostgreSQL 17 container
on port 55433; their leftover test databases were removed. Linux compilation,
the extended controller restart/rollback campaign and the production panel-send
path through verified STARTTLS remain separate checks at this checkpoint.
Complete feature CI is still required before integration. Real VPS/systemd,
public DNS/TLS, external-provider inbox delivery and PITR acceptance remain
unexecuted; stages 4–12 remain pending. No release or deployment was performed.

### Email Linux/Docker checkpoint (2026-11-04)

Linux amd64 validation used the pinned Rust 1.99.1 Bookworm image with four build
jobs, a four-CPU/eight-GiB container limit and low-priority sequential suites. A
Linux-owned volume provided real POSIX private-file semantics and isolated build
outputs; the Windows source tree and unrelated containers were not modified.

- Server build passed. Core email/settings (5/5), auth mail delivery (8), CLI
  configuration (12) and all four real-PostgreSQL email scenarios passed.
- `scripts/test-host-management.py` passed the complete owned-container lifecycle
  campaign (306 seconds). The added email batch exercised literal multiline
  persistence, actual runtime readback after apply/recovery, exact source recovery
  on rollback, one application restart and unchanged other-project configuration
  and acknowledged database writes in the baseline and five injected-fault runs.
- The campaign's DNS/provenance, public TLS, proxy reload and unused PITR image
  extension remain explicit doubles. This is Docker acceptance, not VPS/systemd
  or external-provider acceptance.

The first SMTP attempt failed before the new panel test: Docker Desktop did not
forward Mailpit's automatically published ports to the outer Linux container's
loopback. Independent probes verified STARTTLS/TLS 1.3 using the generated CA and
the expected certificate identity through the host gateway. Only the owned
fixture's TCP ports were transparently forwarded for the rerun; SMTP settings,
certificate/hostname verification and production source were not relaxed.
The rerun of `scripts/test-dev.py` passed: real signup delivery/confirmation and
restart persistence, then authenticated panel preview/test, fixed administrator
delivery, Unicode/multiline content, no added token rows and one-minute test
throttling. Its content assertion normalizes SMTP's RFC-mandated CRLF endings;
production rendering and delivery were unchanged. Linux Clippy for
core/auth/CLI/admin/server, all targets with `-D warnings`, also passed.

Complete fresh feature CI is the remaining merge gate. These local results do
not establish external-provider inbox delivery, real VPS/systemd, public DNS/TLS,
S3 migration or PITR acceptance. Stages 4–12 and production deployment remain
outside this delivery.
