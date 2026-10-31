//! Short database transactions own leases. Connections are returned before HTTP.
use crate::{
    Error,
    models::{Job, Outcome},
};
use deadpool_postgres::{Pool, Transaction};
use nelcota_core::config::Secret;
use std::time::Duration;
use tokio::time::Instant;
use tokio_postgres::{Row, types::ToSql};
use uuid::Uuid;

/// Sends in flight per webhook, so one slow destination cannot hold every
/// worker slot while other webhooks wait behind it.
const PER_ENDPOINT: i64 = 2;

/// Leases whose worker stopped. Recovering them frees no new capacity.
/// Every send resolves the webhook's current URL and key, never a stored copy.
const EXPIRED: &str = "SELECT d.id,d.event_id,e.url,d.payload,d.attempts,d.max_attempts,d.status,e.enabled,e.signing_secret
    FROM nelcota.webhook_deliveries d JOIN nelcota.webhook_endpoints e ON e.id=d.endpoint_id
    WHERE e.deleted_at IS NULL AND d.status='processing' AND d.locked_until<=statement_timestamp()
    ORDER BY d.locked_until,d.id LIMIT $1 FOR UPDATE OF d SKIP LOCKED";

/// One round: the oldest due delivery of each enabled webhook below its
/// in-flight limit, oldest first. The materialized scan tries the advisory
/// lock of every enabled webhook it reads, before checking its in-flight
/// count or whether anything is due, and keeps each lock it gets until the
/// claim commits; a webhook whose lock another claim holds is skipped. Across
/// server instances a claim that commits between another's snapshot and its
/// lock can let one more send through.
const DUE: &str = "WITH ready AS MATERIALIZED (
        SELECT e.id,e.url,e.signing_secret FROM nelcota.webhook_endpoints e
        WHERE e.enabled AND e.deleted_at IS NULL
        AND pg_try_advisory_xact_lock(173471, hashtext(e.id::text))
        AND (SELECT count(*) FROM nelcota.webhook_deliveries busy
            WHERE busy.endpoint_id=e.id AND busy.status='processing'
            AND busy.locked_until>statement_timestamp()) < $2)
    SELECT d.id,d.event_id,ready.url,d.payload,d.attempts,d.max_attempts,d.status,true AS enabled,ready.signing_secret
    FROM ready CROSS JOIN LATERAL (
        SELECT pick.id,pick.event_id,pick.payload,pick.attempts,pick.max_attempts,pick.status,pick.next_attempt_at
        FROM nelcota.webhook_deliveries pick
        WHERE pick.endpoint_id=ready.id AND pick.status='pending' AND pick.next_attempt_at<=statement_timestamp()
        ORDER BY pick.next_attempt_at,pick.id LIMIT 1 FOR UPDATE SKIP LOCKED) d
    ORDER BY d.next_attempt_at,d.id LIMIT $1";

pub(crate) async fn claim(pool: &Pool, limit: usize) -> Result<Vec<Job>, Error> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL ROLE nelcota_webhooks; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'").await?;
    let mut jobs = Vec::with_capacity(limit);
    for row in tx.query(EXPIRED, &[&(limit as i64)]).await? {
        lease(&tx, &row, &mut jobs).await?;
    }
    // Each round adds at most one delivery per webhook. Claimed deliveries
    // are processing, so the next round counts them against the limit.
    for _ in 0..limit {
        let remaining = limit.saturating_sub(jobs.len());
        if remaining == 0 {
            break;
        }
        let batch = remaining as i64;
        let rows = tx.query(DUE, &[&batch, &PER_ENDPOINT]).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            lease(&tx, &row, &mut jobs).await?;
        }
    }
    tx.commit().await?;
    Ok(jobs)
}

