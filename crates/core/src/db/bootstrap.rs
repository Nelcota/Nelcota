//! Migration history and setup shared by full and auth-only hosts.
use std::collections::HashSet;
use tokio_postgres::{Client, NoTls};

struct ConnectionGuard {
    task: tokio::task::JoinHandle<()>,
    cancel: tokio_postgres::CancelToken,
    completed: bool,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if !self.completed
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let cancel = self.cancel.clone();
            runtime.spawn(async move {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    cancel.cancel_query(NoTls),
                )
                .await;
            });
        }
        // Dropping a JoinHandle detaches the driver. Own and stop it instead,
        // including when the bootstrap future is cancelled while waiting.
        self.task.abort();
    }
}

mod embedded {
    refinery::embed_migrations!("migrations");
}

pub const MIGRATIONS_TABLE: &str = "nelcota.schema_migrations";
/// Canonical auth/shared migration selection, also used to recognize promotion.
pub const AUTH_MIGRATION_VERSIONS: &[i32] = &[1, 2, 5, 9, 10, 14, 22];

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error("failed to connect to Postgres: {0}")]
    Connect(#[source] tokio_postgres::Error),
    #[error("failed to prepare the database: {0}")]
    Sql(#[from] tokio_postgres::Error),
    #[error("failed to apply migrations: {0}")]
    Migration(#[from] refinery::Error),
    #[error("migration {version}: {reason}")]
    History { version: i32, reason: &'static str },
    #[error("invalid migration selection at version {0}")]
    InvalidSelection(i32),
    #[error("database role {0} does not match the required privilege boundary")]
    UnsafeRole(&'static str),
}

/// Apply all migrations, including promotion of a supported auth-only database.
pub async fn bootstrap(
    admin: &tokio_postgres::Config,
    password: &str,
    timeout_secs: u64,
) -> Result<(), BootstrapError> {
    run(admin, password, timeout_secs, None).await
}

/// Apply distinct, known capability versions including V1/V2 in shared history.
/// Each migration commits its original SQL and refinery checksum together.
pub async fn bootstrap_migrations(
    admin: &tokio_postgres::Config,
    password: &str,
    timeout_secs: u64,
    versions: &[i32],
) -> Result<(), BootstrapError> {
    run(admin, password, timeout_secs, Some(versions)).await
}

async fn run(
    admin: &tokio_postgres::Config,
    password: &str,
    timeout_secs: u64,
    selection: Option<&[i32]>,
) -> Result<(), BootstrapError> {
    let mut runner = embedded::migrations::runner();
    runner.set_migration_table_name(MIGRATIONS_TABLE);
    let mut plan = runner.get_migrations().clone();
    plan.sort_by_key(refinery::Migration::version);
    if let Some(versions) = selection {
        let mut distinct = HashSet::new();
        for required in [1, 2] {
            if !versions.contains(&required) {
                return Err(BootstrapError::InvalidSelection(required));
            }
        }
        for version in versions {
            if !distinct.insert(version) || !plan.iter().any(|m| m.version() == *version) {
                return Err(BootstrapError::InvalidSelection(*version));
            }
        }
    }
    let (mut client, connection) = admin
        .connect(NoTls)
        .await
        .map_err(BootstrapError::Connect)?;
    let mut driver = ConnectionGuard {
        cancel: client.cancel_token(),
        completed: false,
        task: tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::error!(%error, "bootstrap connection closed");
            }
        }),
    };
    let result = migrate(
        &mut client,
        password,
        timeout_secs,
        selection,
        runner,
        &plan,
    )
    .await;
    // Also release the session advisory lock on errors.
    drop(client);
    driver.completed = true;
    let _ = (&mut driver.task).await;
    result
}

async fn migrate(
    client: &mut Client,
    password: &str,
    timeout_secs: u64,
    selection: Option<&[i32]>,
    runner: refinery::Runner,
    plan: &[refinery::Migration],
) -> Result<(), BootstrapError> {
    client.batch_execute(
        "SET client_connection_check_interval = '1s';
         SELECT pg_advisory_lock(hashtext('nelcota.migrations'));
         CREATE SCHEMA IF NOT EXISTS nelcota;
         CREATE TABLE IF NOT EXISTS nelcota.schema_migrations (
             version int4 PRIMARY KEY, name varchar(255), applied_on varchar(255), checksum varchar(255));"
    ).await?;
    let applied = runner.get_applied_migrations_async(client).await?;
    for previous in &applied {
        let source = plan
            .iter()
            .find(|m| m.version() == previous.version())
            .ok_or(BootstrapError::History {
                version: previous.version(),
                reason: "unsupported version",
            })?;
        if source.name() != previous.name() || source.checksum() != previous.checksum() {
            return Err(BootstrapError::History {
                version: previous.version(),
                reason: "divergent name or checksum",
            });
        }
    }
    let present: HashSet<_> = applied.iter().map(refinery::Migration::version).collect();
    match selection {
        Some(versions) => {
            for migration in plan
                .iter()
                .filter(|m| versions.contains(&m.version()) && !present.contains(&m.version()))
            {
                apply(client, migration).await?;
            }
        }
        None => {
            // Refinery rejects lower gaps. Only a canonical auth prefix may
            // have them; fill it before the normal strict full runner.
            let latest = applied.last().map_or(0, refinery::Migration::version);
            let auth_prefix: HashSet<_> = AUTH_MIGRATION_VERSIONS
                .iter()
                .copied()
                .filter(|v| *v <= latest)
                .collect();
            if !present.is_empty() && present == auth_prefix {
                // Promotion's lower gaps must commit together. A crash or a
                // failing migration leaves the supported auth prefix intact,
                // so a retry cannot become an arbitrary partial history.
                let missing: Vec<_> = plan
                    .iter()
                    .filter(|m| m.version() <= latest && !present.contains(&m.version()))
                    .collect();
                let tx = client.transaction().await?;
                for migration in &missing {
                    apply_in(&tx, migration).await?;
                }
                tx.commit().await?;
                for migration in missing {
                    tracing::info!(migration = %migration, "capability migration applied");
                }
            }
            for migration in runner.run_async(client).await?.applied_migrations() {
                tracing::info!(migration = %migration, "migration applied");
            }
        }
    }
    configure(client, password, timeout_secs).await?;
    client
        .batch_execute("SELECT pg_advisory_unlock(hashtext('nelcota.migrations'))")
        .await?;
    Ok(())
}

async fn apply(client: &mut Client, migration: &refinery::Migration) -> Result<(), BootstrapError> {
    let tx = client.transaction().await?;
    apply_in(&tx, migration).await?;
    tx.commit().await?;
    tracing::info!(migration = %migration, "capability migration applied");
    Ok(())
}

async fn apply_in(
    client: &impl tokio_postgres::GenericClient,
    migration: &refinery::Migration,
) -> Result<(), BootstrapError> {
    let sql = migration
        .sql()
        .ok_or(BootstrapError::InvalidSelection(migration.version()))?;
    client.batch_execute(sql).await?;
    client.execute(
        "INSERT INTO nelcota.schema_migrations (version,name,applied_on,checksum)
         VALUES ($1,$2,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),$3)",
        &[&migration.version(), &migration.name(), &migration.checksum().to_string()],
    ).await?;
    Ok(())
}

