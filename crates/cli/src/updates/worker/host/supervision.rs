//! Detached host task supervision and durable restart reconciliation.
use super::super::State;
use nelcota_deployment::{
    HostLock,
    management::{HostJournal, Stage},
};
use nelcota_deployment::{Journal, Phase};
use std::{
    os::unix::process::CommandExt,
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) async fn launch(state: &Arc<State>, id: &str, recover: bool) -> anyhow::Result<()> {
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
pub(super) fn spawn_child(
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
pub(super) async fn mark_interrupted(root: &std::path::Path, id: &str) -> anyhow::Result<()> {
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
pub(in crate::updates) fn reconcile_after_restart(root: &std::path::Path) -> anyhow::Result<()> {
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
pub(super) async fn reconcile_pending(
    root: &std::path::Path,
    ids: &[String],
) -> anyhow::Result<()> {
    reconcile_pending_all(root, ids, &[]).await
}
pub(super) async fn reconcile_pending_all(
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
