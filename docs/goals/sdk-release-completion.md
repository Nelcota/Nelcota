# SDK release completion — 2026-10-24

Baseline: `4a4956f0922c43fb95544fd1e0fa2f1782f3e170` on `main`.
Implementation branch: `codex/sdk-release-completion`.
This record covers the existing TypeScript, Rust and Next.js deliveries; it
does not start a new language SDK or certify all future deployments.

## TypeScript 0.2.2

The package was already published before this pass. Registry lookup returned
0.2.2 and integrity
`sha512-X8H9cd8g4FWoDJCMVVmFWI17BUBtBN9T3bixLt0N2dF1XxUNtyO5ddI0RVFNDfZ0zUFuzVC1ra8LT+ls6BwoTQ==`.
The successful [release workflow](https://github.com/Nelcota/Nelcota/actions/runs/40127675952)
ran on `44116fb7dad17fff818f74ed510f2d39389122c5`.
An external packed Next consumer installed the actual registry base package,
loaded all five Next exports and checked strict TypeScript declarations.

Fresh checks on the current source: 372 unit tests, 20 type tests, type checking,
unchanged bundle budgets and zero npm advisories. The contract runner gains an
opt-in `--nextjs` consumer using its existing disposable backend/STARTTLS email
fixtures. Runner exceptions now set a failing exit status even after successful
Vitest execution. No new TypeScript runtime release is needed for this tooling.

## Rust 0.1.5

The source version, lockfile, changelog, current install guides and upgrade notes
now include the previously unreleased logout, reserved-filter, file-save
cancellation, query-timeout and MIME corrections. Existing public imports and
Rust 1.88/native Tokio requirements are preserved. The release workflow uses
the sequential shared-PostgreSQL test wrapper for its integration gates.

Fresh local evidence:

| Check | Result |
| --- | --- |
| Rust 1.99 SDK | 50 executable tests and 10 doctests passed |
| Rust 1.88 SDK | 50 executable tests and 10 doctests passed |
| Server `sdk_rust` | 8 real HTTP/PostgreSQL contracts passed |
| Rust generator | 3 focused generator cases passed |
| Server OAuth | 18 passed; the separate Next case is explicitly selected below |
| Formatting, SDK Clippy, SDK rustdoc | Passed, warnings denied where applicable |
| SDK dependency graph | cargo-deny advisories/bans/licenses/sources passed |
| Publish dry run | Passed; no upload performed |
| Packaged external consumer and archive-selection regression | Passed |

The workspace's accepted backend advisory D104 is not in the SDK dependency
graph. This pass neither adds an advisory ignore nor claims to remove D104.
The initial registry lookup still returned 0.1.4; actual 0.1.5 availability must
be established by the tagged release and a fresh registry consumer.

## Next.js 0.1.0

The package is prepared for public distribution, with a changelog, public npm
metadata, prepack build, explicit supported Node ranges and a dedicated gated
release workflow. Its minimum base peer is the published `@nelcota/client`
0.2.2. `.github/workflows/sdk-nextjs-check.yml` is shared by ordinary PR CI and
tagged releases. Removing `private: true` does not itself publish a package.

The example adds a validated auth-operation POST handler and an optional shared
PostgreSQL store. The real framework smoke now starts two Next production
processes, not just two adapters in one process. It covers all public auth
operations, browser-bound OAuth callbacks and replay failures, reversed/natural/
lost login replies, the documented cookie-less residual and 100 repeated reads
with no retained session advisory locks. The session cookie measured 68 bytes.
One final Chromium run completed the 100 reads in 401 ms; this is bounded local
fixture evidence, not a production latency guarantee or long-duration soak.

| Runtime / browser | Local result |
| --- | --- |
| Node 22.23.4 / Chromium 156.0.8078.4 | Passed |
| Node 24.22.1 / Chromium 156.0.8078.4 | Passed |
| Node 26.12.1 / Chromium 156.0.8078.4 | Passed |
| Node 24.22.1 / Firefox 157.0 | Passed |
| Node 24.22.1 / WebKit 27.2 | Passed in the official Playwright Linux container |
| Unit/real PostgreSQL on Node 22/24/26 | 117 passed on each runtime, zero skipped |
| Packed consumers, local and registry base SDK | Passed |
| Valid production build and forbidden Client Component import | Passed |
| Real backend/RLS | Passed; two users, anonymous and cross-user predicates |
| Real auth/STARTTLS email | 12 base auth contracts and the Next consumer passed |
| Real Next SDK/backend OAuth | Explicitly selected `nextjs_sdk_finishes_a_real_pkce_flow -- --ignored` passed |
| Real S3-compatible storage | RustFS 1.0.1 upload, redirect allowlist, stripped credentials and 206 range reads passed |
| npm audit, type check and package build | Passed |

The real auth consumer verifies recovery/magic-link delivery and one-use tokens,
password replacement, metadata, logout and eight concurrent refresh contexts
using independent PostgreSQL adapters. The OAuth integration runs the Next SDK
through real Nelcota authorization/callback/PKCE routes with local GitHub token
and profile endpoints. Production Next request/cookie integration is separately
covered by the framework/browser matrix.

The first WebKit run failed because its provisional intercepted headers omitted
Cookie: the replay accidentally created two unrelated cookie-less sessions.
The corrected harness takes the browser cookie jar for the exact request URL,
asserts the bootstrap cookie is present, and preserves all stale-identity
assertions. This is a harness correction, not a claimed product vulnerability.
WebKit's host launch also failed for missing system libraries; the official
`mcr.microsoft.com/playwright:v1.64.0-noble` container supplied those dependencies.

## Publication and remaining boundaries

Local evidence is complete for the selected App Router matrix. Hosted PR/release
CI must pass on the final commit before release. The machine has GitHub access
but `npm whoami` reports `ENEEDAUTH`; the first Next package publication requires
maintainer npm authentication and package-specific trusted-publisher setup.
That account requirement must not be described as completed publication.

Live Google/GitHub accounts, previous Next majors, Pages Router, Edge, arbitrary
AWS S3/R2/HTTPS provider configurations, historical-server compatibility and a
long-duration resource soak are not covered by this release matrix. Existing
cookie-less/lost-response limits and direct/session-pooling requirements remain
explicit in the package docs. G12's broader security review retains its own scope
and is not closed by this release-verification pass.

Local logs are under `/tmp/nelcota-*`; fixtures own random databases/buckets and
remove them after each test. No production data or deployment was used.

## Publication checkpoint — 2026-10-24

This checkpoint supersedes the initial publication/authentication states above.
[PR #162](https://github.com/Nelcota/Nelcota/pull/162) passed all 29 checks and
merged as `e7b5b352b55fd2d8151aa847a079e2ba92356a24`. Both SDK release tags point
to that exact commit. The final rebuilt backend used by the local RLS/S3 smokes
had SHA-256 `992e013d3122dcdcf6ca169223035d4c76dbf170501ee87055e2f36b50a9619a`.

- **TypeScript 0.2.2:** publication remains confirmed; it was also installed as
  the actual dependency of a clean registry Next consumer.
- **Rust 0.1.5:** the [tagged release workflow](https://github.com/Nelcota/Nelcota/actions/runs/40133251850)
  passed, including all three OS checks, MSRV, real contracts and trusted
  publication. The registry reports 0.1.5, not yanked, with crate checksum
  `d204cfc6b6e6aa45e2286dd10e5dd60358c39499618f9c561dc780779faf9d77`.
  A fresh external consumer installed exactly 0.1.5 from crates.io and compiled
  and ran its query-construction smoke without a local path override.
- **Next.js 0.1.0:** the authenticated initial npm publication completed after
  npm's account verification and processing. The registry reports `latest`
  0.1.0, `gitHead` matching the merge above and tarball SHA-1
  `6f6058da9181b87d2ee16e03f655eb679f4a0471`. A fresh external consumer installed
  exactly `@nelcota/nextjs@0.1.0` with `@nelcota/client@0.2.2`, loaded all five
  exports, created isolated configurations and passed strict TypeScript checks.
  The initial bootstrap used maintainer authentication; it was not an OIDC
  publication. npm now lists the package's GitHub trusted publisher for
  `Nelcota/Nelcota`, `sdk-nextjs-release.yml`, environment `npm`.

The first attempt to configure npm trust before creating the package returned
404; configuring it after the initial publication succeeded. No credentials
were stored in the repository. The [Next tagged workflow](https://github.com/Nelcota/Nelcota/actions/runs/40133586762)
repeats verification and deliberately skips an already published version.
