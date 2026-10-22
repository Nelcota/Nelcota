//! Bounded local protocol. Authentication is verified by the host worker.
use crate::{PublicJob, Release};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerConfig {
    pub schema: u32,
    pub origin: String,
    pub worker_socket: PathBuf,
    pub http_socket: PathBuf,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    HostAlerts {
        token: String,
    },
    HostDiagnostics {
        token: String,
        project: String,
    },
    HostConfiguration {
        token: String,
        project: String,
    },
    HostConfigurePlan {
        token: String,
        project: String,
        configuration: crate::operations::Configuration,
    },
    HostStatus {
        token: String,
        key: Option<String>,
    },
    HostPlan {
        token: String,
        operation: crate::management::Operation,
    },
    HostStart {
        token: String,
        plan: String,
        key: String,
        password: String,
        confirmation: String,
    },
    HostRecover {
        token: String,
        job: String,
        password: String,
        confirmation: String,
    },
    HostLogs {
        token: String,
        project: String,
        service: crate::management::LogService,
    },
    Login {
        email: String,
        password: String,
    },
    Logout {
        token: String,
    },
    Status {
        token: String,
    },
    Check {
        token: String,
    },
    Plan {
        token: String,
        project: String,
    },
    Start {
        token: String,
        plan: String,
        key: String,
        password: String,
    },
    Recover {
        token: String,
        job: String,
        password: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdatePlan {
    pub id: String,
    pub project: String,
    pub current: String,
    pub target: String,
    pub digest: String,
    pub expires_at: u64,
    pub blockers: Vec<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    #[serde(default)]
    pub host_management: bool,
    #[serde(default)]
    pub host_busy: bool,
    pub email: String,
    pub projects: Vec<ProjectStatus>,
    pub jobs: Vec<PublicJob>,
    pub release: Option<Release>,
    pub check_error: Option<String>,
    pub enabled: bool,
    pub checking: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectStatus {
    pub name: String,
    pub version: String,
    pub update_available: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    HostAlerts {
        data: crate::alerts::Status,
    },
    HostDiagnostics {
        data: crate::operations::Diagnostics,
    },
    HostConfiguration {
        data: crate::operations::ConfigurationView,
    },
    HostStatus {
        data: crate::management::Status,
    },
    HostPlan {
        data: crate::management::Plan,
    },
    HostJob {
        data: crate::management::PublicJob,
    },
    HostLogs {
        data: Vec<crate::management::LogEntry>,
    },
    Session {
        token: String,
        email: String,
    },
    Status {
        data: Status,
    },
    Plan {
        data: UpdatePlan,
    },
    Job {
        data: PublicJob,
    },
    Done,
    Error {
        code: String,
    },
}
#[cfg(unix)]
pub fn call(socket: &std::path::Path, request: &Request) -> anyhow::Result<Response> {
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
        time::Duration,
    };
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let bytes = serde_json::to_vec(request)?;
    if bytes.len() > 16384 {
        anyhow::bail!("request too large");
    }
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    let mut length = [0u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > 1024 * 1024 {
        anyhow::bail!("response too large");
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
