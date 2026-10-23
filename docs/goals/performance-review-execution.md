# G09: Performance review execution record

Status: running; preparation and baseline selection started. No optimization or performance approval yet.
Follow [the goal](performance-review.md). This template is not performance evidence.

## Artifact and environment

Execution start/deadline, current main/candidate/release identities, baseline
and final ELF hashes, tools, CPU/RAM/disk/topology/provider versions, fixed
budgets, dataset seed/cardinality, RLS/index/statistics state, warm-up and
workload profiles: pending execution. Historical G02/G05 measurements and
another PR's CI must not be inserted as current G09 validation.

## Coverage

For every cell add paths, measured invariant, source/artifact, workload,
baseline/candidate samples and final verdict. Retain failed samples and identify
co-located generators, doubles, unavailable backends and insufficient sample tails.

| Cell | Area | Pass 1 | Pass 2 | Pass 3 | Final verdict / evidence |
| --- | --- | --- | --- | --- | --- |
| P01 | Request execution | Not run | Not run | Not run | Not run |
| P02 | PostgreSQL | Not run | Not run | Not run | Not run |
| P03 | Pagination/cardinality | Not run | Not run | Not run | Not run |
| P04 | Auth/session paths | Not run | Not run | Not run | Not run |
| P05 | Disk/S3 storage | Not run | Not run | Not run | Not run |
| P06 | Webhooks/alerts | Not run | Not run | Not run | Not run |
| P07 | Panel/browser | Not run | Not run | Not run | Not run |
| P08 | TypeScript/Rust SDKs | Not run | Not run | Not run | Not run |
| P09 | Async contention/resources | Not run | Not run | Not run | Not run |
| P10 | CLI/host operations | Not run | Not run | Not run | Not run |
| P11 | Multiple projects | Not run | Not run | Not run | Not run |
| P12 | Resource stability | Not run | Not run | Not run | Not run |

## Hypotheses and comparisons

No target has been selected. At execution, record at most five selected targets
with cost/impact/risk, preserved behavior, planned mechanism, local commits,
characterization results and why each was retained/reverted/deferred.

Comparison table fields: scenario, source/binary identity, dataset/profile,
sample count, offered/achieved throughput, errors/dropped arrivals, p50/p95/p99,
dispersion, CPU/RSS/I/O, pool/query/lock/resource measurements, absolute and
percentage changes, comparator verdict and evidence hashes. No invented results.

## Final handoff

Pending execution: final-artifact validation, 30-minute stability verdict,
environment blockers, raw-evidence manifest, Portuguese report, remaining
regressions/trade-offs, prioritized follow-up and owned-fixture cleanup result.
Performance review completion and release/VPS readiness are separate decisions.

## Initial checkpoint

- Start: 2026-10-23 01:33:45 UTC; hard deadline 09:33:45 UTC.
- Verified main source: 4d4034835ebc55538dabf3c2df109faea4cc8e13.
- Published server: 0.5.1. PR #125 is merged; it is included in this main source.
- Isolated branch local/g09-performance-review; no VPS access or public writes.
- Resource/command logs and raw evidence: ignored target/g09/20261023T013345Z.
- P01-P12 remain not run pending actual measurements; historical CI is not reused.
