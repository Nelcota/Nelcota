# Backup and restore

Capture and restore a database together with its disk-file snapshot. You need
a selected initialized host/project, PostgreSQL tools through its runtime,
sufficient disk space and a private offsite destination when configured.

Source fixes after 0.4.0 are unpublished: use matching release guidance and
verify the actual artifact. Take a compatible verified pair before destructive
recovery; database PITR has different guarantees from a dump restore.

## Backup

```sh
nelcota -p shop backup            # pg_dump -Fc → projects/shop/backups/nelcota-shop-<date>.dump
                                  # (+ s3://<bucket>/shop/ when host.env has a bucket)
nelcota -p shop backup --upload   # requires the upload: fails if host.env has no bucket
nelcota backup --all --keep 7     # every project; keeps the 7 most recent local dumps (--keep ≥ 1)
```

`backup` uploads on its own whenever the S3 variables are in `host.env`, so
adding a bucket after `init` needs no other change. `--upload` forces it and
fails without one.

The first `init` (as root) installs a daily cron job at 03:00
(`/etc/cron.d/nelcota-backup`):

```
0 3 * * * root '/usr/local/bin/nelcota' -C '/opt/nelcota' backup --all --keep 7 >> /var/log/nelcota-backup.log 2>&1
```

A broken project does not stop the others from being backed up; the command
lists the failures and exits non-zero. `nelcota status` shows the age of each
project's last backup, and `nelcota doctor` reports a missing cron job or a
backup older than 26 hours.

With disk storage, every dump has a sibling `<dump>.files/` directory containing
the immutable object versions and a SHA-256 manifest. The dump and file list
share one exported Postgres snapshot. A SHARE lock on `storage.objects` prevents
metadata changes during capture; reads continue, but file writes may wait.

The upload publishes that directory to `s3://<bucket>/<project>/<dump>.files/`
before uploading the dump. Later replacements and deletions cannot change an
older snapshot. Keep each dump together with its file directory; `--keep` prunes
both locally. Configure remote lifecycle rules for both members of the pair.

On Unix, dumps, snapshot files, manifests and environment files are created
with mode **0600**, before writing data. Backup and archive directories use
**0700**. Copies retain the private policy rather than the source's mode;
downloads run with umask 077 and their bundles are sealed afterward. Existing
environment files are restricted before overwriting them. Windows keeps the
filesystem's ACL policy; Unix modes are not simulated there.

The dump uses `pg_dump`'s custom format: it includes schema, data, RLS
policies, functions and the `auth` schema (users with their argon2id hashes).
Cluster roles (`anon`, `authenticated`...) are not in the dump, but Nelcota's
migrations recreate them on any new install.

### S3-compatible

Any service with an S3 API: AWS S3, Backblaze B2, Cloudflare R2, Wasabi,
MinIO. Variables in `host.env` (they apply to every project):

```sh
NELCOTA_BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
NELCOTA_BACKUP_S3_BUCKET=my-backups
NELCOTA_BACKUP_S3_ACCESS_KEY=...
NELCOTA_BACKUP_S3_SECRET_KEY=...
NELCOTA_BACKUP_S3_REGION=us-west-002
```

Docker uploads use the `amazon/aws-cli` image. Systemd hosts execute native
AWS CLI v2, which you must install separately. Set private bucket access and
explicit remote lifecycle rules for both dumps and file snapshots. Test readback
and off-host restore; a successful upload alone does not prove recoverability.

> **Keep `host.env` and each project's `.env` somewhere safe, apart from the
> bucket.** They are not in the backup (they hold secrets). Without the
> project's `.env` a restore still works, but the JWT key changes and every
> user has to sign in again (passwords keep working).

## Restore

```sh
nelcota -p shop restore projects/shop/backups/nelcota-shop-20261006T030000Z.dump
```

The restore asks for confirmation (`--yes` skips it), puts the project's
Caddy site in maintenance (HTTP 503 with `Retry-After`), stops the app and
takes a **safety backup** of the current state, printing its path. Then it
runs `pg_restore --clean --if-exists` in **a single transaction** (if anything
fails, the database stays as it was), starts the app and reopens traffic once
it is healthy. If the app does not become healthy, the site stays in
maintenance and the error shows how to go back:

```sh
nelcota -p shop restore projects/shop/backups/<safety dump> --yes
```

A restore also takes over a maintenance gate left closed by a failed upgrade
or restore, since it is how such a project recovers.

Use `--files` to restore the matching disk snapshot. It uses the local sibling
directory when present, otherwise fetches that dump's snapshot from the backup
bucket. The manifest, file sizes and hashes are checked before stopping the app.
The immutable versions are copied before restoring the database, so a file-copy
failure leaves the database untouched. Existing unrelated versions remain for
the normal orphan collector. Backups made with the former shared storage mirror
have no historical file manifest; they remain usable for database-only restores.

### Restore on a new VPS

```sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh
mkdir -p /opt/nelcota && cd /opt/nelcota
nelcota init api.shop.com --yes
cp /safe/place/shop.env projects/shop/.env   # optional: keeps the JWT key
nelcota up
aws s3 cp s3://my-backups/shop/nelcota-shop-....dump projects/shop/backups/ --endpoint-url ...
nelcota -p shop restore projects/shop/backups/nelcota-shop-....dump --files --yes
```

This restores the matching disk snapshot too; fetch its directory/manifest or
configure the host backup bucket so the CLI can fetch it. Omit `--files` only
for an intentional database-only restore. Preserve and reconcile the private
project/host configuration, including credentials and SSO settings. The direct
`aws` download above requires an installed AWS CLI and configured private access.

The acceptance test (`scripts/acceptance.sh --local`) takes a backup, writes
more data, restores and checks that the state went back to the backup's.

When a project is removed (`nelcota -p <name> remove`), a final backup is kept
in `archive/`, in the host folder. If its Postgres is stopped, `remove` starts
it for the backup and refuses to delete anything when it cannot;
`--no-backup` removes without one.
Disk snapshots are archived alongside the final dump.

## PITR (point-in-time recovery)

Daily dumps lose up to 24 h of writes in the worst case. With PITR on,
Postgres sends every WAL segment to the S3-compatible storage as it fills (and
at least once a minute), next to periodic base backups, so the project can go
back to **any second** the archive covers: just before a bad migration or a
`DELETE` without a `WHERE`.

```sh
nelcota -p shop pitr enable                                    # archiving + first full backup
nelcota -p shop pitr status                                    # backups and the range covered
nelcota -p shop pitr backup                                    # base backup now (full Sunday, otherwise differential)
nelcota -p shop pitr restore --time "2026-10-07 14:30:00+00"   # back to that moment
nelcota -p shop pitr restore                                   # up to the last archived write
nelcota -p shop pitr disable                                   # stops archiving (keeps what is in S3)
```

