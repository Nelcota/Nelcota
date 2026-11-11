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

On Linux with Docker and at least three available CPUs:

```sh
cargo build --locked --release -p nelcota-server
nice -n19 ionice -c3 python3 bench/campaign.py --binary target/release/nelcota --output target/campaign
```

The campaign owns its disposable PostgreSQL, runtime-generated credentials and
disk files. App, PostgreSQL and the native k6 generator use separate CPU affinity
slots with CPU/memory quotas (app 1 CPU/128 MiB, PostgreSQL 1 CPU/384 MiB,
generator 1 CPU/512 MiB with Go's memory target at 448 MiB, request pool 8,
database connections 40). Keep unrelated
work off those CPU slots. The app runs without root privileges. Reports contain
metrics, plans and redacted logs; credential fixtures are deleted on teardown.

PostgreSQL data uses an owned disk volume, removed at teardown. WAL targets
64 MiB and the fixture's monitored disk budget is 512 MiB. Database files do not
use tmpfs: counting growing data/WAL against a small RAM quota would turn the
soak into a memory-filesystem experiment. k6 containers are named and removed
on errors/timeouts as well as normal completion.

Three steady runs per scenario measure anonymous indexed reads, authenticated
RLS with hidden rows, panel pages, actual disk listing/download/overwrite,
password login, rotation and mixed traffic. Fresh and analyzed statistics have
separate runs/plans. Mixed traffic has 50% reads, 20% RLS, 10% panel, 5% storage,
5% hashing, 5% rotation and 5% signed webhook-producing writes. Memory/RSS,
CPU, connections, idle transactions, locks and queue occupancy are sampled.

The stress cycle uses 16/32/64/128 VUs, recovers at four VUs and restarts the
server. The default soak lasts **1,800 real seconds**, at 80% of the observed
mixed HTTP capacity. The queue must also drain within 30 seconds after traffic
stops. A failed response, RLS check, signature or resource invariant fails the
candidate campaign. Database lock/unavailability, slow export cancellation,
multipart/provider failures and lease recovery additionally have dedicated
real-service Rust regressions; see the execution report.

For an isolated S3 workload with actual uploads/downloads on RustFS:

```sh
python3 bench/campaign.py --binary target/release/nelcota --output target/s3-campaign --backend s3 --workloads storage --soak-seconds 0 --no-stress
```

RustFS adds a 1-CPU/512-MiB fixture on a fourth CPU affinity slot; S3
campaigns require at least four available CPUs. The small S3 campaign does not claim a
30-minute S3 soak or production cloud/network capacity. The manual
`.github/workflows/stress.yml` job runs on a fresh GitHub-hosted Ubuntu 24.04 VM
with Docker. For performance comparisons, collect the baseline and candidate
under equivalent resource and runner conditions.

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

## Troubleshooting and evidence

Use a fresh output directory and inspect failed/skipped resource gates. A
baseline failure cannot certify a candidate. Record binary hashes, CPU/memory
budgets, provider/runtime versions and dataset before comparing runs. The legacy
laptop table above has no current source/artifact identity and is historical.
See [execution evidence](../docs/goals/execution-report.md) for saved campaign
reports and practical limits; [contributing](../CONTRIBUTING.md) covers test isolation.
