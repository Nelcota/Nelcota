//! Durable host task execution and recovery with injectable effects.
use super::effects::approved_backup;
use super::effects::backup_identity;
use super::effects::{Effects, changed, require_identity, verify_https, verify_image};
use super::policy::control_project;
use super::policy::validate_policy;
use super::preflight::blockers;
use super::routine;
use super::settings;
use crate::backup;
use crate::caddy;
use crate::host::Host;
use crate::host::ProjectEntry;
use crate::host::Runtime;
use crate::project::Project;
use crate::project::Service;
use crate::registry;
use crate::scaffold;
use crate::updates::policy::Policy;
use anyhow::Context;
use anyhow::bail;
use nelcota_deployment::HostLock;
use nelcota_deployment::Journal;
use nelcota_deployment::atomic_write;
use nelcota_deployment::digest_file;
use nelcota_deployment::management::HostJournal;
use nelcota_deployment::management::Operation;
use nelcota_deployment::management::Stage;
use nelcota_deployment::management::Task;
use nelcota_deployment::read_private;
use std::fs;
use std::path::Path;

pub fn execute(policy: &Policy, id: &str, recover: bool) -> anyhow::Result<()> {
    execute_with(policy, id, recover, &Native)
}
pub(super) fn execute_with(
    policy: &Policy,
    id: &str,
    recover: bool,
    effects: &impl Effects,
) -> anyhow::Result<()> {
    let _lease = HostLock::acquire(&policy.root)?;
    if Journal::open(&policy.root)?
        .list()?
        .iter()
        .any(|j| !j.public.phase.terminal())
    {
        bail!("update needs recovery first");
    }
    let journal = HostJournal::open(&policy.root)?;
    let mut task = journal
        .list()?
        .into_iter()
        .find(|t| t.public.id == id)
        .context("host job missing")?;
    if task.public.stage.terminal() {
        return Ok(());
    }
    if recover {
        if !matches!(task.public.stage, Stage::NeedsAttention | Stage::Accepted) {
            bail!("recovery not required");
        }
        let next = task.interrupted.unwrap_or(Stage::Validating);
        journal.advance(&mut task, next, None)?;
    }
    if !recover && task.public.stage != Stage::Accepted {
        bail!("host job already started");
    }
    if !policy
        .operators
        .iter()
        .any(|o| o.email == task.actor && o.manage_host)
    {
        bail!("host authority revoked");
    }
    let result = apply_with(policy, &journal, &mut task, effects);
    if result.is_err() {
        task = journal
            .list()?
            .into_iter()
            .find(|t| t.public.id == id)
            .context("host receipt lost")?;
        if !task.public.stage.terminal() {
            let stage = match task.public.changed {
                true => Stage::NeedsAttention,
                false => Stage::Failed,
            };
            let code = result
                .as_ref()
                .err()
                .map(settings::error_code)
                .unwrap_or("operation_failed");
            journal.advance(&mut task, stage, Some(code))?;
        }
    }
    result
}
pub(super) fn apply_with(
    policy: &Policy,
    journal: &HostJournal,
    task: &mut Task,
    effects: &impl Effects,
) -> anyhow::Result<()> {
    let p = policy
        .host_management
        .as_ref()
        .context("host management disabled")?;
    validate_policy(p)?;
    let host = Host::new(&policy.root);
    let op = task.public.operation.clone();
    let name = op.project();
    let dir = journal.directory(&task.public.id)?;
    if task.public.stage == Stage::Accepted {
        journal.advance(task, Stage::Validating, None)?;
    }
    if !task.public.changed {
        if digest_file(&policy.root.join(crate::host::MANIFEST), 1024 * 1024)? != task.manifest_sha
        {
            bail!("host changed after approval");
        }
        if let Some(expected) = &task.env_sha {
            let project = control_project(policy, name)?;
            if digest_file(&project.path(".env"), 65536)? != *expected {
                bail!("project changed after approval");
            }
        }
    }
    if !matches!(
        op,
        Operation::Create { .. }
            | Operation::Backup { .. }
            | Operation::Restore { .. }
            | Operation::Remove { .. }
    ) {
        if let Some(expected) = &task.host_env_sha
            && digest_file(host.secrets().path(), 65536)? != *expected
            && !task.public.changed
        {
            bail!("host configuration changed after approval");
        }
        return routine::execute(policy, journal, task, effects);
    }
    match op.clone() {
        Operation::Create {
            project,
            domain,
            profile,
        } => {
            if task.version != p.version || task.image_digest != p.image_digest {
                bail!("creation image approval changed");
            }
            if !task.public.changed {
                let blocked = effects.preflight(policy, &op)?;
                if blocked
                    .iter()
                    .any(|b| !matches!(b.as_str(), "host_busy" | "history_full"))
                {
                    bail!("creation preflight changed");
                }
                effects.verify_image(policy, &dir)?;
                changed(journal, task, Stage::Provisioning)?;
            }
            if task.public.stage == Stage::Verifying {
                let target = control_project(policy, &project)?;
                require_identity(&target, task)?;
                target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
                effects.verify_https(policy, &target)?;
                return effects.finish(journal, task);
            }
            let entry = ProjectEntry {
                name: project.clone(),
                domain,
            };
            let mut manifest = host.require()?;
            let target = host.project(&manifest, &entry);
            if !target.dir.exists() {
                nelcota_deployment::private_dir(&target.dir)?;
                atomic_write(&target.path(".host-job-id"), task.public.id.as_bytes())?;
            }
            if read_private(&target.path(".host-job-id"), 64)? != task.public.id.as_bytes() {
                bail!("creation directory ownership changed");
            }
            if !target.path(".env").exists() {
                scaffold::create(
                    &host,
                    &scaffold::NewProject {
                        entry: &entry,
                        runtime: Runtime::Docker,
                        profile: &profile,
                        image: &manifest.image,
                        version: &task.version,
                    },
                )?;
            }
            if !target.path("docker-compose.yml").exists() {
                bail!("partial scaffold needs SSH inspection");
            }
            target.env().set("NELCOTA_APP_IMAGE", &effects.image(p))?;
            let compose = fs::read_to_string(target.path("docker-compose.yml"))?.replace(
                "image: ${NELCOTA_IMAGE}:${NELCOTA_VERSION}",
                "image: ${NELCOTA_APP_IMAGE:-${NELCOTA_IMAGE}:${NELCOTA_VERSION}}",
            );
            atomic_write(&target.path("docker-compose.yml"), compose.as_bytes())?;
            atomic_write(
                &target.path(".deployment-project-id"),
                task.identity.as_bytes(),
            )?;
            crate::panel_login::apply(&host, &manifest, &target)?;
            journal.advance(task, Stage::Starting, None)?;
            caddy::ensure_network()?;
            effects.prepare(&target)?;
            target.up()?;
            target.wait_healthy(Service::Postgres, crate::lifecycle::HEALTH_TIMEOUT)?;
            target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
            changed(journal, task, Stage::Applying)?;
            if !manifest.projects.iter().any(|e| e.name == project) {
                manifest.projects.push(entry);
                host.save(&manifest)?;
            }
            policy.record_identity(&project, &task.identity, false)?;
            effects.publish(&host)?;
            journal.advance(task, Stage::Verifying, None)?;
            effects.verify_https(policy, &target)?;
        }
        Operation::Backup { .. } => {
            let target = control_project(policy, name)?;
            require_identity(&target, task)?;
            if task.public.stage == Stage::Verifying {
                let file = task
                    .public
                    .backup
                    .as_ref()
                    .context("backup receipt missing")?;
                backup::validate(&approved_backup(policy, name, file)?)?;
                return effects.finish(journal, task);
            }
            journal.advance(task, Stage::BackingUp, None)?;
            let dump = backup::run(&host, &target, false, None)?;
            backup::validate(&dump)?;
            task.public.backup = Some(
                dump.file_name()
                    .context("backup name missing")?
                    .to_string_lossy()
                    .into_owned(),
            );
            journal.advance(task, Stage::Verifying, None)?;
        }
        Operation::Restore { backup: file, .. } => {
            let target = control_project(policy, name)?;
            require_identity(&target, task)?;
            if task.public.stage == Stage::Verifying {
                target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
                if target.path(crate::maintenance::MARKER).exists() {
                    effects.resume(&host, &target)?;
                }
                return effects.finish(journal, task);
            }
            let source = approved_backup(policy, name, &file)?;
            if task.backup_sha.as_ref() != Some(&backup_identity(&source)?) {
                bail!("approved backup changed");
            }
            let bundle = backup::validate(&source)?;
            changed(journal, task, Stage::BackingUp)?;
            effects.pause(&host, &target)?;
            if task.public.stage != Stage::Verifying {
                changed(journal, task, Stage::BackingUp)?;
                target.stop(&[Service::App])?;
                if task.public.backup.is_none() {
                    let safety = backup::run(&host, &target, false, None)?;
                    task.public.backup = Some(
                        safety
                            .file_name()
                            .context("safety backup name")?
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
                let safety = task
                    .public
                    .backup
                    .as_ref()
                    .context("safety backup missing")?;
                backup::validate(&approved_backup(policy, name, safety)?)?;
                journal.advance(task, Stage::Applying, None)?;
                backup::restore_files(&target, &source, &bundle)?;
                backup::restore_dump(&target, &source)?;
                target.start(&[Service::App])?;
                target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
                journal.advance(task, Stage::Verifying, None)?;
            }
            effects.resume(&host, &target)?;
        }
        Operation::Remove { .. } => {
            let mut manifest = host.require()?;
            let target = Project::new(name, &host.project_dir(name), Runtime::Docker);
            if target.dir.exists() {
                if read_private(&target.path(".deployment-project-id"), 64)?
                    != task.identity.as_bytes()
                {
                    bail!("removal project identity changed");
                }
                if task.public.backup.is_none() {
                    control_project(policy, name)?;
                    changed(journal, task, Stage::BackingUp)?;
                    effects.pause(&host, &target)?;
                    target.stop(&[Service::App])?;
                    let dump = backup::run(&host, &target, false, None)?;
                    backup::validate(&dump)?;
                    nelcota_deployment::private_dir(&host.archive_dir())?;
                    let file = dump
                        .file_name()
                        .context("archive filename")?
                        .to_string_lossy()
                        .into_owned();
                    let archived = host.archive_dir().join(&file);
                    backup::archive(&dump, &archived)?;
                    backup::validate(&archived)?;
                    task.public.backup = Some(file);
                    changed(journal, task, Stage::Applying)?;
                }
                backup::validate(
                    &host.archive_dir().join(
                        task.public
                            .backup
                            .as_ref()
                            .context("final backup missing")?,
                    ),
                )?;
                crate::migration_backup::install::remove(&target)?;
                target.down(true)?;
                // Keep configuration and diagnostics privately with the final paired backup.
                let retired = host
                    .archive_dir()
                    .join(format!("project-{}-{}", name, task.public.id));
                if retired.exists() {
                    bail!("retired directory conflict");
                }
                fs::rename(&target.dir, &retired)?;
                fs::File::open(host.project_dir(name).parent().context("project parent")?)?
                    .sync_all()?;
                fs::File::open(host.archive_dir())?.sync_all()?;
            }
            if task.public.backup.is_none() {
                bail!("no verified final backup; removal blocked");
            }
            backup::validate(
                &host.archive_dir().join(
                    task.public
                        .backup
                        .as_ref()
                        .context("final backup missing")?,
                ),
            )?;
            policy.record_identity(name, &task.identity, true)?;
            manifest.projects.retain(|p| p.name != name);
            host.save(&manifest)?;
            effects.publish(&host)?;
            journal.advance(task, Stage::Verifying, None)?;
        }
        _ => bail!("invalid management action"),
    }
    effects.finish(journal, task)
}

pub(super) struct Native;
impl Effects for Native {
    fn preflight(&self, p: &Policy, op: &Operation) -> anyhow::Result<Vec<String>> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(blockers(p, op))
    }
    fn verify_image(&self, p: &Policy, dir: &Path) -> anyhow::Result<()> {
        verify_image(p, dir)
    }
    fn publish(&self, host: &Host) -> anyhow::Result<()> {
        let manifest = host.require()?;
        registry::write(host, &manifest)?;
        caddy::write(host, &manifest)?;
        caddy::reload(host, manifest.runtime)
    }
    fn verify_https(&self, p: &Policy, target: &Project) -> anyhow::Result<()> {
        verify_https(p, target)
    }
}
