//! Durable PITR ownership, independent of the CLI process and of PGDATA.
mod docker;
#[cfg(test)]
mod faults;
mod files;
mod native;
mod verify;

use crate::{host::Runtime, naming, project::Project};
use anyhow::{Context, bail};
use files::Directory;
#[cfg(test)]
use nelcota_deployment::atomic_write;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const NATIVE_STATE: &str = "/var/lib/nelcota-pitr";
const STATE: &str = "pitr-fence";
const ACTIVE: &str = "active.json";
const RECEIPT: &str = "recovery.json";
const RELEASED: &str = "release.verified.json";

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
    let parent = path.parent().context("PITR fence has no parent")?;
    let directory = match Directory::open(parent, false, false)? {
        Some(directory) => directory,
        None => return Ok(false),
    };
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .context("invalid PITR fence path")?;
    directory.checked(name, true)
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
    // Validate the project path too: a renamed/symlinked ancestor must not
    // redirect a subsequent Docker or filesystem operation.
    #[cfg(unix)]
    Directory::open(&project.dir, false, false)?;
    require_clear_at(&state(project), &recovery(project)?)
}

pub(crate) fn require_clear_at(directory: &Path, command: &str) -> anyhow::Result<()> {
    check_clear_at(directory, command, false)
}

pub(crate) fn require_guard_clear_at(directory: &Path, command: &str) -> anyhow::Result<()> {
    check_clear_at(directory, command, true)
}

fn check_clear_at(directory: &Path, command: &str, required: bool) -> anyhow::Result<()> {
    let opened = Directory::open(directory, false, false).with_context(|| {
        format!(
            "PITR fence {} (or {}) cannot be verified; startup refused; run `{command}`",
            directory.join(ACTIVE).display(),
            directory.join(RECEIPT).display()
        )
    })?;
    let opened = match opened {
        Some(opened) => opened,
        None if required => bail!(
            "PITR fence {} cannot be verified because its directory is missing; startup refused; run `{command}`",
            directory.join(ACTIVE).display()
        ),
        None => return Ok(()),
    };
    for name in [ACTIVE, RECEIPT] {
        if opened.checked(name, true)? {
            bail!(
                "PITR fence {} blocks startup; inspect the restore error and run `{command}` (see the backup recovery guide)",
                directory.join(name).display()
            );
        }
    }
    opened.validate_state_files()?;
    if opened.checked("compose.guarded.json", true)? && !opened.checked(RELEASED, true)? {
        bail!(
            "PITR fence {} has no committed release; run `{command}`",
            directory.display()
        );
    }
    Ok(())
}

/// Also covers a direct `serve`, outside the generated native unit.
pub(crate) fn require_native_clear() -> anyhow::Result<()> {
    let mounted = Path::new("/nelcota-pitr-fence/pitr-fence");
    if Directory::open(Path::new("/nelcota-pitr-fence"), false, true)?.is_some() {
        // Parent mount preserves visibility of a substituted state symlink.
        let candidate = match Directory::open(mounted, false, false)? {
            Some(_) => mounted,
            None => Path::new("/nelcota-pitr-fence"),
        };
        require_clear_at(
            candidate,
            "nelcota -C <host> -p <project> pitr recover --yes",
        )?;
    }
    require_clear_at(
        Path::new(NATIVE_STATE),
        "nelcota -C <host> -p <project> pitr recover --yes",
    )
}

