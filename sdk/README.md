# Nelcota SDKs

Choose the base client for your application's runtime, or the Next.js adapter
for App Router session handling. Server installation does not install or update
application dependencies.

| Package | Version | Runtime and documentation |
| --- | --- | --- |
| `@nelcota/client` | 0.2.2 | [JavaScript/TypeScript](typescript/README.md); Node 22+, browsers, Bun and Deno |
| `nelcota-client` | 0.1.5 | [Native Rust](rust/README.md); Rust 1.88+, Tokio |
| `@nelcota/nextjs` | 0.1.0 | [Next.js App Router](nextjs/README.md); Next 16.4.3 / React 19.3.1, Node 22/24/26 |

The [publication checkpoint](../docs/goals/sdk-release-completion.md#publication-checkpoint--2026-10-24)
records registry installation of these versions. Read the
[upgrade guide](../docs/releases/README.md) before changing application lockfiles.
Next.js source now targets 0.1.1; the table records the confirmed 0.1.0
publication checkpoint. See [the follow-up evidence](../docs/goals/nextjs-151-validation.md)
for session-concurrency corrections and the additional pinned Next 15 consumer.
All clients retain PostgreSQL grants/RLS as the authorization boundary.

## Source ownership

Packages retain separate public entry points. Internal module organization does
not add a public API, runtime dependency or configuration format.

## TypeScript

| Owner | Responsibility |
| --- | --- |
| `src/index.ts` | Combined client composition and public feature exports |
| `core/` | Shared transport, cancellation, errors, encoding and JSON values |
| `auth/types.ts` | Authentication inputs, events and caller options |
| `auth/client.ts` | Account/link endpoints adapted to session operations |
| `auth/manager.ts` | Session transitions, refresh publication and auth events under one lifecycle lock |
| `auth/store.ts` | Session persistence, browser journal and coordinated refresh reservations |
| `auth/scheduler.ts` | Refresh timers, retries and timer cleanup |
| `auth/browser-state.ts`, `coordination.ts`, `pkce.ts` | Existing browser journal, locks/broadcasts and PKCE primitives |
| `rest/query-types.ts`, `types.ts` | Result/options contracts and generated-schema typing |
| `rest/query.ts`, `conditions.ts` | Immutable query construction/execution and validated filter grammar |
| `storage/index.ts` | Bucket administration, standalone composition and the existing public facade |
| `storage/files.ts` | One bucket's file transfer, streaming and response ownership |
| `storage/types.ts` | Storage wire values and request options |

Use type-only imports for contracts. Shared JSON types belong to `core/`, so
authentication does not depend on the REST feature. Keep runtime feature imports
out of `core/`, and keep REST, auth and storage independently consumable through
their existing package entry points. The combined client exports shared runtime
symbols through those feature facades once, rather than duplicating the exports.

## Rust

| Owner | Responsibility |
| --- | --- |
| `src/lib.rs` | Client composition, scoped client configuration and root value types |
| `http.rs`, `encoding.rs`, `json.rs`, `error.rs` | Shared HTTP lifetime, validated encoding, finite JSON and structured errors |
| `auth.rs`, `rest.rs`, `storage.rs` | Small public facades preserving the existing import paths |
| `auth/models.rs`, `links.rs` | Account/session values, notifications and credential-redacting link models |
| `auth/storage.rs` | The existing session-store interface and file/memory adapters |
| `auth/client.rs` | One lifecycle owner for account operations, accepted publication, refresh and timer cleanup |
| `rest/conditions.rs`, `options.rs`, `query.rs` | Filter grammar, caller options and consuming query construction/execution |
| `storage/models.rs`, `content_type.rs` | Wire models/options and pure MIME inference |
| `storage/client.rs`, `files.rs` | Bucket administration and object transfer respectively |

Child modules stay private. Re-export public types through their original
facade; sibling helpers use `pub(super)` only when necessary. Do not expose
internal state or split lifecycle locks, transactions, cancellation and cleanup
across unrelated owners merely to shorten a file.

Profile requests capture their publication owner before HTTP. Rust uses the
existing lifecycle epoch; TypeScript uses a local publication counter and native
journal revision. A delayed response may update the cache only while that owner
and its observed session still match. Explicit session replacement advances the
local revision even when its values are unchanged. Cancellation withdraws a
queued authentication payload through the shared cancellation owner; once the
task acquires the lifecycle lock, accepted publication retains its own lifetime.
The FIFO control slot can drain later without retaining the cancelled request.

## Next.js

The adapter composes the TypeScript SDK with request-scoped server contexts,
encrypted server-side sessions, PostgreSQL persistence and browser helpers.
Public exports are `/server`, `/postgres`, `/proxy`, `/browser` and `/testing`;
there is no root package import. Server-only exports must stay out of Client
Components. The application owns the PostgreSQL pool and expired-row cleanup.

Use a shared production session store with direct connections or session
pooling; transaction pooling does not support the session advisory locks.
Server Components read only, and same-origin POST Route Handlers or Actions own
refresh and other auth mutations. The proxy assists navigation; data access
still requires the visitor's token. See [configuration and concurrency limits](nextjs/README.md).

For custom SSR integrations with the base SDK, appoint one refresh owner across
requests and workers. A request-local client alone does not coordinate rotating
refresh tokens. See [the SSR example](typescript/examples/server.mjs).

## Applying SOLID

- **SRP:** models, persistence adapters, filter grammar, bucket operations and
  file transfer have distinct owners. Keep shared lifecycle decisions together.
- **Open/closed and dependency inversion:** use the existing fetch/token/session
  adapters and the Rust `SessionStorage` implementations for actual variation.
  Do not add a new dependency or trait hierarchy for a single implementation.
- **Liskov substitution:** preserve signatures, wire values, errors, timing and
  ownership. Run the same contract and lifecycle tests before and after a move.
- **Interface segregation:** retain standalone TypeScript feature entry points
  and the explicit Rust facades; implementation modules are not consumer APIs.

Tests remain in each package's existing `test/` or `tests/` directories. Follow
[CONTRIBUTING.md](../CONTRIBUTING.md) for sequential Rust/Vitest/audit checks and
resource limits. Run package-consumer tests and the unchanged bundle budgets
after changing a module boundary. A class/file split that adds enough import
overhead to fail a budget must be redesigned, not justified by raising the limit.

The [execution record](../docs/goals/sdk-srp-execution.md) documents the baseline,
unchanged regression suites, public-interface comparison and bundle measurements.
