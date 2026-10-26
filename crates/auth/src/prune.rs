//! Removes refresh tokens and sessions that can never be used again, so
//! `auth.refresh_tokens` and `auth.sessions` do not grow forever.
//!
//! - refresh tokens past `expires_at` (a revoked token stays until then: it
//!   is what reuse detection recognizes);
//! - sessions revoked more than [`REVOKED_SESSION_RETENTION`] ago, kept that
//!   long for whoever inspects recent logouts and revocations;
//! - sessions left without any token (all expired): nothing can refresh them.

use std::time::Duration;

use deadpool_postgres::Pool;
use nelcota_core::ApiError;

use crate::db::{begin_auth, db_error};

/// How long a revoked session row is kept.
pub const REVOKED_SESSION_RETENTION: Duration = Duration::from_secs(7 * 86_400);
const EVERY: Duration = Duration::from_secs(3600);
/// Rows per DELETE, so a large backlog never holds locks for long.
const BATCH: i64 = 5000;

/// What one pass removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pruned {
    pub refresh_tokens: u64,
    pub sessions: u64,
}

/// Runs [`prune`] in the background, once an hour.
pub fn spawn_pruner(pool: Pool) {
    // Preserve the existing detached helper for the monolith.
    drop(pruner_task(pool));
}

/// Owned pruner task for hosts that explicitly abort and await it at shutdown.
pub fn pruner_task(pool: Pool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(EVERY);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match prune(&pool).await {
                Ok(Pruned {
                    refresh_tokens: 0,
                    sessions: 0,
                }) => {}
                Ok(pruned) => tracing::info!(
                    refresh_tokens = pruned.refresh_tokens,
                    sessions = pruned.sessions,
                    "expired auth sessions removed"
                ),
                Err(err) => tracing::warn!(error = err.message(), "auth session pruning failed"),
            }
        }
    })
}

/// One pass, in batches of [`BATCH`] rows per transaction.
pub async fn prune(pool: &Pool) -> Result<Pruned, ApiError> {
    let retention = REVOKED_SESSION_RETENTION.as_secs_f64();
    let refresh_tokens = batched(
        pool,
        "DELETE FROM auth.refresh_tokens WHERE id IN (
             SELECT id FROM auth.refresh_tokens WHERE expires_at < now() LIMIT $1)",
        None,
    )
    .await?;
    // A session gets its first token in the transaction that creates it, so
    // one without tokens has had them all expire.
    let sessions = batched(
        pool,
        "DELETE FROM auth.sessions WHERE id IN (
             SELECT s.id FROM auth.sessions s
             WHERE s.revoked_at < now() - make_interval(secs => $2)
                OR NOT EXISTS (SELECT 1 FROM auth.refresh_tokens rt WHERE rt.session_id = s.id)
             LIMIT $1)",
        Some(retention),
    )
    .await?;
    batched(
        pool,
        "DELETE FROM auth.one_time_tokens WHERE id IN (
             SELECT id FROM auth.one_time_tokens
             WHERE expires_at < now()
                OR (used_at IS NOT NULL AND created_at <= now() - make_interval(secs => $2))
             LIMIT $1)",
        Some(60.0),
    )
    .await?;
    batched(
        pool,
        "DELETE FROM auth.flow_states WHERE id IN (
             SELECT id FROM auth.flow_states WHERE expires_at < now() LIMIT $1)",
        None,
    )
    .await?;
    Ok(Pruned {
        refresh_tokens,
        sessions,
    })
}

async fn batched(pool: &Pool, sql: &str, retention: Option<f64>) -> Result<u64, ApiError> {
    let mut total = 0;
    loop {
        let mut client = pool.get().await.map_err(ApiError::from_pool)?;
        let tx = begin_auth(&mut client).await?;
        let removed = match retention {
            Some(secs) => tx.execute(sql, &[&BATCH, &secs]).await,
            None => tx.execute(sql, &[&BATCH]).await,
        }
        .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        total += removed;
        if removed < BATCH as u64 {
            return Ok(total);
        }
    }
}
