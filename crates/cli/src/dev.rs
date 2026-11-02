//! `nelcota dev`: Postgres 17 in a local container + the server in the
//! foreground, with development secrets generated and kept in `.nelcota/dev.env`.

use std::{fs, process::Command, time::Duration};

use anyhow::{Context, bail};
use nelcota_core::{
    Config, Secret,
    config::{LogFormat, StorageBackend},
};
use sha2::{Digest, Sha256};
use tokio_postgres::NoTls;

use std::path::Path;

use crate::{
    DevArgs, Outcome,
    envfile::{parse, write_private},
    util::{self, ok, step},
};

mod mail;

const STATE_FILE: &str = ".nelcota/dev.env";

struct DevState {
    postgres_password: String,
    authenticator_password: String,
    jwt_private_key: String,
    db_port: u16,
    admin_email: String,
    admin_password: String,
    admin_password_hash: String,
}

fn load_state(root: &Path) -> anyhow::Result<Option<DevState>> {
    let text = match fs::read_to_string(root.join(STATE_FILE)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("could not read development state"),
    };
    let env = parse(&text);
    let get = |key: &str| {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .with_context(|| format!("{key} missing from {STATE_FILE}"))
    };
    let mut state = DevState {
        postgres_password: get("POSTGRES_PASSWORD")?,
        authenticator_password: get("AUTHENTICATOR_PASSWORD")?,
        jwt_private_key: get("JWT_PRIVATE_KEY")?,
        db_port: get("DB_PORT")?.parse()?,
        admin_email: get("ADMIN_EMAIL").unwrap_or_else(|_| "admin@localhost".into()),
        admin_password: get("ADMIN_PASSWORD").unwrap_or_else(|_| util::password(18)),
        admin_password_hash: get("ADMIN_PASSWORD_HASH").unwrap_or_default(),
    };
    if state.admin_password_hash.is_empty() || get("ADMIN_PASSWORD").is_err() {
        state.admin_password_hash = nelcota_auth::hash_password(&state.admin_password)
            .context("could not hash the development admin password")?;
        save_state(root, &state)?;
    }
    Ok(Some(state))
}

fn save_state(root: &Path, state: &DevState) -> anyhow::Result<()> {
    fs::create_dir_all(root.join(".nelcota"))?;
    let database_url = database_url(state)?;
    let values = [
        ("POSTGRES_PASSWORD", state.postgres_password.as_str()),
        (
            "AUTHENTICATOR_PASSWORD",
            state.authenticator_password.as_str(),
        ),
        ("JWT_PRIVATE_KEY", state.jwt_private_key.as_str()),
        ("DB_PORT", &state.db_port.to_string()),
        ("ADMIN_EMAIL", state.admin_email.as_str()),
        ("ADMIN_PASSWORD", state.admin_password.as_str()),
        ("ADMIN_PASSWORD_HASH", state.admin_password_hash.as_str()),
        ("DATABASE_URL", database_url.as_str()),
    ];
    let mut text = String::from("# Development secrets (do not use in production).\n");
    for (key, value) in values {
        if value.contains(['\n', '\r', '\0']) {
            bail!("{key} must be a single-line environment value");
        }
        // POSIX single quotes prevent parameter, command and history expansion.
        text.push_str(&format!("{key}='{}'\n", value.replace('\'', "'\\''")));
    }
    write_private(&root.join(STATE_FILE), &text)?;
    fs::write(root.join(".nelcota/.gitignore"), "*\n")?;
    Ok(())
}

fn database_url(state: &DevState) -> anyhow::Result<String> {
    let mut url = url::Url::parse(&format!(
        "postgres://postgres@127.0.0.1:{}/postgres",
        state.db_port
    ))?;
    url.set_password(Some(&state.postgres_password.replace('%', "%25")))
        .map_err(|()| anyhow::anyhow!("could not encode the development database password"))?;
    Ok(url.into())
}

