# Deploy repository migrations through the API

Keep application SQL in `migrations/V<n>__<name>.sql`, commit it with the app,
and apply the same complete folder in every environment. This workflow requires
a server and CLI built with deployment API support; installing an older release
does not add these source changes.

## Issue and link a deployment credential

In the panel, open Connect → Deployment tokens and create a named credential.
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
budget and HTTP deployment requests have a three-minute budget.

The panel's Migrations page can receive the same complete set of SQL files,
preview it, and apply it using the signed-in administrator. Files remain owned
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
environment and run the normal project tests before this step. Before production
application, capture and verify the project's existing paired backup/PITR
workflow on its host. The project deployment API has no host-controller
credentials and does not claim to create or verify a host backup. See
[backup](backup.md) for capture, remote verification and restore procedures.

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
