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

## Second review checkpoint — 2026-10-24

Request: continue the review across all SDKs. Baseline for this pass:
`a9b8b265ff989412c403ce501605584ee6e48958`. No production requests, package
publication, merge or disclosure of unrelated private audit artifacts.

### Review and new evidence

- Examined REST identifier/path encoding and filter quoting in both languages,
  transport auth headers/retry/deadline/cancellation, session publication and
  caller identity, native persistence, JSON/exact-number handling, storage
  validators, Next encryption/key binding/nonce, shared ownership and proxy/CSRF.
  Source inventory records59 files and their hashes in the private artifacts.
  This is a targeted security review of those boundaries, not proof that every
  possible behavior or export is bug-free.
- Added two TypeScript regressions using actual local HTTP servers. A307
  cross-origin storage redirect reaches its destination without Bearer or
  Cookie. Encoded traversal-like table/RPC names remain percent-encoded within
  their intended REST segment. Both tests passed; no production defect was
  inferred from a mere suspicious string.
- **G12-01 reproduced:** two first logins sharing an initially empty browser
  cookie jar, with the older response delayed, end on the older identity after
  the newer login succeeded. The private controlled reproducer records the
  expected identity and actual identity. Completion gate FAILED. This proves
  stale identity ordering, not an external privilege escalation. Severity:
  medium correctness/session-integrity risk for the unpublished Next candidate;
  publication blocking. Remains open: a bootstrap/intent ownership design must
  work across processes; a module-local mutex is not an adequate correction.
- G12-02 remains a compatibility limitation of fail-closed redirects; do not
  weaken the policy to make an S3 test pass. No S3 provider configured here.
- G12-05 narrowed: standard credentials were stripped in the tested native
  Node fetch path. Arbitrary custom transports/secret headers and auth-body
  redirects require separate evidence; the test does not certify them.
- G12-06 narrowed by inspection: FileStorage is a caller-owned local path,
  not an untrusted upload destination. Its fresh0600 atomic writes do not make
  parent directories a security boundary. No proven cross-user file exploit
  established. Dedicated hostile filesystem tests remain unrun.

### Fresh supply-chain result: workspace audit failed

`cargo audit --json` fetched the current advisory database and exited1:
**RUSTSEC-2026-0387**, `crypto-bigint0.5.5`, timing variability in operations
intended to be constant-time. Published2026-10-23; advisory lists0.7.6 as patched.

Dependency attribution was checked with `cargo tree --locked -i crypto-bigint`:
it is pulled through elliptic-curve/ecdsa/p256/p384 and jsonwebtoken/openidconnect
in the **backend**. `cargo tree --locked -p nelcota-client -i crypto-bigint`
reports no matching package in the SDK graph. A separate SDK-only dependency
inventory confirms absence. Do not attribute this advisory to the Rust SDK,
claim the workspace audit passed, or infer practical key recovery without
algorithm/secret-operation reachability analysis.

No ignore rule or blind major-version override added. Backend dependency
compatibility/reachability remediation requires a separate focused change;
forcing crypto-bigint0.7 into dependencies expecting0.5 is not a safe fix.

`cargo deny` is unavailable (`no such command: deny`). License strings for the
SDK graph were inventoried, but this is not an automated license-policy pass.
Do not install/build extra tooling with the current disk reserve.

### Validation updates

| Check | Result |
|---|---|
| TypeScript check | Passed after new security tests |
| TypeScript full unit suite | **330 passed** (328 prior +2 added) |
| TypeScript type suite | **18 passed**, no type errors |
| Node24 runtime smoke | Eight scenarios passed: login/read/encoding/count/PKCE/upload/timeout/abort; fixture transport, not a new real-backend test |
| TypeScript memory regressions | Three rounds of1000 cancelled callers: zero retained signals before completion; queues of200 with and without Web Locks: zero retained signals |
| Rust/Next regression suites | Prior G12 results retained:44+10 Rust and55 Next; no corresponding source change this pass; not relabelled as rerun |
| Current RustSec workspace audit | **Failed**, one new advisory; absent from tested SDK graph |
| SDK license-policy automation | **Blocked (environment)**: cargo-deny unavailable |
| Final-source server/provider rebuild | **Blocked (environment)**: approximately443MiB free, too close to300MiB reserve for another large build |
| Full browser/version/provider/soak matrix | Not run; previous G11 evidence retains its own scope and artifact identity |

An initial Vitest invocation from repository root did not select the SDK project;
it failed at startup. Re-running from the actual SDK directory passed. This was
an invocation error, not a product failure or evidence of a fixed vulnerability.

### Assessment and next actions

The released SDK implementations gained security-boundary regression evidence;
this pass found no newly demonstrated cross-user authorization escape in them.
That statement is limited to reviewed paths/tests, not blanket security approval.
The Next candidate **must remain unpublished** while G12-01 and G11 completion
gates are open. The workspace advisory needs backend triage before treating
whole-project supply-chain checks as green.

Next: resolve initial-cookie identity ownership with a distributed/browser
reproducer, design/test safe S3 redirect destinations, provide disk/tooling for
final-source backend/Rust license checks, and complete the remaining runtime,
provider and hostile-state matrix. G12 remains **in progress**, not complete.

## Third checkpoint — production issue PR and candidate revalidation

Draft PR143 (`fix/sdk-open-issues`) contains the production SDK/refresh fixes;
this goal/candidate is a separate stacked draft. Issues132–142 were reviewed.
Ten have closing references in143;137 is deliberately only addressed for the
explicit pre-grant rate-limit rejection, retaining the fence for uncertain
network/gateway outcomes. Issues stay open until reviewed fixes merge.

Current local results supersede prior test/resource blockers where stated:
362 TS unit +20 type tests;46 executable Rust +10 doctests;57 auth library and
28 server auth tests passed. The final32-case issue regression set failed29
assertions on the baseline; both new Rust regressions failed before correction.
The Next candidate has58 passing cases and fresh real Next/Chromium, packed
consumer and current-source backend/RLS evidence in G11's latest checkpoint.
The reserved-filter predicate was also verified against the real backend with
before/after failure/pass. No production data, deployment or publication used.

New candidate corrections: clear the adapter's header timer before handing over
an accepted stream, and reject empty query/fragment delimiters at configuration.
The auth HTTP fixture now generates its signing key at runtime. No real credential
or private security-review bundle was staged or pushed.

The initial-login ordering finding remains open and publication blocking. Safe
S3 redirect handling and the full matrix remain incomplete. Do not present this
as a completed G11/G12 security certification.

Three ordinary CI blockers have been identified in143: SDK bundle caps, backend
RustSec supply-chain advisory, and existing admin UI npm-audit undici advisories
through Scalar. The UI lockfile is identical to main; unrelated Dependabot PR130
is untouched. Keep strict checks enabled and the PR draft. Raw hosted job-log
storage returned403 in this environment; GitHub job metadata and local npm audit
identified the failing steps without bypassing access checks.

Supplemental private logs remain under `/workspace/artifacts/g12/`; versioned
commands/results are the durable review record. No main merge, release, tag,
package publication or VPS operation was performed.