/// A readable directory permits unprivileged startup checks, never writes.
fn directory(path: &Path) -> anyhow::Result<()> {
    Directory::open(path, true, false)?
        .context("PITR fence directory is missing")?
        .make_readable()
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
        Directory::open(&project.dir, false, false)?
            .context("PITR project directory is missing")?;
        if let Some(directory) = Directory::open(&state(project), false, false)? {
            directory.validate_state_files()?;
        }
        let receipt = serde_json::to_vec(&Receipt {
            schema: 1,
            project: project.name.clone(),
            directory: project.dir.canonicalize()?,
            runtime: project.runtime,
        })?;
        let fence = Self {
            project,
            state: state(project),
            receipt,
        };
        fence.owned(RELEASED)?;
        fence.owned(RECEIPT)?;
        fence.owned(ACTIVE)?;
        Ok(fence)
    }

    fn directory(&self) -> anyhow::Result<Directory> {
        Directory::open(&self.project.dir, false, false)?
            .context("PITR project directory is missing")?;
        let directory = Directory::required(&self.state)?;
        directory.validate_state_files()?;
        Ok(directory)
    }

    fn owned(&self, name: &str) -> anyhow::Result<bool> {
        let directory = match Directory::open(&self.state, false, false)? {
            Some(directory) => directory,
            None => return Ok(false),
        };
        directory.validate_state_files()?;
        if !directory.checked(name, true)? {
            return Ok(false);
        }
        let bytes = directory.read(name, 2 * 1024 * 1024, true)?;
        if bytes == self.receipt {
            return Ok(true);
        }
        if name == ACTIVE && self.project.runtime == Runtime::Docker {
            // The last Docker marker contains exact original Compose bytes.
            // Its identity remains bound by recovery.json or the verified
            // release receipt throughout conversion/atomic release.
            let identity = match directory.checked(RECEIPT, true)? {
                true => RECEIPT,
                false => RELEASED,
            };
            if directory.read(identity, 16384, true)? == self.receipt
                && bytes == docker::original(self)?
            {
                return Ok(true);
            }
        }
        bail!(
            "PITR fence {} belongs to another project/directory or changed; preserve all markers and inspect manually",
            self.state.join(name).display()
        );
    }

    /// Arm every boot/start adapter before pgBackRest can touch PGDATA. Never
    /// clear in Drop: interruption, including power loss, must remain fenced.
    pub(crate) fn begin(project: &'a Project) -> anyhow::Result<Self> {
        let fence = Self::new(project)?;
        if project.runtime == Runtime::Docker {
            read_compose(project)?;
        }
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
        let directory = fence.directory()?;
        directory.write(RECEIPT, &fence.receipt)?;
        let active = match project.runtime {
            Runtime::Docker => docker::original(&fence)?,
            Runtime::Systemd => fence.receipt.clone(),
        };
        directory.write(ACTIVE, &active)?;
        directory.remove(RELEASED)?;
        Ok(fence)
    }

    /// Called only by an explicit recovery or after verified restore promotion.
    pub(crate) fn clear_verified(&self) -> anyhow::Result<()> {
        let directory = self.directory()?;
        let active = self.owned(ACTIVE)?;
        let receipt = self.owned(RECEIPT)?;
        if !active && !receipt {
            return self.finish_committed_release();
        }
        self.owned(RELEASED)?;
        if self.project.runtime == Runtime::Docker {
            docker::validate_for_recovery(self)?;
            docker::require_guarded(self)?;
        }
        // Persist identity/verification BEFORE removing any startup marker.
        // This is metadata, not a startup marker. It makes retries after the
        // commit (including a subsequent fsync error) explicitly idempotent.
        directory.write(RELEASED, &self.receipt)?;
        match self.project.runtime {
            Runtime::Docker => {
                let original = docker::original(self)?;
                // Convert legacy receipt markers while a guard still blocks.
                // Any failure before the final rename leaves guarded Compose
                // AND at least active.json. The final rename is the commit:
                // it removes active.json AND installs original Compose in one
                // operation, never exposing original Compose with a marker.
                directory.write(ACTIVE, &original)?;
                directory.remove(RECEIPT)?;
                let project = Directory::open(&self.project.dir, false, false)?
                    .context("PITR project is missing")?;
                directory.move_to(ACTIVE, &project, "docker-compose.yml")?;
            }
            Runtime::Systemd => {
                // Permanent startup adapters remain installed. The final
                // unlink is the commit; every earlier failure retains a marker.
                directory.remove(RECEIPT)?;
                directory.remove(ACTIVE)?;
            }
        }
        Ok(())
    }

    fn finish_committed_release(&self) -> anyhow::Result<()> {
        let directory = self.directory()?;
        if directory.read(RELEASED, 16384, true)? != self.receipt {
            bail!(
                "PITR fence {} has no owned verified release; preserve diagnostics",
                self.state.display()
            );
        }
        if self.project.runtime == Runtime::Docker {
            docker::require_original(self)?;
        }
        Directory::open(&self.project.dir, false, false)?
            .context("PITR project is missing")?
            .sync()?;
        directory.sync()
    }
}

pub(crate) fn recover(project: &Project, yes: bool) -> anyhow::Result<()> {
    let fence = Fence::new(project)?;
    let active = fence.owned(ACTIVE)?;
    let receipt = fence.owned(RECEIPT)?;
    if !active && !receipt {
        fence.finish_committed_release()?;
        crate::util::ok(
            "PITR recovery was already committed; original startup configuration is restored",
        );
        return Ok(());
    }
    // Validate every receipt/configuration before any mutation. In particular,
    // rejected links/owners must not even stop or reconfigure services.
    fence.directory()?;
    match project.runtime {
        Runtime::Docker => docker::validate_for_recovery(&fence)?,
        Runtime::Systemd => {}
    }
    if !yes
        && !(crate::util::interactive()
            && crate::util::confirm(
                "Verify the stopped data directory and explicitly release its PITR fence? Use a covered restore instead if its contents are uncertain.",
            ))
    {
        bail!("recovery cancelled (use --yes to confirm)");
    }
    fence.directory()?.make_readable()?;
    match project.runtime {
        Runtime::Docker => docker::arm(&fence)?,
        Runtime::Systemd => native::arm(&fence)?,
    }
    files::boundary("ordinary guards armed")?;
    project.stop(&[
        crate::project::Service::App,
        crate::project::Service::Postgres,
    ])?;
    files::boundary("ordinary services stopped")?;
    super::restore::recovery::Recovery::stop_previous(project)?;
    files::boundary("previous recovery stopped")?;
    verify::clean_directory(project)?;
    files::boundary("first offline verification completed")?;
    // This recovery-only server has no TCP listener and no restart policy.
    // Keep both ordinary service entrypoints fenced while checking relations.
    let mut verification = super::restore::recovery::Recovery::start(project)?;
    files::boundary("isolated verification started")?;
    super::restore::wait_for_promotion(project, &verification)?;
    files::boundary("verification promotion completed")?;
    verification.check_relations()?;
    files::boundary("relation verification completed")?;
    verification.stop()?;
    files::boundary("isolated verification stopped")?;
    verify::clean_directory(project)?;
    files::boundary("second offline verification completed")?;
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
#[cfg(all(test, unix))]
mod transaction_tests;

pub(in crate::pitr) fn read_compose(project: &Project) -> anyhow::Result<Vec<u8>> {
    Directory::open(&project.dir, false, false)?
        .context("PITR project is missing")?
        .read("docker-compose.yml", 2 * 1024 * 1024, false)
}
