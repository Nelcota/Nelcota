# Edge runtimes and session storage

The framework-independent session core uses Web Crypto, `TextEncoder`,
`TextDecoder`, `atob` and `btoa`. It imports no Node built-ins and needs no
`Buffer`. Application code can bundle `@nelcota/ssr` or its SvelteKit adapter
for a Worker/Edge runtime that provides these standard APIs. The PostgreSQL
adapter is a separate Node entry point and is not an Edge database transport.
These changes are source-only until the next package publication.

Provide an authoritative `SessionStore` reachable from the runtime, preserving
the contract in `src/store.ts`: shared state, exclusive ownership, fencing,
lease lifetime/cancellation and atomic rotation. An ordinary eventually
consistent key/value cache is insufficient. The repository's PostgreSQL
adapter demonstrates the contract; it does not imply that a particular Edge
provider or third-party store has been deployed or validated.

Existing cookie names, hashed store keys, lineage keys and encrypted v1/v2
session rows remain compatible. New rows keep the v2 HKDF-SHA-256/AES-GCM
format; the primary key seals and the bounded keyring opens earlier rows.
Keep old keys until the maximum configured session lifetime has elapsed.

## Decision: keep tokens in shared storage

Issue #206 asked whether an opt-in encrypted token cookie is worth offering.
The decision is to retain the store-backed model for Edge too. A stateless
cookie mode cannot preserve the current session ownership and lineage
contract. Implementing it as a transparent alternate store would imply
revocation and concurrency guarantees it cannot provide.

| Scenario | Shared store | Stateless sealed token cookie |
| --- | --- | --- |
| A delayed sign-in response replaces a newer identity | Lineage generation rejects superseded state | The older cookie can restore that identity |
| Two tabs refresh the same token | One exclusive owner publishes rotation | Both requests can rotate independently; late cookies can overwrite the winner |
| Sign-out followed by replay of an old cookie | Stored head/tombstone retires the old lineage | Replay survives until the embedded token expires or the backend revokes it |
| Oversized JWT/user/PKCE data | Bounded encrypted server row, fixed-size opaque cookie | Browser/proxy cookie limits can reject or truncate the session |
| A cookie encryption key leaks | Bounded keyring rotation and shared state revocation | Every copied cookie remains usable until expiry or global key removal |

HttpOnly encryption hides token plaintext from page scripts, but a copied
cookie is still a replayable bearer credential. Adding a revocation index and
an exclusive refresh coordinator to a cookie mode would require shared state
again. No token-cookie mode, chunking protocol or weakened fallback is exposed.
The browser continues to receive one fixed-size opaque cookie.

## Verification and limits

`bun run test:edge` bundles the core for web runtimes and evaluates it in a
sandbox with standard Web APIs and no Node imports, `Buffer`, `process` or
`require`. It opens independently constructed released v1/v2 envelopes,
verifies stable hashes, runs opaque-cookie sign-in/read/sign-out and rejects
cross-origin mutation. Unit tests retain key rotation, tampering, expiry,
wrong binding, size bounds, lineage and refresh concurrency checks.

This demonstrates standard-API portability; it is not a live deployment to
an Edge provider. Validate the chosen provider and your shared-store adapter
before production use. The default store-backed behavior remains unchanged.
