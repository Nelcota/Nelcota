# G09: Evidence-based performance review

Status: planned; not executed. Record actual work in
[the execution record](performance-review-execution.md). Creating this goal
does not establish a performance result or production capacity.

## Objective

Find and correct measured bottlenecks in the Rust backend, PostgreSQL, disk/S3
storage, panel, TypeScript/Rust SDKs and host operations. Reduce unnecessary work,
latency or retained resources while preserving correctness, security, public
contracts and operational guarantees. A review with no justified optimization is
valid; do not change code merely to produce a speedup claim.

This is a bounded performance investigation, not a whole-project rewrite or a
repeat of G05's full stress/endurance campaign. Historical benchmark tables and
green correctness CI do not establish the capacity of the current VPS.

## Authority, safety and budget

When instructed to execute G09, proceed autonomously and record decisions and
their reasons. Record unavailable resources as blocked and continue independent
work. Do not ask routine implementation questions or silently relax criteria.

- Use a dedicated disposable environment with synthetic accounts, rows and files.
  Do not access, benchmark or change the production VPS, its domain, customers,
  backups, SMTP/webhook destinations or real provider accounts.
- Do not merge, deploy, publish packages, push/delete tags, create releases,
  dispatch release workflows or change repository/branch-protection settings.
  Do not modify existing PRs. Prepare focused local commits and reviewable
  results; public push/PR publication requires separate authorization.
- Preserve documented HTTP/SDK/Rust APIs, CLI/configuration formats, migrations,
  limits and bundle budgets. Do not edit released migration SQL/checksums.
  Changes requiring a new migration, dependency, public contract or configuration
  default remain proposals with evidence for maintainer review.
- Never disable RLS, TLS verification, authorization, hashing cost, quotas,
  cancellation, backpressure, durable writes, recovery fences or approval gates
  to improve timings. Never cache data across users/projects without the same
  authorization checks. Track G08's unresolved work separately; performance
  approval must not conceal a known correctness/security blocker.
- Follow [AGENTS.md](../../AGENTS.md) and
  [CONTRIBUTING.md](../../CONTRIBUTING.md): four Cargo jobs, two Rust test
  threads and at most two UI workers. Rust, Vitest and audits are sequential.
  Never compile, test or profile unrelated work during a measured campaign.
- Hard limit: **eight hours wall clock**, including preparation and waits,
  starting when execution begins. It is a maximum, not a minimum test duration.
  Reserve the final 30 minutes for revalidation, cleanup and the Portuguese
  report. At expiry, stop owned traffic and report unfinished work honestly.

## Pass 1: Inventory and trustworthy baseline

1. Inspect the clean worktree, current main, published server/SDK versions,
   [architecture](../architecture.md), [security model](../security/README.md),
   existing performance tests, [bench instructions](../../bench/README.md),
   [G02](architecture-security-performance.md) and historical G05 limitations.
   Work on an isolated branch. Do not reset unrelated work.
2. Record full source SHA, release-build flags/toolchain, binary SHA-256,
   dependency locks, architecture, CPU quota/affinity, RAM/cgroup limits, disk
   type/free space, topology, provider versions and generator placement.
   Freeze baseline artifacts before changing code. Debug builds may help
   diagnosis but cannot supply release-performance claims.
3. Separate current main, the published release and unmerged candidates. Check
   PR #125's status at execution time before measuring server operations/alerts.
   An unmerged candidate requires its own worktree, artifact and labeled report;
   do not merge it into main merely to simplify testing.
4. Inventory hot paths using code/history plus existing metrics: request counts,
   query counts/plans, allocation/copy/serialization costs, blocking work on
   async runtimes, repeated polling/refresh, unnecessary renders and resources
   retained after cancellation. Large files alone are not bottlenecks.
