//! Authenticated IPC adapters; accepted effects run outside the HTTP lifetime.
use super::super::management;
use super::*;
use nelcota_deployment::management::{
    HostJournal, Operation, Plan as HostPlan, PublicJob as HostJob, Stage, Task,
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
async fn launch(state: &Arc<State>, id: &str, recover: bool) -> anyhow::Result<()> {
    let mut child = match spawn_child(state, id, recover) {
        Ok(child) => child,
        Err(error) => {
            let root = state.policy.root.clone();
            let id = id.to_owned();
            tokio::spawn(async move {
                let _ = mark_interrupted(&root, &id).await;
            });
            return Err(error);
        }
    };
    let root = state.policy.root.clone();
    let id = id.to_owned();
    let timeout = Duration::from_secs(state.policy.timeout_seconds);
    tokio::spawn(async move {
        if tokio::time::timeout(timeout, child.wait()).await.is_err() {
            if let Some(pid) = child.id() {
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .status();
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let _ = mark_interrupted(&root, &id).await;
    });
    Ok(())
}
fn spawn_child(
    state: &Arc<State>,
    id: &str,
    recover: bool,
) -> anyhow::Result<tokio::process::Child> {
    let journal = HostJournal::open(&state.policy.root)?;
    let log = crate::private_fs::file(&journal.directory(id)?.join("runtime.private.log"))?;
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .args(["updates", "host-execute", "--policy"])
        .arg(&state.policy_path)
        .arg("--job")
        .arg(id);
    if recover {
        command.arg("--recover");
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    Ok(command.spawn()?)
}
async fn mark_interrupted(root: &std::path::Path, id: &str) -> anyhow::Result<()> {
    // CLI refusals and receipt lookups may briefly hold the same lease after
    // the child exits. Retry reconciliation, never the mutation itself.
    let deadline = Instant::now() + Duration::from_secs(5);
    let _lease = loop {
        match HostLock::acquire(root) {
            Ok(lease) => break lease,
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    };
    let journal = HostJournal::open(root)?;
    if let Some(mut task) = journal.list()?.into_iter().find(|t| {
        t.public.id == id && !t.public.stage.terminal() && t.public.stage != Stage::NeedsAttention
    }) {
        journal.advance(&mut task, Stage::NeedsAttention, Some("worker_interrupted"))?;
    }
    Ok(())
}
pub(super) fn reconcile_after_restart(root: &std::path::Path) -> anyhow::Result<()> {
    let ids = HostJournal::open(root)?
        .list()?
        .into_iter()
        .filter(|t| !t.public.stage.terminal() && t.public.stage != Stage::NeedsAttention)
        .map(|t| t.public.id)
        .collect::<Vec<_>>();
    let update_ids = Journal::open(root)?
        .list()?
        .into_iter()
        .filter(|j| !j.public.phase.terminal() && j.public.phase != Phase::NeedsOperator)
        .map(|j| j.public.id)
        .collect::<Vec<_>>();
    if ids.is_empty() && update_ids.is_empty() {
        return Ok(());
    }
    let root = root.to_path_buf();
    tokio::spawn(async move {
        let _ = reconcile_pending_all(&root, &ids, &update_ids).await;
    });
    Ok(())
}
#[cfg(test)]
async fn reconcile_pending(root: &std::path::Path, ids: &[String]) -> anyhow::Result<()> {
    reconcile_pending_all(root, ids, &[]).await
}
async fn reconcile_pending_all(
    root: &std::path::Path,
    ids: &[String],
    update_ids: &[String],
) -> anyhow::Result<()> {
    loop {
        if let Ok(_lease) = HostLock::acquire(root) {
            let journal = HostJournal::open(root)?;
            // A completed old job may have allowed a new request while startup
            // was waiting. Reconcile only the receipts captured before listening.
            for mut task in journal.list()?.into_iter().filter(|t| {
                ids.contains(&t.public.id)
                    && !t.public.stage.terminal()
                    && t.public.stage != Stage::NeedsAttention
            }) {
                journal.advance(&mut task, Stage::NeedsAttention, Some("worker_interrupted"))?;
            }
            if !update_ids.is_empty() {
                let updates = Journal::open(root)?;
                for mut job in updates.list()?.into_iter().filter(|j| {
                    update_ids.contains(&j.public.id)
                        && !j.public.phase.terminal()
                        && j.public.phase != Phase::NeedsOperator
                }) {
                    let target = match job.public.phase {
                        Phase::Preparing => (Phase::FailedBeforeChange, "preparation_interrupted"),
                        _ => (Phase::NeedsOperator, "worker_interrupted"),
                    };
                    updates.advance(&mut job, target.0, Some(target.1))?;
                }
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, login};
    use super::*;
    fn management_fixture() -> (tempfile::TempDir, Arc<State>, String) {
        let (temp, mut state, password) = fixture();
        let s = Arc::get_mut(&mut state).unwrap();
        s.policy.operators[0].manage_host = true;
        s.policy.host_management = Some(super::super::super::policy::Provisioning {
            service_hosts: Vec::new(),
            version: "0.4.0".into(),
            image_digest: token().unwrap(),
            source_sha: token().unwrap()[..40].into(),
            max_projects: 32,
            domain_suffixes: vec!["example.test".into()],
            addresses: vec!["203.0.113.7".into()],
        });
        nelcota_deployment::atomic_write(&s.policy_path, &serde_json::to_vec(&s.policy).unwrap())
            .unwrap();
        s.policy_digest = nelcota_deployment::digest_file(&s.policy_path, 65536).unwrap();
        (temp, state, password)
    }
    #[tokio::test]
    async fn scoped_operators_cannot_create_or_inspect_host_projects() {
        let (_temp, state, password) = fixture();
        let token = login(&state, password).await;
        for request in [
            Request::HostAlerts {
                token: token.clone(),
            },
            Request::HostDiagnostics {
                token: token.clone(),
                project: "shop".into(),
            },
            Request::HostConfiguration {
                token: token.clone(),
                project: "shop".into(),
            },
            Request::HostConfigurePlan {
                token: token.clone(),
                project: "shop".into(),
                configuration: nelcota_deployment::operations::Configuration::AdminPassword {
                    new_password: "never-processed-without-authority".into(),
                },
            },
            Request::HostStatus {
                token: token.clone(),
                key: None,
            },
            Request::HostPlan {
                token: token.clone(),
                operation: Operation::Remove {
                    project: "shop".into(),
                },
            },
            Request::HostLogs {
                token,
                project: "shop".into(),
                service: nelcota_deployment::management::LogService::App,
            },
        ] {
            assert!(
                matches!(dispatch(&state,request).await.unwrap(),Response::Error {code} if code=="host_forbidden")
            );
        }
    }
    #[tokio::test]
    async fn malformed_creation_and_wrong_confirmation_never_create_jobs() {
        let (_temp, state, password) = management_fixture();
        let session = login(&state, password.clone()).await;
        assert!(
            dispatch(
                &state,
                Request::HostPlan {
                    token: session.clone(),
                    operation: Operation::Create {
                        project: "../bad".into(),
                        domain: "api.example.test".into(),
                        profile: "1gb".into()
                    }
                }
            )
            .await
            .is_err()
        );
        let plan = match dispatch(
            &state,
            Request::HostPlan {
                token: session.clone(),
                operation: Operation::Create {
                    project: "shop".into(),
                    domain: "shop.example.test".into(),
                    profile: "1gb".into(),
                },
            },
        )
        .await
        .unwrap()
        {
            Response::HostPlan { data } => data,
            _ => panic!("plan missing"),
        };
        assert!(plan.blockers.contains(&"project_exists".into()));
        assert!(
            matches!(dispatch(&state,Request::HostStart {token:session,plan:plan.id,key:token().unwrap(),password,confirmation:"REMOVE shop".into()}).await.unwrap(),Response::Error {code} if code=="plan_blocked")
        );
        assert!(
            HostJournal::open(&state.policy.root)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn a_recreated_name_does_not_inherit_scoped_update_authority() {
        let (_temp, state, _) = management_fixture();
        let new_id = token().unwrap();
        nelcota_deployment::atomic_write(
            &state
                .policy
                .root
                .join("projects/shop/.deployment-project-id"),
            new_id.as_bytes(),
        )
        .unwrap();
        state
            .policy
            .record_identity("shop", &new_id, false)
            .unwrap();
        let mut operator = state.policy.operators[0].clone();
        operator.manage_host = false;
        assert!(!state.policy.authorized(&operator, "shop"));
    }
    #[tokio::test]
    async fn controller_hostname_is_reserved_even_with_a_nonstandard_port() {
        let (_temp, mut state, password) = management_fixture();
        let current = Arc::get_mut(&mut state).unwrap();
        current.policy.origin = "https://control.example.test:8443".into();
        nelcota_deployment::atomic_write(
            &current.policy_path,
            &serde_json::to_vec(&current.policy).unwrap(),
        )
        .unwrap();
        current.policy_digest =
            nelcota_deployment::digest_file(&current.policy_path, 65536).unwrap();
        let session = login(&state, password).await;
        let response = dispatch(
            &state,
            Request::HostPlan {
                token: session,
                operation: Operation::Create {
                    project: "new-app".into(),
                    domain: "control.example.test".into(),
                    profile: "1gb".into(),
                },
            },
        )
        .await
        .unwrap();
        let data = match response {
            Response::HostPlan { data } => data,
            _ => panic!("missing review"),
        };
        assert!(data.blockers.contains(&"domain_exists".into()));
        assert!(
            HostJournal::open(&state.policy.root)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
    }
    #[tokio::test]
    async fn exit_reconciliation_waits_for_a_transient_host_lease() {
        let (_temp, state, _) = management_fixture();
        let root = &state.policy.root;
        let task = management::tests::accepted(
            &state.policy,
            Operation::Backup {
                project: "shop".into(),
            },
        )
        .unwrap();
        let lease = HostLock::acquire(root).unwrap();
        let reconciliation = mark_interrupted(root, &task.public.id);
        let release = async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(lease);
        };
        let (result, _) = tokio::join!(reconciliation, release);
        result.expect("an unrelated transient lease must not lose exit reconciliation");
        assert_eq!(
            HostJournal::open(root).unwrap().list().unwrap()[0]
                .public
                .stage,
            Stage::NeedsAttention
        );
    }
    #[tokio::test]
    async fn startup_reconciliation_does_not_interrupt_a_newly_accepted_request() {
        let (_temp, state, _) = management_fixture();
        let root = &state.policy.root;
        let mut task = management::tests::accepted(
            &state.policy,
            Operation::Backup {
                project: "shop".into(),
            },
        )
        .unwrap();
        let ids = vec![task.public.id.clone()];
        let lease = HostLock::acquire(root).unwrap();
        let release = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let journal = HostJournal::open(root).unwrap();
            task.public.backup = Some("nelcota-shop-final.dump".into());
            journal.advance(&mut task, Stage::Verifying, None).unwrap();
            journal.advance(&mut task, Stage::Completed, None).unwrap();
            let newer = management::tests::accepted(
                &state.policy,
                Operation::Backup {
                    project: "shop".into(),
                },
            )
            .unwrap();
            drop(lease);
            newer.public.id
        };
        let (result, newer) = tokio::join!(reconcile_pending(root, &ids), release);
        result.unwrap();
        assert_eq!(
            HostJournal::open(root)
                .unwrap()
                .list()
                .unwrap()
                .into_iter()
                .find(|task| task.public.id == newer)
                .unwrap()
                .public
                .stage,
            Stage::Accepted
        );
    }
}
