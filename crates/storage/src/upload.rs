//! Streamed file writes, quota enforcement and atomic metadata publication.
use crate::{
    StorageState, db,
    error::{bucket_not_found, store_failed, too_large, write_error},
    mime::{self, SNIFF_BYTES},
    path, quota,
    store::{PARTS_IN_FLIGHT, Store},
};
use axum::http::StatusCode;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use nelcota_core::{ApiError, Claims, db::begin_request};
use object_store::path::Path as Key;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::pin::Pin;
use uuid::Uuid;

pub type UploadStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;
#[derive(Default)]
pub struct UploadOptions {
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
    pub replace: bool,
}
#[derive(Serialize)]
pub struct UploadedObject {
    pub id: Uuid,
    pub bucket: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub etag: String,
}
pub struct UploadOutcome {
    pub object: UploadedObject,
    pub replaced: bool,
    pub public: bool,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// `POST`: a new name only.
    Create,
    /// `PUT`: create or replace.
    Upsert,
}

const INSERT: &str =
    "INSERT INTO storage.objects (id, bucket_id, name, version, size, mime_type, etag)
     VALUES ($1, $2, $3, $4, $5, $6, $7)";
const UPSERT: &str =
    "INSERT INTO storage.objects (id, bucket_id, name, version, size, mime_type, etag)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (bucket_id, name) DO UPDATE
        SET version = EXCLUDED.version, size = EXCLUDED.size,
            mime_type = EXCLUDED.mime_type, etag = EXCLUDED.etag, updated_at = now()
     RETURNING id";

/// Owns byte storage and the metadata commit; HTTP adapters supply a byte stream.
impl StorageState {
    pub async fn upload(
        &self,
        claims: Claims,
        bucket: &str,
        name: &str,
        options: UploadOptions,
        body: UploadStream,
    ) -> Result<UploadOutcome, ApiError> {
        write(self.clone(), claims, bucket, name, options, body).await
    }
}
async fn write(
    state: StorageState,
    claims: Claims,
    bucket: &str,
    name: &str,
    options: UploadOptions,
    body: UploadStream,
) -> Result<UploadOutcome, ApiError> {
    let deadline = tokio::time::Instant::now() + state.settings.upload_timeout;
    let mode = match options.replace {
        true => Mode::Upsert,
        false => Mode::Create,
    };
    let bucket = path::bucket(bucket)?;
    let name = path::object(name)?;
    // One deadline covers pool waits, the policy check, admission and bytes.
    // Active uploads are bounded; overload never builds an unbounded queue.
    let (settings, limit, mut reservation, _slot) = tokio::time::timeout_at(deadline, async {
        let slot = state.uploads.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "upload_busy",
                "all upload slots are busy; retry later",
            )
        })?;
        let settings = db::bucket(&state.pool, bucket)
            .await?
            .ok_or_else(bucket_not_found)?;
        let limit = settings
            .file_size_limit
            .map_or(state.settings.max_file_size, |l| {
                l.min(state.settings.max_file_size)
            });
        let declared = options.content_length;
        if declared.is_some_and(|len| len > limit) {
            return Err(too_large(limit));
        }
        // The policy check before any byte is taken (D78): the same write with
        // placeholder values, rolled back.
        let old_size = {
            let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
            let tx = begin_request(&mut client, &claims)
                .await
                .map_err(|e| ApiError::from_db(e, claims.role()))?;
            let old_size = match mode == Mode::Upsert {
                true => tx
                    .query_opt(
                        "SELECT size FROM storage.objects WHERE bucket_id = $1 AND name = $2",
                        &[&bucket, &name],
                    )
                    .await
                    .map_err(|e| write_error(e, &claims))?
                    .map_or(0, |row| row.get::<_, i64>(0).max(0) as u64),
                false => 0,
            };
            let sql = match mode == Mode::Create {
                true => INSERT,
                false => UPSERT,
            };
            let placeholder: [&(dyn tokio_postgres::types::ToSql + Sync); 7] = [
                &Uuid::now_v7(),
                &bucket,
                &name,
                &Uuid::now_v7(),
                &0i64,
                &"application/octet-stream",
                &"",
            ];
            tx.execute(sql, &placeholder)
                .await
                .map_err(|e| write_error(e, &claims))?;
            old_size
        };

        state
            .store
            .ensure_ownership(&state.pool)
            .await
            .map_err(store_failed)?;
        let reservation = quota::reserve(&state, old_size, declared, limit).await?;
        Ok::<_, ApiError>((settings, limit, reservation, slot))
    })
    .await
    .map_err(|_| upload_timeout())??;
    let version = Uuid::now_v7();
    let key = Store::key(bucket, version);
    let declared_type = options.content_type.as_deref();
    let received = tokio::time::timeout_at(
        deadline,
        receive(
            &state,
            &key,
            body,
            limit,
            &mut reservation,
            declared_type,
            settings.allowed_mime_types.as_deref(),
        ),
    )
    .await
    .unwrap_or_else(|_| Err(upload_timeout()));
    let received = match received {
        Ok(received) => received,
        Err(err) => {
            state.store.delete_quietly(&key).await;
            return Err(err);
        }
    };

    let published = record(&state, &claims, bucket, &name, version, &received, mode).await;
    drop(reservation);
    match published {
        Ok((id, replaced)) => {
            if let Some(old) = replaced.filter(|old| *old != version) {
                state.store.delete_quietly(&Store::key(bucket, old)).await;
            }
            Ok(UploadOutcome {
                object: UploadedObject {
                    id,
                    bucket: bucket.to_owned(),
                    name,
                    size: received.size,
                    mime_type: received.mime_type,
                    etag: received.etag,
                },
                replaced: replaced.is_some(),
                public: settings.public,
            })
        }
        Err(quota::PublicationError::Rejected(err)) => {
            state.store.delete_quietly(&key).await;
            Err(err)
        }
        Err(quota::PublicationError::Uncertain(err)) => {
            // PostgreSQL may have committed before the connection failed.
            // Keep this immutable version: the collector checks authoritative
            // metadata after its grace period before removing any orphan.
            tracing::warn!(
                event = "storage.publication_uncertain",
                "metadata publication could not be acknowledged; bytes retained for reconciliation"
            );
            Err(err)
        }
    }
}

