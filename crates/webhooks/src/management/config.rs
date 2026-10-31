use super::{ENDPOINTS, endpoint, uuid};
use crate::{
    Error,
    destination::Policy,
    invalid,
    models::{Endpoint, EndpointInput, NewSecret},
    signing,
};
use deadpool_postgres::Pool;

pub async fn list(pool: &Pool) -> Result<Vec<Endpoint>, Error> {
    let client = pool.get().await?;
    Ok(client
        .query(
            &format!("{ENDPOINTS} WHERE e.deleted_at IS NULL ORDER BY e.created_at, e.id"),
            &[],
        )
        .await?
        .iter()
        .map(endpoint)
        .collect())
}

fn allowed_schema(schema: &str) -> bool {
    !matches!(
        schema,
        "nelcota" | "auth" | "storage" | "extensions" | "information_schema"
    ) && !schema.starts_with("pg_")
}

pub async fn tables(pool: &Pool, schema: &str) -> Result<Vec<String>, Error> {
    if !allowed_schema(schema) {
        return Ok(Vec::new());
    }
    let client = pool.get().await?;
    Ok(client.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' AND NOT c.relispartition ORDER BY c.relname", &[&schema]).await?.iter().map(|r| r.get(0)).collect())
}

fn validate(mut input: EndpointInput, policy: Policy) -> Result<EndpointInput, Error> {
    input.name = input.name.trim().to_owned();
    if input.name.is_empty()
        || input.name.chars().count() > 80
        || input.name.chars().any(char::is_control)
    {
        return Err(invalid(
            "webhook_invalid_name",
            "Name must contain 1 to 80 characters",
        ));
    }
    if !(1..=10).contains(&input.max_attempts) {
        return Err(invalid(
            "webhook_invalid_attempts",
            "Choose 1 to 10 delivery attempts",
        ));
    }
    if input.events.is_empty()
        || input.events.len() > 3
        || input
            .events
            .iter()
            .any(|e| !matches!(e.as_str(), "INSERT" | "UPDATE" | "DELETE"))
    {
        return Err(invalid(
            "webhook_invalid_events",
            "Choose INSERT, UPDATE or DELETE",
        ));
    }
    input.events.sort();
    input.events.dedup();
    input.url = policy.validate(&input.url)?.to_string();
    Ok(input)
}

pub async fn create(
    pool: &Pool,
    schema: &str,
    input: EndpointInput,
    policy: Policy,
) -> Result<NewSecret, Error> {
    let input = validate(input, policy)?;
    if !allowed_schema(schema) {
        return Err(invalid(
            "webhook_invalid_table",
            "Internal schemas cannot be watched",
        ));
    }
    let secret = signing::generate_secret()?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    // Short lock timeout: configuring a hook never freezes panel traffic.
    tx.batch_execute("SET LOCAL lock_timeout = '3s'; SELECT pg_advisory_xact_lock(173470, 1)")
        .await?;
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM nelcota.webhook_endpoints WHERE deleted_at IS NULL",
            &[],
        )
        .await?
        .get(0);
    if count >= 50 {
        return Err(invalid("webhook_limit", "At most 50 webhooks per project"));
    }
    let table = tx.query_opt("SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS qualified FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r' AND NOT c.relispartition", &[&schema, &input.table]).await?.ok_or_else(|| invalid("webhook_invalid_table", "Choose an ordinary table in the exposed schema"))?;
    let oid: u32 = table.get("oid");
    let qualified: String = table.get("qualified");
    let count: i64 = tx.query_one("SELECT count(*) FROM nelcota.webhook_endpoints WHERE table_oid = $1 AND deleted_at IS NULL", &[&oid]).await?.get(0);
    if count >= 10 {
        return Err(invalid(
            "webhook_table_limit",
            "At most 10 webhooks per table",
        ));
    }
    // Only a PostgreSQL-quoted identifier is interpolated. LOCK pins the OID
    // against a concurrent drop/rename between inspection and trigger creation.
    tx.batch_execute(&format!(
        "LOCK TABLE {qualified} IN SHARE ROW EXCLUSIVE MODE"
    ))
    .await?;
    let still_same: bool = tx.query_one("SELECT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1 AND n.nspname=$2 AND c.relname=$3)", &[&oid, &schema, &input.table]).await?.get(0);
    if !still_same {
        return Err(invalid(
            "webhook_invalid_table",
            "The table changed while configuring the webhook; retry",
        ));
    }
    let has_trigger: bool = tx.query_one("SELECT EXISTS (SELECT FROM pg_trigger WHERE tgrelid = $1 AND tgname = 'nelcota_webhook_events' AND tgfoid = 'nelcota.capture_webhook_event()'::regprocedure)", &[&oid]).await?.get(0);
    if !has_trigger {
        tx.batch_execute(&format!("CREATE TRIGGER nelcota_webhook_events AFTER INSERT OR UPDATE OR DELETE ON {qualified} FOR EACH ROW EXECUTE FUNCTION nelcota.capture_webhook_event()")).await?;
    }
    let id: uuid::Uuid = tx.query_one("INSERT INTO nelcota.webhook_endpoints (name, table_oid, schema_name, table_name, url, events, enabled, signing_secret, max_attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", &[&input.name, &oid, &schema, &input.table, &input.url, &input.events, &input.enabled, &secret.expose(), &input.max_attempts]).await?.get(0);
    let row = tx
        .query_one(&format!("{ENDPOINTS} WHERE e.id = $1"), &[&id])
        .await?;
    tx.commit().await?;
    Ok(NewSecret {
        endpoint: endpoint(&row),
        secret,
    })
}