5. Record workload shape, seed, cardinality, indexes, RLS policies/selectivity,
   file sizes, pool/concurrency limits, warm-up and cache/statistics state before
   running a baseline. Use representative bounded small/medium/large datasets;
   do not exceed the fixture's data budget to reach a nominal row count.
6. Calibrate a safe offered rate before freezing the comparison profile. Separate
   indexed reads, hashing and writes; they have different CPU/I/O costs. After
   calibration, keep the workload/rate identical on baseline and candidate.

## Coverage matrix

For every cell record paths, hypothesis, invariant, workload, source/binary
identity, baseline/candidate evidence and verdict. Use positive authorization
and integrity canaries while measuring; fast incorrect responses are failures.

| Cell | Area | Required investigation and measurements |
| --- | --- | --- |
| P01 | Request execution | Routing, filtering, parsing/serialization, redundant allocations/copies, repeated work and response size; separate network time from server CPU where instrumentation permits. |
| P02 | PostgreSQL | Query count/N+1, EXPLAIN (ANALYZE, BUFFERS) on owned data, pg_stat_statements, plans with fresh/analyzed statistics, RLS overhead, joins/RPC, count queries and pool acquisition. Preserve equivalent authorization and results. |
| P03 | Pagination/cardinality | Indexed and selective/nonselective filters, stable ordering, small/large page positions, users/tables/storage listings, row estimates and memory growth with cardinality. Do not promise O(1) from one dataset. |
| P04 | Auth and session paths | Password verification/hash admission, refresh, token validation, pending work and lock contention. Preserve Argon2/security settings, revocation/grace semantics and source/account quotas. |
| P05 | Disk and S3 storage | Upload/download/list/overwrite, streaming/backpressure, metadata queries, quota checks, multipart cleanup, bytes read/written and time to first byte; disk and real S3-compatible provider results remain separate. |
| P06 | Webhooks and alerts | Idle polling, batching, queue drain, lease/lock contention, retry storms, timers, concurrency, persistent writes, DNS/provider waits and repeated probes. Use controlled local destinations; no real notifications. |
| P07 | Panel/browser | Request duplication, polling with hidden/unmounted views, rendering/large lists, long tasks, navigation, listener/heap retention, transferred/parsed JS and existing bundle budgets. Record browser/viewport/network/cache settings. |
| P08 | TypeScript/Rust SDKs | Shared request coordination, refresh deduplication, parsing/serialization, allocations, streaming/body limits, retry counts, abort/close cleanup and package sizes. Do not introduce extra retries or enlarge budgets for speed. |
| P09 | Async contention/resources | Blocking CPU/I/O, lock hold time, admission fairness, stalled/slow clients, task/timer/connection/descriptor ownership and latency under bounded concurrency. Cancellation must free resources and preserve transactions. |
| P10 | CLI/host operations | Startup/shutdown, discovery/diagnostics, config parsing, backup/compression/encryption/retention and update/recovery work. Measure isolated stages; preserve fences, verification and safe cleanup. |
| P11 | Multiple projects | One/five/ten owned projects only when topology and disk reserve support them; latency/resource fairness and noisy-neighbor isolation with per-project canaries. Insufficient resources mean blocked, not equivalent single-project evidence. |
| P12 | Resource stability | Idle/peak/settled RSS and cgroup usage, CPU, I/O, page cache, sockets/FDs, connections, idle transactions, queues and tasks; repeat bounded load/unload cycles and investigate persistent growth rather than inferring leaks from RSS alone. |

Browser LCP/INP/CLS and long-task measurements must identify the actual flow and
measurement method. Synthetic interaction timings are lab results, not field
Core Web Vitals. If a metric cannot be measured reliably, say so.

## Measurement protocol

- Reuse bench/campaign.py and bench/compare.py. The legacy bench/run.sh is not
  current host-layout validation. Do not build another general benchmark system
  or rerun long G05 campaigns. Add a minimal focused probe only for a concrete
  hypothesis not measurable with existing tools.
