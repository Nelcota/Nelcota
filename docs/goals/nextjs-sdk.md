# G11: Complete Next.js SDK and security verification

Status: complete for the supported App Router matrix; hosted verification and
the published 0.1.0 package are tracked in [the completion record](sdk-release-completion.md).
Execution evidence belongs in
[nextjs-sdk-execution.md](nextjs-sdk-execution.md). Planning baseline:
`84a55c3bb8c7698a0f8d0f6dd1a01153b748b925`.

## Outcome

Deliver an independently packaged `@nelcota/nextjs` integration for the App
Router. Reuse the TypeScript SDK for HTTP, REST/RPC, storage, auth validation,
timeouts and errors. Keep the Nelcota backend a single Rust binary. Server and
browser capabilities have separate entry points; a browser import must never
include operator/service credentials, cookie keys or server session state.

"Complete" means the matrix below passes on the final source and packaged
consumer, including a real Next production server and disposable Nelcota fixture.
An untested adapter or mocked framework is not completion. Release/publication,
production deployment and edits to the maintainer's VPS are outside this goal.

## 1. Prerequisites and compatibility

- Finish issues #132 and #133 with regressions that fail on the baseline.
  External caller identity must agree across user reads/writes, REST and storage;
  a null caller token must never silently select another stored identity.
- Preserve existing SDK package paths, APIs, documented HTTP
  contracts and released migrations except the explicit #133 error correction.
- Record supported Next/React/Node versions from tested releases. Start with
  Next 16.4.3 and Node 24; add the current supported previous Next major and
  Node 22 only after running the matrix. Do not claim Pages Router, Edge or
  untested versions from permissive peer dependency ranges.
- Record the explicit +100 B gzip feature allowance for root/auth in the #132
  prerequisite. REST/storage budgets and all test/security thresholds stay
  unchanged; this is not an allowance for unrelated refactoring.
- Establish public typed examples and an external packed-package consumer.
  Keep generated database typing intact for tables, relations, RPC and storage.

## 2. Architecture and capabilities

- Separate server read-only contexts (Server Components), writable contexts
  (Route Handlers/Server Actions), request/proxy integration and browser helpers.
- Construct identity and clients per request. No module-global user/client,
  no cookie-dependent global cache, and no service-role fallback.
- Server Components validate the access token against the auth service and do
  not rotate or write cookies. Auth mutations require a writable context.
- Define session ownership before implementing refresh. Browser cookies must
  be HttpOnly, Secure in production, host-only and SameSite by default.
  Bound names/values, expiry and total cookie/header size. Do not place tokens
  in localStorage, URLs, serialized React props, logs or client bundles.
- Resolve refresh coordination across simultaneous requests, tabs, processes
  and multiple Next instances. A process-local lock alone cannot certify this.
  An opaque cookie with an authoritative shared session store is the preferred
  production design; a typed, atomic store adapter may be supplied by the app.
  An in-memory store is explicitly development-only and never the implicit
  production fallback. Persist accepted rotations before responding and fence
  stale writers. Define shutdown/cancellation ownership and cookie-write errors.
- Persist PKCE verifier/redeem state with one-use, expiry and binding to the
  browser/session. Support code exchange without accepting an arbitrary return
  URL or reflecting credentials in redirects. Reuse SDK PKCE where appropriate.
- Offer verified-user helpers, login/logout, refresh, recovery, email links,
  OAuth callbacks, protected-page/route examples, REST/RPC and storage through
  composition. Avoid copying the base client's HTTP or model implementations.

## 3. Security review and negative matrix

- CSRF: validate unsafe methods against an explicit trusted app origin;
  reject missing/foreign origins by default for browser auth mutations.
  Do not derive trust from attacker-controlled Host/forwarded headers.
- Prevent open redirects, protocol-relative/backslash/control-character return
  paths, credential-bearing URLs, header/cookie injection and service-role use
  in browsers. Validate proxy matcher exclusions and loops.
- Verify forged/tampered/expired/revoked sessions, missing/empty tokens,
  invalid_grant vs transient network/429/5xx, and request/body deadlines.
- Ensure authenticated responses and token-dependent fetches are not cached
  publicly; test cache headers and explicit Next caching behavior.
- Exercise concurrency, lost replies, duplicate refresh, callback replay,
  session replacement, logout races and cookie persistence failure. Never call
  an in-memory-only result multi-instance proof.
- Verify RLS with two users and an anonymous client against seeded fixtures.
  Never use production data or publish sensitive diagnostics.
- Run dependency audits, export/server-only boundary tests, package-content
  checks and secret canaries. Record findings and reproduce each confirmed bug.

## 4. Reliability, usability and documentation

- Provide English and Portuguese setup, environment variables, key/storage
  configuration, App Router examples, error handling and upgrade instructions.
- Include a minimal runnable Next example with login, protected server page,
  writable auth route/action, logout, callback and owned data under RLS.
- Demonstrate safe redirect-after-login, independent request identities and
  unsupported-context errors. Do not silently ignore failed cookie writes.
- Record bounded request latency, refresh overhead, cookie/header size and
  repeated-request resource cleanup; preserve failed/skipped results.
- Keep one logical owner per module; no speculative abstractions or broad
  refactoring. Rebuild embedded guides only when their source changes.

## Completion gates

| Cell | Required evidence |
|---|---|
| Base prerequisites | #132/#133 before/after regressions, auth tests, recorded feature budgets and package consumer |
| Next read-only | Actual Server Component validates user; no token rotation/cookie mutation |
| Next writable | Actual Route Handler and Server Action commit cookies/session atomically; errors visible |
| Browser boundary | Production client bundle contains no server modules/secrets or credentials in props |
| Concurrency | Same/cross-session, tabs, processes and shared-store instances; stale responses cannot roll back identity |
| Auth flows | Password, sign-up, verified user, logout, refresh, recovery/email links and PKCE callback |
| Adversarial | CSRF, redirect, malformed cookies/tokens, replay, timeouts and persistence failure |
| Backend/RLS | Real disposable Nelcota/Postgres, two users and anonymous canaries |
| Packaging | Packed install, exports/types, production Next build/start and compatibility matrix |
| Operations | Audits, bounded resource checks, EN/PT docs and final finding ledger |

Each cell gets passed/failed/blocked (environment)/not run, with artifact
identity and commands. A failed or missing gate keeps the package unreleased.
Run Rust, Vitest and audit checks sequentially with four Cargo jobs and two
Rust/Vitest test workers. Use disposable bounded fixtures, stop automatically
on critical disk/resource limits, and preserve other worktrees and evidence.
Never merge, tag, publish packages, create a release or deploy as a side effect
of this goal. Prepare reviewable changes and a Portuguese technical handoff.
