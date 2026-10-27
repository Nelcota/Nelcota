# Update an existing host

Update the CLI and deployed projects in one flow. The updater downloads one
selected official stable release, verifies its SHA-256 and executable version,
prints the CLI and project version changes and asks for confirmation. It then
preserves the old CLI and invokes the existing project upgrade command, which
enters maintenance, captures a paired database/file backup and checks health.
Projects are processed one at a time.

## Availability

The `update` command ships with CLI releases after 0.5.6. With such a CLI
installed:

```sh
sudo nelcota update
```

For an older CLI, the installer on `main` provides the same flow, without
requiring the old CLI to recognize a new command:

```sh
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sudo sh -s -- --update
```

The installer defaults to `/opt/nelcota`; `NELCOTA_ROOT` or `--dir` selects
another host. The CLI uses a host in the current directory when present,
otherwise `/opt/nelcota`; explicit `-C` and `NELCOTA_ROOT` take precedence.
Linux and root access are required. Update mode does not install packages or
Docker, initialize projects, change the firewall, or provision swap.

## Select and preview

```sh
# Download, verify and preview without replacing the CLI or updating projects.
sudo nelcota update --dry-run

# One project on a host outside /opt/nelcota.
sudo nelcota -C /srv/nelcota -p shop update

# Pin an exact stable release and accept the plan for automation.
sudo nelcota update --version 0.5.6 --yes

# Equivalent options for the installer used with an older CLI.
curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sudo sh -s -- \
  --update --dir /srv/nelcota --project shop --version 0.5.6 --dry-run
```

Without a project selection, all projects are selected. Without `--version`,
the latest release is resolved once so every step uses the same version.
CLI or project downgrades, prerelease targets and unknown project versions
are refused. Use the existing explicit `upgrade` workflow for operator-reviewed
changes outside this scope. A failed preview, invalid binary/checksum or a
declined confirmation leaves the installed CLI and project versions in place.
Without a terminal, applying changes requires `--yes`; preview never needs it.
The candidate CLI may acquire the host lease and inspect deployment journals
during preview, so this is not a filesystem-wide read-only operation.

## Backup and failure handling

Keep verified offsite backups and the project's recovery configuration before
updating production; follow [backup and restore](backup.md). The updater reuses
the upgrade's paired backup rather than making a second identical backup.
The previous CLI is kept as `nelcota.previous` in its installation folder.
An already-current project is skipped by the existing upgrade command.

If a candidate project fails health validation, the existing upgrade attempts
to restore its previous runtime, database and paired disk snapshot. Interrupted
or failed recovery can leave maintenance closed and requires SSH inspection;
see [deployment recovery](deploy.md#upgrade). The updater exits with an error
when a project fails and keeps the new CLI installed for inspection/recovery.
The final status is printed only after the project upgrades succeed.

## Hosts with an update controller

The shortcut refuses a host with `updates-controller.json` before downloading
or replacing its CLI. Update enrolled projects through the controller panel;
replace the controller separately over SSH using
[the controlled update guide](panel-updates.md). The shortcut never passes
`--without-controller` or replaces the controller/application executable.
