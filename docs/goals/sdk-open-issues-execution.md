# SDK open-issue corrections

Status: implementation/revalidation in progress; no merge/publication approval.
Baseline: `84a55c3bb8c7698a0f8d0f6dd1a01153b748b925`.
Branch: `fix/sdk-open-issues`. Review date:2026-10-24.

## Scope and before/after evidence

The live GitHub inventory contained issues132–142 and the unrelated Dependabot
PR130. No unrelated PR was modified. Keep the unpublished G11 Next candidate in
its own draft PR; do not merge/publish it with production corrections.

- #132/#133 retain their focused local corrections, before/after proof and
  separately rebuilt embedded guides from the earlier review.
- New TypeScript regressions on the pre-correction SDK: **27 failed /4 passed**;
  the new embedded-filter type regression also failed. Failure logs identify
  actual assertions, not fixture/startup errors. After the first correction
  pass:361 unit tests and19 type tests passed. Final counts are recorded below.
- #134 and #139 also reproduced in Rust: expired logout failed to revoke and
  reserved-column filtering was overwritten. Both focused tests failed on the
  original source before the Rust correction.

## Decisions

1. Preserve every size/test/security limit. Restore main's root/auth caps,
   superseding the earlier exploratory +100B allowance in the #132 work. Bundle size currently exceeds its
   existing budgets after these fixes. This is a blocking check, not permission
   to raise budgets or declare the PR ready. Retain all functional protections.
2. For #137 release the journal reservation only for the auth endpoint's explicit
   `429 rate_limited` pre-grant rejection. A gateway500/502/503/504 may follow an
   accepted request; it does not prove rollback. Preserve the uncertain-outcome
   fence rather than risking reuse of a spent grant. No false refreshed event
   is emitted when simply releasing a rate-limit reservation. #137 is addressed
   conservatively, not automatically closed with an unrestricted HTTP-error rule.
3. Existing storage.open defaults already disable transfer deadlines on main.
   #135 is reproducible with an explicit timeout; stop that attempt timer at
   headers, retain caller cancellation and buffered-body deadlines. Do not
   claim the default30s behavior existed in this exact source snapshot.
4. Keep native pending-refresh logout behavior: another tab can clear an uncertain
   reservation without attempting another rotation. Normal expired logout renews
   under the existing lifecycle gate before revoking and always clears locally.
5. Native/shared auth messages carry event kinds only, never credentials; legacy
   `changed` messages still work. Explicit sessionStorage is private to its tab;
   unchanged custom-adapter reloads emit no misleading event.
6. Non-browser lifecycle locks are scoped by storage adapter identity and key;
   separate request adapters do not block one another. Same-adapter clients
   continue to coordinate. This is not cross-process storage coordination.
7. Reserved modifier columns use quoted one-leaf logic groups, including embeds,
   instead of colliding with pagination/sort/selection. Fix both language SDKs.
8. The current workspace RustSec audit has a backend-only crypto-bigint advisory
   (RUSTSEC-2026-0387), absent from the Rust SDK graph. Do not add an ignore or
   force an incompatible major upgrade to hide the workspace failure.

## Review gates

- Run Rust, Vitest and audits sequentially; four Cargo jobs/two Rust threads,
  two Vitest workers. Disposable loopback fixtures only.
- Rust checks use a dedicated cache with debug symbols disabled (functional
  debug assertions remain enabled), disk reserve512MiB, ten-minute command cap.
- Verify source diffs, types, runtime/cancellation, packages, translations and
  generated assets. Never label old artifact results as current-server evidence.
- Push and open draft PRs if blocking size/audit checks remain. No merge, tag,
  release, deployment or package publication in this task.

## Final local correction checkpoint

- TypeScript: **362 unit tests,20 type tests passed**; check/build and external
  packed JS/TS consumer passed. Node24 runtime smoke passed. The memory suite
  passed three1000-caller cancellation rounds and two200-call queued auth cases.
- Rust SDK: **46 executable tests +10 doctests passed**; scoped all-target
  clippy with warnings denied and workspace fmt check passed. Both new Rust
  regressions failed before correction and passed afterwards.
- Final-source server auth: **28 passed**, including oversized-refresh validation
  and normal grant rotation, on isolated databases in the shared test fixture.
  The earlier disk-blocked server test is now unblocked; no threshold changed.
- Portuguese catalogs match source fragments;37 guide tests and panel production
  build passed. Generated assets are rebuilt in a separate commit.
- Blocking size check (main limits retained): root18275/17400B,
  auth12077/11300B, REST9857/9550B, storage7875/7700B gzip.
- Workspace RustSec advisory remains a separate failing supply-chain gate;
  no ignore, workflow change or incompatible dependency override was added.

The event kind is bound to the committed native receipt revision so a delayed
old notification cannot label a newer identity with an obsolete event. Legacy
changed notifications are still sent for older tabs; new clients deduplicate
unchanged state. An explicit sessionStorage adapter is not subscribed across tabs.

Issue mapping: fixes132,133,134,135 (explicit raw-response timeout),136,138,139,
140,141,142. Addresses137 for the definite pre-grant rate-limit case; keep it
open for review of its broader HTTP-error proposal. Do not automatically resume
a token after a gateway failure whose commit outcome is unknown.

Open draft PR for review with these blockers visible. No merge/release/tag or
publication is part of this task. The unrelated Dependabot PR130 stays untouched.
