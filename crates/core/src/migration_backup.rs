//! Project-only backup IPC and migration lifetime. No host paths or commands cross the socket.
use crate::{
    Config, Secret,
    user_migrations::{self, Error, MigrationReport, MigrationRequest, MigrationState},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio_postgres::Client;

/// The agent waits for this session lock before releasing its host lease/fence.
pub const LOCK: &str = "SELECT pg_advisory_lock(hashtext('nelcota.migration_backup'))";
const TRY_LOCK: &str = "SELECT pg_try_advisory_lock(hashtext('nelcota.migration_backup'))";
const UNLOCK: &str = "SELECT pg_advisory_unlock(hashtext('nelcota.migration_backup'))";

#[derive(Clone, Debug)]
pub struct BackupAgent {
    pub socket: PathBuf,
    pub token: Secret,
}
impl BackupAgent {
    pub fn from_config(config: &Config) -> Option<Self> {
        Some(Self {
            socket: config.migration_backup_socket.clone()?,
            token: config.migration_backup_token.clone()?,
        })
    }
    pub fn valid(&self) -> bool {
        self.socket.is_absolute() && valid_token(self.token.expose())
    }
}
pub fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub backup: Option<String>,
}

#[cfg(unix)]
struct Guard(tokio::net::UnixStream);
#[cfg(unix)]
impl Guard {
    async fn prepare(config: &BackupAgent) -> Result<(Self, String), Error> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if !config.valid() {
            return Err(Error::BackupFailed);
        }
        let mut stream = tokio::net::UnixStream::connect(&config.socket)
            .await
            .map_err(|_| Error::BackupFailed)?;
        stream
            .write_all(format!("1{}", config.token.expose()).as_bytes())
            .await
            .map_err(|_| Error::BackupFailed)?;
        let length = stream.read_u32().await.map_err(|_| Error::BackupFailed)? as usize;
        if length == 0 || length > 1024 {
            return Err(Error::BackupFailed);
        }
        let mut bytes = vec![0; length];
        stream
            .read_exact(&mut bytes)
            .await
            .map_err(|_| Error::BackupFailed)?;
        let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| Error::BackupFailed)?;
        let backup = reply
            .backup
            .filter(|name| {
                name.len() <= 255
                    && name.starts_with("nelcota-")
                    && name.ends_with(".dump")
                    && name.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            })
            .ok_or(Error::BackupFailed)?;
        Ok((Self(stream), backup))
    }
    async fn disconnected(&mut self) {
        use tokio::io::AsyncReadExt;
        let _ = self.0.read_u8().await;
    }
}

/// Callers must discard the database connection on cancellation. The HTTP adapter
/// retains pool admission and closes the physical connection on every exit.
/// CLI connections belong to one invocation and are never returned to a pool.
pub async fn apply(
    client: &mut Client,
    request: &MigrationRequest,
    actor: &str,
    production: bool,
    agent: Option<&BackupAgent>,
) -> Result<MigrationReport, Error> {
    if request.dry_run || !production && agent.is_none() {
        return user_migrations::apply(client, request, actor).await;
    }
    let locked: bool = client.query_one(TRY_LOCK, &[]).await?.get(0);
    if !locked {
        return Err(Error::Busy);
    }
    let result = protected(client, request, actor, agent).await;
    if matches!(result, Err(Error::BackupInterrupted)) {
        // SQL was canceled while awaiting a result. Do not queue an unlock
        // behind that abandoned query: the owner closes its physical socket.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.cancel_token().cancel_query(tokio_postgres::NoTls),
        )
        .await;
        return result;
    }
    client.query_one(UNLOCK, &[]).await?;
    result
}
async fn protected(
    client: &mut Client,
    request: &MigrationRequest,
    actor: &str,
    agent: Option<&BackupAgent>,
) -> Result<MigrationReport, Error> {
    let statuses = user_migrations::status(client, &request.files).await?;
    if statuses.iter().any(|row| {
        matches!(
            row.state,
            MigrationState::Diverged | MigrationState::Missing
        )
    }) {
        return Err(Error::Diverged);
    }
    if !statuses
        .iter()
        .any(|row| row.state == MigrationState::Pending)
    {
        return user_migrations::apply(client, request, actor).await;
    }
    let agent = agent.ok_or(Error::BackupRequired)?;
    #[cfg(unix)]
    {
        // A slow/failed backup never starts SQL. While applying, losing the agent
        // aborts the operation; its durable fence survives an agent crash.
        let (mut guard, backup) =
            tokio::time::timeout(std::time::Duration::from_secs(300), Guard::prepare(agent))
                .await
                .map_err(|_| Error::BackupFailed)??;
        let mut report = tokio::select! {
            result = user_migrations::apply(client, request, actor) => result?,
            _ = guard.disconnected() => return Err(Error::BackupInterrupted),
        };
        report.backup = Some(backup);
        Ok(report)
    }
    #[cfg(not(unix))]
    {
        let _ = agent;
        Err(Error::BackupFailed)
    }
}
