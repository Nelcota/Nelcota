# G06 — Authentication security review execution record

Status: planned; baseline prerequisite pending. This is an intake record,
not a completed security review or a certification.

## Baseline and start gate

The [goal](auth-security-review.md) requires a frozen `main` SHA after the G05
production fixes merge. At intake (and rechecked before creating this planning branch), PR [#91](https://github.com/Nelcota/Nelcota/pull/91)
is open at `5b2b2a49f60274456e84fc027fd3e401fd64e417`; all 18 ordinary CI
checks passed on that SHA. It has not merged. That PR head is **not** recorded
as the reviewed `main` baseline.

- Planning-only branch base: `2efede8c27ee12119142170e8bd9742ff7cb900e`; this is not a reviewed security baseline.
- Reviewed frozen `main` SHA: pending.
- Phase 1 start: not started.
- Hard 24-hour deadline: not started; record when phase 1 starts.
- G05 finished its bounded campaign without full approval; its source/artifact
  stayed immutable. No G06 test, change or audit ran alongside those campaigns.
- No automatic merge is authorized. Wait for the required merged baseline;
  do not substitute a moving checkout or treat G05 evidence as G06 coverage.

## Coverage and verdicts

No owning path has been reviewed and no dynamic G06 test has run. The cells
below remain `not run` until both required forms of evidence are available.
Code reading alone and ordinary CI alone do not establish a cell verdict.

| Cell | Verdict | Evidence |
|---|---|---|
| Password storage | not run | Baseline prerequisite pending; no G06 evidence. |
| Login | not run | Baseline prerequisite pending; no G06 evidence. |
| Brute force and abuse | not run | Baseline prerequisite pending; no G06 evidence. |
| Account enumeration | not run | Baseline prerequisite pending; no G06 evidence. |
| JWT | not run | Baseline prerequisite pending; no G06 evidence. |
| API keys and roles | not run | Baseline prerequisite pending; no G06 evidence. |
| Refresh tokens | not run | Baseline prerequisite pending; no G06 evidence. |
| Logout and revocation | not run | Baseline prerequisite pending; no G06 evidence. |
| Password reset and magic links | not run | Baseline prerequisite pending; no G06 evidence. |
| Email verification and change | not run | Baseline prerequisite pending; no G06 evidence. |
| OAuth (local doubles) | not run | Baseline prerequisite pending; no G06 evidence. |
| Cookies, CSRF and origin | not run | Baseline prerequisite pending; no G06 evidence. |
| Panel SSO | not run | Baseline prerequisite pending; no G06 evidence. |
| SDKs | not run | Baseline prerequisite pending; no G06 evidence. |
| Input handling | not run | Baseline prerequisite pending; no G06 evidence. |
| Errors, logs and config | not run | Baseline prerequisite pending; no G06 evidence. |
| Dependencies | not run | Baseline prerequisite pending; no G06 evidence. |

Real OAuth provider behavior and real mail deliverability are **blocked
(environment)** from intake, as required by the goal. Local SMTP/OAuth doubles
remain in scope once phase 1 starts; they cannot certify real providers.

## Findings and disclosure

No G06 finding is claimed. During execution, private evidence belongs only in
`target/auth-review/<run-id>/`. Do not publish exploit details or descriptive
vulnerability titles for unfixed Critical/High issues. Reproduced issues in
that class require immediate maintainer notification under the goal policy.
Contracts, released migrations, dependencies, Argon2 parameters and existing
thresholds retain the goal's decision boundaries.

## Intake validation

The supplied goal is recorded without changing its checklist or approval
criteria. Its G05 related link targets the immutable goal document on the separate
G05 evidence commit `68d62df`; that document is not yet on `main`. Only local Markdown link validation and
`git diff --check` apply to this planning record. There are no claimed test,
audit, regression or vulnerability-remediation results.