- Use release binaries, the same fixed resource budgets, topology, dataset,
  versions, indexes, RLS policies, payload sizes, offered rate, warm-up and nominal
  duration. Reset mutable fixture data where required. Never compare a warmed
  candidate with a cold baseline, or present tmpfs test-database timings as disk
  deployment performance. Correctness suites may use their documented shared DB.
- Obtain at least **three valid steady samples per side/scenario**. Retain every
  sample, failures and run order. Alternate order or use an unchanged control
  where existing tooling permits. Report median and dispersion; investigate
  thermal, scheduling, cache or generator contention. If results are noisy or
  incomparable, report inconclusive rather than selecting the fastest run.
- Report p50/p95/p99, achieved/offered throughput, attempted/completed requests,
  unexpected errors, intentional 429/503 admission outcomes, dropped arrivals,
  CPU/RSS/I/O, pool wait, locks, queries and retained resources. Keep hashing,
  reads, writes and provider/network costs separate. Small sample tails are
  descriptive and uncertain; do not certify p99 from a handful of requests.
- At fixed offered load, stable achieved throughput is not maximum capacity or
  proof of a throughput speedup. Closed-loop tests can hide queuing/coordinated
  omission; use the existing open-loop mode for controlled-rate comparisons and
  preserve its 99% delivery / at most 1% dropped-arrival gate.
- Preserve the repository comparator gate: median p95 may worsen at most 10%,
  and achieved throughput may decrease at most 10% on equivalent valid samples.
  These are regression ceilings, not a promised improvement. Do not use
  --allow-baseline-failures to certify a candidate. Baseline failures cannot
  establish an approved comparison.
- Investigate unexplained regressions in p99, errors, resources, fairness or
  startup even if p95/throughput meet the comparator. An optimization is retained
  only with a repeatable benefit exceeding observed noise and no unresolved
  correctness/security/resource regression. Record the trade-off explicitly.
- Collect profiler/query-plan evidence separately from timing certification;
  profiling overhead must not contaminate an unprofiled comparison. Use existing
  tools when available; missing perf/eBPF privileges are a blocker, not a reason
  to disable kernel protections or expose debug endpoints.

Example of an existing bounded disk investigation, after validating resource
availability and calibrating/freezing the rate for both sides:

```sh
cargo build --locked --release -p nelcota-server
python3 bench/campaign.py --binary target/release/nelcota \
  --output target/g09/baseline-read --workloads read,rls,panel \
  --steady 60s --steady-rate 10 --no-stress --soak-seconds 0
# Save the baseline ELF and its SHA-256 before building a changed candidate.
# Run the candidate with the identical profile in a new output directory.
python3 bench/compare.py target/g09/baseline-read target/g09/candidate-read \
  --workloads read,rls,panel --output target/g09/comparison-read.json
```

Ten requests/second here is a bounded example, not a target SLO or measured
capacity. Confirm current command options first. Authentication, storage, mixed
traffic and S3 require their own appropriate comparable profiles. Use empty
output directories; never overwrite failed or earlier measurements.

## Pass 2: Targeted optimizations

Rank hypotheses by measured cost, user impact, confidence and implementation
risk. Select at most **five targets** for this pass; list remaining hotspots as
future work. For each selected target:

1. State the measured problem, expected mechanism and a falsifiable benefit.
   Verify intended behavior is covered; add characterization/regression tests
   first when absent, and show them passing on unchanged production code.
2. Make one small change in the owning module; preserve errors, ordering,
   authorization, cancellation and post-COMMIT acknowledgement. No speculative
   abstraction, blanket parallelization, new cache or unbounded prefetch.
3. Repeat the focused measurement against the frozen baseline with unchanged
   tests and profile. Record raw before/after values, percent change, dispersion,
   costs and limits. Revert the optimization if its benefit is not demonstrated
   or it introduces an unresolved regression; keep the diagnostic evidence.
