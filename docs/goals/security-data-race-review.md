# G08: Security, data exposure and concurrency review

Status: first execution incomplete; no security approval. The original scope
and acceptance criteria below remain unchanged for a separately authorized run. Record actual work in
[the execution record](security-data-race-review-execution.md).

## Objective and scope

Review the Rust server, PostgreSQL authorization, panel, both SDKs, CLI,
storage, webhooks, installation, backups, recovery, controlled updates and
operational alerts. Identify unintended data disclosure, authorization gaps,
race conditions, unsafe failure paths and applicable OWASP weaknesses. Reproduce
confirmed defects, make bounded corrections and revalidate the affected paths.
Preserve the single native backend and PostgreSQL GRANT/RLS ownership model.

Use three complementary passes. Scanner results supplement code review and
runtime evidence; an empty scanner report is not proof of security. Completion
of this goal is distinct from approving a release or accepting a production VPS.

## Autonomous execution and boundaries

When instructed to execute G08, proceed without routine questions. Record each
material decision, its evidence and reason. If a step needs unavailable access
or a change outside this authority, record the blocker and continue independent
work. Do not silently substitute weaker checks.

- Use owned, disposable fixtures containing synthetic accounts and data only.
  Do not connect to, scan or change the production VPS, its domain, real
  databases, customer accounts, backups or external notification providers.
  Historical SSH credentials in conversation are not audit fixture credentials.
- Do not merge, deploy, publish packages, push/delete tags, create releases,
  run release workflows, change repository settings or weaken protection rules.
  Do not modify other open PRs or delete their branches.
- Preserve documented HTTP/SDK/Rust APIs, configuration and CLI contracts.
  Do not edit released migrations/checksums. A fix requiring a contract change,
  new migration/dependency or changed trust boundary is a documented follow-up
  for the maintainer; do not improvise it during this unattended pass.
- No cosmetic rewrites, broad SOLID refactors, dependency churn or new general
  stress harness. Do not lower lints, bundle budgets, timeouts, security checks,
  Argon2 parameters, approval requirements or existing acceptance thresholds.
- Follow [AGENTS.md](../../AGENTS.md) and
  [CONTRIBUTING.md](../../CONTRIBUTING.md): four Cargo jobs, two Rust test
  threads, at most two UI workers; Rust, Vitest and audit runs are sequential.
  Use the shared disposable test PostgreSQL as documented. Never fall back to
  per-test databases/containers to bypass an unavailable shared fixture.
- Do not install external audit skills or send source, payloads, secrets or
  private findings to third-party scanners. Use existing local tooling first.
  Do not send email/webhooks or contact third parties during this audit.

## Phase 0: Artifact, environment and threat model

1. Read AGENTS/CONTRIBUTING, [SECURITY.md](../../SECURITY.md),
   [the security model](../security/README.md),
   [architecture](../architecture.md), [decisions](../decisions.md), G06's
   [final record](auth-security-review-execution.md), the G05 archive and the
   current installation, update, backup and SDK guides.
2. Inventory the worktree before changing it. Fetch current main when access
   permits, record its full SHA, published versions, tools and platform. Create
   an isolated audit branch/worktree; never reset or overwrite unrelated work.
   If current remote state cannot be verified, label the cached baseline.
3. Inventory open PRs separately. Planning identified operational-alert PR #125
   at 6d2d3b776a9e0ad2330e15f725694a7e5cc7aec7. Verify its current status at
   execution time. If unmerged, review/test that candidate in a separate
   worktree, record its SHA, and label every candidate result; do not claim the
   candidate is in main or the published release, or merge it for convenience.
4. Diagram entry points and flows for passwords, sessions, JWTs, service-role
   tokens, SSO, SMTP/OAuth credentials, signed URLs, SQL results, files, backup
   configuration, controller authority and outbound events. Name the owners,
   trust boundary and intended recipient for each.
5. Treat the documented privileged capabilities as the baseline: project admin
   SQL, service-role RLS bypass and host-root control are intentional. Test
   whether unauthorized callers obtain them. Respect documented access-JWT
   lifetime/revocation semantics and the accepted F07 trade-off; do not label a
   known contract as a newly discovered defect.
6. Pin the OWASP ASVS, Web Top 10 and API Security Top 10 versions used, with
   official references and access date. Map applicable controls to the matrix
   below. Target applicable ASVS Level 2 controls, with explicit additional
   checks for privileged host/recovery paths; do not claim ASVS certification.
   If references are inaccessible, record the limitation instead of inventing
   requirement identifiers or asserting a version is current.

The reviewed baseline is immutable evidence. Fix commits produce new artifacts;
record the SHA for each result and the final source/binary identities. Earlier
green CI and G05/G06 results are historical context, not current acceptance.

