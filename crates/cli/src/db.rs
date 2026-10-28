//! Commands that talk to the database: migrate, types and token.
//!
//! They run directly when the environment has a configuration (container,
//! dev); on a `nelcota init` host they run with the project's app
//! configuration (in its container, or with its `.env` on systemd hosts).

use std::{fs, path::Path};

use anyhow::{Context, bail};
use nelcota_core::Config;
use nelcota_core::user_migrations::{self, MigrationFile, MigrationRequest};
use refinery::Migration;
use tokio_postgres::NoTls;

use crate::{
    dev,
    host::Host,
    project::Project,
    util::{ok, step},
};

enum Target {
    Direct(Box<Config>, Option<nelcota_deployment::HostLock>),
    Container(Project, Option<nelcota_deployment::HostLock>),
}

fn target(host: &Host, selection: Option<&str>, mutation: bool) -> anyhow::Result<Target> {
    // Freeze the target decision: a newly published host must not be selected
    // after skipping its lease. Direct env/dev database operation stays valid.
    let configured_host = host.exists();
    // The project-scoped agent retains the host lease through backup and SQL.
    // Taking it in this parent too would deadlock the child waiting for its agent.
    let uses_agent = configured_host
        && std::env::var_os("NELCOTA_DATABASE_URL").is_none()
        && host
            .select(&host.manifest()?, selection)?
            .env()
            .get("NELCOTA_MIGRATION_BACKUP_TOKEN")?
            .is_some();
    let lease = match mutation && configured_host && !uses_agent {
        true => Some(crate::host::acquire_mutation_lease(host.root())?),
        false => None,
    };
    if std::env::var_os("NELCOTA_DATABASE_URL").is_some() {
        return Ok(Target::Direct(Box::new(Config::load()?), lease));
    }
    if configured_host {
        let manifest = host.manifest()?;
        return Ok(Target::Container(host.select(&manifest, selection)?, lease));
    }
    if let Some(config) = dev::saved_config(host.root())? {
        return Ok(Target::Direct(Box::new(config), lease));
    }
    bail!(
        "no database configured: set NELCOTA_DATABASE_URL, run inside a `nelcota init` project \
         or start the environment with `nelcota dev`"
    )
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}

async fn connect(config: &Config) -> anyhow::Result<tokio_postgres::Client> {
    let (client, connection) = config
        .database_config()?
        .connect(NoTls)
        .await
        .context("could not connect to Postgres")?;
    tokio::spawn(connection);
    Ok(client)
}

/// Reads `V<n>__<name>.sql` from the directory. CRLF becomes LF so the
/// checksum does not depend on the operating system of whoever checked out.
fn load_migrations(dir: &Path) -> anyhow::Result<Vec<Migration>> {
    if !dir.is_dir() {
        bail!("migrations directory not found: {}", dir.display());
    }
    let mut paths: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "sql"))
        .collect();
    paths.sort();
    let mut migrations = Vec::with_capacity(paths.len());
    let mut versions = std::collections::BTreeMap::new();
    for path in paths {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .context("invalid file name")?;
        let sql = fs::read_to_string(&path)?.replace("\r\n", "\n");
        let migration = Migration::unapplied(stem, &sql)
            .with_context(|| format!("invalid name: {stem} (use V<n>__<name>.sql)"))?;
        if let Some(previous) = versions.insert(migration.version(), path.clone()) {
            bail!(
                "duplicate migration version {}: {} and {}",
                migration.version(),
                previous.display(),
                path.display()
            );
        }
        migrations.push(migration);
    }
    Ok(migrations)
}

pub fn migration_files(dir: &Path) -> anyhow::Result<Vec<MigrationFile>> {
    // Preserve the existing filename and duplicate validation before any connection.
    let migrations = load_migrations(dir)?;
    Ok(migrations
        .into_iter()
        .map(|migration| MigrationFile {
            filename: format!("V{}__{}.sql", migration.version(), migration.name()),
            sql: migration.sql().unwrap_or_default().into(),
        })
        .collect())
}

