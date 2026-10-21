//! Private IPC worker. The HTTP process cannot grant deployment authority.
use super::{policy::Policy, releases, runtime};
use anyhow::{Context, bail};
use nelcota_deployment::{
    HostLock, Journal, Phase,
    protocol::{ProjectStatus, Request, Response, Status, UpdatePlan},
    token, valid_digest,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::Semaphore,
};
mod host;

#[derive(Default)]
struct Cache {
    release: Option<nelcota_deployment::Release>,
    checked: Option<Instant>,
    error: Option<String>,
}
struct Session {
    operator: usize,
    expires: Instant,
}
struct Plan {
    public: UpdatePlan,
    operator: usize,
    expires: Instant,
    env_digest: String,
    manifest_digest: String,
}
struct State {
    host_reads: Arc<Semaphore>,
    host_plans: Mutex<HashMap<String, host::StoredPlan>>,
    policy: Policy,
    policy_path: PathBuf,
    passwords: nelcota_auth::Passwords,
    sessions: Mutex<HashMap<String, Session>>,
    plans: Mutex<HashMap<String, Plan>>,
    cache: Mutex<Cache>,
    checks: Arc<Semaphore>,
    preflights: Arc<Semaphore>,
    policy_digest: String,
    logins: Mutex<Vec<Instant>>,
}

