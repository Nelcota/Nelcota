# Controlled panel updates

The update controller and worker ship in the same Rust binary as the API. They
run as separate host processes. The controller serves the embedded panel on a
separate HTTPS origin; it remains reachable while a project is in maintenance.
No Node service, Docker socket in the application, or privileged project cookie
is involved. Node is used only to build the existing frontend.

The controller is included in published server 0.5.0. Installation is disabled
after enrollment. Local tests do not constitute VPS acceptance: retain evidence
for the exact installed controller binary and complete every gate below before
enabling installation.

## Enrollment over SSH

Use a verified official release on a Linux VPS with systemd, an official-image
host registry and a separate public DNS hostname, for example
`updates.example.com`. Its DNS must resolve to the VPS. Existing project domains
cannot be reused. Keep SSH available throughout updates and recovery.

The host metadata, project directories, `.env` files and all ancestors must be
root-owned without group/other write permission. Application storage keeps its
existing service ownership; do not recursively change storage ownership. The
native GitHub CLI must be root-owned and checksum-verified against its official
release; it must support `attestation verify`, `--bundle`, `--source-digest` and
`--source-ref`. systemd hosts also need AWS CLI v2 for offsite backups. Docker
hosts use the existing AWS CLI container transport.

Prepare a private operator-password file on the VPS (mode 0600, at least 16
characters). Supply its path, never a password argument or shell-history value:

```sh
sudo nelcota -C /opt/nelcota updates enroll \
  --origin https://updates.example.com \
  --email operator@example.com \
  --password-file /root/nelcota-update-password \
  --verifier /usr/local/bin/gh \
  --projects shop,blog
```

Enrollment installs `nelcota-updates-worker.service` as root and
`nelcota-updates-controller.service` as the dedicated `nelcota-updates` user.
Their binary is separate from the project's deployed executable. It writes a
root-owned policy, scoped project identity receipts, a public controller link,
proxy routing and Unix socket mounts. It checks compose layouts before editing
known image/mount entries. Native gates live in a root-owned, readable
`/var/lib/nelcota-deployment-gates/` directory so the dynamic app user does not
need access to private host metadata. A custom layout requires operator review; it is not
silently replaced. DNS/HTTPS, service startup and the root-owned files must be
checked on the real host before enabling installation. Enrollment records a
private pending plan before creating its account or installing files. After a
failure, rerun the same command with the original host, project scope, verifier
and credentials. The retry preserves project identities and the password hash,
accepts only the expected compose changes and refuses an altered policy.
Inspect failures from older binaries without this receipt over SSH.

Native enrollment and every update preflight require the canonical project unit,
no systemd drop-ins and no pending daemon reload. Overrides can change the actual
database or environment without changing the project's `.env`; they therefore
require separate operator review. Preparation also verifies that the active
native PID uses the installed executable before capturing its recovery identity.

Open `/admin/updates` in a project panel or go directly to
`https://updates.example.com/admin/`. Sign in with the enrolled operator.
Project-admin, SSO, bearer and service-role credentials do not grant deployment
authority. Each operator sees only its explicitly enrolled projects and history.
A project removed and recreated under the same name needs a fresh identity and
policy enrollment; it does not inherit authority from its name.

Remove the initial password file after confirming the operator login. To revoke
or rotate credentials, change `/etc/nelcota-updates/policy.json` over SSH and
restart the worker. A changed policy immediately invalidates old requests;
worker restart also invalidates its in-memory sessions and plans. The controller
never edits this policy. Do not edit deployment metadata or invoke Docker/
systemd operations outside the CLI while an operation is active.

## Release trust and readiness

Only stable releases from `Nelcota/Nelcota` are discovered. HTTPS redirects,
filenames, sizes, versions, architectures, source revisions and protocol shapes
are bounded. The worker verifies SHA-256 plus Sigstore/GitHub provenance using
native `gh`, the official release workflow, exact source SHA and tag ref, and
rejects self-hosted attestations. Published binary, manifest and OCI attestation
bundles are fetched from fixed release asset paths; no GitHub personal token is
required for bundle-based verification. The verifier still needs its trusted
roots and public registry connectivity. TLS/signature failures block preparation.

The release workflow publishes readiness only after both Linux musl binaries,
the OCI index and their provenance exist, and the latest main CI run for the
exact source has completed successfully. It signs `update-manifest.json`, which
binds binary hashes/sizes, OCI digest, internal migration version, CI run and
minimum application/controller/protocol versions. Workflow-dispatch republishing
does not create a tag-bound readiness receipt. A partial or changed release,
downgrade, prerelease, unknown protocol or incompatible controller cannot install.
Checking a release never starts maintenance or updates a project.

## Enablement and acceptance evidence

Keep `enable_installation: false` until the G03 acceptance matrix has been
executed with the exact installed controller binary and retained evidence. The
worker requires a root-owned private report whose `binary_sha256` matches that
binary, `schema` is 1, `status` is `passed`, and whose `checks` object sets every
following key to `true`:

| Report check | Required evidence |
|---|---|
| `docker_upgrade`, `docker_rollback` | Actual Docker services, seeded DB/files/credentials, upgrade and forced precommit failure |
| `systemd_upgrade`, `systemd_rollback` | Actual systemd services and the same continuity/rollback checks |
| `worker_crash` | Kill the worker at each journal/effect boundary, restart and recover via SSH/UI |
| `power_loss` | Abrupt disposable-VM power loss, durable journal/maintenance/gate and recovery proof |
| `provenance` | Real release bundles plus rejected checksum, source/ref/signer and partial-release cases |
| `browser_reconnect` | Browser close/reload, lost response, idempotent retry and recovery during app downtime |
| `offsite_restore` | Restore the downloaded DB/files/configuration on a separate disposable host |

