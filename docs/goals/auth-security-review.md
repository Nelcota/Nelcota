# G06: Authentication and session security review

Status: finalized after publication of server 0.5.0 and the public advisory.
All seven findings have merged resolutions, including the documented F07
mitigation trade-off. See the [execution record](auth-security-review-execution.md)
for the final ledger and the preserved original plan/results. This goal certifies
no external audit, penetration test, production acceptance or compliance standard.

Planning baseline: `7df975cf0bbed970f01948d559e959b38404a111` (`main` after the G05 production
fixes have merged). Review one frozen SHA; never review a moving checkout.

## Objective

Find and fix exploitable weaknesses in Nelcota's authentication, session and
account-recovery flows before they reach users. Demonstrate with focused
regressions that no confirmed issue allows account takeover, authentication
bypass, cross-project credential use, privilege escalation or credential
leakage.

The goal converges: every checklist cell ends with a verdict, confirmed
findings get bounded fixes, and the review stops at its declared limit.
Completeness means "every cell examined", not "no further idea remains".

## Scope

In scope:

- Native Rust backend auth endpoints: signup, login, logout, refresh,
  password recovery/reset, magic links, email verification/change and any
  OAuth sign-in it implements.
- Password hashing (Argon2 parameters, hash-worker admission) and credential
  storage in PostgreSQL.
- JWT issuance and validation, per-project signing keys, key rotation,
  anon/service-role keys and the claims that RLS policies consume.
- Refresh-token storage, rotation, replay detection and revocation.
- Cookies, CSRF/origin checks and the browser panel's login/session handling,
  including project-panel SSO and its boundary with host-controller authority.
- TypeScript and Rust SDK token handling: storage, refresh coordination,
  multi-tab sign-out, and tokens in URLs/logs.
- Auth-related configuration defaults, secrets handling, logs and error
  responses.

Out of scope (separate goals): load capacity (G05), host-management
operations beyond the SSO authority boundary, storage and webhook
authorization except where they consume auth claims, and infrastructure
hardening (OS, firewall, Caddy TLS configuration).

## Execution boundaries

- Use disposable local fixtures with generated credentials. Never test
  against production, real user accounts or public third-party services.
- Use controlled SMTP and OAuth doubles. Real provider behavior (Google,
  GitHub etc.) and real mail deliverability are **blocked (environment)**
  from the start; do not try to work around that.
- Keep credentials, tokens, cookies, reset/magic links and password hashes
  out of commits, PR text, logs and test names.
- **The repository is public.** Do not push exploit details, proof-of-concept
  requests or descriptive vulnerability titles for unfixed Critical/High
  findings. See the finding policy.
- Follow [AGENTS.md](../../AGENTS.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md):
  four Cargo jobs, two test threads, sequential Rust/Vitest/audit runs.
- Preserve documented HTTP/SDK contracts and immutable released migrations.
  A fix that requires a contract change is recorded as a finding needing a
  maintainer decision, not changed silently.

## Review checklist

Each cell needs: code reading of the owning path, at least one dynamic
negative test against a running fixture, and a verdict. Existing tests may
satisfy the dynamic requirement when they actually assert the negative case.

| Area | What must hold |
|---|---|
| Password storage | Argon2id with documented parameters; per-hash salt; no plaintext or reversible storage; upgrade path when parameters change. Maximum password length is bounded so long inputs cannot exhaust hash workers. |
| Login | Constant-shape responses for unknown user vs wrong password (status, body, comparable timing); verification uses constant-time comparison; disabled/unverified accounts follow the documented policy. |
| Brute force and abuse | Per-account and per-source throttling or documented equivalent; hash-worker saturation returns the documented overload response without blocking other projects; throttling cannot be used to lock out a victim indefinitely without a recovery path. |
| Account enumeration | Signup, login, recovery, magic link and email change do not reveal account existence through status, body, timing or side effects beyond the documented policy. |
| JWT | Fixed algorithm allowlist (no `none`, no alg confusion); signature, `exp`, `nbf`, `iat` skew, `iss`/`aud` and project binding are enforced; a token from project A is rejected by project B; key rotation invalidates or accepts tokens exactly as documented; claims used by RLS cannot be supplied by the client. |
| API keys and roles | Anon and service-role keys cannot be swapped or escalated; service role is never reachable from browser flows; the database role and settings are reset between pooled requests. |
| Refresh tokens | Stored hashed; single use; rotation is atomic under concurrent refresh; replay of a used token revokes the token family per the documented contract; refresh after logout, password change or revocation fails. |
| Logout and revocation | Logout revokes the server-side session; revocation reaches every app/auth-consumer instance; access-token lifetime after revocation matches the documented bound. |
| Password reset and magic links | High-entropy tokens stored hashed; bounded expiry; single use enforced atomically; bound to purpose (reset vs magic vs verify) and to the account; old tokens invalidated after use or password change; link host is not derived from attacker-controlled headers; redirect targets are allowlisted. |
| Email verification and change | Changing email requires proof of the new address and notifies or protects the old one; an unverified email cannot take over an existing account. |
| OAuth (if implemented) | `state` and PKCE verified; exact `redirect_uri` match; ID token signature/issuer/audience/nonce checked; account linking cannot attach a provider identity to an existing account through an unverified email. |
| Cookies, CSRF and origin | Session cookies are `HttpOnly`, `Secure`, appropriate `SameSite` and correctly scoped (prefer `__Host-`); state-changing cookie-authenticated requests require CSRF/origin validation; CORS does not reflect arbitrary origins with credentials. |
| Panel SSO | Project-panel SSO grants only its documented project scope and never host-controller authority; a session for one project cannot act on another. |
| SDKs | Tokens are not placed in URLs or logs; refresh is coordinated so concurrent tabs/clients do not trigger replay revocation; sign-out clears all stored credentials; server-side SDK usage keeps sessions isolated between requests. |
| Input handling | Email normalization (case, Unicode) cannot create duplicate or colliding accounts; oversized and malformed inputs are rejected before hashing or database work. |
| Errors, logs and config | No tokens, hashes, reset links or SQL in responses or logs; insecure defaults (weak secret, debug mode, permissive CORS) are rejected or loudly warned at startup. |
| Dependencies | `cargo audit` and the npm audit for panel/SDK packages are clean or each advisory is triaged for actual reachability in auth paths. |

