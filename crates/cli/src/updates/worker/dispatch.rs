//! Authenticated update IPC routing and release-plan preparation.
use super::Plan;
use super::Session;
use super::State;
use super::error;
use super::host;
use super::jobs::acquire_host_lock;
use super::jobs::launch;
use super::jobs::run_blockers;
use super::jobs::start;
use super::policy_current;
use super::session_key;
use crate::updates::releases;
use anyhow::Context;
use nelcota_deployment::HostLock;
use nelcota_deployment::Journal;
use nelcota_deployment::Phase;
use nelcota_deployment::protocol::Request;
use nelcota_deployment::protocol::Response;
use nelcota_deployment::protocol::UpdatePlan;
use nelcota_deployment::token;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub(super) async fn dispatch(state: &Arc<State>, request: Request) -> anyhow::Result<Response> {
    if nelcota_deployment::digest_file(&state.policy_path, 65536)? != state.policy_digest
        || (state.policy.host_management.is_none() && !state.policy.identities_valid())
    {
        return Ok(error("policy_changed"));
    }
    match request {
        request @ (Request::HostAlerts { .. }
        | Request::HostDiagnostics { .. }
        | Request::HostConfiguration { .. }
        | Request::HostConfigurePlan { .. }
        | Request::HostStatus { .. }
        | Request::HostPlan { .. }
        | Request::HostStart { .. }
        | Request::HostRecover { .. }
        | Request::HostLogs { .. }) => host::dispatch(state, request).await,
        Request::Login { email, password } => {
            if email.len() > 254 || password.len() > 1024 || !state.attempt_login() {
                return Ok(error("login_rate_limited"));
            }
            let index = state
                .policy
                .operators
                .iter()
                .position(|operator| operator.email == email);
            let hash = index.map(|index| state.policy.operators[index].password_hash.clone());
            if !state.passwords.verify(password, hash).await {
                return Ok(error("invalid_credentials"));
            }
            let index = index.context("unknown operator")?;
            let value = token()?;
            let mut sessions = state
                .sessions
                .lock()
                .map_err(|_| anyhow::anyhow!("session unavailable"))?;
            sessions.retain(|_, session| session.expires > Instant::now());
            if sessions.len() >= 32 {
                return Ok(error("session_limit"));
            }
            sessions.insert(
                session_key(&value),
                Session {
                    operator: index,
                    expires: Instant::now() + Duration::from_secs(3600),
                },
            );
            Ok(Response::Session {
                token: value,
                email,
            })
        }
        Request::Logout { token } => {
            state
                .sessions
                .lock()
                .map_err(|_| anyhow::anyhow!("session unavailable"))?
                .remove(&session_key(&token));
            Ok(Response::Done)
        }
        Request::Status { token } => {
            let index = match state.operator(&token) {
                Ok(index) => index,
                Err(_) => return Ok(error("session_expired")),
            };
            match state.status(index) {
                Ok(data) => Ok(Response::Status { data }),
                Err(_) => Ok(error("deployment_state_unavailable")),
            }
        }
        Request::Check { token } => {
            let index = state.operator(&token)?;
            let permit = match state.checks.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    return Ok(Response::Status {
                        data: state.status(index)?,
                    });
                }
            };
            let recent = state
                .cache
                .lock()
                .map_err(|_| anyhow::anyhow!("cache unavailable"))?
                .checked
                .is_some_and(|at| at.elapsed() < Duration::from_secs(60));
            if recent {
                drop(permit);
                return Ok(Response::Status {
                    data: state.status(index)?,
                });
            }
            let task_state = state.clone();
            tokio::spawn(async move {
                let result =
                    releases::latest(&task_state.policy.root, &task_state.policy.verifier).await;
                if let Ok(mut cache) = task_state.cache.lock() {
                    cache.checked = Some(Instant::now());
                    match result {
                        Ok(release) => {
                            cache.release = Some(release);
                            cache.error = None;
                        }
                        Err(_) => {
                            cache.release = None;
                            cache.error = Some("release_not_ready".into());
                        }
                    }
                }
                drop(permit);
            });
            Ok(Response::Status {
                data: state.status(index)?,
            })
        }
        Request::Plan {
            token: session,
            project,
        } => {
            let index = state.operator(&session)?;
            let operator = &state.policy.operators[index];
            if !state.policy.authorized(operator, &project) {
                return Ok(error("project_forbidden"));
            }
            let host = crate::host::Host::new(&state.policy.root);
            let manifest = host.require()?;
            let target = host.select(&manifest, Some(&project))?;
            let current = target
                .env()
                .get("NELCOTA_VERSION")?
                .context("missing current version")?;
            let release = state
                .status(index)?
                .release
                .context("check release first")?;
            release.validate(env!("CARGO_PKG_VERSION"), &current)?;
            let path = state
                .policy
                .root
                .join("updates/releases")
                .join(&release.version)
                .join("update-manifest.json");
            let id = token()?;
            let env_digest = nelcota_deployment::digest_file(&target.path(".env"), 65536)?;
            let manifest_digest = nelcota_deployment::digest_file(&path, 65536)?;
            let public = UpdatePlan {
                id: id.clone(),
                project,
                current,
                target: release.version.clone(),
                digest: release.artifact(std::env::consts::ARCH)?.sha256.clone(),
                expires_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() + 300,
                blockers: run_blockers(state, &target.name).await?,
            };
            let mut plans = state
                .plans
                .lock()
                .map_err(|_| anyhow::anyhow!("plan unavailable"))?;
            plans.retain(|_, plan| plan.expires > Instant::now());
            if plans.len() >= 32 {
                return Ok(error("plan_limit"));
            }
            plans.insert(
                id,
                Plan {
                    public: public.clone(),
                    operator: index,
                    expires: Instant::now() + Duration::from_secs(300),
                    env_digest,
                    manifest_digest,
                },
            );
            Ok(Response::Plan { data: public })
        }
        Request::Start {
            token,
            plan,
            key,
            password,
        } => start(state, &token, &plan, &key, password).await,
        Request::Recover {
            token,
            job,
            password,
        } => {
            let index = state.operator(&token)?;
            let operator = &state.policy.operators[index];
            if password.len() > 1024
                || !state.attempt_login()
                || !state
                    .passwords
                    .verify(password, Some(operator.password_hash.clone()))
                    .await
            {
                return Ok(error("reauthentication_failed"));
            }
            if !policy_current(state)? || state.operator(&token)? != index {
                return Ok(error("policy_changed"));
            }
            let lease = HostLock::acquire(&state.policy.root)?;
            nelcota_deployment::management::ensure_idle(&state.policy.root)?;
            let journal = Journal::open(&state.policy.root)?;
            let mut job = journal
                .list()?
                .into_iter()
                .find(|entry| {
                    entry.public.id == job
                        && state.policy.authorized(operator, &entry.public.project)
                })
                .context("job forbidden")?;
            if job.public.phase != Phase::NeedsOperator {
                return Ok(error("recovery_not_required"));
            }
            let phase = match job.public.committed {
                true => match job.restored {
                    true => Phase::ResumingPrevious,
                    false => Phase::Committing,
                },
                false => Phase::Recovering,
            };
            journal.advance(&mut job, phase, None)?;
            let public = job.public.clone();
            drop(lease);
            if launch(state, &public.id, true).await.is_err() {
                let _lease = acquire_host_lock(&state.policy.root).await?;
                journal.advance(&mut job, Phase::NeedsOperator, Some("worker_unavailable"))?;
                return Ok(error("worker_unavailable"));
            }
            Ok(Response::Job { data: public })
        }
    }
}
