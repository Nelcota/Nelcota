# CLI reference

Use `nelcota --help` and `<command> --help` for the installed binary. The baseline
help below describes published server 0.5.6; the separate current-checkout
section describes newer commands. Match release/tag and checksum, not the
version string alone: a source build can still carry the workspace version.

| Workflow | Required capability |
| --- | --- |
| Manual local migrations and types | Published 0.5.6 or a current-checkout build |
| `dev --mail`, migration watching and project-owned development containers | Current-checkout build; absent from published 0.5.6 |
| `link`, named remote environments, `migrate status`, deployment tokens and `db reset` | Current-checkout CLI and a matching deployment-capable server |
| Automatic backups before production migrations | Matching backup-capable server/CLI and an explicitly configured project host agent |

A guide or a panel build does not upgrade an installed CLI. If a command is
unknown, inspect its installed `--help` and install the intended artifact before
continuing; do not remove project state to work around a version mismatch.

## Prerequisites and selection

Production host operations require Docker or supported Debian/Ubuntu systemd,
appropriate host privileges, a private host directory and the selected project.
Global `-C`/`--dir` selects the host (`NELCOTA_ROOT`, default `.`); `-p`/`--project`
selects a project. Commands needing one project require selection on multi-project
hosts. Without configuration, a bare `nelcota` prints help; with process/TOML
server configuration, it serves. `serve` explicitly loads server configuration.

Application `migrate` and `types` use a saved project link or explicit `--remote`
when present; `--local` selects the original database path. See
[remote migrations](remote-migrations.md) for scoped tokens and environments.
Local `migrate`, `types` and `token` use, in order: `NELCOTA_DATABASE_URL`
from the process environment, the selected host project, or the saved
`nelcota dev` settings. Run migrations in your application
folder; the repository-root migrations are internal Nelcota SQL.

> **Warning:** `token service-role` bypasses RLS. Keep its result private.
> `remove`, `down --volumes`, `restore` and `pitr restore` can delete/replace data;
> `pitr recover` clears a restore fence.
> A confirmation flag does not replace a verified backup and restore plan.

## Commands and options

Each block is the actual help output, preserving option names, accepted values,
defaults and arguments. Help does not run the command. Global options repeat
because they are accepted across command levels.

### Global help

```text
BaaS on plain Postgres: REST API, auth and deploy in a single binary.

Usage: nelcota [OPTIONS] [COMMAND]

Commands:
  update          Updates the CLI and projects to the latest stable release, with a preview
  updates         Secure, separately authenticated host update controller
  serve           Starts the HTTP server (the default when no command is given)
  init            Creates a project (and the host, the first time)
  projects        Lists the host's projects and the state of each one
  up              Starts the projects and Caddy (all of them, or only the one from -p)
  down            Stops a project (or all with --all). With --volumes, DELETES the data
  status          State of the projects (all of them, or only the one from -p)
  doctor          Checks the host: Docker, ports, disk, DNS, backup job and age, S3, health
  logs            Logs of a project, or of the host's Caddy
  remove          Removes a project: final backup in archive/, containers and data deleted
  panel-login     Panel login: one for all (shared) or one per project
  dev             Local development environment (Postgres in a container + server)
  migrate         Applies SQL migrations from the directory (files V<n>__<name>.sql)
  db              Local development database maintenance
  link            Links an application folder to a remote deployment environment
  upgrade         Updates the app image, with a backup first and a rollback if it fails
  backup          Dumps the database to backups/ and uploads it to S3 when host.env has a bucket
  restore         Restores a dump (replaces the project's current database)
  pitr            Point-in-time recovery: WAL archived to S3 with pgBackRest
  types           Generates TypeScript or Rust types from the exposed schema
  token           Issues service tokens
  keygen          Generates a new Ed25519 private key (for NELCOTA_JWT_PRIVATE_KEY)
  admin-password  New panel password (the host's with single sign-on; the project's with per-project login)
  healthcheck     Local healthcheck (used by Docker): exits with 0 if /health answers 200
  help            Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
  -V, --version            Print version
```

### nelcota init

