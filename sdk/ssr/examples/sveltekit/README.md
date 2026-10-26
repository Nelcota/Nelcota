# SvelteKit example

A minimal SvelteKit 3 app using `@nelcota/ssr/sveltekit`: `/login` signs in
through a form action, `/dashboard` is protected by `hooks.server.js` and shows
the signed-in user, and the dashboard's form signs out.

It uses the in-memory development store, so it is **loopback development
only**. Production uses `PostgresSessionStore` from `@nelcota/ssr/postgres` with
[sql/session-store.sql](../../sql/session-store.sql).

```sh
npm --prefix ../../../typescript ci && npm --prefix ../../../typescript run build
npm --prefix ../.. ci && npm --prefix ../.. run build
npm ci
ORIGIN=http://127.0.0.1:5173 npx vite build
PORT=5173 HOST=127.0.0.1 ORIGIN=http://127.0.0.1:5173 \
  NELCOTA_URL=http://127.0.0.1:54321 \
  NELCOTA_SESSION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  node build
```

`NELCOTA_URL` is your Nelcota server. `ORIGIN` must be the URL the browser uses,
both when building (SvelteKit's trusted origin for CSRF checks) and when running
(the session integration's `appOrigin`). `node ../../scripts/sveltekit-smoke.mjs`
runs the whole flow in a browser against a local auth fixture.
