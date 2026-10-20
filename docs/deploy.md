# Deploy

Provision PostgreSQL, the Rust app and Caddy for HTTPS on a VPS. You need
a supported Linux host, root access, DNS and open ports 80/443. Daily backups
require a running, boot-enabled systemd `cron.service` or `crond.service` whose
scheduler reads `/etc/cron.d` (Debian/Ubuntu cron or Fedora/RHEL cronie).
Use an explicitly selected published CLI/image version; source-only features
require their own release and acceptance. Node is not required.

```sh
sudo -i                                        # enter a root shell; omit if already root
# Debian/Ubuntu; prepare cron before either Docker or native init:
apt-get update
apt-get install -y ca-certificates curl coreutils cron
systemctl enable --now cron.service
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | NELCOTA_VERSION=0.5.0 sh
mkdir -p /opt/nelcota && cd /opt/nelcota
nelcota init api.yourdomain.com --version 0.5.0  # creates the host and the first project
nelcota up                                      # starts projects + Caddy, waits for the healthcheck
nelcota doctor                                  # optional: checks DNS, ports, backups and health
```

On Fedora/RHEL, install `cronie` and enable/start `crond.service` instead.
Other schedulers or init managers are not verified by automatic Linux host
provisioning. `nelcota dev` does not provision a host and needs neither root
nor a backup scheduler. Merely belonging to the Docker group is insufficient
for `init`: the file-storage directory must be owned by UID/GID `65532`.

The current source rejects missing installation prerequisites before writing
host credentials, even with `--skip-checks`. These preflight fixes are
**Unreleased**; when installing published 0.5.0, perform the preparation above
yourself. Never remove an existing project's `.env` just to retry a failed init;
inspect and preserve any partial installation first.

To request `--firewall`, install `ufw` first and allow your actual SSH port
before enabling it; the built-in `OpenSSH` rule normally covers port 22.
The option applies only to the first, non-local Linux host initialization.
Missing ufw or a failed rule aborts the current source's init. Without the
option, configure the host firewall and provider security group manually.

First create a DNS **A** record for the domain pointing at the VPS IP. Caddy
issues the certificate on its own on the first request. After starting
everything, `up` polls `https://<domain>/health` for up to a minute; if the
public URL does not answer, it lists what to check (DNS, firewall, Caddy logs)
and exits non-zero. Local hosts (`--local`) skip this check.

Without `curl | sh`: download `nelcota-<architecture>` and
`nelcota-<architecture>.sha256` from the releases page, run `sha256sum -c` and
copy it to `/usr/local/bin`. The [script](../scripts/install.sh) does just
that.

The built-in database connector uses private-network `NoTls`; an `sslmode`
URL is not a TLS connector. Keep database ports private. Production secrets
should be stable/private; do not use dev credentials or service tokens in apps.

## Host and projects

A VPS can hold **several projects**, each one isolated: its own Postgres,
users, JWT keys, panel and backups. A single project is simply a host with one
project.

```
Internet ──80/443──▶ Caddy (shared)
                        ├── api.shop.com ──▶ app-shop ──▶ shop's Postgres   (its own internal network)
                        └── blog.example.com ──▶ app-blog ──▶ blog's Postgres
```

```
/opt/nelcota/                   (the host folder; -C <folder> or NELCOTA_ROOT)
├── nelcota-host.json           registry: login mode, base domain, projects (no secrets)
├── host.env                    host secrets (0600): admin, SSO secret, S3
├── shared/projects.json        public list (name + URL), mounted into the apps for the switcher
├── caddy/                      shared Caddy; the Caddyfile is generated from the registry
├── archive/                    final backups of removed projects
└── projects/<name>/            docker-compose.yml, .env (0600), migrations/, backups/
```

- Only Caddy publishes ports. Each project's Postgres sits on its own
  `internal: true` network; apps talk to Caddy over the `nelcota_edge` network.
  Postgres also joins an `egress` network of its own, outbound only, to
  archive WAL to S3 when PITR is on.
- One Postgres per project, not a shared one: Postgres roles (`anon`,
  `authenticated`, `authenticator`...) apply to the whole server, and separate
  servers keep the physical isolation and a per-project `pg_dump` for leaving.

### Own domain or subdomain

```sh
nelcota init api.shop.com                                # own domain → project "shop"
nelcota init api.shop.com --project sales                # explicit name
nelcota init --project blog --base-domain example.com    # subdomain: blog.example.com
nelcota init --project panel                             # uses the base domain already saved on the host
nelcota init --local --project shop                      # local: https://shop.localhost
```

