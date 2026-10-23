# G10: Operational logging execution record

Status: bounded execution finished; four corrections locally validated, disk latency gate failed, S3 passed. Overall performance approval remains blocked. This bounded pass does not certify all logs or production sinks.

## Provenance, authority and timing

Public-main baseline: `4d4034835ebc55538dabf3c2df109faea4cc8e13`. Local branch `local/g10-operational-logging`, independent of G09. No public push, PR, merge, tag, release, package publication, deployment, VPS access or repository/workflow setting change.

Original start/deadline: 2026-10-23 02:08:47–08:08:47 UTC. The original phase remained incomplete. There is a gap after the last command completed at 02:20:56 until observed continuation at 11:07:20; its cause is not established. It is not testing time. The user explicitly asked to continue; a separate 11:07:20–15:07:20 bounded continuation is recorded, preserving the initial failures and missed original deadline. The shared test PostgreSQL stayed idle across the gap and was explicitly removed before final timing. This is a cleanup limitation, not endurance evidence.

First frozen candidate: source `55a918803cd58430879033bf49c39477e0a6ddda`, ELF `a2e2841959b5eaceb5e324db264ad177eb4c6e5cccef6eaeff305cca076a12a0`; preserved and not certified by a load campaign. Final provider-aware v2 source `bd805a245f8454d8b5e620e950a2b47d14de61b3`; final ELF SHA-256 `ec72a81da28046b3062a71093f27a61e1bbe609ba90788b9f891cb7660718127` is recorded in `final-elf-v2.json`. No first-candidate evidence is relabeled as v2. Rust 1.99, release/thin LTO/codegen-units=1. Current published server is 0.5.1; this local main-derived binary is not that published artifact. G09's independent frozen ELF does not include these corrections; no combined artifact is approved.

Private evidence: ignored `target/g10/20261023T020847Z` and `target/g10/20261023T110720Z`; commands, source identities, exit codes, exact timestamps and safety samples retained. Raw runtime log capture was deliberately not retained; probe records only synthetic-canary booleans, byte counts and artifact hashes.

## Four selected corrections

1. HTTP diagnostic boundary: log actual router templates rather than path values, allowlist standard methods (`OTHER` for extensions), bound log correlation IDs to 128 ASCII letters/digits/`._:-`, and redact other values. Preserve the incoming response header and normal proxy correlation. Enable Axum's existing empty `matched-path` feature in the server only; no crate/version/lockfile dependency addition. Keep URI queries, payloads and headers out of these events. This is diagnostic hardening, not anonymization of arbitrary caller-supplied IDs.
2. Database boundary: replace opaque database message rendering with stable `event` and SQLSTATE `code`. Pool events distinguish wait/create/recycle timeouts, backend, closed, missing runtime and post-create hook; backend SQLSTATE remains available. Public error mapping, body fields, status and retry behavior are unchanged. Preserve the existing owner of failures; no new retries, caches, tasks or sinks.

3. Mail delivery: keep a stable `auth.mail_delivery_failed` event, message kind and static error type instead of arbitrary provider text. Admission, timeout, permit ownership and public recovery responses are unchanged.
4. Storage diagnostics: replace opaque provider/JSON error text and identifying bucket/object/path values with stable events, static error type and bounded typed IO causes. Missing-byte diagnostics retain the opaque version UUID. Multipart abort still owns its permit until cleanup completes; remove the private key retained solely for logging. No upload, cleanup deadline, retry or public API changes.

Local commits: `a36a4e5a` goal; `36408d25` HTTP plus regressions; `b1eb7282` database plus regressions; `27b2f9af` English/Portuguese operator guidance; `55a91880` separately rebuilt embedded assets; `28006e80` reuses G09's minimal restart-diagnostic distinction in the existing benchmark runner. That harness change alters neither limits nor workloads. Provider correction `ab587ca5`, EN/PT guidance `3447cc0c`, generated assets `bd805a24`.

## Before/after and local checks

