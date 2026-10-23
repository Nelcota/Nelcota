# G09: Performance review execution record

Status: bounded execution finished with open performance gates and environment limitations. Polling optimization withdrawn; no performance approval. This is not production capacity, a release approval or a completed G08 security review.

## Artifact, environment and timeline

Baseline production source `4d4034835ebc55538dabf3c2df109faea4cc8e13`, fetched at intake; PR125 is merged and included. Published server0.5.1 is a different dated artifact. Published/source SDK versions confirmed0.2.1(TypeScript),0.1.4(Rust). Local branch `local/g09-performance-review`.

Frozen baseline release ELF SHA-256 `2dc5d31029463dddeaa7175efcad2d922529cef2ea482793e8b42f91f3cd4ae0`; rejected polling proposal source `d5f227a571563c162edf8f5dbc4d4d1e27ab8cc5`, ELF `aede831cb929408e36c65c7d66a040c01227e87b86de89f99068f65bb6dafc8a`. Final selected production source is unchanged `4d4034835ebc55538dabf3c2df109faea4cc8e13` and final ELF is the original baseline `2dc5d31029463dddeaa7175efcad2d922529cef2ea482793e8b42f91f3cd4ae0`; local revert commits `581fb760`/`1cf017e0` retain characterization tests. Rust1.99 release/thinLTO/codegen-units1, same locks. Frozen copies remain read-only and are used instead of the mutable shared target directory. G10 is a separate source/ELF; neither candidate certifies their combination.

Managed x86_64 host, kernel6.18.55, cgroup4CPU/32GiB, five affinity IDs. App/PG/generator use separate pinned CPU slots0/1/2; real local RustFS adds slot3. Same co-located generator, pinned k6 digest, PG17.11/Ubuntu24.04 and recorded image IDs; disk data is an owned Docker volume on the managed host, not tmpfs or the VPS disk. Hypervisor exclusivity/physical disk characteristics are not established. Separate-host, ARM64, publicTLS/WAN/provider/production-host evidence is unavailable.

Existing runner profile: app1CPU/128MiB, PG1CPU/384MiB/max40connections/shared_buffers64MiB/WAL64MiB/pool8, generator1CPU/512MiB/Go448MiB; S3 provider1CPU/512MiB. Dataset100k products,100k private rows(50% owned under RLS),10k object metadata, bounded small real byte fixtures. Three fresh-statistics closed-loop diagnostic samples for selected workloads precede ANALYZE; steady certification uses three60s open-loop samples per workload at10 iterations/s. Warmup15s and two20s closed-loop recovery probes have their own profile. Login, refresh, read, RLS, panel, storage and mixed remain separate. Higher HTTP request counts on refresh/mixed can include per-VU login; iterations/s is not universally requests/s.

Finite high benchmark authquota100000 and storageMINFREE0 are pre-existing runner isolation settings, identical on both sides; they do not validate production-default quota/free-space policies. External disk/memory floors remain enforced. TLS/RLS/Argon2/durability/cancellation/approval product settings were not changed. Measurements do not certify default-limit/remoteTLS acceptance.

Original start/deadline01:33:45–09:33:45UTC on23Oct2026. First phase remained incomplete. Last command ended02:20:56, next observed continuation11:07:20; this gap is not testing and its cause is not established. The original deadline was missed and is not rewritten. The user asked to continue; a distinct bounded11:07:20–15:07:20 continuation preserves the old evidence and reserves the last30minutes. Idle testPG across the pause was removed before final timing, not counted as endurance.

## Pass1 and safety

Baseline release build176.061s, hash frozen before changes. Calibration01 stopped automatically after137.592s because expected Docker statsEOF during the explicit restart was written to the same file as genuine sampler errors. Preserve failed evidence. A four-line diagnostic correction separates restart observations from genuine errors, without changing workload, violation or telemetry-gap checks. Calibration02 passed163.052s at10iterations/s(read/login). Original full disk baseline passed1430.707s.

After the long gap, an unchanged-ELF control was predeclared before measuring either final candidate. Compare current candidates against it at the identical profile; retain the original/control diagnostic comparison too. Do not select the fastest run or attribute compiler/scheduling noise to UI changes. No builds/tests/audits/profiling compete with measured campaigns.

Before traffic retain25% availableRAM. Automatic guards stop owned traffic on free disk<max2GiB/10%, available memory<max512MiB/10%, PGdata>512MiB, OOM, genuine sampler failure, telemetry gap>30s, per-command timeout or continuation deadline. Existing k6 correctness/delivery gates and cleanup remain. Strict comparator: medianp95<=+10%, achieved throughput>=-10%, three valid equivalent samples,99% delivery/<=1% dropped. No baseline-failure override used. Fixed offered rate is not maximum capacity or a throughput speedup.

## One selected optimization

Controller browser polling only: `HostConsole.svelte`, `UpdatesConsole.svelte`, `Alerts.svelte`. Production-preview Chromium,1440x900,pt-BR, intercepted synthetic controller replies, controlled document visibility/clock. Three identical120s visible/hidden repetitions per side:

