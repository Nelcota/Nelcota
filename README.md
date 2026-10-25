<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo-light.svg" alt="Nelcota" width="480" height="180">
</picture>

Open source backend-as-a-service for applications that use PostgreSQL.<br>
One Rust binary provides REST, authentication, file storage, webhooks,<br>
a database admin panel and a separately authenticated host operator console.

[![CI](https://github.com/Nelcota/Nelcota/actions/workflows/ci.yml/badge.svg)](https://github.com/Nelcota/Nelcota/actions/workflows/ci.yml)
[Releases](https://github.com/Nelcota/Nelcota/releases) · [Apache-2.0](LICENSE)

[Quickstart](docs/quickstart.md) · [Deploy](docs/deploy.md) · [Documentation website](https://nelcota.github.io/NelcotaWebsite/docs/) · [Repository guides](docs/README.md) · [Changelog](CHANGELOG.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-overview-dark.png">
  <img src="docs/assets/panel-overview-light.png" alt="Current Nelcota overview in English, showing project resources and API traffic">
</picture>

Screenshots show the current Svelte interface with disposable demonstration data
from the browser-test fixtures. They describe this checkout, including unreleased
UI changes, rather than a running production deployment.

## Why Nelcota

Use Nelcota when you want to own your database and deploy your backend on a VPS.
Your schema, grants, row-level security policies and functions remain SQL you
can export. PostgreSQL enforces data access; you do not need a separate Node
service for the backend or panel. Production deployments also use Caddy for
HTTPS, and optional integrations need their own SMTP or S3 provider.

Build applications through the REST API or the TypeScript, Rust and Next.js
clients. Manage tables, users, files and webhooks in the embedded panel. For
host operations, enroll a separate operator to manage isolated projects,
configuration, backups, recovery and operational alerts. Project administrators
and application users have separate credentials and authority.

## Quickstart

You need Linux, Docker, `curl` and `jq`. The installer downloads a published
binary and verifies its checksum. Use a fresh application directory:

```sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | NELCOTA_SKIP_DOCKER=1 sh
mkdir notes-app && cd notes-app
nelcota dev
```

Keep that terminal running. In a second terminal, enter `notes-app` and run:

```sh
set -eu
mkdir -p migrations
cat > migrations/V1__notes.sql <<'SQL'
CREATE TABLE public.notes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner uuid NOT NULL DEFAULT auth.uid(),
    body text NOT NULL
);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;
CREATE POLICY notes_owner ON public.notes FOR ALL TO authenticated
    USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
SQL
nelcota migrate
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

The last request returns your note under RLS. This account/password is a local
example. The [full quickstart](docs/quickstart.md) adds the shared SDK schema,
generated types and a runnable client. On macOS/Windows, build with Rust as
explained there. The panel is at `http://127.0.0.1:8000/admin/`; read its generated
credentials locally from `.nelcota/dev.env`.

> [!WARNING]
> A `service_role` token bypasses RLS. Keep it in trusted backend code; never
> include it in a browser, mobile app or public example configuration.

## What's inside

| Capability | Reference |
| --- | --- |
| Schema-derived REST, filters, relations, RPC and OpenAPI | [REST API](docs/api.md) |
| Password/email/OAuth sign-in, Ed25519 JWTs and refresh rotation | [Auth schema](docs/schema-auth.md), [JWT and roles](docs/jwt-and-roles.md) |
| Private/public files, disk/S3 storage and signed URLs | [Storage](docs/storage.md) |
| Transactional events and signed delivery with retries | [Webhooks](docs/webhooks.md) |
| Embedded English/Portuguese panel, table editing, SQL, migrations and API guides | [Panel](docs/panel.md) |
| Docker/systemd deployment, isolated projects, backups and database PITR | [Deploy](docs/deploy.md), [Backup](docs/backup.md) |
| Separate host operator console for project lifecycle, health and configuration | [Host management](docs/host-management.md) |
| Operator-approved email/webhook alerts and external heartbeat monitoring | [Operational alerts](docs/operational-alerts.md) |
| Controlled updates with artifact verification, approval and recovery | [Panel updates](docs/panel-updates.md) |
| TypeScript, Rust and Next.js App Router clients | [SDK overview](sdk/README.md) |

## Explore the panel

The current panel uses the official Nelcota wordmark, graphite surfaces and
cobalt actions, with light and dark themes, English and Portuguese, and mobile
navigation. The login keeps project identity visible and places language and
theme controls in the footer.

- **Database:** edit rows and table structure, filter and sort data, run SQL,
  inspect row protection and export schema changes as migrations.
- **Users:** inspect accounts, sessions and sign-in providers, with password
  and email/OAuth configuration kept separate from panel administrator login.
- **Storage:** browse buckets and files, preview content, manage access rules
  and create signed URLs using disk or S3-compatible storage.
- **Events and API:** configure signed webhook deliveries, inspect history,
  find SDK examples and read the bundled guides.
- **Server:** use a separately enrolled operator for health, project lifecycle,
  configuration, backups, alerts and controlled updates. Availability depends
  on enrollment, policy and the required acceptance checks.

<details>
<summary>Database table editor — light and dark themes</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-table-dark.png">
  <img src="docs/assets/panel-table-light.png" alt="Nelcota database table editor showing the notes table and row editing controls" loading="lazy">
</picture>

</details>

<details>
<summary>File storage — buckets, files and access rules</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-storage-dark.png">
  <img src="docs/assets/panel-storage-light.png" alt="Nelcota file browser showing the documents bucket, folders and file actions" loading="lazy">
</picture>

</details>

<details>
<summary>Updated administrator login</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-login-dark.png">
  <img src="docs/assets/panel-login-light.png" alt="Nelcota administrator login with email and password, project identity, language and theme controls" loading="lazy">
</picture>

</details>

Capture sources and reproduction steps are in [documentation assets](docs/assets/README.md).

## Deploy a VPS

Point your domain's DNS A record at a Linux VPS, then run on Debian/Ubuntu or
Fedora/RHEL:

```sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sudo NELCOTA_VERSION=0.5.4 sh -s -- api.yourdomain.com
```

The current installer prepares cron, Docker and the CLI, initializes the host
in `/opt/nelcota` and starts its projects and Caddy. Add `--firewall` to install
and configure ufw, or `--dir <folder>` to choose the host directory. Keep the
panel password shown during setup. Read [deployment](docs/deploy.md) for DNS,
ports, runtime choices and backups. The installer comes from `main`; the version
pin selects the published CLI and image, not a snapshot of the installer.

## Application SDKs

| Application | Package | Guide |
| --- | --- | --- |
| JavaScript / TypeScript | `@nelcota/client@0.2.3` | [REST, auth and storage](sdk/typescript/README.md) |
| Native Rust / Tokio | `nelcota-client = "0.1.6"` | [Rust client](sdk/rust/README.md) |
| Next.js App Router / Node.js | `@nelcota/nextjs@0.1.1` with `@nelcota/client@0.2.3` | [Server Components, Actions, Route Handlers and OAuth](sdk/nextjs/README.md) |

Publication and registry-consumer checks are recorded in the
[TypeScript/Rust receipts](https://github.com/Nelcota/Nelcota/pull/167#issuecomment-6391372294) and
[Next.js acceptance ledger](https://github.com/Nelcota/Nelcota/issues/151).
Next.js uses a dedicated PostgreSQL session store and request-scoped clients;
Server Components only read sessions. Its supported matrix is Next 16.4.3 /
React 19.3.1 on Node 22, 24 and 26. Source now targets Next.js SDK 0.1.1 with
additional session-concurrency corrections; see [version availability](docs/releases/README.md)
and the guide before configuring sessions.

## Status and roadmap

This source targets server **0.5.4**. SDKs have independent versions.
Confirm published artifacts and signed readiness on the
[release page](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.4).
The [0.5.4 notes](docs/releases/0.5.4.en.md) cover storage integrity, stable refresh
rotation, literal database identifiers, panel usability and guarded installation.
[current status](docs/current-status.md) distinguishes source scope, publication
and validation. Host project management and durable PITR recovery fencing remain available.
See the [changelog](CHANGELOG.md), [version and upgrade guide](docs/releases/README.md)
and [release handoff](docs/onboarding/release.md) for source/package distinctions.
A source build can report the same binary version as a published release until
its version is bumped: identify it by tag/commit and artifact hash.

Controlled panel updates are available in server 0.5.0 and remain disabled
until the exact controller binary passes its documented VPS acceptance matrix.
See [the update guide](docs/panel-updates.md).

Realtime subscriptions, Edge Functions, MFA and image transformations are not
implemented. Multiple isolated projects per Docker host are supported; shared
database tenant management is not built in. Versions remain 0.x: review upgrade
notes and test backup/restore before production changes. Measurements and their
operating limits are in [bench](bench/README.md).

## Documentation

Use the [task-based index](docs/README.md), [configuration](docs/configuration.md),
[CLI reference](docs/cli.md) and [security model](docs/security/README.md).
For a complete private Notes/file installation, follow [Notes staging](docs/onboarding/notes.md).

## Development

Source builds use Rust **1.99.1**, pinned in `rust-toolchain.toml`. Node is
needed for UI/TypeScript SDK development, not to run the Rust backend or panel.
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, targeted suites, contracts and
separate generated-panel commits. Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
for community conduct and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

[Apache-2.0](LICENSE)