## Coverage matrix

For every cell record entry points/files, invariant, applicable OWASP controls,
method, exact artifact, result and evidence location. Include positive controls
and denied probes; a refusal caused by a broken fixture does not prove isolation.

| Cell | Surface | Required boundary checks |
| --- | --- | --- |
| C01 | Identity and sessions | Signature/algorithm/role/expiry validation; malformed credentials; three password-replacement paths; refresh rotation and grace; logout/recovery/confirmation/magic-link single use; durable panel SSO; enumeration and existing quota trade-offs. |
| C02 | RLS, GRANTs and project isolation | Anonymous/user A/user B/service role, two projects, pooled connections and transaction rollback; WITH CHECK as well as USING; joins/RPC/views/SECURITY DEFINER; internal catalogs never become ordinary REST resources. |
| C03 | SQL and other injection | Bound values and quoted identifiers in REST/RPC, DDL, filters, exports and generated queries; header/CRLF and shell/argument injection in privileged adapters. Distinguish authorized admin SQL from unauthorized injection. |
| C04 | Panel/browser security | Stored/reflected/DOM XSS, Markdown and API documentation rendering, URL schemes, CSRF/origin/cookie/CORS/CSP/frame/cache behavior, separate operator/project sessions and stale responses after account/project navigation. |
| C05 | Data and credential exposure | Responses/errors, SQL diagnostics, logs/traces/metrics, health/debug output, browser storage/URLs/referrers, SDK exceptions, generated assets and packaging. Private rows, credentials, signed URLs and recovery files must reach only their intended audience. |
| C06 | Storage on disk/S3 | Authorization before bytes, path traversal and encoding, symlinks, upload/overwrite/delete/list races, signed URL scope/expiry/content headers, multipart cancellation and unpublished-version cleanup. Test each available backend separately. |
| C07 | Outbound network trust | SSRF, redirect and DNS changes for webhooks/alerts/OAuth/backup transports; IPv4/IPv6, mapped/shared/private/link-local addresses, URL credentials, approved names, proxy/CA handling. Use controlled DNS and local synthetic endpoints; never probe real metadata/private services. |
| C08 | Webhooks and side effects | Signature/body/timestamp validation, queue leases and ownership, retry deduplication, retention, duplicate/out-of-order delivery, cancellation and no event publication for rolled-back writes. Preserve documented at-least-once guarantees. |
| C09 | Host/operator authority | Enrollment, Unix-socket ownership/peer identity, least privilege, policy changes, password reauthentication, plan expiry/review, affected-project scope, durable receipts, stale approvals, retries and recovery without arbitrary command execution. |
| C10 | Updates/install/runtime | Release identity/checksum/provenance/readiness, immutable artifact selection, interrupted updates and rollback, secret file ownership, Docker/systemd startup, private database/listener/firewall/TLS assumptions. Code/fixture evidence does not replace real boot or public TLS acceptance. |
| C11 | Backup, restore and PITR | Paired data/files/configuration, encrypted offsite secrets, genuine success receipts, retention after failed copies, supported target-directory validation, durable restore fence, explicit recovery and all applicable native/Docker start paths. Foreign/symlinked fence state must fail closed; interrupted recovery must remain safely rerunnable. Never restore real data for this review. |
| C12 | Async/resource ownership | Timeouts, cancellation, shutdown and task ownership; connections/transactions/locks, timers/listeners, queues/buffers, temporary files, multipart sessions, descriptors/sockets, child-process cleanup and unsafe/FFI assumptions where present. Check before/during/after, not just peak RSS. |
| C13 | Concurrent account operations | Deterministically interleave refresh, password replacement, logout, single-use links and SSO redemption across tasks/instances; prove atomic authorization decisions and their durable effect. See the race protocol below. |
| C14 | Concurrent control/data operations | Competing host plans/jobs, crash after durable steps, config changes during probes, storage metadata versus bytes, webhook worker lease expiry, duplicate browser submissions and project deletion/recreation. Check identities and stale ownership. |
| C15 | TypeScript and Rust SDKs | Shared-client/session isolation, concurrent refresh/close/abort, retry semantics, auth headers and redirects, browser/server credential boundaries, nullable/empty/non-finite data, error redaction and response/body bounds. Run affected package/type/size contracts. |
| C16 | Operational alerts | Operator-only authority, secret-free status/storage/logs, SMTP TLS and pinned project identity, outbound grants, incident confirmation/recovery, unknown probes, bounded persistent retries, backoff/restart, backup receipt integrity and heartbeat suspension on observer failure. Label unreleased candidates. |
| C17 | Input/resource abuse | Nulls, empties, malformed UTF-8/JSON, unsafe deserialization/prototype pollution, numbers/NaN/infinity/overflow, excessive nesting/length/page sizes, streamed bodies and slow clients, decompression or expensive parsing/hash work. Measure bounded refusals with a successful legitimate control. |
| C18 | Cryptography and secrets | Existing RNG/key/token/hash/constant-time primitives, TLS verification, encryption and secret ownership/redaction, example keys versus actual shipped credentials; inspect reachable usage before classifying scanner hits. No live secret rotation. |
| C19 | Dependencies/build/release | Cargo/npm lock and policy audits, CodeQL when authorized/available, packaged content, CI token permissions, untrusted PR inputs, shell interpolation and provenance verification. Read workflows; do not publish or weaken them. |
| C20 | Failure handling and observability | Fail-closed authorization/recovery, unknown versus healthy state, no successful acknowledgement for failed/incomplete effects, no blind retry after uncertain writes, bounded logs/alerts and actionable diagnosis without disclosing secrets. |

