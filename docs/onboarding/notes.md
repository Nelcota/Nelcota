# Notes: installation and local staging

The next milestone is one working installation of the existing Notes example:
create an account, sign in, save a private note and upload a private file.
This guide keeps its database, signing keys and disk files separate from both
the repository's test database and any deployed project.

The local rehearsal uses the same native binary and PostgreSQL 17 as the
server. It uses `nelcota dev`, with HTTP on loopback and email confirmation
disabled. For public staging with DNS and HTTPS, use the deployment section
below. The Rust backend and the automated HTTP checks do not require Node.

Use Linux with Docker running, Git, curl, coreutils and Python 3.11+. Keep
the existing checkout if you already have one; otherwise start with:

```sh
git clone https://github.com/Nelcota/Nelcota.git
cd Nelcota
docker info > /dev/null
python3 --version
```

Building from source additionally requires [Rust](https://www.rust-lang.org/tools/install);
the repository pins its toolchain. The published binary does not require Rust.

## 1. Choose the binary

On Linux with Docker already installed, install a specific published release
into a user-owned directory. Run from the cloned repository:

```sh
NELCOTA_VERSION=0.5.6 PREFIX="$HOME/.local/bin" NELCOTA_SKIP_DOCKER=1 sh scripts/install.sh
"$HOME/.local/bin/nelcota" --version
```

The installer checks the SHA-256 before replacing the binary. Confirm the pinned release assets and readiness receipt before installing.
Changes after its tag require another matching artifact. To validate this
checkout instead, use the repository's pinned Rust toolchain and lockfile:

```sh
cargo build --locked -p nelcota-server
./target/debug/nelcota --version
```

The examples below use `target/debug/nelcota`. For a published installation,
replace the `NELCOTA_BIN` assignment with the absolute installed path. Do not
run `nelcota migrate` from the repository root: its `migrations/` directory
belongs to Nelcota itself, not your application's schema.

## 2. Create an isolated project and start it

Run these commands from the repository root, using a new project directory:

```sh
NELCOTA_SOURCE="$(pwd)"
NELCOTA_BIN="$NELCOTA_SOURCE/target/debug/nelcota"
mkdir -p .nelcota/notes-staging/migrations .nelcota/notes-staging/src
cp -n examples/notes.sql .nelcota/notes-staging/migrations/V1__notes.sql
cd .nelcota/notes-staging
"$NELCOTA_BIN" dev --listen 127.0.0.1:8100 --db-port 54323
```

Keep this terminal running. The API and panel are on port `8100`; this
project's PostgreSQL is on port `54323`. If either port or the container
`nelcota-dev-postgres-54323` is already used by another project, select a free
port before the first start and keep it on subsequent starts.

Generated credentials stay in this project's private `.nelcota/dev.env`.
The panel account is `admin@localhost`; read `ADMIN_PASSWORD` there locally
when you need to sign in. Keep that file private. Repeating the command
reuses the same credentials, database volume and `.nelcota/storage` files.
Changing `--db-port` selects a different database; it does not move data.

## 3. Apply the Notes schema

Open a second terminal at the repository root:

```sh
NELCOTA_BIN="$(pwd)/target/debug/nelcota"
cd .nelcota/notes-staging
"$NELCOTA_BIN" migrate
"$NELCOTA_BIN" migrate
"$NELCOTA_BIN" types -o src/database.ts
"$NELCOTA_BIN" types --lang rust -o src/database.rs
```

The first migration creates private `notes` and a private `files` bucket.
The second run must report that the database is up to date. The API reloads
its catalog without a restart. An anonymous OpenAPI document omits `notes`
because `anon` has no grant; sign in to see its operations.

After applying a migration, keep its contents unchanged and add a new
`V2__...sql` for further changes. `cp -n` above deliberately preserves an
existing migration; it does not update an already initialized project.

## 4. Use the existing browser example

The example already ships in `sdk/typescript/examples/browser.html`. To build
its local SDK modules, use Bun and Node 22+ only for this optional frontend
step, from the repository root:

```sh
cd sdk/typescript
bun install --frozen-lockfile
bun run build
python3 -m http.server 5178 --bind 127.0.0.1
```

Open `http://127.0.0.1:5178/examples/browser.html` in your browser. Set **API
URL** to `http://127.0.0.1:8100`, enter an email and a password, then:

1. Choose **Create account**. You should be signed in immediately.
2. Save a note and choose **List notes**. The saved note should appear.
3. Upload a text file. Its path should start with your account's user ID.
4. Sign out, sign in with the same credentials and list the note again.
5. In a separate browser profile, create another account. Its notes list
   should be empty; the first account's data stays private.
6. Stop the API with Ctrl+C and run the same `dev` command again. Sign in
   again: your note and file should still exist.

The panel is at `/admin/` on API port `8100`. It is the administrator's view;
use the example's account when assessing RLS. Never put a `service_role`
token in the browser: it bypasses RLS.

## 5. Run the repeatable acceptance check

For a fresh, disposable installation, from the repository root:

```sh
python3 scripts/test-onboarding.py --binary target/debug/nelcota
```

This Linux/Python 3.11+ runner needs Docker but no Node. It allocates separate
local ports, invokes the real `dev`, `migrate` and `types` commands, checks
panel login, creates two users, tests Notes and file isolation, checks logout
and restarts both the API and PostgreSQL. It verifies account identity,
saved notes, exact file bytes and signing keys after restart. It removes only
the database container whose generated credentials and mount match its own
fixture, and the volume carrying that run's unique ownership label. A volume
created concurrently by another run is rejected before starting the server.
Existing databases are never reused.

To exercise the browser example too, build the SDK as above and install the
browser test dependency:

```sh
# From sdk/typescript after bun install --frozen-lockfile and bun run build:
bunx playwright-core install chromium
cd ../..
python3 scripts/test-onboarding.py --binary target/debug/nelcota --browser
```

On Linux with a system Chromium already installed, set
`PLAYWRIGHT_CHROMIUM=/usr/bin/chromium` instead of downloading it. The browser
check uses another origin to exercise CORS. The automated fixture is separate
from the manual project on ports `8100`/`54323`.

Run the same acceptance command a second time to verify another fresh
installation. Each invocation writes a new `report.json` under the ignored
`.tools/reports/onboarding/` directory, including the exact binary SHA-256,
PostgreSQL image/version and timestamps. CI retains only this sanitized JSON
as an artifact; it does not upload the fixture's credentials or logs.
CLI/server diagnostics and generated credentials remain in private fixture
folders there; share only the sanitized report. A failed or incomplete check
exits non-zero. Data volumes are removed after both successful and failed
runs when ownership can be established.

## Public staging and release handoff

On a dedicated staging VPS, point a real domain at it and use an explicit
published image version through the existing CLI. Run as root (`sudo -i`), with
cron prepared as in [deployment](../deploy.md):

```sh
mkdir -p /opt/nelcota-staging && cd /opt/nelcota-staging
nelcota init staging.example.com --project notes --version 0.5.6
nelcota up
nelcota -p notes status
```

Copy `examples/notes.sql` to `projects/notes/migrations/V1__notes.sql`, run
`nelcota -p notes migrate` and repeat the browser steps with the HTTPS API
origin. Preserve that project's credentials and use a separate database,
file directory and backup destination from production. Use an immutable
published version rather than `latest`. The local acceptance check does not
provision a VPS, issue certificates or validate your DNS.

Stop the manual local API with Ctrl+C and stop its database with
`docker stop nelcota-dev-postgres-54323`; both its volume and disk files are
retained. Export or back up any data you need before removing them.

For upgrade preparation, publication gates and remaining limits, see
[release handoff](release.md), [deployment](../deploy.md) and
[backups](../backup.md). For empty results, 401/403 or migration errors, see
[troubleshooting](../troubleshooting.md).
