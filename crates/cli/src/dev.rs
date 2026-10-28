//! `nelcota dev`: Postgres 17 in a local container + the server in the
//! foreground, with development secrets generated and kept in `.nelcota/dev.env`.

use std::{
    fs,
    process::Command,
    time::{Duration, Instant},
};

use anyhow::{Context, bail};
use nelcota_core::{
    Config, Secret,
    config::{LogFormat, StorageBackend},
};
use tokio_postgres::NoTls;

use std::path::Path;

use crate::{
    DevArgs, Outcome,
    envfile::{parse, write_private},
    util::{self, ok, step},
};

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
    url.set_password(Some(&state.postgres_password))
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
                     (nelcota-dev-postgres-{port}) with its own data; the old one is left as is",
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

pub fn run(root: &Path, args: DevArgs) -> anyhow::Result<Outcome> {
    let state = prepare_state(root, args.db_port)?;

    let container = format!("nelcota-dev-postgres-{}", state.db_port);
    step(&format!("Development Postgres ({container})"));
    let running = Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", &container])
        .output()
        .context("Docker not found")?;
    match !running.status.success() {
        true => {
            let status = Command::new("docker")
                .args(["run", "-d", "--name", &container, "-e"])
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
                bail!("could not create the {container} container");
            }
        }
        false => {
            if String::from_utf8_lossy(&running.stdout).trim() != "true" {
                Command::new("docker")
                    .args(["start", &container])
                    .status()?;
            }
        }
    }

    save_state(root, &state)?;
    let config = config_for(root, &state, args.listen)?;
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
    let deadline = Instant::now() + Duration::from_secs(60);
    runtime.block_on(async {
        loop {
            match db.connect(NoTls).await {
                Ok(_) => return Ok(()),
                Err(_) if Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(err) => bail!("the development Postgres did not answer: {err}"),
            }
        }
    })
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
        state.postgres_password = "a$b`c@:/?#' space".into();
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
        let loaded = load_state(root.path()).unwrap().unwrap();
        assert_eq!(loaded.postgres_password, state.postgres_password);
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