## Pass 1: Trust boundaries and exposure

Review all cells, following untrusted input to the privileged action and the
response back to its recipient. Use synthetic per-user/project secret canaries
to detect leakage in responses, logs, artifacts and browser state. Store only
redacted public summaries. Establish positive controls and record existing
regressions before introducing fixes; recent reviewed code remains in scope,
but is not a justification for a structural rewrite.

## Pass 2: Races, interruptions and resources

Use deterministic barriers, latches or fault hooks at an actual state boundary;
avoid sleep-only races. A hook must be test-only, never an operational backdoor.
For each applicable scenario record the interleaving and assert the documented
winner/loser outcome, persisted rows/files and authorization after completion:

- Same refresh/link/SSO credential consumed concurrently; refresh against
  password replacement/logout; late result after SDK close/session change.
- Two users/projects sharing a pool while one request cancels or rolls back;
  follow the denied probe with an authorized read of its own canary.
- Same object uploaded/overwritten/deleted while listing/downloading; metadata
  commit failure, interrupted multipart and retry after an uncertain response.
- Webhook lease expiry versus late completion/retry; events from rolled-back
  business transactions; duplicate delivery without duplicate business action.
- Host plan/start/recover/configure competition, stale policy/identity, backup
  versus retention, project removal/recreation, and fence checks versus startup.
- Alert scan versus configuration change, slow/cancelled probes, durable send
  reservation versus process exit, backward clocks and duplicate transport replies.
- Component unmount, navigation, abort, stream drop and service shutdown while
  connections, background tasks, timers or temporary resources are owned.

Where feasible, execute 20 controlled interleavings per race with recorded seeds
and a bounded 100-operation resource loop. Do not substitute probabilistic stress
for a decisive invariant assertion. Record completed repetitions/counts; fewer
runs or missing instrumentation are limitations. A process restart is not a
machine reboot. Native boot, Docker daemon restart, ARM64, real S3/off-host restore
and public DNS/ACME/TLS each require their actual disposable environment; mark
unavailable cells blocked without substituting a mock and calling it passed.

## Pass 3: Correct, reassess and converge

For each confirmed defect, retain a focused reproducer that fails on the old
implementation for the expected invariant, then passes unchanged after the fix.
Compilation/setup failures do not prove a defect. Patch the owning module with
the smallest compatible change, inspect sibling callers/backends and rerun the
affected scenarios. Test intended success and failure cleanup as well as denial.
Record negative findings and disproved hypotheses without counting them as fixes.

Review the final diff again from the caller's perspective, especially error
translation, async cancellation, post-COMMIT replies and durable ownership. New
findings go into the same ledger; do not endlessly restart every pass. Revalidate
affected cells on the final artifact and close with explicit remaining work.

## Private evidence and finding handling

Follow SECURITY.md. Create a mode-0700 ignored directory under
target/g08-security-review/RUN_ID before writing raw diagnostics; verify ignore
rules and keep sensitive files/patches/bundles mode 0600. Do not print credentials
or dump process environments. Use synthetic canaries; redact payloads and URLs.

The private ledger records finding ID, hypothesis/confirmed state, severity and
reasoning (CVSS only when justified), attacker prerequisites, affected versions,
boundary, minimal reproduction, expected/actual outcome, root cause, fix commit,
old/new test results, residual risk and private evidence SHA-256/location.
Scanner warnings alone are not confirmed findings.

Do not put unpublished potentially exploitable findings, their code/tests,
payloads or identifying descriptions into public commits, PRs, issues, comments,
CI artifacts or logs. Neutral names do not make revealing code private. Keep
such fixes locally; package a private patch/bundle and checksum for handoff.
Do not create/publish an advisory, contact people or push to an assumed private
fork. Public push/PR needs an explicit disclosure/publication decision outside
this unattended goal. Prepare small Conventional Commits locally instead.

