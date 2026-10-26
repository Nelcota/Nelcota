# SvelteKit example

A minimal SvelteKit 3 app using `@nelcota/ssr/sveltekit`: `/login` signs in
through a form action, `/dashboard` is protected by `hooks.server.js` and shows
the signed-in user, `/auth/refresh` renews an expired session and returns, and
the dashboard's form signs out.

It uses the in-memory development store, so it is **loopback development
only**. Production uses `PostgresSessionStore` from `@nelcota/ssr/postgres` with
[sql/session-store.sql](../../sql/session-store.sql).

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

`NELCOTA_URL` is your Nelcota server. `ORIGIN` must be the URL the browser uses,
both when building (SvelteKit's trusted origin for CSRF checks) and when running
(the session integration's `appOrigin`). `node ../../scripts/sveltekit-smoke.mjs`
runs the whole flow in a browser against a local auth fixture.
