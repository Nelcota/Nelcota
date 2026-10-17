//! Supported-machine validation and package installation.
use super::unit_state;
use crate::{
    project::run,
    util::{ok, step},
};
use anyhow::bail;
use std::{fs, process::Command};

/// Linux, root, and apt on Debian or Ubuntu.
pub fn check_machine() -> anyhow::Result<()> {
    if !cfg!(target_os = "linux") {
        bail!("--runtime systemd needs a Linux machine (Debian or Ubuntu)");
    }
    let root = Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "0");
    if !root {
        bail!("--runtime systemd installs packages and services: run it as root");
    }
    let release = fs::read_to_string("/etc/os-release").unwrap_or_default();
    let supported = release.lines().any(|l| {
        matches!(
            l,
            "ID=debian" | "ID=ubuntu" | "ID_LIKE=debian" | "ID_LIKE=\"ubuntu debian\""
        )
    });
    if !supported || Command::new("apt-get").arg("--version").output().is_err() {
        bail!("--runtime systemd supports Debian and Ubuntu (apt); use Docker elsewhere");
    }
    if unit_state("systemd-journald").is_none() {
        bail!("systemd is not running on this machine");
    }
    super::postgres::check_cluster_layout()?;
    ok("Debian/Ubuntu with systemd, as root");
    Ok(())
}

/// Postgres 17 + pgBackRest (PGDG) and Caddy (its apt repository).
pub fn install_packages() -> anyhow::Result<()> {
    step("Installing Postgres 17, pgBackRest and Caddy (apt)");
    let script = r#"set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg postgresql-common
if ! ls /etc/apt/sources.list.d/ | grep -q pgdg; then
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
fi
if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
fi
apt-get install -y -q postgresql-17 pgbackrest caddy
"#;
    run(
        Command::new("sh").args(["-c", script]),
        "the package installation",
    )?;
    ok("packages installed");
    Ok(())
}