fn upload_timeout() -> ApiError {
    ApiError::new(
        StatusCode::REQUEST_TIMEOUT,
        "upload_timeout",
        "the upload took too long",
    )
}

/// Writes the row once the bytes are stored. Returns the row id and, when a
/// file was replaced, the version its bytes are under.
async fn record(
    state: &StorageState,
    claims: &Claims,
    bucket: &str,
    name: &str,
    version: Uuid,
    received: &Received,
    mode: Mode,
) -> Result<(Uuid, Option<Uuid>), quota::PublicationError> {
    let db_err = |e| write_error(e, claims);
    quota::publish(state, claims, async |tx| {
        // Row locks cannot protect a name that does not exist yet. Serialize
        // every publisher of this name across instances before reading its
        // predecessor, including when no project quota is configured.
        tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtext('nelcota.storage.object:' || $1), hashtext($2))",
            &[&bucket, &name],
        )
        .await
        .map_err(db_err)?;
        let id = Uuid::now_v7();
        let size = i64::try_from(received.size).unwrap_or(i64::MAX);
        let values: [&(dyn tokio_postgres::types::ToSql + Sync); 7] = [
            &id,
            &bucket,
            &name,
            &version,
            &size,
            &received.mime_type,
            &received.etag,
        ];
        let (id, replaced) = match mode {
            Mode::Create => {
                tx.execute(INSERT, &values).await.map_err(db_err)?;
                (id, None)
            }
            Mode::Upsert => {
                // Under the caller's policies: replacing needs SELECT anyway.
                let old: Option<Uuid> = tx
                    .query_opt(
                        "SELECT version FROM storage.objects
                      WHERE bucket_id = $1 AND name = $2 FOR UPDATE",
                        &[&bucket, &name],
                    )
                    .await
                    .map_err(db_err)?
                    .map(|r| r.get(0));
                let row = tx.query_one(UPSERT, &values).await.map_err(db_err)?;
                (row.get(0), old)
            }
        };
        Ok((id, replaced))
    })
    .await
}

struct Received {
    size: u64,
    mime_type: String,
    etag: String,
}

/// Streams the body to `key`, sniffing the type from the first bytes and
/// enforcing the size limit and the room left as bytes arrive.
async fn receive(
    state: &StorageState,
    key: &Key,
    body: UploadStream,
    limit: u64,
    reservation: &mut quota::Reservation,
    declared_type: Option<&str>,
    allowed: Option<&[String]>,
) -> Result<Received, ApiError> {
    let interrupted = |_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "upload_interrupted",
            "the upload was interrupted",
        )
    };
    let mut stream = body;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let store = &state.store;
    let mut take = async |chunk: &Bytes| {
        size += chunk.len() as u64;
        hasher.update(chunk);
        if size > limit {
            return Err(too_large(limit));
        }
        reservation.check(state, size).await
    };

    // The first bytes decide the type before anything is written.
    let mut head = Vec::new();
    let mut ended = true;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(interrupted)?;
        take(&chunk).await?;
        head.extend_from_slice(&chunk);
        if head.len() >= SNIFF_BYTES {
            ended = false;
            break;
        }
    }
    let mime_type = mime::effective(&head, declared_type);
    if !mime::allowed(&mime_type, allowed) {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "mime_type_not_allowed",
            format!("this bucket does not accept {mime_type}"),
        ));
    }

    match ended {
        true => {
            store
                .put(key, Bytes::from(head))
                .await
                .map_err(store_failed)?;
        }
        false => {
            let mut writer = store.writer(key).await.map_err(store_failed)?;
            writer.write(&head);
            let mut result = Ok(());
            while let Some(chunk) = stream.next().await {
                let chunk = match chunk.map_err(interrupted) {
                    Ok(chunk) => chunk,
                    Err(err) => {
                        result = Err(err);
                        break;
                    }
                };
                if let Err(err) = take(&chunk).await {
                    result = Err(err);
                    break;
                }
                if let Err(err) = writer.wait_for_capacity(PARTS_IN_FLIGHT).await {
                    result = Err(store_failed(err));
                    break;
                }
                writer.put(chunk);
            }
            match result {
                Ok(()) => {
                    writer.finish().await.map_err(store_failed)?;
                }
                Err(err) => {
                    let _ = writer.abort().await;
                    return Err(err);
                }
            }
        }
    }
    Ok(Received {
        size,
        mime_type,
        etag: base16ct::lower::encode_string(&hasher.finalize()),
    })
}
