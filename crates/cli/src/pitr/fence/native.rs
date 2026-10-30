use super::{Fence, files::Directory, recovery};
use crate::native;
use anyhow::{Context, bail};
use std::{
    path::Path,
    process::{Command, Stdio},
};

const GUARD: &str = "/usr/local/lib/nelcota/pitr-check";
const DROP_IN: &str = "80-nelcota-pitr-fence.conf";

mod preflight;

pub(super) fn preflight_target() -> anyhow::Result<()> {
    preflight::validate()
}

pub(super) fn arm(fence: &Fence<'_>) -> anyhow::Result<()> {
    preflight_target()?;
    // Require the installed artifact to understand the new check-only guard.
    // An older binary is refused before replacing any start adapter or data.
    let library = Directory::required(Path::new("/usr/local/lib/nelcota"))?;
    library.checked("nelcota", false)?;
    library.checked("pitr-check", true)?;
    let status = Command::new(native::deployed_binary())
        .args(["guarded-serve", "--check-only", "--check-support"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        bail!("PITR fence requires the matching installed app binary; upgrade it before recovery");
    }
    preflight(fence, Path::new("/etc/systemd/system"))?;
    library.install_guard("nelcota", "pitr-check")?;
    arm_at(fence, Path::new("/etc/systemd/system"))?;
    native::systemctl(&["daemon-reload".into()])
}

fn preflight(fence: &Fence<'_>, units: &Path) -> anyhow::Result<(Vec<std::path::PathBuf>, String)> {
    fence.directory()?;
    let command = recovery(fence.project)?;
    // systemd quoting is independent of shell quoting. The executable and
    // state path are fixed native paths, and no shell reads a state script.
    let escaped = command
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    let body = format!(
        "# Durable Nelcota PITR fence; do not remove to recover.\n[Service]\nExecStartPre=+{} guarded-serve --check-only --state {} --recovery \"{}\"\n",
        GUARD,
        fence.state.display(),
        escaped
    );
    let paths: Vec<_> = [
        native::POSTGRES_UNIT.to_owned(),
        native::app_unit(&fence.project.name),
    ]
    .iter()
    .map(|unit| units.join(format!("{unit}.service.d")))
    .collect();
    // Preflight ALL existing adapters before creating or changing any of them.
    for parent in &paths {
        if let Some(directory) = Directory::open(parent, false, false)?
            && directory.checked(DROP_IN, true)?
        {
            let old = directory.read(DROP_IN, 16384, true)?;
            let legacy = format!(
                "# Durable Nelcota PITR fence; do not remove to recover.\n[Service]\nExecStartPre=+/bin/sh {}\n",
                fence.state.join("check-start").display()
            );
            if old != body.as_bytes() && old != legacy.as_bytes() {
                bail!(
                    "PITR fence rejects modified start guard {}; preserve all markers",
                    parent.join(DROP_IN).display()
                );
            }
        }
    }
    Ok((paths, body))
}

fn arm_at(fence: &Fence<'_>, units: &Path) -> anyhow::Result<()> {
    let (paths, body) = preflight(fence, units)?;
    for parent in &paths {
        Directory::open(parent, true, false)?
            .context("PITR unit directory is missing")?
            .write(DROP_IN, body.as_bytes())?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
pub(super) fn arm_fixture(fence: &Fence<'_>, units: &Path) -> anyhow::Result<()> {
    arm_at(fence, units)
}
