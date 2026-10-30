//! Host-owned, project-scoped backups. IPC can only request this project's backup.
use crate::{host::Host, project::Project};
#[cfg(any(unix, test))]
use anyhow::Context;
use anyhow::bail;
use std::{
    fs,
    path::{Path, PathBuf},
};
// The agent and its installation exist only on Unix hosts.
#[cfg(unix)]
use crate::backup;
#[cfg(unix)]
use nelcota_core::migration_backup::{LOCK, Reply, valid_token};
#[cfg(unix)]
use nelcota_deployment::{
    HostLock, MIGRATION_BACKUP_FENCE as FENCE, atomic_write, digest_file, read_private,
};
#[cfg(unix)]
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::{
    io::{Read, Write},
    process::Stdio,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

pub(crate) mod install;
#[derive(clap::Subcommand, Debug)]
pub enum Action {
    /// Install/start the root backup agent and connect the managed app to it.
    Enable,
    /// Capability preflight: does not load configuration or start a server.
    #[command(hide = true)]
    CheckSupport,
    /// Run the installed agent; its host/project are fixed by the service unit.
    #[command(hide = true)]
    Serve {
        #[arg(long)]
        socket: PathBuf,
    },
}
pub fn run(host: &Host, selection: Option<&str>, action: Action) -> anyhow::Result<()> {
    if matches!(action, Action::CheckSupport) {
        return Ok(());
    }
    let project = host.select(&host.require()?, selection)?;
    crate::naming::validate_project_name(&project.name)?;
    match action {
        Action::Enable => install::enable(host, &project),
        Action::CheckSupport => Ok(()),
        Action::Serve { socket } => serve(host, &project, &socket),
    }
}
#[cfg(unix)]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fence {
    project: String,
    environment: String,
}
#[cfg(unix)]
fn identity(project: &Project) -> anyhow::Result<Fence> {
    Ok(Fence {
        project: project.name.clone(),
        environment: digest_file(&project.path(".env"), 65536)?,
    })
}
#[cfg(unix)]
fn wait_for_sql(project: &Project) -> anyhow::Result<()> {
    // On HTTP cancellation the physical DB connection closes. Waiting for its
    // session lock keeps host updates/restores excluded until SQL has stopped.
    // Failure leaves the durable fence; it never certifies an unknown outcome.
    let status = project
        .as_postgres(&[
            "psql",
            "-XqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-d",
            "postgres",
            "-c",
            LOCK,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()?;
    if !status.success() {
        bail!("could not confirm that migration SQL has stopped; backup fence retained");
    }
    Ok(())
}
#[cfg(unix)]
fn clear_fence(host: &Host) -> anyhow::Result<()> {
    fs::remove_file(host.root().join(FENCE))?;
    fs::File::open(host.root())?.sync_all()?;
    Ok(())
}
#[cfg(unix)]
fn recover(host: &Host, project: &Project) -> anyhow::Result<()> {
    let path = host.root().join(FENCE);
    if !path.try_exists()? {
        return Ok(());
    }
    let fence: Fence = serde_json::from_slice(&read_private(&path, 4096)?)?;
    if fence.project != project.name {
        return Ok(());
    }
    let _lease = HostLock::acquire_migration_recovery(host.root())?;
    if fence.environment != identity(project)?.environment {
        bail!(
            "backup fence belongs to an earlier project configuration; inspect it before recovery"
        );
    }
    wait_for_sql(project)?;
    clear_fence(host)
}
#[cfg(unix)]
fn capture(host: &Host, project: &Project) -> anyhow::Result<String> {
    crate::pitr::fence::require_clear(project)?;
    // Existing capture retains one exported database/file snapshot. External
    // destinations use the same upload/readback verification as scheduled backups.
    read_private(host.secrets().path(), 65536)?;
    let upload = backup::s3_configured(host);
    let path = backup::run(host, project, upload, None)?;
    if project.stores_files_on_disk()? {
        backup::validate(&path)?;
    }
    let status = project
        .as_postgres(&["pg_restore", "--list"])
        .stdin(Stdio::from(fs::File::open(&path)?))
        .stdout(Stdio::null())
        .status()?;
    if !status.success() {
        bail!("migration backup dump failed validation");
    }
    Ok(path
        .file_name()
        .and_then(|name| name.to_str())
        .context("invalid backup filename")?
        .to_owned())
}
/// The socket is reachable by every local user; only the capability authorizes.
/// Each connection must present it within this deadline, and at most
/// `MAX_CONNECTIONS` are served at once, so idle callers cannot starve the app.
#[cfg(unix)]
const CAPABILITY_DEADLINE: Duration = Duration::from_secs(1);
#[cfg(unix)]
const MAX_CONNECTIONS: usize = 8;
#[cfg(unix)]
fn read_capability(
    stream: &mut std::os::unix::net::UnixStream,
    auth: &mut [u8],
) -> anyhow::Result<()> {
    let deadline = Instant::now() + CAPABILITY_DEADLINE;
    let mut filled = 0;
    while filled < auth.len() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .context("backup capability not presented in time")?;
        stream.set_read_timeout(Some(remaining))?;
        match stream.read(&mut auth[filled..])? {
            0 => bail!("backup capability incomplete"),
            read => filled += read,
        }
    }
    Ok(())
}
#[cfg(unix)]
fn handle(
    host: &Host,
    project: &Project,
    mut stream: std::os::unix::net::UnixStream,
) -> anyhow::Result<()> {
    use subtle::ConstantTimeEq;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut auth = [0; 65];
    read_capability(&mut stream, &mut auth)?;
    // Reload the root-owned environment for every request, binding the capability
    // to the current project incarnation. No project/path/command is accepted.
    let token = project
        .env()
        .get("NELCOTA_MIGRATION_BACKUP_TOKEN")?
        .context("backup agent disabled")?;
    if !valid_token(&token) || auth[0] != b'1' || !bool::from(auth[1..].ct_eq(token.as_bytes())) {
        bail!("invalid backup capability");
    }
    let _lease = crate::host::acquire_mutation_lease(host.root())?;
    atomic_write(
        &host.root().join(FENCE),
        &serde_json::to_vec(&identity(project)?)?,
    )?;
    let result = capture(host, project);
    let reply = serde_json::to_vec(&Reply {
        backup: result.as_ref().ok().cloned(),
    })?;
    let sent = stream
        .write_all(&(reply.len() as u32).to_be_bytes())
        .and_then(|()| stream.write_all(&reply));
    if sent.is_ok() && result.is_ok() {
        // Closing this socket cancels a still-running HTTP migration. There is
        // no "success" from a timeout: wait_for_sql owns the final exclusion.
        stream.set_read_timeout(Some(Duration::from_secs(900)))?;
        let _ = stream.read(&mut [0]);
    }
    drop(stream);
    wait_for_sql(project)?;
    clear_fence(host)?;
    result.map(|_| ())
}
#[cfg(unix)]
fn serve(host: &Host, project: &Project, socket: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    if !socket.is_absolute() {
        bail!("backup socket must be absolute");
    }
    read_private(&project.path(".env"), 65536)?;
    let directory = socket.parent().context("missing backup socket directory")?;
    fs::create_dir_all(directory)?;
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("unsafe backup socket directory");
    }
    fs::set_permissions(directory, fs::Permissions::from_mode(0o755))?;
    // A separate daemon lock prevents a second process from stealing a live
    // listener. A stale socket after a crash can then be safely replaced.
    let _daemon = HostLock::acquire(directory)?;
    recover(host, project)?;
    if let Ok(metadata) = fs::symlink_metadata(socket) {
        if !metadata.file_type().is_socket() {
            bail!("unsafe backup socket");
        }
        fs::remove_file(socket)?;
    }
    let listener = std::os::unix::net::UnixListener::bind(socket)?;
    // Only the random project capability authorizes capture, including native
    // DynamicUser processes; the socket never grants a general host operation.
    fs::set_permissions(socket, fs::Permissions::from_mode(0o666))?;
    let active = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for stream in listener.incoming() {
            let stream = stream?;
            if active.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                active.fetch_sub(1, Ordering::AcqRel);
                eprintln!("Migration backup refused: too many connections");
                continue;
            }
            let slot = Slot(&active);
            scope.spawn(move || {
                let _slot = slot;
                if let Err(error) = handle(host, project, stream) {
                    eprintln!("Migration backup refused: {error}");
                }
            });
        }
        Ok(())
    })
}
/// One served connection; released even when its handler panics.
#[cfg(unix)]
struct Slot<'a>(&'a AtomicUsize);
#[cfg(unix)]
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
#[cfg(not(unix))]
fn serve(_host: &Host, _project: &Project, _socket: &Path) -> anyhow::Result<()> {
    bail!("migration backup agents require Unix sockets");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn capability_preflight_needs_no_database_or_host_configuration() {
        let temp = tempfile::tempdir().unwrap();
        let host = Host::new(temp.path());
        run(&host, None, Action::CheckSupport).unwrap();
        assert!(!host.root().join(crate::host::MANIFEST).exists());
    }
    #[test]
    fn wrong_capabilities_cannot_create_a_fence_or_invoke_host_effects() {
        let temp = tempfile::tempdir().unwrap();
        let host = Host::new(temp.path());
        let project = Project::new(
            "shop",
            &host.project_dir("shop"),
            crate::host::Runtime::Docker,
        );
        crate::private_fs::dir(&project.dir).unwrap();
        crate::private_fs::write(
            &project.path(".env"),
            format!("NELCOTA_MIGRATION_BACKUP_TOKEN={}\n", "a".repeat(64)),
        )
        .unwrap();
        for credential in [
            format!("1{}", "b".repeat(64)),
            format!("2{}", "a".repeat(64)),
        ] {
            let (server, mut client) = std::os::unix::net::UnixStream::pair().unwrap();
            client.write_all(credential.as_bytes()).unwrap();
            assert!(handle(&host, &project, server).is_err());
            assert!(!host.root().join(FENCE).exists());
            assert!(!project.path("backups").exists());
        }
    }
    #[test]
    fn a_stalled_caller_is_dropped_at_the_capability_deadline() {
        let temp = tempfile::tempdir().unwrap();
        let host = Host::new(temp.path());
        let project = Project::new(
            "shop",
            &host.project_dir("shop"),
            crate::host::Runtime::Docker,
        );
        crate::private_fs::dir(&project.dir).unwrap();
        crate::private_fs::write(
            &project.path(".env"),
            format!("NELCOTA_MIGRATION_BACKUP_TOKEN={}\n", "a".repeat(64)),
        )
        .unwrap();
        let (server, mut client) = std::os::unix::net::UnixStream::pair().unwrap();
        // A slow drip of a valid prefix must not extend the deadline.
        let drip = std::thread::spawn(move || {
            for _ in 0..8 {
                if client.write_all(b"1").is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(400));
            }
        });
        let started = Instant::now();
        assert!(handle(&host, &project, server).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(!host.root().join(FENCE).exists());
        drip.join().unwrap();
    }
}
