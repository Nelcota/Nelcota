# GitHub Actions audit

Inventory of the working tree on 2026-11-11, including the SDK removal already
in progress. Jobs start independently unless a dependency is listed.

| Workflow | Trigger | Jobs and dependencies |
| --- | --- | --- |
| `ci.yml` | Main push and pull request | `lint` checks workflows, formatting, architecture, doc versions and Clippy. `test` runs three nextest partitions and one doctest pass. `integration` exercises cancellation, migrations, backups, Notes, auth archives and S3. `host-lifecycle` exercises provisioning and restore. `native-lint` checks review presets. `supply-chain` audits Rust. `javascript-supply-chain` calls the JS audit with patch checks enabled. `upgrade` exercises checkout and published targets. `admin-ui` validates, tests and rebuilds the panel. `sdk` calls SDK verification. `check` aggregates verification results. |
| `sdk-check.yml` | Reusable by CI and SDK release | `sdk` tests the SDK on Node 24, Bun, Deno and three browser engines, and runs live server, panel and Notes contracts. `sdk-node` tests Node 22 and 26. `code-quality` needs `sdk` for the CLI-generated schema artifact. |
| `javascript-supply-chain.yml` | Reusable by CI and SDK release | `audit` checks root, panel and SDK lockfiles. Only CI sets `check-patches`, enabling the installed panel patch tests. |
| `release.yml` | Push to `v*` or manual dispatch on an existing stable tag ref | `validate` checks the tag, workspace version and exact-source main CI. `binaries` needs `validate` and builds, attests and uploads musl x86-64 and ARM64 assets. `image` needs `binaries`, packages those binaries in GHCR by version and attests the digest. `ready` needs both to publish the signed update receipt. `promote` needs `image` and `ready` and assigns GHCR `latest` to that digest only for the newest stable tag. |
| `sdk-release.yml` | Push to `sdk-v*` | `audit` and `verify` call reusable workflows in parallel. `publish` needs both, validates the tag and version and uses npm trusted publishing. |
| `stress.yml` | Manual dispatch | `stress` builds the release binary and runs the Docker campaign on a fresh GitHub-hosted Ubuntu 24.04 runner. |

## Consumers and data flow

- Checkout uses the shallow default and drops persisted credentials. Rust jobs
  use rust-toolchain, rust-cache and install-action. JS jobs use setup-node,
  setup-bun and setup-deno. The local browser installer uses the SDK lockfile,
  the runner image and architecture for its browser/APT cache. Artifact actions
  move the SDK schema, release binaries and attestations, and retain diagnostics.
  Server release also uses actions-rust-cross, attest-build-provenance,
  action-gh-release and Docker's setup-buildx, login and build-push actions.
- The event ref selects the server release tag. `validate` passes main CI
  evidence to `ready` as an artifact. The image digest passes to `ready` and
  `promote`, and `promote` also receives the image name. The version and
  provenance outputs feed packaging.
  `published.skip` gates SDK publication steps and `sdk_contract.conclusion`
  gates diagnostic annotations. `needs` feeds the required CI check.
  Releases use the built-in token for GHCR and CI evidence, plus OIDC for
  attestations or npm. No repository secret or `vars.*` references were found.
  S3 credentials are literals for a local test fixture.
- The browser installer is internal to SDK verification. The `migrate`
  composite action is an external interface documented in
  [Remote migrations](../remote-migrations.md). Its URL, token, path and dry-run
  inputs all feed the CLI.
- CI calls `scripts/check-boundaries.py`, `check-doc-versions.py`,
  `install-oxlint.py`, `run-preset.py` and `review_tests`. Integration, lifecycle
  and upgrade call `test-migration-backup.py`, `test-dev.py`,
  `test-onboarding.py`, `test-auth-package.py`, `test-host-management.py` and
  `test-upgrade.py`, which provision disposable services and use the CLI,
  Cargo, Docker and OpenSSL. The live browser entry points are the panel's
  `scripts/dev-panel.ts` and SDK's `test/browser/notes.mjs`. The SDK's
  `scripts/contract.ts` builds the SMTP test server, generates types, runs
  Vitest and Playwright and tears down fixtures. The three `package.json` files
  wire lint, type, test, build and packaging commands. Release uses
  `assert-update-ci.py`, `build-update-manifest.py` and
  `deploy/release.Dockerfile`. Stress uses `bench/campaign.py`.
- Dependabot groups Cargo, Bun (root, panel and SDK) and GitHub Actions updates.
  GitHub consumes the three issue forms, contact links and PR template.
  CODEOWNERS routes CI and release tooling reviews to the repository
  administrators. CodeQL and Dependabot also run from GitHub settings.

The starting worktree already omitted these files. The audit commits now
include the standalone preset deletion, the retired SDK workflows, their CI
callers and their Dependabot directories. The separate SDK removal in the
working tree also consolidates the JavaScript audit. The audit branch keeps
auditing the legacy JavaScript lockfiles while they are still checked in.

