//! Read-only checks for the packaged 17/main startup path and effective PGDATA.
use crate::native;
use anyhow::{Context, bail};
use std::{fs::File, io::Read, process::Command};

const CONFIG: &str = "/etc/postgresql/17/main/postgresql.conf";
const PG_CTL: &str = "/etc/postgresql/17/main/pg_ctl.conf";
const ENVIRONMENT: &str = "/etc/postgresql/17/main/environment";
const EXEC_START: &str = "/usr/bin/pg_ctlcluster --skip-systemctl-redirect 17-main start";

pub(super) fn validate() -> anyhow::Result<()> {
    if std::env::var_os("PG_CLUSTER_CONF_ROOT").is_some_and(|value| value != "/etc/postgresql") {
        bail!(
            "unsupported PG_CLUSTER_CONF_ROOT; supported native PITR configuration uses /etc/postgresql/17/main"
        );
    }
    let unit = Command::new("systemctl")
        .args([
            "show",
            native::POSTGRES_UNIT,
            "--property=ExecStart",
            "--property=Environment",
            "--property=EnvironmentFiles",
        ])
        .output()
        .context("cannot determine supported native PITR PostgreSQL service configuration")?;
    if !unit.status.success() || unit.stdout.len() > 16384 {
        bail!("cannot determine supported native PITR PostgreSQL service configuration");
    }
    validate_unit(
        &String::from_utf8(unit.stdout)
            .context("cannot determine supported native PostgreSQL ExecStart/Environment")?,
    )?;
    validate_options(&read_optional(PG_CTL)?, PG_CTL, "pg_ctl_options", "")?;
    validate_options(
        &read_optional(ENVIRONMENT)?,
        ENVIRONMENT,
        "PGDATA",
        native::PG_DATA,
    )?;
    // postgres itself resolves postgresql.conf, includes and auto.conf. Merely
    // checking -D is insufficient: data_directory in those files overrides it.
    let data = Command::new("runuser")
        .args([
            "-u",
            "postgres",
            "--",
            "/usr/lib/postgresql/17/bin/postgres",
            "-D",
            native::PG_DATA,
            "-c",
            &format!("config_file={CONFIG}"),
            "-C",
            "data_directory",
        ])
        .env_remove("PGDATA")
        .env_remove("PG_CLUSTER_CONF_ROOT")
        .output()
        .context("cannot determine supported native PITR data_directory")?;
    if !data.status.success() || data.stdout.len() > 4096 {
        bail!(
            "cannot determine native data_directory in {CONFIG}; supported configuration uses {}",
            native::PG_DATA
        );
    }
    validate_directory(
        &String::from_utf8(data.stdout)
            .context("cannot determine supported native PostgreSQL data_directory")?,
    )
}

fn validate_unit(text: &str) -> anyhow::Result<()> {
    let properties: Vec<_> = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.split_once('=')
                .context("cannot determine supported native PostgreSQL service properties")
        })
        .collect::<anyhow::Result<_>>()?;
    if properties.len() != 3 {
        bail!(
            "cannot determine supported native PostgreSQL ExecStart/Environment/EnvironmentFiles"
        );
    }
    for key in ["ExecStart", "Environment", "EnvironmentFiles"] {
        let values: Vec<_> = properties
            .iter()
            .filter(|(name, _)| *name == key)
            .map(|(_, value)| *value)
            .collect();
        if values.len() != 1 {
            bail!("cannot determine supported native PostgreSQL {key}");
        }
        let value = values[0];
        if key == "ExecStart" {
            let argv: Vec<_> = value
                .split(" ; ")
                .filter_map(|part| part.strip_prefix("argv[]="))
                .collect();
            if value.matches("path=").count() != 1
                || !value.starts_with("{ path=/usr/bin/pg_ctlcluster ; ")
                || argv.as_slice() != [EXEC_START]
            {
                bail!(
                    "unsupported native PostgreSQL ExecStart; supported configuration is {EXEC_START}"
                );
            }
            continue;
        }
        if !value.is_empty() {
            bail!(
                "unsupported native PostgreSQL {key}; supported configuration uses the packaged 17/main unit without environment overrides"
            );
        }
    }
    Ok(())
}

