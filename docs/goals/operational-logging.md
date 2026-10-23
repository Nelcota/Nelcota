# G10: Safe, actionable operational logging

Status: bounded execution finished with four locally validated corrections,
open disk performance gates and deployment limits. See
[the execution record](operational-logging-execution.md) and
[Portuguese report](results/g10-logging-report.pt-BR.md). No performance or
production approval.

## Objective

Make failures and important lifecycle transitions diagnosable across the server,
PostgreSQL adapters, authentication, storage, workers, CLI, panel and SDKs.
Useful coverage means accountable operation boundaries and actionable context,
not logging every function, payload, successful health probe or loop iteration.
Logs support diagnosis; they do not automatically correct or retry operations.

## Authority and safety

When asked to execute, proceed autonomously and record decisions and reasons.
Use a separate branch and owned synthetic fixtures. No VPS/customer access,
real email/webhooks, external telemetry, merge, release, tag, package publication,
deployment or settings/workflow changes. Public push/PR publication requires
separate authorization. Follow AGENTS.md and CONTRIBUTING.md.

Hard limit: six hours wall clock including preparation and waits; reserve the
last 30 minutes for checks, cleanup and a Portuguese report. Existing G09 timing
campaigns have priority: never compile/test/profile alongside them or alter
G09's worktree, frozen binaries, data or measurement profile. Report unavailable
resources and unfinished coverage honestly. No new dependencies or services.
Do not change documented HTTP/SDK/Rust APIs, CLI/configuration/output formats,
migrations, existing security guarantees or thresholds. Logging changes that
need such a change remain proposals rather than being silently implemented.

## Pass 1: Inventory and baseline

Record starting source, existing tracing/log-format/filter support, sinks,
request/operation IDs, denied-event/audit ownership, rotation and access policy.
Read current operating and security documentation before changing code. Capture
only synthetic redacted baselines. Rank missing context, unsafe raw values,
duplicate events and high-volume paths by impact and evidence.

| Cell | Area | Evidence required |
| --- | --- | --- |
| L01 | HTTP/requests | Correlatable response/error events; bounded IDs; method, matched route, status and response-head latency; health/static noise controlled. No raw URL/query/body/header logging. |
| L02 | Errors/database | Stable event/error category and safe SQLSTATE/operation context; preserve internal error ownership and public error behavior; no SQL values, connection URLs or unconstrained database messages. |
| L03 | Auth/authorization | Useful outcomes and limiter failures without passwords, JWTs, cookies, session/recovery/SSO material, hashes, account enumeration or raw identities/IPs. Security audit requirements distinguished from diagnostic logs. |
| L04 | Storage/integrations | Upload/download/queue outcome and bounded timing/count/retry metadata without object contents, identifying keys, signed URLs, SMTP credentials or webhook secrets. |
| L05 | Async/workers | Start/finish/failure/cancellation, bounded retry/flood behavior, queue ownership and shutdown; no per-tick success spam or retry added merely to create a log. |
| L06 | CLI/host operations | Operator-action/job/project correlation, phase and safe reason for update/backup/restore/fence failure; preserve approval, restore fencing, durability and machine-readable CLI output. |
| L07 | Panel/SDKs | No secret console output or unsolicited telemetry; useful existing error/correlation presentation with no API expansion or package/bundle budget increase. |
| L08 | Sinks/operations | stdout/stderr/journald/Docker ownership, rotation/retention/size, restricted access, clock/UTC guidance, redacted support export; no raw log file endpoint or privileged browser log reader. |
| L09 | Robustness/cost | Long/malformed/control-character inputs, log flooding and hot paths; no panic, unbounded allocation or request failure caused by logging. Existing release budgets unchanged. |
| L10 | Diagnostic usability | Reconstruct a synthetic failure using bounded request/job context; document what happened, where, correlation and safe next action, including what a log cannot establish. |

## Logging policy

- Prefer structured tracing with stable event names and named fields. Reuse the
  existing JSON/text/filter mechanisms. WARN/ERROR for actionable abnormal
  outcomes, INFO for important boundaries, DEBUG/TRACE for optional diagnostics.
  Avoid duplicate error reports at every layer; preserve ownership of the cause.
- UTC event timestamps; monotonic elapsed time; identify response-head timing
  separately from streaming completion. Include version/component/operation and
  bounded correlation context where existing ownership supports it.
- Treat all incoming IDs, paths, filenames, provider/database error messages and
  third-party response text as untrusted. Allowlist diagnostic fields; bound
  lengths/cardinality and avoid CR/LF injection. Redaction must cover both an
  event and its parent spans, text and JSON output, and failure/cancellation paths.
- Never record credentials, authorization headers, cookies, signed query strings,
  private URLs, request/response bodies, file contents, SQL parameters or entire
  config/Debug dumps. Do not log personal data by default. Hashing an identifier
  is not automatically anonymization; do not invent a new tracking identifier.
- Do not suppress critical failures to improve benchmarks. Avoid synchronous
  filesystem/network sinks on async hot paths; do not introduce unbounded queues.
  Where audit durability differs from best-effort diagnostics, document the
  boundary rather than silently treating one as the other.
- Existing metrics/alerts remain separate: logs explain events, metrics quantify
  behavior and alerts notify. No notification sent to real operators during tests.

## Pass 2: Bounded corrections

Select at most five concrete targets, with cause, scope, risk and acceptance
criteria. Add focused regressions first: synthetic secret canaries and adversarial
values must reproduce a confirmed leak/diagnostic gap on the original code.
Show old/new results; preserve authorized public errors, timeout/cancellation,
authorization and CLI output behavior. Then make small changes in the owning
modules. No speculative tracing framework, blanket instrumentation or refactor.

Use unchanged characterization tests for unaffected behavior. Document any
coverage without a justified correction and every out-of-scope finding.
Add English/Portuguese operating guidance when bundled prose changes, maintain
translations and rebuild embedded assets in a separate build commit. Use focused
Conventional Commits. Do not log real secrets even into private test artifacts.

## Pass 3: Validation and handoff

Run related Rust suites (four jobs, two threads), UI/SDK checks as affected,
fmt, Clippy -D warnings and relevant architecture/doc/guide checks sequentially.
Capture text/JSON output and assert secret canaries absent, safe fields present,
IDs/lines bounded, and failure outcomes unchanged. Use actual local sinks where
available; mark journald/real host/provider behavior blocked when unavailable.

Check diagnostic cost separately from G09: identical bounded synthetic load,
logging mode/filter, binary/profile/sink and at least three valid repetitions
when making a performance claim. Do not claim overhead from debug builds, file
size alone or historical evidence. If overhead cannot be measured reliably,
report not measured; never claim it free. Preserve all failures and budgets.

Deliver an English execution record plus a Portuguese technical report with:
source/commits, L01-L10 verdicts, before/after regressions, checks/counts, logging
schema/examples containing synthetic non-sensitive values only, residual risks,
retention/access/support guidance, performance limits and owned-fixture cleanup.
A cell is measured/validated, source-reviewed only, blocked, not applicable or
not run; unknown is never passed. Keep security findings distinct from proposals.
No production readiness, compliance, leak-proof or complete audit-trail guarantee
is established by this bounded pass. Stop after the local handoff.
