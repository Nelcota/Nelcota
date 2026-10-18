//! Durable PITR ownership, independent of the CLI process and of PGDATA.
mod docker;
mod native;
mod verify;

use crate::{host::Runtime, naming, project::Project};
use anyhow::{Context, bail};
use nelcota_deployment::{atomic_write, read_private};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub(crate) const NATIVE_STATE: &str = "/var/lib/nelcota-pitr";
const STATE: &str = "pitr-fence";
const ACTIVE: &str = "active.json";
const RECEIPT: &str = "recovery.json";

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema: u8,
    project: String,
    directory: PathBuf,
    runtime: Runtime,
}

pub(crate) struct Fence<'a> {
    project: &'a Project,
    state: PathBuf,
    receipt: Vec<u8>,
}

fn state(project: &Project) -> PathBuf {
    match project.runtime {
        Runtime::Systemd => PathBuf::from(NATIVE_STATE),
        Runtime::Docker => project.path(STATE),
    }
}

fn present(path: &Path) -> anyhow::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => {
            Err(error).with_context(|| format!("cannot inspect PITR fence {}", path.display()))
        }
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn recovery(project: &Project) -> anyhow::Result<String> {
    let root = project
        .dir
        .parent()
        .and_then(Path::parent)
        .context("project has no host root")?;
    Ok(format!(
        "nelcota -C {} -p {} pitr recover --yes",
        quote(&root.display().to_string()),
        project.name
    ))
}

pub(crate) fn require_clear(project: &Project) -> anyhow::Result<()> {
    let directory = state(project);
    if !present(&directory.join(ACTIVE))? && !present(&directory.join(RECEIPT))? {
        return Ok(());
    }
    require_clear_at(&directory, &recovery(project)?)
}

pub(crate) fn require_clear_at(directory: &Path, command: &str) -> anyhow::Result<()> {
    for name in [ACTIVE, RECEIPT] {
        let path = directory.join(name);
        if present(&path)? {
            bail!(
                "PITR fence {} blocks startup; inspect the restore error and run `{command}` (see the backup recovery guide)",
                path.display()
            );
        }
    }
    Ok(())
}

/// Also covers a direct `serve`, outside the generated native unit.
pub(crate) fn require_native_clear() -> anyhow::Result<()> {
    require_clear_at(
        Path::new("/nelcota-pitr-fence"),
        "nelcota -C <host> -p <project> pitr recover --yes",
    )?;
    require_clear_at(
        Path::new(NATIVE_STATE),
        "nelcota -C <host> -p <project> pitr recover --yes",
    )
}

