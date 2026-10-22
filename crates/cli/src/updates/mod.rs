//! Host updates are explicitly enrolled over SSH; projects never enroll themselves.
#[cfg(target_os = "linux")]
mod enroll;
#[cfg(target_os = "linux")]
pub(crate) use enroll::descriptor;
#[cfg(target_os = "linux")]
mod alerts;
#[cfg(target_os = "linux")]
mod management;
#[cfg(target_os = "linux")]
mod policy;
#[cfg(target_os = "linux")]
mod probes;
#[cfg(target_os = "linux")]
mod releases;
#[cfg(target_os = "linux")]
mod runtime;
#[cfg(target_os = "linux")]
mod worker;
use anyhow::bail;
use clap::{Args, Subcommand};
use std::path::PathBuf;

pub const POLICY: &str = "/etc/nelcota-updates/policy.json";
pub const CONTROLLER: &str = "/etc/nelcota-updates/controller.json";
pub const WORKER_SOCKET: &str = "/run/nelcota-updates-worker/worker.sock";
pub const HTTP_SOCKET: &str = "/run/nelcota-updates-http/http.sock";
#[derive(Args, Debug)]
pub struct UpdatesArgs {
    #[command(subcommand)]
    pub action: Action,
}
#[derive(Subcommand, Debug)]
pub enum Action {
    /// Enroll a host with a separate HTTPS origin and scoped operator (root/SSH only).
    Enroll {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        email: String,
        /// Private file containing a new operator password (at least 16 characters).
        #[arg(long)]
        password_file: PathBuf,
        /// Root-owned native GitHub CLI supporting `attestation verify`.
        #[arg(long)]
        verifier: PathBuf,
        #[arg(long, required = true, value_delimiter = ',')]
        projects: Vec<String>,
        /// Private root-owned JSON approving host management, image and DNS scope.
        #[arg(long)]
        host_management: Option<PathBuf>,
    },
    /// Unprivileged HTTP controller (normally managed by systemd).
    Serve {
        #[arg(long,default_value=CONTROLLER)]
        config: PathBuf,
    },
    /// Restricted privileged IPC worker (normally managed by systemd).
    Worker {
        #[arg(long,default_value=POLICY)]
        policy: PathBuf,
    },
    /// Inspect the durable journal over SSH, including interrupted jobs.
    Status {
        #[arg(long,default_value=POLICY)]
        policy: PathBuf,
    },
    /// Recover one interrupted job. Never restores an old snapshot after commit.
    Recover {
        #[arg(long,default_value=POLICY)]
        policy: PathBuf,
        #[arg(long)]
        job: String,
    },
    /// Internal job subprocess; not an HTTP command interface.
    #[command(hide = true)]
    Execute {
        #[arg(long,default_value=POLICY)]
        policy: PathBuf,
        #[arg(long)]
        job: String,
        #[arg(long)]
        recover: bool,
    },
    /// Resume a host-management receipt after inspecting the interrupted operation.
    HostRecover {
        #[arg(long,default_value=POLICY)]
        policy: PathBuf,
        #[arg(long)]
        job: String,
    },
    /// Inspect host projects and durable management receipts over SSH.
    HostStatus {
        #[arg(long,default_value=POLICY)]
        policy: PathBuf,
    },
    #[command(hide = true)]
    HostExecute {
        #[arg(long,default_value=POLICY)]
        policy: PathBuf,
        #[arg(long)]
        job: String,
        #[arg(long)]
        recover: bool,
    },
}
#[cfg(target_os = "linux")]
pub fn run(root: &std::path::Path, args: UpdatesArgs) -> anyhow::Result<crate::Outcome> {
    match args.action {
        Action::Serve { config } => {
            let bytes = std::fs::read(config)?;
            if bytes.len() > 16384 {
                bail!("controller configuration too large");
            }
            let config = serde_json::from_slice(&bytes)?;
            Ok(crate::Outcome::UpdatesServe(config))
        }
        action => {
            require_root()?;
            match action {
                Action::Enroll {
                    origin,
                    email,
                    password_file,
                    verifier,
                    projects,
                    host_management,
                } => enroll::run(
                    root,
                    &origin,
                    &email,
                    &password_file,
                    &verifier,
                    &projects,
                    host_management.as_deref(),
                )?,
                Action::HostRecover { policy, job } => {
                    management::execute(&policy::Policy::load(&policy)?, &job, true)?
                }
                Action::HostStatus { policy } => {
                    let policy = policy::Policy::load(&policy)?;
                    let data = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?
                        .block_on(management::status(&policy))?;
                    println!("{}", serde_json::to_string_pretty(&data)?);
                }
                Action::HostExecute {
                    policy,
                    job,
                    recover,
                } => management::execute(&policy::Policy::load(&policy)?, &job, recover)?,
                Action::Worker { policy } => {
                    #[cfg(unix)]
                    tokio::runtime::Builder::new_multi_thread()
                        .worker_threads(2)
                        .enable_all()
                        .build()?
                        .block_on(worker::run(policy))?;
                }
                Action::Status { policy } => {
                    let policy = policy::Policy::load(&policy)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(
                            &nelcota_deployment::Journal::open(&policy.root)?
                                .list()?
                                .into_iter()
                                .map(|job| job.public)
                                .collect::<Vec<_>>()
                        )?
                    );
                }
                Action::Recover { policy, job } => {
                    runtime::execute(&policy::Policy::load(&policy)?, &job, true)?
                }
                Action::Execute {
                    policy,
                    job,
                    recover,
                } => runtime::execute(&policy::Policy::load(&policy)?, &job, recover)?,
                Action::Serve { .. } => unreachable!(),
            }
            Ok(crate::Outcome::Done)
        }
    }
}
#[cfg(target_os = "linux")]
fn require_root() -> anyhow::Result<()> {
    let output = std::process::Command::new("id").arg("-u").output()?;
    if !output.status.success() || output.stdout != b"0\n" {
        bail!("host enrollment and recovery require root over SSH");
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn run(_root: &std::path::Path, _args: UpdatesArgs) -> anyhow::Result<crate::Outcome> {
    bail!("host updates require Linux");
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn descriptor(
    root: &std::path::Path,
) -> anyhow::Result<Option<nelcota_deployment::protocol::ControllerConfig>> {
    if root.join("updates-controller.json").exists() {
        bail!("enrolled host updates require Linux");
    }
    Ok(None)
}
