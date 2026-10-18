use super::{ACTIVE, Fence, RECEIPT, directory, quote, recovery};
use crate::native;
use anyhow::{Context, bail};
use nelcota_deployment::atomic_write;
use std::{fs, path::Path};

const DROP_IN: &str = "80-nelcota-pitr-fence.conf";

pub(super) fn arm(fence: &Fence<'_>) -> anyhow::Result<()> {
    arm_at(fence, Path::new("/etc/systemd/system"))?;
    native::systemctl(&["daemon-reload".into()])
}

fn arm_at(fence: &Fence<'_>, units: &Path) -> anyhow::Result<()> {
    let message = format!(
        "PITR fence {} blocks startup; inspect the restore error and run `{}` (backup recovery guide)",
        fence.state.join(ACTIVE).display(),
        recovery(fence.project)?
    );
    let script = format!(
        "#!/bin/sh\nset -eu\nif [ -e {active} ] || [ -L {active} ] || [ -e {receipt} ] || [ -L {receipt} ]; then\n  printf '%s\\n' {message} >&2\n  exit 78\nfi\n",
        active = quote(&fence.state.join(ACTIVE).display().to_string()),
        receipt = quote(&fence.state.join(RECEIPT).display().to_string()),
        message = quote(&message)
    );
    atomic_write(&fence.state.join("check-start"), script.as_bytes())?;
    // '+' runs the read-only check with host credentials, before the app's
    // DynamicUser or PostgreSQL's service user is selected. No CLI/env bypass.
    let body = format!(
        "# Durable Nelcota PITR fence; do not remove to recover.\n[Service]\nExecStartPre=+/bin/sh {}\n",
        fence.state.join("check-start").display()
    );
    for unit in [
        native::POSTGRES_UNIT.to_owned(),
        native::app_unit(&fence.project.name),
    ] {
        let parent = units.join(format!("{unit}.service.d"));
        directory(&parent)?;
        let path = parent.join(DROP_IN);
        if super::present(&path)? {
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || fs::read(&path)? != body.as_bytes()
            {
                bail!(
                    "custom PITR start guard {}; inspect it before restoring",
                    path.display()
                );
            }
        }
        // Unit files must be readable by systemd; the script is read by root.
        atomic_write(&path, body.as_bytes())
            .with_context(|| format!("cannot persist start guard {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn arm_fixture(fence: &Fence<'_>, units: &Path) -> anyhow::Result<()> {
    arm_at(fence, units)
}
