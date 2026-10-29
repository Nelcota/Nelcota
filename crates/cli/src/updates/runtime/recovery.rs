//! Resume and restore decisions from authoritative deployment receipts.
use super::artifacts::restore_previous_artifacts;
use super::artifacts::write_gate;
use super::validation::gate_path;
use super::validation::resume_previous_gate;
use super::validation::validate_identity;
use super::validation::validate_previous;
use super::validation::wait_ready;
use crate::backup;
use crate::host::Host;
use crate::maintenance::Maintenance;
use crate::project::Project;
use crate::project::Service;
use crate::updates::policy::Policy;
use anyhow::Context;
use anyhow::bail;
use nelcota_deployment::Job;
use nelcota_deployment::Journal;
use nelcota_deployment::Phase;
use nelcota_deployment::digest_file;
use std::path::Path;
use std::time::Duration;

pub(super) fn recovery(
    _policy: &Policy,
    host: &Host,
    project: &Project,
    journal: &Journal,
    job: &mut Job,
) -> anyhow::Result<()> {
    if job.public.phase.terminal() {
        return Ok(());
    }
    if !job.public.committed
        && (job.public.phase == Phase::Preparing || job.interrupted_phase == Some(Phase::Preparing))
    {
        return journal.advance(
            job,
            Phase::FailedBeforeChange,
            Some("preparation_interrupted"),
        );
    }
    let gate = Maintenance::hold(host, project)?;
    if job.public.committed && (job.restored || !job.restore_requested) {
        if job.restored {
            let dir = journal.directory(&job.public.id)?;
            restore_previous_artifacts(project, job, &dir)?;
            resume_previous_gate(project)?;
            project.recreate(Service::App)?;
            project.wait_healthy(Service::App, Duration::from_secs(120))?;
            validate_previous(project, job, &dir)?;
            if job.public.phase != Phase::ResumingPrevious {
                journal.advance(job, Phase::ResumingPrevious, None)?;
            }
            wait_ready(project)?;
            gate.finish()?;
            return journal.advance(job, Phase::Recovered, None);
        }
        project.recreate(Service::App)?;
        project.wait_healthy(Service::App, Duration::from_secs(120))?;
        validate_identity(project, job)?;
        if job.public.phase != Phase::Committing {
            journal.advance(job, Phase::Committing, None)?;
        }
        write_gate(
            &gate_path(project)?,
            format!("COMMITTED {}\n", job.public.id).as_bytes(),
        )?;
        wait_ready(project)?;
        gate.finish()?;
        return journal.advance(job, Phase::Succeeded, None);
    }
    if job.backup.is_none()
        && matches!(
            job.interrupted_phase,
            Some(Phase::BackupVerified | Phase::Activating | Phase::Validating)
        )
    {
        bail!("missing deployment snapshot");
    }
    if job.public.phase != Phase::Recovering {
        journal.advance(job, Phase::Recovering, None)?;
    }
    let dir = journal.directory(&job.public.id)?;
    project.stop(&[Service::App])?;
    if let Some(dump) = &job.backup {
        let dump = Path::new(dump);
        if dump.parent() != Some(project.path("backups").as_path())
            || digest_file(dump, u64::MAX - 1)?
                != job
                    .dump_sha256
                    .as_deref()
                    .context("missing backup identity")?
        {
            bail!("backup verification failed");
        }
        if project.stores_files_on_disk()? {
            if digest_file(
                &backup::bundle_path(dump)?.join("manifest.json"),
                16 * 1024 * 1024,
            )? != job
                .files_manifest_sha256
                .as_deref()
                .context("missing file snapshot identity")?
            {
                bail!("snapshot manifest changed");
            }
            let manifest = backup::validate(dump)?;
            backup::restore_files(project, dump, &manifest)?;
        }
        backup::restore_dump(project, dump)?;
    }
    restore_previous_artifacts(project, job, &dir)?;
    job.restored = true;
    if job.backup.is_none() {
        // No activation was possible without a durable snapshot. Retrying this
        // path may restart the old app, but never restores database/file bytes.
        resume_previous_gate(project)?;
        project.recreate(Service::App)?;
        project.wait_healthy(Service::App, Duration::from_secs(120))?;
        validate_previous(project, job, &dir)?;
        wait_ready(project)?;
        gate.finish()?;
        return journal.advance(
            job,
            Phase::FailedBeforeChange,
            Some("deployment_failed_before_change"),
        );
    }
    journal.advance(job, Phase::ResumingPrevious, None)?;
    resume_previous_gate(project)?;
    project.recreate(Service::App)?;
    project.wait_healthy(Service::App, Duration::from_secs(120))?;
    validate_previous(project, job, &dir)?;
    wait_ready(project)?;
    gate.finish()?;
    journal.advance(job, Phase::Recovered, None)
}