pub fn migrate(
    host: &Host,
    selection: Option<&str>,
    dir: &Path,
    status: bool,
    dry_run: bool,
) -> anyhow::Result<()> {
    match target(host, selection, !status && !dry_run)? {
        Target::Container(project, _lease) => {
            if dir != Path::new("migrations") {
                bail!("in a nelcota init project, migrations live in ./migrations");
            }
            if !status
                && !dry_run
                && project
                    .env()
                    .get("NELCOTA_MIGRATION_BACKUP_TOKEN")?
                    .is_some()
            {
                project.in_app(&["migration-backup", "check-support"]).context("the configured project server does not support automatic migration backups")?;
            }
            let path = project.app_migrations_dir();
            let mut args = vec!["migrate", "--path", &path];
            if dry_run {
                args.push("--dry-run");
            }
            if status {
                args.push("status");
            }
            project.in_app(&args)
        }
        Target::Direct(config, _lease) => {
            let files = migration_files(dir)?;
            runtime()?.block_on(async {
                let mut client = connect(&config).await?;
                if status {
                    let statuses = user_migrations::status(&client, &files).await?;
                    println!("{}", serde_json::to_string_pretty(&statuses)?);
                    return Ok(());
                }
                step(&format!("Applying migrations from {}", dir.display()));
                let agent = nelcota_core::migration_backup::BackupAgent::from_config(&config);
                let report = nelcota_core::migration_backup::apply(
                    &mut client,
                    &MigrationRequest { files, dry_run },
                    "cli:local",
                    config.production,
                    agent.as_ref(),
                )
                .await?;
                for version in report.applied {
                    ok(&format!("V{version} applied"));
                }
                if dry_run {
                    println!("{}", serde_json::to_string_pretty(&report.migrations)?);
                }
                println!("Regenerate Context for AI in the panel: /admin/connect?section=api-ai");
                Ok(())
            })
        }
    }
}

pub fn deploy_token(
    host: &Host,
    selection: Option<&str>,
    days: u32,
    name: &str,
) -> anyhow::Result<()> {
    if !(1..=90).contains(&days) || name.trim().is_empty() || name.len() > 100 {
        bail!("deploy token needs a name (1-100 bytes) and validity of 1-90 days");
    }
    match target(host, selection, false)? {
        Target::Container(project, _lease) => {
            print!("{}", project.in_app_output(&["token", "deploy", "--days", &days.to_string(), "--name", name])?);
            Ok(())
        }
        Target::Direct(config, _lease) => runtime()?.block_on(async {
            use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
            use sha2::{Digest, Sha256};
            let mut bytes = [0u8; 32]; getrandom::fill(&mut bytes)?;
            let token = format!("ndp_{}", URL_SAFE_NO_PAD.encode(bytes));
            let hash = base16ct::lower::encode_string(&Sha256::digest(token.as_bytes()));
            let client = connect(&config).await?;
            let days = i64::from(days);
            client.execute("INSERT INTO nelcota.deploy_tokens (token_hash, name, issued_by, expires_at) VALUES ($1, $2, 'cli:local', now() + $3::bigint * interval '1 day')", &[&hash, &name, &days]).await?;
            println!("{token}");
            Ok(())
        }),
    }
}

pub fn types(
    host: &Host,
    selection: Option<&str>,
    out: Option<&Path>,
    lang: crate::TypesLanguage,
) -> anyhow::Result<()> {
    let code = match target(host, selection, false)? {
        Target::Container(project, _lease) => match lang {
            // Existing deployed binaries understand the original TypeScript command.
            crate::TypesLanguage::Typescript => project.in_app_output(&["types"])?,
            crate::TypesLanguage::Rust => {
                project.in_app_output(&["types", "--lang", lang.as_str()])?
            }
        },
        Target::Direct(config, _lease) => runtime()?.block_on(async {
            let client = connect(&config).await?;
            let catalog = nelcota_api::Catalog::load(&client, &config.db_schema).await?;
            Ok::<_, anyhow::Error>(match lang {
                crate::TypesLanguage::Typescript => nelcota_api::typescript::generate(&catalog),
                crate::TypesLanguage::Rust => nelcota_api::rust::generate(&catalog),
            })
        })?,
    };
    match out {
        Some(path) => {
            fs::write(path, code)?;
            ok(&format!("types written to {}", path.display()));
        }
        None => print!("{code}"),
    }
    Ok(())
}

pub fn service_role_token(host: &Host, selection: Option<&str>, days: u64) -> anyhow::Result<()> {
    match target(host, selection, false)? {
        Target::Container(project, _lease) => {
            let token =
                project.in_app_output(&["token", "service-role", "--days", &days.to_string()])?;
            print!("{token}");
        }
        Target::Direct(config, _lease) => {
            let keys = nelcota_auth::Keys::new(
                config.jwt_private_key(),
                config.jwt_secret().map(str::as_bytes),
            )?;
            let token = keys.service_role_token(&config.jwt_issuer, days)?;
            eprintln!(
                "WARNING: this token bypasses RLS. Use it only in your backend, never in a frontend."
            );
            println!("{token}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn duplicate_versions_are_rejected_before_connecting_to_postgres() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["V3__first.sql", "V3__second.sql"] {
            std::fs::write(directory.path().join(name), "SELECT 1;").unwrap();
        }
        let error = super::load_migrations(directory.path()).unwrap_err();
        assert!(error.to_string().contains("duplicate migration version 3"));
    }
}
