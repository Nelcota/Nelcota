//! Private IPC worker. The HTTP process cannot grant deployment authority.
use super::policy::Policy;
use anyhow::{Context, bail};
use nelcota_deployment::{
    HostLock, Journal,
    protocol::{ProjectStatus, Request, Response, Status, UpdatePlan},
    valid_digest,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::Semaphore,
};
mod dispatch;
mod host;
mod jobs;
use dispatch::dispatch;

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
    let _alerts = super::alerts::spawn(path);
    let admission = Arc::new(Semaphore::new(8));
    loop {
        // A failed accept (descriptor exhaustion, an aborted connection) or
        // peer lookup affects one caller; the worker must keep serving.
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                eprintln!("nelcota update worker could not accept a connection: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        match stream.peer_cred() {
            Ok(peer) if peer.uid() == state.policy.controller_uid => {}
            Ok(_) => continue,
            Err(error) => {
                eprintln!("nelcota update worker could not identify a caller: {error}");
                continue;
            }
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
fn session_key(value: &str) -> String {
    use sha2::{Digest, Sha256};
    base16ct::lower::encode_string(&Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests;
