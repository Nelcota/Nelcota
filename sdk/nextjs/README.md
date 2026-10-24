# Nelcota for Next.js — G11 candidate

**Unreleased prototype, not yet approved for production.** G11 completion gates
are tracked in [the execution record](../../docs/goals/nextjs-sdk-execution.md).
Do not install a registry package or deploy this candidate as if it were final.
It currently requires the local TypeScript SDK correction for #132. A new base
SDK version and matching minimum peer dependency are release prerequisites.

[Português](docs/quickstart.pt-BR.md).

## Scope

App Router on the Node.js runtime: Server Components, Route Handlers, Server
Actions, OAuth callback, optional authentication proxy, and a browser refresh
helper. Next 16.4.3 / React 19.3.1 / Node 24 are the initial tested candidates.
Node 22, previous Next majors, Pages Router and Edge are not certified.

This composes `@nelcota/client`; its REST/RPC/storage types and backend grants/RLS
remain the data contract. The proxy is navigation assistance, never authorization.
Never use a service/operator credential as a substitute for a visitor token.

## Production configuration

Keep this module server-only. Share configuration/pool, **never a user client**.
Provision a dedicated PostgreSQL session database with
[sql/session-store.sql](sql/session-store.sql), using its owner for installation.
Give an application role only CONNECT on that database, USAGE on `nelcota_next`
and SELECT/INSERT/UPDATE/DELETE on `nelcota_next.sessions`. Do not grant these
privileges to Nelcota `anon`, `authenticated`, or a public API schema. Runtime
credentials need no superuser, role administration or schema creation rights.

```ts
import 'server-only';
import { Pool } from 'pg'; // application-owned dependency
import { createNelcotaNext } from '@nelcota/nextjs/server';
import { PostgresSessionStore } from '@nelcota/nextjs/postgres';

const pool = new Pool({
  connectionString: process.env.SESSION_DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
  // Configure TLS with certificate verification for remote PostgreSQL.
});
pool.on('error', () => { /* record a stable connection-error event, no raw URL */ });
const store = new PostgresSessionStore(pool);
export const nelcota = createNelcotaNext<Database>({
  url: 'https://api.example.com',
  appOrigin: 'https://app.example.com',
  keys: [process.env.NELCOTA_SESSION_KEY!], // validate required environment at boot
  store,
});
```