Original source: seven logging tests, normal correlation passed and six failed. Confirmed failures were raw route values, amplification by large IDs/methods, internal/transient database message rendering, and absent backend pool classification. Pool message leakage was not reproduced; its confirmed gap is classification. Both initial after attempts failed compilation because the existing matched-path feature was disabled; no test passed in those attempts. They remain in the ledger. With that empty feature enabled, all seven pass, covering text/JSON, unchanged responses and bounded lines.

Additional focused candidate checks: core error tests 4; server hardening 7; request-ID API contract 1; shutdown/cancellation memory regression 1; guide Vitest 37. All passed. The signed-download regression also passed independently, with token exclusions intact and the route-template assertion updated. These duplicate runs are not additional unique cases. Fmt, workspace/all-target Clippy `-D warnings`, architecture boundaries, guide/catalog checks, embedded UI build and release build passed. Rust/Vitest/audits were not concurrent; four Cargo jobs, two Rust threads, at most two UI workers. No GitHub Actions or complete workspace correctness suite is claimed.

Real owned-container JSON runtime probe at `RUST_LOG=trace`: before/after signup201, missing-table404. Path canary present before, absent after; configuration-secret, synthetic email, hash and query-token flags absent both. Driver DEBUG events were zero both: current tracing-subscriber lacks log bridging. That hypothesis was disproved, so no speculative filter/dependency was added. This probe validates those canaries, not every possible third-party diagnostic.

A dedicated synthetic provider regression first failed due to an invalid auth fixture (RowCount); those text/JSON attempts prove nothing about the product. After correcting only the fixture, the test failed on the old code in both formats for five observations: provider mail text, oversized mail line, bucket identifier, storage path, and deferred-delete key/path. The unchanged behavioral assertions (signup201, recover200, upload201, missing bytes404 and backend failure500) pass after the fixes in text and JSON. Repeated final checks: storage units16, auth units53, provider regression1 per format, storage API3, existing hardening7 and logging7 passed. Fmt, all-target workspace Clippy, boundaries,37 guide tests, catalog checks and UI build passed. One obsolete private Guard constructor caused an initial compile failure after key removal; its retained test setup was adjusted without changing cancellation assertions, then all16 storage tests passed.

## Coverage and limits

| Cell | Verdict | Evidence / remaining boundary |
| --- | --- | --- |
| L01 HTTP | Corrected and locally validated | Four HTTP-focused cases plus existing correlation/token tests, text/JSON and production ELF probe. Parser/proxy rejection logs are separate. |
| L02 Database | Corrected and locally validated at application boundary | Two SQLSTATE cases, pool classification and existing error contracts. PostgreSQL's own server logs are not redacted by this patch. |
| L03 Auth | Mail failure corrected/validated; broader auth source-reviewed | Text/JSON provider regression plus53 existing units; OAuth text and account/session IDs need separate privacy/audit policy. No session behavior refactor. |
| L04 Storage/integrations | Selected storage diagnostics corrected/validated | Real disk failure/missing-byte/deferred-delete canaries,16 cancellation/cleanup units,3 API tests; real remote SMTP/cloud sinks and every cleanup error branch not certified. |
| L05 Workers | Source-reviewed only | Existing bounded delivery IDs/retries and Skip timers retained; no new fault/log-storm certification. |
| L06 CLI/host | Source-reviewed only | Existing output/approval/fencing preserved. G09 host acceptance belongs to its separate source/artifact and is not transferred as G10 evidence. |
| L07 Panel/SDK | Source-reviewed; guides validated | No direct SDK console telemetry found; no SDK API/bundle changes. No privileged panel raw-log reader or new telemetry. |
| L08 Sinks | Guidance validated; real deployment blocked | EN/PT retention/access/support guidance plus37 tests; journald, proxy, PostgreSQL and actual VPS rotation remain deployment gates. |
| L09 Robustness/cost | Adversarial fields validated; disk API comparison failed latency gate | Long fields, JSON validity and response contracts tested. INFO/JSON logging overhead not measured, never claimed free. |
| L10 Usability | Scoped synthetic validation | Request correlation, stable SQLSTATE/pool events and recovery guidance; logs are not proof of commit/backup/update success or authorization to retry. |

