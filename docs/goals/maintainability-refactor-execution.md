# G07 — Targeted maintainability refactoring: execution record

Status: complete: two independent implementation PRs are ready for review. This document stays in a
draft PR. Each implementation target gets an independent PR for human review;
none may be merged by this run.

## Baseline and boundaries

- Start: 2026-10-19 01:37:29 UTC. Wall-clock deadline: 09:37:29 UTC.
- Baseline: `b18412a65f4accc4d759d7f840e50420d32d7579` on `main`.
- Behavior, generated output, public APIs, HTTP/SDK contracts, migrations,
  configuration, CLI flags/output and dependency versions must remain unchanged.
- Exclusions: all of `crates/auth`, `crates/admin/src/sso.rs`, PITR
  fence/recovery/preflight, and **every file** changed by #91, #93, #97,
  #99–#103 and #105. This is a conservative file-level exclusion, including
  renamed paths, tests, guides, changelog and generated assets.
- The PR file inventories contain 599 distinct current/previous paths. A
  changed-path check against that set is required before each implementation
  commit. Unrelated historical evidence and release work are untouched.
- Rust jobs: four; test threads: two. Rust, Vitest and audit runs are sequential.
  No dependencies, lint configuration, budgets or workflows are changed.

## Phase 1: read-only measurements

The scan covered 725 tracked Rust/TypeScript/Svelte files: 262 Rust and 463
TypeScript/Svelte. Tests/examples, generated files and translation data were
classified separately before ranking production hotspots. Large files do not
automatically imply long production functions.

Reproduction commands (read-only; Rust 1.99.0, Node 24):

```sh
git ls-files '*.rs' '*.ts' '*.tsx' '*.svelte'
git log main --format='COMMIT%x09%H%x09%s' --name-only --no-renames
cargo clippy --locked --workspace --lib --bins --message-format=json -- \
  -W clippy::too_many_lines -W clippy::too_many_arguments \
  -W clippy::cognitive_complexity
gh api --paginate 'repos/Nelcota/Nelcota/pulls/91/files?per_page=100'
# Repeat the PR file inventory for 93, 97, 99, 100, 101, 102, 103, 105.
```

The one-off Clippy report completed with exit 0: 25 `too_many_lines`
diagnostics, one `cognitive_complexity` diagnostic, and **no**
`too_many_arguments` diagnostic at the default threshold of seven parameters.
These are inventory warnings, not an ordinary `-D warnings` validation result.
No threshold was changed. Clippy counts logical function lines, whereas the
file/TypeScript counts below are physical source lines.

TypeScript measurements used the already-installed TypeScript compiler AST:
2,993 function-like nodes including test callbacks were inspected, then tests
were excluded from production rankings. Svelte measurements cover script blocks,
not template size. Control depth counts nested if/loop/switch/conditional/catch
nodes, excluding nested function bodies; it is **not** Clippy cognitive complexity.
Raw local reports are in ignored `target/g07-maintainability/`; the findings
needed for review are recorded here so they do not depend on that directory.

### Largest production-bearing files