pub async fn run(path: PathBuf) -> anyhow::Result<()> {
    let policy = Policy::load(&path)?;
    let root = policy.root.join("updates");
    nelcota_deployment::private_dir(&root)?;
    let _worker = HostLock::acquire(&root)?;
    match HostLock::acquire(&policy.root) {
        Ok(_lease) => {
            Journal::open(&policy.root)?.reconcile()?;
            nelcota_deployment::management::HostJournal::open(&policy.root)?.reconcile()?;
        }
        Err(_) => host::reconcile_after_restart(&policy.root)?,
    }
    let socket = PathBuf::from(super::WORKER_SOCKET);
    if socket.exists() {
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o660))?;
    if !std::process::Command::new("chown")
        .arg(format!("0:{}", policy.controller_gid))
        .arg(&socket)
        .status()?
        .success()
    {
        bail!("worker socket ownership failed");
    }
    let state = Arc::new(State {
        host_reads: Arc::new(Semaphore::new(1)),
        host_plans: Mutex::default(),
        policy,
        policy_path: path.clone(),
        passwords: nelcota_auth::Passwords::new(1),
        sessions: Mutex::default(),
        plans: Mutex::default(),
        cache: Mutex::default(),
        checks: Arc::new(Semaphore::new(1)),
        preflights: Arc::new(Semaphore::new(1)),
        policy_digest: nelcota_deployment::digest_file(&path, 65536)?,
        logins: Mutex::default(),
    });
    let admission = Arc::new(Semaphore::new(8));
    loop {
        let (stream, _) = listener.accept().await?;
        if stream.peer_cred()?.uid() != state.policy.controller_uid {
            continue;
        }
        let permit = match admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => continue,
        };
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = tokio::time::timeout(Duration::from_secs(20), serve(stream, state)).await;
        });
    }
}
async fn serve(mut stream: UnixStream, state: Arc<State>) -> anyhow::Result<()> {
    let length = stream.read_u32().await? as usize;
    if length == 0 || length > 16384 {
        bail!("invalid IPC length");
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    let request: Request = serde_json::from_slice(&bytes)?;
    let response = dispatch(&state, request)
        .await
        .unwrap_or_else(|_| Response::Error {
            code: "operation_blocked".into(),
        });
    let bytes = serde_json::to_vec(&response)?;
    if bytes.len() > 1024 * 1024 {
        bail!("IPC response too large");
    }
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}
fn error(code: &str) -> Response {
    Response::Error { code: code.into() }
}
impl State {
    fn operator(&self, value: &str) -> anyhow::Result<usize> {
        if !valid_digest(value) {
            bail!("invalid session");
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("session unavailable"))?;
        sessions.retain(|_, entry| entry.expires > Instant::now());
        sessions
            .get(&session_key(value))
            .map(|session| session.operator)
            .context("session expired")
    }
    fn status(&self, index: usize) -> anyhow::Result<Status> {
        let operator = &self.policy.operators[index];
        let host = crate::host::Host::new(&self.policy.root);
        let manifest = host.require()?;
        let (release, check_error) = {
            let cache = self
                .cache
                .lock()
                .map_err(|_| anyhow::anyhow!("cache unavailable"))?;
            let release = match cache
                .checked
                .is_some_and(|at| at.elapsed() < Duration::from_secs(900))
            {
                true => cache.release.clone(),
                false => None,
            };
            (release, cache.error.clone())
        };
        let names: Vec<_> = manifest
            .projects
            .iter()
            .filter(|p| self.policy.authorized(operator, &p.name))
            .map(|p| &p.name)
            .collect();
        let projects = names
            .iter()
            .filter_map(|name| host.select(&manifest, Some(name)).ok())
            .map(|project| {
                let version = nelcota_deployment::read_private(&project.path(".env"), 65536)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .and_then(|text| {
                        crate::envfile::parse(&text)
                            .into_iter()
                            .find(|(key, _)| key == "NELCOTA_VERSION")
                            .map(|(_, value)| value)
                    })
                    .unwrap_or_default();
                let update_available = release.as_ref().is_some_and(|release| {
                    release
                        .validate(env!("CARGO_PKG_VERSION"), &version)
                        .is_ok()
                });
                ProjectStatus {
                    name: project.name,
                    version,
                    update_available,
                }
            })
            .collect();
        let jobs = Journal::open(&self.policy.root)?
            .list()?
            .into_iter()
            .filter(|job| self.policy.authorized(operator, &job.public.project))
            .map(|job| job.public)
            .take(32)
            .collect();
        Ok(Status {
            host_management: operator.manage_host && self.policy.host_management.is_some(),
            host_busy: nelcota_deployment::management::HostJournal::open(&self.policy.root)?
                .list()?
                .iter()
                .any(|task| !task.public.stage.terminal()),
            email: operator.email.clone(),
            projects,
            jobs,
            release,
            check_error,
            enabled: self.policy.installation_validated(),
            checking: self.checks.available_permits() == 0,
        })
    }
    fn attempt_login(&self) -> bool {
        let mut attempts = match self.logins.lock() {
            Ok(attempts) => attempts,
            Err(_) => return false,
        };
        let now = Instant::now();
        attempts.retain(|at| now.duration_since(*at) < Duration::from_secs(60));
        if attempts.len() >= 10 {
            return false;
        }
        attempts.push(now);
        true
    }
}
fn policy_current(state: &State) -> anyhow::Result<bool> {
    Ok(
        nelcota_deployment::digest_file(&state.policy_path, 65536)? == state.policy_digest
            && (state.policy.host_management.is_some() || state.policy.identities_valid()),
    )
}
async fn dispatch(state: &Arc<State>, request: Request) -> anyhow::Result<Response> {
    if nelcota_deployment::digest_file(&state.policy_path, 65536)? != state.policy_digest
        || (state.policy.host_management.is_none() && !state.policy.identities_valid())
    {
        return Ok(error("policy_changed"));
    }
    match request {
        request @ (Request::HostStatus { .. }
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
                let _lease = HostLock::acquire(&state.policy.root)?;
                journal.advance(&mut job, Phase::NeedsOperator, Some("worker_unavailable"))?;
                return Ok(error("worker_unavailable"));
            }
            Ok(Response::Job { data: public })
        }
    }
}
async fn run_blockers(state: &Arc<State>, name: &str) -> anyhow::Result<Vec<String>> {
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
async fn start(
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
        let _lease = HostLock::acquire(&state.policy.root)?;
        journal.advance(
            &mut job,
            Phase::FailedBeforeChange,
            Some("worker_unavailable"),
        )?;
        return Ok(error("worker_unavailable"));
    }
    Ok(Response::Job { data: public })
}
async fn launch(state: &Arc<State>, id: &str, recover: bool) -> anyhow::Result<()> {
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
        if let Ok(_lease) = HostLock::acquire(&root)
            && let Ok(journal) = Journal::open(&root)
            && let Ok(jobs) = journal.list()
            && let Some(mut job) = jobs.into_iter().find(|job| job.public.id == id)
            && !job.public.phase.terminal()
        {
            let _ = journal.advance(&mut job, Phase::NeedsOperator, Some("worker_interrupted"));
        }
    });
    Ok(())
}
use std::os::unix::process::CommandExt;

