# Full-project audit — 25 October 2026

Status: overnight execution interrupted by loss of the execution environment;
the corrections and completed evidence are prepared for review. Workspace access
returned at 11:05 UTC for the separately requested commit/push/PR handoff.
Production readiness is **not verified**. Historical checkpoints below retain
their original scope; the final-state section supersedes their pending statuses.

## Scope and operating limits

- Baseline: `bb63800727eec2c577c32118566619481e9f88d9` (current public main at start).
- Branch: `audit/full-project-20261025`.
- Started: 24 October 2026, 22:43 America/Sao_Paulo (25 October 01:43 UTC).
- Deadline: 25 October 2026, 07:10 America/Sao_Paulo (10:10 UTC).
- Stop new long tests at 09:55 UTC, retaining time for evidence and reporting.
- Disposable local databases, files, containers and providers only. No production
  access, deployment, merges, releases, package publication or credential changes.
- Four Cargo jobs, two Rust test threads; Rust, Vitest and audits run sequentially.
- Automatic runner stops at less than 1 GiB free workspace disk, less than
  512 MiB available host RAM, command timeout or the final validation cutoff.
- Preserve released migrations, documented contracts, security checks and budgets.
- Review the current main, not abandoned/unmerged local worktrees. PR #170 remains
  a separate dependency candidate; its changes are not silently included.

## Inventory

The modular monolith contains nine product Rust crates (core, auth, API,
storage, webhooks, admin, deployment, CLI, server) plus the Rust client: ten
workspace members. It also contains the TypeScript client,
the Next.js integration and the embedded Svelte panel. The separately fetched
NelcotaWebsite is an additional documentation/landing application.

Runtime: PostgreSQL 17, grants and RLS, Axum/Tokio, rotating refresh tokens,
EdDSA/HS256 JWTs, Argon2id, disk/object-store storage, SMTP, OAuth/OIDC, webhooks,
Caddy, Docker or native systemd and an isolated host update controller/worker.
Frontend: Svelte, Vite, Tailwind, generated Rust wire contracts and JSON Schema
validators. SDK tooling uses Node/TypeScript/Vitest and Next/React; backend
production does not require Node. Migrations V1–V16 exist in both internal trees.

Machine-generated source hashes, route declarations, migration paths, test files
and TODO/FIXME inventory are saved privately in
`/workspace/artifacts/full-audit-20261025/inventory.json`. A route declaration is
an inventory entry, not proof that its authorization or behavior was tested.

## Initial coverage matrix

All results below start as **not run**. Execution results and concrete findings
will be appended with the command, artifact and source identity.

| Capability | Required scenarios | Evidence planned | Initial status |
| --- | --- | --- | --- |
| Core/config/bootstrap | Invalid configuration, migration parity, grants, RLS, pool cleanup | Rust unit/integration, migration hashes | Not run |
| Authentication | Signup, password, email, renewal, revocation, malformed/expired credentials | Auth/server suites, real SMTP contracts | Not run |
| Admin/session/SSO | CSRF/origin, roles, persistence, single-use handoff, isolation | Admin/server/browser tests | Not run |
| REST/query/RPC | CRUD, filters, ranges, embeds, reserved fields, constraints, SQL injection | Server suites and real SDK contracts | Not run |
| Storage/disk | RLS, traversal, limits, interrupted writes, listing, ranges, integrity | Server suites, API journeys | Not run |
| Storage/S3 | Redirect/range/credentials, multipart failure | Disposable S3-compatible provider | Not run |
| Webhooks | Destination policy, signing, leases, retries, queue cleanup | Rust real-service suites | Not run |
| SQL/export | Connection ownership, cancellation, timeouts, partial results | Dedicated cancellation suite | Not run |
| CLI/native/host | Preflight, fencing, update recovery, backups, restore, management | Unit tests, owned Docker acceptance | Not run |
| Panel pages/forms | Load/error/empty, navigation, mutations, races, accessibility, viewports | Vitest, browser tests, real backend probe | Not run |
| TypeScript SDK | Values/types, lifecycle, cancellation, streams, package exports, bundle size | Unit/type/runtime/memory/contract checks | Not run |
| Rust SDK | Transport, authentication, package/API contracts | Cargo tests, doctests, backend contracts | Not run |
| Next.js SDK | Request isolation, cookie ownership, CSRF, session contention, redirect boundaries | Unit/PG/production framework/backend probes | Not run |
| Dependencies/build | Lockfile installs, audits, fmt/clippy/lints, assets/contracts drift | Native and npm checks, production builds | Not run |
| Capacity/recovery | Measurable baseline, bounded concurrency, faults, resource retention | Isolated benchmark and regressions | Not run |
| Website/docs | Build, links, versions, examples | Website checks and doc validators | Not run |
| Production-only gates | Public DNS/ACME, VPS firewall/boot, off-host restore, power loss, ARM64 | Dedicated external staging required | Blocked (environment) |