pub async fn update(
    pool: &Pool,
    id: &str,
    input: EndpointInput,
    policy: Policy,
) -> Result<Endpoint, Error> {
    let id = uuid(id)?;
    let input = validate(input, policy)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let row = tx
        .query_opt(
            &format!("{ENDPOINTS} WHERE e.id = $1 AND e.deleted_at IS NULL FOR UPDATE OF e"),
            &[&id],
        )
        .await?
        .ok_or(Error::NotFound)?;
    if input.table != row.get::<_, String>("table_name") {
        return Err(invalid(
            "webhook_table_immutable",
            "Create another webhook to watch a different table",
        ));
    }
    if input.enabled && !row.get::<_, bool>("table_available") {
        return Err(invalid(
            "webhook_invalid_table",
            "The watched table no longer exists",
        ));
    }
    tx.execute("UPDATE nelcota.webhook_endpoints SET name=$2, url=$3, events=$4, enabled=$5, max_attempts=$6 WHERE id=$1", &[&id, &input.name, &input.url, &input.events, &input.enabled, &input.max_attempts]).await?;
    // Queued work follows the new destination; the worker also resolves the
    // current URL for every send, so sends in progress finish as they are and
    // their retries use it too. This keeps the delivery history accurate.
    tx.execute("UPDATE nelcota.webhook_deliveries SET url=$2 WHERE endpoint_id=$1 AND status='pending' AND url<>$2", &[&id, &input.url]).await?;
    let row = tx
        .query_one(&format!("{ENDPOINTS} WHERE e.id = $1"), &[&id])
        .await?;
    tx.commit().await?;
    Ok(endpoint(&row))
}

pub async fn rotate(pool: &Pool, id: &str) -> Result<NewSecret, Error> {
    let id = uuid(id)?;
    let secret = signing::generate_secret()?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    if tx.execute("UPDATE nelcota.webhook_endpoints SET signing_secret=$2 WHERE id=$1 AND deleted_at IS NULL", &[&id, &secret.expose()]).await? == 0 { return Err(Error::NotFound); }
    let row = tx
        .query_one(&format!("{ENDPOINTS} WHERE e.id = $1"), &[&id])
        .await?;
    tx.commit().await?;
    Ok(NewSecret {
        endpoint: endpoint(&row),
        secret,
    })
}

