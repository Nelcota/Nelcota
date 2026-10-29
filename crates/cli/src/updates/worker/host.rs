//! Authenticated IPC adapters; accepted effects run outside the HTTP lifetime.
use super::super::management;
use super::{State, error, policy_current};
use anyhow::{Context, bail};
use nelcota_deployment::management::{
    HostJournal, Operation, Plan as HostPlan, PublicJob as HostJob, Stage, Task,
};
use nelcota_deployment::{
    HostLock,
    protocol::{Request, Response},
    token, valid_digest,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
pub(super) struct StoredPlan {
    public: HostPlan,
    operator: usize,
    expires: Instant,
    manifest_sha: String,
    env_sha: Option<String>,
    identity: String,
    backup_sha: Option<String>,
    host_env_sha: Option<String>,
    configuration: Option<management::settings::Prepared>,
}
async fn reauthenticate(
    state: &Arc<State>,
    index: usize,
    password: String,
    session: &str,
) -> anyhow::Result<()> {
    if password.len() > 1024
        || !state.attempt_login()
        || !state
            .passwords
            .verify(
                password,
                Some(state.policy.operators[index].password_hash.clone()),
            )
            .await
    {
        bail!("reauthentication_failed");
    }
    if !policy_current(state)? || state.operator(session)? != index {
        bail!("policy_changed");
    }
    Ok(())
}
pub(super) async fn dispatch(state: &Arc<State>, request: Request) -> anyhow::Result<Response> {
    let session = match &request {
        Request::HostAlerts { token }
        | Request::HostDiagnostics { token, .. }
        | Request::HostConfiguration { token, .. }
        | Request::HostConfigurePlan { token, .. }
        | Request::HostStatus { token, .. }
        | Request::HostPlan { token, .. }
        | Request::HostStart { token, .. }
        | Request::HostRecover { token, .. }
        | Request::HostLogs { token, .. } => token,
        _ => bail!("invalid host action"),
    };
    let index = match state.operator(session) {
        Ok(index) => index,
        Err(_) => return Ok(error("session_expired")),
    };
    if !state.policy.operators[index].manage_host || state.policy.host_management.is_none() {
        return Ok(error("host_forbidden"));
    }
    let mut configuration = None;
    let request = match request {
        Request::HostConfigurePlan {
            token,
            project,
            configuration: input,
        } => {
            let permit = state
                .preflights
                .clone()
                .try_acquire_owned()
                .context("host_read_busy")?;
            let policy = state.policy.clone();
            let name = project.clone();
            let prepared = match tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let _lease = HostLock::acquire(&policy.root)?;
                management::settings::prepare(&policy, &name, input)
            })
            .await?
            {
                Ok(prepared) => prepared,
                Err(reason) => return Ok(error(management::settings::error_code(&reason))),
            };
            let operation = Operation::Configure {
                project,
                section: prepared.section,
                revision: prepared.revision.clone(),
            };
            configuration = Some(prepared);
            Request::HostPlan { token, operation }
        }
        other => other,
    };
    match request {
        Request::HostAlerts { .. } => {
            let _permit = state
                .host_reads
                .clone()
                .try_acquire_owned()
                .context("host_read_busy")?;
            Ok(Response::HostAlerts {
                data: super::super::alerts::status(&state.policy)?,
            })
        }
        Request::HostDiagnostics { project, .. } => {
            let _permit = state
                .host_reads
                .clone()
                .try_acquire_owned()
                .context("host_read_busy")?;
            let data = tokio::time::timeout(
                Duration::from_secs(18),
                management::diagnostics(&state.policy, &project),
            )
            .await
            .context("diagnostics_timeout")??;
            Ok(Response::HostDiagnostics { data })
        }
        Request::HostConfiguration { project, .. } => {
            let _permit = state
                .host_reads
                .clone()
                .try_acquire_owned()
                .context("host_read_busy")?;
            Ok(Response::HostConfiguration {
                data: management::settings::view(&state.policy, &project)?,
            })
        }
        Request::HostStatus { key, .. } => {
            let _permit = state
                .host_reads
                .clone()
                .try_acquire_owned()
                .context("host_read_busy")?;
            let mut data = management::status(&state.policy).await?;
            if let Some(key) = key {
                if !valid_digest(&key) {
                    return Ok(error("invalid_request"));
                }
                let find = || -> anyhow::Result<_> {
                    Ok(HostJournal::open(&state.policy.root)?
                        .list()?
                        .into_iter()
                        .find(|t| t.key == key && t.actor == state.policy.operators[index].email)
                        .map(|t| t.public))
                };
                data.receipt = find()?;
                if data.receipt.is_none() {
                    let _lease = HostLock::acquire(&state.policy.root)?;
                    data.receipt = find()?;
                }
            }
            Ok(Response::HostStatus { data })
        }
        Request::HostLogs {
            project, service, ..
        } => {
            let _permit = state
                .host_reads
                .clone()
                .try_acquire_owned()
                .context("host_read_busy")?;
            Ok(Response::HostLogs {
                data: management::logs(&state.policy, &project, service).await?,
            })
        }
        Request::HostPlan { operation, .. } => {
            let _permit = state
                .preflights
                .clone()
                .try_acquire_owned()
                .context("host_read_busy")?;
            operation.validate()?;
            if matches!(operation, Operation::Configure { .. }) && configuration.is_none() {
                return Ok(error("configuration_input_required"));
            }
            let p = state
                .policy
                .host_management
                .as_ref()
                .context("management disabled")?;
            let blockers = management::blockers(&state.policy, &operation).await?;
            let manifest_sha = nelcota_deployment::digest_file(
                &state.policy.root.join(crate::host::MANIFEST),
                1024 * 1024,
            )?;
            let (env_sha, identity) = match &operation {
                Operation::Create { .. } => (None, token()?),
                _ => match management::control_project(&state.policy, operation.project()) {
                    Ok(project) => (
                        Some(nelcota_deployment::digest_file(
                            &project.path(".env"),
                            65536,
                        )?),
                        String::from_utf8(nelcota_deployment::read_private(
                            &project.path(".deployment-project-id"),
                            64,
                        )?)?,
                    ),
                    Err(_) => (None, token()?),
                },
            };
            let backup_sha = match &operation {
                Operation::Restore { project, backup } => {
                    management::approved_backup(&state.policy, project, backup)
                        .and_then(|path| management::backup_identity(&path))
                        .ok()
                }
                _ => None,
            };
            let affected_projects = match &configuration {
                Some(c)
                    if matches!(
                        c.section,
                        nelcota_deployment::operations::Section::Alerts
                            | nelcota_deployment::operations::Section::Backup
                            | nelcota_deployment::operations::Section::Schedule
                    ) =>
                {
                    crate::host::Host::new(&state.policy.root)
                        .require()?
                        .projects
                        .into_iter()
                        .map(|p| p.name)
                        .collect()
                }
                Some(c) => c.restarts.clone(),
                None if matches!(operation, Operation::TestAlerts { .. }) => {
                    crate::host::Host::new(&state.policy.root)
                        .require()?
                        .projects
                        .into_iter()
                        .map(|p| p.name)
                        .collect()
                }
                None => vec![operation.project().to_owned()],
            };
            let public = HostPlan {
                affected_projects,
                id: token()?,
                confirmation: operation.confirmation(),
                destructive: operation.destructive(),
                operation,
                expires_at: nelcota_deployment::management::now()? + 300,
                version: p.version.clone(),
                image_digest: p.image_digest.clone(),
                blockers,
                ram_mb: crate::checks::total_ram_mb().unwrap_or(0),
                free_bytes: management::free_bytes(&state.policy.root),
                project_count: crate::host::Host::new(&state.policy.root)
                    .require()?
                    .projects
                    .len(),
            };
            let mut plans = state
                .host_plans
                .lock()
                .map_err(|_| anyhow::anyhow!("host plans unavailable"))?;
            plans.retain(|_, p| p.expires > Instant::now());
            if plans.len() >= 32 {
                return Ok(error("plan_limit"));
            }
            plans.insert(
                public.id.clone(),
                StoredPlan {
                    public: public.clone(),
                    operator: index,
                    expires: Instant::now() + Duration::from_secs(300),
                    manifest_sha,
                    env_sha,
                    identity,
                    backup_sha,
                    host_env_sha: Some(nelcota_deployment::digest_file(
                        &state.policy.root.join("host.env"),
                        65536,
                    )?),
                    configuration,
                },
            );
            drop(plans);
            // An abandoned review must release its private configuration on time,
            // even when the browser closes and no further requests arrive.
            let owner = Arc::downgrade(state);
            let id = public.id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(300)).await;
                if let Some(state) = owner.upgrade()
                    && let Ok(mut plans) = state.host_plans.lock()
                {
                    plans.retain(|key, plan| key != &id || plan.expires > Instant::now());
                }
            });
            Ok(Response::HostPlan { data: public })
        }
        Request::HostStart {
            token: session,
            plan,
            key,
            password,
            confirmation,
        } => {
            if reauthenticate(state, index, password, &session)
                .await
                .is_err()
            {
                return Ok(error("reauthentication_failed"));
            }
            if !valid_digest(&plan) || !valid_digest(&key) {
                return Ok(error("invalid_request"));
            }
            let lease = HostLock::acquire(&state.policy.root)?;
            let journal = HostJournal::open(&state.policy.root)?;
            if let Some(task) = journal.list()?.into_iter().find(|t| t.key == key) {
                if task.actor != state.policy.operators[index].email
                    || task.plan != plan
                    || confirmation != task.public.operation.confirmation()
                {
                    return Ok(error("idempotency_conflict"));
                }
                return Ok(Response::HostJob { data: task.public });
            }
            let stored = state
                .host_plans
                .lock()
                .map_err(|_| anyhow::anyhow!("host plans unavailable"))?
                .remove(&plan);
            let stored = match stored {
                Some(stored) => stored,
                None => return Ok(error("plan_expired")),
            };
            if stored.operator != index
                || stored.expires < Instant::now()
                || !stored.public.blockers.is_empty()
                || confirmation != stored.public.confirmation
            {
                return Ok(error("plan_blocked"));
            }
            if nelcota_deployment::digest_file(
                &state.policy.root.join(crate::host::MANIFEST),
                1024 * 1024,
            )? != stored.manifest_sha
                || !management::blockers(&state.policy, &stored.public.operation)
                    .await?
                    .is_empty()
            {
                return Ok(error("plan_changed"));
            }
            if !policy_current(state)? || state.operator(&session)? != index {
                return Ok(error("policy_changed"));
            }
            if let Some(prepared) = &stored.configuration {
                management::verify_prepared(&state.policy, prepared)?;
            }
            let input = stored
                .configuration
                .as_ref()
                .map(serde_json::to_vec)
                .transpose()?;
            let input_sha = input
                .as_ref()
                .map(|bytes| management::settings::bytes_digest(bytes));
            let public = HostJob {
                affected_projects: stored.public.affected_projects.clone(),
                last_stage: None,
                request_key: key.clone(),
                id: token()?,
                operation: stored.public.operation,
                stage: Stage::Accepted,
                sequence: 1,
                updated_at: nelcota_deployment::management::now()?,
                changed: false,
                backup: None,
                error: None,
            };
            let mut task = journal.begin(
                Task {
                    schema: 1,
                    public,
                    actor: state.policy.operators[index].email.clone(),
                    key,
                    plan,
                    manifest_sha: stored.manifest_sha,
                    env_sha: stored.env_sha,
                    identity: stored.identity,
                    backup_sha: stored.backup_sha,
                    version: stored.public.version,
                    image_digest: stored.public.image_digest,
                    interrupted: None,
                    input_sha,
                    host_env_sha: stored.host_env_sha,
                },
                &state.policy.root,
            )?;
            if let Some(bytes) = input {
                let path = journal
                    .directory(&task.public.id)?
                    .join("configuration.private.json");
                if nelcota_deployment::atomic_write(&path, &bytes).is_err() {
                    journal.advance(&mut task, Stage::Failed, Some("configuration_not_stored"))?;
                    return Ok(error("configuration_not_stored"));
                }
            }
            let public = task.public.clone();
            drop(lease);
            launch(state, &public.id, false).await?;
            Ok(Response::HostJob { data: public })
        }
        Request::HostRecover {
            token: session,
            job,
            password,
            confirmation,
        } => {
            reauthenticate(state, index, password, &session).await?;
            let lease = HostLock::acquire(&state.policy.root)?;
            let journal = HostJournal::open(&state.policy.root)?;
            let mut task = journal
                .list()?
                .into_iter()
                .find(|t| t.public.id == job && t.actor == state.policy.operators[index].email)
                .context("host recovery forbidden")?;
            if task.public.stage != Stage::NeedsAttention
                || confirmation != format!("RESUME {}", task.public.operation.project())
            {
                return Ok(error("recovery_not_required"));
            }
            journal.advance(&mut task, Stage::Accepted, None)?;
            let public = task.public.clone();
            drop(lease);
            launch(state, &public.id, true).await?;
            Ok(Response::HostJob { data: public })
        }
        _ => bail!("invalid host action"),
    }
}

mod supervision;
use supervision::launch;
pub(super) use supervision::reconcile_after_restart;
#[cfg(test)]
mod tests;
