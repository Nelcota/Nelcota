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
Nelcota `anon`, `authenticated` or a public API schema. Expired rows are removed
by an application-owned, bounded `DELETE` job.

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

`@nelcota/ssr/testing` provides `DevelopmentSessionStore`, an in-memory store
that only loads with `allowInsecureDevelopment` and a loopback `appOrigin`.

## SvelteKit

`createNelcotaSvelteKit(options)` returns per-request helpers and a `handle`
for `hooks.server.ts`. A [runnable example](examples/sveltekit) signs in through
a form action, protects a page and signs out; CI runs it in a production
`adapter-node` build with Chromium, Firefox and WebKit.

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
    // `next` is written without paths.base: prefix it when the app sets one.
    redirect(303, safeReturnTo(event.url.searchParams.get('next') ?? '/'));
  },
};
```

Provide the refresh route too (`refreshPath`, default `/auth/refresh`). The guard
sends a browser there when its access token expired, and since rendering never
refreshes, that page POSTs to a form action calling `auth.refresh()` and then
redirects back to `next`. The example's
[auth/refresh route](examples/sveltekit/src/routes/auth/refresh) does this.

`route(event, work)` serves `+server.ts` endpoints and `callback(event, work)` the
OAuth callback. Routing policies are written without `paths.base`, which the
adapter strips. Set `paths.origin` in the SvelteKit configuration when the
server cannot derive its public origin (SvelteKit 3 uses it for CSRF checks),
and read secrets from `process.env` at runtime (the example does).

## Using the core from a framework

An adapter supplies a cookie jar with `get(name)` and
`set(name, value, options)`, plus the incoming `Request`:

```ts
// Rendering: verified identity, no refresh.
const notes = await sessions.read(cookies, async ({ client, hasSession }) =>
  hasSession ? (await client.from('notes').select('id, body')).data : []);

// Form/API endpoint: same-origin unsafe request only.
const response = await sessions.write(cookies, request, async ({ auth }) => {
  const result = await auth.signInWithPassword({ email, password });
  return result.error ? new Response(null, { status: 401 }) : new Response(null, { status: 303, headers: { location: '/' } });
});
return privateResponse(response);
```

Send every response that depends on the session through `privateResponse`
(`no-store`, `Vary: Cookie`, no referrer). `createGuard(options, ignoredPrefixes)`
returns routing decisions (`public`, `allow`, `redirect`, `denied`,
`unavailable`, `invalid_path`) that an adapter maps to its own responses. A
guard is navigation assistance, never authorization: backend grants and RLS
decide what a user may read or write.

The [Next.js adapter source](../nextjs/src) is a complete example, at about 100
lines.

## Compatibility

Cookie values, sealed rows and the `nelcota_next` schema are the same as
`@nelcota/nextjs` 0.1.x, so moving between the adapter and the core keeps
existing sessions. Internal identifiers that still say `nelcota-next` are part
of that format and stay unchanged.

## Development

```sh
bun install --cwd sdk/typescript --frozen-lockfile && bun run --cwd sdk/typescript build
bun install --cwd sdk/ssr --frozen-lockfile
bun run --cwd sdk/ssr check
NELCOTA_NEXT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  bun run --cwd sdk/ssr test
bun run --cwd sdk/ssr build
```

The PostgreSQL integration tests use the repository's disposable fixture
(`scripts/test.sh db`), never a shared database. The Next.js verification
workflow also runs every framework, browser and backend check through this core.