pub async fn delete(pool: &Pool, id: &str) -> Result<(), Error> {
    let id = uuid(id)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL lock_timeout = '3s'; SELECT pg_advisory_xact_lock(173470, 1)")
        .await?;
    // Lock the watched relation BEFORE cancelling deliveries (and their usage
    // counter). Otherwise a writer holding this table could wait on our counter
    // while DROP TRIGGER waits on that writer, forming a lock cycle.
    loop {
        let watched = tx.query_opt("SELECT c.oid, n.nspname, c.relname, format('%I.%I',n.nspname,c.relname) AS qualified FROM nelcota.webhook_endpoints e JOIN pg_class c ON c.oid=e.table_oid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE e.id=$1 AND e.deleted_at IS NULL", &[&id]).await?;
        let watched = match watched {
            Some(watched) => watched,
            None => break,
        };
        let oid: u32 = watched.get(0);
        let schema: String = watched.get(1);
        let name: String = watched.get(2);
        let qualified: String = watched.get(3);
        tx.batch_execute("SAVEPOINT nelcota_webhook_lock").await?;
        let locked = tx
            .batch_execute(&format!(
                "LOCK TABLE {qualified} IN SHARE ROW EXCLUSIVE MODE"
            ))
            .await;
        match locked {
            Ok(()) => {
                tx.batch_execute("RELEASE SAVEPOINT nelcota_webhook_lock")
                    .await?;
            }
            Err(err) if err.code() == Some(&tokio_postgres::error::SqlState::UNDEFINED_TABLE) => {
                tx.batch_execute(
                    "ROLLBACK TO SAVEPOINT nelcota_webhook_lock; RELEASE SAVEPOINT nelcota_webhook_lock",
                )
                .await?;
                continue;
            }
            Err(err) => return Err(err.into()),
        }
        let still_same: bool = tx.query_one("SELECT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1 AND n.nspname=$2 AND c.relname=$3)", &[&oid, &schema, &name]).await?.get(0);
        if still_same {
            break;
        }
    }
    if tx.execute("UPDATE nelcota.webhook_endpoints SET enabled=false, deleted_at=clock_timestamp(), signing_secret=NULL WHERE id=$1 AND deleted_at IS NULL", &[&id]).await? == 0 { return Err(Error::NotFound); }
    // Match the queue's delivery-before-attempt lock order.
    tx.query("SELECT id FROM nelcota.webhook_deliveries WHERE endpoint_id=$1 AND status IN ('pending','processing') ORDER BY id FOR UPDATE", &[&id]).await?;
    tx.execute("UPDATE nelcota.webhook_attempts a SET finished_at=clock_timestamp(), error='endpoint_deleted' FROM nelcota.webhook_deliveries d WHERE a.delivery_id=d.id AND d.endpoint_id=$1 AND a.finished_at IS NULL", &[&id]).await?;
    tx.execute("UPDATE nelcota.webhook_deliveries SET status='cancelled', finished_at=clock_timestamp(), lease_token=NULL, locked_until=NULL, last_error='endpoint_deleted' WHERE endpoint_id=$1 AND status IN ('pending','processing')", &[&id]).await?;
    let table = tx.query_opt("SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS qualified FROM nelcota.webhook_endpoints e JOIN pg_class c ON c.oid=e.table_oid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE e.id=$1 AND NOT EXISTS (SELECT FROM nelcota.webhook_endpoints live WHERE live.table_oid=e.table_oid AND live.deleted_at IS NULL)", &[&id]).await?;
    if let Some(table) = table {
        let qualified: String = table.get("qualified");
        tx.batch_execute(&format!(
            "DROP TRIGGER IF EXISTS nelcota_webhook_events ON {qualified}"
        ))
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
