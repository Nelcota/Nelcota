# Contributing

Nelcota uses PostgreSQL grants/RLS for authorization and ships its backend as
one Rust binary. Read [architecture](docs/architecture.md) and
[decisions](docs/decisions.md) before proposing changes to those boundaries.
Follow [the Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Use Rust **1.99.0** from `rust-toolchain.toml`, Docker and Git. Python 3.11+
is needed for native review/acceptance scripts (3.11.8+ for auth packaging).
Node **24** and npm are used for repository UI/TypeScript tooling; SDK consumers
support Node 22+, and the Rust SDK alone supports Rust 1.88. Neither Node nor
Python is a production backend runtime dependency.

From the repository root:

```sh
cargo build --locked -p nelcota-server
scripts/test.sh db
```

Start development from a separate application directory using the absolute
built binary path. The repository's root migrations are internal SQL: do not
apply them as application migrations. Follow [quickstart](docs/quickstart.md)
or [Notes staging](docs/onboarding/notes.md). Native Oxlint uses Python:

```sh
python3 scripts/install-oxlint.py
python3 scripts/run-preset.py base
python3 scripts/run-preset.py performance/imports
```

## Testing

Run suites related to the change. Keep Rust tests, Vitest and cargo deny/audit
sequential; use the resource limits in [AGENTS.md](AGENTS.md). From the root:

```sh
scripts/test.sh rust --locked -p nelcota-server --test rls
scripts/test.sh rust --locked -p nelcota-client --test transport
scripts/test.sh ui src/lib/features/guides/content.test.ts
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo deny check
cargo audit
```

Choose the appropriate server suite (`auth`, `oauth`, `storage`, `webhooks`,
`sdk_rust`, `memory`, or feature modules under `tests/admin`). S3 tests are
ignored without their disposable provider settings; CI provisions the provider
and runs them explicitly. Check `.github/workflows/ci.yml` for the exact commands.
Do not report ignored/unrun checks as passed.

For a full requested validation, `scripts/test.sh all` runs Rust then panel
Vitest; it does not replace SDK/browser/provider or supply-chain checks. The
shared test container uses port 55432 by default and tmpfs. The script creates
isolated databases and cleans them after each Rust suite. Never run simultaneous
Rust suites against it. Never use development/production data as a test fixture.
An existing disposable PostgreSQL 17 cluster needs `pg_stat_statements` preloaded
and permission to create databases/cluster roles. Docker-specific tests still
require Docker; agent execution follows the stricter shared-container rule.

### Panel and contracts

From `crates/admin/ui`:

```sh
npm ci
npm run dev
npm run contracts
npm run check
npx vitest run src/lib/features/guides --maxWorkers=2
npm run test:memory
npx playwright install chromium
npm run test:e2e
npm run build
```

Vite serves `/admin/` on port 5173 and proxies to `http://127.0.0.1:8000` by
default; set `NELCOTA_API_URL` for another backend. Wire contracts come from Rust
DTOs; regenerate TypeScript/schemas/validators, never hand-edit generated files.
Use feature-local state/adapters/components and shared transport/contracts.
Shared modules have explicit owners under `ui/src/lib/`: `transport`, `contracts`,
`resources`, `navigation`, `browser`, `forms` and `formatting`. Keep tests beside
their implementation, keep page dependencies out of these modules, and run
`python3 scripts/check-boundaries.py` after moving sources. See the ownership map
in [architecture](docs/architecture.md#source-organization).

`dist/` is tracked and embedded. Rebuild it after UI or bundled-guide changes,
then rebuild the Rust binary to serve the new assets. Commit generated `dist`
in its own build commit. CI checks it for drift. For targeted UI tests use
`npx vitest run <path>` or `scripts/test.sh ui <path>`; appending a path to
`npm test` still includes the script's full `src` selection.

### SDKs

From `sdk/typescript`, run `npm ci`, `npm run check`, `npm test`,
`npm run test:types`, `npm run build`, `npm run size`, `npm run test:package`,
`npm run test:memory` and `npm run test:runtime` as relevant. The real-server
contract is `npm run test:contract -- --browser` after building the server and
installing Playwright browsers. CI also covers Bun/Deno and all three browser
engines; see [the SDK contract](sdk/typescript/docs/contract.md).

Rust SDK checks include `cargo test --locked -p nelcota-client`, doctests/examples,
server `sdk_rust` contracts and generated-model tests. Package/release procedures
are in [Rust releasing](sdk/rust/docs/releasing.md) and
[TypeScript releasing](sdk/typescript/docs/releasing.md). Do not publish as a side
effect of a documentation or test change.

### Next.js integration

Build the base SDK first with `npm --prefix sdk/typescript ci` and
`npm --prefix sdk/typescript run build`, then run `npm ci` in `sdk/nextjs`.
Use `npm run check`, `npm test`, `npm run build` and
`node scripts/package-smoke.mjs` there for package changes. PostgreSQL cases
need the shared disposable test service and
`NELCOTA_NEXT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`.
Keep these suites sequential with Rust and panel tests.

The authoritative browser/backend commands and environment are in
[the Next.js verification workflow](.github/workflows/sdk-nextjs-check.yml).
It covers Node 22/24/26 with Chromium, Firefox/WebKit on Node 24, two production
Next processes sharing PostgreSQL sessions, server-only import boundaries,
real backend/RLS, email/PKCE and disposable S3. Select the affected gate; do not
run the entire matrix for prose-only edits. The
[release guide](sdk/nextjs/docs/releasing.md) separates verification from npm
publication. Existing results are dated in
[the SDK release record](docs/goals/sdk-release-completion.md).

### Acceptance, upgrades and stress

```sh
python3 scripts/test-onboarding.py --binary target/debug/nelcota
python3 scripts/test-host-management.py --binary target/debug/nelcota
python3 scripts/check-boundaries.py
python3 scripts/test-docker-context.py
python3 scripts/test-auth-package.py --run
nice -n 19 ionice -c3 python3 scripts/test-upgrade.py
```

Host management acceptance uses owned Docker fixtures and verifies isolated
PostgreSQL/files, backup, restore, recovery and removal. DNS/provenance, public
TLS, proxy reload and the unused PITR image extension are explicit doubles;
see [host management](docs/host-management.md) before production enrollment.

The Docker context check builds a synthetic, network-disabled scratch image.
It verifies that required sources/assets remain available while private host
configuration and nested generated dependencies stay outside the context.
It removes only its own labeled image and container; it reads no real secrets.

Auth packaging requires built core/auth archives; follow
[auth integration](docs/auth-integration.md). Upgrade tests require Linux amd64,
Python and Docker; their disposable cluster starts with clean cluster roles.
The default regression checks 0.3.1 → this checkout; `--published-target` checks
0.3.1 → 0.4.0. It verifies existing data/schema/files, auth, rollback, retry and
restore. Diagnostics remain in `target/upgrade-tests/`.

[Bench campaigns](bench/README.md) include resource/load/stress/soak evidence
and need dedicated CPUs/services. Do not run a long campaign alongside ordinary
suites. Production update acceptance, systemd, real power loss and off-host
restore are separate gates; local mocks do not complete them.

## Documentation and translations

English guides are canonical. Existing standalone pt-BR quickstarts and panel
catalogs are maintained alongside them. After changing bundled prose, run
`npm run guides:pending` and `npm run guides:check` from the UI directory;
translate new fragments and remove obsolete ones, preserving inline code, URLs
and source section identifiers. See [translation workflow](docs/i18n/README.md).

Update the relevant reference and Unreleased changelog for behavior changes.
Label historical evidence with its original artifact/date; do not rewrite old
measurements as current validation. Check internal links/anchors, external links,
examples and `git diff --check`. Report inaccessible destinations honestly.

## Code, commits and pull requests

- Use English in source, comments, primary docs, commits and PR descriptions.
- Use guard clauses/early returns; avoid executable `else`, including Rust
  value expressions and `let ... else`. Use `match`/`switch` and mutually exclusive
  Svelte guards. Check nullable input and reject non-finite numbers at boundaries.
- Preserve capability ownership. Keep transaction, cancellation and cleanup
  with the operation; HTTP adapters translate inputs/results.
- Never edit released migration SQL/checksums; add a new migration.
- Security changes need a regression proving the boundary. Use targeted checks
  for documentation and other changes; do not add tests that mirror implementation.
- Make one logical change per commit, with relevant tests in the code commit.
  Use Conventional Commits, an imperative subject and a body explaining why.
- PR descriptions lead with the problem and resulting behavior, then relevant
  verification and real limits. Link issues and identify generated assets.
- CI must pass. Review applicable server/S3, panel, SDK, packaging, audit and
  CodeQL jobs; a single green job is not the complete result.

## Reporting security issues

Report privately through [SECURITY.md](SECURITY.md).