4. Use small Conventional Commits with focused tests. Keep generated embedded
   assets in a separate build commit, then rebuild/hash the final Rust binary.
   English/Portuguese bundled guides change together when behavior needs docs.

## Pass 3: Final reassessment

Review the complete diff and rerun affected correctness/security/resource suites,
SDK type/package/size checks, UI checks and relevant memory/provider cases.
Run fmt, Clippy -D warnings and architecture/doc checks; do not repeat unrelated
green suites without a new reason. Broad correctness testing must be sequential
with measurement, never competing for benchmark CPU slots.

Revalidate selected and adjacent unaffected workloads on the final artifact.
Use a bounded 30-minute stability run at a safe calibrated load only on a
dedicated environment that supports the same budgets, with continuous telemetry
and cleanup assertions. If unavailable or the deadline prevents it, mark that
stability cell blocked/not run; do not substitute a short loop and call it a soak.
This run does not certify G05 endurance, reboot or off-host recovery.

Document causal evidence, remaining regressions, disproved hypotheses and
environment limitations. Do not keep adding targets or restart all three passes
for every new idea. No optimization can be called approved until its affected
final-artifact comparison and correctness checks are complete. If publication is
later authorized, all applicable ordinary CI checks must pass on its exact head;
local evidence and older green CI are not that approval.

## Resource envelope and automatic stop

Before traffic, record/enforce CPU affinity/quotas, aggregate RAM, connections,
request/concurrency/data caps, per-scenario timeout and total wall-clock deadline
for app, database and generator. Use the existing campaign's pinned profile:
three dedicated CPU slots for disk; S3 needs a fourth slot/provider budget.
If those slots cannot be reserved, block the campaign rather than reduce its
profile or run it alongside other suites. Document generator co-location; a
separate-host capacity claim requires a separate actual generator machine.

Retain a 25% RAM reserve before starting. Stop owned load automatically if free
disk drops below the larger of 2 GiB/10%, available memory below the larger of
512 MiB/10%, the existing campaign disk/data cap is crossed, a fixture OOMs,
telemetry disappears, request/duration limits are exceeded, or authorization,
integrity or acknowledged-data invariants fail. Enforce guards in the runner;
prose alone is not enforcement. Do not raise a safety ceiling after failure to
obtain a green result. Keep failed diagnostics and clean only owned fixtures.

Do not probe production, exhaust a shared host, run broad Docker prune, restart
unrelated services or weaken resource/security budgets. Real public TLS, ARM64,
off-host storage and ten-project host topology require the actual disposable
resources; report missing resources as blocked without claiming equivalence.

## Deliverables and completion

- [ ] Baseline/final source and binary identities, versions, hardware, budgets,
      dataset, warm-up and workload profiles recorded.
- [ ] All 12 cells have paths, method, evidence and verdict: measured, optimized
      and revalidated, no justified change, open regression, blocked (environment),
      not applicable (reason), or not run. Unknown is not passed.
- [ ] At most five selected changes have a measured cause, unchanged behavior
      tests, comparable before/after samples and final-artifact verification.
- [ ] Raw JSON/CSV, query plans, profiler/resource traces, failed samples and
      comparator output remain available with hashes; secrets and private rows
      never enter public logs or reports.
- [ ] Final local checks and any authorized exact-head CI are distinguished;
      pending, ignored and failed cases remain visible.
- [ ] A Portuguese technical report lists results by scenario, p95/p99 and
      resource changes, uncertainty/trade-offs, local commits, reverted/no-op
      attempts, blockers and prioritized follow-up. Separate measured throughput
      from maximum capacity and source evidence from VPS acceptance.
- [ ] Execution record updated, owned workloads/fixtures stopped, and no merge,
      release, publication or production change occurred.

Related: [benchmarks](../../bench/README.md),
[G02](architecture-security-performance.md),
[G05 archive](https://github.com/Nelcota/Nelcota/pull/90),
[G08](security-data-race-review.md).
