# Host project management

The separately authenticated host controller manages isolated Docker projects.
It uses the same Rust binary and project/runtime adapters as the CLI. Each new
project receives its own PostgreSQL cluster, signing keys, users, disk files,
migrations and project panel. The project panel links to the controller; project
cookies, SSO and service-role tokens never grant host authority.

This capability is included in published server **0.5.0**. Production enrollment
requires the matching official controller release and host-specific acceptance.
Use source builds for disposable validation; source and release artifacts are
identified separately.

## Explicit operator enrollment

Initialize the host and its first project through SSH using the deploy guide.
Use a dedicated public HTTPS controller origin, native attestation verifier and
private operator-password file as described in `docs/panel-updates.md`.

Host creation authority is an additional SSH grant. Prepare a root-owned JSON
file, mode 0600, approving one official release image, its source commit, domain
scope, VPS addresses and maximum concurrent projects. This is a shape; replace
every placeholder with reviewed release/host values:

```json
{
  "version": "RELEASE_VERSION",
  "image_digest": "64_LOWERCASE_HEX_CHARACTERS_FROM_THE_OFFICIAL_IMAGE",
  "source_sha": "40_LOWERCASE_HEX_CHARACTERS_FROM_THE_RELEASE_COMMIT",
  "max_projects": 32,
  "domain_suffixes": ["apps.example.com"],
  "addresses": ["YOUR_PUBLIC_VPS_IP"]
}
```

Pass this file on the initial enrollment:

```sh
sudo nelcota -C /opt/nelcota updates enroll \
  --origin https://control.example.com \
  --email operator@example.com \
  --password-file /safe/operator-password \
  --verifier /usr/local/bin/gh \
  --projects first \
  --host-management /safe/host-management.json
```

An already enrolled host requires an explicit SSH policy change: copy these
values into `host_management`, set `manage_host: true` only on the designated
operator, and restart the worker. Policy changes revoke existing sessions and
reviews. Keep `enable_installation` and update acceptance settings unchanged:
project creation authority does not complete the separate update acceptance.

V1 creation supports Docker, shared project-panel login and disk storage.
Root control files must retain their trusted ownership and permissions.
Per-project panel credentials, S3 application storage, PITR or custom Compose
layouts require their CLI/recovery workflows; the interface reports blockers.
PostgreSQL profiles estimate configuration and do not reserve RAM or guarantee
capacity. Measure application/database load before filling the host.

## Visual workflow

Open the host controller from the Projects page and sign in with the enrolled
operator. The Projects tab shows resource counters, project domains, backend/
database health, backup selection, structured log metadata and operation history.

Every operation has a review showing its exact project, domain/backup, approved
version/image, effects, blockers and expiration. Review both acknowledgments,
type the displayed action/project phrase and re-enter the operator password.
Reviews expire after five minutes and are revalidated before acceptance.

Creation checks project/domain collisions (including the controller hostname at
any port), reserved Docker containers/volumes/networks, domain scope, DNS addresses, disk
reserve, estimated RAM share and project count. It verifies image provenance,
pins immutable image bytes, starts the isolated services, publishes the project
and verifies public HTTPS. Failed partial provisioning remains inspectable;
it never erases an existing folder to retry automatically.

Backup captures and verifies a consistent database/disk-file pair. It is a local
copy; configure and test off-host backups separately. Restore validates the
selected pair, enters maintenance and captures the current state first. Once
the restored state reaches verification, recovery preserves any later writes
and never automatically replays the earlier snapshot. Before that checkpoint,
recovery revalidates the preserved safety pair and refuses destructive work if
it is missing or corrupt.

Removal enters maintenance, stops application writes and verifies a final paired
backup in `archive/` before deleting database volumes. Configuration and disk
files remain in a private retired-project directory. Only the selected project
leaves the host registry/proxy; other projects remain running. A recreated name
gets a new identity and never inherits a scoped operator's former authority.

## Disconnects and recovery

The VPS owns accepted work. Closing or reloading the page does not cancel it.
The browser stores only a per-operator request identifier in session storage,
never the password. Uncertain responses are reconciled with durable receipts;
retrying the same identifier returns the same job. Mutations are never retried
automatically. Concurrent CLI, update and management mutations use one host
lease and refuse unresolved operations.

Interrupted jobs require operator attention. The UI shows the last recorded
stage and offers a separately confirmed recovery. SSH diagnostics remain useful:

```sh
sudo nelcota -C /opt/nelcota updates host-status
sudo nelcota -C /opt/nelcota updates host-recover --job OPERATION_ID
sudo journalctl -u nelcota-updates-worker -u nelcota-updates-controller
```

Private receipts/logs are under `<host>/updates/host-jobs/<id>/`. The browser
receives bounded structured event metadata; free-form application messages,
SQL, credentials and command output stay private. Preserve incomplete receipts,
safety/final backups and retired configuration. Archive only completed history
before reaching the bounded 255-job journal limit. Inventory remains readable
when a partial removal has already moved a project directory; an incomplete
recreation of a retired name can restart under its durable receipt. Temporary
host-lease contention delays reconciliation and never retries mutations.

## Validation limits

`scripts/test-host-management.py` runs owned Docker projects and real PostgreSQL,
file snapshots, restore, post-verification recovery, missing safety backups, partial removal/recreation,
worker-policy reload, Docker volume collisions and removal. It uses explicit
doubles for DNS/image provenance, public TLS, proxy reload and the unused PITR
image extension. Browser tests cover visual approval, blockers and lost responses.
These tests do not certify a production VPS, actual abrupt power loss, native
systemd deployment or off-host recovery. Rehearse those on the selected host and
exact official controller/image before production use.

Related: [deploy](deploy.md), [backup](backup.md), [security model](security/README.md)
and the separately gated [update controller](panel-updates.md).