## Decisions

1. Use one clean branch with a serial evidence runner: prevents mixing old local
   work or overlapping high-resource test families.
2. Start with the complete requested Rust baseline while installing JavaScript
   tooling; installation is not a concurrent Vitest or audit run.
3. Treat a local S3-compatible service as provider evidence only, not validation
   of a real remote cloud account or off-host disaster recovery.
4. Keep detailed diagnostics private until reviewed for credentials or sensitive
   findings; committed records contain only sanitized summaries.

## Checkpoint — initial baseline and reproduced defects

The main baseline has 30 successful hosted checks at the start of this audit.
That is baseline evidence, not CI evidence for this branch. The full local Rust
workspace baseline completed in 460 seconds: **725 passed, 0 failed, 6 ignored**.
The ignored provider/fixture cases require separate explicit execution.

Local baseline checks: native Oxlint base/imports, architecture boundaries,
document versions, 57 Python cases (4 additional skipped) and clean lockfile
installs passed. Website Node 26 unit tests passed (49), typecheck reported
zero errors/warnings across 127 files and its production build emitted 127 pages.
The website build used its documented cached GitHub snapshot when native fetch
could not reach GitHub; that does not establish live integration availability.

| ID | Priority | Reproduced result before correction | Correction and verification |
| --- | --- | --- | --- |
| A01 | P1 | A controlled real-Postgres COMMIT acknowledgement cut left published metadata without its bytes; 1 regression failed, conflict control passed | Distinguish rejected publication from uncertain COMMIT; retain immutable bytes for authoritative reconciliation. Initial focused rerun: 2 passed; replacement/collector coverage being expanded. |
| A02 | P2 | Row inserts/edits/explicit NULL dropped an own `__proto__` key; browser regression also identified Svelte snapshot loss | Build own-key payloads with Map/fromEntries and capture the fresh primitive record without Svelte snapshot. Browser rerun passed; final reactivity check pending. |
| A03 | P2 | Custom PostgreSQL types named `constructor` or `__proto__` read inherited aliases and failed rendering | Restrict aliases to own keys. Focused unit and browser checks passed. |
| A04 | P2 | Early years mapped to 1901/1999; malformed or BC values were reformatted incorrectly | Set full calendar years explicitly and retain unrecognized/overflow values. The original 10 failing panel boundary cases now pass (41 total). |
| A05 | P2 | 1,040 characters of nested JSON expanded to 526,352 formatted characters | Cap visual indentation to 32 levels, preserving every token. Original failing bounded-expansion test now passes; all 5 formatter tests pass. |

Panel baseline: 431 unit cases passed, one GC-dependent case skipped by the
ordinary run; all seven explicit memory cases passed. 158 Chromium UI cases
passed using controlled API fixtures, not a real database. They include phone,
desktop, both themes, translations, keyboard/focus, measured text contrast,
partial failures, cancellation, history and operation ownership. A new identifier
flow is retained as a permanent browser regression.

TypeScript SDK: 374 unit + 20 type cases passed, package/build/runtime and memory
checks passed. Unchanged bundle gates passed: root 18,885/18,900, REST
9,878/9,900, auth 12,680/12,700 and storage 7,896/7,950 bytes gzip.
These tight margins remain unchanged; no threshold was raised.

The Playwright browser download failed with HTTP 403 (domain policy).
System Chromium remains usable; Firefox/WebKit installation is blocked.
Two temporary check failures introduced by the new test code (a TypeScript
`constructor` property type and an e2e alias import) were recorded and corrected;
their final check is required before completion.


## Checkpoint — full regression and real application journeys

The full workspace after the storage, query and session corrections passed
**731 cases, 0 failed, 6 ignored**. The explicit Next PKCE provider control also
passed. Ignored cases are tracked separately; the SSO child helper is executed
by its passing parent and is not a standalone fixture.

