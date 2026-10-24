# G12 — Comprehensive SDK security review

Status: in progress. Scope: first-party TypeScript, Rust and Next.js SDKs,
entry points, generated declarations, examples, package contents and integration
boundaries. Follow AGENTS.md and CONTRIBUTING.md. No production traffic/data,
package publication, releases, deployment or automatic merge.

## Objective and baseline

Find and correct reproducible security defects while preserving documented
contracts, RLS enforcement and resource/security thresholds. Record starting
SHA, package/toolchain versions and tested artifact identities. A clean audit
or passing unit suite alone is not security approval.

## Required review

1. Inventory every public export, transport, auth/storage adapter, example,
   dependency and packaging/release boundary. Map untrusted inputs and secrets.
2. Review authentication and authorization: caller-token precedence, anonymous
   fallback, service credentials, expired/revoked sessions, refresh ownership,
   logout/replacement races, OAuth state/PKCE, email/recovery flows and cache
   isolation. Backend grants/RLS remain authoritative.
3. Review transport: URL/redirect trust, credential stripping, SSRF boundaries,
   header injection, TLS, proxy handling, retries of mutations, timeouts,
   cancellation, streams, body limits and malformed provider responses.
4. Review validation: null/empty/non-object values, finite numbers/int64,
   prototype-related keys, path encoding/traversal, upload names/MIME, signed
   links and response-shape assumptions. Preserve valid empty files/null fields.
5. Review secret exposure: serialized errors, causes/logs, browser bundles,
   source maps, examples, tarballs, cookies, storage and cross-request caches.
6. Review concurrency/resource ownership: tabs, processes, shared stores,
   stale writers/responses, connection loss, queues, timers/listeners, sockets,
   descriptors, streaming cleanup and bounded admission/deadlines.
7. Exercise disposable real-backend two-user/anonymous RLS canaries and malicious
   response fixtures. Test external packed consumers and server/browser export
   boundaries. Test each supported runtime; mark unavailable cells explicitly.
8. Audit locked dependencies and scripts. Inspect advisory reachability and
   actual use rather than treating version reports as proof of exploitability.

## Findings and correction workflow

Maintain docs/goals/sdk-security-review-execution.md. Each finding records ID,
severity/reasoning, affected version/entry point, trust boundary, minimal local
reproducer, before result, root cause, focused fix, regression and after result.
Separate confirmed defects, hypotheses and design limitations. Record failed,
skipped and blocked tests; never invent evidence or lower thresholds.

Fix confirmed in-scope defects, add regressions that fail before the fix and
pass afterwards, then rerun affected integrations on the final artifact.
Coordinate with G11: explicitly carry forward first-login identity races and
presigned S3 redirect compatibility; do not call the Next candidate production
ready until its gates pass. Keep corrections small; no cosmetic rewrite.

Potential unpublished serious findings and reproducers stay in private local
artifacts pending maintainer disclosure decisions. Do not publish actionable
sensitive details in public PRs/comments as an automatic side effect.

## Completion gates

- Reviewed inventory for all three SDKs with per-area passed/failed/blocked/not
  run verdicts, and an explicit list of untested public entry points.
- Confirmed defects fixed with before/after evidence; unresolved findings retain
  severity, owner/next action and impact on readiness.
- Focused unit/type/integration/package checks pass on the final SHA; ordinary
  CI evidence, if available, identifies that exact SHA.
- Existing lint/bundle/security/resource limits retained. Any proposed budget
  change is reported separately and cannot masquerade as the original pass.
- Final Portuguese report: scope, artifacts, findings, fixes, exact counts,
  real-provider vs simulated evidence, limitations and readiness decision.

Use four Cargo jobs/two Rust threads and two Vitest workers. Rust, Vitest and
supply-chain audits run sequentially. Bound disposable fixtures and stop tests
on critical disk/memory limits. Preserve other worktrees and prior evidence.
