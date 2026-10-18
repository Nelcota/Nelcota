//! Native PostgreSQL cluster configuration and removal.
use super::systemctl;
use crate::{
    project::run,
    scaffold,
    util::{ok, step},
};
use anyhow::{Context, bail};
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    process::{Command, Stdio},
};
pub const POSTGRES_UNIT: &str = "postgresql@17-main";
pub const PG_DATA: &str = "/var/lib/postgresql/17/main";
const PG_CONF: &str = "/etc/postgresql/17/main/conf.d/nelcota.conf";

#[derive(Debug, PartialEq, Eq)]
struct Cluster {
    version: String,
    name: String,
    port: u16,
}

impl Cluster {
    fn is_native(&self) -> bool {
        self.version == "17" && self.name == "main"
    }
}

fn parse_clusters(output: &str) -> anyhow::Result<Vec<Cluster>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 7 {
            bail!("incomplete PostgreSQL cluster inventory; refusing native configuration");
        }
        let port = fields[2]
            .parse::<u16>()
            .context("invalid PostgreSQL cluster port; refusing native configuration")?;
        if port == 0 || !seen.insert((fields[0].to_owned(), fields[1].to_owned())) {
            bail!("ambiguous PostgreSQL cluster inventory; refusing native configuration");
        }
        result.push(Cluster {
            version: fields[0].to_owned(),
            name: fields[1].to_owned(),
            port,
        });
    }
    Ok(result)
}

fn validate_layout(clusters: &[Cluster]) -> anyhow::Result<()> {
    for cluster in clusters {
        if cluster.is_native() {
            if cluster.port != 5432 {
                bail!(
                    "native PostgreSQL requires 17/main on port 5432; refusing to configure a different target"
                );
            }
            continue;
        }
        if cluster.port == 5432 {
            bail!(
                "port 5432 belongs to another PostgreSQL cluster; native init requires 17/main on that port"
            );
        }
    }
    Ok(())
}

fn inventory() -> anyhow::Result<Option<Vec<Cluster>>> {
    let output = match Command::new("pg_lsclusters").arg("--no-header").output() {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("could not inventory native PostgreSQL clusters"),
    };
    if !output.status.success() {
        bail!("pg_lsclusters failed; native PostgreSQL ownership cannot be verified");
    }
    let text =
        String::from_utf8(output.stdout).context("PostgreSQL cluster inventory is not UTF-8")?;
    Ok(Some(parse_clusters(&text)?))
}

/// Check before installing packages or writing a new host/project registry.
pub(super) fn check_cluster_layout() -> anyhow::Result<()> {
    match inventory()? {
        Some(clusters) => validate_layout(&clusters),
        None => Ok(()),
    }
}

/// Native administrative clients always belong to the local 17/main cluster.
pub(crate) fn postgres_command(args: &[&str]) -> Command {
    let mut command = Command::new("runuser");
    command.args(["-u", "postgres", "--"]);
    for (index, argument) in args.iter().enumerate() {
        command.arg(argument);
        if index == 0 && matches!(*argument, "psql" | "pg_dump" | "pg_restore" | "pg_isready") {
            command.args(["--cluster", "17/main"]);
        }
    }
    command
        .env("PGCLUSTER", "17/main")
        .env("PGHOST", "/var/run/postgresql")
        .env("PGPORT", "5432")
        .env("PGUSER", "postgres")
        .env("PGDATABASE", "postgres")
        .env_remove("PGHOSTADDR")
        .env_remove("PGSERVICE")
        .env_remove("PGSERVICEFILE");
    command
}

fn password_command() -> Command {
    let mut command = postgres_command(&[
        "psql",
        "--host",
        "/var/run/postgresql",
        "--port",
        "5432",
        "--username",
        "postgres",
        "-Xqw",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        "postgres",
    ]);
    command
        .env("PGCONNECT_TIMEOUT", "10")
        .env(
            "PGOPTIONS",
            "-c statement_timeout=30000 -c lock_timeout=10000",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn validate_password(candidate: &str) -> anyhow::Result<()> {
    if candidate.is_empty()
        || candidate.len() > 256
        || !candidate.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        bail!("native PostgreSQL needs the generated alphanumeric password");
    }
    Ok(())
}

fn set_password(password: &str) -> anyhow::Result<()> {
    let mut child = password_command()
        .spawn()
        .context("could not start native PostgreSQL password update")?;
    // Keep the generated credential out of argv and SQL error output.
    let statement = format!("ALTER ROLE postgres PASSWORD '{password}';\n");
    let written = match child.stdin.take() {
        Some(mut input) => input.write_all(statement.as_bytes()),
        None => Err(io::Error::other("missing native PostgreSQL password input")),
    };
    if let Err(error) = written {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error).context("could not send native PostgreSQL password update");
    }
    let status = child
        .wait()
        .context("could not wait for native PostgreSQL password update")?;
    if !status.success() {
        bail!(
            "setting the native PostgreSQL password failed ({status}); check local cluster connectivity and locks"
        );
    }
    Ok(())
}

/// The Postgres profile as a `conf.d` file (the Debian packaging includes it).
pub fn render_postgres_conf(profile: &str) -> String {
    format!(
        "# Postgres profile {profile} for nelcota (generated by `nelcota init`).\n{}",
        scaffold::profile_settings(profile)
            .iter()
            .map(|(k, v)| format!("{k} = '{v}'\n"))
            .collect::<String>()
    )
}