async fn configure(
    client: &Client,
    password: &str,
    timeout_secs: u64,
) -> Result<(), BootstrapError> {
    validate_roles(client).await?;
    let verifier = postgres_protocol::password::scram_sha_256(password.as_bytes());
    for (template, value) in [
        (
            "SELECT format('ALTER ROLE authenticator WITH PASSWORD %L', $1::text)",
            verifier,
        ),
        (
            "SELECT format('ALTER ROLE authenticator SET statement_timeout = %L', $1::text)",
            format!("{timeout_secs}s"),
        ),
    ] {
        let statement: String = client.query_one(template, &[&value]).await?.get(0);
        client.batch_execute(&statement).await?;
    }
    Ok(())
}

async fn validate_roles(client: &Client) -> Result<(), BootstrapError> {
    let rows = client.query(
        "SELECT rolname, NOT (rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication)
            AND rolcanlogin = (rolname = 'authenticator')
            AND rolbypassrls = (rolname IN ('service_role','nelcota_storage'))
            AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid AND inherit_option)
         FROM pg_roles WHERE rolname IN ('authenticator','anon','authenticated','service_role','nelcota_auth','nelcota_storage','nelcota_webhooks')", &[]
    ).await?;
    // The shared/auth roles are required; full-host roles are validated when
    // present, including when another database in the cluster created them.
    for (role, required) in [
        ("authenticator", true),
        ("anon", true),
        ("authenticated", true),
        ("service_role", true),
        ("nelcota_auth", true),
        ("nelcota_storage", false),
        ("nelcota_webhooks", false),
    ] {
        if !required && !rows.iter().any(|row| row.get::<_, &str>(0) == role) {
            continue;
        }
        if !rows
            .iter()
            .any(|row| row.get::<_, &str>(0) == role && row.get::<_, bool>(1))
        {
            return Err(BootstrapError::UnsafeRole(role));
        }
    }
    Ok(())
}
