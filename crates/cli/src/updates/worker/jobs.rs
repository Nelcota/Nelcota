//! Admission, idempotent job acceptance and detached process ownership.
use super::State;
use super::error;
use super::policy_current;
use crate::updates::runtime;
use anyhow::Context;
use nelcota_deployment::HostLock;
use nelcota_deployment::Journal;
use nelcota_deployment::Phase;
use nelcota_deployment::protocol::Response;
use nelcota_deployment::valid_digest;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

pub(super) async fn run_blockers(state: &Arc<State>, name: &str) -> anyhow::Result<Vec<String>> {
    let permit = state
        .preflights
        .clone()
        .try_acquire_owned()
        .context("preflight busy")?;
    let policy = state.policy.clone();
    let name = name.to_owned();
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let host = crate::host::Host::new(&policy.root);
        let manifest = host.require()?;
        let project = host.select(&manifest, Some(&name))?;
        Ok::<_, anyhow::Error>(runtime::blockers(&policy, &project))
    });
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .context("preflight timed out")??
}
pub(super) async fn start(
    state: &Arc<State>,
    session: &str,
    id: &str,
    key: &str,
    password: String,
) -> anyhow::Result<Response> {
    let index = state.operator(session)?;
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
    if !valid_digest(id) || !valid_digest(key) {
        return Ok(error("invalid_request"));
    }
    if !policy_current(state)? || state.operator(session)? != index {
        return Ok(error("policy_changed"));
    }
    let _lease = HostLock::acquire(&state.policy.root)?;
    nelcota_deployment::management::ensure_idle(&state.policy.root)?;
    let journal = Journal::open(&state.policy.root)?;
    if let Some(job) = journal
        .list()?
        .into_iter()
        .find(|job| job.request_key == key)
    {
        if job.actor != operator.email
            || job.fingerprint != id
            || !state.policy.authorized(operator, &job.public.project)
        {
            return Ok(error("idempotency_conflict"));
        }
        return Ok(Response::Job { data: job.public });
    }
    if !state.policy.installation_validated() {
        return Ok(error("installation_not_validated"));
    }
    let plan = {
        let mut plans = state
            .plans
            .lock()
            .map_err(|_| anyhow::anyhow!("plan unavailable"))?;
        plans.remove(id).context("plan expired or already used")?
    };
    if plan.operator != index
        || plan.expires < Instant::now()
        || !plan.public.blockers.is_empty()
        || !state.policy.authorized(operator, &plan.public.project)
    {
        return Ok(error("plan_blocked"));
    }
    let host = crate::host::Host::new(&state.policy.root);
    let manifest = host.require()?;
    let project = host.select(&manifest, Some(&plan.public.project))?;
    let path = state
        .policy
        .root
        .join("updates/releases")
        .join(&plan.public.target)
        .join("update-manifest.json");
    if nelcota_deployment::digest_file(&project.path(".env"), 65536)? != plan.env_digest
        || nelcota_deployment::digest_file(&path, 65536)? != plan.manifest_digest
        || !run_blockers(state, &project.name).await?.is_empty()
    {
        return Ok(error("plan_changed"));
    }
    if !policy_current(state)? || state.operator(session)? != index {
        return Ok(error("policy_changed"));
    }
    let mut job = match journal.begin(
        &plan.public.project,
        &plan.public.current,
        &plan.public.target,
        &operator.email,
        key,
        id,
    ) {
        Ok(job) => job,
        Err(error) => {
            if let Ok(jobs) = journal.list()
                && let Some(mut job) = jobs
                    .into_iter()
                    .find(|job| job.request_key == key && job.public.phase == Phase::Preparing)
            {
                let _ = journal.advance(
                    &mut job,
                    Phase::FailedBeforeChange,
                    Some("preparation_failed"),
                );
            }
            return Err(error);
        }
    };
    job.expected_env_sha256 = Some(plan.env_digest);
    job.manifest_sha256 = Some(plan.manifest_digest);
    if let Err(error) = journal.save(&job) {
        if let Ok(jobs) = journal.list()
            && let Some(mut stored) = jobs.into_iter().find(|entry| {
                entry.public.id == job.public.id && entry.public.phase == Phase::Preparing
            })
        {
            let _ = journal.advance(
                &mut stored,
                Phase::FailedBeforeChange,
                Some("preparation_failed"),
            );
        }
        return Err(error);
    }
    let public = job.public.clone();
    drop(_lease);
    if launch(state, &public.id, false).await.is_err() {
        let _lease = acquire_host_lock(&state.policy.root).await?;
        journal.advance(
            &mut job,
            Phase::FailedBeforeChange,
            Some("worker_unavailable"),
        )?;
        return Ok(error("worker_unavailable"));
    }
    Ok(Response::Job { data: public })
}
pub(super) async fn launch(state: &Arc<State>, id: &str, recover: bool) -> anyhow::Result<()> {
    let journal = Journal::open(&state.policy.root)?;
    let log = crate::private_fs::file(&journal.directory(id)?.join("runtime.private.log"))?;
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .args(["updates", "execute", "--policy"])
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
    let mut child = command.spawn()?;
    let timeout = Duration::from_secs(state.policy.timeout_seconds);
    let root = state.policy.root.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        let result = tokio::time::timeout(timeout, child.wait()).await;
        if result.is_err() {
            if let Some(pid) = child.id() {
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .status();
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let Ok(_lease) = acquire_host_lock(&root).await
            && let Ok(journal) = Journal::open(&root)
            && let Ok(jobs) = journal.list()
            && let Some(mut job) = jobs.into_iter().find(|job| job.public.id == id)
            && !job.public.phase.terminal()
            && job.public.phase != Phase::NeedsOperator
        {
            // A job still Preparing never changed the host (for example the
            // runtime could not take the host lock); recovery and restart
            // reconciliation classify it the same way. Only later phases
            // need an operator.
            let (phase, reason) =
                match job.public.phase == Phase::Preparing && !job.public.committed {
                    true => (Phase::FailedBeforeChange, "preparation_interrupted"),
                    false => (Phase::NeedsOperator, "worker_interrupted"),
                };
            let _ = journal.advance(&mut job, phase, Some(reason));
        }
    });
    Ok(())
}
pub(super) async fn acquire_host_lock(root: &std::path::Path) -> anyhow::Result<HostLock> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match HostLock::acquire(root) {
            Ok(lease) => return Ok(lease),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}
use std::os::unix::process::CommandExt;