| Phase | Visible updates/host/alerts | Hidden updates/host/alerts | Immediate resume |
| --- | --- | --- | --- |
| Baseline |12/15/4|12/15/2(total29)|0/0/0|
| Rejected proposal |12/15/4|0/0/0|1/1/1|

A repeatable29-to0 reduction of hidden read work, visible schedule unchanged; not a claim about CPU, field Core Web Vitals or actual browser throttling. Dirty drafts, in-flight deadlines, explicit operator approvals and server-owned jobs remain. Clock/timer work beyond these requests was not optimized. No backend cache/query/security refactor justified by evidence.

Before: seven characterization/browser tests passed; new hidden-poll regression failed as expected. After:30 browser cases passed, including request ownership, lost replies, explicit recovery, drafts and upload File release. Focused UI Vitest72passed/1skipped; GC-specific memory run7passed covers its memory path separately. Svelte check0errors/0warnings. First browser setup was aborted after resolving unpinned Vite from the config directory; repeated using locked local production preview. Baseline dist rebuild reproduced tracked assets exactly. Generated final dist committed separately, then release binary rebuilt/frozen.

Local commits764d00cb(harness diagnostic),05519eca(characterization),0650ae54(polling),d5f227a5(assets); initial goal/record commits are documentation only. SDKs unchanged: TypeScript297unit tests plus type/build/size/package/memory/runtime checks passed; Rust transport14passed. SDK gzip sizes17325/17400(index),9441/9550(rest),11271/11300(auth),7602/7700(storage). No budget changed.

Rust: admin performance10, memory1, CLI alerts10, Rust SDK transport14 passed. The initial joint command filtered memory to zero; that was not a pass and was followed by its separate actual1-test run. Fmt, workspace/all-target Clippy-Dwarnings and boundaries passed. Host acceptance passed1 explicit ignored fixture test in249.22s(256.095s wrapper including preparation), real owned two-project Docker DB/files backup/restore/recovery/removal; DNS/provenance/publicTLS/proxyreload/unusedPITR extension are doubles. Its total duration is not a stage-performance benchmark. All those fixtures were cleaned before timing. Local checks are not public exact-head CI; no push/PR/Actions authorized.

## Coverage

| Cell | Evidence / scope | Final verdict |
| --- | --- | --- |
| P01 Requests | Seven workload latencies/error/delivery samples; code reviewed routing/serialization; CPU/network/allocator costs not individually attributed. | Full-profile proposal comparison failed panel latency; proposal withdrawn. No backend optimization justified; final production source unchanged. |
| P02 PostgreSQL | Fresh/analyzed owner/service/RLS plans, connection/lock/queue telemetry, bounded admin performance regressions; cumulative pg_stat_statements includes fixture/warmup/recovery, not per-request query counts. | Measured scoped plans; no general N+1/RPC/join certification. |
| P03 Pagination |18post-traffic read-only EXPLAIN samples across logical1k/10k/100k subsets of one physical100k table, plus indexed/tie-break pagination regression. First-page~.03–.04ms; deep-offset medians.169/1.687/12.885ms. | Mechanism measured; separate physical cardinalities/deep HTTP pages not run. No O(1) claim/APIchange. |
| P04 Auth | Separate login/refresh at identical Argon2/admission settings with positive invariants. | Original and proposal fixed-rate functional profiles passed; no auth change retained. Unfinished G08 overlapping-concurrency work is not closed by per-VU refresh. |
| P05 Storage | Small disk/S3 list/download/overwrite and byte canaries. Actual disposable RustFS, loopbackHTTP, provider limits recorded. | Final original ELF disk/S3 small-object campaigns passed correctness/resource checks. No G09 storage change; multipart/large transfer/WAN/cloudTLS not certified. |
| P06 Webhooks/alerts | Signature and queue-drain probes, restart recovery; CLI alerts10; browser duplicate-read reduction. | Scoped local paths; real SMTP/remote observer timing not run. Monitor remains independent of browser. |
| P07 Panel | Three production-asset count samples each side,30 browser cases, GC release tests, unchanged SDK budgets. | Polling benefit demonstrated but proposal withdrawn because full-profile panel latency gate failed; rendering/large-list/fieldLCP/INP/CLS not certified. |
| P08 SDKs | Existing coordination/cancellation/source audit and unit/type/package/memory/size/runtime/transport checks. | No measured SDK optimization justified; Bun/Deno/other browser engines not run. |
| P09 Async | Bounded open-loop load, cancellation/export/connection/lock regressions, resource telemetry. | Scoped functional/resource telemetry measured; withdrawn proposal fails latency approval. No exhaustive task/allocator profiler or fault-under-load fairness claim. |
| P10 CLI/host | Source review plus real owned lifecycle/verified backup/restore functional fixture. | Functional validation only; isolated compression/startup stage timings not measured, real systemd/boot/VPS blocked. |
| P11 Projects | One benchmark app/PG with user RLS canaries; separate host fixture validates two-project correctness. | Five/ten dedicated benchmark topologies blocked(CPU/reserve); no noisy-neighbor performance claim. |
| P12 Stability | Original baseline/restart telemetry; final original-production ELF1800s mixed stability and FD/thread/socket counts measured. | Passed scoped continuous1800s original-artifact run; final queue/transactions/locks clear. Not a general no-leak or G05 endurance guarantee. |

