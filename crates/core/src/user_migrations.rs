//! Application migrations shared by local CLI and authenticated remote deployment.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tokio_postgres::{Client, GenericClient};

pub const TABLE: &str = "nelcota.user_migrations";
pub const LOCK: &str = "SELECT pg_advisory_xact_lock(hashtext('nelcota.user_migrations'))";
const CREATE: &str = "CREATE TABLE IF NOT EXISTS nelcota.user_migrations (
    version INT4 PRIMARY KEY, name VARCHAR(255), applied_on VARCHAR(255), checksum VARCHAR(255))";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationFile {
    pub filename: String,
    pub sql: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationRequest {
    pub files: Vec<MigrationFile>,
    #[serde(default)]
    pub dry_run: bool,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("migration history diverged; inspect migrate status before applying")]
    Diverged,
    #[error("production migrations require a configured automatic backup agent")]
    BackupRequired,
    #[error(
        "automatic migration backup is unavailable or interrupted; inspect migration status before retrying"
    )]
    BackupFailed,
    #[error("backup agent disconnected during SQL; inspect migration status before retrying")]
    BackupInterrupted,
    #[error("another protected migration deployment is running")]
    Busy,
    #[error(transparent)]
    Database(#[from] tokio_postgres::Error),
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationState {
    Applied,
    Pending,
    Diverged,
    Missing,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MigrationStatus {
    pub version: i32,
    pub name: String,
    pub checksum: String,
    pub applied_on: Option<String>,
    pub state: MigrationState,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MigrationReport {
    pub migrations: Vec<MigrationStatus>,
    pub applied: Vec<i32>,
    pub dry_run: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub backup: Option<String>,
}

fn parse(files: &[MigrationFile]) -> Result<BTreeMap<i32, refinery::Migration>, Error> {
    if files.len() > 1024 {
        return Err(Error::Invalid(
            "at most 1024 migration files per request".into(),
        ));
    }
    let mut migrations = BTreeMap::new();
    for file in files {
        if file.filename.contains(['/', '\\', '\0'])
            || file.filename.len() > 255
            || !file.filename.starts_with('V')
        {
            return Err(Error::Invalid(
                "use V<n>__<name>.sql filenames without paths".into(),
            ));
        }
        let stem = file
            .filename
            .strip_suffix(".sql")
            .ok_or_else(|| Error::Invalid("migration files must end in .sql".into()))?;
        let sql = file.sql.replace("\r\n", "\n");
        let migration = refinery::Migration::unapplied(stem, &sql).map_err(|_| {
            Error::Invalid(format!("invalid migration filename: {}", file.filename))
        })?;
        if migration.version() < 1 {
            return Err(Error::Invalid("migration versions must be positive".into()));
        }
        if migrations.insert(migration.version(), migration).is_some() {
            return Err(Error::Invalid("duplicate migration version".into()));
        }
    }
    Ok(migrations)
}

async fn history(client: &impl GenericClient) -> Result<BTreeMap<i32, MigrationStatus>, Error> {
    let exists: bool = client
        .query_one(
            "SELECT to_regclass('nelcota.user_migrations') IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    if !exists {
        return Ok(BTreeMap::new());
    }
    let rows = client.query("SELECT version, coalesce(name, ''), checksum, applied_on FROM nelcota.user_migrations ORDER BY version", &[]).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let version = row.get(0);
            (
                version,
                MigrationStatus {
                    version,
                    name: row.get(1),
                    checksum: row.get(2),
                    applied_on: row.get(3),
                    state: MigrationState::Applied,
                },
            )
        })
        .collect())
}

fn reconcile(
    mut history: BTreeMap<i32, MigrationStatus>,
    files: &BTreeMap<i32, refinery::Migration>,
) -> Vec<MigrationStatus> {
    let max_applied = history.keys().next_back().copied().unwrap_or(0);
    for row in history.values_mut() {
        row.state = match files.get(&row.version) {
            Some(file)
                if file.name() == row.name && file.checksum().to_string() == row.checksum =>
            {
                MigrationState::Applied
            }
            Some(_) => MigrationState::Diverged,
            None => MigrationState::Missing,
        };
    }
    for (version, file) in files {
        history.entry(*version).or_insert_with(|| MigrationStatus {
            version: *version,
            name: file.name().into(),
            checksum: file.checksum().to_string(),
            applied_on: None,
            state: match *version > max_applied {
                true => MigrationState::Pending,
                false => MigrationState::Diverged,
            },
        });
    }
    history.into_values().collect()
}

