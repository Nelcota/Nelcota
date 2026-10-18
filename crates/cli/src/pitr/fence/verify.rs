//! Offline verification is deliberately restricted to a clean, unrecovering
//! PG17 directory. Unknown/interrupted WAL replay requires a covered restore.
use crate::{
    host::Runtime,
    native,
    project::{Project, run},
};
use anyhow::{Context, bail};

fn location(project: &Project) -> (&'static str, &'static str, &'static str) {
    match project.runtime {
        Runtime::Systemd => (
            native::PG_DATA,
            "/usr/lib/postgresql/17/bin/pg_controldata",
            "/usr/lib/postgresql/17/bin/pg_checksums",
        ),
        Runtime::Docker => ("/var/lib/postgresql/data", "pg_controldata", "pg_checksums"),
    }
}

pub(super) fn clean_directory(project: &Project) -> anyhow::Result<()> {
    let (data, control, checksums) = location(project);
    let script = "set -eu; test \"$(cat \"$1/PG_VERSION\")\" = 17; for file in postmaster.pid recovery.signal standby.signal backup_label; do test ! -e \"$1/$file\"; test ! -L \"$1/$file\"; done";
    run(
        &mut project.as_postgres_offline(&["/bin/sh", "-ec", script, "--", data]),
        "offline PG17 directory checks (requires no server, recovery signal or backup label)",
    )?;
    let output = project
        .as_postgres_offline(&["env", "LC_ALL=C", control, data])
        .output()
        .context("could not inspect PostgreSQL control file")?;
    if !output.status.success() || output.stdout.len() > 16384 || !output.stderr.is_empty() {
        bail!(
            "PostgreSQL control verification failed; keep the PITR fence and retry a covered restore"
        );
    }
    let version = clean_control(&String::from_utf8(output.stdout)?)?;
    if version == 1 {
        run(
            &mut project.as_postgres_offline(&[checksums, "--check", "-D", data]),
            "offline PostgreSQL page checksums",
        )?;
    }
    if version == 0 {
        crate::util::warn(
            "page checksums are disabled: heap/TOAST/B-tree checks still run, but cannot establish byte-level identity or application-level correctness",
        );
    }
    Ok(())
}

fn clean_control(text: &str) -> anyhow::Result<u8> {
    let value = |key: &str| {
        let values: Vec<_> = text
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| *name == key)
            .map(|(_, value)| value.trim())
            .collect();
        match values.as_slice() {
            [value] => Some(*value),
            _ => None,
        }
    };
    if value("Database cluster state") != Some("shut down") {
        bail!(
            "data directory is not cleanly shut down; PITR fence retained. Retry `pitr restore` with a covered target"
        );
    }
    match value("Data page checksum version") {
        Some("0") => Ok(0),
        Some("1") => Ok(1),
        _ => bail!("invalid/unsupported PostgreSQL checksum metadata; PITR fence retained"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unclean_ambiguous_and_nonfinite_control_cannot_release_fence() {
        for text in [
            "",
            "Database cluster state: in production\nData page checksum version: 0\n",
            "Database cluster state: in archive recovery\nData page checksum version: 1\n",
            "Database cluster state: shut down\nData page checksum version: NaN\n",
            "Database cluster state: shut down\nDatabase cluster state: shut down\nData page checksum version: 1\n",
        ] {
            assert!(clean_control(text).is_err());
        }
        for version in [0, 1] {
            assert_eq!(
                clean_control(&format!(
                    "Database cluster state: shut down\nData page checksum version: {version}\n"
                ))
                .unwrap(),
                version
            );
        }
    }
}