Record OS/architecture, Postgres version, source/release/binary identity, commands,
results, RPO/RTO and evidence locations. Keep failing, skipped and unrun checks
separate. This report is a root operator attestation backed by retained evidence;
a boolean template is not a substitute for running the checks. Set its absolute
path in `validation_report` and enable installation only after all gates pass.
There is no HTTP bypass. Each architecture requires evidence for its own binary.

V1 blocks project S3 storage, PITR, external/custom database layouts and custom
images. Ordinary disk storage with local per-project Postgres 17 is the supported
model after acceptance. Offsite backups require HTTPS, readback verification of
the exact dump/file manifest/bytes, and encrypted configuration upload (SSE
AES256). Backups must fit alongside restoration and artifact space; preflight
reserves three times the measured database/file size plus the configured buffer.

## Operation and recovery

Prepare a five-minute plan, inspect target/digest/requirements and confirm the
operator password again. Installation rechecks the configuration and manifest
identities. A durable idempotency key binds retries to the accepted operation.
There is one mutation lease per host; ordinary CLI mutations use the same lease
and refuse unresolved jobs. On enrolled hosts, legacy `upgrade` requires
`--without-controller`. It still refuses projects carrying controller-written
`.env` keys (`NELCOTA_APP_IMAGE`, `NELCOTA_DEPLOYMENT_*`), so it cannot override a
pinned image, and refuses to run from the controller's own binary. It keeps the
controller route in the proxy configuration.

The worker prepares verified artifacts, persists previous runtime/configuration
identities, closes and syncs maintenance, stops the app and checks that its DB
connections are gone. It captures the paired snapshot, validates the dump and
file manifest, refuses source/destination symlink traversal using directory
handles, reads the offsite backup back and records the identities before
activation. The candidate blocks all application routes except `/health` and
pauses webhook dispatch, auth pruning and file collection while validating.
Health, executable/image identity (including the running native PID) and internal migration version are checked.
Only a durable commit decision may release a gate bound to
that candidate's operation ID. Application-route readiness is then checked before
reopening the proxy. An older/cancelled candidate cannot reuse another
operation's commit signal. The UI uses phase/sequence receipts; percentages do
not pretend to estimate remaining migration time.

Before commit, a failure can restore the verified paired snapshot, previous
configuration and exact previous binary/image. Before restarting the restored
version, the journal records a second irreversible boundary: background work
may write data even before public traffic opens. Failure after either boundary
preserves current data; it never automatically restores an earlier snapshot.
A failed/uncertain restore leaves maintenance closed. Worker/job crashes become
`needs_operator`; journal corruption never becomes guessed success.
Recovery error handling reloads the authoritative receipt, including when rename
succeeded before fsync reported an error. Older/conflicting sequences cannot
overwrite newer receipts, revoke either irreversible decision or reopen a
completed job.

A failure before the snapshot exists resumes the unchanged previous application
and ends as `failed_before_change`. Repeated recovery failures or timeouts retain
the original phase, so they cannot turn this case into a missing-snapshot loop.
Unrelated files in the jobs directory are ignored; malformed job receipts still
block mutations until inspected.

The browser polls with a single request loop, bounded backoff and stale-sequence
protection. Closing the page cancels only browser requests. Mutating requests
are not automatically retried. On a lost response, inspect the journal through
the panel; an explicit retry with the same key returns the accepted job.

For SSH inspection and recovery:

```sh
sudo /usr/local/lib/nelcota-updates/nelcota updates status
sudo /usr/local/lib/nelcota-updates/nelcota updates recover --job OPERATION_ID
sudo journalctl -u nelcota-updates-worker -u nelcota-updates-controller
```

If a committed candidate cannot become ready, ordinary recovery keeps trying to
resume it. A root operator can explicitly choose the verified pre-update snapshot
instead. This discards database/file changes made after that snapshot, including
background work after commit. Inspect the job and backup before choosing it:

```sh
sudo /usr/local/lib/nelcota-updates/nelcota updates recover \
  --job OPERATION_ID --restore-snapshot
```

This option is restricted to interrupted committed jobs whose previous version
has not resumed. It records the operator's decision before restoring anything;
after another interruption, ordinary `recover` continues that recorded decision.
The HTTP controller never chooses this data-loss recovery path. Preserve the
receipt; do not remove it to bypass the host lease.

Job state and private runtime diagnostics are under `<host>/updates/jobs/`.
HTTP responses contain safe phase/error codes, not logs, credentials, dump paths
or command output. Preserve incomplete jobs, their paired backups, previous
configuration and images/binaries. Normal backup retention cannot run under an
active/unresolved deployment lease. The bounded journal admits at most 255 jobs;
archive completed history over SSH after reviewing retention needs. Do not delete
incomplete receipts to clear a blocked host.

Controller replacement is a separate SSH procedure: require no incomplete jobs,
stop both update services, verify the new official controller and native verifier,
replace their installed files atomically, invalidate/re-run the exact-binary
acceptance report, and restart/recheck both services and HTTPS. Application jobs
never update their own controller. Do not use an ordinary application rollback
as controller replacement or incident/PITR recovery.