```text
Creates a project (and the host, the first time)

Usage: nelcota init [OPTIONS] [DOMAIN]

Arguments:
  [DOMAIN]
          Project domain (e.g. api.shop.com). Without it, use --project with a base domain (subdomain) or --local

Options:
  -C, --dir <DIR>
          Host folder (default: current directory; update also finds /opt/nelcota)

          [env: NELCOTA_ROOT=]

      --project <PROJECT>
          Project name (default: derived from the domain, e.g. api.shop.com → shop)

      --base-domain <BASE_DOMAIN>
          Host base domain: `--project shop` becomes `shop.<base>`

      --local
          Local host, without a public domain: HTTPS at https://<project>.localhost

      --panel-login <PANEL_LOGIN>
          Panel login when creating the host: one for all (default) or per project

          Possible values:
          - shared:      One login for every panel on the host (SSO between projects)
          - per-project: Each project with its own login

          [default: shared]

      --email <EMAIL>
          Administrator email (default: admin@<domain>)

  -y, --yes
          Asks no questions (uses the defaults and the flags)

      --image <IMAGE>
          App image

          [env: NELCOTA_IMAGE=]
          [default: ghcr.io/nelcota/nelcota-server]

      --version <VERSION>
          Image tag (default: this binary's version)

      --profile <PROFILE>
          Postgres profile: 1gb, 2gb, 4gb or 8gb (default: by the RAM split across the projects)

      --s3-endpoint <S3_ENDPOINT>


      --s3-bucket <S3_BUCKET>


      --s3-access-key <S3_ACCESS_KEY>


      --s3-secret-key <S3_SECRET_KEY>


      --s3-region <S3_REGION>
          [default: us-east-1]

      --runtime <RUNTIME>
          How projects run: docker (N per host) or systemd (one, on Debian/Ubuntu, with Postgres and Caddy from apt). Only when the host is created

          [default: docker]
          [possible values: docker, systemd]

      --firewall
          Configures installed ufw on a new non-local Linux host (SSH, 80 and 443)

      --skip-checks
          Skips Docker, ports, RAM and DNS checks, not installation prerequisites

  -h, --help
          Print help (see a summary with '-h')
```

### nelcota dev

```text
Local development environment (Postgres in a container + server)

Usage: nelcota dev [OPTIONS]

Options:
  -C, --dir <DIR>                      Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --mail                           Capture local auth email with Mailpit and require signup confirmation (needs OpenSSL)
      --mail-callback <MAIL_CALLBACK>  Application page receiving local email-link fragments [default: http://localhost:3000/auth/callback]
  -p, --project <PROJECT>              Project (update defaults to all; other project commands may require one)
      --listen <LISTEN>                [default: 127.0.0.1:8000]
      --db-port <DB_PORT>              Local port of the development Postgres (default: the saved one, else 54322). A new port is saved in .nelcota/dev.env
  -h, --help                           Print help
```

### nelcota migrate

```text
Applies SQL migrations from the directory (files V<n>__<name>.sql)

Usage: nelcota migrate [OPTIONS] [COMMAND]

Commands:
  status  Show applied, pending, missing and diverged repository migrations
  help    Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --path <PATH>        [default: migrations]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --remote <REMOTE>    API origin of a remote project (HTTPS, or loopback HTTP for development)
      --env <ENVIRONMENT>  Linked environment name [default: default]
      --token <TOKEN>      Deployment credential. Prefer NELCOTA_DEPLOY_TOKEN to command-line history [env: NELCOTA_DEPLOY_TOKEN]
      --local              Use the local/host database even when this folder has a project link
      --dry-run            Validate history and show pending migrations without applying SQL
  -h, --help               Print help
```

### nelcota types

```text
Generates TypeScript or Rust types from the exposed schema

Usage: nelcota types [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --remote <REMOTE>    API origin of a remote project (HTTPS, or loopback HTTP for development)
      --env <ENVIRONMENT>  Linked environment name [default: default]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --token <TOKEN>      Deployment credential. Prefer NELCOTA_DEPLOY_TOKEN to command-line history [env: NELCOTA_DEPLOY_TOKEN]
      --local              Use the local/host database even when this folder has a project link
      --lang <LANG>        [default: typescript] [possible values: typescript, rust]
  -o, --out <OUT>
  -h, --help               Print help
```

