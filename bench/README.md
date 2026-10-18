# Benchmark

The current supported measurement workflow is the release campaign below, using
[k6](https://k6.io), Docker and dedicated Linux CPU slots. Historical results
describe their original fixtures, not current VPS capacity.

The older read-only fixture queried:
`GET /rest/v1/bench_products?stock=eq.N&order=id&limit=20` over 100k rows
(indexed filter, page of 20), as `anon`.

The legacy `bench/run.sh` assumes the former single-project Compose layout and
`nelcota_web` network. Current hosts use per-project Compose files, `nelcota_edge`
and project-specific app aliases, so that runner needs a separate tooling fix.
Do not use it as current validation. Use `campaign.py` below instead.

## Measured result (2026-10-06)

The later release campaign below is a separate fixture and operating envelope;
do not compare its resource-limited workload numbers to this laptop result.

Environment: a Windows 11 laptop + Docker Desktop (WSL2), 8 vCPUs, k6 on the
same machine. Postgres `1gb` profile and 1 GB VPS memory limits applied to the
containers (app 128 MB, Postgres 640 MB, Caddy 128 MB). **This is not a VPS**:
repeat on your target machine before drawing conclusions.

| Metric | Value |
|---|---|
| Throughput | **5,175 req/s** (32 VUs, 30 s) |
| Latency p50 / p95 / p99 | 4.9 ms / 12.6 ms / **29.6 ms** |
| Errors | 0 of 155,310 |

### Memory

| Container | Idle | Peak under load |
|---|---|---|
| app (nelcota) | 2.2 MiB | **5.2 MiB** |
| postgres (1gb profile) | 39 MiB | 69 MiB |
| caddy | 14 MiB | 13 MiB |
| **Total** | ~56 MiB | **~88 MiB** |

These laptop container readings do not establish available RAM on a VPS.
Measure process/container usage, PostgreSQL buffers, page cache and OS overhead
under your own workload before sizing a deployment.

### Automated tests

`cargo test --release --test api performance -- --nocapture` (300 sequential
reads over 20k rows, no concurrency): ~1.5 ms per request on average, Docker
networking included.

## Release campaign

On Linux with Docker, at least four affinity slots and an effective CPU quota
of 3.5 CPUs for disk or 4 CPUs for S3:

```sh
cargo build --locked --release -p nelcota-server
nice -n19 ionice -c3 python3 bench/campaign.py --binary target/release/nelcota --output target/campaign
```

The campaign owns its disposable PostgreSQL, runtime-generated credentials and
disk files. App, PostgreSQL and the native k6 generator use separate CPU affinity
slots with CPU/memory quotas (app 1 CPU/128 MiB, PostgreSQL 1 CPU/384 MiB,
generator 1 CPU/512 MiB with Go's memory target at 448 MiB, Prometheus
0.25 CPU/512 MiB, request pool 8,
database connections 40). Keep unrelated
work off those CPU slots. The app runs without root privileges. Reports contain
metrics, plans and redacted logs; credential fixtures are deleted on teardown.

PostgreSQL data uses an owned disk volume, removed at teardown. WAL targets
64 MiB and the fixture's monitored disk budget is 512 MiB. Database files do not
use tmpfs. Local object files must also reside on a real disk filesystem:
counting growing data/WAL against a small RAM quota would turn the
soak into a memory-filesystem experiment. k6 containers are named and removed
on errors/timeouts as well as normal completion.

Three steady runs per scenario measure anonymous indexed reads, authenticated
RLS with hidden rows, panel pages, actual disk listing/download/overwrite,
password login, rotation and mixed traffic. Fresh and analyzed statistics have
separate runs/plans. Mixed traffic has 50% reads, 20% RLS, 10% panel, 5% storage,
5% hashing, 5% rotation and 5% signed webhook-producing writes. Memory/RSS,
CPU, connections, idle transactions, locks and queue occupancy are sampled.

The stress cycle uses 16/32/64/128 VUs, recovers at four VUs and restarts the
server. The default soak lasts **1,800 real seconds**, at 80% of independently
qualified mixed iterations/second. Five-minute open-loop probes qualify rates
against G05 SLOs, useful work and delivered arrivals. Rejected requests do not
enter successful-response latency. Failed capacity probes remain in the evidence. The queue must also drain within 30 seconds after traffic
stops. A failed response, RLS check, signature or resource invariant fails the
candidate campaign. Database lock/unavailability, slow export cancellation,
multipart/provider failures and lease recovery additionally have dedicated
real-service Rust regressions; see the execution report.

For an isolated S3 workload with actual uploads/downloads on RustFS:

```sh
python3 bench/campaign.py --binary target/release/nelcota --output target/s3-campaign --backend s3 --workloads storage --soak-seconds 0 --no-stress
```

RustFS adds a 0.5-CPU/512-MiB fixture on a fourth CPU affinity slot; S3
campaigns require four effective CPUs including the observer/OS reserve. The small S3 campaign does not claim a
30-minute S3 soak or production cloud/network capacity. Long campaigns belong
on a dedicated host. `.github/workflows/stress.yml` provides a manual job for a
self-hosted Linux runner labeled `nelcota-benchmark`, keeping this workload
outside ordinary PR checks.

The manual workflow also accepts `target=native-preflight`. This selects a
separate disposable `ubuntu-latest` GitHub-hosted VM and skips the self-hosted
benchmark job. It only inventories CPU, available memory/disk, PID 1, systemd,
noninteractive sudo and KVM/tool availability. It installs nothing and starts
no service or load. The bounded JSON artifact and check notice record the
workflow SHA; this inventory does not certify native deployment or power-loss
recovery. Its five-minute deadline is independent of benchmark endurance.

`target=native-vm` separately builds a frozen release on a disposable
`ubuntu-24.04` runner (two Cargo jobs). It verifies the official Ubuntu 24.04
cloud-image checksum over HTTPS, creates one fresh KVM guest with a 12-GiB
virtual disk and a controller-generated SSH host key, and exercises actual
systemd init/up, TLS ingress, RLS, private file bytes, database/files backup
and restore, guest power cut, boot activation, acknowledgement reconciliation
and removal. This is a small functional/durability campaign, not capacity or
four-hour endurance. Its report records actual source/binary/image hashes.

`target=native-suite` builds and retains **one** source-bound ELF, then runs
all six native scenarios twice on independent disposable runners/guests.
The twelve cases are serialized with `max-parallel: 1`; a failed case retains
its verdict without cancelling independent evidence. Every case verifies the
downloaded ELF against the common build manifest before creating its VM.
Application cases also compare the actual running `/proc/PID/exe` inode and
bytes with the deployed/provided artifact, including after the runtime power
cut. Workflow run/attempt and pass/case remain distinct in each owned identity.
Each case publishes its own bounded step annotations and public artifact;
the retained executable is a review artifact, never a published release.

`native_case=remove-boundary` injects a marked configuration directory only
inside its owned guest. Removal must reject it before changing the unit,
cluster, registry or machine owner. A finally handler restores the original
configuration, then ordinary backup/removal must succeed. Missing files and
unlink-only symlinks retain their supported cleanup behavior.

`target=native-identity` separately repeats the exact real executable-identity
unit test 1,000 times after one compilation. The repetition controller verifies
its two-CPU/4-GiB/128-task budget, allows ten seconds per test and stops after
240 seconds, with a 300-second systemd backstop. Child readiness uses bounded
real I/O; production executable validation remains fail closed. This is a
regression control with no BaaS traffic/endurance credit.

The guest has two vCPUs/3 GiB RAM; its QEMU service is capped at two CPUs,
4 GiB RAM, 128 tasks and 1,800 seconds. App/PostgreSQL/Caddy have separate
systemd CPU, memory and task limits in a 1.5-CPU/2-GiB slice, leaving
0.5 guest CPU and 1 GiB for the guest OS. Individual unit quotas intentionally
sum to 2.25 CPUs within that aggregate ceiling. Five-second observers
enforce 10% free RAM, 15% disk/inode reserves, 2-GiB PostgreSQL disk, 256-MiB
storage and a 4-GiB external network budget after the controller starts.
An independent observer stops the owned VM and controller on loss of sampling
or the duration limit; TLS and SSH host verification remain enabled.

Only structured diagnostics are uploaded. Keys, seed data, guest disks,
credentials, request bodies and private logs stay on the disposable runner.
The guest power cut discards guest RAM after acknowledged writes and proves
a new kernel boot; it does not certify an in-flight write, physical host
power loss, public DNS/ACME, PITR or an off-host/fresh-target restore.
`native_case=runtime-inflight` is an additional, separate control. After the
same thirty externally fsynced acknowledgements, an owned transient helper
holds a table lock for at most thirty seconds. One additional real HTTPS
write must be observed waiting on that lock before the guest is killed;
the witness may be at most two seconds old and the request must still be
unfinished. Recovery must preserve every acknowledged row and value, reject
the anonymous probe, keep another user's view empty, hide the private file,
roll back the blocked write and leave no helper or lock.
The helper has a five-percent CPU quota, 48 MiB RAM, no swap, sixteen tasks
and a forty-second systemd deadline within the existing aggregate slice.
Its failure cleanup cancels only the owned marker/table's lock holder.
This proves a blocked write's rollback across guest RAM loss. It does not
claim a cut during COMMIT, physical host power loss, off-host durability,
ordinary performance or completion of the original twelve-case suite.
The optional `evidence_run` input downloads the already-public structured
report from a previous native run before repeating the campaign. Reports are
also published in bounded, checksummed notice fragments: a single long Actions
annotation truncates at 4,096 characters. Downloading/replaying a report never
changes its original source, verdict or cleanup receipt.
Notice transport uses gzip/base64, raw-JSON SHA-256 and at most nine fragments
plus one summary, respecting both the byte limit and ten annotations per step.
An oversized report fails publication rather than silently losing its tail.

`native_case=cluster-routing` uses a separate fresh guest and two generated
PostgreSQL 17 clusters: named `17/main` at 5433 and unrelated `17/sentinel`
at 5432. Before/after queries explicitly qualify both clusters. Native init
must reject that unsupported layout before changing the sentinel password,
its row, the project root or native configuration. The extra cluster has
its own 384-MiB/one-CPU/256-task limit within the same aggregate slice; the
declared quota sum is 3.25 CPUs, and the aggregate database disk guard remains
2 GiB. This case tests routing safety, with no effective endurance time credit.

`native_case=default-root` executes the documented native init from the owned
application directory, with neither `-C` nor `NELCOTA_ROOT`. It checks the
actual generated environment-file path, systemd verification, activation and
verified HTTPS readiness. A successful init alone does not pass this regression.
`native_case=host-root` first starts one native installation, then tries init in
another owned directory with `--skip-checks`. The first database credential,
Caddy configuration and sentinel row must remain unchanged, and the second
host/unit must not be created. Both probes remain inside the disposable guest.

`native_case=clock-drift` uses a fresh owned guest, with the same resource
budgets, to advance only its wall clock beyond a fresh access token's expiry
(at most 1,800 seconds). The token must be rejected while a longer-lived
service token still reads the exact seeded row and anonymous access fails.
A finally handler restores the guest clock and original NTP state; ordinary
access must recover with at most five seconds of offset from the external
observer. The host/controller clock and monotonic watchdogs are unchanged.
This functional control has no endurance/throughput credit and does not claim
protection against a malicious host clock or physical power loss.

`target=provider-preflight` discovers telemetry capabilities on another
disposable Ubuntu 24.04 VM, refusing a Docker host with existing containers.
It uses the exact historical RustFS image digest and a private, nonce/peer
checked OTLP listener. The parser retains bounded numeric memory gauges/sums
and allowlisted nonprivate attributes; missing/unavailable values stay absent
or null. Cumulative allocations never imply current live bytes. No BaaS
traffic runs, and startup telemetry does not certify reclamation or explain
the historical anonymous-memory plateau.

The controller's actual systemd budget is 0.5 CPU/256 MiB/128 tasks; the provider
has another CPU affinity slot, 0.5 CPU/1 GiB/128 tasks. Provider data and its
writable layer each have a 512-MiB guard, network traffic is bounded to 4 GiB,
and host reserves remain 10% RAM/15% disk/inodes. An independent watchdog limits
the control to 300 seconds, with a 360-second systemd backstop. Discovery samples
for 90 seconds after preparation; lack of allocator export stays `blocked`.
Only structured public first/last observations and cleanup receipts are
uploaded; generated credentials, receiver nonce and raw attributes stay private.

`target=provider-runtime` runs a separate owner diagnostic on a fresh disposable
Actions VM. Three sequential fresh RustFS fixtures use the same pinned image:
default settings, `RUSTFS_RUNTIME_WORKER_THREADS=4` alone, then
`RUSTFS_RUNTIME_FSYNC_BLOCKING_THREADS=4` alone. Each performs sixty bursts of
sixteen signed 64-byte PUT/GET/DELETE operations over 180 seconds, verifies
downloaded bytes and private-bucket rejection, then observes ten idle minutes.
The final provider API inventory and multipart state must be empty. This does
not change ordinary campaign settings or certify an equivalent performance
profile; passed environment variables alone do not prove runtime behavior.

The provider has 0.5 CPU/1 GiB/256 tasks, with 512-MiB data/writable-layer
guards. The separate controller has 0.5 CPU/256 MiB/128 tasks. Per-case watchdogs
allow 1,080 seconds; the whole diagnostic allows 3,600 seconds and 4 GiB of
observed network traffic, backed by a 3,900-second systemd limit. Five-second
samples retain the existing 30-second gap and 10% RAM/15% disk/inode reserves.
Signed requests are capped at 4,096 per case, and byte mismatches stop new
traffic immediately. Public evidence contains OS owner counts and typed
allocator capabilities, with no raw thread names, credentials or payloads.
The long diagnostic explicitly allows at most 256 telemetry exports/16 MiB
per case, covering its bounded observation period; short capability discovery
keeps its original 128-export/16-MiB defaults. Per-request parser limits and
the controller's memory quota remain unchanged. Failed collector runs retain
their original verdict and are repeated after a correction.
It earns zero BaaS endurance time and cannot establish exact live allocation
ownership or explain anonymous retention without further evidence. G05 plans
two independent dispatches of this diagnostic before drawing recommendations.

`native_case=default-root` follows the documented command from the application
directory without `-C` or an inherited `NELCOTA_ROOT`. It checks the actual
systemd environment-file path, `systemd-analyze verify`, activation and verified
HTTPS readiness. `native_case=host-root` first starts a native fixture, then
attempts another installation in a different generated directory with network
checks skipped. The first database credential, Caddy configuration and sentinel
row must remain intact; the second host/unit must be refused. No real host,
existing data, credential verifier or Caddy configuration body is published.

Save a release baseline binary before refactoring, then compare equivalent runs:

```sh
python3 bench/compare.py target/baseline target/candidate --output target/comparison.json
```

Median p95 may worsen at most 10%; throughput may decrease at most 10%.
Unexpected failures are recorded separately. A failed baseline sample cannot
certify a candidate. The comparator requires three valid samples on both
sides, finite positive latency/throughput and matching resource, image,
dataset, backend and nominal-duration evidence. Incomparable reports fail.
Use an empty output directory for every campaign; existing reports are never
appended to or overwritten. Open-loop delivery must reach 99% of the requested
iterations with at most 1% dropped arrivals. Post-load byte checks verify the
bounded fixture objects, and diagnostics cannot bypass teardown. `--allow-baseline-failures`
collects failures/restarts of an old binary and explicitly reports them;
never use that option to certify a candidate. `--workloads` and `--steady`
select smaller investigations, while `--soak-seconds 0` disables the long soak.
TLS verification in the original read runner is enabled by default; only a
controlled development test should set `INSECURE_TLS=true`.

## G05 endurance and independent projects

Freeze the harness and keep a unique run ID. Never overwrite a failed run:

```sh
python3 bench/launch.py --run-id disk-pass-1 --binary target/release/nelcota \
  --soak-seconds 14400 --fixture-disk-mib 2048 --capacity --spikes
python3 bench/launch.py --run-id s3-pass-1 --binary target/release/nelcota \
  --backend s3 --soak-seconds 14400 --fixture-disk-mib 2048 --capacity --spikes
python3 bench/launch.py --run-id host-ten-pass-1 --kind host \
  --binary target/release/nelcota --projects 10 --seconds 300 --capacity --webhooks
```

Run these sequentially on this profile. The single-project watchdog has a
six-hour deadline, bounded preparation, 5-second resource samples and a maximum
30-second observation gap. Host reserve floors are 10% available memory and
15% free bytes/inodes. Preflight additionally reserves room for declared data
growth, container roots and telemetry. A breached budget stops traffic and
removes only explicitly owned resources. Keep an external deployment observer
for power-loss acceptance; a local watchdog does not survive host loss.

Endurance uses bounded native Prometheus histograms. k6's raw end-of-test trend
collector is disabled; the script still aborts immediately on correctness
violations. Output includes `ownership.json`, `metadata.json`, frozen source
hashes, `traffic-ledger.jsonl`, `resources.jsonl`, capacity probes, retention
cohorts, event reconciliation, cleanup and a final `completion.json`. Missing
or failed evidence cannot certify a campaign. Duration counts completed,
positive-traffic intervals; preparation and waiting are excluded.

The fixture explicitly clears terminal webhook history through the documented
admin API at 5,000 retained records, while an independent commit ledger keeps
event identities. This does not change the product's 100,000-history admission
limit; testing that limit without maintenance is a separate scenario. Two
safely aged auth/event cohorts exercise the real pruning loops during long
endurance. User access credentials rotate through supported login/refresh.

The host runner creates 1, 5 or 10 independent app/PostgreSQL clusters with
distinct keys, passwords and stores, intentionally reused user IDs and marked
database/file bytes. Apps share an aggregate 1-CPU budget and databases another
1 CPU; each app has 128 MiB and each database 256 MiB. k6 and telemetry retain
their own slots. Three balanced samples establish the median. Noisy-neighbor
phases leave healthy arrivals unchanged and send 80% of offered work to project
zero, checking absolute SLOs and the 90%-throughput/120%-p95 fairness gates.
`--seconds 30` is a functional smoke and does not certify five-minute steps.
This 1,000-row topology measures local application/database isolation; it does
not certify the host controller, Caddy/public TLS, larger datasets or VPS sizing.

`--webhooks` enables an owned loopback receiver and a real signed webhook worker
in every project before the balanced baseline. The noisy write phase then also
pressures the hot project's webhook queue. Receiver evidence has a 128-MiB
aggregate budget and a 2,048-event memory window per project, with persisted
identities for reconciliation. All projects must deliver positive traffic with
valid signatures, drain within 30 seconds and match committed event IDs.
Documented duplicate deliveries are counted; lost or foreign IDs fail. This
profile uses the existing staging-only loopback exception, without weakening
public webhook destination policy. Request owners are joined before closing
their ledgers. Comparisons reject different webhook profiles. A run without
this option does not cover noisy webhook workers.

Once all three balanced samples pass, noncritical fairness findings are retained
while the remaining noisy cases and final ledger reconciliation run. Any failed
fairness gate still fails the complete campaign and the comparator independently
rejects a nonempty `acceptance-failures.json`. An invalid balanced baseline stops
before interference measurements; correctness, resource and ownership failures
always stop further offered traffic.

`--caddy` routes each project through a real shared Caddy container and a distinct
unprivileged loopback HTTPS port. Pull `caddy:2-alpine` before the campaign; the
fixture records its digest and runs that immutable image ID. It reserves another
0.25 CPU on affinity slot four, 128 MiB RAM and 64 MiB fixture disk. This profile
requires five affinity slots and four effective CPUs including reserves. TLS
uses a fresh internal CA added to the generator's trusted bundle; the fixture
also proves that a client without that CA rejects the certificate. Storage
compression exclusions and security headers follow the deployment template.
The admin endpoint is an owned Unix socket. No public port, DNS enrollment or
ACME request is used. This local ingress rehearsal does not certify public
deployment, controller operations, proxy failure recovery or slow-client limits.
Comparisons reject direct HTTP versus Caddy HTTPS profiles.

`--cpu-period-micros 10000` explicitly selects a 10-ms CPU bandwidth period for
each independent application/database container; the default remains 100 ms.
The shorter period preserves the same aggregate application/database CPU caps
and requires at least the kernel's 1-ms quota per project. This option lets a
fractional-CPU staging profile investigate long scheduling pauses under bursty
password hashing. Record the actual `cpu.max` and repeat all affected campaigns;
comparisons reject different periods. A failed SLO at the default period remains
a failed result, and changing this policy does not certify production capacity.

`--project-cpu-policy shared` selects a separate experimental allocation. Each
project may use one CPU, but every app is pinned to the same single app slot and
every PostgreSQL is pinned to a different single database slot. Each entire role
therefore remains bounded to one logical CPU. Configured quotas sum to the
project count within that slot; this deliberate oversubscription lets idle
projects lend scheduling time to active projects. The generator retains its
separate slot. The default `quota` policy keeps each project's 1/N hard quota.
Memory, disk, traffic ceilings, absolute SLOs, 90%/20% fairness and the 30-second
webhook drain gate remain unchanged.

Before traffic, `cpu-allocation.json` verifies the real owned cgroup namespace
for every app/database: its effective affinity must be exactly its declared
single slot and its finite quota/period must match. Unknown, missing or widened
kernel evidence fails preparation. The allocation is frozen in the manifest;
comparators require its complete native census and reject different policies.
The previous single-project quota profile can be normalized to its exact 1/1
geometry; missing multi-project allocation cannot certify a comparison. Run two
fresh complete campaigns for a new sharing profile before interpreting its
results. Historical fractional-quota failures remain failures and are not a
baseline for a different allocation.

The manual workflow supports separate disk/S3 four-hour endurance jobs with a
seven-hour job budget including the build. The internal campaign limit remains
six hours. Ordinary pull-request jobs do not launch endurance.

Campaign credentials are generated at runtime and passed to native k6 through
the Docker child environment. The generator command contains the environment
variable name, without its value; no plaintext credential fixture file is
written or mounted. Treat Docker daemon access as privileged, as for the
application and database containers' existing runtime configuration.

Resource evidence requires at least two successful samples and a maximum
30-second gap, including the beginning/end of observed traffic. Sampler
exceptions invalidate the campaign unless the observation crossed its explicit
server-restart window; cross-restart observations are discarded. The sampler
must finish before the final evidence gate, so a late failure cannot be hidden.

Independent-project campaigns use at most four concurrent owned observation
probes. Their cgroup reader uses shell builtins, preserving the numeric fields
without spawning one `cat` process per file. The manifest records this protocol
and worker limit; samples retain total and per-probe durations. A failed probe
signals traffic cancellation before the remaining owners are joined, and no
partial batch certifies a sample. The 30-second watchdog limit is unchanged.
Metric-retention errors are recorded without replacing an existing campaign
failure; absent metrics still fail a previously healthy run. Host comparisons
reject different observation protocols.

## Troubleshooting and evidence

Use a fresh output directory and inspect failed/skipped resource gates. A
baseline failure cannot certify a candidate. Record binary hashes, CPU/memory
budgets, provider/runtime versions and dataset before comparing runs. The legacy
laptop table above has no current source/artifact identity and is historical.
See [execution evidence](../docs/goals/execution-report.md) for saved campaign
reports and practical limits; [contributing](../CONTRIBUTING.md) covers test isolation.


## G05 extended fixture profiles

The full fixture creates the 10,000 empty objects physically, with matching
size/hash metadata. S3 preparation has eight workers, at most 32 queued objects
and a 15-minute deadline. PostgreSQL and object data have separate monitored disk
budgets. S3 uses a labeled named volume. Docker operations verify ownership and
use immutable container IDs; a foreign volume is refused before mounting.
A critical stop can signal a verified generator through pidfd independently
of the Docker API.

Long runs hold one continuous RLS session and renew its token near actual expiry.
Its separate scenario cannot mask dropped nominal arrivals; combined admission
remains 128 VUs. Two aged cohorts exercise auth, webhook and physical-object GC.
PID/container/StartedAt checks preserve process continuity. Per-container cgroup
counters include PostgreSQL child OOMs; controller counters describe the controller.
Component cgroup observations also retain memory current/peak, anonymous/file
cache counters, CPU quota/throttling and task gauges. The manifest identifies
this observation protocol so comparisons cannot silently mix instrumentation.
PostgreSQL observations include table/vacuum, WAL, checkpointer, I/O and blocker
statistics. Lock waits and slow statements remain in private fixture logs.
On an unexpected generator failure, safe host reserves permit a private
64-MiB-limited database snapshot with a 30-second deadline. Critical resource
stops skip this extra work; failed/partial diagnostics remain explicit.

`--wal-mib 64|128|256|512` names a separate database resource profile; its disk
budget must cover at least three WAL budgets. `--soak-fraction 0.7|0.75|0.8`
chooses the declared share of independently qualified capacity. Defaults remain
64 MiB and 0.8. Changing either value requires fresh comparable measurements.
Owned containers cap their local Docker logs at two 8-MiB files. Spike campaigns
record 15 seconds without offered traffic after each recovery, and all campaigns
record 30 seconds of final rest. Queue drain, connections, locks, process owners
and component cgroups are retained in `resource-plateaus.json`. Rest is excluded
from effective load duration; interpreting live-owner growth still requires the
full timeline and application evidence.
Public object reads also verify their actual payload during traffic. Successful
HTTP status cannot mask wrong/truncated bytes or a transport error. The workload
JavaScript hash participates in regression-profile matching.

```sh
python3 bench/oracle_check.py --output target/stress-oracles/bytes
```

This short native k6 control uses a bounded HTTP fixture to prove that the
benchmark oracle accepts correct bytes and rejects corrupt/truncated HTTP 200
responses. It does not certify the Rust backend, real S3 or endurance.
Allocated-disk measurements retain totals and count children removed during
concurrent overwrite/GC. Missing roots, ambiguous totals, permission/I/O errors
and unknown diagnostics still abort. These observations are non-atomic; the
host reserve guard and independent metadata/byte invariants remain required.
Arrival clients are fully preallocated and obtain separate real sessions before
the timed scenario, with at most four concurrent bootstrap logins. A global
arrival ordinal preserves the declared operation mix; initializing a new VU
cannot silently add hashing to nominal traffic. Bootstrap uses its own metric
project tag and is excluded from nominal throughput/latency and effective load
duration. The preparation profile and exact JavaScript hash must match.
Every successful operation checks its response contract, including filtered and
ordered fixture rows, RLS identities, the panel's `size=20` pagination, session
identity and safe expiry, and upload size/SHA-256 receipts. Writes explicitly
request and validate their returned representation. A generic 2xx response is
insufficient. The native oracle control also accepts
`--semantic-baseline-script PATH` to preserve and reproduce older false passes;
its controlled HTTP fixture is never backend or endurance evidence.
`--calibration-ceiling N` caps the provisional arrival rate before measurement;
it does not waive any SLO/delivery gate or certify the observed median as stable.
Retain failed higher-rate investigations separately. `--s3-memory-mib 512|1024`
names the provider memory budget; different budgets require fresh measurements.

The endurance session-renewal counter uses the last regular Prometheus sample
within one retained hour and rejects observed counter resets. k6 emits sparse
counters only when events happen, so an instant query can miss valid renewals
after the default five-minute lookback. Missing/non-finite range evidence still
fails. The continuous-client iteration and minimum-renewal gates remain in force;
this observation protocol must match across compared campaigns.

Scheduler drops need continuous observation: a drop early in a four-hour phase
can expire from both the instant query and the one-hour telemetry store. Before
traffic starts, the runner opens a bounded phase counter; the resource sampler
then reads sparse scenario totals with a 120-second lookback and preserves
their previous values when a series expires. Counter resets, regressions,
unknown scenarios and polling gaps over 30 seconds invalidate the evidence.
The final report embeds closed beginning/end coverage and exact retained totals.
State is limited to 128 phases and 11 scenarios per phase. Comparators require
this declared protocol and reject missing coverage or totals that disagree with
the report; an absent sparse series cannot manufacture a zero. Historical
endurance summaries using only the final instant query do not certify this
protocol. Diagnostic one-shot summaries of at most five minutes use a bounded
range query and remain distinct
from comparable campaign evidence.

Owned k6 runners explicitly disable anonymous usage reporting with
`K6_NO_USAGE_REPORT=true`. This keeps generator reporting within the declared
local metrics destination; the disabled setting is recorded in run profiles.

Run the native sparse-counter regression from the repository root:

```sh
python3 bench/arrival_check.py --output target/stress-oracles/arrivals
```

It uses native k6/Prometheus, one sleeping VU, a six-second arrival burst and
at least 130 seconds of controller-owned observation after the generator exits.
An arrival stage ending at zero can exit early; it cannot supply that idle
coverage. This idle interval is not application stress time. The final instant query and 120-second
range must expire while the continuously observed total stays positive.
This artificial control verifies the measurement pipeline, not service capacity
or effective endurance time. Each container has 0.25 CPU/128 MiB, the controller
has a 240-second watchdog, and a polled 128-MiB metrics-volume limit preserves
host reserves. Startup reserves 2 GiB for image/container preparation. CI retains
only its structured profiles/completion/proof; raw metric snapshots stay private.

Single-project campaigns also retain physical HTTP attempts per native series
and sparse expected 401 rejections throughout every phase. A final instant
query loses rare outcomes after its lookback expires; summing logical operations
also misses real S3 redirects. The collector preserves bounded per-series
maxima, checks resets and phase/project labels, and embeds closed polling
coverage. Successful workloads reconcile status totals and negative probes with
independent assertion accounting. Long summaries require this coverage;
diagnostic summaries of at most 300 seconds use a bounded range instead.
Comparators reject missing coverage or inconsistent counts. Historical summaries
are preserved and cannot certify the new protocol.

`python3 bench/http_check.py --output target/stress-oracles/http` sends 2 requests
per second for 136 seconds to an owned loopback responder, with exactly three
initial 401 responses. It requires both final instant and 120-second queries to
lose those responses while retained totals still match the server. It also
injects one Docker stats timeout and verifies the owned generator's actual
cgroup counters. A timeout fallback never invents Docker CPU percentages:
kernel CPU time, memory, tasks and OOM evidence remain separately identified.
Wrong ownership, PID reuse, native-reader failure and the existing 30-second
observation-gap limit still stop the run. The control has a 300-second watchdog
and the same 0.25-CPU/128-MiB container bounds; its traffic is not BaaS endurance.

Successful operation latency uses k6's monotonic test-run clock around the full
logical request, including DNS, connection/admission waits and redirects. The
returned response's `timings.duration` describes only its final hop and can
hide time spent before an S3 redirect. The declared latency protocol must match
in comparisons. The native response oracle injects a 250-ms redirect delay into
the actual storage workload and requires its successful p95 to include it;
`--latency-baseline-script` can also demonstrate the preceding undercount.

The metrics receiver keeps a 512-MiB monitored disk budget. Its common storage
profile also bounds compacted block chunks to 16 MiB: Prometheus otherwise
preallocates a 512-MiB chunk segment before truncation, independently of the
128-MiB retention target and 16-MiB WAL segments. Campaigns record this profile
and comparisons require it. Fleet sampling checks metrics disk use as well.
`python3 bench/compaction_check.py --output target/stress-oracles/compaction`
verifies the actual receiver flags, preserves a synthetic counter and forces
four real head snapshots with compacted block metadata. Its admin API is enabled
only in the owned loopback control. Synthetic traffic does not count as BaaS
stress or endurance. The physical guard and other retention settings stay fixed.

After confirmed teardown, `python3 bench/export_series.py RUN OUTPUT.csv.gz`
projects a closed single-project resource log into a bounded numeric CSV and
an index with source/content hashes. Run it from the repository root and retain
the private raw inputs. The allowlist exports resource owners, connections,
queues, disk and cgroup counters; raw SQL, request URLs and payloads are omitted.
Rounded resource timestamps and sampled maxima remain distinct from the traffic
ledger and separately recorded critical budget observations.

`--final-idle-seconds 180` extends the final resource observation beyond the
provider allocator's idle reclamation window. The bounded 30..300-second value
is frozen in the profile and must match in comparisons. Idle/drain observation
is reported separately and never added to effective load or four-hour endurance.
Include `write` explicitly in `--workloads` for three pure REST-write samples.
`--write-steady-rate 50` predeclares their separate open-loop rate while mixed
capacity is independently qualified. The rate is bounded by the same traffic
ceiling, preserves all SLO/delivery gates and must match across comparisons.
Include `write` in the comparator's `--workloads` as well; legacy defaults stay
compatible with existing release campaigns.

Use `--rows 1000000` for the separate million-row investigation and
`--object-bytes 1048576` for 1-MiB transfers. These profiles need separate
baselines. `--metadata-only-seed` is explicitly a listing investigation and
cannot certify full physical-fixture integrity.

The fault runner checks atomic transfers, balances, a hot counter and committed
operation identities. Disconnected replies stay ambiguous until reconciliation;
no mutation is automatically retried. It covers deadlock, database/app restart,
tagged OOM, owned tmpfs byte/inode exhaustion and local live-writer snapshot
restore. The tmpfs fault does not certify physical disk endurance.
With `--s3-faults`, the runner also starts an owned real RustFS instance,
restarts and pauses it under database writers and storage probes, and requires
verified reads and new writes within the same recovery deadline. Its separate
CPU, memory, disk and ownership budgets are part of the manifest.

```sh
python3 bench/launch.py --run-id fault-smoke --kind fault --binary target/release/nelcota --rate 8
python3 bench/launch.py --run-id fault-pass-1 --kind fault --binary target/release/nelcota --capacity --s3-faults
python3 bench/host_compare.py target/stress-g05/host-before target/stress-g05/host-after --output target/stress-g05/host-comparison.json
python3 bench/evidence.py target/stress-g05/disk-pass-1 --output target/stress-public/disk-pass-1
python3 bench/guard_check.py --output target/stress-g05/native-guards
```

Functional smoke has no capacity claim. Full fault mode holds four five-minute
arrival steps and uses 80% of the qualified lower bound. Host comparisons need
three completed five-minute samples with equivalent budgets, images, dataset
and rates. Per-operation p95 and useful-throughput limits remain 10%. Rejected
HTTP requests cannot mask lost useful work; a later failed campaign cannot
certify successful initial samples.
`--focus filesystem` or `--focus provider --s3-faults` isolates an investigation;
the manifest names the subset and cannot certify the complete fault matrix.

Completed private raw diagnostics can be archived as adjacent `.gz` files with
an index of original and compressed hashes. Verify decompressed bytes before
removing the uncompressed copy and retain every failed verdict and phase report.
Read archived observations with a gzip reader. Before archiving a closed SQLite
ledger, `bench/sqlite_evidence.py` verifies read-only integrity, rejects journal
sidecars and explicitly releases the connection before space accounting. A
SQLite connection transaction context alone does not close the descriptor.
Filesystem setup copies bounded immutable bytes through `docker exec` into the
actual tmpfs mount, then verifies reads before exhaustion. Byte reservation
rejects a full device with `507 storage_full`; failed inode allocation uses the
existing `500 internal` contract. Other errors and loss of existing bytes fail.
The mutation workload drops 5% of connections before a reply and discards 5% of
actual upstream commit replies through a private HTTP socketpair intermediary.
The backend still receives real project HTTP requests. The downstream client
receives no success; ordered receipts and the durable operation ledger must
prove at least one committed reply loss and zero missing commits. No generic
mutation retry or exactly-once contract is inferred. Each admitted operation
owns and joins its intermediary and closes both sockets.

Public bundles contain bounded structured outcomes and hashes. Raw logs,
credential fixtures, database dumps and free-form diagnostics stay private.
Failed/invalid evidence remains explicit; the exporter does not certify G05.

With host `--caddy`, a separate nominal traffic phase applies a syntactically
valid proxy configuration containing an occupied, verified owned backend port.
The real admin reload must reject the bind, the original configuration is
explicitly restored, and every project must return correct data and reject an
invalid credential over verified HTTPS. Proxy PID/start identity must remain
unchanged; nominal SLO and arrival gates still apply. This local ingress fault
does not certify public DNS/ACME or production deployment recovery.
The fixture retains the image's exact executable bytes while stripping file
capabilities from its owned copy, so unprivileged high ports work with
`cap-drop ALL` and `no-new-privileges`. The binary SHA-256, image digest and
128-MiB proxy disk budget are recorded before traffic.
Fleet preflight includes image storage-driver costs independently from database
data. VFS reserves two full container-layer copies plus a margin per project;
unknown drivers or invalid image sizes require an explicit supported profile.
An insufficient reserve blocks preparation before containers are created.

## Live browser profile (native validation in progress)

`browser_campaign.py` adds a separately owned Chromium/TypeScript-SDK profile.
It is not a completed G05 result until its native controls, data oracles and
cleanup pass. Run it between backend campaigns, after rebuilding the SDK from
the reviewed source; runtime preparation copies public development tools and
can use up to 1.5 GiB of additional disk. Production keeps its Rust-only runtime.

```sh
npm --prefix sdk/typescript run build
python3 bench/launch.py --run-id browser-pass-1 --kind browser --binary target/release/nelcota --sdk "$PWD/sdk/typescript/dist" --session-seconds 1080
```

This x86_64/UID-1000 profile uses two real application/auth consumers sharing
one project's database, three browser tabs, verified local HTTPS with separate
untrusted/trusted NSS controls, five navigation/rest cycles, CDP memory/owner
observations, real multi-tab SDK refresh and actual credential expiry. The
normal logout contract remains: refresh stops; issued access lasts until expiry.
It also declares offline/reconnect, a cancelled SDK read and navigation away
from a delayed real server response. CDP pauses actual verified HTTPS response
headers for at most five seconds; it never supplies a substitute BaaS body.
Those controls still require a successful native campaign before acceptance.
Six real 1-MiB upload conflicts exercise cancel/replace File ownership with GC
and byte read-back; five text-preview cycles record completion separately from
the table feedback SLO. No upload response is replaced by the harness.
No BaaS responses are mocked. Only the built SDK's test assets are served by
the browser harness. External page requests are blocked before transmission.

The browser runs in an owned nonroot container with a private PID namespace,
all capabilities dropped, a read-only root and no-new-privileges. Chromium's
inner OS sandbox is disabled inside that container, as in normal Playwright
development runs; certificate and browser origin checks remain enabled. No real
home or global certificate store is mounted or changed. CPU, RAM, PIDs,
API-request rate/count, decoded bytes and duration budgets are recorded before
traffic. Killing its PID-1 generator also stops its namespace's browser children.

## Effective load accounting

```sh
python3 bench/load_time.py target/stress-g05 --output target/stress-g05/artifacts/load-time-final.json
```

This report counts completed requested traffic intervals, excluding warmup,
setup, preparation, drain/rest and failed partial intervals. It credits only
the largest duration in connected overlapping driver windows, providing a
conservative lower bound instead of double-counting concurrent tests. A recorded
four-hour completion is listed separately. Neither reaching eight accumulated
hours nor this report alone certifies G05; all mandatory correctness, continuous
endurance, resource, regression and deployment evidence remains required.

## Optional allocation ownership diagnostic

On Linux glibc, build the bounded native observer separately:

```sh
python3 bench/allocation.py --build target/stress-g05/artifacts/allocator/libg05alloc.so
python3 bench/launch.py --run-id allocation-disk-1 --binary target/release/nelcota --backend disk --workloads mixed --no-stress --soak-seconds 3600 --final-idle-seconds 180 --allocation-probe "$PWD/target/stress-g05/artifacts/allocator/libg05alloc.so"
```

This development-only preload observes glibc arenas and mapped allocations. It
adds one detached thread, samples every five seconds and bounds each process's
private numeric log to 1 MiB. Helpers inheriting the container environment do
not start observers. A real 64-MiB malloc/free control and directory/period
ownership controls validate the observer; they do not establish backend results.

The driver verifies the library/source build identity, preserves bounded raw
samples after the app stops and requires coverage of completed traffic. An
instrumented run cannot certify the ordinary performance regression envelope.
Correlate its current process and post-load idle samples with cgroup/RSS evidence:
allocator-held free arenas and thread caches are not an application-object
census or an absolute proof of leak absence. The production executable and its
runtime requirements remain unchanged.

## Supplemental backend matrix

The manual `matrix` workflow target uses the retained ELF from the completed
native suite on a fresh disposable Actions VM. Its artifact digest, size and
all six current product tree identities must match the recorded build before
any fixture is created. The local performance ELF remains separately identified.

Start with `matrix_full=false` for an explicit smoke. After reviewing it, use
two fresh dispatches with `matrix_full=true`. Full mode qualifies four
five-minute RPC rates, then holds each supplemental scenario for 120 seconds
at 80% of its qualified rate. The existing foreground ledger delivery/latency,
negative JWT, ambiguous-reply, snapshot/restore, sampling and teardown gates
remain enabled. Named probes exercise SQL row/batch/admission limits, actual
HTTP disconnect cancellation, two unpolled exports and their dedicated slots,
concurrent introspection/committed DDL, malformed/deep/null/nonfinite JSON,
admin cookie/origin rejection and expiring partial header/body connections.
The `auth-links` case adds five cycles of recovery, signup confirmation and
magic-link verification. Four barrier-released HTTP consumers submit each
generated token once; exactly one must receive the correct user's session.
Expired, wrong-kind and reused links must fail. The case checks predecessor
refresh behavior, committed recovery passwords (four distinct competing values
with only the winner remaining valid), retired unconfirmed-account
credentials and final session revocation. Tokens are seeded privately in the
owned database: SMTP delivery, issuance/cooldown and external OAuth remain
separate gates. This barrier establishes concurrent client attempts, without
claiming that all four requests overlapped inside one server transaction.

Full public reports retain all four capacity steps, including failed
qualification, with phase-boundary generator process/current-cgroup CPU and
host steal counters. These diagnostics investigate variation; they do not
identify a bottleneck by themselves or relax the existing acceptance gates.
Full runs also require each entire supplemental action, including every link
pressure cycle, to finish inside its offered ledger-traffic window. Functional
smokes record timing separately and cannot certify full overlap after traffic
has drained.

The new probes allow at most 4,096 requests, 2 MiB per consumed body/response,
64 MiB consumed responses and a conservative 256 MiB bound on intentionally
unread exports. Five pressure cycles close every partial socket; cancelled
SQL must release its dedicated connection within three seconds and exports
within five. The controller has one CPU, 512 MiB, no swap and 128 tasks in an
owned systemd unit with a 3,000-second hard deadline. The existing fault fixture
retains per-app/database quotas, 512-MiB database disk guards, 10% RAM/15%
filesystem reserves, five-second sampling and the 30-second gap gate.

Thirty-three focused safety regressions run before artifact download or backend
traffic. Public receipts retain failed source locations without assertion or
SQL payloads and a bounded, checksummed numeric cgroup series. This subset does
not certify forced catalog-refresh failures,
all security/mutation scenarios, public TLS/DNS/ingress, SMTP/OAuth or the full
G05 matrix. Remote time overlapping local load earns no extra local checkpoint
credit. These profiles are prepared until their actual receipts exist.


### Additional browser/backend authentication pressure

The optional `browser-auth` manual workflow uses the retained verified final
native ELF, two auth consumers sharing one disposable database, and the real
panel/TypeScript SDK in Chromium. It adds eight concurrent account flows to each
of five existing navigation pressure/rest cycles: signup/login, rejected wrong
passwords, user and RLS canaries, supported refresh retry grace, stale-token family
revocation, an independent surviving family, logout and revoked-refresh rejection.
Each cycle is limited to112 raw requests,8in flight,16arrivals/s,64KiB per
response and40s, without automatic mutation retries. The browser independently
counts its marked requests. Final database accounting requires40created users
and zero unrevoked sessions belonging to those generated users. Existing login,
read/refresh and visual SLOs remain unchanged; negatives have separate counts.

Its explicit four-slot Actions profile keeps app/database/generator on distinct
slots and shares slot3 between observer and proxy. Configured quotas total3.75
CPUs, including a1CPU/512MiB/128-task controller; observer+proxy quotas on their
shared slot total1.25CPUs. This intentional local oversubscription is recorded,
not a claim of physical isolation or a comparison to the existing local five-slot
profile. Existing memory/disk/traffic/reserve/30s sampling-gap gates, the untrusted
CA rejection, verified local TLS, actual expiry and SDK disposal stay enabled.
The local five-slot default is unchanged. Alternate public Chromium tooling is
copied under the same runtime byte/ownership boundary and exposed read-only;
Node/Python remain development tooling, with no backend production dependency.

Both predeclared passes require remote regressions, source/provenance and the
native artifact gates. The G05 execution record tracks their actual outcomes. Their
full browser observation lasts1080s. SMTP/OAuth/public ingress are separate cells;
this profile neither bypasses unavailable services nor certifies all G05 work.

### Recovering existing public resource series

When the operator cannot download an Actions artifact, dispatch `public-evidence`
with `evidence_run` set to its completed workflow run and `evidence_kind` set to
`matrix` or `browser-auth`. This read-only five-minute job downloads only the
corresponding named public artifact, bounded at2MiB, then republishes its original
numeric gzip series through checksummed notices. It starts no backend fixture and
earns no load-time credit.

The republisher requires the series hash, byte count, sample count and maximum
gap recorded in the original report to agree. It rejects private/unknown fields, duplicate JSON keys,
nonfinite/boolean gauges, unknown phases/roles, gzip comments/extra metadata,
trailing streams and excessive decoded/encoded data. It preserves the original
source, artifact digest, status and cleanup verdict; republication cannot approve
a failed campaign. Original resource files larger than the18KiB notice boundary
remain in their provider artifact and require direct download.


### Private files across independent projects

`host_campaign.py --private-file-isolation` adds the complete directed foreign-JWT
GET/PUT graph against one distinct private fixture in each project. Every foreign
write rejection is followed by owner-byte and anonymous-denial checks; final
metadata must match. Graphs run before/after and after actual positive k6 work
inside each balanced, noisy, capacity and proxy phase of at least 60 seconds.
Each request waits at least 1/64 second after the previous response closes.
Traffic, bytes, response sizes, graph deadlines and the separate controller CPU
are explicit in `fleet_private_files.PROFILE`. Auxiliary work never counts as
k6 useful throughput. Comparisons require the same enabled protocol, CPU layout
and complete source-bound cumulative receipts on both sides. Legacy evidence
without this option only certifies its original scope.

The manual `host-files` Actions target first validates this optional harness on
a fresh empty hosted four-slot VM with at least 3.8 effective CPUs and the retained
final007 Actions executable.
It declares one project at 4 iterations/s and five at 1 iteration/s each, using
60-second phases, direct owned loopback HTTP and a 1536-MiB aggregate PostgreSQL
disk ceiling. Those rates are functional preflight settings, not the full host
capacity profile or five-minute fairness approval. All existing short-profile
absolute and relative gates still apply; any failed gate stays failed.

The controller has 0.5 CPU/512 MiB/no swap/128 tasks and a 2700-second systemd
ceiling. Each case has a tighter 1200-second lease. A separate transient systemd
watchdog, outside the controller cgroup, has 5 percent CPU/128 MiB/no swap/32 tasks
and a 1500-second expiry. It retains the existing host reserves, owner generation,
30-second resource gap and PID-bound traffic stop. A lost watcher stops
qualification. Teardown retains original failed counts and attempts every owned
cleanup step even if publication fails; an incomplete cleanup retains the guard.
Only validated fixed receipts and numeric component projections are public.
On the shared telemetry slot, controller 0.5 + metrics 0.25 + watchdog 0.05
leaves 0.2 CPU for the OS. The effective role/auxiliary bound is 3.8 CPUs. Five
shared app/PG quota sums intentionally exceed each role's single pinned CPU;
their configured sum is 11.8 CPUs, with a 3.8-CPU affinity bound. These numbers
are declared, not a guarantee about an unmeasured host.
Full host1/5/10 baselines and two candidate passes remain separately required.


### Native restore error fencing control

The optional `native-vm` case `runtime-pitr-error` runs only in an explicitly
owned fresh guest. It temporarily substitutes the installed pgBackRest adapter
with a fixed program that writes one inert owned marker and returns72. It accepts
only the exact restore argument list and cannot overwrite an existing marker or
follow its symlink. Real PostgreSQL data files are not changed. The actual CLI
error path must leave app and PostgreSQL stopped before explicit fixture recovery.
The original executable/hash, rows, private bytes and unauthorized-access canaries
must then recover. Private command output remains bounded and unpublished.

The helper is confined to the existing1.5-CPU/2-GiB target slice, with10percent
CPU,96MiB/no swap,32tasks and120seconds; actual unit PID/kernel limits are checked
before mutation. CLI failure/explicit recovery timeouts are35/60seconds. This
controlled adapter probe is not successful PITR, real S3 recovery or evidence of
data corruption. The first actual run must establish or refute the source-review
hypothesis before a product correction is claimed. The ordinary twelve-case native
suite remains unchanged. See the G05 execution record for actual verdicts.