fn session_key(value: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn fixture() -> (tempfile::TempDir, Arc<State>, String) {
        let temporary = match std::env::var_os("NELCOTA_IPC_FIXTURE_BASE") {
            Some(base) => tempfile::tempdir_in(base).unwrap(),
            None => tempfile::tempdir().unwrap(),
        };
        let root = temporary.path().to_path_buf();
        let host = crate::host::Host::new(&root);
        nelcota_deployment::atomic_write(&root.join("host.env"), b"# private host fixture\n")
            .unwrap();
        let manifest = crate::host::Manifest {
            version: 1,
            panel_login: crate::host::PanelLogin::Shared,
            base_domain: None,
            local: false,
            runtime: crate::host::Runtime::Docker,
            image: "ghcr.io/nelcota/nelcota-server".into(),
            projects: ["shop", "blog"]
                .into_iter()
                .map(|name| crate::host::ProjectEntry {
                    name: name.into(),
                    domain: format!("{name}.example.test"),
                })
                .collect(),
        };
        host.save(&manifest).unwrap();
        for project in host.projects(&manifest) {
            std::fs::create_dir_all(project.path("")).unwrap();
            project.env().set("NELCOTA_VERSION", "0.4.0").unwrap();
        }
        let password = token().unwrap();
        let operator = super::super::policy::Operator {
            manage_host: false,
            email: "operator@example.test".into(),
            password_hash: nelcota_auth::hash_password(&password).unwrap(),
            projects: vec!["shop".into()],
        };
        let id = token().unwrap();
        nelcota_deployment::atomic_write(
            &root.join("projects/shop/.deployment-project-id"),
            id.as_bytes(),
        )
        .unwrap();
        let policy = Policy {
            host_management: None,
            schema: 1,
            root: root.clone(),
            origin: "https://updates.example.test".into(),
            controller_uid: 1000,
            controller_gid: 1000,
            verifier: "/invalid/gh".into(),
            operators: vec![operator],
            project_ids: std::collections::BTreeMap::from([("shop".into(), id)]),
            enable_installation: false,
            validation_report: None,
            minimum_free_bytes: 1 << 30,
            timeout_seconds: 60,
        };
        let path = root.join("policy.json");
        nelcota_deployment::atomic_write(&path, &serde_json::to_vec(&policy).unwrap()).unwrap();
        let state = Arc::new(State {
            host_reads: Arc::new(Semaphore::new(1)),
            host_plans: Mutex::default(),
            policy,
            policy_path: path.clone(),
            policy_digest: nelcota_deployment::digest_file(&path, 65536).unwrap(),
            passwords: nelcota_auth::Passwords::new(1),
            sessions: Mutex::default(),
            plans: Mutex::default(),
            cache: Mutex::default(),
            checks: Arc::new(Semaphore::new(1)),
            preflights: Arc::new(Semaphore::new(1)),
            logins: Mutex::default(),
        });
        (temporary, state, password)
    }
    pub(super) async fn login(state: &Arc<State>, password: String) -> String {
        match dispatch(
            state,
            Request::Login {
                email: "operator@example.test".into(),
                password,
            },
        )
        .await
        .unwrap()
        {
            Response::Session { token, .. } => token,
            _ => panic!("operator login failed"),
        }
    }
    #[tokio::test]
    async fn operator_is_scoped_even_when_project_sso_covers_the_host() {
        let (_temporary, state, password) = fixture();
        let session = login(&state, password).await;
        let journal = Journal::open(&state.policy.root).unwrap();
        journal
            .begin(
                "blog",
                "0.4.0",
                "0.5.0",
                "another",
                &token().unwrap(),
                &token().unwrap(),
            )
            .unwrap();
        let status = state.status(state.operator(&session).unwrap()).unwrap();
        assert_eq!(status.projects.len(), 1);
        assert_eq!(status.projects[0].name, "shop");
        assert!(status.jobs.is_empty());
        assert!(
            matches!(dispatch(&state,Request::Plan{token:session.clone(),project:"blog".into()}).await.unwrap(),Response::Error{code} if code=="project_forbidden")
        );
        assert!(state.operator("service_role.jwt").is_err());
        assert!(state.operator(&token().unwrap()).is_err());
        dispatch(
            &state,
            Request::Logout {
                token: session.clone(),
            },
        )
        .await
        .unwrap();
        assert!(state.operator(&session).is_err());
    }
    #[tokio::test]
    async fn a_session_cannot_start_or_recover_without_fresh_password_confirmation() {
        let (_temporary, state, password) = fixture();
        let session = login(&state, password).await;
        let result = dispatch(
            &state,
            Request::Start {
                token: session.clone(),
                plan: token().unwrap(),
                key: token().unwrap(),
                password: token().unwrap(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(result,Response::Error{code} if code=="reauthentication_failed"));
        let result = dispatch(
            &state,
            Request::Recover {
                token: session,
                job: token().unwrap(),
                password: token().unwrap(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(result,Response::Error{code} if code=="reauthentication_failed"));
        assert!(
            Journal::open(&state.policy.root)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
    }
    #[tokio::test]
    async fn policy_revocation_and_session_expiry_fail_closed() {
        let (_temporary, state, password) = fixture();
        let session = login(&state, password).await;
        state
            .sessions
            .lock()
            .unwrap()
            .get_mut(&session_key(&session))
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        assert!(state.operator(&session).is_err());
        nelcota_deployment::atomic_write(&state.policy_path, b"{}").unwrap();
        assert!(
            matches!(dispatch(&state,Request::Status{token:session}).await.unwrap(),Response::Error{code} if code=="policy_changed")
        );
    }
    #[test]
    fn clients_cannot_add_paths_shell_commands_or_host_authority_to_ipc() {
        for value in [
            r#"{"action":"start","token":"x","plan":"x","key":"x","password":"x","command":"rm"}"#,
            r#"{"action":"plan","token":"x","project":"shop","root":"/"}"#,
            r#"{"action":"execute","job":"x"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(value).is_err());
        }
    }
    #[test]
    fn real_worker_transport_enforces_uid_and_operator_scope() {
        const TEST: &str =
            "updates::worker::tests::real_worker_transport_enforces_uid_and_operator_scope";
        let mode = std::env::var("NELCOTA_IPC_TEST_MODE").unwrap_or_default();
        if mode.is_empty() {
            let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.tools/reports/updates/ipc-fixtures");
            std::fs::create_dir_all(&directory).unwrap();
            let temporary = tempfile::tempdir_in(directory).unwrap();
            let executable = temporary.path().join("fixture-test");
            std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
            let status = std::process::Command::new("docker")
                .args([
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--read-only",
                    "--memory",
                    "512m",
                    "--pids-limit",
                    "64",
                    "--cap-drop",
                    "ALL",
                    "--cap-add",
                    "CHOWN",
                    "--cap-add",
                    "SETUID",
                    "--cap-add",
                    "SETGID",
                    "--tmpfs",
                    "/fixture:rw,mode=0755",
                    "--tmpfs",
                    "/run:rw,mode=0755",
                    "-e",
                    "NELCOTA_IPC_TEST_MODE=worker",
                    "-e",
                    "NELCOTA_IPC_FIXTURE_BASE=/fixture",
                    "-v",
                ])
                .arg(format!("{}:/fixture-test:ro", executable.display()))
                .args([
                    "debian:trixie-slim",
                    "/fixture-test",
                    "--exact",
                    TEST,
                    "--nocapture",
                ])
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        let socket = PathBuf::from(super::super::WORKER_SOCKET);
        if mode == "rogue" {
            assert!(
                nelcota_deployment::protocol::call(
                    &socket,
                    &Request::Login {
                        email: "operator@example.test".into(),
                        password: std::env::var("NELCOTA_IPC_TEST_PASSWORD").unwrap()
                    }
                )
                .is_err()
            );
            return;
        }
        if mode == "client" {
            let password = std::env::var("NELCOTA_IPC_TEST_PASSWORD").unwrap();
            let value = match nelcota_deployment::protocol::call(
                &socket,
                &Request::Login {
                    email: "operator@example.test".into(),
                    password: password.clone(),
                },
            )
            .unwrap()
            {
                Response::Session { token, .. } => token,
                _ => panic!("IPC login rejected"),
            };
            match nelcota_deployment::protocol::call(
                &socket,
                &Request::Status {
                    token: value.clone(),
                },
            )
            .unwrap()
            {
                Response::Status { data } => {
                    assert_eq!(data.projects.len(), 1);
                    assert_eq!(data.projects[0].name, "shop");
                    assert!(!data.enabled);
                    assert!(data.jobs.is_empty());
                }
                _ => panic!("IPC status rejected"),
            }
            assert!(
                matches!(nelcota_deployment::protocol::call(&socket,&Request::Plan{token:value.clone(),project:"blog".into()}).unwrap(),Response::Error{code} if code=="project_forbidden")
            );
            assert!(
                matches!(nelcota_deployment::protocol::call(&socket,&Request::Start{token:value,plan:token().unwrap(),key:token().unwrap(),password}).unwrap(),Response::Error{code} if code=="installation_not_validated")
            );
            return;
        }
        assert_eq!(mode, "worker");
        let (_temporary, state, password) = fixture();
        let host = crate::host::Host::new(&state.policy.root);
        std::fs::create_dir_all(host.shared_dir()).unwrap();
        std::fs::create_dir_all(host.caddy_dir().join("config")).unwrap();
        std::fs::write(host.caddy_dir().join("docker-compose.yml"), b"fixture").unwrap();
        std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
        assert!(
            std::process::Command::new("chown")
                .arg("0:1000")
                .arg(socket.parent().unwrap())
                .status()
                .unwrap()
                .success()
        );
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            socket.parent().unwrap(),
            std::fs::Permissions::from_mode(0o750),
        )
        .unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let path = state.policy_path.clone();
            let worker = tokio::spawn(async move { run(path).await.unwrap() });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !socket.exists() {
                assert!(!worker.is_finished());
                assert!(Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            for (mode, uid) in [("rogue", 1001), ("client", 1000)] {
                let password = password.clone();
                let result = tokio::task::spawn_blocking(move || {
                    use std::os::unix::process::CommandExt;
                    std::process::Command::new("/fixture-test")
                        .args(["--exact", TEST, "--nocapture"])
                        .env("NELCOTA_IPC_TEST_MODE", mode)
                        .env("NELCOTA_IPC_TEST_PASSWORD", password)
                        .uid(uid)
                        .gid(1000)
                        .status()
                        .unwrap()
                })
                .await
                .unwrap();
                assert!(result.success());
            }
            worker.abort();
            let _ = worker.await;
        });
        assert!(
            Journal::open(&state.policy.root)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
    }
}
