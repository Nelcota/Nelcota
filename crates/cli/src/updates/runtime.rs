//! Runtime orchestration retains host exclusion and authoritative recovery decisions.
use crate::host::Host;
use crate::maintenance::Maintenance;
use crate::project::Project;
use crate::updates::policy::Policy;
use activation::deploy;
use anyhow::Context;
use anyhow::bail;
use nelcota_deployment::HostLock;
use nelcota_deployment::Job;
use nelcota_deployment::Journal;
use nelcota_deployment::Phase;
use recovery::recovery;
use std::path::Path;
use std::time::{Duration, Instant};

fn project(policy: &Policy, name: &str) -> anyhow::Result<(Host, Project)> {
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    if manifest.image != "ghcr.io/nelcota/nelcota-server" {
        bail!("custom images are not enrolled");
    }
    let project = host.select(&manifest, Some(name))?;
    Ok((host, project))
}
pub fn execute(policy: &Policy, id: &str, recover: bool) -> anyhow::Result<()> {
    execute_inner(policy, id, recover, false)
}

pub fn recover(policy: &Policy, id: &str, restore_snapshot: bool) -> anyhow::Result<()> {
    execute_inner(policy, id, true, restore_snapshot)
}

fn execute_inner(
    policy: &Policy,
    id: &str,
    recover: bool,
    restore_snapshot: bool,
) -> anyhow::Result<()> {
    let _lease = acquire_host_lock(&policy.root, Duration::from_secs(30))?;
    nelcota_deployment::management::ensure_idle(&policy.root)?;
    let journal = Journal::open(&policy.root)?;
    let mut job = journal
        .list()?
        .into_iter()
        .find(|job| job.public.id == id)
        .context("unknown job")?;
    let (host, project) = project(policy, &job.public.project)?;
    if restore_snapshot {
        if job.public.phase != Phase::NeedsOperator
            || !job.public.committed
            || job.restored
            || job.backup.is_none()
            || job.dump_sha256.is_none()
        {
            bail!("snapshot restore requires an interrupted committed job with a verified backup");
        }
        job.restore_requested = true;
        journal.advance(
            &mut job,
            Phase::NeedsOperator,
            Some("operator_snapshot_restore_requested"),
        )?;
    }
    if recover {
        let result = recovery(policy, &host, &project, &journal, &mut job);
        if result.is_err() {
            record_recovery_failure(&journal, &mut job)?;
        }
        return result;
    }
    if job.public.phase != Phase::Preparing {
        bail!("job already started");
    }
    let result = deploy(policy, &host, &project, &journal, &mut job);
    if result.is_err() {
        // A rename can succeed before directory fsync reports an error. Read
        // the authoritative receipt before deciding whether data can roll back.
        job = journal
            .list()?
            .into_iter()
            .find(|entry| entry.public.id == id)
            .context("deployment receipt lost; keep maintenance closed")?;
        match job.public.phase {
            Phase::Preparing => journal.advance(
                &mut job,
                Phase::FailedBeforeChange,
                Some("preparation_failed"),
            )?,
            phase if phase.terminal() => {}
            _ => {
                let _ = Maintenance::hold(&host, &project);
                journal.advance(&mut job, Phase::NeedsOperator, Some("deployment_failed"))?;
                if !job.public.committed
                    && recovery(policy, &host, &project, &journal, &mut job).is_err()
                {
                    record_recovery_failure(&journal, &mut job)?;
                }
            }
        }
    }
    result
}
/// The worker releases the host lock just before launching this process, so a
/// brief holder (an alert check, the start of a scheduled backup) can win the
/// race. Wait for it instead of failing the job; other lock errors are final.
fn acquire_host_lock(root: &Path, patience: Duration) -> anyhow::Result<HostLock> {
    let deadline = Instant::now() + patience;
    loop {
        match HostLock::acquire(root) {
            Ok(lease) => return Ok(lease),
            Err(error) if error.to_string() != "deployment_busy" || Instant::now() >= deadline => {
                return Err(error);
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}
fn record_recovery_failure(journal: &Journal, job: &mut Job) -> anyhow::Result<()> {
    *job = journal
        .list()?
        .into_iter()
        .find(|entry| entry.public.id == job.public.id)
        .context("recovery receipt lost; keep maintenance closed")?;
    if !job.public.phase.terminal() {
        journal.advance(job, Phase::NeedsOperator, Some("recovery_failed"))?;
    }
    Ok(())
}

mod activation;
mod artifacts;
mod preflight;
mod recovery;
#[cfg(test)]
mod tests;
mod validation;

pub use preflight::blockers;
pub(super) use validation::gate_path;
