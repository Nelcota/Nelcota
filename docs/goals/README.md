# Project goals

G01 and G02 are implemented and validated through two execution passes and two
corrective reviews. See the [execution report](execution-report.md) and its
versioned measurements, compatibility checks and operating limits.
G03 is implemented with local validation and corrective reviews recorded in
[its execution report](panel-updates-execution.md). Production installation stays
blocked pending verified releases and exact-binary VPS acceptance evidence.
G04 completed three project reviews with an evolving finding ledger; its
evidence is recorded in [the review execution record](triple-review-execution.md).
A focused [memory lifecycle review](memory-review-execution.md) records subsequent
ownership/cancellation corrections and their release-of-resource evidence.
G05 is in progress: it defines fresh stress/endurance campaigns, ten-project host
isolation, controlled failures and measurable recovery gates. Its
[execution record](stress-verification-execution.md) separates measured runs
from incomplete work; it does not inherit capacity certification from earlier CI.

| Goal | Outcome |
|---|---|
| [G01: Reusable authentication](auth-reusability.md) | An independent Rust consumer integrates Nelcota authentication through a stable public API and a documented database lifecycle. |
| [G02: Architecture and operational quality](architecture-security-performance.md) | Clear module ownership, tested security boundaries and reproducible performance, load and stress evidence across the project. |
| [G03: Controlled panel updates](panel-updates-and-recovery.md) | Implemented: scoped authority, verified release discovery, durable jobs and recovery; production activation remains gated by exact-binary VPS acceptance. |
| [G04: Three project reviews](triple-project-review.md) | Three complementary reviews, reproduced corrections, evolving criteria and a final evidence-based report. |
| [G05: Full stress verification](full-stress-verification.md) | In progress: sustainable capacity, overload, spikes, ten-project fairness, continuous disk/S3 endurance and fault recovery with final-artifact evidence. |

G02 established the inventory and retained release baseline; G01's archive
consumer proves the auth boundary. The ownership map and regression gates keep
the resulting capability interfaces and immutable migration assets reviewable.

These goals preserve the [architecture](../architecture.md) and existing
[decisions](../decisions.md): PostgreSQL owns authorization through RLS, the
backend ships as one Rust binary and needs no Node runtime. The existing
frontend/SDK toolchain remains available for builds and tests.
Use [AGENTS.md](../../AGENTS.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md)
for execution limits, migration rules and contribution practices.

Record the starting commit, deliverables, validation evidence and limits when
extending these completed goals. Keep findings distinct from
proposals; each confirmed defect needs a reproducer and an appropriate fix.
Publishing packages or opening another repository is a separate release step
from proving reuse in a consumer outside the workspace.

## Reading historical evidence

Execution reports and JSON measurements retain their original commit, artifact,
date and failed/skipped/unrun checks. Completed code reviews do not certify all
future builds or production deployment. Current behavior belongs in the operating
references; public security context is in [the review summary](../security/review-summary.md).