/// Starts the next attempt, or settles an interrupted one that cannot run now.
async fn lease(tx: &Transaction<'_>, row: &Row, jobs: &mut Vec<Job>) -> Result<(), Error> {
    let id: i64 = row.get("id");
    let previous_attempts: i32 = row.get("attempts");
    if row.get::<_, &str>("status") == "processing" {
        tx.execute("UPDATE nelcota.webhook_attempts SET finished_at=clock_timestamp(),error='worker_interrupted' WHERE delivery_id=$1 AND finished_at IS NULL", &[&id]).await?;
        if previous_attempts >= row.get::<_, i32>("max_attempts") {
            tx.execute("UPDATE nelcota.webhook_deliveries SET status='failed',finished_at=clock_timestamp(),last_error='worker_interrupted',lease_token=NULL,locked_until=NULL WHERE id=$1", &[&id]).await?;
            return Ok(());
        }
        if !row.get::<_, bool>("enabled") {
            tx.execute("UPDATE nelcota.webhook_deliveries SET status='pending',last_error='worker_interrupted',lease_token=NULL,locked_until=NULL WHERE id=$1", &[&id]).await?;
            return Ok(());
        }
    }
    let lease = Uuid::new_v4();
    let attempt = previous_attempts + 1;
    // The URL and key come from the webhook as of this statement, not from the
    // claim's snapshot, so a retarget committed meanwhile is never undone.
    // History shows the destination of the latest send.
    let current = tx.query_one("UPDATE nelcota.webhook_deliveries d SET status='processing',attempts=$2,lease_token=$3,locked_until=clock_timestamp()+interval '120 seconds',finished_at=NULL,url=e.url FROM nelcota.webhook_endpoints e WHERE d.id=$1 AND e.id=d.endpoint_id RETURNING e.url,e.signing_secret", &[&id,&attempt,&lease]).await?;
    let url: String = current.get(0);
    tx.execute(
        "INSERT INTO nelcota.webhook_attempts (delivery_id,number) VALUES ($1,$2)",
        &[&id, &attempt],
    )
    .await?;
    jobs.push(Job {
        id,
        event_id: row.get("event_id"),
        attempt,
        lease,
        url,
        payload: row.get("payload"),
        secret: Secret::new(current.get::<_, String>(1)),
    });
    Ok(())
}

/// Consecutive DNS deferrals, two seconds apart, before the next one uses an
/// attempt like any other network failure: about a minute.
const MAX_DEFERRALS: i32 = 30;