| Retired file | Previous trigger and jobs |
| --- | --- |
| `review-presets.yml` | Main push and PR with path filters; `native-presets` duplicated `ci.native-lint`. |
| `sdk-rust-check.yml` | Main push, PR and reusable call; `sdk-rust` on Linux, Windows and macOS and a separate `msrv` job. |
| `sdk-rust-release.yml` | `rust-sdk-v*`; reusable `checks` and server `contract` gate crates.io `publish`. |
| `sdk-nextjs-check.yml` | Reusable call; independent `framework`, `backend` and `sveltekit` verification. |
| `sdk-nextjs-release.yml` | `nextjs-sdk-v*`; `publish` needs reusable `verify`. |
| `sdk-ssr-check.yml` | Main push and PR with path filters, and reusable call; `test` checks runtimes and PostgreSQL; `backend` checks the real server. |
| `sdk-ssr-release.yml` | `ssr-sdk-v*`; reusable Next.js `verify` and SSR `verify-core` gate npm `publish`. |
| `tmp-panel-dist.yml` | Historical pull requests on test branches. The file was already absent from `main` and the remaining workflow record is disabled. |

## Findings and changes

| Area | Severity | Finding and disposition |
| --- | --- | --- |
| Cleanup | Low | Removed the standalone review-presets workflow because `native-lint` runs the same checks. The SDK Node matrix now runs runtime-specific checks; the Bun type suite runs once. Removed the unused browser selector from the internal action and reused the existing server binary for the panel smoke. |
| Logic | High | The required `check` aggregate omitted native lint, upgrades and SDK code quality. It now covers every active verification job and fails on skipped or failed dependencies. Main branch protection now requires the six active checks and keeps strict mode enabled. |
| Logic | Medium | The S3 retry loop could fall through when startup failed. The step now requires a ready bucket, bounds requests and fails with the container log. |
| Release | High | Parallel releases could write the same GHCR or npm `latest` destination. Server and SDK release workflows now have separate queues that preserve pending runs. The server checks the actual tag and main CI before publishing assets, and the newest stable tag can promote only the digest with a signed update receipt. npm publication stops when the registry lookup fails for reasons other than a missing version. |
| Security | Medium | The Rust audit wrapper attempted to create a Checks API report with a read-only token. A pinned `cargo-audit` now checks the same lockfile and reports via its exit status. `cargo-deny` still checks graph advisories, licenses and sources. The aggregate check needs zero token permissions. |
| Security | Medium | A manual stress run executed the selected ref on a persistent self-hosted runner. The job now uses a fresh hosted VM and retains read-only repository access. |
| Security | Medium | The retired SDK publication paths were still enabled. GitHub Actions now disables all three retired SDK publishers, the standalone Rust SDK and preset checks, and the temporary panel build. The `npm` environment allows only `sdk-v*`. The obsolete `rust-sdk-v*` policy was removed from `crates-io`. |
| Performance | Medium | SDK server verification and upgrade now restore the nextest Rust cache with matching build settings. Cache writing stays with the main test partition. PR concurrency cancels superseded runs, and main runs use their own run IDs. |

The current third-party action references use full commit SHAs. The active
workflows have timeouts on runnable jobs, read-only defaults, no
`pull_request_target`, and no direct event payload interpolations into shell
commands. Release tag inputs reach shell commands through environment variables.

## Time estimate and follow-ups

In [the sampled main run](https://github.com/Nelcota/Nelcota/actions/runs/43101359824),
the SDK and upgrade server builds took 3:46 and 3:37. Comparable jobs restoring
the shared cache took about 50 seconds for their server/test build steps.
If the two changed jobs get comparable hits, the order of magnitude is
four to six runner minutes saved per run. This is an estimate, not an observed
speedup. Wall time depends on queueing and the longest job. The 15 removed
Next.js/SSR jobs accounted for about 21 runner minutes in that sample.

- Revoke the retired trusted publishers for `@nelcota/nextjs` and
  `@nelcota/ssr` on npm and `nelcota-client` on crates.io using registry
  maintainer access. GitHub workflow and environment settings are already
  updated. The reusable Next.js and SSR checks remain enabled on GitHub until
  their callers are removed from `main`.
- Apply the release policy through the workflow on new tags. GitHub loads the
  workflow at the selected ref when dispatching a manual run. Historical tags
  that predate the policy still contain their original workflow.
- Keep the top-level CI triggers while required checks depend on them and
  release readiness demands exact-source main CI. GitHub leaves required
  checks pending when their workflows are filtered out. Keep the required
  Node matrix and the three supported browser engines.
  [GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

## Validation

Run `actionlint` with ShellCheck from the repository root. The pinned actionlint
1.7.12 has a path-specific exception for its single unsupported `queue` key
diagnostic in the two release files. Both use GitHub's documented
`queue: max` and `cancel-in-progress: false`.
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
· [actionlint issue](https://github.com/rhysd/actionlint/issues/657)

Run `cargo audit --file Cargo.lock`, `python3 scripts/check-boundaries.py`,
`python3 scripts/check-doc-versions.py` and `bun run test:dependencies` for
the corresponding local checks. The audit passed these checks, actionlint
with ShellCheck, and all 119 review-script tests in Linux. The S3 readiness
script, aggregate and release guards were exercised with local command
fixtures for success and failure. Follow-up validation covered exact tag refs,
older stable tags, release candidate tags, failed tag lookups and the release
evidence tests. A normal PR run verifies the CI graph after these commits
land. A manual stress run and the next planned release verify the hosted
runner and publication behavior respectively.
