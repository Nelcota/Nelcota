# App Router example

This runnable application uses published `@nelcota/nextjs` 0.1.1 and
`@nelcota/client` 0.2.3 with Next 16.4.3 / React 19.3.1. Use Node 22, 24 or 26.
The package manifest and lockfile use registry packages, with no local SDK link.

Copy this directory into a separate application directory, then run:

```sh
npm ci
```

Configure a disposable local Nelcota backend and create a user. The [backend quickstart](https://github.com/Nelcota/Nelcota/blob/main/docs/quickstart.md)
explains app migrations and startup. Set server-only environment variables:

```sh
export NELCOTA_URL=http://127.0.0.1:8000
export APP_ORIGIN=http://localhost:3000
export NELCOTA_SESSION_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
npm run build
npm run check
npm start
```

Open `http://localhost:3000/login` and sign in. Keep the same origin for every
request; changing between `localhost` and `127.0.0.1` changes the origin/cookies.
The example includes a sign-in Action, read-only profile/account pages, auth
POST handlers, a callback route and browser refresh. Credentials must remain in
server environment variables or submitted form/POST bodies.

The default `DevelopmentSessionStore` is loopback-only, volatile and limited
to one process. For disposable multi-process testing, provision the dedicated
session schema from the installed package's `sql/session-store.sql`, set
`NELCOTA_NEXT_SESSION_DATABASE_URL` privately, and give the application role
only the privileges described in the [SDK guide](https://github.com/Nelcota/Nelcota/blob/main/sdk/nextjs/README.md).

This fixture enables `allowInsecureDevelopment` and keeps a bounded global pool
for local testing. For deployment, follow the guide's production configuration:
HTTPS, an explicit origin, verified database TLS, application-owned pool
shutdown and scheduled expired-row cleanup. Configure a shared PostgreSQL store;
do not deploy the in-memory fallback. The backend API's RLS is the data boundary.

The package's checkout smoke scripts deliberately set `NELCOTA_NEXT_CHECKOUT=1`
and link the current SDK build using the parent's dependency tree. They verify
unreleased source. Ordinary standalone builds omit that variable and trace only
this application's registry dependencies. Keep the two dependency trees separate.

Live Google/GitHub and AWS S3/R2 HTTPS validation remain excluded. The callback
and storage examples do not claim those providers have been validated.

## Verify the copied application

After installing the copied application's dependencies, the checkout's existing
framework smoke can exercise that copy against controlled loopback auth and a
disposable PostgreSQL session database. From `sdk/nextjs` in the checkout:

```sh
NELCOTA_NEXT_EXAMPLE_DIR=/absolute/path/to/copied-app \
NELCOTA_NEXT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node scripts/framework-smoke.mjs
```

Start the repository's shared disposable database with `scripts/test.sh db`
first. Install the selected Playwright browser from `sdk/typescript` as described
in the SDK verification guide. This mode builds and runs the copied app using
its installed Next/React/SDK packages and does not link checkout SDK code.
