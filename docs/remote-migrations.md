# Deploy repository migrations through the API

Keep application SQL in `migrations/V<n>__<name>.sql`, commit it with the app,
and apply the same complete folder in every environment. This workflow requires
a server and CLI built with deployment API support; installing an older release
does not add these source changes. Published 0.5.6 lacks `link`, named remote
environments, deployment tokens and the automatic migration backup agent.
Use the same reviewed current-checkout capability on the CLI and project server,
or a later verified release that includes it; check installed `--help` first.

## Issue and link a deployment credential

In the panel, open Connect → Deployment tokens. Its guide shows the target API,
lets you name the environment, and keeps that environment on every command.
Create a named credential.
It is copied once, stored only as a SHA-256 digest on the server, expires after
30 days and can be revoked from the same page. On the configured project host,
`nelcota token deploy --days 30 --name ci-production` issues the same kind of
credential; validity is limited to 1–90 days.

Provide the token through `NELCOTA_DEPLOY_TOKEN`, then link your app folder:

```sh
# Set NELCOTA_DEPLOY_TOKEN through your local secret manager or CI secrets.
nelcota link --remote https://api.example.com
nelcota migrate status
nelcota migrate --dry-run
nelcota migrate
nelcota types -o src/database.ts
```

The link is in owner-only `.nelcota/project.json`, ignored by Git. Named
links use `nelcota link --remote https://staging.example.com --env staging`;
pass `--env staging` before the `status` subcommand or other options when
using that link. `--remote` and `NELCOTA_DEPLOY_TOKEN` can also be supplied
without saving a link. `--local` explicitly uses the local/host database.
A linked environment takes precedence over saved development settings;
`token deploy` always uses host/local administrator configuration.

Remote URLs must be HTTPS origins. Loopback HTTP is accepted for disposable
local development. Credentials in URLs and redirects are refused. The token
works only at `/admin/deploy/v1/migrations`, `/migrations/status` and
`/typescript` under that prefix. It cannot authenticate public REST, storage,
auth or ordinary panel routes. A migration executes administrator SQL, so
protect deployment tokens like database deployment credentials.

## Apply and inspect

Status compares the full repository folder with `nelcota.user_migrations`:
`applied`, `pending`, `diverged` (changed checksum/name or an out-of-order file),
and `missing` (applied in the database but absent from the folder). Divergence
and missing files block application. Restore the original files; never edit
released SQL or checksum records. CRLF is normalized to LF before checksumming.
The checksum algorithm remains refinery's existing algorithm.

Each pending file runs in its own transaction under the shared migration lock.
SQL, its history record and the actor/version/checksum audit row commit together.
Two deploys cannot apply the same version twice. PostgreSQL refuses transaction
control inside a migration; do not include `BEGIN`, `COMMIT`, `ROLLBACK`, or
commands requiring execution outside a transaction. Earlier successful files
stay committed if a later file fails. Inspect status after a timeout or lost
response before retrying. Catalog refresh failure after commit is reported as
`catalog_pending`, without replaying SQL. Per-file statements have a two-minute
budget. The backup preparation budget is five minutes; HTTP deployment and
CLI requests allow eleven minutes for backup plus SQL. A timeout can follow
earlier committed files, so always inspect status before retrying.

The panel's Migrations page can receive the same complete set of SQL files,
preview it, and apply it using the signed-in administrator. Preview is required
before application, and selecting different files invalidates that preview.
The result lists each file's status, newly applied versions, the verified backup
when one was captured, and any pending catalog refresh. A lost response requires
a new preview to reconcile history; it never triggers an automatic replay. Files remain owned
by the repository; uploading does not install a second copy on the server.
`nelcota.migration_audit` records remote token identity or panel administrator
and the applied version, checksum and time.

Set `NELCOTA_PRODUCTION=true` to block direct table/policy schema changes from
the panel; previewing SQL remains available. The SQL editor always warns that
manual SQL is not recorded as a migration. Keep production schema changes in
the repository and use forward-only expand/contract migrations.

