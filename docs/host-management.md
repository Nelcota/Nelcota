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

## Routine server operations (unreleased)

The source after 0.5.1 extends the same journal/lease to application restart, SMTP/OAuth configuration, external backups, daily schedule/local retention and panel-administrator password changes. These controls require a matching reviewed CLI/controller release; they are not present in published 0.5.1. No terminal, arbitrary command, Docker socket or root password is exposed to the browser.

Add `service_hosts` to the initial root-owned host-management grant for SMTP and S3 destinations, for example `"service_hosts": ["smtp.example.com", "s3.example.com"]`. The default is empty. Entries are exact lowercase DNS hostnames, not wildcards or IP literals. Preparing and executing the relevant changes rechecks this grant. Existing enrollments need one explicit SSH policy update and worker restart; project sessions cannot grant these permissions.

Every change has an immutable, secret-free public plan and receipt. New credential values are kept only in worker memory until confirmation, then in a root-private `configuration.private.json` under the owned job directory. It includes before/after configuration needed for interrupted recovery; protect it like `.env` and archive only completed history. Configuration plans are bounded to 4 MiB. Multiline values, literal single quotes and backslashes are refused rather than reinterpreted; percent-encode such characters inside provider URLs. Blank credential fields preserve the existing value. Disabling a section removes its controlled keys.

SMTP requires `smtps://` or mandatory STARTTLS, a sender and an HTTPS application recovery page. Test email goes only to the enrolled operator; transport acceptance does not certify inbox delivery, and explicit recovery of an uncertain test can resend it. Google/GitHub return pages are shared by the project; verify real provider login separately. The callback remains `https://<project-domain>/auth/v1/callback`.

Review lists every affected project. Shared administrator-password changes update the host and all project hashes under the same lease and recreate the affected applications. Other SMTP/OAuth changes restart only their selected application. S3 destination and cron changes do not restart applications. Existing maintenance/PITR fences, identity changes and unsupported layouts block new routine actions.

Configuration execution persists its effects and recovery decision. Failed startup attempts restore only configuration and verify the previous application state; they never rewind database writes. A cut during rollback resumes rollback even if the interrupted stage was verification. A cut after successful verification reconciles the result without recreating the application again. Successful rollback has its own terminal result, distinct from a successful change. Foreign configuration edits are preserved and require operator attention.

External backup copies verify encrypted configuration plus dump/files after download, with reserve for three times the estimated database/file bytes plus the existing host buffer. The destination test uses a unique probe object and removes it; it never deletes backup history. Daily retention is local and keeps 1–365 copies. Readback evidence is not the off-host restore acceptance required to enable updates. All existing update gates and minimum reserves remain in force.

## Operational alerts (unreleased)

**Server → Alerts** adds host-wide application/database/HTTPS health, disk,
certificate-expiry and successful-backup monitoring. Enrolled host operators
configure email and HTTPS webhook channels, review changes and explicitly test
delivery. SMTP comes from a pinned registered project; recipients are enrolled
host operators. Provider names require the existing `service_hosts` grant.
Secret endpoint URLs never return to the browser. A matching upgraded backup CLI
must produce successful-outcome receipts; partial dump mtimes do not count.

A total VPS/worker/network outage requires an independent heartbeat monitor.
Configure and rehearse that external provider separately. See
[operational alerts](operational-alerts.md) for thresholds, confirmation,
retries, payloads, activation and limitations. These controls are not in published
0.5.1 and do not complete the separate update-installation acceptance.

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
image extension. Routine-operation coverage injects eleven configuration failure
scenarios, including a second interruption during rollback, and checks shared
credential consistency, both projects' acknowledged data, restart recovery,
manual configuration drift and secret-free receipts. Browser tests cover visual
approval, blockers and lost responses.
These tests do not certify a production VPS, actual abrupt power loss, native
systemd deployment or off-host recovery. Rehearse those on the selected host and
exact official controller/image before production use.

Related: [deploy](deploy.md), [backup](backup.md), [security model](security/README.md)
and the separately gated [update controller](panel-updates.md).
