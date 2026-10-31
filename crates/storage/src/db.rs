//! Queries under the internal `nelcota_storage` role (no JWT can assume it):
//! bucket settings, files reached by a public or signed URL, and the rows
//! the collector checks. Everything a caller asks for runs as the caller.

use std::{
    collections::HashSet,
    time::{Duration, SystemTime},
};

use deadpool_postgres::{Pool, Transaction};
use nelcota_core::{ApiError, Role};
use tokio_postgres::Row;
use uuid::Uuid;

pub struct Bucket {
    pub public: bool,
    pub file_size_limit: Option<u64>,
    pub allowed_mime_types: Option<Vec<String>>,
}

/// What serving a file needs from its row.
pub struct Object {
    pub version: Uuid,
    pub size: u64,
    pub mime_type: String,
    pub etag: String,
    pub updated_at: SystemTime,
}

/// Columns read by [`Object::from_row`], in order.
pub const OBJECT_COLUMNS: &str = "version, size, mime_type, etag, \
     floor(extract(epoch FROM updated_at))::bigint";

impl Object {
    pub fn from_row(row: &Row) -> Self {
        let size: i64 = row.get(1);
        let updated: i64 = row.get(4);
        Object {
            version: row.get(0),
            size: size.max(0) as u64,
            mime_type: row.get(2),
            etag: row.get(3),
            updated_at: SystemTime::UNIX_EPOCH + Duration::from_secs(updated.max(0) as u64),
        }
    }
}

fn db_error(err: tokio_postgres::Error) -> ApiError {
    ApiError::from_db(err, Role::ServiceRole)
}

/// Runs `query` in a transaction as `nelcota_storage`.
async fn internal<T>(
    pool: &Pool,
    query: impl AsyncFnOnce(&Transaction<'_>) -> Result<T, tokio_postgres::Error>,
) -> Result<T, ApiError> {
    let mut client = pool.get().await.map_err(ApiError::from_pool)?;
    let tx = client.transaction().await.map_err(db_error)?;
    tx.batch_execute("SET LOCAL ROLE nelcota_storage")
        .await
        .map_err(db_error)?;
    let value = query(&tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(value)
}

pub async fn bucket(pool: &Pool, id: &str) -> Result<Option<Bucket>, ApiError> {
    let row = internal(pool, async |tx| {
        tx.query_opt(
            "SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = $1",
            &[&id],
        )
        .await
    })
    .await?;
    Ok(row.map(|row| Bucket {
        public: row.get(0),
        file_size_limit: row.get::<_, Option<i64>>(1).map(|n| n.max(0) as u64),
        allowed_mime_types: row.get(2),
    }))
}

/// A file regardless of policies: only after a public bucket or a valid
/// signature has granted access.
pub async fn object(pool: &Pool, bucket: &str, name: &str) -> Result<Option<Object>, ApiError> {
    let sql =
        format!("SELECT {OBJECT_COLUMNS} FROM storage.objects WHERE bucket_id = $1 AND name = $2");
    let row = internal(pool, async |tx| tx.query_opt(&sql, &[&bucket, &name]).await).await?;
    Ok(row.as_ref().map(Object::from_row))
}

/// Bytes stored in all buckets.
pub async fn used_bytes(pool: &Pool) -> Result<u64, ApiError> {
    let row = internal(pool, async |tx| {
        tx.query_one("SELECT bytes FROM storage.usage WHERE singleton", &[])
            .await
    })
    .await?;
    Ok(row.get::<_, i64>(0).max(0) as u64)
}

/// Which of `versions` some row still points to.
pub async fn known_versions(pool: &Pool, versions: &[Uuid]) -> Result<HashSet<Uuid>, ApiError> {
    let rows = internal(pool, async |tx| {
        tx.query(
            "SELECT version FROM storage.objects WHERE version = ANY($1)",
            &[&versions],
        )
        .await
    })
    .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}