## CI and backups

The composite action at `.github/actions/migrate` builds the locked CLI with
the pinned toolchain and calls the deployment API. Store the token in a
repository/environment secret and pin the action to a reviewed commit:

```yaml
# After checkout and the project's tests, in a protected deployment job:
- uses: Nelcota/Nelcota/.github/actions/migrate@<reviewed-commit>
  with:
    url: ${{ vars.NELCOTA_URL }}
    token: ${{ secrets.NELCOTA_DEPLOY_TOKEN }}
    path: migrations
```

The build step never receives the token. Configure workflow concurrency per
environment and run the normal project tests before this step.

### Automatic backup before application

On a Linux host, install the current CLI and project server, then enable the
project's backup agent once as root:

```sh
nelcota -C /opt/nelcota -p shop migration-backup enable
```

The installer first checks that the project's running binary supports this
capability. It then installs a root-owned systemd service bound to that host/project, adds the
exact read-only Unix socket mount to an official generated Compose layout (or
uses the socket directly with the native service), and recreates the app with
`NELCOTA_MIGRATION_BACKUP_SOCKET` and a private, random
`NELCOTA_MIGRATION_BACKUP_TOKEN`. Custom Compose layouts require an operator to
review and add that mount explicitly; the installer refuses to rewrite them.
Install/re-enable with the matching CLI when upgrading the agent binary.
Project removal retires its agent service before deleting the project.

Set `NELCOTA_PRODUCTION=true` in the project's environment and recreate the app.
Pending production migrations fail with `migration_backup_required` until a
backup agent is configured. A configured agent also protects non-production
writes. The same gate covers deployment tokens, authenticated panel uploads and
local CLI application with this configuration. Disposable `nelcota dev`
environments keep their existing behavior.

Before the first pending file in each request, the agent takes the existing
custom-format database dump and, for disk storage, its immutable file snapshot.
It verifies the file manifest and dump archive. Configured external backup
destinations additionally use the existing HTTPS upload/readback verification;
failures stop application. S3 application objects retain their provider-specific
recovery requirements; a database dump does not archive those external bytes.
The response's `report.backup` names the recovery dump in the project's
`backups/` directory. Keep the sibling `.files/` directory with disk backups.
No automatic pruning runs during migration; the existing scheduled retention
policy still applies. This uses a logical backup even on PITR-enabled hosts.
See [backup](backup.md) for off-host verification and restoration.

Status, dry runs and already-applied requests create no backup. Invalid or
divergent history is rejected before capture. A missing agent, failed capture,
failed verification or lost agent connection prevents unprotected SQL. Each
successful file still commits independently; retain the backup and inspect
status if an interruption follows a committed file.

The agent accepts only a fixed-size project backup credential. It receives no
host paths, command lines, project selectors or deployment/controller tokens.
Projects get no Docker socket or host-controller access. A shared host lease
and root-private `.migration-backup-active` fence exclude host mutations while
backup/SQL are running. SQL cancellation sends a PostgreSQL cancellation request;
the agent waits for the migration session lock to be released before clearing
the fence. An agent crash leaves the fence in place. Restart its installed
`nelcota-migration-backup-<id>.service` to recover after SQL stops; use
`systemctl list-units 'nelcota-migration-backup-*'` to identify it. A changed
project environment makes recovery fail closed for operator inspection. Do not
delete the fence or change configuration while recovery is unresolved.

## Local parity

`nelcota dev` applies existing application migrations after internal bootstrap
and watches the folder once a second for new/changed files. Divergent files are
reported and remain unapplied. The repository's own folder is refused as an
application development folder because its SQL is internal.

To rebuild disposable local data, stop `dev` and close SQL connections, then run
`nelcota db reset --yes`. The command checks this folder's labeled development
container, refuses managed hosts, recreates only its local database, reapplies
internal and application migrations, then runs optional application `seed.sql`.
It preserves development secrets and disk blobs; it does not target linked
remote projects. The confirmation flag is required because local data is deleted.