| ID | Priority | Before | After / evidence |
| --- | --- | --- | --- |
| A01 | P1 | A real COMMIT response cut left committed metadata without bytes | All 3 focused cases passed, including replacement, collection and known-conflict cleanup (`storage-commit-expanded.log`). |
| A06 | P2 | Reserved column filters became REST control parameters, producing unfiltered results or HTTP 400 | Literal catalog-validated filter construction; 39 filtered listing/export/RLS paths passed. |
| A07 | P2 | Comma/dot-bearing order and primary-key names were parsed as query grammar | Literal catalog-validated order terms; 13 sort paths plus default primary-key ordering passed. A06/A07 share 2 integration tests. |
| A08 | P2 | Controlled refresh retry/successor contention caused a measured PostgreSQL deadlock and HTTP 503 | Acquire the session row before token rows, with a fresh subsequent statement snapshot. All 4 controlled interleavings passed; database deadlock count stayed zero. Performance cost remains to be measured. |
| A09 | P2 | A read-only, vertically overflowing migrations page could not be reached by Tab | Make the page scroll target sequentially focusable with a visible inset outline. The same keyboard traversal and ArrowDown regression passed. |

The embedded production panel on a real backend/PostgreSQL passed login refusal,
login, Unicode insert/edit, literal filters/order, reload, export and exact
file upload/download persistence. An automated axe matrix covered 66 route,
viewport and theme combinations. With theme transitions allowed to finish,
its only remaining violations were four read-only scrolling cases (A09); the
new embedded assets must be rechecked. The initial contrast failures occurred
while sampling color transitions and were not recorded as product defects.
A separate harness fix waits for upload completion before asserting metadata.

Panel static analysis reports one explicit Svelte warning for the intentional
nonnegative tabindex of a scroll target. It is not suppressed and no lint gate
is disabled. Existing SQL results use the same keyboard behavior. Automated
WCAG, visible-focus and actual scrolling evidence determine the functional
result; the warning remains visible for review.

SDK real-service contracts passed **34 cases** with local PostgreSQL, mandatory
STARTTLS and a disposable CA; browser checks exercised signup, CRUD, files,
logout, 100 two-tab refresh rounds and PKCE. The SMTP contract server uses the
existing test-only native-CA example, not a claim about release-binary trust
roots. The Next production framework test passed with two processes and a
shared session store, while its separate real-backend probe verified RLS, CSRF,
credential separation, rejection paths and SQL integrity. Its 120-second
contention run completed 28,981 operations, no errors or retained advisory
locks, four maximum connections and 4,034,560 bytes RSS growth after warmup.
These are shared-host measurements, not VPS capacity claims.

The website's production Chromium suite passed **129 cases**, with seven
device-specific cases deliberately inapplicable. Astro auto-backgrounding in
agent environments required a foreground `--ignore-lock` invocation in the
private runner; no website application source or check was changed.

Disk reserve management removes regenerable build caches only. Source, Git
history, private handoffs, databases and backup evidence are preserved. An
initial Docker cache command could not write its default read-only home
configuration; the retry uses a workspace Docker configuration.


Provider/host checkpoint: the explicit S3 tests passed (2), as did Next S3
redirect/range/credential checks (8 groups), the root ownership fence control
(1) and the owned Docker host lifecycle control (1). The final embedded-panel
recheck passed all 66 axe combinations, zero horizontal page overflows and
zero unhandled exceptions. Two expected console HTTP 401 entries belong to
the deliberate negative login probe. The native fixture was removed.

The first optimized candidate build exposed a shared-target cache collision
with the control worktree (old query library selected, new helper absent).
All product-package release artifacts are explicitly cleaned before the final
optimized build; unchanged external dependencies may remain cached. The
control binary was built from an initially empty release target and retained
separately. No application source is changed to accommodate a build-cache error.
The Docker cache cleanup reclaimed 2.402 GB without removing images, volumes,
source or evidence. S3 harness preparation failures (tmpfs permissions and an
unready provider) are retained as fixture failures, not successful tests.


## Checkpoint — final candidate and bounded campaigns, 07:00 UTC

