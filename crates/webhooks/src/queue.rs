//! Short database transactions own leases. Connections are returned before HTTP.
use crate::{
    Error,
    models::{Job, Outcome},
};
use deadpool_postgres::Pool;
use nelcota_core::config::Secret;
use uuid::Uuid;

pub(crate) async fn claim(pool: &Pool, limit: usize) -> Result<Vec<Job>, Error> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL ROLE nelcota_webhooks; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'").await?;
    let mut jobs = Vec::with_capacity(limit);
    for _ in 0..4 {
        let remaining = limit.saturating_sub(jobs.len());
        if remaining == 0 {
            break;
        }
        let rows = tx.query("SELECT d.id,d.event_id,d.url,d.payload,d.attempts,d.max_attempts,d.status,e.enabled,e.signing_secret FROM nelcota.webhook_deliveries d JOIN nelcota.webhook_endpoints e ON e.id=d.endpoint_id WHERE e.deleted_at IS NULL AND ((d.status='pending' AND e.enabled AND d.next_attempt_at<=statement_timestamp()) OR (d.status='processing' AND d.locked_until<=statement_timestamp())) ORDER BY d.next_attempt_at,d.id LIMIT $1 FOR UPDATE OF d SKIP LOCKED", &[&(remaining as i64)]).await?;
        let fetched = rows.len();
        for row in rows {
            let id: i64 = row.get("id");
            let previous_attempts: i32 = row.get("attempts");
            if row.get::<_, &str>("status") == "processing" {
                tx.execute("UPDATE nelcota.webhook_attempts SET finished_at=clock_timestamp(),error='worker_interrupted' WHERE delivery_id=$1 AND finished_at IS NULL", &[&id]).await?;
                if previous_attempts >= row.get::<_, i32>("max_attempts") {
                    tx.execute("UPDATE nelcota.webhook_deliveries SET status='failed',finished_at=clock_timestamp(),last_error='worker_interrupted',lease_token=NULL,locked_until=NULL WHERE id=$1", &[&id]).await?;
                    continue;
                }
                if !row.get::<_, bool>("enabled") {
                    tx.execute("UPDATE nelcota.webhook_deliveries SET status='pending',last_error='worker_interrupted',lease_token=NULL,locked_until=NULL WHERE id=$1", &[&id]).await?;
                    continue;
                }
            }
            let lease = Uuid::new_v4();
            let attempt = previous_attempts + 1;
            tx.execute("UPDATE nelcota.webhook_deliveries SET status='processing',attempts=$2,lease_token=$3,locked_until=clock_timestamp()+interval '120 seconds',finished_at=NULL WHERE id=$1", &[&id,&attempt,&lease]).await?;
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
                url: row.get("url"),
                payload: row.get("payload"),
                secret: Secret::new(row.get::<_, String>("signing_secret")),
            });
        }
        if fetched < remaining {
            break;
        }
    }
    tx.commit().await?;
    Ok(jobs)
}

pub(crate) async fn finish(pool: &Pool, job: &Job, outcome: Outcome) -> Result<(), Error> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL ROLE nelcota_webhooks; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'").await?;
    let delay = retry_delay(job.attempt, job.id, outcome.retry_after) as i64;
    // The lease token fences off a worker whose lease was recovered or cancelled.
    let updated = tx.execute("UPDATE nelcota.webhook_deliveries SET status=CASE WHEN $3::text IS NULL THEN 'succeeded' WHEN $4 AND attempts<max_attempts THEN 'pending' ELSE 'failed' END, next_attempt_at=clock_timestamp()+$5::bigint*interval '1 second', finished_at=CASE WHEN $3::text IS NOT NULL AND $4 AND attempts<max_attempts THEN NULL ELSE clock_timestamp() END, last_status=$6,last_error=$3,lease_token=NULL,locked_until=NULL WHERE id=$1 AND lease_token=$2 AND status='processing'", &[&job.id,&job.lease,&outcome.error,&outcome.retryable,&delay,&outcome.status]).await?;
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
const PRUNE_BATCH: u64 = 500;
/// Batches per cleanup run, so a burst of history is caught up within minutes.
const PRUNE_BATCHES: usize = 40;

/// Retention runs in small batches so cascade cleanup does not monopolize the
/// queue pool. It deletes terminal history older than 7 days or beyond the
/// newest `HISTORY_LIMIT` terminal deliveries. Pending/processing work is kept.
pub(crate) async fn prune(pool: &Pool) -> Result<(), Error> {
    for _ in 0..PRUNE_BATCHES {
        if prune_batch(pool).await? < PRUNE_BATCH {
            break;
        }
    }
    Ok(())
}

async fn prune_batch(pool: &Pool) -> Result<u64, Error> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL ROLE nelcota_webhooks; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'").await?;
    let deleted = tx
        .execute(PRUNE, &[&HISTORY_LIMIT, &(PRUNE_BATCH as i64)])
        .await?;
    tx.commit().await?;
    Ok(deleted)
}

const PRUNE: &str = "DELETE FROM nelcota.webhook_deliveries WHERE id IN (
    SELECT id FROM nelcota.webhook_deliveries
    WHERE finished_at IS NOT NULL AND status IN ('succeeded','failed','cancelled')
    AND (finished_at < statement_timestamp() - interval '7 days'
        OR (finished_at, id) <= (SELECT k.finished_at, k.id FROM nelcota.webhook_deliveries k
            WHERE k.finished_at IS NOT NULL AND k.status IN ('succeeded','failed','cancelled')
            ORDER BY k.finished_at DESC, k.id DESC OFFSET $1 LIMIT 1))
    ORDER BY finished_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)";

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