fn config_for(
    root: &Path,
    state: &DevState,
    listen: std::net::SocketAddr,
) -> anyhow::Result<Config> {
    Ok(Config {
        database_url: Secret::new(database_url(state)?),
        authenticator_password: Secret::new(state.authenticator_password.clone()),
        jwt_private_key: Some(Secret::new(state.jwt_private_key.clone())),
        jwt_issuer: "nelcota-dev".into(),
        listen,
        log_format: LogFormat::Text,
        storage_backend: StorageBackend::Disk,
        storage_dir: Some(root.join(".nelcota/storage")),
        admin_email: Some(state.admin_email.clone()),
        admin_password_hash: Some(Secret::new(state.admin_password_hash.clone())),
        project_name: Some("nelcota-dev".into()),
        migrations_dir: Some(root.join("migrations")),
        dev_migrations_dir: Some(root.join("migrations")),
        ..Config::default()
    })
}

/// Configuration of the already created dev environment (for `migrate`/`types`).
pub fn saved_config(root: &Path) -> anyhow::Result<Option<Config>> {
    load_state(root)?
        .map(|s| config_for(root, &s, ([127, 0, 0, 1], 8000).into()))
        .transpose()
}

const DEFAULT_DB_PORT: u16 = 54322;

/// The saved state (created on the first run). An explicit `--db-port`
/// different from the saved one replaces it and is saved for the next runs.
fn prepare_state(root: &Path, db_port: Option<u16>) -> anyhow::Result<DevState> {
    match load_state(root)? {
        Some(mut state) => {
            if let Some(port) = db_port.filter(|port| *port != state.db_port) {
                util::warn(&format!(
                    "development Postgres moves from port {} to {port}: a new container \
                     with its own data; the old container is left as is",
                    state.db_port
                ));
                state.db_port = port;
                save_state(root, &state)?;
            }
            Ok(state)
        }
        None => {
            let admin_password = util::password(18);
            let admin_password_hash = nelcota_auth::hash_password(&admin_password)
                .context("could not hash the development admin password")?;
            let state = DevState {
                postgres_password: util::secret(24),
                authenticator_password: util::secret(24),
                jwt_private_key: nelcota_auth::generate_ed25519_private_key(),
                db_port: db_port.unwrap_or(DEFAULT_DB_PORT),
                admin_email: "admin@localhost".into(),
                admin_password,
                admin_password_hash,
            };
            save_state(root, &state)?;
            Ok(state)
        }
    }
}

const PROJECT_LABEL: &str = "com.nelcota.dev.project";

fn postgres_container(root: &Path, port: u16) -> anyhow::Result<String> {
    let root = root
        .canonicalize()
        .context("could not resolve the project folder")?;
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    Ok(format!(
        "nelcota-dev-postgres-{}-{port}",
        base16ct::lower::encode_string(&digest[..12])
    ))
}

fn inspect_container(name: &str) -> anyhow::Result<Option<serde_json::Value>> {
    let output = Command::new("docker")
        .args(["container", "inspect", name])
        .output()
        .context("Docker not found")?;
    if !output.status.success() {
        let reachable = Command::new("docker").arg("info").output()?;
        if !reachable.status.success() {
            bail!("cannot reach Docker");
        }
        return Ok(None);
    }
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout)?;
    Ok(rows.into_iter().next())
}

fn check_owner(container: &str, info: &serde_json::Value, root: &Path) -> anyhow::Result<()> {
    let owner = info["Config"]["Labels"][PROJECT_LABEL]
        .as_str()
        .unwrap_or("unknown (legacy container)");
    if owner != root.to_string_lossy() {
        bail!(
            "container {container} belongs to {owner}; this project is {}. Use --db-port with a free port; existing data has been preserved",
            root.display()
        );
    }
    Ok(())
}