/// A readable directory permits unprivileged startup checks, never writes.
fn directory(path: &Path) -> anyhow::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => fs::File::open(path.parent().context("fence has no parent")?)?.sync_all()?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("cannot create PITR fence directory"),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("unsafe PITR fence directory {}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != fs::metadata(path.parent().context("fence has no parent")?)?.uid()
            || metadata.mode() & 0o022 != 0
        {
            bail!("unsafe PITR fence directory ownership");
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

pub(super) fn status(project: &Project) -> anyhow::Result<bool> {
    let directory = state(project);
    if !present(&directory.join(ACTIVE))? && !present(&directory.join(RECEIPT))? {
        return Ok(false);
    }
    println!(
        "PITR fence active at {}; ordinary starts are blocked. Recovery: {}",
        directory.display(),
        recovery(project)?
    );
    Ok(true)
}

impl<'a> Fence<'a> {
    fn new(project: &'a Project) -> anyhow::Result<Self> {
        naming::validate_project_name(&project.name)?;
        let receipt = serde_json::to_vec(&Receipt {
            schema: 1,
            project: project.name.clone(),
            directory: project.dir.canonicalize()?,
            runtime: project.runtime,
        })?;
        Ok(Self {
            project,
            state: state(project),
            receipt,
        })
    }

    fn owned(&self, name: &str) -> anyhow::Result<bool> {
        let path = self.state.join(name);
        if !present(&path)? {
            return Ok(false);
        }
        let metadata = fs::symlink_metadata(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != fs::metadata(&self.state)?.uid() || metadata.nlink() != 1 {
                bail!("PITR fence ownership changed; preserve diagnostics and inspect manually");
            }
        }
        if read_private(&path, 16384)? != self.receipt {
            bail!(
                "PITR fence belongs to another project/directory; preserve it and inspect manually"
            );
        }
        Ok(true)
    }

    /// Arm every boot/start adapter before pgBackRest can touch PGDATA. Never
    /// clear in Drop: interruption, including power loss, must remain fenced.
    pub(crate) fn begin(project: &'a Project) -> anyhow::Result<Self> {
        let fence = Self::new(project)?;
        directory(&fence.state)?;
        let receipt = fence.owned(RECEIPT)?;
        let active = fence.owned(ACTIVE)?;
        if receipt || active {
            super::restore::recovery::Recovery::stop_previous(project)?;
        }
        match project.runtime {
            Runtime::Systemd => native::arm(&fence)?,
            Runtime::Docker => docker::arm(&fence)?,
        }
        atomic_write(&fence.state.join(RECEIPT), &fence.receipt)?;
        atomic_write(&fence.state.join(ACTIVE), &fence.receipt)?;
        Ok(fence)
    }

    /// Called only by an explicit recovery or after verified restore promotion.
    pub(crate) fn clear_verified(&self) -> anyhow::Result<()> {
        let active = self.owned(ACTIVE)?;
        let receipt = self.owned(RECEIPT)?;
        if !active && !receipt {
            bail!("PITR fence is missing; preserve diagnostics");
        }
        match self.project.runtime {
            Runtime::Systemd => {}
            Runtime::Docker => docker::restore_compose(self)?,
        }
        // Adapters remain installed until the marker is durably removed. A
        // cleanup error never authorizes startup of an unverified directory.
        if receipt {
            fs::remove_file(self.state.join(RECEIPT))?;
        }
        fs::File::open(&self.state)?.sync_all()?;
        if active {
            fs::remove_file(self.state.join(ACTIVE))?;
        }
        fs::File::open(&self.state)?.sync_all()?;
        Ok(())
    }
}

pub(crate) fn recover(project: &Project, yes: bool) -> anyhow::Result<()> {
    let fence = Fence::new(project)?;
    let active = fence.owned(ACTIVE)?;
    let receipt = fence.owned(RECEIPT)?;
    if !active && !receipt {
        bail!(
            "no PITR fence for {}; recovery was not needed",
            project.name
        );
    }
    if !yes
        && !(crate::util::interactive()
            && crate::util::confirm(
                "Verify the stopped data directory and explicitly release its PITR fence? Use a covered restore instead if its contents are uncertain.",
            ))
    {
        bail!("recovery cancelled (use --yes to confirm)");
    }
    project.stop(&[
        crate::project::Service::App,
        crate::project::Service::Postgres,
    ])?;
    super::restore::recovery::Recovery::stop_previous(project)?;
    verify::clean_directory(project)?;
    // This recovery-only server has no TCP listener and no restart policy.
    // Keep both ordinary service entrypoints fenced while checking relations.
    let mut verification = super::restore::recovery::Recovery::start(project)?;
    super::restore::wait_for_promotion(project, &verification)?;
    verification.check_relations()?;
    verification.stop()?;
    verify::clean_directory(project)?;
    if project.runtime == Runtime::Systemd {
        crate::native::systemctl(&[
            "reset-failed".into(),
            crate::native::POSTGRES_UNIT.into(),
            crate::native::app_unit(&project.name),
        ])?;
    }
    fence.clear_verified()?;
    crate::util::ok(
        "PITR fence cleared after directory and relation verification; start the project with `nelcota up`",
    );
    Ok(())
}

pub(super) fn verify_stopped(project: &Project) -> anyhow::Result<()> {
    verify::clean_directory(project)
}

#[cfg(test)]
mod tests;
