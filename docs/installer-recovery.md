# Recover before retrying VPS installation

The one-command installer needs a working system package manager. A failed
Debian/Ubuntu package operation is not a Nelcota database migration failure.
Installing another Nelcota binary does not repair that operating-system state.
The installer is fetched from `main`, independently of the selected binary
version; verify which script revision you are using.

The current source runs a read-only `dpkg --audit` before APT, debconf, firewall,
swap, binary replacement or project setup. It stops both when the audit fails
and when it reports unfinished/inconsistent packages with exit status zero.
It also rechecks after APT failures. The original diagnostics are retained.
CLI-only installation, `--update` and Fedora/RHEL do not run this Debian-specific
audit. A clean audit is a point-in-time check, not a lock or proof that a later
package download/configuration will succeed.

## First check ongoing operations and disk health

If another APT/dpkg operation or unattended upgrade is running, let it finish.
Do not kill it, delete locks or start simultaneous recovery commands. On a
minimal image, `fuser` may be unavailable; inspect the running package-manager
processes through the operating system's normal tools instead.

The following checks do not repair or remove package state:

```sh
df -h /var/lib/dpkg
df -i /var/lib/dpkg
fuser -v /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend
```

Resolve full disks, exhausted inodes, read-only filesystems or storage errors
first. If the VPS reports filesystem/I/O problems, preserve evidence and involve
the provider or system administrator before changing package metadata.

## Preserve the package database

After other package operations finish, take a private backup before manual
recovery. Run this as root, on a filesystem with enough free space. The `&&`
prevents copying to an unintended path if temporary-directory creation fails:

```sh
backup=$(mktemp -d /root/nelcota-dpkg-recovery.XXXXXX) &&
cp -a /var/lib/dpkg "$backup/dpkg"
```

If that fails, stop; do not continue by deleting journal files to make room.
Keep this backup private. It is system package metadata, not a substitute for
application/database/file backups or a complete operating-system recovery plan.

## Interrupted configuration

For the usual `dpkg was interrupted` condition with readable package metadata,
review the audit report. After the backup and with no other package operation
running, an administrator can finish configuration:

```sh
dpkg --configure -a && dpkg --audit
```

Configuration runs pending packages' maintainer scripts and can restart services;
it is deliberately not performed automatically by the Nelcota installer, even
with `--yes`. If dependencies need repair, review the proposed package changes
with the distribution's tools; do not automatically accept removals or ignore
errors. Retry setup only after the audit exits successfully with no report.

## Unreadable or corrupt package records

An error such as `parsing file '/var/lib/dpkg/updates/0054'` followed by
`end of file after field name` means dpkg could not parse that record. It is not
evidence that the numbered file is safe to discard. The same applies to parse
errors in the main status database.

For that specific example, collect limited read-only evidence:

```sh
ls -l /var/lib/dpkg/updates/0054
od -An -tx1 -N128 /var/lib/dpkg/updates/0054
```

Use the actual filename from your own error. Preserve all records and the
backup; have an administrator assess the damaged record and available status
backups before any targeted recovery. Do not clear the entire `updates`
directory, delete `/var/lib/dpkg/status`, remove lock files, use force options or
keep rerunning configuration after parse failures. The installer will not
quarantine/delete a record or restore a status backup on your behalf.

Once the underlying problem is repaired and `dpkg --audit` succeeds without
output, rerun the original installer command. Preserve any existing host/project
credentials and inspect partial state rather than removing the host directory.