pub(crate) async fn finish(pool: &Pool, job: &Job, outcome: Outcome) -> Result<(), Error> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL ROLE nelcota_webhooks; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'").await?;
    if outcome.deferred {
        // Nothing left this host: give the attempt back and retry shortly,
        // showing why in history. Past the limit it counts as an attempt.
        let updated = tx.execute("UPDATE nelcota.webhook_deliveries SET status='pending',attempts=attempts-1,deferrals=deferrals+1,last_error='dns_busy',next_attempt_at=clock_timestamp()+interval '2 seconds',lease_token=NULL,locked_until=NULL WHERE id=$1 AND lease_token=$2 AND status='processing' AND deferrals<$3", &[&job.id, &job.lease, &MAX_DEFERRALS]).await?;
        if updated != 0 {
            tx.execute(
                "DELETE FROM nelcota.webhook_attempts WHERE delivery_id=$1 AND number=$2",
                &[&job.id, &job.attempt],
            )
            .await?;
            tx.commit().await?;
            return Ok(());
        }
    }
    let delay = retry_delay(job.attempt, job.id, outcome.retry_after) as i64;
    // The lease token fences off a worker whose lease was recovered or cancelled.
    let updated = tx.execute("UPDATE nelcota.webhook_deliveries SET deferrals=0,status=CASE WHEN $3::text IS NULL THEN 'succeeded' WHEN $4 AND attempts<max_attempts THEN 'pending' ELSE 'failed' END, next_attempt_at=clock_timestamp()+$5::bigint*interval '1 second', finished_at=CASE WHEN $3::text IS NOT NULL AND $4 AND attempts<max_attempts THEN NULL ELSE clock_timestamp() END, last_status=$6,last_error=$3,lease_token=NULL,locked_until=NULL WHERE id=$1 AND lease_token=$2 AND status='processing'", &[&job.id,&job.lease,&outcome.error,&outcome.retryable,&delay,&outcome.status]).await?;
    if updated != 0 {
        tx.execute("UPDATE nelcota.webhook_attempts SET finished_at=clock_timestamp(),status_code=$3,duration_ms=$4,error=$5 WHERE delivery_id=$1 AND number=$2 AND finished_at IS NULL", &[&job.id,&job.attempt,&outcome.status,&outcome.duration_ms,&outcome.error]).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Bounded exponential schedule with deterministic per-delivery jitter, and a
/// bounded Retry-After. No hot retries, even when the receiver asks for zero.
fn retry_delay(attempt: i32, id: i64, retry_after: Option<u64>) -> u64 {
    let schedule = [5u64, 30, 120, 600, 1800, 3600];
    let base = schedule[(attempt.saturating_sub(1) as usize).min(schedule.len() - 1)];
    let jitter = (id
        .unsigned_abs()
        .wrapping_mul(2654435761)
        .wrapping_add(attempt as u64))
        % (base / 5 + 1);
    (base + jitter)
        .max(retry_after.unwrap_or(0).min(3600))
        .min(3600)
}

/// Terminal deliveries kept by retention. History never blocks business
/// writes; the oldest terminal rows beyond this cap are pruned instead.
const HISTORY_LIMIT: i64 = 100_000;
const PRUNE_BATCH: i64 = 500;
const FOLD_BATCH: i32 = 500;
/// Time one cleanup run may spend on each kind. Full batches continue until
/// it runs out, and a run that did not catch up is repeated shortly, so
/// cleanup keeps pace with a sustained overflow while claims run in between.
const PRUNE_BUDGET: Duration = Duration::from_secs(1);

/// Retention runs in small batches so cascade cleanup does not monopolize the
/// queue pool. It folds committed counter overflow rows, deletes terminal
/// history older than 7 days, then terminal rows beyond the newest
/// `HISTORY_LIMIT`. Age cleanup runs on its own, so a slow cap query never
/// stops it; the cap's cutoff is computed once per run. Pending/processing
/// work is kept. Returns whether every kind caught up.
pub(crate) async fn prune(pool: &Pool) -> Result<bool, Error> {
    let folded = drain(pool, FOLD_OVERFLOW, &[&FOLD_BATCH], i64::from(FOLD_BATCH)).await?;
    let aged = drain(pool, PRUNE_AGED, &[&PRUNE_BATCH], PRUNE_BATCH).await?;
    let cutoff = match history_cutoff(pool).await? {
        Some(cutoff) => cutoff,
        None => return Ok(folded && aged),
    };
    let (finished_at, id) = cutoff;
    let params: [&(dyn ToSql + Sync); 3] = [&finished_at, &id, &PRUNE_BATCH];
    let capped = drain(pool, PRUNE_CAPPED, &params, PRUNE_BATCH).await?;
    Ok(folded && aged && capped)
}

/// Runs batches while they come back full, within `PRUNE_BUDGET`. Returns
/// whether a partial batch showed that nothing is left for now.
async fn drain(
    pool: &Pool,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
    full: i64,
) -> Result<bool, Error> {
    let deadline = Instant::now() + PRUNE_BUDGET;
    loop {
        if prune_batch(pool, sql, params).await? < full {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
    }
}

/// Each cleanup statement returns how many rows it handled.
async fn prune_batch(pool: &Pool, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<i64, Error> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL ROLE nelcota_webhooks; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'").await?;
    let handled: i64 = tx.query_one(sql, params).await?.get(0);
    tx.commit().await?;
    Ok(handled)
}

/// The newest terminal delivery beyond `HISTORY_LIMIT`, as (finished_at as
/// text, id): it and everything older is pruned. `None` while within the cap.
async fn history_cutoff(pool: &Pool) -> Result<Option<(String, i64)>, Error> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL ROLE nelcota_webhooks; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'").await?;
    let row = tx.query_opt(CUTOFF, &[&HISTORY_LIMIT]).await?;
    tx.commit().await?;
    Ok(row.map(|row| (row.get(0), row.get(1))))
}

const FOLD_OVERFLOW: &str = "SELECT nelcota.fold_webhook_queue_overflow($1)::bigint";

const PRUNE_AGED: &str = "WITH gone AS (DELETE FROM nelcota.webhook_deliveries WHERE id IN (
    SELECT id FROM nelcota.webhook_deliveries
    WHERE finished_at < statement_timestamp() - interval '7 days'
    AND status IN ('succeeded','failed','cancelled')
    ORDER BY finished_at, id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING 1)
    SELECT count(*) FROM gone";

const CUTOFF: &str = "SELECT k.finished_at::text, k.id FROM nelcota.webhook_deliveries k
    WHERE k.finished_at IS NOT NULL AND k.status IN ('succeeded','failed','cancelled')
    ORDER BY k.finished_at DESC, k.id DESC OFFSET $1 LIMIT 1";

const PRUNE_CAPPED: &str = "WITH gone AS (DELETE FROM nelcota.webhook_deliveries WHERE id IN (
    SELECT id FROM nelcota.webhook_deliveries
    WHERE finished_at IS NOT NULL AND status IN ('succeeded','failed','cancelled')
    AND (finished_at, id) <= ($1::text::timestamptz, $2)
    ORDER BY finished_at, id LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING 1)
    SELECT count(*) FROM gone";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_are_bounded_and_spread_out() {
        for attempt in 1..=10 {
            assert!((5..=3600).contains(&retry_delay(attempt, 1, None)));
            assert!(retry_delay(attempt, 1, Some(u64::MAX)) <= 3600);
        }
        assert_eq!(retry_delay(1, 1, Some(300)), 300);
        assert!(retry_delay(1, 1, Some(0)) >= 5);
        assert!(retry_delay(2, 1, None) >= 30);
        assert_ne!(retry_delay(3, 1, None), retry_delay(3, 2, None));
    }
}
