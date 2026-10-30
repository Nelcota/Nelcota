# SvelteKit example

A minimal SvelteKit 3 app using `@nelcota/ssr/sveltekit`: `/login` signs in
through a form action, `/dashboard` is protected by `hooks.server.js` and shows
the signed-in user, `/auth/refresh` renews an expired session and returns, and
the dashboard's form signs out.

The session store depends on the environment. With
`NELCOTA_SESSION_DATABASE_URL` set it uses `PostgresSessionStore` from
`@nelcota/ssr/postgres` on a database provisioned with
[sql/session-store.sql](../../sql/session-store.sql); this is the production
setup. Without it, the example falls back to the in-memory development store,
which the core accepts only for a plain-HTTP loopback `ORIGIN` (the only case in
which the example sets `allowInsecureDevelopment`). The commands below, and the
CI smoke test, build for production but run on loopback with the in-memory store;
they are not a production deployment.

```sh
bun install --cwd ../../../typescript --frozen-lockfile && bun run --cwd ../../../typescript build
bun install --cwd ../.. --frozen-lockfile && bun run --cwd ../.. build
bun install --frozen-lockfile
ORIGIN=http://127.0.0.1:5173 bunx vite build
PORT=5173 HOST=127.0.0.1 ORIGIN=http://127.0.0.1:5173 \
  NELCOTA_URL=http://127.0.0.1:54321 \
  NELCOTA_SESSION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  bun build/index.js   # or with Node: node build
```

For a production-like run, add
`NELCOTA_SESSION_DATABASE_URL=postgres://…` (a dedicated session database) and
serve an HTTPS `ORIGIN`.

`NELCOTA_URL` is your Nelcota server. `ORIGIN` must be the URL the browser uses,
both when building (SvelteKit's trusted origin for CSRF checks) and when running
(the session integration's `appOrigin`). `node ../../scripts/sveltekit-smoke.mjs`
runs the whole flow in a browser against a local auth fixture.