pub async fn status(
    client: &impl GenericClient,
    files: &[MigrationFile],
) -> Result<Vec<MigrationStatus>, Error> {
    Ok(reconcile(history(client).await?, &parse(files)?))
}

/// Apply forward-only files in version order. Each file and audit row commit together.
/// A transaction-scoped lock is released by rollback/cancellation and never leaks into a pool.
pub async fn apply(
    client: &mut Client,
    request: &MigrationRequest,
    actor: &str,
) -> Result<MigrationReport, Error> {
    let files = parse(&request.files)?;
    let mut applied = Vec::new();
    for (version, migration) in &files {
        let tx = client.transaction().await?;
        tx.batch_execute("SET LOCAL lock_timeout = '30s'; SET LOCAL statement_timeout = '120s'")
            .await?;
        tx.batch_execute(LOCK).await?;
        let statuses = reconcile(history(&tx).await?, &files);
        if statuses.iter().any(|row| {
            matches!(
                row.state,
                MigrationState::Diverged | MigrationState::Missing
            )
        }) {
            return Err(Error::Diverged);
        }
        let pending = statuses
            .iter()
            .any(|row| row.version == *version && row.state == MigrationState::Pending);
        if request.dry_run || !pending {
            tx.rollback().await?;
            continue;
        }
        tx.batch_execute("CREATE SCHEMA IF NOT EXISTS nelcota")
            .await?;
        tx.batch_execute(CREATE).await?;
        // PostgreSQL forbids transaction control within a function call. Run
        // the bound migration script through SPI so COMMIT cannot escape the
        // file's transaction (including inside a called procedure).
        tx.batch_execute("CREATE OR REPLACE FUNCTION pg_temp.nelcota_apply_migration(script text) RETURNS void LANGUAGE plpgsql AS 'BEGIN EXECUTE script; END'").await?;
        tx.query_one(
            "SELECT pg_temp.nelcota_apply_migration($1)",
            &[&migration.sql().unwrap_or_default()],
        )
        .await?;
        tx.batch_execute("DROP FUNCTION pg_temp.nelcota_apply_migration(text)")
            .await?;
        let checksum = migration.checksum().to_string();
        tx.execute("INSERT INTO nelcota.user_migrations (version, name, applied_on, checksum) VALUES ($1, $2, to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), $3)", &[version, &migration.name(), &checksum]).await?;
        tx.execute("INSERT INTO nelcota.migration_audit (version, name, checksum, actor) VALUES ($1, $2, $3, $4)", &[version, &migration.name(), &checksum, &actor]).await?;
        tx.batch_execute("NOTIFY nelcota, 'reload schema'").await?;
        tx.commit().await?;
        applied.push(*version);
    }
    let migrations = reconcile(history(client).await?, &files);
    if migrations.iter().any(|row| {
        matches!(
            row.state,
            MigrationState::Diverged | MigrationState::Missing
        )
    }) {
        return Err(Error::Diverged);
    }
    Ok(MigrationReport {
        migrations,
        applied,
        backup: None,
        dry_run: request.dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_duplicates_and_nonpositive_versions() {
        for filename in [
            "../V1__bad.sql",
            "V1__bad.sql/extra",
            "V0__bad.sql",
            "U1__bad.sql",
            "V1__bad.txt",
        ] {
            assert!(
                parse(&[MigrationFile {
                    filename: filename.into(),
                    sql: "SELECT 1".into()
                }])
                .is_err()
            );
        }
        let file = MigrationFile {
            filename: "V1__ok.sql".into(),
            sql: "SELECT 1;\r\n".into(),
        };
        assert!(parse(&[file.clone(), file]).is_err());
    }
}