WARN-profile disk API campaign passed correctness/resource/delivery invariants, but comparison FAILED: RLS p95 +19.74%, storage +11.80%, login +14.26%; other four scenarios passed. Three valid samples per side, original 10% ceiling and no baseline-failure override. Final queue=0, idle transactions=0, waiting locks=0,17 objects verified and signatures valid. Causality is unresolved; performance approval is blocked, corrections remain local, and no retry-until-green was authorized. Independent S3/stability cells continue under the predeclared failure policy. Even if green, it does not measure INFO/JSON formatting/sink cost or all external logs. No public CI, compliance, leak-proof or complete durable audit-trail approval. Broader auth/provider/sink work remains explicit follow-up, not silently passed.

Final local S3 provider comparison passed: p95 ratio0.926572, three valid samples each, unchanged ceiling. Real disposable RustFS loopback/HTTP; not remote cloud/TLS. Both campaigns passed final integrity/queue/database checks and cleaned their fixtures. This does not supersede the failed disk comparison.

## Final handoff and limits

G10 timing: 1670.659s (27.844min) estimated completed k6 traffic from disk/S3 summaries, excluding preparation and ordinary tests. Earlier/final candidate identities and all failed attempts remain separate. G09's continuous1800s validation uses unchanged original product code; it is not G10 endurance evidence. All owned G10 fixtures removed; no running containers after the shared sequence. Old unrelated Docker objects preserved.

Future work remains source-only: OAuth provider text, account/session identifiers, panel request-observation data/retention and async context propagation. Application tracing redaction does not certify those separate records or PostgreSQL/proxy logs. No fifth target was added without reproduction; no durable audit or global logging framework was introduced. Performance gate findings stay open before publication/approval. See the Portuguese report and private manifests for exact evidence; no public CI was run.

## Follow-up review

Full changed-scope review found a provider-test automation gap: JSON previously required a manual environment toggle. Commit2c6017f8 adds separate ordinary text/JSON integration binaries with shared cases, recovery-kind synchronization, JSON parsing and positive cleanup-event evidence. Default signup does not send confirmation here; no prior signup/recovery race was reproduced. Nine targeted Rust tests and two retained Chromium characterization cases passed; fmt, server/tests Clippy-Dwarnings and boundaries passed. UI build reproduced embedded assets exactly. Test-only changes do not invalidate frozen production ELFs; campaigns were not rerun or relabeled.

Reports now include per-scenario median p50/p99 values as well as p95. Login p99 also worsened in G10 and remains unapproved with the existing disk gates; no causal or performance approval was invented. No new production defect confirmed in changed code. Original artifacts/archive preserved; reviewed handoff has fresh source bundles/reports/test logs. Shared test PG removed; no live fixtures or public/production action.

## Merge review: new artifact and predeclared validation

The clean public CI found embedded-asset drift that the earlier shared-node_modules builds did not detect. Rebuilding after an isolated npm ci produces the clean artifact; the earlier local no-drift claim is limited to that shared dependency setup and is not clean-CI validation. The generated assets are replaced in a separate build commit. ctutils is updated to0.4.4 for public RUSTSEC-2026-0385, with no policy waiver. Earlier frozen ELF/campaign results stay historical and are not relabeled.

Before new traffic, declare exactly one A/B/A whole-profile sequence against these patched artifacts: unchanged existing disk profile, read/rls/panel/storage/login/refresh/mixed, three60s steady samples each at10iterations/s, same resource/dataset/recovery gates and safety stops. Compare candidate with both controls and report the control/control diagnostic. Candidate must satisfy all original comparator gates against both; any correctness/resource failure stops traffic. No new harness feature, retry-until-green or threshold change. CI must also be green on the up-to-date public head before merge; performance results will be appended whether they pass or fail.
