# G06 — Authentication security review execution record

Status: finalized after public disclosure and publication of server 0.5.0.
All seven findings have merged resolutions; F07 retains its explicitly accepted
mitigation trade-off. This source review is not production acceptance or an
external audit.

The current ledger below supersedes the original open/ready statuses. The
original bounded review, measurements and authorization remain dated evidence
in the archived section. Disclosure placeholders now refer to the public
advisory; historical coverage verdicts and measurements are unchanged.

## Authorized resolution ledger

| Finding | Severity | Final status | Fix PR | Squash merge SHA |
|---|---|---|---|---|
| G06-F01 | High (CVSS 3.1: 7.4) | Fixed in server 0.5.0: pending email credentials and OAuth authorization state retire transactionally with password replacement. See the [public advisory][g06-advisory]. | [#105](https://github.com/Nelcota/Nelcota/pull/105) | `bbe9dc8f5f07b6ee545ba6e600ed8b171718744f` |
| G06-F02 | Medium | Fixed in server 0.5.0: optional nbf/iat validation with 30-second leeway; issuer/audience remain informative. | [#102](https://github.com/Nelcota/Nelcota/pull/102) | `098d28c7e62389ea5ed2631d3031fe3caf5d1bec` |
| G06-F03 | Medium | Fixed in server 0.5.0: bound account verification inputs before pool/hash admission. | [#99](https://github.com/Nelcota/Nelcota/pull/99) | `27a01afb05c3bdd458390347b6bdaa467791df82` |
| G06-F04 | Low | Fixed in server 0.5.0: redact adapter/configuration diagnostics. | [#100](https://github.com/Nelcota/Nelcota/pull/100) | `228218989e773104d659d0d47a8e9394ed478403` |
| G06-F05 | High (CVSS 3.1: 8.1) | Fixed in server 0.5.0: panel SSO single-use redemption uses atomic, durable project-database receipts across restarts and instances. See the [public advisory][g06-advisory]. | [#105](https://github.com/Nelcota/Nelcota/pull/105) | `bbe9dc8f5f07b6ee545ba6e600ed8b171718744f` |
| G06-F06 | Medium | Fixed and published in TypeScript SDK 0.2.0: clear pending OAuth state on sign-out. | [#101](https://github.com/Nelcota/Nelcota/pull/101) | `c249e4237950d852b13ae182d6a89c88b23e2b95` |
| G06-F07 | Medium | Authorized mitigation released in server 0.5.0: account/source quotas plus bounded aggregate delay. The original strict aggregate ceiling is not retained; there is no absolute lockout guarantee. | [#103](https://github.com/Nelcota/Nelcota/pull/103) | `4387592eafd56818d3093d590867fde2fb542ad5` |

The [published advisory GHSA-9f7h-6cpv-wh6q][g06-advisory] covers F01/F05 in
server versions through 0.4.0, patched in 0.5.0. These summaries stay within its
public description. Existing access JWTs continue until their configured expiry
and verifier leeway; the update does not provide immediate access-JWT revocation.
The SSO impact is scoped to the affected project, without host-controller authority.

The initial five-PR wave (#99–#103) used squash after an independent review
pass, an ordinary merge of current main into its branch where needed, and all **17 applicable ordinary
checks passing on the exact head**. No protection/check bypass or history rewrite
was used. The five merged remote branches were deleted; no unrelated branch,
issue, repository setting or workflow was changed by this follow-up.

PR #105 subsequently integrated F01/F05. Its exact head below also passed all
17 applicable checks; the final ledger records its verified squash merge SHA.

| PR | Reviewed/up-to-date head (17 successful checks) | Squash merge |
|---|---|---|
| #99 | `e388912e72f52b9f7f7791644080415817ac733c` | `27a01afb05c3bdd458390347b6bdaa467791df82` |
| #100 | `a8be69a9171d454c5104af8c0c33bfc7d7f69935` | `228218989e773104d659d0d47a8e9394ed478403` |
| #101 | `992a309e93dce2b64c8a6146c53ac3fdcd28851f` | `c249e4237950d852b13ae182d6a89c88b23e2b95` |
| #102 | `ae464ecec15f6de053dc11456713b1a308f0c5bb` | `098d28c7e62389ea5ed2631d3031fe3caf5d1bec` |
| #103 | `75ea5996a1ff2952ddfa708d53520c42994816c1` | `4387592eafd56818d3093d590867fde2fb542ad5` |
| #105 | `62905aecbdf0f53f387d42327986329a9c78e418` | `bbe9dc8f5f07b6ee545ba6e600ed8b171718744f` |

Native presets were not triggered by their unchanged path filter and are not
counted as a passed eighteenth check. At the end of the initial five-PR wave,
main was `4387592eafd56818d3093d590867fde2fb542ad5`; this historical checkpoint
is not the release tag or this documentation update's main base.

## Public before/after evidence and decisions

- Independent repetitions confirm #99's two old-source admission failures and
  supported-input control; all three pass after correction. An initial shared
  compilation-cache result was excluded and the old source was recompiled.
- #100's four diagnostic assertions fail on old source; all 64 owning-library
  tests pass after correction. #101's four original cleanup assertions fail on
  old source; all 118 related tests, type checking and deterministic guide
  rebuild pass on its updated branch. SDK gzip budgets remain unchanged.
- F02: the old key tests have three expected failures and the REST regression
  fails because the request is accepted. After correction/current-main update:
  47 auth unit tests, the HTTP regression and all 10 RLS tests pass, with Clippy
  and 37 guide tests. The exact inclusive +30/+31-second boundary is checked.
  Built-in raw-payload and request verification share this policy; SDKs do not
  become cryptographic JWT validators. `iss`/`aud` remain informative by the
  maintainer's explicit decision.
- F07: both final regressions fail on unchanged old production source. After
  correction/current-main update: 49 auth units and 32 related HTTP tests pass,
  with Clippy and 37 guide tests. The initial forwarded-header fixture was
  invalid while proxy trust was off; it was replaced by actual connection
  metadata and rerun before changing production code.
- F07's strict aggregate-ceiling requirement is **not claimed as passed**. An
  unrecognized legitimate source cannot be distinguished from another attacking
  source before password verification. The maintainer explicitly allowed this
  fallback: hard IP/account-source burst/refill quotas (default 30), plus account
  delay of 125/250/500/1,000/2,000 ms, capped at two seconds. Distributed sources
  can exceed the former aggregate ceiling. The bound is throttle delay, not a
  total-latency/SLO promise under worker, store-capacity or other overload.
  Single-source quotas, Argon2 parameters, worker admission/deadlines and
  fail-closed key capacity are unchanged. Sleeps own no pool/hash slot.
- F07 mitigates account-targeted lockout; it does not eliminate it or guarantee
  legitimate admission. IP/account-source quotas (including shared NAT), limiter
  capacity and server saturation can still refuse legitimate sign-in.
- EN/PT auth guidance documents the trade-off, shared NAT/per-process limits
  and SMTP-disabled operator recovery: verify identity through a trusted
  separate channel, reset through the project panel, block abuse at ingress,
  use an independent source or allow up to 60 seconds without new attempts for
  full refill. A password reset does not erase throttle buckets.
- #103's initial `367720be68206a0f0aac454476ae682f350818d6` failed CodeQL with
  four literal test-password alerts. Generated disposable credentials and the
  final main update pass CodeQL without suppression or changed thresholds.
  The failed run is retained, not relabeled as passed.
- Rust/Vitest/audit runs in this follow-up are sequential, with four Cargo jobs
  and two Rust test threads. Only disposable local fixtures are used.

## Published release and SDK versions

[PR #104](https://github.com/Nelcota/Nelcota/pull/104) merged as
`b18412a65f4accc4d759d7f840e50420d32d7579`. The published server release is
[v0.5.0](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.0); its tag points
to that commit. F01/F05 are fixed through #105 and publicly described by the
[advisory][g06-advisory].

- Server/core/auth: **0.5.0**.
- TypeScript SDK: **0.2.0**, published as `@nelcota/client` on npm.
- Rust SDK: **0.1.3**, published as `nelcota-client` on crates.io.

Installing or updating the server does not update application SDK packages.
The final documentation branch was updated by an ordinary merge of main
`6bdfc030dec053c07baae636b579c059d72a66fa`; this changes no review baseline.

### Historical release-candidate validation

The independent TypeScript minor accounts for required native
IndexedDB and wider generated numeric/array types. Rust retains Rust 1.88+ and
server 0.3.0+ compatibility. Workspace registry versions/checksums are unchanged;
the new consumer lock preserves the same registry entries. SDK/source version
metadata is not registry publication.

At exact public candidate `070cf10ae34060a2101b884be820f70ba53854a7`, local
TypeScript checks pass 212 unit + 15 type tests, package installation and runtime
smoke; auth gzip is 11,246/11,250 B. Rust SDK checks pass 31 tests + 10 doctests,
plus 7 real-server HTTP/Postgres contracts. Catalog validation and 37 guide tests
pass; generated guide assets are a separate commit.

Native Notes acceptance passed **twice**, six functional groups per run, on
PostgreSQL 17.11 with the same binary SHA-256
`69e3161a891511ac7fc546c1fa8e01a197a66e3ac2258eb28892ae03caea6f15`.
Its bytes were rechecked after each run; owned containers and volumes were
removed. These are public-candidate acceptance checks, not a new stress soak or
certification of deferred integration.

At that candidate checkpoint, local browser acceptance was **blocked
(environment)**: executables were absent and Playwright's CDN download returned
HTTP 403 Domain forbidden. No alternate download/proxy bypass was attempted.
Ordinary CI browser checks were still required;
the locally blocked check is not counted as passed. Real OAuth/mail and public
TLS/VPS acceptance remain outside the available fixtures. Historical G05
measurements are not relabeled as 0.5.0 results.

The original follow-up started at 2026-10-18 19:56:28 UTC. Its six-hour checkpoint
was due 2026-10-19 01:56:28 UTC and hard budget ended 2026-10-19 11:56:28 UTC.
At that checkpoint the record and release PR were draft; that original run did
not publish a tag, GitHub Release, SDK package or deployment. Publication has now
been verified separately above. These historical candidate results are not
relabeled as new validation of the released artifact.

[g06-advisory]: https://github.com/Nelcota/Nelcota/security/advisories/GHSA-9f7h-6cpv-wh6q

<details>
<summary>Original bounded review — completed 2026-10-18 19:17:58 UTC</summary>

Status: completed with open findings. This bounded source review is not an external audit,
penetration test, compliance certification or production acceptance.

Completion summary: **17 rows examined: 8 passed, 5 fixed on unmerged PRs,
4 open-finding rows.** Finding counts: 0 Critical, 2 High, 4 Medium and 1 Low.
F01/F05 were awaiting coordinated disclosure at that cutoff; their public
resolution is recorded in the current ledger above. Real OAuth providers and real
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
| Password reset and magic links | open finding at original cutoff — F01, High | Reviewed at the frozen baseline; public summary in the current ledger above. | Original local verification completed. Subsequently fixed by #105 in server 0.5.0; see the [advisory][g06-advisory]. |
| Email verification and change | passed for implemented flows | `confirmation.rs`, `verify.rs`, account/inbox ownership | Auth 27 + OAuth 18 cover proof of inbox ownership, unverified identities and single-use confirmation. Self-service email change and account-disabled state are not implemented; source search and an ignored email-update-field probe confirm this sub-scope is not applicable. |
| OAuth (local doubles) | passed for implemented local flow | `auth/oauth.rs`, flow/identities/provider/PKCE/redirect adapters | OAuth 18 + auth units cover state, PKCE, exact configured provider callback, redirect allowlist and linking refusal. Google uses authenticated userinfo, not ID-token validation; parser negatives run. Real provider behavior remains blocked (environment). |
| Cookies, CSRF and origin | passed for documented topology | `admin/auth.rs`, `middleware.rs`, server CORS and panel auth state | Panel auth/cookie units, controller boundary tests and extra CSRF/CORS probes reject foreign/null origins and cross-site mutations. Secure/HttpOnly/Strict attributes are checked; generated proxied deployments enable proxy trust. Public TLS is not exercised. |
| Panel SSO | open finding at original cutoff — F05, High | Reviewed at the frozen baseline; public summary in the current ledger above. | Original panel SSO, controller-boundary and scoped-worker checks completed. Subsequently fixed by #105 in server 0.5.0; see the [advisory][g06-advisory]. |
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
| G06-F01 | High | Password reset and magic links | Open at original cutoff; subsequently fixed in #105/server 0.5.0 with transactional pending-credential retirement on password replacement; see the [advisory][g06-advisory]. |
| G06-F02 | Medium | JWT | Open decision: built-in issuer/audience are deliberately informative; future `nbf`/`iat` are not enforced. Tightening the documented policy requires a contract decision. |
| G06-F03 | Medium | Input handling | Fixed in isolated [PR #99](https://github.com/Nelcota/Nelcota/pull/99), 17/17 applicable CI passed on `e388912e72f52b9f7f7791644080415817ac733c`, ready; account verification bounds precede pool admission. |
| G06-F04 | Low | Errors, logs and config | Fixed in isolated [PR #100](https://github.com/Nelcota/Nelcota/pull/100), 17/17 applicable CI passed on `e2aa4e59eb5c9593e27fd8cea4b94ef38f91da9b`, ready; redact explicit adapter/configuration Debug views. No default-path production leak claimed. |
| G06-F05 | High | Panel SSO | Open at original cutoff; subsequently fixed in #105/server 0.5.0 with atomic, durable project-database redemption receipts; see the [advisory][g06-advisory]. |
| G06-F06 | Medium | SDKs | Fixed in isolated [PR #101](https://github.com/Nelcota/Nelcota/pull/101), 17/17 applicable CI passed on `c9e861d1b295a518f48282b138477bfacaa44dbe`, ready; retire pending OAuth verification state on sign-out. |
| G06-F07 | Medium | Brute force and abuse | Open policy decision: independent source addresses can exhaust an account quota and a subsequent correct login receives 429; with supported SMTP-disabled configuration, recovery/magic-link requests return 403. Do not weaken throttling; decide on independent recovery/unlock requirements. |

## Findings and disclosure

At the original cutoff, **G06-F01 (High)** and **G06-F05 (High)** were confirmed
and awaiting coordinated disclosure. Dynamic exploration stopped after
confirmation. Both are now fixed by #105 in server 0.5.0. Their short public
summaries and severity are in the current ledger, limited to the
[published advisory][g06-advisory]. This finalization adds no F01/F05 exploit
steps, request sequences or proof-of-concept code.

The original run required unconfirmed suspicions to be reproduced or rejected
and restricted disclosure of unfixed High/Critical findings to their identifiers,
severity and checklist rows. Those historical boundaries did not authorize
publication of private evidence. This finalization uses only the advisory's
published F01/F05 description.

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
account features remain explicit. F01/F05 awaited coordinated disclosure at
this original cutoff; their subsequent public resolution is recorded above.
No G05 campaign, VM probe, production action, new dependency or migration ran.
The execution PR remains draft. Release preparation is private and publishes
no version, tag or release artifact.

</details>