/// The 17/main cluster with the profile and the `postgres` password the
/// app's `NELCOTA_DATABASE_URL` uses (over 127.0.0.1, scram-sha-256).
pub fn configure_postgres(profile: &str, password: &str) -> anyhow::Result<()> {
    validate_password(password)?;
    step("Configuring Postgres 17");
    let mut clusters =
        inventory()?.context("pg_lsclusters not found (is postgresql-17 installed?)")?;
    validate_layout(&clusters)?;
    if !clusters.iter().any(Cluster::is_native) {
        run(
            Command::new("pg_createcluster").args(["17", "main"]),
            "pg_createcluster",
        )?;
        clusters = inventory()?.context("pg_lsclusters disappeared after cluster creation")?;
        validate_layout(&clusters)?;
    }
    if !clusters.iter().any(Cluster::is_native) {
        bail!("PostgreSQL 17/main is missing after creation; refusing native configuration");
    }
    fs::write(PG_CONF, render_postgres_conf(profile))?;
    systemctl(&["enable".into(), POSTGRES_UNIT.into()])?;
    systemctl(&["restart".into(), POSTGRES_UNIT.into()])?;
    set_password(password)?;
    ok(&format!("cluster 17/main with the {profile} profile"));
    Ok(())
}

pub(super) fn remove_cluster() -> anyhow::Result<()> {
    run(
        Command::new("pg_dropcluster").args(["17", "main", "--stop"]),
        "pg_dropcluster",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn alternate_native_port_and_foreign_default_port_are_rejected() {
        for records in [
            "17 main 5433 online postgres /owned/main /owned/main.log\n17 sentinel 5432 online postgres /owned/sentinel /owned/sentinel.log\n",
            "16 main 5432 down postgres /owned/old /owned/old.log\n",
            "17 main 5433 down postgres /owned/main /owned/main.log\n",
        ] {
            assert!(validate_layout(&parse_clusters(records).unwrap()).is_err());
        }
    }

    #[test]
    fn supported_default_and_other_unused_ports_remain_compatible() {
        for records in [
            "",
            "17 main 5432 online postgres /owned/main /owned/main.log\n",
            "17 main 5432 down postgres /owned/main /owned/main.log\n16 other 5433 online postgres /owned/other /owned/other.log\n",
            "16 other 5433 down postgres /owned/other /owned/other.log\n",
        ] {
            validate_layout(&parse_clusters(records).unwrap()).unwrap();
        }
    }

    #[test]
    fn ambiguous_and_nonfinite_inventory_cannot_enable_provisioning() {
        for records in [
            "17 main 5432\n",
            "17 main NaN online postgres /owned/main /owned/main.log\n",
            "17 main 0 online postgres /owned/main /owned/main.log\n",
            "17 main 65536 online postgres /owned/main /owned/main.log\n",
            "17 main 5432 online postgres /owned/main /owned/main.log\n17 main 5433 down postgres /owned/main /owned/main.log\n",
        ] {
            assert!(parse_clusters(records).is_err());
        }
    }

    #[test]
    fn native_clients_override_ambient_database_routing() {
        for client in ["psql", "pg_dump", "pg_restore", "pg_isready", "pgbackrest"] {
            let command = postgres_command(&[client]);
            assert_eq!(
                command.get_args().any(|argument| argument == "--cluster"),
                client != "pgbackrest"
            );
            let environment: BTreeMap<_, _> = command
                .get_envs()
                .map(|(key, value)| {
                    (
                        key.to_string_lossy().to_string(),
                        value.map(|value| value.to_string_lossy().to_string()),
                    )
                })
                .collect();
            for (key, value) in [
                ("PGCLUSTER", "17/main"),
                ("PGHOST", "/var/run/postgresql"),
                ("PGPORT", "5432"),
                ("PGUSER", "postgres"),
                ("PGDATABASE", "postgres"),
            ] {
                assert_eq!(environment.get(key), Some(&Some(value.to_owned())));
            }
            for key in ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"] {
                assert_eq!(environment.get(key), Some(&None));
            }
        }
    }

    #[test]
    fn password_update_has_no_sql_or_credential_argument() {
        let command = password_command();
        let arguments: Vec<_> = command
            .get_args()
            .map(|value| value.to_string_lossy())
            .collect();
        assert!(
            !arguments
                .iter()
                .any(|value| value.contains("ALTER ROLE") || value.as_ref() == "-c")
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair[0].as_ref() == "--cluster" && pair[1].as_ref() == "17/main")
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair[0].as_ref() == "--host"
                    && pair[1].as_ref() == "/var/run/postgresql")
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair[0].as_ref() == "--port" && pair[1].as_ref() == "5432")
        );
    }

    #[test]
    fn unsafe_password_is_rejected_before_any_native_operation() {
        assert!(validate_password("").is_err());
        for suffix in ["'", "\n", "\\", "\u{e7}"] {
            let password = crate::util::secret(42) + suffix;
            let error = configure_postgres("1gb", &password).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("generated alphanumeric password")
            );
        }
        assert!(validate_password(&crate::util::secret(257)).is_err());
        validate_password(&crate::util::secret(42)).unwrap();
    }
}
