# @nelcota/ssr

Request-scoped Nelcota sessions for server-rendered applications, independent of
the framework. The browser holds only an opaque, `HttpOnly` cookie; access and
refresh tokens stay in an encrypted server-side store. A cross-site script can
therefore never read a refresh token.

Use a framework adapter when one exists:

| Framework | Package |
| --- | --- |
| Next.js App Router | [`@nelcota/nextjs`](../nextjs/README.md), built on this package |
| SvelteKit 3 | `@nelcota/ssr/sveltekit` (below) |

Other frameworks call the core directly, as described below.
The core uses standard Web Crypto and can be bundled for Edge runtimes with a
compatible shared session store. See [Edge support and the token-cookie
decision](docs/edge.md); the PostgreSQL adapter remains a separate Node entry.

## What it provides

- One `Integration` per application, created from shared configuration:
  encryption keys, the session store and the Nelcota API URL.
- `read(cookies, work)` for rendering. The session is never refreshed or
  rotated while reading.
- `write(cookies, request, work)` for unsafe requests (POST/PUT/PATCH/DELETE)
  that may sign in, sign out, refresh or call the API. It checks the exact
  `Origin`, rejects cross-site requests, and serializes each browser session
  across all application instances through the store.
- Session lineage: a sign-in or sign-out in one tab supersedes earlier cookies,
  and late responses carrying an old cookie read as signed out, never as the
  previous user.
- PKCE OAuth with a state check, an optional storage-redirect allow-list,
  `safeReturnTo` for local redirects, and `createGuard` for authentication
  routing of protected paths.
- Sign-up confirmation bound to the browser that signed up: `auth.signUp`
  keeps the sign-up's PKCE verifier in the sealed server-side session and
  `auth.verifyEmailLink` sends it, so the chosen password survives the email
  link. The link opened in another browser still confirms and signs in, but
  the server clears that password.

## Install

```sh
bun add --exact @nelcota/ssr@0.1.0 @nelcota/client@0.2.5
bun add pg   # for the PostgreSQL store
# or with npm: npm install --save-exact @nelcota/ssr@0.1.0 @nelcota/client@0.2.5 pg
```

