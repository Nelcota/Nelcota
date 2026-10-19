# Quickstart: local development

Create a local application, make an authenticated request and read your own
rows through PostgreSQL RLS. For production HTTPS, use [deploy.md](deploy.md).

You need Docker, `curl` and `jq`. The optional JavaScript client needs Node 22+;
Rust client development needs Rust 1.88+. Building the server from source needs
the pinned Rust 1.99.0 toolchain. The binary needs no Node runtime.

## 1. Install the binary

On Linux with Docker already installed:

```sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | NELCOTA_SKIP_DOCKER=1 sh
nelcota --version
```

This installs the latest published release, currently 0.5.0. To build that
release on macOS/Windows with Rust 1.99+:

```sh
cargo install --locked --git https://github.com/Nelcota/Nelcota --tag v0.5.0 nelcota-server
```

For this checkout, run `cargo build --locked -p nelcota-server` and use the
absolute path to `target/debug/nelcota` in place of `nelcota`. Unreleased features
are listed in the server changelog. See [Notes staging](onboarding/notes.md)
for separate published/candidate acceptance.

## 2. Start the development environment

Use a fresh application directory outside Nelcota's repository:

```sh
mkdir notes-app && cd notes-app
nelcota dev
```

The command starts PostgreSQL 17 in `nelcota-dev-postgres-54322`, stores data
in a Docker volume, applies internal migrations and serves the API in the
foreground. The API is at `http://127.0.0.1:8000`, and the panel is at `/admin/`.
Its account is `admin@localhost`; read `ADMIN_PASSWORD` locally from
`.nelcota/dev.env`. Do not share that file.

Generated database passwords, signing keys and panel credentials persist in
that owner-readable, Git-ignored file. Repeating `dev` reuses them. Use
`--listen 127.0.0.1:9000` or `--db-port 54323` for free ports; changing the database
port selects another container/volume, rather than moving data. Ctrl+C stops
the API; the database container and its data remain until you stop/remove them.

`dev` enables disk storage and leaves SMTP/email confirmation off. Signup
therefore returns a session immediately. It uses generated settings, not your
application's `.env` overrides.

## 3. Write a migration

Keep `dev` running. Open a second terminal in `notes-app`. This file contains
the schema used by the SDK examples, including `extra` and the private `files`
bucket. Do this once in a fresh database:

```sh
mkdir -p migrations src
cat > migrations/V1__notes.sql <<'SQL'
CREATE TABLE public.notes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner uuid NOT NULL DEFAULT auth.uid(),
    body text NOT NULL,
    extra jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;
CREATE POLICY notes_owner ON public.notes FOR ALL TO authenticated
    USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
INSERT INTO storage.buckets (id, public) VALUES ('files', false);
CREATE POLICY notes_files_owner ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text);
SQL
```

For an existing schema, use the repeatable [examples/notes.sql](../examples/notes.sql)
or a new migration adding missing columns. `CREATE TABLE IF NOT EXISTS` does
not add columns to an existing table. A GRANT permits an operation, RLS enables
row filtering, and a policy defines accessible rows.

## 4. Apply it

```sh
nelcota migrate
nelcota migrate
```

The first run applies the file and records its checksum in
`nelcota.user_migrations`; the second is a no-op. The API reloads its catalog
without restarting. Never edit an applied migration: add `V2__...` instead.
The repository-root `migrations/` contains internal SQL, not your app schema.

## 5. Generate types

```sh
nelcota types -o src/database.ts
nelcota types --lang rust -o src/database.rs
```

Regenerate after schema changes. Generators describe the running server's schema;
consumer compilation does not connect to your database.

## 6. Use it from the client

First make an authenticated request using only `curl` and `jq`:

The catalog reloads asynchronously after migration. The bounded read below
waits for `notes` before sending a write; an error other than 404 stops the
example. Mutations are sent once.

```sh
set -eu
SESSION=$(curl -fsS -X POST http://127.0.0.1:8000/auth/v1/signup \
  -H 'content-type: application/json' \
  -d '{"email":"ana@example.com","password":"a-development-password"}')
TOKEN=$(printf '%s' "$SESSION" | jq -er '.access_token')
NELCOTA_SCHEMA_READY=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  NELCOTA_READ_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:8000/rest/v1/notes -H "authorization: Bearer $TOKEN")
  if [ "$NELCOTA_READ_STATUS" = 200 ]; then NELCOTA_SCHEMA_READY=1; break; fi
  [ "$NELCOTA_READ_STATUS" = 404 ] || { printf '%s\n' 'Readiness request failed' >&2; exit 1; }
  sleep 0.2
done
[ "$NELCOTA_SCHEMA_READY" = 1 ] || { printf '%s\n' 'Schema is not ready' >&2; exit 1; }
curl -fsS -X POST http://127.0.0.1:8000/rest/v1/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'prefer: return=representation' -d '{"body":"My first note"}'
curl -fsS 'http://127.0.0.1:8000/rest/v1/notes?order=id.desc' \
  -H "authorization: Bearer $TOKEN"
```

Use this password only for the local example. If the account exists, sign in
with `POST /auth/v1/token?grant_type=password` and the same JSON body instead
of signing up again. Another user's token returns none of Ana's notes.
On a project with confirmation enabled, confirm the email and sign in before
extracting an access token.

For a runnable JavaScript client, install the documented SDK version. Confirm
its registry availability first; a source checkout can also use a reviewed local
archive as described in the SDK README:

```sh
npm init -y
npm install @nelcota/client@0.2.1
cat > client.mjs <<'JS'
import { createClient, unwrap } from '@nelcota/client';
const client = createClient('http://127.0.0.1:8000');
try {
  unwrap(await client.auth.signInWithPassword({
    email: 'ana@example.com', password: 'a-development-password',
  }));
  const { data } = await client.from('notes').select('id,body,created_at')
    .order('id', { ascending: false }).throwOnError();
  console.log(data);
} finally { client.dispose(); }
JS
node client.mjs
```

In a TypeScript application, import `Database` from the generated file and use
`createClient<Database>(url)` with your framework's TypeScript build configuration.
The [TypeScript SDK](../sdk/typescript/README.md) explains published versus source
behavior. The [Rust SDK](../sdk/rust/README.md) uses the same Notes schema.

> **Warning:** `service_role` bypasses RLS. Never use it in a browser or mobile
> client; use each user's access token.

## Troubleshooting

For occupied ports, select free API/database ports before startup. For
`user_already_exists`, sign in to the existing account. For empty rows, 401/403
or missing columns, check [troubleshooting.md](troubleshooting.md).
Creating `.env` alone does not configure `nelcota serve`: it reads process
variables and optional TOML. Host Compose/systemd and `dev` load their own settings.

## Next

- Query syntax and errors: [api.md](api.md).
- Files and policies: [storage.md](storage.md).
- SDKs: [TypeScript](../sdk/typescript/README.md) and [Rust](../sdk/rust/README.md).
- Production: [deploy.md](deploy.md). Installation/restart checks: [Notes staging](onboarding/notes.md).
