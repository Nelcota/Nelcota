# G06 — Authentication security review execution record

Status: completed with open findings. This bounded source review is not an external audit,
penetration test, compliance certification or production acceptance.

Completion summary: **17 rows examined: 8 passed, 5 fixed on unmerged PRs,
4 open-finding rows.** Finding counts: 0 Critical, 2 High (details withheld
pending maintainer review), 4 Medium and 1 Low. Real OAuth providers and real
mail delivery remain blocked (environment).

## Frozen baseline and run boundaries

- Goal authority: [G06](auth-security-review.md), read in full before phase 1.
- Reviewed frozen SHA: `7df975cf0bbed970f01948d559e959b38404a111` (the goal's Planning baseline).
- Current main at phase 1 start: `4d5992b2b27e47ece47ac30f020ca13f3af539af`.
- Phase 1 start: 2026-10-18 18:24:20 UTC.
- Part 2 completed: 2026-10-18 19:17:58 UTC (53 minutes 38 seconds).
- Completed before the eight-hour checkpoint; no minimum review duration was required.
- Eight-hour checkpoint due: 2026-10-19 02:24:20 UTC.
- Hard deadline: 2026-10-19 18:24:20 UTC.
- Source is a frozen Git archive, not a moving checkout. Integrity verification
  found 1,226 byte-identical tracked files and two test-only append overlays;
  production code was unchanged. Extra disposable probes are outside Git.
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

All 17 original rows have code-reading and dynamic evidence. `Fixed` means a
verified correction on the linked isolated PR, **not** a correction merged into
the frozen baseline or current main. The three fix PRs must remain unmerged.

| Cell | Verdict | Code reading | Dynamic evidence / limitation |
|---|---|---|---|
| Password storage | fixed — F03, #99 | `auth/password.rs`, `credentials.rs` | Auth 27 + auth/core 40/20 baseline units; fresh salts differ at unchanged Argon2id parameters; #99 maximum ASCII/Unicode regressions pass. Rehash on password replacement uses the current implementation; automatic login-time parameter upgrades are not implemented. |
| Login | fixed — F03, #99 | `auth/accounts.rs`, `password.rs`, `confirmation.rs` | Unknown/wrong status/body match; 20 paired timing observations after warm-up; disabled confirmation policy tested; #99 auth suite 27 passes and oversized-input regressions. Timing observations are local, not a universal side-channel proof. |
| Brute force and abuse | open finding — F07 | `auth/rate_limit.rs`, `request.rs`, `state.rs` | IP/account quotas and gradual refill tested; bounded hash ownership and a controlled 504 deadline tested while another project stays healthy. F07 records the configured recovery-off/account-quota policy gap. |
| Account enumeration | passed within documented policy | `accounts.rs`, `links/send.rs`, `confirmation.rs` | Auth 27 checks wrong/unknown login and existing/missing recovery, magic link and resend. Signup deliberately returns documented 409 on duplicates; OAuth linking refusals follow the documented policy. |
| JWT | open finding — F02 | `auth/keys.rs`, `auth/lib.rs`, `core/claims.rs`; `docs/jwt-and-roles.md` | RLS 10 and key units reject none, tampering, unknown role/key, expiry and foreign independently keyed projects. Migration HS256 mode follows configuration. Additional signed-claim probes confirm F02; no issuer/audience contract was changed. |
| API keys and roles | passed | `core/db.rs`, `claims.rs`, `auth/db.rs`; panel token boundary | RLS 10 + auth_reuse 10: pooled roles/claims reset after success/error; API roles cannot read auth schema; JWT/service credentials do not open the panel or controller. Service-role issuance by an authenticated project administrator is deliberate operator authority. |
| Refresh tokens | passed within documented grace | `auth/sessions.rs`, token schema and pruning | Auth 27 + auth_reuse 10 demonstrate rotation, expiry, replay revocation, newest-only live successor and logout/password-replacement refresh rejection across instances. Ten-second retry grace is explicit; it is not strict rejection of every concurrent retry. |
| Logout and revocation | passed within documented access-token bound | `auth/sessions.rs`, `lib.rs`; panel sessions | Auth/auth_reuse and SDK HTTP fixture revoke refresh families across instances. Access JWTs remain stateless through expiry plus configured verifier leeway (default 900 + 30 seconds); panel sessions revoke in their owning process. |
| Password reset and magic links | open finding — F01, High | Reviewed; details withheld pending maintainer review | Existing auth/OAuth suites and private verification completed. Details withheld pending maintainer review. |
| Email verification and change | passed for implemented flows | `confirmation.rs`, `verify.rs`, account/inbox ownership | Auth 27 + OAuth 18 cover proof of inbox ownership, unverified identities and single-use confirmation. Self-service email change and account-disabled state are not implemented; source search and an ignored email-update-field probe confirm this sub-scope is not applicable. |
| OAuth (local doubles) | passed for implemented local flow | `auth/oauth.rs`, flow/identities/provider/PKCE/redirect adapters | OAuth 18 + auth units cover state, PKCE, exact configured provider callback, redirect allowlist and linking refusal. Google uses authenticated userinfo, not ID-token validation; parser negatives run. Real provider behavior remains blocked (environment). |
| Cookies, CSRF and origin | passed for documented topology | `admin/auth.rs`, `middleware.rs`, server CORS and panel auth state | Panel auth/cookie units, controller boundary tests and extra CSRF/CORS probes reject foreign/null origins and cross-site mutations. Secure/HttpOnly/Strict attributes are checked; generated proxied deployments enable proxy trust. Public TLS is not exercised. |
| Panel SSO | open finding — F05, High | Reviewed; details withheld pending maintainer review | Existing panel SSO, controller-boundary and scoped-worker checks completed. Details withheld pending maintainer review. |
| SDKs | fixed — F06, #101 | TS auth/session/journal/HTTP; Rust auth/transport/scoped clients; panel cache | Baseline TS 110, Rust auth/transport 8/12 and one real-server auth contract pass. Four new cleanup regressions fail before; 118 related tests pass after. Panel API/auth/cache checks: 29 passed, one GC-only test subsequently run separately. |
| Input handling | fixed — F03, #99 | `auth/credentials.rs`, handlers and JSON extractors | Oversized/malformed bodies, ASCII mailbox restrictions, case/Unicode collisions and 256-character limits checked. Two pool-admission regressions fail before and pass after; supported 256-character Unicode passwords still sign in. |
| Errors, logs and config | fixed — F04, #100 | Auth error/mail/provider adapters; core configuration; SDK diagnostics and server request logging | Four diagnostic regressions fail before and pass after (64 library tests after). Weak/missing keys, invalid settings, malformed requests and generic auth responses are checked. Logs exclude query strings; no default-path production leak is claimed for explicit Debug views. |
| Dependencies | passed at audit time | Frozen `Cargo.lock` and both npm lockfiles; package boundaries | `cargo audit`: zero vulnerabilities/warnings, 1,338 advisories at DB commit `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b`; panel and SDK `npm audit`: zero advisories at all severities. No dependency/lock changes. |

Blocked sub-scopes from intake: real OAuth providers and real mail delivery.
These are not extra checklist rows and were not substituted with live services.
No original row is unreviewed; absent subfeatures are identified above rather
than invented. A passing row is bounded by its documented behavior and fixtures.

## Public finding ledger

| ID | Severity | Checklist row | Status |
|---|---|---|---|
| G06-F01 | High | Password reset and magic links | details withheld pending maintainer review |
| G06-F02 | Medium | JWT | Open decision: built-in issuer/audience are deliberately informative; future `nbf`/`iat` are not enforced. Tightening the documented policy requires a contract decision. |
| G06-F03 | Medium | Input handling | Fixed in isolated [PR #99](https://github.com/Nelcota/Nelcota/pull/99), 17/17 applicable CI passed on `e388912e72f52b9f7f7791644080415817ac733c`, ready; account verification bounds precede pool admission. |
| G06-F04 | Low | Errors, logs and config | Fixed in isolated [PR #100](https://github.com/Nelcota/Nelcota/pull/100), 17/17 applicable CI passed on `e2aa4e59eb5c9593e27fd8cea4b94ef38f91da9b`, ready; redact explicit adapter/configuration Debug views. No default-path production leak claimed. |
| G06-F05 | High | Panel SSO | details withheld pending maintainer review |
| G06-F06 | Medium | SDKs | Fixed in isolated [PR #101](https://github.com/Nelcota/Nelcota/pull/101), 17/17 applicable CI passed on `c9e861d1b295a518f48282b138477bfacaa44dbe`, ready; retire pending OAuth verification state on sign-out. |
| G06-F07 | Medium | Brute force and abuse | Open policy decision: independent source addresses can exhaust an account quota and a subsequent correct login receives 429; with supported SMTP-disabled configuration, recovery/magic-link requests return 403. Do not weaken throttling; decide on independent recovery/unlock requirements. |

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
  F06 before 4 assertion failures, after 118 SDK passes plus 37 guide passes.
  Source/translation and generated asset commits are separated in #101.
- Fixture correction: an initial standalone core diagnostics probe used a UUID
  feature absent from that crate and did not compile; the corrected probe ran
  all four assertions without adding a dependency. Compile failure is not
  counted as defect reproduction.
- Execution sequencing deviation: Clippy for #99 was started during the final
  seconds of its auth suite. No Vitest or audit overlapped; subsequent local
  Rust/Vitest/audit stages are serialized. All result statuses are retained.
- Additional baseline probes passed: distinct per-hash salts and per-account
  throttling across source addresses; a busy hash worker retains its permit
  while a controlled 50 ms request deadline yields 504 and a separate project's
  health check succeeds. This uses a short fixture deadline, not a production
  capacity/SLO measurement; production defaults and existing thresholds did not
  change.
- F07 policy probe used a disposable quota of two to demonstrate the same
  account-key behavior without a load campaign: two invalid source addresses,
  then correct credentials from a third address returned 429; disabled recovery
  and magic-link flows returned 403. No indefinite real-world lockout was claimed
  or attempted. Continuous refill remains intact; no quota was weakened.
- Panel baseline API/auth/cache tests: 29 passed and one GC-only check skipped
  without GC exposure. The skipped check was then explicitly run with the
  repository's documented fork/GC flags: 1 passed; its other six tests were
  filtered, not counted as newly passed.
- Rust SDK real-server auth/refresh/recovery/scoped-token contract: 1 passed.
  Controller HTTP boundary tests: 3 passed; panel cookie parsing/attributes:
  2 passed; scoped CLI worker authority: 1 passed.
- Dependency audit databases were reachable. Cargo audit and panel/SDK npm
  audit each reported zero advisories. No exception or reachability waiver was
  required and no registry configuration/lockfile changed.
- #101 initial head `e3f64b337c0fae9720c621d00ee8b0f2657d6301` failed ordinary
  SDK CI at its gzip budget (auth 11,283 B / 11,250 B). The follow-up
  `c9e861d1b295a518f48282b138477bfacaa44dbe` reuses existing credential operations
  and keeps public explicit-session validation at its owner. All 118 related
  tests, type check, build and installed-package acceptance pass locally;
  auth is 11,246 / 11,250 B and root 17,064 / 17,100 B. No budget changed.
  The failed historical CI run is retained, not replaced by a success claim.
- Local package acceptance initially encountered an unwritable home npm cache;
  a workspace-owned cache resolved setup and the installed-package check passed.
- Approval review initially rejected even the redacted High marker. The exact
  authorization in the task was provided for re-review; approval then succeeded.
  No affected-code detail, private regression or proposed High patch was pushed.
- Final fix verification: #99, #100 and #101 are ready for review, each with
  all 17 applicable ordinary checks successful on the exact SHA in the ledger.
  Native presets were not triggered by their unchanged path filter. No fix PR
  was merged; main remains `4d5992b2b27e47ece47ac30f020ca13f3af539af`, with all
  16 check runs reported for that main SHA successful at verification.
- Resource policy: four Cargo jobs, two Rust test threads, sequential Rust,
  Vitest and audit runs. Only disposable local fixtures are authorized.

## Decisions and limitations

- Follow the specifically authorized #97 merge and branch deletion as the
  exception to the general prohibition on merges/deletions; nothing else is
  closed or deleted.
- No real provider/mail checks will be attempted or replaced with workarounds.
- The configured repository automation closed issue #96 through #97's existing
  closing reference. No issue was closed manually and no settings were changed.
- Two policy gaps (F02/F07) are kept as maintainer decisions: enforcing stricter
  claims or changing authentication/recovery availability is a documented
  behavior decision; no contract change, new dependency or weakened quota was
  introduced to force an approval verdict.
- This record is not a published release plan; release notes and commands belong
  only in the maintainer's final private task response.

## Bounded completion

All original cells have verdicts; there are no unreviewed/not-run original
rows. The two blocked real-service sub-scopes and absent email-change/disabled
account features remain explicit. High details and proposed patches belong
only to the private maintainer task response; no public patch is implied.
No G05 campaign, VM probe, production action, new dependency or migration ran.
The execution PR remains draft. Release preparation is private and publishes
no version, tag or release artifact.