pub fn run(root: &Path, args: DevArgs) -> anyhow::Result<Outcome> {
    if root.join("crates/core/migrations").is_dir() {
        bail!(
            "start nelcota dev from a separate application folder; repository migrations are internal"
        );
    }
    let state = prepare_state(root, args.db_port)?;

    let root = &root
        .canonicalize()
        .context("could not resolve the project folder")?;
    let container = postgres_container(root, state.db_port)?;
    println!("  Project:  {}", root.display());
    println!("  Database: {container} (127.0.0.1:{})", state.db_port);
    step(&format!("Development Postgres ({container})"));
    match inspect_container(&container)? {
        Some(info) => {
            check_owner(&container, &info, root)?;
            if info["State"]["Running"].as_bool() != Some(true) {
                let status = Command::new("docker")
                    .args(["start", &container])
                    .status()?;
                if !status.success() {
                    bail!("could not start {container}");
                }
            }
            ok("reusing this project's development database");
        }
        None => {
            let conflicts = Command::new("docker")
                .args([
                    "ps",
                    "--filter",
                    &format!("publish={}", state.db_port),
                    "--format",
                    "{{.Names}}",
                ])
                .output()?;
            if !conflicts.status.success() {
                bail!("could not check development database ports");
            }
            if let Some(other) = String::from_utf8_lossy(&conflicts.stdout).lines().next() {
                let info = inspect_container(other)?.unwrap_or_default();
                let owner = info["Config"]["Labels"][PROJECT_LABEL]
                    .as_str()
                    .unwrap_or("unknown (legacy container)");
                bail!(
                    "database port {} is used by container {other}, created for {owner}. Use --db-port with a free port; existing data has been preserved",
                    state.db_port
                );
            }
            let status = Command::new("docker")
                .args(["run", "-d", "--name", &container, "--label"])
                .arg(format!("{PROJECT_LABEL}={}", root.display()))
                .arg("-e")
                .arg(format!("POSTGRES_PASSWORD={}", state.postgres_password))
                .arg("-p")
                .arg(format!("127.0.0.1:{}:5432", state.db_port))
                .arg("-v")
                .arg(format!("{container}-data:/var/lib/postgresql/data"))
                .args([
                    "postgres:17-alpine",
                    "postgres",
                    "-c",
                    "shared_preload_libraries=pg_stat_statements",
                ])
                .status()?;
            if !status.success() {
                bail!(
                    "could not create {container}; check whether port {} is available",
                    state.db_port
                );
            }
        }
    }

    save_state(root, &state)?;
    let mut config = config_for(root, &state, args.listen)?;
    if args.mail {
        mail::configure(root, &container, &args.mail_callback, &mut config)?;
    }
    wait_for_postgres(&config)?;
    ok(&format!("Postgres at 127.0.0.1:{}", state.db_port));

    // Secrets stay in the 0600 state file: terminal scrollback and CI logs
    // only get where to find them.
    println!();
    println!("  API:      http://{}/rest/v1/", args.listen);
    println!("  Auth:     http://{}/auth/v1/", args.listen);
    println!("  Panel:    http://{}/admin/", args.listen);
    println!(
        "  Login:    {}  (ADMIN_PASSWORD in {STATE_FILE})",
        state.admin_email
    );
    println!(
        "  Postgres: postgres://postgres:***@127.0.0.1:{}/postgres  (POSTGRES_PASSWORD in {STATE_FILE})",
        state.db_port
    );
    println!();
    println!("  Migrations: nelcota migrate   ·   Types: nelcota types -o database.ts");
    println!("  service_role token (bypasses RLS): nelcota token service-role --days 30");
    println!();
    Ok(Outcome::Serve(Box::new(config)))
}

fn wait_for_postgres(config: &Config) -> anyhow::Result<()> {
    let db = config.database_config()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            // A port that accepts but never answers (a starting proxy, another
            // service) must not hold an attempt past the overall deadline.
            match tokio::time::timeout_at(deadline, db.connect(NoTls)).await {
                Ok(Ok(_)) => return Ok(()),
                Ok(Err(_)) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Ok(Err(err)) => bail!("the development Postgres did not answer: {err}"),
                Err(_) => bail!("the development Postgres did not answer within 60s"),
            }
        }
    })
}

/// Apply application files after internal bootstrap, before the development server serves traffic.
pub async fn apply_migrations(config: &Config) -> anyhow::Result<()> {
    let directory = match &config.dev_migrations_dir {
        Some(directory) if directory.is_dir() => directory,
        _ => return Ok(()),
    };
    let scan = directory.clone();
    let files = tokio::task::spawn_blocking(move || crate::db::migration_files(&scan)).await??;
    let (mut client, connection) = config.database_config()?.connect(NoTls).await?;
    let driver = tokio::spawn(connection);
    let result = nelcota_core::user_migrations::apply(
        &mut client,
        &nelcota_core::user_migrations::MigrationRequest {
            files,
            dry_run: false,
        },
        "cli:dev",
    )
    .await;
    drop(client);
    let _ = driver.await;
    result?;
    Ok(())
}

