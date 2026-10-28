//! Commands that talk to the database: migrate, types and token.
//!
//! They run directly when the environment has a configuration (container,
//! dev); on a `nelcota init` host they run with the project's app
//! configuration (in its container, or with its `.env` on systemd hosts).

use std::{fs, path::Path};

use anyhow::{Context, bail};
use nelcota_core::Config;
use refinery::{Migration, Runner};
use tokio_postgres::NoTls;

use crate::{
    dev,
    host::Host,
    project::Project,
    util::{ok, step},
};

/// Control table of the user's migrations (documented in docs/deploy.md).
pub const USER_MIGRATIONS_TABLE: &str = "nelcota.user_migrations";

enum Target {
    Direct(Box<Config>, Option<nelcota_deployment::HostLock>),
    Container(Project, Option<nelcota_deployment::HostLock>),
}

fn target(host: &Host, selection: Option<&str>, mutation: bool) -> anyhow::Result<Target> {
    // Freeze the target decision: a newly published host must not be selected
    // after skipping its lease. Direct env/dev database operation stays valid.
    let configured_host = host.exists();
    let lease = match mutation && configured_host {
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

pub fn migrate(host: &Host, selection: Option<&str>, dir: &Path) -> anyhow::Result<()> {
    match target(host, selection, true)? {
        Target::Container(project, _lease) => {
            if dir != Path::new("migrations") {
                bail!("in a `nelcota init` project, migrations live in ./migrations");
            }
            project.in_app(&["migrate", "--path", &project.app_migrations_dir()])
        }
        Target::Direct(config, _lease) => {
            let migrations = load_migrations(dir)?;
            if migrations.is_empty() {
                println!("No migrations in {}.", dir.display());
                return Ok(());
            }
            runtime()?.block_on(async {
                let mut client = connect(&config).await?;
                client
                    .batch_execute("CREATE SCHEMA IF NOT EXISTS nelcota")
                    .await?;
                let mut runner = Runner::new(&migrations).set_abort_divergent(true);
                runner.set_migration_table_name(USER_MIGRATIONS_TABLE);
                step(&format!("Applying migrations from {}", dir.display()));
                let report = runner.run_async(&mut client).await?;
                if report.applied_migrations().is_empty() {
                    ok("nothing new: the database is up to date");
                }
                for migration in report.applied_migrations() {
                    ok(&migration.to_string());
                }
                // Reload the catalog even without the event trigger.
                client
                    .batch_execute("NOTIFY nelcota, 'reload schema'")
                    .await?;
                Ok(())
            })
        }
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
