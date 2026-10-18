# G06 — Authentication security review execution record

Status: in progress. This bounded source review is not an external audit,
penetration test, compliance certification or production acceptance.

## Frozen baseline and run boundaries

- Goal authority: [G06](auth-security-review.md), read in full before phase 1.
- Reviewed frozen SHA: `7df975cf0bbed970f01948d559e959b38404a111` (the goal's Planning baseline).
- Current main at phase 1 start: `4d5992b2b27e47ece47ac30f020ca13f3af539af`.
- Phase 1 start: 2026-10-18 18:24:20 UTC.
- Eight-hour checkpoint due: 2026-10-19 02:24:20 UTC.
- Hard deadline: 2026-10-19 18:24:20 UTC.
- Source is a read-only Git archive of the frozen SHA, not a moving checkout.
- Private sanitized evidence: ignored `target/auth-review/20261018/`.
- PR [#97](https://github.com/Nelcota/Nelcota/pull/97) merged by the configured
  squash method as `4d5992b2b27e47ece47ac30f020ca13f3af539af` after all 17 applicable
  ordinary checks passed on `f5e196012d8dab07caab59b2f3e7ca6d76cece1b`.
  Native presets were not triggered by their path filter. GitHub automatically
  deleted its branch; this is the specific Part 1 deletion authorized by the task.

The complete path diff from the baseline to current main contains workflow
updates, goal documents and the PITR preflight/docs/embedded-guide rebuild from
#97. It changes no auth/session source or SDK source. Embedded asset filenames
and import references changed during the guide rebuild; those bytes are not
substituted for the frozen panel source under review.

No releases, tags, deploys, settings/workflow changes or other merges are
permitted. Medium/Low fix PRs, if eligible, remain unmerged. High/Critical
patches and reproductions are withheld from public Git history and PRs.

## Inventory and threat model

Trust boundaries: unauthenticated callers to auth endpoints; account/session
state to PostgreSQL; signed claims to RLS roles; project signing keys to other
projects; browser panel cookies to admin authority; project-panel SSO to host
controller authority; SDK storage and refresh coordination to distinct callers.

Local OAuth and SMTP doubles are permitted. Real providers, real mail, real
accounts and production deployments are **blocked (environment)** from the
start and will not be contacted. Existing tests count only when actually run
and when they assert the relevant negative case. Code reading or green CI alone
cannot establish a cell verdict.

## Coverage and verdicts

`Not started` below is a checkpoint state, not a passing verdict. Final entries
will use G06 verdicts and identify both code reading and dynamic evidence.

| Cell | State / verdict | Owning code | Planned dynamic evidence |
|---|---|---|---|
| Password storage | not started | `crates/auth/src/password.rs; credentials.rs` | server auth; auth unit tests |
| Login | not started | `crates/auth/src/accounts.rs; password.rs` | server auth |
| Brute force and abuse | not started | `crates/auth/src/rate_limit.rs; request.rs; state.rs` | server auth; auth unit tests |
| Account enumeration | not started | `accounts.rs; links/send.rs; confirmation.rs` | server auth |
| JWT | not started | `crates/auth/src/keys.rs; lib.rs; crates/core/src/claims.rs` | auth unit tests; server auth/RLS |
| API keys and roles | not started | `crates/core/src/extract.rs; db.rs; auth/db.rs` | server auth; auth_reuse; RLS |
| Refresh tokens | not started | `crates/auth/src/sessions.rs` | server auth; auth_reuse |
| Logout and revocation | not started | `sessions.rs; crates/auth/src/lib.rs` | server auth; auth_reuse |
| Password reset and magic links | open finding (G06-F01; High; details withheld pending maintainer review) | `recovery.rs; verify.rs; links/` | server auth; OAuth local doubles |
| Email verification and change | not started | `confirmation.rs; verify.rs; accounts.rs` | server auth; OAuth local doubles |
| OAuth (local doubles) | not started | `crates/auth/src/oauth/; oauth.rs` | server oauth; auth unit tests |
| Cookies, CSRF and origin | not started | `crates/admin/src/auth.rs; middleware.rs; server router` | server admin auth; panel auth tests |
| Panel SSO | open finding (G06-F05; High; details withheld pending maintainer review) | `crates/admin/src/sso.rs; host SSO boundary` | server admin SSO |
| SDKs | not started | `sdk/typescript/src/auth/; sdk/rust/src/auth.rs` | SDK unit/transport; server sdk_rust |
| Input handling | not started | `crates/auth/src/credentials.rs; handlers.rs` | server auth; auth unit tests |
| Errors, logs and config | not started | `auth/error.rs; mail.rs; core/config.rs` | auth/core unit tests; server negative tests |
| Dependencies | not started | `Cargo.lock; panel/SDK package-lock.json` | cargo audit; panel/SDK npm audit |

## Public finding ledger

| ID | Severity | Checklist row | Status |
|---|---|---|---|
| G06-F01 | High | Password reset and magic links | details withheld pending maintainer review |
| G06-F02 | Medium | JWT | Open decision: built-in issuer/audience are deliberately informative; future `nbf`/`iat` are not enforced. Tightening the documented policy requires a contract decision. |
| G06-F03 | Medium | Input handling | Fixed in isolated [PR #99](https://github.com/Nelcota/Nelcota/pull/99), CI pending; account verification bounds precede pool admission. |
| G06-F04 | Low | Errors, logs and config | Fixed in isolated [PR #100](https://github.com/Nelcota/Nelcota/pull/100), CI pending; redact explicit adapter/configuration Debug views. No default-path production leak claimed. |
| G06-F05 | High | Panel SSO | details withheld pending maintainer review |
| G06-F06 | Medium | SDKs | Fixed in isolated [PR #101](https://github.com/Nelcota/Nelcota/pull/101), CI pending; retire pending OAuth verification state on sign-out. |

## Findings and disclosure

Confirmed private finding: **G06-F01: severity High, Password reset and magic
links; details withheld pending maintainer review.** Dynamic exploration of
that issue stopped after confirmation. No patch or regression for it is
published. **G06-F05: severity High, Panel SSO; details withheld pending maintainer
review.** Dynamic exploration of that issue stopped after confirmation.

Other suspicions must be reproduced or rejected. Public High/Critical entries will contain only the
finding identifier, severity, checklist row and “details withheld pending
maintainer review”. No public patch, regression or exploit narrative is allowed
for an unfixed finding in that class.

## Execution log

- Intake: read repository instructions, goal and network/runtime instructions;
  reused installed Rust/Node tools and caches without changing setup or locks.
- Baseline: checked all later changed paths and extracted the exact Git tree.
- Dynamic baseline suites: server `auth` 27 passed; server `oauth` 18 passed
  using local provider doubles. No ignored tests in either suite.
- Additional checks: `auth_reuse` 10 passed; `rls` 10 passed; panel login/CSRF
  integration 1 passed; panel SSO integration 1 passed. These do not override
  open finding verdicts.
- Owning auth/core baseline units: 40 + 20 passed. The four added diagnostic
  regressions were excluded from this unchanged-behavior run and separately
  failed on the baseline as intended; no ignored tests were counted as passes.
- SDK baseline: 110 TypeScript unit tests and 8 Rust auth + 12 Rust transport
  tests passed. Four new TypeScript cleanup regressions failed on the baseline.
- Boundary probes: cross-project EdDSA, expired keys/tokens and role forgery
  rejected; future temporal claims and informative issuer/audience accepted
  as recorded for F02. Twenty alternating wrong/unknown login pairs after four
  warm-up pairs had medians 398.36/396.55 ms (ratio 1.005); this local observation
  is not a statistical timing-channel certification.
- Input/cookie probe passed after correcting its initial expectation from 400
  to the documented 422 for invalid email; the initial failed probe is retained.
  Oversized-body/malformed JSON, normalized-email collision, unsupported email
  update, noncredentialed CORS and cross-origin cookie mutations were checked.
- Fix evidence: F03 before 1 pass / 2 failures, after 3 passes plus 27 existing
  auth passes. F04 before 4 assertion failures, after 64 library passes.
  F06 before 4 assertion failures, after 116 SDK passes plus 37 guide passes.
  Source/translation and generated asset commits are separated in #101.
- Fixture correction: an initial standalone core diagnostics probe used a UUID
  feature absent from that crate and did not compile; the corrected probe ran
  all four assertions without adding a dependency. Compile failure is not
  counted as defect reproduction.
- Execution sequencing deviation: Clippy for #99 was started during the final
  seconds of its auth suite. No Vitest or audit overlapped; subsequent local
  Rust/Vitest/audit stages are serialized. All result statuses are retained.
- Resource policy: four Cargo jobs, two Rust test threads, sequential Rust,
  Vitest and audit runs. Only disposable local fixtures are authorized.

## Decisions and limitations

- Follow the specifically authorized #97 merge and branch deletion as the
  exception to the general prohibition on merges/deletions; nothing else is
  closed or deleted.
- No real provider/mail checks will be attempted or replaced with workarounds.
- This record is not a published release plan; release notes and commands belong
  only in the maintainer's final private task response.
