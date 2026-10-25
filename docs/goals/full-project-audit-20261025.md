# Full-project audit — 25 October 2026

Status: in progress. This record distinguishes executed evidence from planned
coverage. It is not a production certification or a claim of exhaustive testing.

## Scope and operating limits

- Baseline: `bb63800727eec2c577c32118566619481e9f88d9` (current public main at start).
- Branch: `audit/full-project-20261025`.
- Started: 24 October 2026, 22:43 America/Sao_Paulo (25 October 01:43 UTC).
- Deadline: 25 October 2026, 07:10 America/Sao_Paulo (10:10 UTC).
- Stop new long tests at 09:55 UTC, retaining time for evidence and reporting.
- Disposable local databases, files, containers and providers only. No production
  access, deployment, merges, releases, package publication or credential changes.
- Four Cargo jobs, two Rust test threads; Rust, Vitest and audits run sequentially.
- Automatic runner stops at less than 1 GiB free workspace disk, less than
  512 MiB available host RAM, command timeout or the final validation cutoff.
- Preserve released migrations, documented contracts, security checks and budgets.
- Review the current main, not abandoned/unmerged local worktrees. PR #170 remains
  a separate dependency candidate; its changes are not silently included.

## Inventory

The modular monolith contains nine Rust workspace members (core, auth, API,
storage, webhooks, admin, deployment, CLI, server), TypeScript and Rust clients,
the Next.js integration and the embedded Svelte panel. The separately fetched
NelcotaWebsite is an additional documentation/landing application.

Runtime: PostgreSQL 17, grants and RLS, Axum/Tokio, rotating refresh tokens,
EdDSA/HS256 JWTs, Argon2id, disk/object-store storage, SMTP, OAuth/OIDC, webhooks,
Caddy, Docker or native systemd and an isolated host update controller/worker.
Frontend: Svelte, Vite, Tailwind, generated Rust wire contracts and JSON Schema
validators. SDK tooling uses Node/TypeScript/Vitest and Next/React; backend
production does not require Node. Migrations V1–V16 exist in both internal trees.

Machine-generated source hashes, route declarations, migration paths, test files
and TODO/FIXME inventory are saved privately in
`/workspace/artifacts/full-audit-20261025/inventory.json`. A route declaration is
an inventory entry, not proof that its authorization or behavior was tested.

## Initial coverage matrix

All results below start as **not run**. Execution results and concrete findings
will be appended with the command, artifact and source identity.

| Capability | Required scenarios | Evidence planned | Initial status |
| --- | --- | --- | --- |
| Core/config/bootstrap | Invalid configuration, migration parity, grants, RLS, pool cleanup | Rust unit/integration, migration hashes | Not run |
| Authentication | Signup, password, email, renewal, revocation, malformed/expired credentials | Auth/server suites, real SMTP contracts | Not run |
| Admin/session/SSO | CSRF/origin, roles, persistence, single-use handoff, isolation | Admin/server/browser tests | Not run |
| REST/query/RPC | CRUD, filters, ranges, embeds, reserved fields, constraints, SQL injection | Server suites and real SDK contracts | Not run |
| Storage/disk | RLS, traversal, limits, interrupted writes, listing, ranges, integrity | Server suites, API journeys | Not run |
| Storage/S3 | Redirect/range/credentials, multipart failure | Disposable S3-compatible provider | Not run |
| Webhooks | Destination policy, signing, leases, retries, queue cleanup | Rust real-service suites | Not run |
| SQL/export | Connection ownership, cancellation, timeouts, partial results | Dedicated cancellation suite | Not run |
| CLI/native/host | Preflight, fencing, update recovery, backups, restore, management | Unit tests, owned Docker acceptance | Not run |
| Panel pages/forms | Load/error/empty, navigation, mutations, races, accessibility, viewports | Vitest, browser tests, real backend probe | Not run |
| TypeScript SDK | Values/types, lifecycle, cancellation, streams, package exports, bundle size | Unit/type/runtime/memory/contract checks | Not run |
| Rust SDK | Transport, authentication, package/API contracts | Cargo tests, doctests, backend contracts | Not run |
| Next.js SDK | Request isolation, cookie ownership, CSRF, session contention, redirect boundaries | Unit/PG/production framework/backend probes | Not run |
| Dependencies/build | Lockfile installs, audits, fmt/clippy/lints, assets/contracts drift | Native and npm checks, production builds | Not run |
| Capacity/recovery | Measurable baseline, bounded concurrency, faults, resource retention | Isolated benchmark and regressions | Not run |
| Website/docs | Build, links, versions, examples | Website checks and doc validators | Not run |
| Production-only gates | Public DNS/ACME, VPS firewall/boot, off-host restore, power loss, ARM64 | Dedicated external staging required | Blocked (environment) |

## Decisions

1. Use one clean branch with a serial evidence runner: prevents mixing old local
   work or overlapping high-resource test families.
2. Start with the complete requested Rust baseline while installing JavaScript
   tooling; installation is not a concurrent Vitest or audit run.
3. Treat a local S3-compatible service as provider evidence only, not validation
   of a real remote cloud account or off-host disaster recovery.
4. Keep detailed diagnostics private until reviewed for credentials or sensitive
   findings; committed records contain only sanitized summaries.
