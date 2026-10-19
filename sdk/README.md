# SDK source ownership

The TypeScript and Rust SDKs retain separate packages and public entry points.
These directories organize their implementation; they do not add a new API,
runtime dependency, configuration format or release. Consumer documentation is
in [TypeScript](typescript/README.md) and [Rust](rust/README.md).

## TypeScript

| Owner | Responsibility |
| --- | --- |
| `src/index.ts` | Combined client composition and public feature exports |
| `core/` | Shared transport, cancellation, errors, encoding and JSON values |
| `auth/types.ts` | Authentication inputs, events and caller options |
| `auth/client.ts` | Account/link endpoints adapted to session operations |
| `auth/manager.ts` | One owner for session transitions, persistence, refresh and cleanup |
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