This guide targets 0.1.0, the first release, available on npm; [registry receipts](https://github.com/Nelcota/Nelcota/pull/203#issuecomment-6446199815)
record its integrity and a fresh consumer. See the [changelog](CHANGELOG.md).

Bun 1.4.3 or later, or Node 22, 24 or 26. Session keys never reach a browser bundle:
`Integration.create` refuses to run where `document` exists.

## Session store

Production requires a shared, durable store. Provision a dedicated PostgreSQL
database with [sql/session-store.sql](sql/session-store.sql), using its owner.
Give the application role only CONNECT on that database, USAGE on `nelcota_next`
and SELECT/INSERT/UPDATE/DELETE on `nelcota_next.sessions`. Never grant them to
Nelcota `anon`, `authenticated` or a public API schema. Expired rows,
tombstones and lineage heads are removed by an application-owned job: schedule
the bounded statement in [sql/session-cleanup.sql](sql/session-cleanup.sql)
every few minutes with the session role, repeating while it deletes a full batch.

```ts
import { Pool } from 'pg';
import { Integration } from '@nelcota/ssr';
import { PostgresSessionStore } from '@nelcota/ssr/postgres';

const pool = new Pool({ connectionString: process.env.SESSION_DATABASE_URL, max: 8 });
export const sessions = await Integration.create<Database>({
  url: 'https://api.example.com',
  appOrigin: 'https://app.example.com',
  keys: [process.env.SESSION_KEY!], // 32 random bytes, base64url; first key seals
  store: new PostgresSessionStore(pool),
});
```

### Pool sizing and deadlines

A `write` owns its browser session for the whole callback: it holds one pooled
connection and a PostgreSQL advisory lock until the callback returns, so keep
slow, unrelated work (uploads, third-party calls) outside `write` where you can.
To keep rendering available, at most `maxLeases` writes run at once (default
the pool's `max` minus one, at least one); further writers wait for a slot and
reads always keep a connection. Writers for the same session queue in-process
and take one slot between them. Lower `maxLeases` to reserve more read capacity
when writes call slow upstream services.

```ts
new PostgresSessionStore(pool, {
  timeout: 5_000,       // each statement and connection borrow
  leaseTimeout: 60_000, // longest one write may own its session
  lockTimeout: 60_000,  // how long a writer waits for the same session (default: leaseTimeout)
  maxLeases: 4,         // concurrent write leases (default: pool max - 1)
});
```

The positional `new PostgresSessionStore(pool, timeout, leaseTimeout)` form still
works. A waiter for a busy session gives up after `lockTimeout` (`session_store`),
or `session_capacity` when no lease slot frees up in time; the server cancels its
lock wait and the connection goes back to the pool. Refresh-token rotation for
one session stays serialized across requests, workers and app instances.

Session locks are session-level advisory locks on `hashtextextended(key, 0)`,
the single-bigint key space that every `pg_advisory_lock(bigint)` caller in the
same database shares. The key is frozen so that every version excludes every
other during a rolling deploy. A collision with another application's advisory
lock cannot corrupt sessions, but it serializes unrelated work and can make
either side wait or time out. Use a dedicated database for the session store,
as above, so nothing else takes advisory locks there.

`@nelcota/ssr/testing` provides `DevelopmentSessionStore`, an in-memory store
that only loads with `allowInsecureDevelopment` and a loopback `appOrigin`.

## SvelteKit

`createNelcotaSvelteKit(options)` returns per-request helpers and a `handle`
for `hooks.server.ts`. A [runnable example](examples/sveltekit) signs in through
a form action, protects a page and signs out. CI builds it with `adapter-node`
and drives it with Chromium, Firefox and WebKit on loopback, using the in-memory
development store; the example switches to `PostgresSessionStore` when
`NELCOTA_SESSION_DATABASE_URL` is set, which is what a production deployment needs.

```js
// src/lib/server/nelcota.js: one integration per process, created on first use
// (SvelteKit imports server modules while building, without the runtime env).
import { createNelcotaSvelteKit } from '@nelcota/ssr/sveltekit';
let integration;
export const nelcota = () => (integration ??= createNelcotaSvelteKit(options));

// src/hooks.server.js
let guard;
export async function handle(input) {
  guard ??= (await nelcota()).handle({ protectedPaths: ['/dashboard'] });
  return guard(input);
}

// src/routes/dashboard/+page.server.js: rendering never refreshes the session
export const load = async event => (await nelcota()).server(event, async ({ getUser }) =>
  ({ email: (await getUser()).data?.email ?? null }));

// src/routes/login/+page.server.js: form actions are same-origin POSTs
import { fail, redirect } from '@sveltejs/kit';
import { safeReturnTo } from '@nelcota/ssr';
export const actions = {
  default: async event => {
    const form = await event.request.formData();
    const result = await (await nelcota()).action(event, ({ auth }) =>
      auth.signInWithPassword({ email: String(form.get('email')), password: String(form.get('password')) }));
    if (result.error) return fail(400, { error: 'Invalid email or password' });
    // `next` from the guard already includes paths.base.
    redirect(303, safeReturnTo(event.url.searchParams.get('next') ?? '/'));
  },
};
```

Provide the refresh page too (`refreshPath`, default `/auth/refresh`, exported
as `DEFAULT_REFRESH_PAGE`). The guard sends a browser there when its access token
expired, and since rendering never refreshes, that page POSTs to a form action
calling `auth.refresh()` and then redirects back to `next`. The example's
[auth/refresh route](examples/sveltekit/src/routes/auth/refresh) does this. This
interstitial costs an extra round trip (redirect, page, POST, redirect) each time
an access token expires during navigation. A client-side app can avoid it by
calling `refreshSession()` from `@nelcota/ssr/browser` before the token expires.
That helper POSTs to a separate endpoint (`/auth/session/refresh`, exported as
`DEFAULT_REFRESH_ENDPOINT`; include `paths.base` when set), served by a `route`
calling `auth.refresh()`. The guard always leaves both paths public.

`route(event, work)` serves `+server.ts` endpoints and `callback(event, work)` the
OAuth callback. `server(event, work)` marks the page private through
`event.setHeaders` (`Cache-Control: private, no-store`, `Vary: Cookie`), once per
request even when a layout and a page both read the session; do not set those
headers again in the same request. Routing policies are written without
`paths.base`, which the adapter strips; the `next` parameter the guard adds already
includes it, so pass it to `redirect` unchanged. If you change Kit's `appDir`,
pass the same value to `handle({ appDir })` so its assets stay unguarded. Set `paths.origin` in the SvelteKit configuration when the
server cannot derive its public origin (SvelteKit 3 uses it for CSRF checks),
and read secrets from `process.env` at runtime (the example does).

## Using the core from a framework

An adapter supplies a cookie jar with `get(name)` and
`set(name, value, options)`, plus the incoming `Request`:

```ts
// Rendering: verified identity, no refresh.
const notes = await sessions.read(cookies, async ({ client, hasSession }) =>
  hasSession ? (await client.from('notes').select('id, body').execute()).data : []);

// Form/API endpoint: same-origin unsafe request only.
const response = await sessions.write(cookies, request, async ({ auth }) => {
  const result = await auth.signInWithPassword({ email, password });
  return result.error ? new Response(null, { status: 401 }) : new Response(null, { status: 303, headers: { location: '/' } });
});
return privateResponse(response);
```

Send every response that depends on the session through `privateResponse`
(`no-store`, `Vary: Cookie`, `Referrer-Policy: same-origin`: the URL never leaks
to other sites, while native same-origin form POSTs keep their `Origin` header,
which `no-referrer` would turn into `Origin: null` in Chromium). `createGuard(options, ignoredPrefixes)`
returns routing decisions (`public`, `allow`, `redirect`, `denied`,
`unavailable`, `invalid_path`) that an adapter maps to its own responses. A
guard is navigation assistance, never authorization: backend grants and RLS
decide what a user may read or write.

The [Next.js adapter source](../nextjs/src) is a complete example, at about 100
lines.

OAuth callbacks use `integration.oauthCallback(cookies, request, work)`; the older
`write(cookies, request, work, true)` form is deprecated but still works.

When a sign-in replaces a signed-in session (in this request, or another tab of
the same browser), the replaced upstream session is revoked through the auth
logout endpoint after the new one is published. This is best effort: a failure
never fails the sign-in and goes to the optional `onBackgroundError` hook, with a
code and message only (never tokens).

## Compatibility

Cookie values, sealed rows and the `nelcota_next` schema are the same as
`@nelcota/nextjs` 0.1.x, so moving between the adapter and the core keeps
existing sessions. Internal identifiers that still say `nelcota-next` (HKDF and
binding strings, lineage hashes, the Web Lock name, storage keys, the
`nelcota_next` schema) are frozen wire format and stay unchanged.

Envelopes still carry the SHA-256-prefix key id that 0.1.x reads; this version
also opens envelopes carrying the HKDF-derived id that a later release will
write. Legacy v1 envelopes still open by default; set
`legacyEnvelopes: false` once none can be live (the longest session TTL after
your last v1 writer), so a key is never used directly for AES-GCM. Rolling
deploys and rollbacks between 0.1.x and this version are safe: see the changelog.

## Development

```sh
bun install --cwd sdk/typescript --frozen-lockfile && bun run --cwd sdk/typescript build
bun install --cwd sdk/ssr --frozen-lockfile
bun run --cwd sdk/ssr check
bun run --cwd sdk/ssr test
NELCOTA_SSR_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  bun run --cwd sdk/ssr test:integration
bun run --cwd sdk/ssr build
```

### Backend smokes

These run the built core (`dist`) against a real Nelcota server, one at a time
from `sdk/ssr` after `bun run build`, on disposable fixtures only.
`sdk-ssr-check.yml` runs the first two in CI:

```sh
NELCOTA_NEXT_TEST_BINARY=/abs/target/debug/nelcota \
NELCOTA_NEXT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  bun scripts/backend-smoke.mjs   # adversarial session matrix, pool contention
# same two variables plus a disposable loopback S3 provider and its bucket-admin key:
NELCOTA_NEXT_TEST_S3_ENDPOINT=http://127.0.0.1:9100 \
NELCOTA_NEXT_TEST_S3_ACCESS_KEY_ID=... NELCOTA_NEXT_TEST_S3_SECRET_ACCESS_KEY=... \
  bun scripts/storage-smoke.mjs   # S3 redirects, credential stripping, ranges
```

`scripts/auth-smoke.mjs` runs from the SDK auth contract
(`sdk/typescript/scripts/contract.ts --nextjs`), and `scripts/oauth-smoke.mjs`
from the ignored `nextjs_sdk_finishes_a_real_pkce_flow` server test. Their
environment variables keep their historical `NELCOTA_NEXT_*` names.

The PostgreSQL integration tests use the repository's disposable fixture
(`scripts/test.sh db`), never a shared database. Without a URL they are skipped
with a message locally and fail in CI (`CI` set); `.github/workflows/sdk-ssr-check.yml`
runs them against a PostgreSQL service. The older `NELCOTA_NEXT_TEST_DATABASE_URL`
name is still accepted. The Next.js verification
workflow also runs every framework, browser and backend check through this core.
