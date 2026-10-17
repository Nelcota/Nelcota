# G05: Full stress, endurance and failure-recovery verification

Status: in progress. The [execution record](stress-verification-execution.md)
tracks actual campaigns, corrections and incomplete gates. This goal records no
production capacity certification.

Planning baseline: `2efede8c27ee12119142170e8bd9742ff7cb900e` (PR #89).
Its 17 PR checks and 17 post-merge checks passed. Those checks do not establish
the load capacity of this revision or of a future VPS.

## Campaign convergence directive — 2026-10-17

The owner narrowed the remaining work at **2026-10-17 21:27:36 UTC**. The hard
wall-clock deadline is **2026-10-19 03:27:36 UTC** (30 hours); preparation counts
against this deadline, but does not count as effective load. This directive
supersedes the earlier automatic fix/refreeze/repeat loop and remaining campaign
schedule. Historical failures, thresholds, SLOs and evidence remain unchanged.
Unexecuted original criteria stay unapproved.

First extract the eleven reproduced production corrections, focused regressions
and necessary translated guides/assets into a separate review PR from current
`main`. Exclude stress harness changes and G05 evidence documents. Keep #90 a
draft. Require all **18** ordinary checks on the extraction PR's exact head.
Then freeze that production source and its built artifact once. Do not change
or refreeze it for this campaign.

Run only these remaining campaigns, in order: (a) restore-fencing guest reboot,
(b) one continuous four-hour disk endurance, (c) one continuous four-hour real S3
endurance, (d) existing fault-under-load campaign with one fault at a time.
Retain all existing workload, quota, reserve, latency, correctness, recovery and
observation thresholds. No new harness features. Only minimal fixes to harness
bugs that invalidate evidence are permitted, and each requires a ledger entry.
A failed campaign is recorded without restarting it or modifying the product;
continue the remaining feasible campaigns after safe cleanup.

New product findings are recorded with reproductions and remain open. An
authorization/RLS escape, acknowledged-data loss or corruption immediately stops
all campaign traffic: preserve diagnostics, report and await human instruction.
Do not auto-fix such a failure. Stop on the deadline wherever execution stands,
write the Portuguese per-cell report (passed/failed/blocked/not run), then end.
No production deployment, merge or additional qualification work is authorized.

### Environment-blocked cells: no workaround and no retry

All cells below are **blocked (environment)** for this campaign. The staging
profiles describe prerequisites for a future separately authorized campaign;
they do not lower or satisfy any original acceptance criterion.

| Cell | Missing prerequisite | Required disposable staging profile |
|---|---|---|
| Off-host restore | No independently provisioned recovery host and approved private backup transfer path | Two independently isolated hosts, separately owned storage and verified encrypted backup transport; a fresh recovery database/file target with capacity for the original dataset plus backup/restore temporary space and the 15% disk/inode and 10% RAM reserves. Record unchanged RPO/RTO, credentials and checksum/row/file reconciliation before starting. |
| Real WAL/PITR with pgBackRest/S3 | No configured real WAL archive/repository and recovery target | Dedicated PostgreSQL 17/systemd host with real pgBackRest, verified-TLS S3 repository and generated fixture credentials; independent fresh restore target, continuous timestamped acknowledged-write ledger, retained base backups/WAL and enough bounded repository/target disk for the complete replay window plus reserves. The marker-only error adapter is not a substitute. |
| Public DNS/ACME/TLS | No owned public staging hostname, DNS control and reachable ACME ingress | Dedicated public staging address and domain with narrowly scoped DNS credentials, verified authority/provenance, ports 80/443 available and bounded traffic; disposable Caddy/ACME certificate lifecycle, renewal/reload tests and unchanged TLS validation. A local CA is not public ACME evidence. |
| ARM64 | No native ARM64 staging runner | Dedicated Linux ARM64 machine with Docker/systemd as applicable, compatible pinned toolchain and native provider/generator images; at least the original effective CPU slots (3 disk/4 S3), measured per-component RAM/disk budgets and original reserves. Emulation does not satisfy the native architecture cell. |
| Separate load-generator machine | No independently isolated generator host/network measurement path | Dedicated target host plus separate generator machine and controlled network; generator capacity above the declared offered load, measured saturation/drops/steal and network limits, TLS enabled, synchronized metadata and monotonic local measurements. Co-located CPU affinity is not off-host capacity evidence. |
| Ten-project host topology | Current disk cannot fit the declared physical fixtures and root reserve | Disposable host with ten independent project PostgreSQL/file/JWT fixtures at the original sizes, provider and proxy as applicable, declared aggregate CPU/RAM plus OS/controller/generator headroom. The last projection required 16,062,994,022.4 free bytes including reserve; provision additional physical disk headroom for telemetry, WAL, temporary files and full-run growth before admission. Do not delete caches, shrink fixtures, oversubscribe silently or retry on this host. |
| 24-hour rehearsal | No separately reserved uninterrupted 24-hour staging window compatible with the remaining ordered campaigns and hard deadline | Dedicated disposable host, independent observer/watchdog and resource/storage reservation for 24 uninterrupted measured hours plus preparation and safe cleanup; original traffic, SLOs, reserves, recovery and evidence retention. Short campaigns cannot be added together to claim this cell. |
| Power loss beyond VM process cuts | No isolated physical power/storage fault apparatus | Dedicated nonproduction hardware or equivalently controlled infrastructure exposing real host/storage power interruption, independently durable acknowledged-write witness and diagnostics, externally controlled recovery/power cycle and restore material. QEMU process/RAM cuts do not prove controller-cache or physical-media durability. |

## Objective

Measure Nelcota's sustainable capacity, breaking points and recovery behavior
under realistic and adversarial workloads. Reproduce and fix confirmed defects,
then demonstrate that overload cannot break authorization, corrupt acknowledged
data, repeat accepted host mutations or retain unbounded resources.

Cover the native Rust backend, PostgreSQL, Caddy, disk/S3 storage, webhooks,
panel, both SDKs, authentication consumers and host management. Include the
intended deployment of **ten independent projects on one host**, with distinct
databases, keys, users and files. Preserve the single Rust backend, PostgreSQL
RLS, immutable released migrations and documented HTTP/SDK contracts.

The result is a measured operating envelope for named artifacts, hardware and
workloads. Project count alone does not establish host capacity.

## Existing foundation and required extensions

Reuse [the release campaign](../../bench/README.md), `bench/campaign.py`,
`bench/campaign.js`, `bench/compare.py` and the focused real-service regressions.
k6 runs as a native binary in Docker; Python orchestrates development tooling.
The production backend retains no Node or Python runtime requirement.

| Existing capability | Work required for G05 |
|---|---|
| Three steady measurements, mixed traffic, 16/32/64/128-VU stress, restart recovery and a default 30-minute soak | Add sustained open-loop capacity steps, repeated spikes and explicit saturation/recovery measurements. |
| Single-project fixture with separate app/database/generator CPU slots; optional real RustFS | Add 1/5/10-project topologies, per-project measurements and controlled noisy-neighbor scenarios. |
| Resource sampling, RLS/signature/file invariants and equivalent-fixture comparison | Add task/descriptor/socket ownership, successful-work throughput, cancellation, longer-run retention and fault evidence. |
| Runner accepts at most 3,600 soak seconds; k6 execution has a 3,900-second deadline | Implement bounded continuous endurance support before claiming a four-hour soak. Restarting the fixture between short runs is not equivalent. |
| Manual x64 workflow on a `nelcota-benchmark` self-hosted runner, with a 90-minute job limit | Keep normal PR checks fast; provide separately bounded endurance jobs with sufficient time and diagnostic retention. |
| Real host lifecycle acceptance | Extend concurrency and interruption scenarios under traffic. Its DNS/provenance/TLS/proxy doubles remain explicit limits. |

Do not use the legacy `bench/run.sh` as current validation: its Compose layout
is obsolete. Historical G02 measurements remain tied to their original source,
fixtures and hardware; obtain a fresh baseline for this goal.

## Execution boundaries

- Use dedicated disposable staging resources and generated fixture credentials.
  Maintain a run ID and ownership manifest for every container, volume, network,
  directory, database and fault rule. Cleanup may affect only that run's resources.
- Before starting, record topology, available CPUs/RAM, per-component quotas,
  filesystem/inode reserves, connection limits, maximum offered traffic, dataset,
  request sizes, total duration, stop conditions and recovery deadlines.
  Aggregate project budgets must leave explicit space for the OS, proxy,
  controller, generator and provider. Declare CPU oversubscription when used.
- The current single-project campaign requires at least three available CPU
  slots for disk and four for S3. These minima do not size a ten-project host.
  Keep the generator off target CPU slots; use a separate machine for host-scale
  network capacity measurements and verify that it is not the bottleneck.
- Stop offered traffic on an authorization/integrity violation, an unplanned
  restart/OOM, a lost sampler or a host reserve breach. Preserve diagnostics and
  recovery material. Plan defaults reserve 10% available host RAM and 15% free
  filesystem bytes/inodes; record any stricter deployment requirement up front.
  Inject exhaustion through owned quotas/filesystems, never the shared host disk.
- Allow one disruptive fault at a time before testing a declared combined-fault
  case. Give every fault an expiry, cleanup handler and external watchdog;
  verify removal even when the campaign process crashes.
- Keep TLS, signature, provenance and authorization checks enabled. Use controlled
  webhook/mail/OAuth destinations; do not send stress traffic to public third
  parties. Keep credentials, cookies, signed URLs, private SQL and user payloads out of
  public artifacts, labels and command arguments.
- Follow [AGENTS.md](../../AGENTS.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md):
  four Cargo jobs, two test threads, low priority and sequential Rust/Vitest/audit
  runs. Use shared PostgreSQL for ordinary Rust regressions; the multi-project
  deployment must still exercise independent project clusters.
- Production enrollment, release publication and destructive production tests
  are separate operational actions. Preserve the Unreleased controller's
  acceptance gates in [host management](../host-management.md) and
  [controlled updates](../panel-updates.md).

## Workload and correctness matrix

Each row needs positive traffic, relevant rejection cases, a correctness oracle
and recovery evidence. Small correctness checks and sustained load serve
different purposes; record both.

| Area | Required scenarios and invariants |
|---|---|
| Authentication | Concurrent signup/login, valid/invalid credentials, hash-worker saturation, refresh rotation/replay, logout/revocation, password recovery and single-use links. Two application/auth-consumer instances share session state correctly; rejected or disconnected work releases admission. |
| REST and RLS | Reads, writes, RPC, filtering, pagination and large/hidden datasets with anon, authenticated users and service roles. Exercise 100k and 1M-row fixtures where budgets permit, fresh/stale/analyzed statistics and skewed ownership. Hidden rows and another project's credentials never become visible through pooling or cancellation. |
| Concurrent mutations | Hot-row contention, unique conflicts, atomic fixture transfers/counters, transaction rollback, deadlocks and lost responses after COMMIT. Reconcile with a seeded operation ledger. Generic HTTP retries do not imply exactly-once writes; ambiguous outcomes require read-back or an explicit application idempotency contract. |
| Catalog and schema | Concurrent introspection, committed DDL followed by refresh failure, reconnects, migration locking and long-running queries. Catalog recovery cannot repeat a committed mutation; released migration bytes/checksums remain unchanged. |
| Disk storage | Wide/deep/Unicode listings, private/public objects, tiny/large uploads, overwrite/delete collisions, quotas, slow clients, interrupted downloads, traversal and symlink attempts. Check actual bytes against metadata, visibility and publication/cleanup boundaries. |
| S3 storage | Real upload/download/multipart flows with delayed/failed parts, throttling, disconnects and provider restart. Verify published bytes and cleanup of abandoned multipart state; never replace provider evidence with an HTTP mock. |
| Webhooks | Bursts, slow/unreachable receivers, retryable/terminal responses, signature checks, key changes, competing workers, restart and lease expiry. Track committed event IDs and queue accounting. Preserve documented at-least-once delivery; duplicates retain identity and are counted separately from lost events. |
| Admin operations | Parallel previews/counts, SQL batches, exports, slow/unpolled consumers, disconnects and cancellation. Verify dedicated admission/connection budgets and role reset while ordinary API traffic continues. A truncated stream cannot report successful complete export. |
| Browser panel | Multiple tabs, rapid navigation/filter changes, upload previews, request cancellation, delayed/out-of-order replies, offline/reconnect and long-lived sessions. Count requests/timers/listeners, inspect retained resources and verify confirmations/progress against authoritative operation receipts. |
| TypeScript and Rust SDKs | Concurrent refresh, multi-tab sign-out, request cancellation, dropped clients/streams, expired tokens and lost mutation responses. Verify disposal, stale-response handling and bounded retries in documented runtimes, including browser versus server behavior. |
| Ten-project host | Provision 1/5/10 independent projects, balanced and skewed traffic, reused local user/row IDs, one hot project and healthy canaries. Verify per-project JWT/file/database isolation and bounded interference. Shared project-panel SSO keeps its documented scope and never grants host-controller authority. |
| Host management | Competing create/backup/restore/remove, duplicate request IDs, expired reviews, wrong confirmations, revoked operators, Docker name collisions, lost replies and browser/worker restart at durable checkpoints. CLI/update/management share the lease; one accepted operation has one identity. Other projects remain correct; restored verified state is not replayed over later writes. |
| Updates and recovery | Read-only checks during traffic, scoped authorization, invalid manifests/digests, incompatible versions, proxy failure and interruption before/after the durable commit decision. Validate the actual runtime and matching database/files; unknown recovery state cannot reopen traffic or repeat activation. |
| Backup and deployment | Backup while controlled writers run, restore to a fresh owned target, snapshot corruption, off-host restoration and PITR where configured. Verify checksums, row/file relationships, identities and measured RPO/RTO. Cover Docker and the declared native/systemd deployment targets with actual restart/ingress checks. |
| Hostile inputs and ingress | Oversized/deep payloads, malformed encodings, null/non-finite/out-of-range values, connection churn, bounded slow headers/bodies and proxy/backend disconnects. Unauthorized control requests fail under load; limits protect resources without exposing private error/log data. |

Use smaller fixtures first. When a larger dataset exceeds the declared host
budget, record that cell as blocked and provide the required staging profile;
silently shrinking the workload does not satisfy its intended scale.

Exercise boundaries as well as average traffic: configured project caps,
255-job journal admission, 256-identity inventory, history pagination, bounded
logs/IPC, duplicate clicks and simultaneous polling. Filling an admission limit
must return the documented blocker while status/recovery stay readable; accepted
receipts cannot be evicted to admit new mutations. Measure upstream discovery
coalescing against a controlled source. Include CSRF/origin/peer-identity checks
and webhook DNS/redirect/SSRF policy under contention.

## Measurement contract

Before the first measured run, freeze the workload manifest and absolute SLOs.
Initial staging targets below are goals, not existing performance guarantees.
Choose a lower offered rate when needed to meet them. A different target needs
a documented workload/deployment reason before measurement, never a silent
adjustment after a failure.

| Operation class at nominal load | Initial target |
|---|---|
| Indexed REST/RLS reads and refresh | Successful-response p95 <= 200 ms; p99 <= 500 ms. |
| Password login with the existing Argon2 parameters | Successful-response p95 <= 750 ms; p99 <= 1,500 ms. |
| Storage list and transfers up to 1 MiB on the declared staging network | Successful-response p95 <= 500 ms; p99 <= 2,000 ms; report larger transfers in bytes/s. |
| Panel user interaction | p95 <= 1 second to useful visual feedback; report asynchronous server completion separately. |
| Recovery after ordinary overload | Useful canary traffic returns within the longest relevant configured deadline plus 30 seconds of cleanup grace; webhook drain uses the existing 30-second gate when the controlled receiver is healthy. |

Record at least:

- Source SHA, binary/image SHA-256, build flags, tool/runtime/provider versions,
  architecture, CPU affinity/quotas, cgroup limits, disk and network topology,
  proxy/TLS settings, dataset seed/size, roles/RLS and actual configured deadlines.
- Offered iterations, attempted HTTP requests, successful operations/s, bytes/s,
  p50/p95/p99, connection/queue wait and latency split by operation and outcome.
  Do not mix fast rejected responses into successful-request latency or count
  rejected traffic as useful throughput. HTTP requests and k6 iterations are
  different units; validate conversion before calibrating arrival rates.
- Expected negative assertions, documented overload responses and unexpected
  errors separately, with denominators. A 429/503/504 is expected only for a
  named scenario/endpoint with bounded behavior; a blanket allowlist cannot
  turn a broken service into a successful campaign.
- Per-process RSS, cgroup memory/current/peak/OOM events, CPU/throttling, heap
  evidence where available, tasks/threads, descriptors, sockets, buffers and
  timers/listeners. Distinguish allocator/cache retention from growing live owners.
- PostgreSQL active/idle/idle-in-transaction connections, locks/deadlocks, pool
  waits, query plans, buffer/temp I/O, WAL/disk growth, vacuum and retention work;
  webhook depth/age/in-flight work, provider multipart state and host job states.

Sample resources every five seconds and retain beginning/end/recovery coverage.
The existing maximum 30-second observation-gap gate still applies; absent,
non-finite, incomplete or failed resource evidence cannot certify a run.
Bound diagnostic sizes/cardinality and measure instrumentation overhead.

Use monotonic durations. Record CPU steal, generator saturation, dropped arrivals,
TLS/connection reuse and competing host activity. Use open-loop arrival traffic
for capacity/SLO claims to avoid hiding queue delays through client pacing.
Require at least 99% delivered iterations and at most 1% dropped arrivals at
nominal load; an underpowered generator makes the capacity result inconclusive.
Report run-to-run variation; investigate noisy comparisons rather than averaging
away failed samples or loosening gates. Test clock drift through controlled
clocks or a disposable VM, preserving expiry/trust checks and the shared host's
actual clock.

## Campaign phases

1. **Inventory and preflight.** Map every matrix row to an existing test or a
   required harness extension. Validate ownership/cleanup, watchdogs, redaction,
   stop conditions and functional probes at tiny load. Capture a retained
   release baseline and candidate artifact; never benchmark a moving checkout.
2. **Baseline and capacity.** Warm each fixture, then run three equivalent
   steady measurements per operation/backend/topology. Use open-loop rate steps
   at 25/50/75/100% of provisional capacity, holding each for at least five
   minutes. Refine the highest rate meeting SLOs and resource headroom.
   Establish a separate ten-project baseline with the same budgets and traffic
   distribution used for its candidate.
3. **Stress and spikes.** Retain the existing bounded VU staircase. Add up to
   125/150/200% of measured sustainable arrival rate, within the predeclared
   ceiling. Repeat five cycles of a 10-30-second 3x arrival spike followed by
   baseline traffic and recovery. Failed correctness always stops the run;
   saturation is a measurement, not permission for unbounded work.
4. **Fairness and contention.** Run ten active projects with balanced traffic,
   then send 80% of offered work to one project. Saturate its hashing, queries,
   storage or webhooks one at a time. Healthy projects must meet their declared
   SLOs; the default relative gate retains at least 90% of their baseline useful
   throughput with at most 20% worse p95. Declare any intentional CPU sharing
   and include proxy/controller responsiveness.
5. **Faults under load.** At 60-80% of measured sustainable capacity, inject
   database latency/locks/disconnect/restart, provider throttling/unavailability,
   receiver failures, app kill, worker/controller restart, proxy reload failure
   and owned disk/inode/quota exhaustion. Include an explicitly tagged
   per-container OOM case with a host watchdog. Measure the event, response,
   bounded work, cleanup and functional recovery. Exercise host-operation
   checkpoints and conflicting CLI actions separately before combining faults.
6. **Continuous endurance.** After implementing the runner extension, require
   at least four uninterrupted hours for mixed disk traffic and four for mixed
   real S3 traffic at 70-80% of independently measured sustainable capacity.
   Keep the same app/database processes for each run, renew test credentials
   through supported flows, and include at least two retention/pruning cycles
   using safely aged fixtures where real TTLs are longer. Bound legitimate data
   growth and preserve realistic retention; do not periodically recreate the
   service to hide accumulation. A 24-hour deployment rehearsal is an additional
   promotion check when that operating claim is needed.
7. **Drain and recovery.** Stop offered load, remove faults and verify row/file
   ledgers, queued event outcomes, auth revocation and host receipts. Sample idle
   resource plateaus after five pressure/rest cycles and after endurance. Restore
   a verified snapshot to a fresh owned target and prove functional access and
   rejection of unauthorized access. Record RPO/RTO and any intended restore
   rewind separately from unintended loss of acknowledged writes.
8. **Correct and repeat.** Complete two independent campaign passes from fresh
   fixtures. Pass 1 establishes evidence and a finding ledger; fix confirmed
   defects in their owning packages and add meaningful regressions. Pass 2
   validates the final candidate and all affected matrix cells. Independently
   reassess its oracles, failure handling, measurement units and teardown.
   Any further correction invalidates affected earlier results and requires
   their replacement on the final artifact. Repeating an unchanged linter does
   not constitute another stress pass.

Actual power-loss/durability tests require a disposable VM/host and an external
observer; killing a process is not power loss. Real public TLS/DNS/provenance,
systemd, provider and off-host recovery gates must be recorded for each claimed
deployment target. An unavailable target stays blocked; a local double cannot
complete that operational acceptance cell. Performance numbers apply only to
the measured architecture/hardware, including any separate ARM64 campaign.

## Acceptance gates

- **Correctness:** zero authorization/RLS escapes, unintended acknowledged-data
  loss, byte/metadata mismatches, signature violations or duplicate accepted host
  mutations. Account for ambiguous client responses and documented webhook
  duplication rather than asserting unsupported exactly-once semantics.
- **Nominal service:** zero unexpected failures; all declared absolute SLOs,
  offered-load delivery and useful-throughput requirements pass. Negative and
  overload cases have explicit expected outcomes and meaningful positive probes.
- **Regression:** three valid comparable steady samples on each side. Median
  p95 may worsen at most 10%; useful throughput may decrease at most 10%.
  Use the existing comparator for its supported report schema and extend its
  gates with regressions before relying on new host/endurance metrics.
  Failed, mismatched or non-finite baselines never certify a candidate.
- **Resource ownership:** no unplanned OOM/restart, breached budget, stuck lock,
  orphaned child/transaction/multipart upload, leaked admission or accumulating
  task/listener/socket/descriptor owners. Known bounded caches may plateau above
  startup RSS; unexplained sustained post-warm growth blocks approval until
  investigated with ownership/allocation evidence.
- **Recovery:** ordinary traffic and resource owners recover within declared
  deadlines; healthy-project fairness gates pass. Readiness includes successful
  authorized work and a rejected unauthorized probe, not just HTTP 200 health.
  Interrupted host jobs preserve evidence and require the documented explicit
  recovery when applicable; they never guess rollback or replay verified work.
- **Evidence:** both passes, all mandatory matrix cells, continuous disk/S3
  endurance and measured recovery have final-artifact evidence. Missing services,
  skipped cases, sampler gaps, incomplete reports and unavailable deployment
  acceptance remain visible as blocked/not run, never inferred passes.

## Deliverables and completion checklist

Keep raw run outputs in fresh ignored `target/stress-g05/<run-id>/` directories.
Retain a bounded, secret-safe evidence bundle per run. Commit reviewed summaries
under `docs/goals/results/stress/` and an execution record at
`docs/goals/stress-verification-execution.md` when the work is executed; these
are planned deliverables, not existing reports.

The final Portuguese report must show the source/artifact IDs; test counts and
durations; sustainable/breaking rates per workload and 1/5/10-project topology;
latency/resource peaks; recovery RPO/RTO; reproduced fixes; before/after
comparisons; cleanup results; and remaining limits. Give each scenario a
`passed`, `failed`, `blocked` or `not run` verdict with an evidence location.
Provide practical VPS sizing guidance only for the measured workload and
headroom, including OS, database, proxy and controller costs.

- [ ] Coverage inventory, immutable baseline and predeclared manifests/SLOs exist.
- [ ] Generator calibration, units, sampling and evidence gates are validated.
- [ ] Safe cancellation, watchdogs, redaction and owned teardown are demonstrated.
- [ ] Steady, staircase, spike and repeated pressure/rest phases pass twice.
- [ ] All capability, security and concurrency matrix cells have evidence.
- [ ] 1/5/10-project isolation, shared-host fairness and controller responsiveness pass.
- [ ] Continuous four-hour disk and S3 endurance runs pass on the final candidate.
- [ ] Fault injection, drain, restart, restore and applicable deployment gates pass.
- [ ] Resource ownership, data/file/event invariants and regression gates pass.
- [ ] Confirmed defects have focused fixes, reproductions and passing regressions.
- [ ] Final affected Rust/UI/SDK/native lint checks and CI match the tested SHA.
- [ ] Findings, measurements, sizing limits and all failed/blocked/unrun work are reported.

The goal remains open while a mandatory gate is failed, blocked or unrun.
Optional deployment experiments need their own verdict and cannot widen the
certified envelope. Follow the repository's Conventional Commit/PR practices
for future fixes; rebuild versioned UI assets separately when UI changes.

Related: [G02](architecture-security-performance.md),
[memory lifecycle review](memory-review-execution.md),
[configuration](../configuration.md), [architecture](../architecture.md),
[backups](../backup.md), [storage](../storage.md) and [webhooks](../webhooks.md).