The project name comes from the domain (`api.shop.com` → `shop`), or from
`--project`. It shows up in the panel's project switcher and in the commands'
`-p`.

Arguments are validated before provisioning. A package, filesystem or service
failure during provisioning can still leave files/services behind; inspect the
reported stage before retrying.

### `init` flags

| Flag | What it does |
|---|---|
| `--project <name>` | project name (default: derived from the domain) |
| `--base-domain <domain>` | saves the host's base domain: `--project shop` becomes `shop.<base>` |
| `--local` | local host without a public domain (`https://<project>.localhost`, internal certificate); only when the host is created |
| `--panel-login shared\|per-project` | panel login mode when the host is created (default `shared`) |
| `--email <email>` | administrator email (default `admin@<domain>`) |
| `-y`, `--yes` | asks no questions (defaults and flags only) |
| `--image <image>` | app image (default `ghcr.io/nelcota/nelcota-server`, or `NELCOTA_IMAGE`) |
| `--version <tag>` | image tag (default: the CLI's version) |
| `--profile 1gb\|2gb\|4gb\|8gb` | Postgres profile (default: by the RAM split across the projects) |
| `--s3-endpoint`, `--s3-bucket`, `--s3-access-key`, `--s3-secret-key`, `--s3-region` | backup bucket, written to `host.env` (all four or none; region defaults to `us-east-1`). Without them, an interactive `init` asks, reading the secret key without echo |
| `--runtime docker\|systemd` | how projects run (only when the host is created; see below) |
| `--firewall` | requires installed `ufw`; configures SSH, 80 and 443 only when creating a non-local Linux host |
| `--skip-checks` | skips Docker, ports, RAM and DNS checks; root, backup scheduler and requested ufw requirements still apply |

## Commands

With a single project, `-p` is optional. With several, commands that act on a
project ask for `-p <name>`.

| Command | What it does |
|---|---|
| `nelcota projects` | lists projects, state and version |
| `nelcota up` | starts every project and Caddy (`-p` for just one), then checks public HTTPS |
| `nelcota status` | app and Postgres health, last backup age, version and free disk |
| `nelcota doctor` | checks Docker, Caddy/ports 80 and 443, free disk, DNS, the backup cron file and active boot-enabled scheduler, a backup younger than 26 h per project, S3 and service health; exits non-zero on any problem |
| `nelcota -p shop logs -f [app\|postgres]` / `logs caddy` | project logs / the shared proxy's logs |
| `nelcota -p shop down` / `down --all` | stops (`--volumes` DELETES the data after a confirmation, `--yes` skips it; Docker only) |
| `nelcota -p shop migrate` | applies `projects/shop/migrations/V<n>__<name>.sql` |
| `nelcota -p shop types -o database.ts` / `types --lang rust -o database.rs` | TypeScript (default) or Rust types of the schema |
| `nelcota -p shop token service-role` | service JWT (**bypasses RLS**) |
| `nelcota -p shop backup` / `backup --all --keep 7` | dump into `backups/`, uploaded to S3 when `host.env` has a bucket ([backup.md](backup.md)) |
| `nelcota -p shop restore <file>` | restores a dump, after a safety backup of the current state |
| `nelcota -p shop pitr enable` / `status` / `restore --time ...` | point-in-time recovery with WAL archived to S3 ([backup.md](backup.md#pitr-point-in-time-recovery)) |
| `nelcota -p shop upgrade` / `upgrade --all` | upgrades with a backup and automatic rollback (`--dry-run` shows current → target; downgrades need `--allow-downgrade`) |
| `nelcota -p shop remove` | final backup in `archive/` (starting Postgres if needed; `--no-backup` skips it), removes containers, data and the Caddy site |
| `nelcota panel-login shared` / `per-project` | panel login: single or per project |
| `nelcota admin-password` | new panel password (`-p` with per-project login) |

On a host, `migrate`, `types` and `token` run inside the project's `app`
container, which is what can reach Postgres. Outside a host, they use
`NELCOTA_DATABASE_URL`.

## Without Docker (systemd)

On a small VPS that will only ever hold one project, Nelcota can skip Docker:

```sh
sudo -i
apt-get update && apt-get install -y ca-certificates curl coreutils cron
systemctl enable --now cron.service
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | NELCOTA_SKIP_DOCKER=1 sh
mkdir -p /opt/nelcota && cd /opt/nelcota
nelcota init api.yourdomain.com --runtime systemd
nelcota up
```

As root on Debian or Ubuntu, `init` installs Postgres 17 and pgBackRest from
the PostgreSQL project's apt repository (PGDG) and Caddy from its own, then:

| What | Where |
|---|---|
| Postgres profile (by RAM) | `/etc/postgresql/17/main/conf.d/nelcota.conf` |
| The app | `nelcota-<name>.service`, running `/usr/local/lib/nelcota/nelcota serve` on `127.0.0.1:8000` with the project's `.env` |
| Caddy | the `caddy` service, `/etc/caddy/Caddyfile` generated from the registry |
| PITR settings | `/etc/pgbackrest/pgbackrest.conf` (with `pitr enable`) |

- Install AWS CLI v2 on the host before using offsite dump/file backups.
  Native package provisioning installs Postgres, pgBackRest and Caddy, not AWS CLI.
- Every command works the same way (`up`, `down`, `status`, `logs`, `migrate`,
  `backup`, `restore`, `pitr`, `upgrade`, `remove`); they drive `systemctl`,
  `journalctl` and `runuser -u postgres` instead of `docker compose`.
- One project per machine: a second `init` is refused, including from another
  directory and with `--skip-checks`. A machine-wide lease serializes native
  init/removal; `/var/lib/nelcota-native/owner.json` keeps the host-directory
  claim across interrupted commands. Only a completely successful `remove`
  releases it. Do not delete this record to bypass an interrupted installation:
  inspect and recover the original host over SSH. Legacy installations without
  a record are adopted only when their existing unit points unambiguously to
  the selected host's absolute `.env` path; conflicting or incomplete state
  requires explicit recovery. For multiple projects, use Docker.
- Native PostgreSQL uses the local `17/main` cluster on port 5432. A differently
  configured `17/main`, or another PostgreSQL cluster reserving 5432, is rejected
  before packages or new host/project configuration are written, including with
  `--skip-checks`. Other ports are not selected by native database commands. Native
  administrative clients explicitly select this cluster and local socket;
  ambient `PGCLUSTER`, `PGHOST`, `PGHOSTADDR`, `PGPORT` or service settings cannot
  redirect a backup, restore or credential update to a different database.
- The app's unit runs as a throwaway user (`DynamicUser`) with no write
  access to the system (`ProtectSystem=strict`) and no capabilities.
- `upgrade` swaps the binary the unit runs for the one you are running (so
  install the new version first: `NELCOTA_VERSION=x.y.z install.sh`), keeps the
  previous one and, if the app does not become healthy, puts it back and
  restores the pre-upgrade backup.
- `remove` takes the final backup, then deletes the unit and the Postgres
  cluster with its data (`pg_dropcluster`).
- `down --volumes` is Docker-only.

## Panel login

- **Single** (default): one email and password for every panel on the host.
  Signing in to one panel and switching projects with the switcher does not ask
  for the password again.
- **Per project**: each panel has its own credentials; the switcher just takes
  you to the other panel, which asks for its own login.

```sh
nelcota panel-login per-project     # generates and shows one password per project
nelcota panel-login shared          # back to single login (host password)
```

Security details in [panel.md](panel.md).

## What the first `init` does

1. **Checks** root access, an active boot-enabled backup scheduler and installed
   ufw when requested, before writing host credentials. Then checks Docker and
   the compose plugin, free ports 80/443
   (in use = error, with how to find the process; `--skip-checks` continues
   anyway), RAM and the domain's DNS.
2. **Machine:** with `--firewall`, configures `ufw` (SSH, 80 and 443), then
   installs the daily backup job (03:00, keeps 7). Failure aborts init before
   host credentials are written. These prerequisites are not skipped by
   `--skip-checks`.
3. **Generates** the host secrets: admin credentials (password shown **once**;
   `host.env` keeps only the argon2id hash) and the single sign-on secret.
4. **Backup:** asks for the S3-compatible destination (or use `--s3-*`).
   The job uploads whenever `host.env` has a bucket, so S3 can be added later.

Each later `init` only creates the project: its own secrets (Postgres,
`authenticator`, Ed25519 key), a Postgres profile from the RAM split between
projects, and the Caddy site (reloaded without taking the others down).

Project capacity depends on queries, data, hashing, uploads and PostgreSQL
working sets. Select a profile, measure your workload and monitor headroom.
The benchmark guide records specific fixtures; it does not establish a
projects-per-GB guarantee.

## Migrations

Plain SQL in `projects/<name>/migrations/`, named `V1__create_tables.sql`,
`V2__indexes.sql`... Each file runs in a transaction. Tracking lives in
`nelcota.user_migrations` (version, name, date, checksum): if an already
applied file is edited, `migrate` refuses. After applying, the API reloads the
catalog on its own.

### Changes made in the panel

Tables, columns and policies created in the panel go straight to the project's
database, but they do not exist in any other environment (staging, another
machine, a fresh database) until they become a file. The panel records each
one and lists the pending ones under **Migrations**; "Generate migration"
downloads `V<n>__<name>.sql` with them and already registers it as applied in
this database, with the same checksum `migrate` computes. Put the file in
`migrations/` and commit it: nothing runs again here, and `migrate` applies it
in the other environments.

The chosen number goes past everything in the database and in the folder (the
container reads `./migrations`, mounted at `/migrations`), so a file not yet
applied is never overtaken. Outside the container, point to the folder with
`NELCOTA_MIGRATIONS_DIR`. What you run in the SQL editor is not recorded: copy
that SQL into a migration by hand.

## Upgrade

`nelcota -p shop upgrade` makes the target image available before changing the
running project. It then puts that project's Caddy site in maintenance (HTTP
503 with `Retry-After`), stops the app to drain existing requests, and captures
the database and disk files together. Only then does it change
`NELCOTA_VERSION` in `.env`, start the new version and wait for its healthcheck.

If the new version does not become healthy, the CLI restores the previous
version, database and paired disk snapshot before reopening traffic. If backup
creation fails, it restarts the unchanged previous version. A failed or
interrupted recovery leaves the maintenance gate closed; after fixing the
cause, `nelcota -p shop up` checks health and reopens it. Other projects keep
serving traffic; `upgrade --all` upgrades one at a time, keeps going when one
project fails (it was rolled back) and lists the failures at the end.

Without `--version`, the target is the CLI's own version. The CLI compares it
with the project's `NELCOTA_VERSION` first:

- same version: nothing to do (`--reinstall` redeploys it anyway, e.g. a rebuilt
  binary on a systemd host);
- older target: refused, because the older app does not know the newer
  migrations. When the CLI itself is the older one, reinstall it
  (`curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh`); to go back on purpose, pass
  `--allow-downgrade`;
- `--dry-run` prints `current → target` for each project and changes nothing.

```sh
nelcota upgrade --all --dry-run
nelcota -p shop upgrade --version 0.5.0  # published target; already-current projects are skipped
```

## Local development

```sh
nelcota dev        # Postgres 17 in a container (127.0.0.1:54322) + server on :8000
```

The development secrets (panel and Postgres passwords, JWT key) live in
`.nelcota/dev.env`, readable only by you; the startup banner says where they
are instead of printing them. `nelcota token service-role --days 30` issues a
`service_role` token for that environment.

`--db-port <port>` moves the development Postgres to another local port. The
new port is saved in `.nelcota/dev.env`; it gets its own container and data,
and the old container is left as it was.

To test the full deploy locally (several projects, Caddy, HTTPS with an
internal certificate): `nelcota init --local --project shop` and open
`https://shop.localhost/admin/`.

## Acceptance test

```sh
ACCEPT_DOMAIN=api.example.com ./scripts/acceptance.sh   # real VM
./scripts/acceptance.sh --local                          # local simulation
```

Last local run (2026-10-06, Windows 11 + Docker Desktop, cached images): **two
projects with HTTPS in 28 s**. Also passing: migrate (idempotent), signup and
RLS through Caddy, isolation between projects (one project's JWT is not valid
on the other; one project's tables do not exist on the other), single sign-on
between panels with a single-use token, switching to per-project login and
back, `types`, backup → write → restore, automatic upgrade rollback without
affecting the other project, and project removal with a backup in `archive/`.

This dated local run is historical evidence. It does not validate a current
VPS, public DNS/TLS, the native systemd runtime or controlled updates. Published
releases now exist; run acceptance on your target host/version before relying
on production behavior.

## Optional host management

The controller in server 0.5.0 can provision and manage isolated Docker projects
after explicit SSH enrollment. Approve an official image, domain scope and VPS
addresses before enabling creation; inspect operation reviews and retain
recovery access. See `docs/host-management.md` for supported layouts and
production acceptance.
