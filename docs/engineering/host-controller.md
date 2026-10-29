# Host controller ownership

The controller remains part of the modular monolith. Its separately authenticated
operator session never grants authority to project credentials. Existing IPC,
HTTP, journal, migration and SDK contracts are unchanged by this organization.

## Operator panel

| Owner | Responsibility |
| --- | --- |
| `features/updates/updates-console.svelte` | Controller shell, host/update navigation and component lifetime |
| `features/updates/console-state.svelte.ts` | Operator session, request generations, polling and update approval state |
| `features/updates/components/` | Login, navigation, release planning, approval, history and safety presentation |
| `features/host/host-console.svelte` | Host-area composition and the existing navigation/dirty-form interface |
| `features/host/console-state.svelte.ts` | Inventory, selection, mutation reconciliation and pending-request persistence |
| `features/host/model/approval.ts` | Confirmation, admission, plan freshness and durable request identity |
| `features/host/components/` | Project inventory, project actions, approval and job history |

Component styles remain locally scoped. Presentation components read the owning
model and invoke its operations; they do not start independent polling loops.
Mounted models own their timers, cancellation and password cleanup. Pending host
requests retain their original identity until an authoritative receipt resolves
them, including after an uncertain HTTP outcome.

## Privileged CLI

| Owner | Responsibility |
| --- | --- |
| `updates/management.rs` | Small facade for host management |
| `updates/management/policy.rs` | Provisioning policy and enrolled project lookup |
| `updates/management/preflight.rs` | Admission checks before host mutations |
| `updates/management/execution.rs` | Durable task transitions and injected-effect orchestration |
| `updates/management/effects.rs` | Effect contract, bounded commands, backup identity and artifact verification |
| `updates/management/status.rs` | Inventory and redacted operator log views |
| `updates/runtime.rs` | Deployment lease and authoritative failure/recovery decisions |
| `updates/runtime/activation.rs` | Ordered backup, activation and validation sequence |
| `updates/runtime/recovery.rs` | Resume and verified restore decisions |
| `updates/runtime/artifacts.rs` | Durable configuration, binary and traffic-gate publication |
| `updates/runtime/validation.rs` | Identity and readiness checks before reopening traffic |
| `updates/worker.rs` | IPC admission, shared worker state and operator sessions |
| `updates/worker/dispatch.rs` | Authenticated update requests and plans |
| `updates/worker/jobs.rs` | Idempotent job admission and process lifetime |
| `updates/worker/host.rs` | Authenticated host-operation adapters |
| `updates/worker/host/supervision.rs` | Detached host-process supervision and restart reconciliation |

Locks, transactions, maintenance gates and cleanup stay with their owning
operation. The facade preserves existing callers; private helpers are imported
explicitly rather than inherited from a parent's unrelated imports. Regression
tests keep their original module paths so native acceptance selectors remain
valid.

## Verification

Run the affected CLI update tests sequentially, the panel controller/model tests
and the update/host browser scenarios. Run the isolated native host-management
and IPC fixtures for privileged effects. Preserve repository resource limits,
run architecture checks, and commit rebuilt embedded panel assets separately.
Local fixtures do not satisfy the external provider acceptance pending in #151.
