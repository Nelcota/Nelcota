# Full-project audit — 25 October 2026

Status: in progress. This record distinguishes executed evidence from planned
coverage. It is not a production certification or a claim of exhaustive testing.

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