On an authorization/RLS escape or acknowledged-data loss/corruption in an owned
fixture, stop probing that boundary, isolate it and preserve evidence. A minimal
local correction and a clean-fixture regression may proceed within this goal;
do not broaden exploitation. If ownership is uncertain, real data appears, or
traffic reaches an unintended system, stop all traffic immediately, preserve
diagnostics and leave the decision for the maintainer. Continue only safe
independent work when containment is certain. Unfixable/high-risk findings stay
open with a private handoff; never conceal them to call the run successful.

## Resource limits and deadline

Hard limit: **eight hours wall clock** from the start of Phase 0, including
preparation and CI waits. This is a maximum, not an eight-hour soak requirement.
Finish sooner when coverage is closed; do not repeat unchanged tools to fill time.
Reserve the final 30 minutes for revalidation, evidence packaging and reporting.

Before traffic, record available CPU/RAM/disk and actual fixture limits. Default
ceilings: four CPU cores and 2 GiB aggregate fixture RAM (lower when the host
cannot retain a 25% reserve), 16 concurrent requests, 20 requests/second,
50,000 total requests, five minutes per scenario and 2 GiB of owned test files
plus database data. Enforce request/time/data caps in the runner and container
limits where available; a prose limit alone does not bound a test. Never fill a
real filesystem. Use only the resources allocated to this task.

Automatically stop the affected workload if host free disk drops below the
larger of 2 GiB/10%, available RAM below the larger of 512 MiB/10%, a fixture
is OOM-killed, its limits cannot be enforced, or unexpected targets/real data
appear. Preserve diagnostics and clean only explicitly owned fixtures; no broad
Docker prune or unrelated service restart. If telemetry is unavailable, do not
start resource/traffic loops. These are audit safety ceilings, not reduced
product SLOs or substitutes for G05 capacity/stress acceptance.

At the deadline, stop launching cells/fixes, terminate owned traffic, complete
safe cleanup and report the current state. Mark unfinished work not run or
incomplete; do not claim success because the budget expired.

## Validation and deliverables

- Run the affected Rust suites through scripts/test.sh, then affected
  Vitest/browser/SDK checks sequentially; add existing memory/provider suites
  when their ownership/backend is touched. No full-workspace rerun merely to
  repeat a green result; use broader coverage when evidence/scope requires it.
- Run fmt, Clippy with -D warnings, boundaries/doc-version checks and existing
  Cargo/npm audits as applicable. Report audit database freshness/access errors
  and triage findings; do not disable advisories to obtain green output.
- Preserve SDK size/type/package contracts. If UI/bundled guides change, update
  English/Portuguese sources, check translations, rebuild embedded assets in a
  separate build commit and then rebuild the binary. Record the final ELF hash.
- Record every command, tool version, start/end, exit status, pass/fail/ignored
  count and sanitized evidence path against its SHA. A mock, skipped test or
  successful build alone is not runtime acceptance.
- Public CI is not authorized to receive private corrections. Local evidence
  remains local evidence; leave CI/release readiness explicitly pending. If a
  later publication is authorized, require all applicable ordinary checks on
  that exact public head; do not reuse an older head's green result.
- Update the sanitized [execution record](security-data-race-review-execution.md)
  with one verdict per cell: passed, fixed and revalidated, open finding,
  blocked (environment), not applicable (reason), or not run. A finding needs
  its own severity/status; blocked is never passed.
- Produce a private technical report in Portuguese: starting/final SHAs,
  published-versus-source/candidate distinction, coverage and three-pass
  evidence, findings by severity, old/new results, resource observations,
  open/blocked/not-run work and ordered operator actions. Include artifact
  checksums and explain that local artifacts must be saved outside the workspace.
  Publish no sensitive details in the sanitized repository record.

## Completion criteria

- [ ] Baselines, artifact identities, environment caps and deadline recorded.
- [ ] All 20 cells mapped to applicable OWASP controls and an explicit verdict.
- [ ] All three passes have their actual work/evidence recorded.
- [ ] Every confirmed defect is fixed with before/after regression evidence or
      remains explicitly open with impact, reason and safe recommendation.
- [ ] Final changed boundaries are revalidated; failure/ignored results and
      actual resource release observations remain visible.
- [ ] Private corrections/evidence have a recoverable handoff with checksums;
      sanitized records disclose no unpublished exploitable details.
- [ ] Portuguese report separates review completion, remaining blockers and
      release/VPS readiness; no merge, publication or production action occurred.

References: [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/),
[OWASP Top 10](https://owasp.org/www-project-top-ten/),
[OWASP API Security](https://owasp.org/www-project-api-security/),
[G02](architecture-security-performance.md),
[G04](triple-project-review.md), [G06](auth-security-review.md).
