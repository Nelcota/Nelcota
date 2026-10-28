//! Migration operations; generation commits all tracking records together.
use super::files::{folder_migrations, next_version, parse_filename, render, valid_name};
use crate::{
    ApiError,
    contracts::{ExportedMigration, Migration, MigrationsData, PendingChange},
};
use deadpool_postgres::Pool;
use std::{collections::BTreeMap, path::Path as FsPath};

pub(super) struct MigrationFile {
    pub filename: String,
    pub sql: String,
}

/// Table used by `nelcota migrate` (crates/cli/src/db.rs).
const USER_MIGRATIONS: &str = "nelcota.user_migrations";

/// DDL refinery uses for its control table: created here when the project
/// has never run `migrate`.
const CREATE_USER_MIGRATIONS: &str = "CREATE TABLE IF NOT EXISTS nelcota.user_migrations(
             version INT4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255))";

/// Applied versions (`user_migrations` may not exist yet).
async fn applied(
    client: &tokio_postgres::Client,
) -> Result<BTreeMap<i32, (String, String)>, ApiError> {
    let exists: bool = client
        .query_one("SELECT to_regclass($1) IS NOT NULL", &[&USER_MIGRATIONS])
        .await?
        .get(0);
    if !exists {
        return Ok(BTreeMap::new());
    }
    let rows = client
        .query(
            "SELECT version, coalesce(name, ''), coalesce(applied_on, '') FROM nelcota.user_migrations",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| (r.get(0), (r.get(1), r.get(2))))
        .collect())
}

async fn exported(client: &tokio_postgres::Client) -> Result<BTreeMap<i32, String>, ApiError> {
    let rows = client
        .query(
            "SELECT version, filename FROM nelcota.panel_migrations",
            &[],
        )
        .await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// Lists applied, generated and local migration versions together.
pub(super) async fn list(db: &Pool, dir: Option<&FsPath>) -> Result<MigrationsData, ApiError> {
    let client = db.get().await?;
    let applied = applied(&client).await?;
    let exported = exported(&client).await?;
    let folder = folder_migrations(dir);

    let versions: std::collections::BTreeSet<i32> = applied
        .keys()
        .chain(folder.keys())
        .chain(exported.keys())
        .copied()
        .collect();
    let migrations = versions
        .iter()
        .rev()
        .map(|v| {
            let name = applied
                .get(v)
                .map(|(n, _)| n.clone())
                .or_else(|| folder.get(v).cloned())
                .or_else(|| {
                    exported
                        .get(v)
                        .and_then(|f| parse_filename(f))
                        .map(|(_, n)| n)
                })
                .unwrap_or_default();
            Migration {
                version: i64::from(*v),
                name,
                applied_on: applied.get(v).map(|(_, at)| at.clone()),
                // `null` when the folder is not reachable from the server.
                in_folder: dir.map(|_| folder.contains_key(v)),
                from_panel: exported.contains_key(v),
            }
        })
        .collect();

    let pending = client
        .query(
            "SELECT id, to_char(applied_at, 'YYYY-MM-DD\"T\"HH24:MI:SSTZH:TZM'), summary, statements,
                    kind, target
               FROM nelcota.panel_changes WHERE exported_in IS NULL ORDER BY id",
            &[],
        )
        .await?
        .iter()
        .map(|r| {
            PendingChange {
                id: r.get(0),
                applied_at: r.get(1),
                summary: r.get(2),
                statements: r.get(3),
                // The panel describes the change in its own language from these;
                // `summary` (English, or the old Portuguese) is the fallback.
                kind: r.get(4),
                target: r.get(5),
            }
        })
        .collect();

    Ok(MigrationsData {
        migrations,
        pending,
        next_version: i64::from(next_version(versions.iter().copied())),
        folder: dir.map(|d| d.display().to_string()),
    })
}

/// Generates pending changes and records their checksum as applied atomically.
pub(super) async fn generate(
    db: &Pool,
    dir: Option<&FsPath>,
    name: &str,
) -> Result<ExportedMigration, ApiError> {
    let name = name.trim();
    if !valid_name(name) {
        return Err(ApiError::bad_request(
            "invalid_migration_name",
            "name with lowercase letters, digits and _ (up to 60), e.g. create_orders",
        ));
    }
    let mut client = db.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute(nelcota_core::user_migrations::LOCK)
        .await?;
    // One generation at a time: two tabs never compete for the same number.
    tx.batch_execute("LOCK TABLE nelcota.panel_changes IN SHARE ROW EXCLUSIVE MODE")
        .await?;
    let rows = tx
        .query(
            "SELECT id, to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI \"UTC\"'),
                    summary, statements
               FROM nelcota.panel_changes WHERE exported_in IS NULL ORDER BY id",
            &[],
        )
        .await?;
    if rows.is_empty() {
        return Err(ApiError::conflict(
            "no_pending_changes",
            "no panel changes outside migrations",
        ));
    }
    let ids: Vec<i64> = rows.iter().map(|r| r.get(0)).collect();
    let changes: Vec<(String, String, Vec<String>)> = rows
        .iter()
        .map(|r| (r.get(1), r.get(2), r.get(3)))
        .collect();

    tx.batch_execute(CREATE_USER_MIGRATIONS).await?;
    let taken: Vec<i32> = tx
        .query(
            "SELECT version FROM nelcota.user_migrations
             UNION SELECT version FROM nelcota.panel_migrations",
            &[],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .chain(folder_migrations(dir).into_keys())
        .collect();
    let version = next_version(taken);

    let (generated_at, applied_on): (String, String) = {
        let row = tx
            .query_one(
                "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI \"UTC\"'),
                        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
                &[],
            )
            .await?;
        (row.get(0), row.get(1))
    };
    let sql = render(&generated_at, &changes);
    let stem = format!("V{version}__{name}");
    let filename = format!("{stem}.sql");
    // The same computation `migrate` does when it reads the file.
    let checksum = refinery::Migration::unapplied(&stem, &sql)
        .map_err(|e| ApiError::from(format!("invalid migration: {e}")))?
        .checksum()
        .to_string();

    tx.execute(
        "INSERT INTO nelcota.user_migrations (version, name, applied_on, checksum)
         VALUES ($1, $2, $3, $4)",
        &[&version, &name, &applied_on, &checksum],
    )
    .await?;
    tx.execute(
        "INSERT INTO nelcota.panel_migrations (version, filename, sql) VALUES ($1, $2, $3)",
        &[&version, &filename, &sql],
    )
    .await?;
    tx.execute(
        "UPDATE nelcota.panel_changes SET exported_in = $1 WHERE id = ANY($2)",
        &[&version, &ids],
    )
    .await?;
    tx.commit().await?;
    tracing::info!(
        version,
        changes = ids.len(),
        "migration generated by the panel"
    );
    let message = format!("{filename} generated with {} change(s)", ids.len());
    Ok(ExportedMigration {
        version: i64::from(version),
        filename,
        sql,
        message,
    })
}

/// Returns the original generated file without regenerating its SQL.
pub(super) async fn file(db: &Pool, version: i32) -> Result<MigrationFile, ApiError> {
    let client = db.get().await?;
    let row = client
        .query_opt(
            "SELECT filename, sql FROM nelcota.panel_migrations WHERE version = $1",
            &[&version],
        )
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "migration_not_from_panel",
                "migration was not generated by the panel",
            )
        })?;
    let filename: String = row.get(0);
    let sql: String = row.get(1);
    Ok(MigrationFile { filename, sql })
}