The final campaign candidate is source `c8e100f497abd0ed4f42a75025fe1c615773aa91`,
optimized native GNU ELF SHA-256
`f8d5303aca9236caebb97db5ac46de763dde622a995af5a7d49bd926ffef9fc0`.
It is a development build, not a published/attested release or a musl image.
The complete requested Rust workspace passed **736 cases, zero failures, seven
ordinary ignores**. Provider/privileged/child-helper fixtures are accounted for
separately. After that run only panel code/embedded assets changed: all Rust
sources are identical. The affected 19 browser cases passed, including the
new accessible-name regression; panel types reported zero errors and the one
explicitly recorded main-scroll focus warning. The final real-backend panel
matrix passed 120 route/viewport/saved-theme observations, zero automated WCAG
violations and zero unhandled page exceptions. Thirteen contrast observations
remain incomplete and require manual inspection; this is not full WCAG approval.

Additional confirmed defects:

| ID | Priority | Before | Correction and verified evidence |
| --- | --- | --- | --- |
| A10 | P0, conditional on independent databases sharing an unpartitioned physical store | A real 60-second collector tick deleted another owned database's referenced file; its metadata remained and authorized download became 404 | Persistent database ownership, conditional store claim and durable quarantine preserve ambiguous files. Five focused disk cases plus real local S3 controls pass; exact bytes survive the collector interval and process restart, with unauthorized users rejected. No migration or key namespace rewrite. |
| A11 | P2 | A real scratch build admitted ten private/generated synthetic paths | Docker context regression now excludes all 14 private/generated fixture paths while retaining all 12 required source/asset cases. No real secret entered the probe. |
| A12 | P2 | The new browser regression failed; named scrollable pre elements produced 24 unsupported-ARIA observations | Supported group semantics preserve keyboard focus and accessible names; 19 affected browser cases and the final 120-view matrix pass, with no prohibited-ARIA findings. |

The final frozen ELF passed native acceptance including the real Notes browser
journey **twice**, and 34 SDK real-API/email/Next contract cases. The separate
fault-under-load probe passed four single faults (database pause, terminated
connections, database restart, application process cut): **688 acknowledged,
688 persisted**, no cross-user visibility, idle transactions or pending locks at
drain. PostgreSQL fsync, synchronous_commit and full_page_writes were on. These
are process/container faults, not VM reboot or power-loss verification.

The separately audited website now applies pnpm 12 policies from its workspace
file: 13 dependency advisories (six high) became zero without replacing the
original Lighthouse audit engine or weakening any gate. Frozen install, peers,
lint, types, docs parity, build and byte budgets pass; 49 units, 129 Chromium
cases and 15 Lighthouse reports pass. All category scores are 1, maximum FCP
1,228.86 ms, LCP 1,653.54 ms, TBT 0 and CLS 0. Existing DOM-size warnings remain.
An owned read-only Caddy container also passed static routes/headers/cache/404
checks. Its build mounted the managed environment's CA as a temporary BuildKit
secret; TLS verification stayed enabled and that CA was not copied to the image.

A completed earlier 664-iteration/s disk hour **failed** at the documented
100,000 retained webhook-delivery ceiling (28,583 retryable HTTP 503s). The
failed run remains evidence. No queue limit, retention, SLO or assertion was
changed. At this checkpoint, a separate final-artifact 400-iteration/s one-hour
disk profile was running, to be followed by matched S3 control and a one-hour
local real-S3 profile. Their final recorded states are listed below.
That additional capacity envelope cannot turn the failed nominal profile into
a pass. The initial refresh throughput regression was also retained and fixed
through prepared-plan reuse; its seven-scenario comparison subsequently passed.

Resource reserve guards interrupted one workspace retry and the first website
container build before the disk filled. Only older duplicate/generated test
executables and exact unshared cache IDs created by this audit were removed;
sources, frozen binaries, evidence, other images/volumes and old worktrees were
preserved. Sequential retries passed. Private probe corrections (an expected
storage 404, reacquiring a session after restart, partial JSONL reads) are in the
harness ledger; they did not change product code or acceptance thresholds.

Environment limits remain explicit: no fresh VM/systemd boot, real power loss,
public DNS/ACME/TLS, off-host restore, real WAL/PITR with pgBackRest/remote S3,
ARM64, separate load generator, ten-project host topology or 24-hour rehearsal.
Firefox/WebKit downloads were blocked by HTTP 403. No production resource or
remote credential was used. The website's hosted docs-sync PR step is still
failing; detailed logs/permissions were blocked and its root cause is not
established. No settings or credentials were changed to work around it.

## Final recorded results and environment interruption