fn read_optional(path: &str) -> anyhow::Result<String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => {
            return Err(error).with_context(|| {
                format!("cannot determine supported native PITR settings in {path}")
            });
        }
    };
    let mut text = String::new();
    file.take(16385)
        .read_to_string(&mut text)
        .with_context(|| format!("cannot determine supported native PITR settings in {path}"))?;
    if text.len() > 16384 {
        bail!("cannot determine supported native PITR settings: {path} exceeds its limit");
    }
    Ok(text)
}

fn validate_options(text: &str, path: &str, key: &str, supported: &str) -> anyhow::Result<()> {
    let lines: Vec<_> = text
        .lines()
        .map(|line| line.split('#').next().unwrap_or("").trim())
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return Ok(());
    }
    if let [line] = lines.as_slice()
        && let Some((name, value)) = line.split_once('=')
        && name.trim() == key
        && [
            supported.to_owned(),
            format!("'{supported}'"),
            format!("\"{supported}\""),
        ]
        .contains(&value.trim().to_owned())
    {
        return Ok(());
    }
    bail!(
        "unsupported {path} {key}; supported native PITR configuration has {key}={supported:?} or no override"
    )
}

fn validate_directory(value: &str) -> anyhow::Result<()> {
    if value.trim() != native::PG_DATA {
        bail!(
            "unsupported {CONFIG} data_directory; supported native PITR configuration uses {}",
            native::PG_DATA
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(args: &str) -> String {
        format!(
            "Environment=\nEnvironmentFiles=\nExecStart={{ path=/usr/bin/pg_ctlcluster ; argv[]={args} ; ignore_errors=yes ; pid=0 ; }}\n"
        )
    }

    #[test]
    fn packaged_native_startup_and_default_directory_are_supported() {
        validate_unit(&unit(EXEC_START)).unwrap();
        for text in ["", "# packaged defaults\n", "pg_ctl_options = ''\n"] {
            validate_options(text, PG_CTL, "pg_ctl_options", "").unwrap();
        }
        for text in [
            "",
            "# inherited locale\n",
            "PGDATA='/var/lib/postgresql/17/main'\n",
        ] {
            validate_options(text, ENVIRONMENT, "PGDATA", native::PG_DATA).unwrap();
        }
        validate_directory("/var/lib/postgresql/17/main\n").unwrap();
    }

    #[test]
    fn native_command_environment_and_effective_directory_overrides_are_refused() {
        for args in [
            "/usr/bin/pg_ctlcluster --skip-systemctl-redirect 17-main start -- -D /other",
            "/usr/bin/pg_ctlcluster --skip-systemctl-redirect 17-main start -o -cconfig_file=/other",
            "/usr/bin/pg_ctlcluster --skip-systemctl-redirect 17-other start",
        ] {
            assert!(validate_unit(&unit(args)).is_err());
        }
        assert!(
            validate_unit(
                &unit(EXEC_START)
                    .replace("Environment=", "Environment=PG_CLUSTER_CONF_ROOT=/other")
            )
            .is_err()
        );
        assert!(
            validate_unit(
                &unit(EXEC_START).replace("EnvironmentFiles=", "EnvironmentFiles=/other")
            )
            .is_err()
        );
        assert!(validate_unit("ExecStart=\n").is_err());
        assert!(validate_unit(&format!("{}unparsed\n", unit(EXEC_START))).is_err());
        for value in ["/other", "", "/var/lib/postgresql/17/main\n/other"] {
            assert!(validate_directory(value).is_err());
        }
        for text in [
            "pg_ctl_options = '-D /other'",
            "pg_ctl_options = '-o -cconfig_file=/other'",
            "unresolved",
            "pg_ctl_options=''\npg_ctl_options=''",
        ] {
            assert!(validate_options(text, PG_CTL, "pg_ctl_options", "").is_err());
        }
        for text in [
            "PGDATA=/other",
            "PGDATA=",
            "PGDATA=${PGDATA}",
            "PG_CLUSTER_CONF_ROOT=/other",
        ] {
            assert!(validate_options(text, ENVIRONMENT, "PGDATA", native::PG_DATA).is_err());
        }
    }
}