| Rust file | Physical lines | Interpretation |
| --- | ---: | --- |
| `crates/cli/src/updates/worker.rs` | 1,031 | 670 lines before inline tests; lifecycle orchestration |
| `crates/api/src/query/mod.rs` | 1,030 | Only 316 before inline tests; size dominated by characterization |
| `crates/cli/src/updates/management.rs` | 915 | 913 before inline tests; orchestration and policy |
| `crates/cli/src/updates/runtime.rs` | 902 | Excluded (#91) |
| `crates/core/src/config.rs` | 896 | Excluded (#91) |
| `crates/admin/src/ddl/table.rs` | 858 | 456 before inline tests; action planning and validation |
| `sdk/rust/src/auth.rs` | 851 | SDK session/network behavior; defer this pass |
| `crates/cli/src/lib.rs` | 756 | Excluded (#91/#93/#97) |
| `sdk/rust/src/rest.rs` | 638 | Public SDK query behavior; defer |
| `crates/api/src/query/parse.rs` | 622 | Grammar/error-order compatibility requires broader fixtures |

The prefix before the first inline `#[cfg(test)]` is a size heuristic, not an
exact count of all executable production code; external test modules are separate.

| TypeScript/Svelte production file | Physical lines |
| --- | ---: |
| `crates/admin/ui/src/lib/features/host/HostConsole.svelte` | 767 |
| `sdk/typescript/src/rest/query.ts` | 478 |
| `crates/admin/ui/src/lib/features/overview/Overview.svelte` | 433 |
| `crates/admin/ui/src/lib/features/sql/SqlEditor.svelte` | 431 |
| `crates/admin/ui/src/lib/features/tables/TableEditor.svelte` | 400 |
| `crates/admin/ui/src/lib/features/storage/StorageBucket.svelte` | 384 |
| `crates/admin/ui/src/lib/features/policies/Policies.svelte` | 358 |
| `crates/admin/ui/src/lib/features/tables/components/DataGrid.svelte` | 355 |
| `crates/admin/ui/src/lib/features/migrations/Migrations.svelte` | 321 |
| `sdk/typescript/src/core/http.ts` | 315 |

Translation tables such as `i18n/messages/tables.ts` (626 lines) were measured
but are data rather than candidates for a behavior refactor.

### Long functions, parameter counts and nesting

Selected longest eligible Rust functions from the complete Clippy report:

| Location at baseline | Function / responsibility | Logical lines |
| --- | --- | ---: |
| `crates/cli/src/updates/worker/host.rs:39` | `dispatch` | 252 |
| `crates/cli/src/updates/enroll.rs:54` | `run` | 250 |
| `crates/server/src/main.rs:28` | `main` | 243 |
| `crates/cli/src/updates/management.rs:583` | `apply_with` | 241 |
| `crates/cli/src/updates/worker.rs:243` | `dispatch` | 227 |
| `crates/api/src/catalog/introspection.rs:12` | `Catalog::load` | 221 |
| `crates/api/src/rust.rs:111` | `generate` | 172 |
| `crates/admin/src/ddl/table.rs:293` | `alter` | 151 |
| `crates/api/src/openapi.rs:82` | `generate` | 147 |
| `crates/api/src/typescript.rs:103` | `generate` | 129 |
| `crates/admin/src/lib.rs:62` | `router` | 119 |
| `crates/api/src/query/sql.rs:325` | `insert` | 116 |
| `crates/storage/src/upload.rs:72` | `write` | 115 |
| `sdk/rust/src/http.rs:127` | `request` | 115 |

`server::main` is the only default cognitive-complexity warning (26/25).
No excessive-parameter warning was found in Rust. This does not mean every
function is simple; the report only measures the named lints and targets.

| TypeScript/Svelte location | Function | Lines | Parameters | Control depth | Decision nodes |
| --- | --- | ---: | ---: | ---: | ---: |
| `sdk/typescript/src/core/http.ts:187` | `#request` | 81 | 2 | 3 | 27 |
| `crates/admin/ui/src/lib/features/host/HostConsole.svelte:236` | `approve` | 78 | 1 | 2 | 12 |
| same file, line 125 | `refresh` | 66 | 0 | 2 | 10 |
| `crates/admin/ui/src/lib/features/api/api-examples.ts:73` | `tableSnippets` | 62 | 3 | 1 | — |
| `crates/admin/ui/src/lib/features/storage/upload.ts:9` | `upload` | 50 | 4 | 1 | — |
| `crates/admin/ui/src/lib/features/guides/markdown.ts:27` | `readMarkdown` | 44 | 3 | 2 | — |
| `sdk/typescript/src/rest/query.ts:290` | `#run` | 41 | 0 | 1 | 9 |
| `crates/admin/ui/src/lib/features/host/controller.ts:133` | `parseStatus` | 39 | 1 | 1 | — |

The maximum production parameter count found was five (`pageInfo`, `nextCell`,
`queryRead`, `replacePolicy`). Maximum control depth was three; HTTP transport,
OpenAPI prose translation and upload queues merit future focused review. Test
`describe` callbacks were not mistaken for long production functions.

### Fix history and duplication

The full, non-shallow main history contains 599 commits. Fix counts use subjects
matching `^fix(?:\([^)]+\))?!?:`, count historical paths without rename following,
and rank only files still tracked at baseline. They are a churn signal, not a
defect count or a reason to modify a stable interface.

| Current path / feature | Fix commits | Decision |
| --- | ---: | --- |
| `crates/cli/src/lib.rs` | 15 | Excluded |
| UI `i18n/messages/tables.ts` | 8 | Translation data |
| SDK `auth/manager.ts` | 7 | Excluded |
| UI `SqlEditor.svelte` | 7 | Defer transport/interaction changes |
| `crates/auth/src/accounts.rs` | 6 | Excluded |
| UI `api.ts`, `TableEditor.svelte` | 6 each | Broad consumers and asset churn |
| CLI `projects.rs`, `init.rs` | 5 each | Excluded |
| UI `Policies.svelte`, `TableToolbar.svelte`, `ApiPage.svelte` | 5 each | Defer |
| SDK `core/http.ts` | 4 | Timeouts/retry/public semantics and bundle risk |
| `crates/api/src/typescript.rs` | 3 | Candidate: RPC signature computation mixed with rendering |
| `crates/api/src/rust.rs` | 2 | Candidate: RPC type mapping mixed with rendering |

An exact normalized-window duplication scan (12 significant lines, minimum 350
characters, production only) found no duplicate blocks. This is not a claim of
absence of semantic duplication. Manual inspection found:

- Rust `generate` computes nullable/omittable field shapes while formatting
  structs, then separately computes RPC arguments and return shapes.
- TypeScript `generate` repeats nullable column rendering for Row/Insert/Update
  and embeds a long RPC signature closure inside document rendering.
- Both language generators traverse the same catalog, but their nullability,
  naming and set-return rules differ. Sharing a cross-language abstraction would
  hide those differences and is not proposed.
- Rust identifier and enum-variant collision loops deliberately use different
  suffixes (`_2` versus `2`); superficial similarity is not safe deduplication.

### Ranked candidates by value/risk

| Rank | Target | Concrete maintenance cost | Proposed bounded change | Risk / disposition |
| --- | --- | --- | --- | --- |
| 1 | TypeScript generator RPC signature | Argument defaults, relation lookup, union grouping and set returns are buried inside a rendering closure | Extract a private signature function; characterize exact output first | Low: deterministic catalog input/output |
| 2 | Rust generator RPC type mapping | Return relation resolution and void/set/scalar wrapping are interleaved with module formatting | Extract a private return-type calculation; characterize return combinations, names and precedence first | Low: preserve formatting, identifiers and public API |
| 3 | Catalog introspection | Four ordered queries, row decoding and privileges share one 221-line operation | Separate query-result mapping after database characterization | Medium/high: privilege metadata and query order; defer |
| 4 | DDL table alteration | Thirteen actions update working schema while validating ordered errors | Separate action planning with SQL/error golden tests | High: transaction/validation ordering; defer |
| 5 | Host/update orchestration | Large dispatch functions mix ownership, durable state and external actions | A separate future lifecycle review | High and adjacent to excluded fixes; defer |
| 6 | SDK HTTP transport | Timeout, retry, headers and response decoding share an 81-line method | Characterize cancellation/retry boundaries before any split | High: public semantics and 4-byte auth budget margin; defer |
| 7 | Panel HostConsole / SQL / tables | Confirmation flows, refresh and UI state share large components | Feature-local controller extraction after interaction characterization | Medium/high: rebuilding assets would touch excluded paths; defer |
| 8 | Server startup | Composition has cognitive complexity 26 and 243 logical lines | Separate startup assembly after lifecycle characterization | High: shutdown/listener ownership; defer |

### Excluded hotspots: future work only

- `crates/cli/src/lib.rs`: 15 fix commits and a 240-line function at line 424.
- `crates/cli/src/updates/runtime.rs`: 902 physical lines; functions of
  155, 117 and 108 logical lines.
- `crates/core/src/config.rs`: 896 physical lines; configuration compatibility.
- `sdk/typescript/src/auth/manager.ts`: 311 physical lines and seven fix commits.
- `crates/auth/src/accounts.rs`: six fix commits. All auth code and admin SSO
  stay outside this pass regardless of size.
- SQL executor/export ownership, CLI lifecycle/native ownership and PITR
  preflight/fence/recovery stay excluded, including their focused regressions.
- Recently rebuilt panel guide assets are excluded even if their source module
  would otherwise be eligible. No recent evidence is invalidated by rebuilding.

## Decisions and next gates

1. Use conservative file exclusions rather than interpreting which individual
   lines were involved in recent fixes: this preserves their evidence.
2. Open the inventory as a draft before touching production code. Select at most
   eight targets; two narrow generator extractions are the current shortlist,
   not a requirement to consume the whole budget.
3. Require byte-for-byte characterization before extraction. Generated types are
   public output even though the implementation helpers are private.
4. Follow CONTRIBUTING's guard-clause/match convention where it is stricter than
   G07's allowance for `else`/`let ... else`. No lint changes are needed.
5. Do not touch SDK runtime or panel code: the auth bundle is 11,246/11,250 gzip
   bytes at baseline and existing generated panel paths are excluded.
6. Do not introduce traits, builders, dependency injection or parameter structs
   without a concrete need. The shortlisted pure helpers need none.

## Phase 2 / 3 execution ledger

### Target selection

Inventory draft: [#106](https://github.com/Nelcota/Nelcota/pull/106), opened
before production edits. Exactly two targets were selected, in ranking order.
The concrete problem/change for each was written in the inventory first. The
remaining six candidates stay deferred for the risks recorded above; eight is
an upper bound rather than a quota.

Both implementation branches start independently at the baseline main SHA,
without depending on the inventory or each other. They affect different files.
No public branch was rebased or force-pushed. Main is unchanged.

### Before/after evidence

| Target | Characterization commit (original implementation) | Before | Refactor head | After | PR |
| --- | --- | --- | --- | --- | --- |
| TS RPC signature | `05a8c99c2f1a573458453b04ddc34e7faf27fcee` | 6 generator tests passed | `f33b33aeeafb3981ef67fa445316178d91d77eb5` | 43 API tests passed, including the same 6 | [#107](https://github.com/Nelcota/Nelcota/pull/107) |
| Rust RPC return | `1df5a92a1821e63c959054b1627a4cae53e0b882` | 3 generator tests passed | `008f93b6345646317fff08e3e12bdf38f111b9e4` | 43 API tests passed, including the same 3 | [#108](https://github.com/Nelcota/Nelcota/pull/108) |

The totals belong to independent branches, each adding one test to baseline's
42 API tests. They are not a claim of a combined-branch test run. No tests were
ignored in these local runs. Characterization was committed separately before
production extraction; its entire test module remained byte-identical afterward:

- TS test-module SHA-256:
  `c11a35dbdfe9c8ded2aa35d8f57198c017198081af4d5b55939993140420bcf2`.
- Rust test-module SHA-256:
  `4e3481b12e6b8112743930c3a6d7a625f1362bbf6c8aa11440df8cd07abd3e1d`.

TS characterization compares the complete Functions section, including escaping,
ordering, required/default arguments, table/view references, scalar sets, arrays
and void. Existing tests also cover precise numbers, relationships and view kinds.
Rust characterization compares the complete RPC section across eight return
combinations, including module collisions, schema qualification and void priority.
Its existing full generated-model fixture remains unchanged.

Additional Rust-head checks:

- Rust SDK generated-model serialization: **1 passed**, omission/null/defaults
  and decimal precision retained.
- Server real-catalog/CLI types contract: **1 passed**, preserving Rust output
  and the default TypeScript language, using disposable shared PostgreSQL 17.
- Both heads: formatting, package all-target Clippy with `-D warnings`, diff
  whitespace and the excluded-path guard passed.
- Final complete diffs: TS **108 insertions / 44 deletions** (152 changed lines,
  including moved implementation); Rust **102 / 18** (120 changed lines). Both
  are below 400 even counting moved code.

Commands, run sequentially with four Cargo jobs/two test threads:

```sh
# On the TS characterization commit, before production changes:
scripts/test.sh rust --locked -p nelcota-api --lib typescript::tests
# On the Rust characterization commit, before production changes:
scripts/test.sh rust --locked -p nelcota-api --lib rust::tests
# On each corresponding refactor head:
scripts/test.sh rust --locked -p nelcota-api --lib
cargo fmt --all --check
cargo clippy --locked -p nelcota-api --all-targets -- -D warnings
# Additional checks on the Rust head:
scripts/test.sh rust --locked -p nelcota-client --test models
scripts/test.sh rust --locked -p nelcota-server --test sdk_rust \
  rust_types_cli_reads_the_real_catalog_and_keeps_the_typescript_default
```

The one-off post-refactor report no longer flags TS `generate` above 100 logical
lines. Rust `generate` falls from **172 to 156**, still above 100. That remaining
warning is reported openly: this pass isolates one concrete responsibility,
rather than chasing a length threshold through a whole-renderer rewrite.

### SDK bundle and scope verification

`npm --prefix sdk/typescript run build` and `npm --prefix sdk/typescript run size`
passed after the Rust checks, with unchanged gzip sizes:

| Entry | Bytes | Budget |
| --- | ---: | ---: |
| `index.js` | 17,064 | 17,100 |
| `rest/index.js` | 9,387 | 9,550 |
| `auth/index.js` | 11,246 | 11,250 |
| `storage/index.js` | 7,267 | 7,400 |

Both PRs have an empty diff under `sdk/`; the four-byte auth headroom is intact.
The changed-path guard confirms each implementation PR touches its one eligible
source file only. No migration, public signature, HTTP/SDK contract, CLI flag,
configuration, workflow, dependency, recent-fix test or panel asset changed.
No bundled-guide rebuild is needed for this unbundled execution document.

### Ordinary CI and final disposition

Both implementation PRs were marked **ready for review** only after fetching
fresh check results and reconfirming the unchanged exact head and main base:

| PR | Exact head | Ordinary checks | Last check completed (UTC) | Disposition |
| --- | --- | --- | --- | --- |
| [#107](https://github.com/Nelcota/Nelcota/pull/107/checks) | `f33b33aeeafb3981ef67fa445316178d91d77eb5` | **17/17 success** | 2026-10-19 02:07:14 | Ready; not merged |
| [#108](https://github.com/Nelcota/Nelcota/pull/108/checks) | `008f93b6345646317fff08e3e12bdf38f111b9e4` | **17/17 success** | 2026-10-19 02:10:40 | Ready; not merged |

The successful set on each head comprises `check`, `native-lint`, `supply-chain`,
`upgrade`, `admin-ui`, `sdk / sdk`, SDK Node 22/26, Rust SDK Ubuntu/macOS/Windows,
`msrv`, CodeQL analyses for actions/Python/JavaScript-TypeScript/Rust and the
CodeQL result check. No neutral, ignored or pending check is counted as passed.
The separately filtered `native-presets` configuration workflow does not apply
because none of its path filters changed. No workflow was dispatched manually.

The draft inventory's initial head `f28ce58415bc19ee8832fd13339a145195a52197`
also passed its 17 checks. Its final documentation-only update starts ordinary
CI again; that draft remains the execution archive rather than an implementation
merge candidate. See its checks for the current documentation-head result.

Main remained `b18412a65f4accc4d759d7f840e50420d32d7579`. No merge, tag,
release, publication, deployment or repository setting change was performed.

### Timing and budget closure

The original eight-hour deadline was 2026-10-19 09:37:29 UTC. Both code heads
finished ordinary CI by 02:10:40, inside that budget. On processing the later
`Continua` message, the environment clock was **10:44:07 UTC**, already beyond
the deadline. Only closure of the existing work was performed at that point:
reconfirming checks/heads, marking the two existing PRs ready, and committing
this execution record. No additional target, refactor, test campaign or rerun
was started. The elapsed interval is not claimed as effective testing time.
The final documentation-only CI is not awaited beyond the expired budget.

### Further decisions and limitations

7. Prefer pure helper extraction over moving formatting and changing error
   conventions. The new helpers return strings and introduce no ignored Results,
   unwraps, traits or dependencies in production code.
8. Preserve existing language-specific relation lookup, nullable set behavior,
   identifier collisions and void precedence even where the two generators use
   different rules. This is not a contract redesign.
9. Keep all runtime SDK/panel refactors deferred. Measuring TypeScript does not
   require changing it, especially with the current bundle and asset exclusions.
10. Do not run stress, reboot, release or deployment campaigns for pure catalog
    code generation. Existing ordinary CI supplies platform/browser/provider,
    packaging and supply-chain coverage without modifying those areas.
11. Initial formatting checks requested normal formatter adjustments while
    preparing the changes; these were applied before final checks. No behavioral
    test failed, no budget/lint was weakened, and no new product defect was
    confirmed during this bounded review.
12. Automatic app attachment calls did not return and were cancelled; PR URLs
    are recorded directly here and in the handoff. GitHub PR creation succeeded.
13. Close the run after publishing the existing evidence, because the original
    wall-clock deadline had passed at resumption. Do not use the continuation
    message as implicit permission to expand the scope or restart the budget.
