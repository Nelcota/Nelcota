<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo-light.svg" alt="Nelcota" width="400">
</picture>

### Your PostgreSQL, your server, your backend.

REST API, authentication, file storage, webhooks and an admin panel,<br>
in a single Rust binary, secured by PostgreSQL row-level security.

[![CI](https://img.shields.io/github/actions/workflow/status/Nelcota/Nelcota/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=2088FF&labelColor=1F2328)](https://github.com/Nelcota/Nelcota/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/Nelcota/Nelcota?style=flat-square&label=release&color=003FDA&labelColor=1F2328)](https://github.com/Nelcota/Nelcota/releases) [![License](https://img.shields.io/badge/license-Apache--2.0-D22128?style=flat-square&logo=apache&logoColor=white&labelColor=1F2328)](LICENSE) [![Rust](https://img.shields.io/badge/Rust-1.99-CE422B?style=flat-square&logo=rust&logoColor=white&labelColor=1F2328)](rust-toolchain.toml) [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white&labelColor=1F2328)](docs/architecture.md)

**[Quickstart](docs/quickstart.md)** · **[Documentation](https://nelcota.github.io/NelcotaWebsite/docs/)** · **[Deploy](docs/deploy.md)** · **[SDKs](sdk/README.md)** · **[Changelog](CHANGELOG.md)**

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-overview-dark.png">
  <img src="docs/assets/panel-overview-light.png" alt="Nelcota admin panel overview with project resources and API traffic">
</picture>

## What is Nelcota?

Nelcota is an open source backend-as-a-service you run on your own VPS. Write
your schema in SQL, and Nelcota turns it into a ready-to-use backend:

- **REST API**: generated from your schema, with filters, relations, RPC and OpenAPI.
- **Authentication**: email/password, magic links, OAuth/OIDC, Ed25519 JWTs and refresh-token rotation.
- **File storage**: public and private buckets on disk or S3, with signed URLs.
- **Webhooks**: transactional events with signed delivery and retries.
- **Admin panel**: tables, SQL, migrations, users, files and webhooks, in English and Portuguese.
- **Host operations**: isolated projects per server, backups, point-in-time recovery and alerts.

There is no authorization layer to learn: **PostgreSQL grants and RLS policies
decide what every request can do.** Your data, schema and policies stay plain
SQL that you can export and [take with you](docs/leaving.md) at any time.

## How it works

```
your app ──HTTPS──▶ Caddy ──▶ nelcota (one binary) ──▶ PostgreSQL 17
                                │  /rest/v1     tables, views and RPC
                                │  /auth/v1     sign-up, sign-in and sessions
                                │  /storage/v1  buckets and files
                                │  /admin       embedded panel
```

Each request runs in a PostgreSQL transaction with the caller's role and JWT
claims, so your RLS policies apply everywhere: API, SDKs and storage alike.
Caddy provides HTTPS in production; locally, the API listens directly. The
panel is embedded in the binary, so no Node runtime is required in production.

## Quickstart

You need Linux, Docker, `curl` and `jq`. On macOS or Windows, build from source
as described in the [full quickstart](docs/quickstart.md).

**1. Install and start a local environment**

```sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | NELCOTA_SKIP_DOCKER=1 sh
mkdir notes-app && cd notes-app
nelcota dev
```

This starts PostgreSQL in Docker and serves the API at `http://127.0.0.1:8000`.
The panel is at [`/admin/`](http://127.0.0.1:8000/admin/); its credentials are
in `.nelcota/dev.env`.

**2. Describe your data in SQL** (in a second terminal, inside `notes-app`)

```sh
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
```

**3. Use your API**

```sh
TOKEN=$(curl -fsS -X POST http://127.0.0.1:8000/auth/v1/signup \
  -H 'content-type: application/json' \
  -d '{"email":"ana@example.com","password":"a-development-password"}' | jq -er .access_token)

curl -fsS -X POST http://127.0.0.1:8000/rest/v1/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'prefer: return=representation' -d '{"body":"My first note"}'

curl -fsS http://127.0.0.1:8000/rest/v1/notes -H "authorization: Bearer $TOKEN"
```

Each user only sees their own notes. That is the RLS policy at work. If the
API answers `404` right after `migrate`, wait a moment for the schema to reload.
The [full quickstart](docs/quickstart.md) continues with file storage,
generated types and a runnable client.

> [!WARNING]
> A `service_role` token bypasses RLS. Use it only in trusted backend code,
> never in a browser, mobile app or public configuration.

## Client SDKs

```ts
import { createClient } from '@nelcota/client';

const nelcota = createClient('https://api.yourdomain.com');
await nelcota.auth.signInWithPassword({ email, password });
const { data: notes } = await nelcota.from('notes').select('id,body');
```

| Platform | Package | Guide |
| --- | --- | --- |
| JavaScript / TypeScript | `bun add @nelcota/client` (or `npm install`) | [TypeScript SDK](sdk/typescript/README.md) |
| Rust / Tokio | `cargo add nelcota-client` | [Rust SDK](sdk/rust/README.md) |
| Next.js App Router | `bun add @nelcota/nextjs @nelcota/client pg` (or `npm install`) | [Next.js integration](sdk/nextjs/README.md) |

Generate types from your schema with `nelcota types -o src/database.ts`
(TypeScript) or `nelcota types --lang rust -o src/database.rs` (Rust). Quickstarts
are also available in Portuguese for [TypeScript](sdk/typescript/docs/quickstart.pt-BR.md),
[Rust](sdk/rust/docs/quickstart.pt-BR.md) and [Next.js](sdk/nextjs/docs/quickstart.pt-BR.md).

## Deploy to a VPS

You need a Linux server (Debian/Ubuntu or Fedora/RHEL) with root access, ports
80 and 443 open, and a DNS A record pointing at it. Then run:

```sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sudo NELCOTA_VERSION=0.5.5 sh -s -- api.yourdomain.com
```

The installer sets up cron, Docker and the CLI, creates the host in
`/opt/nelcota` and starts your project behind Caddy with automatic HTTPS.
**Save the panel password it prints; it is not shown again.** Add `--firewall`
to configure ufw. Run `nelcota -C /opt/nelcota doctor` to check DNS, ports, backups and health,
and read the [deployment guide](docs/deploy.md) and [backups](docs/backup.md)
before going to production.

## The admin panel

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-table-dark.png">
        <img src="docs/assets/panel-table-light.png" alt="Table editor showing the notes table" loading="lazy">
      </picture>
      <p align="center"><b>Database</b>: edit rows and structure, run SQL, export migrations</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-storage-dark.png">
        <img src="docs/assets/panel-storage-light.png" alt="File browser showing a bucket and its folders" loading="lazy">
      </picture>
      <p align="center"><b>Storage</b>: browse buckets, manage access, create signed URLs</p>
    </td>
  </tr>
</table>

The panel also manages users and sessions, sign-in providers, webhooks,
`service_role` tokens and bundled guides. Server operations (projects, backups, alerts and updates) live in a
separate operator console with its own credentials. See the [panel guide](docs/panel.md)
and [host management](docs/host-management.md).

## Status

This source targets server **0.5.5**. Nelcota is still `0.x`: read the
[upgrade notes](docs/releases/README.md) and test backup and restore before
upgrading production. See what changed in the [0.5.5 release notes](docs/releases/0.5.5.en.md);
newer changes are listed under [Unreleased](CHANGELOG.md#unreleased) and in the
[current status](docs/current-status.md).

Not implemented yet: realtime subscriptions, edge functions, MFA and image
transformations.

## Documentation

| Build | Operate | Reference |
| --- | --- | --- |
| [REST API](docs/api.md) | [Deploy](docs/deploy.md) | [Configuration](docs/configuration.md) |
| [Authentication](docs/schema-auth.md) | [Backup and PITR](docs/backup.md) | [CLI](docs/cli.md) |
| [JWT and roles](docs/jwt-and-roles.md) | [Host management](docs/host-management.md) | [Architecture](docs/architecture.md) |
| [Storage](docs/storage.md) | [Operational alerts](docs/operational-alerts.md) | [Security model](docs/security/README.md) |
| [Webhooks](docs/webhooks.md) | [Controlled updates](docs/panel-updates.md) | [Troubleshooting](docs/troubleshooting.md) |
| [Examples](examples/README.md) | [Leaving Nelcota](docs/leaving.md) | [Glossary](docs/glossary.md) |

Browse everything in the [documentation index](docs/README.md) or on the
[documentation website](https://nelcota.github.io/NelcotaWebsite/docs/).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
tests, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security
issues privately as described in [SECURITY.md](SECURITY.md).

## License

Nelcota is licensed under [Apache-2.0](LICENSE).