pub struct MigrationWatcher {
    task: tokio::task::JoinHandle<()>,
}
impl Drop for MigrationWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub fn watch_migrations(config: &Config) -> Option<MigrationWatcher> {
    let directory = config.dev_migrations_dir.clone()?;
    let config = config.clone();
    Some(MigrationWatcher {
        task: tokio::spawn(async move {
            let mut previous = Vec::new();
            let mut previous_error: Option<String> = None;
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            // A slow apply must not be followed by a burst of catch-up scans.
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                // Reading every file each second is blocking work; keep it off
                // the runtime threads that serve the development API.
                let scan = directory.clone();
                let files = tokio::task::spawn_blocking(move || {
                    scan.is_dir()
                        .then(|| crate::db::migration_files(&scan))
                        .transpose()
                })
                .await;
                let current = match files {
                    Ok(Ok(None)) => continue,
                    Ok(Ok(Some(files))) => files
                        .into_iter()
                        .map(|file| (file.filename, file.sql))
                        .collect::<Vec<_>>(),
                    // The scan panicked; try again on the next tick.
                    Err(_) => continue,
                    Ok(Err(error)) => {
                        let message = error.to_string();
                        if previous_error.as_ref() != Some(&message) {
                            eprintln!("Development migration files are invalid: {message}");
                        }
                        previous_error = Some(message);
                        continue;
                    }
                };
                previous_error = None;
                if current == previous {
                    continue;
                }
                previous = current;
                if let Err(error) = apply_migrations(&config).await {
                    eprintln!(
                        "Development migration failed: {error}. Fix the migration file before continuing."
                    );
                }
            }
        }),
    })
}