- It uses [pgBackRest](https://pgbackrest.org/), installed in the project's
  Postgres image (`postgres/Dockerfile`: the official `postgres:17-alpine` plus
  the Alpine package, so the data directory is unchanged). Everything goes to
  `s3://<bucket>/<project>/pitr/`, beside the dumps.
- It needs the S3 settings in `host.env` (the same ones the backup upload uses).
  pgBackRest only talks to S3 over HTTPS. For your own MinIO/SeaweedFS with a
  private certificate authority, install its trusted CA for the runtime.
  `NELCOTA_BACKUP_S3_VERIFY_TLS=false` disables verification and should not
  be used for production recovery. For providers requiring path-style URLs,
  set `NELCOTA_BACKUP_S3_URI_STYLE=path`.
- `enable` writes `pgbackrest.env` in the project folder (mode 600, it holds
  the S3 keys). After changing the S3 settings in `host.env`, run `enable`
  again to regenerate it.
- The daily `backup --all` also takes a base backup for projects with PITR:
  full on Sundays, differential on the other days. Two full backups are kept,
  so the window reaches back one to two weeks. Fewer WAL segments to replay
  means a faster restore.
- PITR restores PostgreSQL only. It does not rewind disk/S3 object bytes.
  Older metadata can refer to versions already deleted; maintain provider
  versioning/history or a separately verified file-recovery plan. Paired
  dump/file snapshots are a different recovery mechanism.
- `restore` stops the project, rewrites the data directory from the closest
  base backup, replays the WAL up to the target and starts everything again.
  It discards every write after the target, so it asks for confirmation
  (`--yes` skips it). Then it takes a new full backup, because the restored
  database continues on a new timeline that older backups cannot serve.
- Recovery is destructive. Some configuration/archive problems are rejected
  early, but an unreachable target can be detected during WAL replay after
  files were restored. Before changing data, the CLI persists a recovery fence
  outside the data directory. An error or interrupted restore retains it across
  CLI exit, service restart and machine reboot. Do not assume the old database
  is unchanged or automatically restored. Use the explicit recovery steps below.
- Projects created before PITR are updated by `enable`: Postgres switches to
  the image built from `postgres/Dockerfile` and gets an `egress` network to
  reach S3 (the `internal` network has no way out). If `docker-compose.yml`
  was edited by hand, `enable` prints the changes to make.

The acceptance test (`scripts/acceptance-pitr.sh`) runs the whole cycle
against a local S3 server with TLS.

### PITR recovery fence

This is an Unreleased source capability; use a matching CLI and app artifact.
Run fence mutations and recovery on the Linux host. Docker refuses a restore
before changing data if the app image does not support the guard. Native recovery
also requires the matching installed app binary. Custom entrypoints, app commands
or data-directory locations require reviewed integration; they are refused
rather than silently left unprotected.

The durable fence is `active.json` (or a partially committed `recovery.json`)
under `/var/lib/nelcota-pitr/` on systemd, or
`projects/<project>/pitr-fence/` on Docker. Private receipts bind the fence to
its owning project and directory. Docker's `active.json` holds the exact original
Compose bytes for atomic release; do not print or publish its contents. The fence
has no timeout and is never removed at boot. Do not delete these files, move the
host directory, bypass entrypoints or disable the start guards.

Native PostgreSQL and app units check the fence in `ExecStartPre`, including
boot, manual `systemctl start` and cluster starts redirected through systemd.
The guard invokes a dedicated check-only copy at
`/usr/local/lib/nelcota/pitr-check`, retained across app binary rollback, without
following a script inside the fence directory. The CLI refuses `up`, service starts/restarts
and direct serving while fenced. Plain `up` is not a recovery action: use
`pitr recover` or a covered restore. Each refusal identifies the fence and
recovery command; systemd records its message in the service journal. A refused
unit can be `failed` with PID zero.

Docker temporarily rewrites `docker-compose.yml` and removes old containers
without removing their data volumes before any restore writes. The fenced
Compose mounts the project directory read-only so a substituted fence-directory
symlink remains visible to both entrypoint guards; its restart policy is
`no`. This prevents old `unless-stopped` or `always` containers from reopening
after a daemon or host restart. A manual container start still exits at the
guard, even if its restart policy is changed. Docker starts asynchronously:
inspect its exit status and logs, not only the exit code of `docker start`.
Successful recovery restores the exact original Compose bytes and `up` applies
its original restart policies.

Recovery validates directory components and every state file without following
symlinks, and rejects wrong owners, hardlinks or unexpected types before changing
PITR state or services. A refusal names the rejected path; preserve every marker
and investigate the ownership/layout instead of deleting it.

After verification and a clean recovery-server stop, Docker persists an
owner-bound `release.verified.json`, prepares `active.json` with the original
Compose bytes and removes `recovery.json`. One atomic rename then removes the
last marker and restores `docker-compose.yml` together; both directories are
synced. Failure before that commit leaves markers and guarded Compose. Failure
after it leaves no markers and the original Compose. Native guards remain
installed while markers are removed and synced. Repeating `pitr recover --yes`
re-verifies a fenced directory or finishes an already committed release; a
failed final sync does not require manual edits. The retained verification
receipt is metadata, not an active fence, and never authorizes automatic cleanup.

Inspect the fence and preserve the failed restore's diagnostics:

```sh
nelcota -C /opt/nelcota -p shop pitr status
# Native service diagnostics:
sudo journalctl -u postgresql@17-main -u nelcota-shop -n 60 --no-pager
```

If native recovery refuses an older installed app binary, keep services stopped
and install your already verified matching artifact atomically before retrying.
Do not replace it with an unverified download:

```sh
sudo install -m 0755 /path/to/verified/nelcota /usr/local/lib/nelcota/nelcota.pitr-new
sudo mv /usr/local/lib/nelcota/nelcota.pitr-new /usr/local/lib/nelcota/nelcota
```

When files may have been replaced or WAL recovery was interrupted, retry a
restore with a target covered by the archive. This explicit operation keeps
ordinary starts fenced while a temporary recovery-only PostgreSQL instance
replays WAL, without a TCP listener or autostart. Only verified promotion and
a stopped recovery instance release the fence:

```sh
sudo nelcota -C /opt/nelcota -p shop pitr restore --time "2026-10-07 14:30:00+00" --yes
```

To intentionally retain the current directory, first establish from the error
and backup history that retaining it is appropriate. Then run verification:

```sh
sudo nelcota -C /opt/nelcota -p shop pitr recover --yes
sudo nelcota -C /opt/nelcota -p shop up
nelcota -C /opt/nelcota -p shop status
```

`recover` stops any owned leftover recovery instance, requires a cleanly stopped
PG17 directory without recovery signals or a backup label, verifies the control
file and enabled page checksums, then checks heaps, TOAST and B-tree indexes
with `pg_amcheck` using at most two parallel workers. It can install the missing `amcheck`
extension in `pg_catalog`. This temporary PostgreSQL instance has no TCP
listener and cannot autostart; ordinary services remain blocked. After a clean
stop, the offline checks run again before the fence is durably cleared.
`--yes` skips the question, never verification. Failed checks retain the fence;
use a covered restore instead of removing it manually.

These checks cannot prove application-level correctness, preservation of every
acknowledged write or byte identity when checksums were disabled. Reconcile
data with your verified backup/history. After starting, verify an authorized
read, another user's RLS isolation, anonymous rejection and a private-file 404
before reopening external traffic. Recovery checks do not replace an off-host
restore rehearsal or paired file recovery.

## Troubleshooting

A missing offsite destination fails `--upload`; a partially configured bucket
also fails rather than silently skipping transfer. Check available space,
provider permissions/TLS and the full dump/files pair. On failed recovery, keep
maintenance and private diagnostics intact and inspect the selected runtime;
do not discard the safety backup. Use a disposable host to rehearse recovery.

Related: [deploy](deploy.md), [storage](storage.md), [leaving](leaving.md). Controlled-update recovery has a separate repository
guide at `docs/panel-updates.md`.
