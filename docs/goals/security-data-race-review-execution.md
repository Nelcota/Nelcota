# G08: Security, data exposure and concurrency execution record

Status: incomplete; no security approval. The three review passes were not
completed. Follow [the original goal](security-data-race-review.md); a new
explicit execution budget is required before further audit traffic.

## Recorded activity

- Main source baseline: f94a9b929a15e153f7f916a4f45ed83f110aaeb6.
- Local audit branch: local/g08-security-review, with goal documentation commit
  b5d1f4ffff9d7d15d30e8c86151281399f06afa4. Production code was not corrected.
- Start: 2026-10-22 02:00 UTC; original deadline: 10:00 UTC the same day.
  Recorded activity reached 02:09:24 UTC. Later wall-clock time is not test time;
  this was not eight hours of execution. Closure took place on the next
  resumption, after the deadline, without new tests or fixes.
- Authentication library: 53 tests passed. A preparation attempt was stopped
  by its RSS limit; a separate compilation then passed. A targeted concurrency
  regression failed and did not complete its intended repetitions. Root cause
  and a correction were not fully established or revalidated.
- Earlier G06/PR checks and source inspection are context, not completed G08
  coverage. OWASP mapping, the full matrix and final-artifact validation remain
  unfinished. No passed cell or security approval is inferred from unit tests.

## Coverage ledger

Partial evidence is not a completed cell verdict. All other cells remain not
run for full G08 coverage; raw diagnostic detail is private.

| Cell | Area | Pass 1 | Pass 2 | Pass 3 | Final verdict / evidence |
| --- | --- | --- | --- | --- | --- |
| C01 | Identity and sessions | Partial evidence | Not run | Not run | Incomplete; library tests only |
| C02 | RLS, GRANTs and project isolation | Not run | Not run | Not run | Not run |
| C03 | SQL and other injection | Not run | Not run | Not run | Not run |
| C04 | Panel/browser security | Not run | Not run | Not run | Not run |
| C05 | Data and credential exposure | Not run | Not run | Not run | Not run |
| C06 | Storage on disk/S3 | Not run | Not run | Not run | Not run |
| C07 | Outbound network trust | Not run | Not run | Not run | Not run |
| C08 | Webhooks and side effects | Not run | Not run | Not run | Not run |
| C09 | Host/operator authority | Not run | Not run | Not run | Not run |
| C10 | Updates/install/runtime | Not run | Not run | Not run | Not run |
| C11 | Backup, restore and PITR | Not run | Not run | Not run | Not run |
| C12 | Async/resource ownership | Not run | Not run | Not run | Not run |
| C13 | Concurrent account operations | Partial review | Incomplete | Not run | Incomplete; targeted regression failed |
| C14 | Concurrent control/data operations | Not run | Not run | Not run | Not run |
| C15 | TypeScript and Rust SDKs | Not run | Not run | Not run | Not run |
| C16 | Operational alerts | Not run | Not run | Not run | Not run |
| C17 | Input/resource abuse | Not run | Not run | Not run | Not run |
| C18 | Cryptography and secrets | Not run | Not run | Not run | Not run |
| C19 | Dependencies/build/release | Not run | Not run | Not run | Not run |
| C20 | Failure handling and observability | Not run | Not run | Not run | Not run |


## Evidence and cleanup

Raw logs, an unfinished local regression patch and a checksum manifest are
retained in the ignored target/g08-security-review/20261022T020000Z directory
of the audit worktree. Its Portuguese partial report records failures and
limits. No unpublished reproduction details are included here.

The PostgreSQL fixture was verified by its exclusive audit label, logs were
saved, and only that owned container was stopped/removed. Local dependency links
were removed without touching the shared cache. No audit traffic remains running.
No VPS access, real notifications, public push, merge, release or deploy occurred.

The review is incomplete. Open diagnostic work must be investigated in a new
bounded run; do not relabel it as fixed, passed or release-ready.