Generate each key with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`.
Keep it in server secret storage; no `NEXT_PUBLIC_` prefix. Supply current then
previous keys (at most three) during rotation, retaining old keys through the
maximum session lifetime. Losing all old keys signs those sessions out; it does
not permit decrypting or adopting them. An unreadable or mismatched row reads as
no session (`staleCookie` is true), the next write deletes it and continues
signed out, and the proxy clears the cookie when it redirects to login. The
proxy does not clear a superseded cookie (see concurrent sign-ins below). `forgetLocalSession()` provides an
explicit same-origin POST reset without requiring successful decryption.

Use durable PostgreSQL commits and direct/session pooling. **Transaction pooling
is unsupported:** session advisory locks require the same physical connection.
Set pool connection/query limits, close the pool during your application's
shutdown, and handle pool idle errors. Saves are separate autocommits, not a
transaction spanning HTTP. The store bounds connection attempts, query time and
lease lifetime; a failed owner cannot write again. Same-key requests queue in
the process before borrowing a connection, and the lock is polled with
`pg_try_advisory_lock` within the store `timeout` (default 5 s). A request that
cannot obtain it fails with `SessionError` `session_store` instead of leaving a
backend waiting in PostgreSQL. `new PostgresSessionStore(pool, timeout, leaseTimeout)`
defaults to 5 s / 60 s and requires `leaseTimeout >= 2 * timeout`. Each auth
request in a lease gets at most the remaining lease time minus one store timeout,
which is reserved for saving its result. A request that cannot fit returns the
`lease_exhausted` auth error before it is sent. A lost HTTP reply after a
remote rotation can still require signing in again. It cannot be made atomic
with a separate auth server by a local SQL transaction.

Expired rows need application-owned housekeeping. For example run this bounded
statement periodically with the dedicated session role, recording counts only:

```sql
DELETE FROM nelcota_next.sessions WHERE key IN (
  SELECT key FROM nelcota_next.sessions
  WHERE expires_at <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
  ORDER BY expires_at LIMIT 1000
);
```

`DevelopmentSessionStore` is available from `/testing` only for explicit
`allowInsecureDevelopment: true` and a loopback application origin. It loses state
on restart, is not shared between workers, and is refused by default in production.

## Server Components: read only

```tsx
export default async function Profile() {
  return (await nelcota).server(async ({ getUser, client }) => {
    const user = await getUser(); // validates with auth service; not decoded JWT trust
    if (user.error) return <a href="/login">Sign in</a>;
    const notes = await client.from('notes').select();
    if (notes.error) throw new Error('Notes unavailable');
    return <p>{user.data.email}: {notes.data.length} notes</p>;
  });
}
```

Components do not refresh or mutate cookies/data. Expired sessions need the
explicit refresh POST flow. Use dynamic, user-specific rendering and never put
these contexts/results in a shared cache, `unstable_cache`, or public ISR page.
The adapter forces token-dependent API fetches to `no-store`; applications still
own their page/CDN cache configuration. Await every operation before the context
ends; a stored context is not a reusable client.

## Route Handlers and Server Actions

```ts
export async function POST(request: Request): Promise<Response> {
  return (await nelcota).route(request, async ({ auth }) => {
    const result = await auth.refresh();
    return Response.json(result, { status: result.error ? 401 : 200 });
  });
}
```

Route/Action mutation requires an unsafe method and an exact Origin matching
configured `appOrigin`; missing/foreign Origin is refused before HTTP/state
mutation. Host and forwarded headers do not define trust. For forms, read and
validate bounded fields yourself; do not pass arbitrary JSON to an auth method.
Read the request body **before** `route()`: the callback holds the browser
session's lease (and, with PostgreSQL, a pooled connection) until it returns.
Do no slow I/O unrelated to auth inside it, such as bodies, uploads or
third-party calls; see `examples/app-router/app/api/login/route.ts`.
Map `SessionError.code === 'csrf'` to a generic 403 and persistence errors to a
generic 503 in your error boundary, logging stable codes only. Do not serialize
causes, cookies, keys, request bodies or credential-bearing backend messages.
Each writable context first tries to refresh an expiring session. If that
refresh fails with a 429/5xx or network error, the callback still runs with the
stored session. Sign-out still clears local state, and the auth result carries
the backend error.

An Action uses `(await nelcota).action(async ({ auth }) => { ... })`. Next only
invokes Actions by POST, so the method check never fails for them. Their CSRF
defense is the exact `Origin` check above plus Next's own Server Action origin
check; do not widen `serverActions.allowedOrigins` beyond your own origin. Call
`redirect('/profile')` **after** checking the auth result; Next redirects throw,
and the adapter publishes an accepted cookie in its `finally` path. Do not catch
Next redirect exceptions as ordinary authentication failures.

Writable auth offers password login, sign-up, verified-user read, logout,
refresh, user update, password reset requests, magic links, confirmation resend,
email-link verification/reset and OAuth. Results contain users, not session JWTs.
Auth operations are serialized per request and per shared browser session.
Their bounded accepted publication completes before releasing the owner;
cancelling a waiter must not discard accepted credentials. Data calls retain
normal request cancellation and streaming ownership.

## OAuth and browser helpers

Start OAuth from a same-origin POST/Action with `auth.startOAuth({ provider,
returnTo })`, then redirect to the returned authorization URL. The only GET
callback context is `/auth/callback`, prefixed by the `basePath` option when the
app sets Next's `basePath` (for example `basePath: '/app'` gives
`/app/auth/callback`). `redirectTo` is built from the configured `appOrigin`, and
the callback is matched by path only: Host and forwarded headers are not trusted,
so a proxy that rewrites them still works. The host-only cookie plus one-use
state/PKCE bind it to the initiating browser. Proxy redirects also include
`basePath`. Pass `endpoint: '/app/auth/session/refresh'` to `refreshSession`.

```ts
export async function GET(request: Request): Promise<Response> {
  return (await nelcota).callback(request, async ({ auth }) => {
    const result = await auth.exchangeCode(new URL(request.url).searchParams.get('code') ?? '');
    if (result.error) return Response.json({ error: 'sign_in_failed' }, { status: 400 });
    return Response.redirect(new URL(result.data.returnTo, 'https://app.example.com'), 303);
  });
}
```

It requires the initiating browser cookie and one-use state/PKCE verifier.
Wrong state does not consume a valid verifier. Successful exchange clears state
before returning and accepts only validated local return paths. Ordinary auth
and data mutations are refused in this GET context. Use generic failure pages;
never reflect callback credentials or arbitrary `next` URLs into HTML/logs.

In a Client Component, import **only** `refreshSession` from
`@nelcota/nextjs/browser`; it POSTs to `/auth/session/refresh`. Provide that Route
Handler as above. The optional `/proxy` entry redirects expired sessions to
`/auth/refresh`, a page that owns the POST. Exclude callback/login/refresh pages
from loops. The example has an explicit Continue button. Ambiguous encodings
get a 400 only on paths that could reach a protected prefix after decoding.
Public paths such as `/blog/50%25-off` pass through. A proxy never refreshes
or writes cookies itself; storage failures must surface instead of silently
adopting another identity.

## Cookies, concurrency and remaining gates

A host-only HttpOnly SameSite=Lax cookie contains one random 32-byte opaque ID,
not JWTs. Production uses Secure and the `__Host-` prefix. Default names and
storage bindings include application/API identity. Server state is AES-256-GCM
authenticated encryption, with key rotation and expiry. Each save derives its own
AES key with HKDF-SHA-256 from the primary key and a random salt (format `v2`);
rows sealed in the earlier `v1` format still open. No incoming browser
cookie is forwarded to the API. A write never adopts a presented ID without a
stored row, and sign-in, sign-up, OAuth exchange, email-link verification and
password reset move the state to a fresh ID. The old row becomes a
credential-free tombstone. Custom `SessionStore` leases implement
`rotate(key, retain?)` for this: replace the current row with `retain` when it
is given, otherwise delete it.

### Concurrent sign-ins and response ordering

A browser keeps whichever `Set-Cookie` it processes last. If two tabs sign in
at the same time, the older identity could end up as the one the browser keeps.
The adapter orders identities per **lineage**, meaning every ID that descends
from one browser cookie:

- Each stored state records its lineage. A lineage head record (same table,
  sealed, keyed by a derived hash) names the one live key and a monotonic
  generation. A sign-in, sign-up, OAuth exchange, email-link verification,
  password reset or sign-out makes its key the new head under the lineage's
  store lock.
- A session row is live only while the head names its key and generation.
  Reads and writes check this, so a superseded cookie reads as signed out
  (`staleCookie` and `superseded` are true). It never reads as the older user.
- Before setting or clearing the cookie, a write checks the head again. If a
  later identity won while the write was running, it sets no cookie, clears
  nothing, and tombstones its own row. The auth result it already returned
  describes that losing attempt.
- Superseded session rows are replaced by tombstones after the winning request
  releases its lock. They are also replaced lazily when their ID is presented.
  A tombstone keeps only the lineage link, so a delayed request that carries
  the old ID still joins the lineage. Writes that publish nothing do not clear
  a superseded or row-less cookie, because the browser may already hold the
  replacement.
- **Bootstrap:** the optional proxy gives a cookie-less browser a random,
  credential-free ID on `bootstrapPaths` (default `[loginPath]`). No row is
  stored for it and a write never adopts it, but it seeds the lineage, so
  concurrent first sign-ins from tabs that loaded the login page share one.

Results: the newest sign-in or sign-out wins, or the browser ends up signed out
with `superseded: true`. It is never silently signed in as the older identity.
The cost is one more store read per session-bearing request (the head) and two
rows per lineage.

**Residual limits, by HTTP cookie semantics.** Requests that carry *no* session
cookie share nothing the server can link. Without a bootstrap ID (no proxy, a
path outside `bootstrapPaths`, or bootstrap responses that are themselves still
in flight when the sign-ins are sent), two concurrent first sign-ins remain
independent sessions. The browser keeps the last one it receives, and the other
row is unreachable but keeps its encrypted credentials until its absolute
expiry and housekeeping. The same applies when a winning head's response is
lost: that row lives until a later sign-in or sign-out in the lineage, or until
it expires. Tombstoning only deletes local state. It does not revoke a
superseded refresh token at the auth server.

Tests cover memory and PostgreSQL stores (mocked pool with two store instances,
and real PostgreSQL with two pools/instances): reordered responses for
different and identical users, publication withheld for a later winner, a
delayed sign-out with an older cookie, no clearing by stale requests, the
proxy bootstrap, and the cookie-less residual. Do not claim production
readiness until final-source backend tests, package installation,
compatibility and the full auth-flow matrix are resolved. See the execution
ledger.

## Local verification

From the repository root, install/build the base SDK, then `npm ci --prefix
sdk/nextjs`. Run Rust, Vitest and audits sequentially:

```sh
npm --prefix sdk/nextjs run check
NELCOTA_NEXT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  npm --prefix sdk/nextjs test
npm --prefix sdk/nextjs run build
```

The PostgreSQL integration creates/drops its own random test database. It needs
the repository's disposable fixture, never a production/shared database. The
example is **loopback-only development**, not a production deployment template.
Framework/backend scripts require bounded disposable environments; the latter
records the explicit binary SHA and does not claim it matches newer source.

## Storage downloads and S3 redirects

API, auth and REST/RPC requests never follow redirects (`redirect: 'error'`).
With an S3 backend, a storage download may answer with a redirect to a
presigned URL. Allow that explicitly:

```ts
createNelcotaNext<Database>({
  // ...
  storageRedirectOrigins: ['https://my-bucket.s3.eu-west-1.amazonaws.com'],
});
```

- Only `GET`/`HEAD` object requests under `/storage/v1/object/` follow
  redirects. They use `redirect: 'manual'`, with at most three hops, and every
  hop's `Location` must resolve to a listed origin.
- Origins are validated absolute HTTPS origins, with no path, query or
  credentials, and at most sixteen of them. Plain HTTP is accepted only for
  loopback hosts with `allowInsecureDevelopment`.
- On the first hop away from the API origin, the request keeps only `accept`,
  `range` and conditional headers. `Authorization`, cookies, `apikey` and every
  other header are dropped and are not restored on later hops. The presigned
  URL carries its own authorization.
- Without the option, or for a destination outside the list, the result error
  code is `storage_redirect_refused` and the destination is never contacted.
  Too many hops give `storage_redirect_limit`.

Unit tests and a real loopback HTTP redirect cover this. A real S3/MinIO
provider run with the Nelcota server has **not** been performed for this
adapter.