/// Destructive reset is restricted to the canonical, labeled local development container.
pub fn reset(host: &crate::host::Host, yes: bool) -> anyhow::Result<()> {
    if !yes {
        bail!("db reset deletes this project's local database; stop nelcota dev and pass --yes");
    }
    if host.exists() {
        bail!("db reset is only available in a local nelcota dev application folder");
    }
    let root = host.root().canonicalize()?;
    let state = load_state(&root)?.context("no saved local development database")?;
    let container = postgres_container(&root, state.db_port)?;
    let info = inspect_container(&container)?.context("local development container not found")?;
    check_owner(&container, &info, &root)?;
    let config = config_for(&root, &state, ([127, 0, 0, 1], 8000).into())?;
    // Validate the repository files before deleting any local data.
    if root.join("migrations").is_dir() {
        crate::db::migration_files(&root.join("migrations"))?;
    }
    tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(async {
        let mut maintenance = config.database_config()?;
        maintenance.dbname("template1");
        let (client, connection) = maintenance.connect(NoTls).await?;
        let driver = tokio::spawn(connection);
        let active: i64 = client.query_one("SELECT count(*) FROM pg_stat_activity WHERE datname = 'postgres'", &[]).await?.get(0);
        if active > 0 { bail!("stop nelcota dev and close local SQL clients before db reset"); }
        client.batch_execute("ALTER DATABASE postgres ALLOW_CONNECTIONS false").await?;
        if let Err(error) = client.batch_execute("DROP DATABASE postgres WITH (FORCE)").await {
            let _ = client.batch_execute("ALTER DATABASE postgres ALLOW_CONNECTIONS true").await;
            return Err(error.into());
        }
        client.batch_execute("CREATE DATABASE postgres").await?;
        drop(client); let _ = driver.await;
        nelcota_core::db::bootstrap(&config.database_config()?, config.authenticator_password.expose(), config.statement_timeout_secs).await?;
        apply_migrations(&config).await?;
        let seed = root.join("seed.sql");
        if seed.exists() {
            let sql = fs::read_to_string(seed)?;
            let (mut client, connection) = config.database_config()?.connect(NoTls).await?;
            let driver = tokio::spawn(connection);
            let transaction = client.transaction().await?;
            transaction.batch_execute("CREATE FUNCTION pg_temp.nelcota_seed(script text) RETURNS void LANGUAGE plpgsql AS 'BEGIN EXECUTE script; END'").await?;
            transaction.query_one("SELECT pg_temp.nelcota_seed($1)", &[&sql]).await?;
            transaction.commit().await?;
            drop(client); let _ = driver.await;
        }
        Ok::<_, anyhow::Error>(())
    })?;
    ok("local development database rebuilt from migrations and seed.sql");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upgrades_legacy_dev_state_and_keeps_the_same_credentials_on_reload() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".nelcota")).unwrap();
        fs::write(root.path().join(STATE_FILE), "POSTGRES_PASSWORD=existing-db\nAUTHENTICATOR_PASSWORD=existing-api\nJWT_PRIVATE_KEY=existing-key\nDB_PORT=54322\n").unwrap();
        let first = load_state(root.path()).unwrap().unwrap();
        assert_eq!(first.postgres_password, "existing-db");
        assert!(nelcota_auth::verify_password(
            &first.admin_password,
            &first.admin_password_hash
        ));
        let second = load_state(root.path()).unwrap().unwrap();
        assert_eq!(first.admin_password, second.admin_password);
        assert_eq!(first.admin_password_hash, second.admin_password_hash);
        let config = config_for(root.path(), &second, ([127, 0, 0, 1], 8000).into()).unwrap();
        assert_eq!(config.admin_email.as_deref(), Some("admin@localhost"));
        assert!(config.admin_password_hash.is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.path().join(STATE_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn development_env_can_be_sourced_without_expanding_secrets() {
        let root = tempfile::tempdir().unwrap();
        let mut state = prepare_state(root.path(), None).unwrap();
        state.postgres_password = "a$b`c@:/?#' space%40%literal".into();
        save_state(root.path(), &state).unwrap();
        let text = fs::read_to_string(root.path().join(STATE_FILE)).unwrap();
        let parsed = parse(&text);
        assert_eq!(
            parsed
                .iter()
                .find(|(key, _)| key == "POSTGRES_PASSWORD")
                .unwrap()
                .1,
            state.postgres_password
        );
        let output = Command::new("bash")
            .args([
                "-c",
                ". \"$1\"; printf '%s\\n%s' \"$POSTGRES_PASSWORD\" \"$ADMIN_PASSWORD_HASH\"",
                "test",
            ])
            .arg(root.path().join(STATE_FILE))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n{}", state.postgres_password, state.admin_password_hash)
        );
        let url = database_url(&state).unwrap();
        assert!(!url.contains("@:/?#"));
        assert_eq!(url::Url::parse(&url).unwrap().host_str(), Some("127.0.0.1"));
        let decoded = url.parse::<tokio_postgres::Config>().unwrap();
        assert_eq!(
            decoded.get_password(),
            Some(state.postgres_password.as_bytes())
        );
        let loaded = load_state(root.path()).unwrap().unwrap();
        assert_eq!(loaded.postgres_password, state.postgres_password);
    }

    #[test]
    fn database_identity_belongs_to_the_canonical_project_and_port() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let name = postgres_container(first.path(), DEFAULT_DB_PORT).unwrap();
        assert_ne!(
            name,
            postgres_container(second.path(), DEFAULT_DB_PORT).unwrap()
        );
        assert_ne!(name, postgres_container(first.path(), 55000).unwrap());
        let info = serde_json::json!({"Config": {"Labels": {PROJECT_LABEL: first.path().to_str().unwrap()}}});
        assert!(check_owner(&name, &info, first.path()).is_ok());
        assert!(check_owner(&name, &info, second.path()).is_err());
        assert!(check_owner(&name, &serde_json::json!({}), first.path()).is_err());
        #[cfg(unix)]
        {
            let link = second.path().join("alias");
            std::os::unix::fs::symlink(first.path(), &link).unwrap();
            assert_eq!(name, postgres_container(&link, DEFAULT_DB_PORT).unwrap());
        }
    }

    #[test]
    fn an_explicit_db_port_is_honored_and_saved() {
        let root = tempfile::tempdir().unwrap();
        let first = prepare_state(root.path(), None).unwrap();
        assert_eq!(first.db_port, DEFAULT_DB_PORT);
        assert_eq!(
            prepare_state(root.path(), None).unwrap().db_port,
            DEFAULT_DB_PORT
        );

        let moved = prepare_state(root.path(), Some(55000)).unwrap();
        assert_eq!(moved.db_port, 55000);
        assert_eq!(moved.postgres_password, first.postgres_password);
        // Saved: later runs without the flag keep the new port.
        assert_eq!(prepare_state(root.path(), None).unwrap().db_port, 55000);
    }
}
