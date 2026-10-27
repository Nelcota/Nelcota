//! One entry point for verified CLI installation and the existing project upgrade.

use std::{path::PathBuf, process::Command};

use anyhow::{Context, bail};
use clap::Args;

use crate::{host::Host, native, upgrade};

const INSTALLER: &str = include_str!("../../../scripts/install.sh");

#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Stable release version (default: the latest published release).
    #[arg(long)]
    version: Option<String>,
    /// Downloads and verifies the candidate, then previews without installing.
    #[arg(long)]
    dry_run: bool,
    /// Accepts the update plan without an interactive confirmation.
    #[arg(short, long)]
    yes: bool,
}

pub fn default_dir() -> PathBuf {
    match std::path::Path::new(crate::host::MANIFEST).is_file() {
        true => PathBuf::from("."),
        false => PathBuf::from("/opt/nelcota"),
    }
}

pub fn run(host: &Host, selection: Option<&str>, args: UpdateArgs) -> anyhow::Result<()> {
    if std::env::consts::OS != "linux" {
        bail!("host updates require Linux");
    }
    host.require()?;
    upgrade::require_cli_binary()?;
    let executable = std::env::current_exe()?.canonicalize()?;
    if executable == native::deployed_binary().canonicalize().unwrap_or_default() {
        bail!("run the installed CLI (`nelcota update`), not the systemd application's binary");
    }
    if executable.file_name().is_none_or(|name| name != "nelcota") {
        bail!("run the installed CLI named `nelcota` to update it");
    }
    let prefix = executable
        .parent()
        .context("CLI has no installation folder")?;
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(INSTALLER)
        .args(["nelcota update", "--update", "--dir"])
        .arg(host.root())
        .env("PREFIX", prefix)
        .env("NELCOTA_REPO", "Nelcota/Nelcota")
        .env("NELCOTA_SKIP_DOCKER", "1")
        .env_remove("NELCOTA_VERSION");
    if let Some(project) = selection {
        command.args(["--project", project]);
    }
    if let Some(version) = &args.version {
        command.args(["--version", version]);
    }
    if args.dry_run {
        command.arg("--dry-run");
    }
    if args.yes {
        command.arg("--yes");
    }
    let status = command
        .status()
        .context("could not start the host updater")?;
    if !status.success() {
        bail!("host update did not complete; see the updater output above");
    }
    Ok(())
}