## Final evidence and handoff

Comparisons preserved, including original full-profile failure and panel A/B/A diagnostic. Final stability, timing and cleanup completed below. Private raw logs/JSON/query plans/metadata under ignored `target/g09/20261023T013345Z` and `target/g09/20261023T110720Z`, including every invalid/failed attempt. Final report must distinguish measured throughput from capacity, small-samplep99 from SLO evidence, local RustFS from remote provider, source review from current VPS acceptance, and G10's separate logging artifact from G09.

No production access/change or GitHub write. G08 remains incomplete; performance results do not conceal its outstanding concurrency work or authorize a release. Owned cleanup verified; private evidence manifest generated at handoff.

## Failed full-profile gate and convergence decision

Both full campaigns passed their own correctness/resource/delivery gates. The unchanged-ELF control after the execution gap nevertheless differed from the original baseline: read p95 +21.2% and refresh +48.9%. This demonstrates temporal noise, not a product speedup. Keep both controls; no selective deletion or relaxed gate.

Against the predeclared current control, the polling proposal failed the panel median p95 ceiling: 4.628328ms to5.225836ms (+12.91%; ceiling10%). Read ratio0.839, RLS1.023, storage0.964, login1.064, refresh1.055 and mixed0.947 passed; throughput remained near the fixed offered load. Cause is inconclusive. The original orchestration stopped before G10/S3/stability and retained its failed status.

Decision: no approval and no retry-until-green. Preserve the proposal patch and a verified Git bundle; revert generated assets and source separately, leaving only characterization tests and the minimal sampler diagnostic correction. Production files now match the baseline exactly. A single predeclared panel A/B/A diagnostic investigates repeatability; it cannot erase the earlier full-profile failure or restore the proposal. Final G09 S3/stability therefore use the original frozen baseline ELF, not a newly relabeled candidate. New independent campaign results are recorded separately in `campaign-progress-02.json`/`campaign-final-status-02.json`. A failed latency comparator blocks approval but does not falsify independently valid correctness/storage/stability evidence; authorization/integrity/resource failures still stop traffic.

Panel A/B/A completed with three valid samples per side. Candidate/A p95 ratio0.8586, candidate/C1.0980, C/A0.7820; controls themselves vary materially. All focused comparisons pass their original ceiling, but they do not replace the failed full-profile comparison or justify stable causal benefit. Proposal remains withdrawn.

Final G09 S3 campaign passed on the unchanged original ELF: three storage samples, recovery and17 byte-integrity canaries; final queue=0, idle transactions=0, locks=0, signatures valid. No separate same-ELF candidate run was mislabeled as an optimization. Real local RustFS/HTTP is not WAN/cloud TLS.

## Final stability, timing and cleanup

Final original-production ELF completed continuous1800s mixed load: 18001 iterations/HTTP requests, 21605 successful checks, zero unexpected errors, zero failed checks and zero dropped arrivals. Mixed aggregate p50=2.576947ms, p95=21.038386ms, p99=29.407194ms; this is a mixed distribution, not each operation's SLO. Warmup/three steady samples/restart precede the continuous window and are not counted as its1800s. Final queue=0, idle transactions=0, waiting locks=0, signatures valid and17 objects verified. Eleven final DB connections include legitimate pool/worker/sampler connections before teardown.

Across the complete final campaign: 161 resource samples; RSS42024–42700KiB, last42452KiB; PG volume126–131MiB. The 68 optional OS samples span FDs20–36(last20), sockets14–30(last14), pipes2 and threads4–6(last6). Traffic windows plateaued; final descriptors fell after traffic. OS threads are not a count of Tokio tasks. No allocator/task census or general absence-of-leaks proof. Observer overhead belongs to this stability method, not an unprofiled latency comparison.

Estimated k6 traffic from completed summary count/rate totals 9162.809s (152.713min), including retained failed calibration traffic; G09 7492.149s and independent G10 1670.659s. This excludes setup, idle gap and ordinary tests, and is not wall-clock/G05 endurance. See `load-time-ledger.json` for each sample and `resource-summary.json` for counters. Preparation-inclusive wrappers have separate timestamps.

At 2026-10-23T14:05:24.846963+00:00: no running containers, no owned benchmark names/volumes/networks, and no shared test PG. The historical exited dev container, old anonymous volumes and `nelcota_edge` network were preserved; remaining volume creation dates all predate23October. No broad prune or production/public write. Final reports/patches/bundles/manifests are private local handoff. Broader G08 work remains incomplete; no release/CI approval.

Complete final campaign Docker CPU samples: application min0.59%, median1.86%, max99.28% of one core; these include preparation/recovery and are not isolated operation attribution. Container IO/raw limits remain in resources.jsonl. k6 continuous-window counters:4,089,021 bytes sent and55,321,305 received; host-network Docker NetIO is not substituted for those HTTP counters. Soak duration derived from count/rate=1800.003s.
