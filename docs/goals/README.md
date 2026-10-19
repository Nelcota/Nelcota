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

G06 is finalized after publication of server 0.5.0 and the public advisory.
All seven findings have merged resolutions; F07 retains the accepted mitigation
trade-off. The [final execution record](auth-security-review-execution.md)
supersedes its original intake statuses without rewriting the dated evidence.
G07's two targeted refactorings were reviewed and merged; its
[execution record](maintainability-refactor-execution.md) preserves the hotspot
inventory, selected targets and deferred work.

| Goal | Outcome |
|---|---|
| [G01: Reusable authentication](auth-reusability.md) | An independent Rust consumer integrates Nelcota authentication through a stable public API and a documented database lifecycle. |
| [G02: Architecture and operational quality](architecture-security-performance.md) | Clear module ownership, tested security boundaries and reproducible performance, load and stress evidence across the project. |
| [G03: Controlled panel updates](panel-updates-and-recovery.md) | Implemented: scoped authority, verified release discovery, durable jobs and recovery; production activation remains gated by exact-binary VPS acceptance. |
| [G04: Three project reviews](triple-project-review.md) | Three complementary reviews, reproduced corrections, evolving criteria and a final evidence-based report. |
| [G05: Complete stress verification](https://github.com/Nelcota/Nelcota/pull/90) | Archived campaign: original-artifact evidence and environment-blocked cells are retained on `test/g05-stress-verification`; production fixes were extracted into #91 and #93. This is not a new soak of the current release. |
| [G06: Authentication and session security](auth-security-review.md) | Finalized: all seven findings have merged resolutions; public disclosure and server 0.5.0 are recorded, including the F07 trade-off. |
| [G07: Targeted maintainability refactoring](maintainability-refactor-execution.md) | Completed bounded pass: PRs #107/#108 and the inventory #106 merged; excluded areas and remaining hotspots are future work. |

Subsequent [module ownership](solid-module-ownership-execution.md),
[SDK responsibility](sdk-srp-execution.md), [SDK corrections](sdk-review-fixes-execution.md)
and [SDK input/async](sdk-input-async-review-execution.md) records retain their
own scopes and validation. Read [versions and upgrades](../releases/README.md)
to distinguish reviewed source from the server and client packages installed.

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
