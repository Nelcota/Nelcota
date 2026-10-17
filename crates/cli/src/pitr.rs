//! Point-in-time recovery with pgBackRest: Postgres archives every WAL segment
//! to the host's S3-compatible storage, next to periodic base backups, so a
//! project can be restored to any second covered by the archive (not only to
//! the last nightly dump).
//!
//! pgBackRest runs next to Postgres as the postgres user. On Docker hosts it
//! lives in the project's Postgres image (`postgres/Dockerfile` adds it to
//! postgres:17-alpine) and reads its settings as `PGBACKREST_*` variables
//! from `pgbackrest.env`; on systemd hosts it comes from the PGDG packages and
//! reads the same settings from `/etc/pgbackrest/pgbackrest.conf`. Either way
//! `pgbackrest.env` (mode 600, it holds the S3 keys) existing is what "PITR
//! enabled" means for a project.

mod commands;
mod config;
mod restore;
pub use config::{enabled, write_dockerfile};
pub use restore::restore;

use crate::{
    host::Host,
    project::{Project, Service},
    util::{ok, step},
};
use anyhow::{Context, bail};
use commands::{pgbackrest, psql};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
const ARCHIVE_COMMAND: &str = "pgbackrest --stanza=main archive-push %p";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);

/// Turns WAL archiving on and takes the first full backup.
pub fn enable(host: &Host, project: &Project) -> anyhow::Result<()> {
    config::prepare(host, project)?;
    project.wait_healthy(Service::Postgres, HEALTH_TIMEOUT)?;
    pgbackrest(project, &["stanza-create"]).context("could not create the repository in S3")?;

    step("Archiving WAL");
    psql(
        project,
        &[
            "ALTER SYSTEM SET archive_mode = on",
            &format!("ALTER SYSTEM SET archive_command = '{ARCHIVE_COMMAND}'"),
            // An idle database still ships its last writes within a minute.
            "ALTER SYSTEM SET archive_timeout = '60s'",
        ],
    )?;
    project.recreate(Service::Postgres)?;
    project.wait_healthy(Service::Postgres, HEALTH_TIMEOUT)?;
    pgbackrest(project, &["check"]).context("WAL archiving check failed")?;

    step("First full backup");
    pgbackrest(project, &["--type=full", "backup"])?;
    ok(&format!(
        "PITR on: restore any moment from now with `nelcota -p {} pitr restore --time ...`",
        project.name
    ));
    Ok(())
}

/// Stops archiving. The backups already in S3 stay there.
pub fn disable(project: &Project) -> anyhow::Result<()> {
    if !enabled(project) {
        bail!("PITR is not enabled for {}", project.name);
    }
    if project.runtime == crate::host::Runtime::Systemd {
        crate::native::check_backup_configuration()?;
    }
    step(&format!(
        "Disabling point-in-time recovery for {}",
        project.name
    ));
    psql(
        project,
        &[
            "ALTER SYSTEM RESET archive_command",
            "ALTER SYSTEM RESET archive_mode",
            "ALTER SYSTEM RESET archive_timeout",
        ],
    )?;
    config::remove(project)?;
    project.recreate(Service::Postgres)?;
    project.wait_healthy(Service::Postgres, HEALTH_TIMEOUT)?;
    ok("archiving stopped; the backups already in S3 were kept");
    Ok(())
}

/// Backups and the WAL range the archive covers (`pgbackrest info`).
pub fn status(project: &Project) -> anyhow::Result<()> {
    if !enabled(project) {
        println!(
            "PITR is off for {}: nelcota -p {} pitr enable",
            project.name, project.name
        );
        return Ok(());
    }
    pgbackrest(project, &["info"])
}

/// A base backup: full on Sundays, differential (changes since the last
/// full) on the other days. Shorter WAL replays on restore.
pub fn backup(project: &Project) -> anyhow::Result<()> {
    let kind = match weekday_utc() == 0 {
        true => "full",
        false => "diff",
    };
    step(&format!("PITR base backup of {} ({kind})", project.name));
    pgbackrest(project, &[&format!("--type={kind}"), "backup"])?;
    ok("base backup stored in S3");
    Ok(())
}

/// 0 = Sunday.
fn weekday_utc() -> u64 {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() / 86_400);
    // 1970-01-01 was a Thursday.
    (days + 4) % 7
}
