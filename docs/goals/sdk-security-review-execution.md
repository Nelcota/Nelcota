# G12 execution record

Status: **in progress; initial review/tests executed, no security approval**.
Baseline: `42e59ff893a3ba91c84177dbf4044c822f1a255d`.
Branch: `feat/nextjs-sdk-g11`. Date: 2026-10-24 UTC.

## Scope and decisions

Inventory identified 59 Rust/TypeScript source files across `sdk/rust`,
`sdk/typescript` and `sdk/nextjs`. The initial targeted inspection covered token
selection, auth/session storage, Rust OAuth callback handling and Debug/error
redaction, redirect policies, Next cookies/encryption/Origin and ownership.
It is not a line-by-line certification of every export.

Use existing disposable fixtures and local transport tests. Preserve production,
other worktrees and private audit evidence. No merge, release, publication or
VPS operation. Keep confirmed serious new findings private pending disclosure.
Do not classify caller-controlled configuration or a hypothesis as a confirmed
vulnerability without a reachable trust-boundary violation.

## Fresh execution evidence

Commands ran sequentially following AGENTS.md (four Cargo jobs/two Rust test
threads; two Vitest workers). Logs: `/workspace/artifacts/g12/`.

| Command | Result |
|---|---|
| `cargo test --locked -p nelcota-client` | 44 executable tests +10 doctests passed; zero failures/ignored |
| `npm --prefix sdk/typescript test` | 328 passed |
| `npm --prefix sdk/typescript run test:types` | 18 passed; no type errors |
| `NELCOTA_NEXT_TEST_DATABASE_URL=... npm --prefix sdk/nextjs test` | 55 passed, no skipped tests; includes real disposable PostgreSQL case |
| `npm --prefix sdk/typescript audit --json` | Zero known npm alerts at checkpoint |
| `npm --prefix sdk/nextjs audit --json` | Zero known npm alerts at checkpoint |

The shared PostgreSQL fixture was started with `scripts/test.sh db`; provider
cases create/drop their own databases. No production credentials/data used.
Rust build left approximately1.1GiB free; do not start a full-server rebuild
without rechecking the reserve. Earlier G11 evidence is referenced below, not
misrepresented as newly executed G12 checks.

## Initial findings and boundaries

| ID | Classification | Status/evidence |
|---|---|---|
| G12-01 | Potential identity ordering defect; publication blocking | Carry forward G11 N01: separate SIDs for simultaneous first logins lack a proven stale-response fence. Static path identified; adversarial browser reproducer and final design remain pending. Do not claim a confirmed privilege escalation. |
| G12-02 | Compatibility defect, not established security vulnerability | Carry forward G11 N02: redirect rejection prevents presigned S3 download redirects. Preserve fail-closed behavior until an explicit safe destination policy is implemented/tested. |
| G12-03 | Corrected prerequisite, not a new finding | #132 external-token identity and #133 terminal refresh error classification already have local corrections and G11 before/after evidence. They are not published by this execution. |
| G12-04 | Documented trust boundary | Rust independent clients/processes sharing SessionStorage require external coordination; cloning one Client shares its manager. Do not treat the storage trait as a distributed lock. Existing clone/cancellation/logout tests passed. |
| G12-05 | Investigation required | Base Rust/TS transports follow redirects; Next auth refuses them. Need negative credential/body/header redirect tests and threat-model assessment before deciding whether a new reachable defect exists. No exploitability claim. |
| G12-06 | Caller-owned file boundary | Rust FileStorage creates0600 files with atomic publication and directory sync, but load trusts the caller-selected path. Symlink/parent-owner and oversized-file behavior require dedicated tests before security conclusions. |

Rust session/PKCE/email-link formatting deliberately omits credential fields;
network errors strip request URLs. These inspected controls and their existing
regressions are useful evidence, not a promise that arbitrary application logs
or metadata are safe. Public error messages preserve backend error semantics;
consumers still must not indiscriminately log identifying provider/DB payloads.

## Remaining execution cells

| Area | Verdict at checkpoint |
|---|---|
| SDK inventory | Initial inventory done; full export-to-test traceability not run |
| Rust regression suite | Passed |
| TypeScript unit/types | Passed |
| Next unit/shared PostgreSQL provider | Passed |
| Authentication isolation | Existing focused regressions pass; full cross-tab/process negative matrix not run |
| Backend two-user/anonymous RLS | G11 compatibility evidence exists; final-source backend not run (disk constraint) |
| Redirect/SSRF/header adversarial matrix | Not run; G12-05 pending |
| File paths/permissions/hostile local state | Existing file tests pass; G12-06 pending |
| Packed consumer/framework boundary | G11 evidence exists; not rerun in G12 |
| npm dependency advisories | Passed at checkpoint |
| Rust advisory/license audit | Not run in this checkpoint |
| Runtime/version/provider matrix | Not run beyond existing fixture versions |
| Resource/leak/soak matrix | Not run |
| Final security acceptance | Not passed; G12 remains open |

## Next steps

1. Produce private minimal redirect and hostile-storage tests; distinguish
   expected caller trust from actual cross-boundary disclosure or state adoption.
2. Resolve/prove G11 first-login ownership before approving the Next candidate.
3. Trace every public export to its validation and negative tests; complete real
   backend/provider, packaging, Rust advisory and resource checks on final SHA.
4. Correct confirmed in-scope defects with before/after regressions, retaining
   failed evidence and every current threshold. Report unresolved items plainly.

No new confirmed security defect was auto-published or labelled resolved by
this first checkpoint. The goal was created and execution started; it is not
marked complete merely because regression suites passed.