If a feature in a row does not exist in Nelcota, mark it `not applicable`
with the evidence (code search) rather than inventing work.

## Phases

1. **Inventory and threat model.** Map every auth endpoint, token type,
   cookie, key and SDK entry point to the checklist. Record which existing
   tests already cover each cell. Output: coverage table in the execution
   record.
2. **Code review.** Read each owning path against its checklist row. Record
   suspected issues in the finding ledger as `suspected`.
3. **Dynamic verification.** For every cell, run negative tests against a
   disposable fixture. A suspected issue becomes `confirmed` only with a
   reproduction; otherwise it becomes `rejected` with the reason.
4. **Fix.** Fix confirmed findings in their owning packages, each with a
   regression that fails before and passes after. Re-verify only the
   affected cells; do not restart the whole review.
5. **Report.** Write the final Portuguese report and stop.

## Finding policy

Severity:

- **Critical:** account takeover, authentication bypass, cross-project
  access, service-role escalation, or credential disclosure without user
  interaction.
- **High:** the same outcomes requiring user interaction or a precondition,
  or session revocation that does not work.
- **Medium:** enumeration, missing throttling, weak defaults, information
  leakage without direct takeover.
- **Low:** defense-in-depth and hardening.

Handling:

- **Critical/High:** stop dynamic exploration of that issue once reproduced.
  Record details only in the private ignored directory
  `target/auth-review/<run-id>/` and report to the maintainer immediately.
  Fix commits use neutral messages (e.g. `fix(auth): tighten token
  validation`) and contain no exploit narrative. Public description waits
  until the fix is merged or the maintainer decides otherwise.
- **Medium/Low:** fix with regressions when the change is local and keeps
  documented contracts; otherwise record with a recommendation.
- A fix that needs a contract or migration change, or a new dependency,
  waits for a maintainer decision. Record it and continue the review.
- Do not lower existing security checks, Argon2 parameters or test
  thresholds to make anything pass.

## Stop condition and budget

The review is complete when every checklist cell has one verdict
(`passed`, `fixed`, `open finding`, `blocked (environment)` or
`not applicable`) with an evidence location, and every confirmed finding is
either fixed with a regression or recorded with a recommendation.

Hard wall-clock budget: **24 hours** from the start of phase 1. If it is
exceeded, stop where you are, mark unreviewed cells `not run`, write the
report with the current state and end. Do not start new cells after the
budget expires.

Do not add new scope, checklist rows or tooling beyond what a cell requires.
Ideas outside the checklist go into a "future work" list in the report.

## Deliverables

- Execution record: `docs/goals/auth-security-review-execution.md`
  (coverage table, cell verdicts, no exploit details for unfixed
  Critical/High findings).
- Finding ledger: private in `target/auth-review/<run-id>/`; a redacted
  public summary in the report once fixes merge.
- Fixes: small focused PRs, each with failing-before/passing-after
  regressions and all ordinary CI checks green on its exact SHA.
- Final report in Portuguese: reviewed SHA, cell verdicts, findings by
  severity and status, fixes with PR links, blocked/not-run cells and
  future work.

- [ ] Frozen SHA recorded and coverage inventory complete.
- [ ] Every checklist cell has a verdict and evidence location.
- [ ] Every confirmed Critical/High finding is fixed or escalated to the maintainer.
- [ ] Fixes have focused regressions and green CI on their exact SHAs.
- [ ] `cargo audit` and npm audit results are triaged.
- [ ] Final Portuguese report written; review stopped.

Related: [G02](architecture-security-performance.md),
[G05](https://github.com/Nelcota/Nelcota/blob/68d62df4a78276dc5bb60b4d6a36ff2491dde9b0/docs/goals/full-stress-verification.md), [configuration](../configuration.md),
[architecture](../architecture.md).