The frozen artifact above completed the independent **3,600-second disk profile
at 400 iterations/s**: 1,439,939 HTTP requests, zero HTTP failures, zero failed
checks, 65 dropped iterations and HTTP p95 20.9319441 ms. Final invariants verified
129 exact-byte objects, no outstanding queue entries, no idle transactions,
no waiting locks and no signature errors. The guard completed successfully and
reported no remaining owned campaign containers. A subsequent observation found
24 descriptors, 17 socket descriptors, approximately 45 MiB RSS and no CLOSE_WAIT
sockets. These finite measurements do not prove absence of all resource leaks.

All seven matched disk comparisons and all seven matched local S3 comparisons
passed the unchanged p95/throughput gates with no fixture differences. The S3
control campaign completed, including 129 exact-byte objects and drained queue,
transactions and locks. Final S3 storage p95 was 8.9% above control, within the
existing 10% gate; refresh throughput was approximately 1.44 times control on
disk and 1.41 times control on S3. These are local shared-host measurements.

The final S3 endurance attempt is **blocked/interrupted, not passed**. Its
resource series ends around 09:01 UTC and contains neither a final `soak.json`
nor final guard/integrity results. The execution transport stopped responding;
subsequent shell calls returned `No usable execution environment is available`.
Recovery attempts through 09:55 UTC did not restore access. The elapsed wall
clock is not evidence of a completed continuous hour. On workspace recovery at
11:05 UTC, the binary hash and both source branches were intact; Docker reported
no running containers. The interrupted campaign's stopped app, PostgreSQL and
S3 containers still existed, so their cleanup must not be reported as completed.
No VM reboot or power-loss result is inferred from this infrastructure event.

| Capability / final checkpoint | Verdict | Evidence and remaining scope |
| --- | --- | --- |
| Rust workspace, auth/admin/query/storage/CLI regressions | Passed for executed cases | 736 passed, zero failed, seven ordinary ignores; final Rust sources unchanged after that run |
| Panel unit/browser and real persistence | Passed for executed cases | 434 distinct unit cases including explicit GC; 162 distinct browser cases across complete/focused runs; 120 final real-backend observations |
| SDKs and native acceptance | Passed for executed cases | TS 374 units + 20 types; Next 122; Rust included in workspace; 34 real-service contracts; seven native/browser groups repeated twice on one ELF |
| Fault recovery | Passed for executed process/container faults | Four individual faults; 688 acknowledged records, 688 persisted; VM/power-loss excluded |
| Disk, 400/s continuous hour | Passed | 3,600 seconds, exact-byte integrity and drain verified |
| Disk, original 664/s continuous hour | Failed | 28,583 HTTP 503s at the documented 100,000 retained-history ceiling; no limit or assertion changed |
| Local S3 control and matched steady workloads | Passed | Control integrity/drain and all seven steady comparisons completed |
| Final local S3 continuous hour | Blocked / interrupted | No complete hour summary, final invariants or guard result |
| Final provider/upgrade/host-management repeats | Not run | Earlier provider/upgrade/host results retain their original candidate identity; final repeats were prevented by environment loss |
| Website | Passed local checks | 49 units, 129 browser cases, 15 Lighthouse reports, production static build/container; hosted docs-sync failure remains open |
| Deployment profiles and accessibility manual review | Blocked / not run | The environment gates listed above, screen readers and 13 incomplete contrast observations remain explicit |
| Hosted CI for these new branches | Pending publication/checks | The 30 green baseline checks do not certify the candidate |

The conservative distinct-case census totals **2,127 passed**: Rust 736, panel
units 434, TS units 374, TS types 20, Next 122, Python 61, panel Chromium 162,
website units 49, website Chromium 129, six explicitly exercised ordinary-ignored
Rust cases and 34 real-service SDK cases. Repeated runtimes/subsets are not added
again. Native groups, screen observations, Lighthouse reports and load requests
are separate evidence. This is a consolidation of latest available case results,
not a claim that all cases ran once on one exact composite SHA. Final provider,
upgrade and host-management repetitions remain unexecuted. Line coverage was not
measured. The ledger preserves 55 nonzero attempts, including red regressions,
tool/fixture failures, reserve interruptions and the failed capacity campaign.

The original audit report was delivered with the interrupted state. The later
handoff preserves the existing code commits and commits only the remaining
changelog/audit documentation; it does not restart the campaigns, certify the
unrun cells, change budgets or operate production. Detailed logs, fixture files,
keys and raw browser traces remain outside Git. A private allowlisted archive
preserves the available evidence and source bundles separately from the PRs.