### nelcota token

```text
Issues service tokens

Usage: nelcota token [OPTIONS] <COMMAND>

Commands:
  deploy        Opaque credential scoped to remote migrations and type downloads
  service-role  JWT with the service_role role (BYPASSES RLS: never use it in a frontend)
  help          Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota token service-role

```text
JWT with the service_role role (BYPASSES RLS: never use it in a frontend)

Usage: nelcota token service-role [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --days <DAYS>        [default: 3650]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota backup

```text
Dumps the database to backups/ and uploads it to S3 when host.env has a bucket

Usage: nelcota backup [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --upload             Requires the S3 upload (fails if host.env has no bucket). Without it, the dump is uploaded whenever the bucket is configured
      --keep <KEEP>        Keeps only the N most recent local dumps (at least 1: the new one)
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --all                All projects
  -h, --help               Print help
```

### nelcota restore

```text
Restores a dump (replaces the project's current database)

Usage: nelcota restore [OPTIONS] <FILE>

Arguments:
  <FILE>

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --files              Also restores the files from the backup bucket (disk storage)
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --yes                Does not ask for confirmation
  -h, --help               Print help
```

### nelcota upgrade

```text
Updates the app image, with a backup first and a rollback if it fails

Usage: nelcota upgrade [OPTIONS]

Options:
  -C, --dir <DIR>           Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --version <VERSION>   Target version (default: this binary's version)
      --all                 All projects, one at a time
  -p, --project <PROJECT>   Project (update defaults to all; other project commands may require one)
      --allow-downgrade     Allows a target older than the running version
      --reinstall           Redeploys even when the project is already on the target version
      --dry-run             Only prints the current → target version of each project
      --without-controller  Upgrades with this CLI on a host enrolled in the updates controller
  -h, --help                Print help
```

### nelcota down

```text
Stops a project (or all with --all). With --volumes, DELETES the data

Usage: nelcota down [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --volumes            Also deletes the data volumes (asks for confirmation; Docker only)
      --all
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --yes                Does not ask for confirmation before deleting volumes
  -h, --help               Print help
```

### nelcota remove

```text
Removes a project: final backup in archive/, containers and data deleted

Usage: nelcota remove [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --yes                Does not ask for confirmation
      --keep-files         Keeps the project folder (migrations, backups)
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --no-backup          Skips the final backup (otherwise a stopped Postgres is started for it)
  -h, --help               Print help
```

### nelcota logs

```text
Logs of a project, or of the host's Caddy

Usage: nelcota logs [OPTIONS] [SERVICE]

Arguments:
  [SERVICE]
          app, postgres or caddy (default: the project's app and postgres)

          Possible values:
          - app
          - postgres
          - caddy:    The shared proxy (host-wide; -p is not needed)

Options:
  -C, --dir <DIR>
          Host folder (default: current directory; update also finds /opt/nelcota)

          [env: NELCOTA_ROOT=]

  -f, --follow


  -p, --project <PROJECT>
          Project (update defaults to all; other project commands may require one)

  -h, --help
          Print help (see a summary with '-h')
```

### nelcota healthcheck

```text
Local healthcheck (used by Docker): exits with 0 if /health answers 200

Usage: nelcota healthcheck [OPTIONS]

Options:
      --addr <ADDR>        [default: 127.0.0.1:8000]
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota projects

```text
Lists the host's projects and the state of each one

Usage: nelcota projects [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota up

```text
Starts the projects and Caddy (all of them, or only the one from -p)

Usage: nelcota up [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota status

```text
State of the projects (all of them, or only the one from -p)

Usage: nelcota status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota doctor

```text
Checks the host: Docker, ports, disk, DNS, backup job and age, S3, health

Usage: nelcota doctor [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota panel-login

```text
Panel login: one for all (shared) or one per project

Usage: nelcota panel-login [OPTIONS] <MODE>

Arguments:
  <MODE>
          Possible values:
          - shared:      One login for every panel on the host (SSO between projects)
          - per-project: Each project with its own login

Options:
  -C, --dir <DIR>
          Host folder (default: current directory; update also finds /opt/nelcota)

          [env: NELCOTA_ROOT=]

  -p, --project <PROJECT>
          Project (update defaults to all; other project commands may require one)

  -h, --help
          Print help (see a summary with '-h')
```

### nelcota admin-password

```text
New panel password (the host's with single sign-on; the project's with per-project login)

Usage: nelcota admin-password [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota keygen

```text
Generates a new Ed25519 private key (for NELCOTA_JWT_PRIVATE_KEY)

Usage: nelcota keygen [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota serve

```text
Starts the HTTP server (the default when no command is given)

Usage: nelcota serve [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota pitr

```text
Point-in-time recovery: WAL archived to S3 with pgBackRest

Usage: nelcota pitr [OPTIONS] <COMMAND>

Commands:
  enable   Archives every WAL segment to the host's S3 and takes a first full backup
  disable  Stops archiving (the backups already in S3 are kept)
  status   Base backups and the time range that can be restored
  recover  Verifies a cleanly stopped PG17 directory and explicitly clears its fence
  backup   Takes a base backup now (full on Sundays, differential otherwise)
  restore  Restores the database to a moment (REPLACES the current data)
  help     Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota pitr enable

```text
Archives every WAL segment to the host's S3 and takes a first full backup

Usage: nelcota pitr enable [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota pitr disable

```text
Stops archiving (the backups already in S3 are kept)

Usage: nelcota pitr disable [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota pitr status

```text
Base backups and the time range that can be restored

Usage: nelcota pitr status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota pitr restore

```text
Restores the database to a moment (REPLACES the current data)

Usage: nelcota pitr restore [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --time <TIME>        Target moment, e.g. "2026-10-07 14:30:00+00" (default: the last archived write)
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --yes                Does not ask for confirmation
  -h, --help               Print help
```

### nelcota pitr recover

```text
Verifies a cleanly stopped PG17 directory and explicitly clears its fence

Usage: nelcota pitr recover [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --yes                Does not ask for confirmation; verification is still mandatory
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota updates

```text
Secure, separately authenticated host update controller

Usage: nelcota updates [OPTIONS] <COMMAND>

Commands:
  enroll        Enroll a host with a separate HTTPS origin and scoped operator (root/SSH only)
  serve         Unprivileged HTTP controller (normally managed by systemd)
  worker        Restricted privileged IPC worker (normally managed by systemd)
  status        Inspect the durable journal over SSH, including interrupted jobs
  recover       Recover one interrupted job; resume the committed version by default
  host-recover  Resume a host-management receipt after inspecting the interrupted operation
  host-status   Inspect host projects and durable management receipts over SSH
  help          Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota updates enroll

```text
Enroll a host with a separate HTTPS origin and scoped operator (root/SSH only)

Usage: nelcota updates enroll [OPTIONS] --origin <ORIGIN> --email <EMAIL> --password-file <PASSWORD_FILE> --verifier <VERIFIER> --projects <PROJECTS>

Options:
  -C, --dir <DIR>
          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --origin <ORIGIN>

      --email <EMAIL>

  -p, --project <PROJECT>
          Project (update defaults to all; other project commands may require one)
      --password-file <PASSWORD_FILE>
          Private file containing a new operator password (at least 16 characters)
      --verifier <VERIFIER>
          Root-owned native GitHub CLI supporting `attestation verify`
      --projects <PROJECTS>

      --host-management <HOST_MANAGEMENT>
          Private root-owned JSON approving host management, image and DNS scope
  -h, --help
          Print help
```

### nelcota updates host-status

```text
Inspect host projects and durable management receipts over SSH

Usage: nelcota updates host-status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota updates host-recover

```text
Resume a host-management receipt after inspecting the interrupted operation

Usage: nelcota updates host-recover [OPTIONS] --job <JOB>

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
      --job <JOB>
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota updates recover

```text
Recover one interrupted job; resume the committed version by default

Usage: nelcota updates recover [OPTIONS] --job <JOB>

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
      --job <JOB>
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --restore-snapshot   Restore the verified pre-update snapshot after commit, discarding later writes
  -h, --help               Print help
```

### nelcota updates serve

```text
Unprivileged HTTP controller (normally managed by systemd)

Usage: nelcota updates serve [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --config <CONFIG>    [default: /etc/nelcota-updates/controller.json]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota updates worker

```text
Restricted privileged IPC worker (normally managed by systemd)

Usage: nelcota updates worker [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota updates status

```text
Inspect the durable journal over SSH, including interrupted jobs

Usage: nelcota updates status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --policy <POLICY>    [default: /etc/nelcota-updates/policy.json]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota pitr backup

```text
Takes a base backup now (full on Sundays, differential otherwise)

Usage: nelcota pitr backup [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

## Operational guarantees and limits

- `upgrade` targets the installed CLI version unless you provide a version. Install
  that CLI first. On hosts enrolled in the updates controller, `upgrade` needs
  `--without-controller`; it is refused while a controller job is unresolved,
  for projects the controller already activated and from the controller's own
  binary.
- Ordinary upgrade/restore maintenance, paired snapshots and rollback are in
  [deploy](deploy.md) and [backup](backup.md). Database PITR has different failure
  and file-recovery limits; do not infer dump-restore guarantees from it.
- `pitr backup` takes a base backup now: full on Sunday, differential otherwise.
- `init` validates arguments before provisioning; provisioning errors can still
  leave files/services requiring inspection. `--skip-checks` does not make a
  failed deployment safe.
- `updates enroll` requires root/SSH and official artifacts plus a separate origin.
  Installation remains disabled until the exact-binary acceptance matrix passes.
  Internal serve/worker roles are normally managed by systemd.

## Troubleshooting

Use `status`, `doctor` and the selected service logs. Preserve unresolved update
journals/backups and use `updates status`/`recover` over SSH; do not clear receipts
to bypass a blocked host. For permission/SQL/auth errors, see
[troubleshooting](troubleshooting.md).

Related: [configuration](configuration.md), [deploy](deploy.md), [backup](backup.md)
and [controlled updates](panel-updates.md).

## Current-checkout capabilities

The following commands are not present in the published 0.5.6 CLI. Build the
current checkout and use its absolute binary path, or use a later verified
release that includes these capabilities. Remote deployment also requires a
matching server; a newer CLI alone cannot add its HTTP endpoints.

### nelcota link

```text
Links an application folder to a remote deployment environment

Usage: nelcota link [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --remote <REMOTE>    API origin of a remote project (HTTPS, or loopback HTTP for development)
      --env <ENVIRONMENT>  Linked environment name [default: default]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
      --token <TOKEN>      Deployment credential. Prefer NELCOTA_DEPLOY_TOKEN to command-line history [env: NELCOTA_DEPLOY_TOKEN]
      --local              Use the local/host database even when this folder has a project link
  -h, --help               Print help
```

### nelcota migrate status

```text
Show applied, pending, missing and diverged repository migrations

Usage: nelcota migrate status [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota db

```text
Local development database maintenance

Usage: nelcota db [OPTIONS] <COMMAND>

Commands:
  reset  Rebuild only this project's owned local development database from migrations and seed.sql
  help   Print this message or the help of the given subcommand(s)

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota db reset

```text
Rebuild only this project's owned local development database from migrations and seed.sql

Usage: nelcota db reset [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --yes
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```

### nelcota token deploy

```text
Opaque credential scoped to remote migrations and type downloads

Usage: nelcota token deploy [OPTIONS]

Options:
  -C, --dir <DIR>          Host folder (default: current directory; update also finds /opt/nelcota) [env: NELCOTA_ROOT=]
      --days <DAYS>        [default: 30]
      --name <NAME>        [default: cli-deploy]
  -p, --project <PROJECT>  Project (update defaults to all; other project commands may require one)
  -h, --help               Print help
```
