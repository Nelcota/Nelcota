use super::{DELIVERIES, delivery, delivery_id, uuid};
use crate::{
    Error, invalid,
    models::{Attempt, DeliveryDetail, DeliveryPage, HistoryQuery},
};
use deadpool_postgres::Pool;

const PAGE_SIZE: i64 = 25;

pub async fn history(pool: &Pool, query: HistoryQuery) -> Result<DeliveryPage, Error> {
    let endpoint = query.endpoint.as_deref().map(uuid).transpose()?;
    let before = query.before.as_deref().map(delivery_id).transpose()?;
    if query.status.as_deref().is_some_and(|s| {
        !matches!(
            s,
            "pending" | "processing" | "succeeded" | "failed" | "cancelled"
        )
    }) {
        return Err(invalid("webhook_invalid_status", "Invalid delivery status"));
    }
    let client = pool.get().await?;
    let rows = client.query(&format!("{DELIVERIES} WHERE ($1::uuid IS NULL OR d.endpoint_id=$1) AND ($2::text IS NULL OR d.status=$2) AND ($3::bigint IS NULL OR d.id<$3) ORDER BY d.id DESC LIMIT $4"), &[&endpoint, &query.status, &before, &(PAGE_SIZE+1)]).await?;
    let next_cursor = match rows.len() > PAGE_SIZE as usize {
        true => Some(rows[(PAGE_SIZE - 1) as usize].get("id")),
        false => None,
    };
    Ok(DeliveryPage {
        deliveries: rows.iter().take(PAGE_SIZE as usize).map(delivery).collect(),
        next_cursor,
    })
}

pub async fn detail(pool: &Pool, id: &str) -> Result<DeliveryDetail, Error> {
    let id = delivery_id(id)?;
    let mut client = pool.get().await?;
    let tx = client
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await?;
    let row = tx
        .query_opt(&format!("{DELIVERIES} WHERE d.id=$1"), &[&id])
        .await?
        .ok_or(Error::NotFound)?;
    let payload: String = tx
        .query_one(
            "SELECT payload FROM nelcota.webhook_deliveries WHERE id=$1",
            &[&id],
        )
        .await?
        .get(0);
    let attempts = tx.query("SELECT number, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS started_at, to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS finished_at, status_code, duration_ms, error FROM nelcota.webhook_attempts WHERE delivery_id=$1 ORDER BY number DESC", &[&id]).await?.iter().map(|r| Attempt { number: r.get("number"), started_at: r.get("started_at"), finished_at: r.get("finished_at"), status_code: r.get("status_code"), duration_ms: r.get("duration_ms"), error: r.get("error") }).collect();
    tx.commit().await?;
    Ok(DeliveryDetail {
        delivery: delivery(&row),
        payload,
        attempts,
    })
}

/// A replay is a new delivery with the same event id/body. It preserves the
/// original attempts, uses the current destination and never races an active job.
pub async fn replay(pool: &Pool, id: &str) -> Result<String, Error> {
    let id = delivery_id(id)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    // Lock endpoint before delivery, the same order as endpoint deletion.
    let endpoint = tx.query_opt("SELECT e.id, e.enabled, e.deleted_at IS NOT NULL AS deleted FROM nelcota.webhook_endpoints e JOIN nelcota.webhook_deliveries d ON d.endpoint_id=e.id WHERE d.id=$1 FOR UPDATE OF e", &[&id]).await?.ok_or(Error::NotFound)?;
    if endpoint.get::<_, bool>("deleted") || !endpoint.get::<_, bool>("enabled") {
        return Err(Error::Conflict {
            code: "webhook_paused",
            message: "Enable the webhook before resending",
        });
    }
    let old = tx
        .query_opt(
            "SELECT status, last_error, endpoint_id, event_id FROM nelcota.webhook_deliveries WHERE id=$1 FOR UPDATE",
            &[&id],
        )
        .await?
        .ok_or(Error::NotFound)?;
    if !matches!(old.get::<_, &str>("status"), "succeeded" | "failed") {
        return Err(Error::Conflict {
            code: "webhook_delivery_active",
            message: "Wait for the current delivery to finish",
        });
    }
    // Both failures store the event without its row data, so it cannot be resent.
    if matches!(
        old.get::<_, Option<&str>>("last_error"),
        Some("payload_too_large" | "queue_full")
    ) {
        return Err(Error::Conflict {
            code: "webhook_payload_omitted",
            message: "This event was recorded without its contents and cannot be resent",
        });
    }
    let endpoint_id: uuid::Uuid = old.get("endpoint_id");
    let event_id: uuid::Uuid = old.get("event_id");
    // Serializes duplicate clicks, even across panel sessions or instances.
    if tx.query_one("SELECT EXISTS (SELECT FROM nelcota.webhook_deliveries WHERE (replay_of=$1 OR (endpoint_id=$2 AND event_id=$3)) AND status IN ('pending','processing'))", &[&id, &endpoint_id, &event_id]).await?.get::<_, bool>(0) { return Err(Error::Conflict { code: "webhook_delivery_active", message: "A resend is already queued" }); }
    let new_id: String = tx.query_one("INSERT INTO nelcota.webhook_deliveries (endpoint_id,event_id,replay_of,schema_name,table_name,event,url,payload,max_attempts) SELECT d.endpoint_id,d.event_id,d.id,d.schema_name,d.table_name,d.event,e.url,d.payload,e.max_attempts FROM nelcota.webhook_deliveries d JOIN nelcota.webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1 RETURNING id::text", &[&id]).await?.get(0);
    tx.commit().await?;
    Ok(new_id)
}

/// Explicit panel action clears only terminal history; the queue is untouched.
pub async fn clear_history(pool: &Pool) -> Result<u64, Error> {
    let client = pool.get().await?;
    Ok(client.execute("DELETE FROM nelcota.webhook_deliveries WHERE status IN ('succeeded','failed','cancelled')", &[]).await?)
}
