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
use std::{net::IpAddr, pin::Pin, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

pub type UploadStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// How long a body may go without a byte. Upload slots are shared by every
/// caller; without this a trickling body holds one until the whole upload
/// timeout (an hour by default) runs out.
const BODY_IDLE: Duration = Duration::from_secs(60);
/// The transfer-rate floor: after [`RATE_GRACE`], every consecutive
/// [`RATE_WINDOW`] must bring at least [`RATE_MIN_BYTES`]. A body that sends a
/// byte just often enough to dodge [`BODY_IDLE`] still loses its slot within
/// two minutes. The floor (16 KiB a minute, about 273 bytes/s) is far below
/// any usable link: a 64 KiB/s upload brings 3.75 MiB per window.
const RATE_GRACE: Duration = Duration::from_secs(60);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MIN_BYTES: u64 = 16 * 1024;
#[derive(Default)]
pub struct UploadOptions {
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
    pub replace: bool,
    /// The client's address, which keys the per-caller upload limit for
    /// requests without a signed-in user. `None` (an embedded caller) is not
    /// limited per caller.
    pub client: Option<IpAddr>,
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
    let deadline = Instant::now() + state.settings.upload_timeout;
    let caller = nelcota_auth::caller_key(&claims, options.client);
    let mode = match options.replace {
        true => Mode::Upsert,
        false => Mode::Create,
    };
    let bucket = path::bucket(bucket)?;
    let name = path::object(name)?;
    // One deadline covers pool waits, the policy check, admission and bytes.
    // Active uploads are bounded; overload never builds an unbounded queue.
    // A caller first takes one of its own slots (429 when it keeps them all
    // busy), so no single caller can hold every process-wide slot.
    let (settings, limit, mut reservation, _slot) = tokio::time::timeout_at(deadline, async {
        let caller_slot = state.callers.clone().admit(caller).await?;
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
            let checked = tx
                .execute(sql, &placeholder)
                .await
                .map_err(|e| write_error(e, &claims));
            if let Err(error) = checked {
                // Return the connection before the visibility check takes one.
                drop(tx);
                drop(client);
                return Err(conceal_hidden(&state, &claims, bucket, &name, error).await);
            }
            old_size
        };

        state
            .store
            .ensure_ownership(&state.pool)
            .await
            .map_err(store_failed)?;
        let reservation = quota::reserve(&state, old_size, declared, limit).await?;
        Ok::<_, ApiError>((settings, limit, reservation, (caller_slot, slot)))
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
            Err(conceal_hidden(&state, &claims, bucket, &name, err).await)
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

/// A unique violation (POST) or a refused update of an existing row (PUT,
/// whose RLS message names the USING expression) proves that the name is
/// taken, even when the caller's policies hide that file. Only a caller who
/// can see it learns that it exists; anyone else gets the answer of a plain
/// policy refusal, the same as for a name that is free.
async fn conceal_hidden(
    state: &StorageState,
    claims: &Claims,
    bucket: &str,
    name: &str,
    error: ApiError,
) -> ApiError {
    if !depends_on_name(&error) {
        return error;
    }
    match visible(state, claims, bucket, name).await {
        Ok(true) => error,
        Ok(false) => ApiError::row_security_refused("objects", claims.role()),
        Err(lookup) => lookup,
    }
}

/// Whether the error can differ with the name's existence. Other refusals,
/// such as a missing table privilege, answer every name alike and keep their
/// own message so operators can see the real cause.
fn depends_on_name(error: &ApiError) -> bool {
    error.code() == "object_exists" || error.is_row_security_refusal()
}

/// Whether the caller's policies let them see the file.
async fn visible(
    state: &StorageState,
    claims: &Claims,
    bucket: &str,
    name: &str,
) -> Result<bool, ApiError> {
    let db_err = |e| ApiError::from_db(e, claims.role());
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_request(&mut client, claims).await.map_err(db_err)?;
    let row = tx
        .query_opt(
            "SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2",
            &[&bucket, &name],
        )
        .await
        .map_err(db_err)?;
    Ok(row.is_some())
}

/// Bytes received per consecutive window, checked against the rate floor.
/// Fed with instants rather than reading the clock, so the rule is tested
/// apart from any I/O.
#[derive(Debug)]
struct RateFloor {
    /// Start of the window being counted; the first one opens after the grace.
    window_start: Instant,
    /// Bytes received in that window.
    received: u64,
}

impl RateFloor {
    fn new(start: Instant) -> Self {
        RateFloor {
            window_start: start + RATE_GRACE,
            received: 0,
        }
    }

    /// Records `bytes` received at `now`; `Err` when a window that closed
    /// by `now` brought too little.
    fn record(&mut self, now: Instant, bytes: u64) -> Result<(), ()> {
        while now >= self.window_start + RATE_WINDOW {
            if self.received < RATE_MIN_BYTES {
                return Err(());
            }
            self.window_start += RATE_WINDOW;
            self.received = 0;
        }
        if now >= self.window_start {
            self.received = self.received.saturating_add(bytes);
        }
        Ok(())
    }

    /// When the floor fails if nothing more arrives: the end of the current
    /// window when it is still short, else the end of the next (empty) one.
    fn deadline(&self) -> Instant {
        match self.received < RATE_MIN_BYTES {
            true => self.window_start + RATE_WINDOW,
            false => self.window_start + RATE_WINDOW * 2,
        }
    }
}

/// The next body chunk, or an error when the body fails, stalls or stays
/// below the transfer-rate floor.
async fn next_chunk(
    stream: &mut UploadStream,
    floor: &mut RateFloor,
) -> Result<Option<Bytes>, ApiError> {
    let wait_until = floor.deadline().min(Instant::now() + BODY_IDLE);
    let chunk = match tokio::time::timeout_at(wait_until, stream.next()).await {
        Err(_) => return Err(upload_timeout()),
        Ok(None) => return Ok(None),
        Ok(Some(chunk)) => chunk.map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "upload_interrupted",
                "the upload was interrupted",
            )
        })?,
    };
    floor
        .record(Instant::now(), chunk.len() as u64)
        .map_err(|()| upload_timeout())?;
    Ok(Some(chunk))
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
    let mut stream = body;
    let mut floor = RateFloor::new(Instant::now());
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
    while let Some(chunk) = next_chunk(&mut stream, &mut floor).await? {
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
            loop {
                let chunk = match next_chunk(&mut stream, &mut floor).await {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break,
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

#[cfg(test)]
mod tests {
    use nelcota_core::Role;

    use super::*;

    const KIB: u64 = 1024;

    #[test]
    fn the_rate_floor_spares_the_first_minute_and_slow_links() {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        // Nothing counts during the grace: a slow start is fine.
        let mut floor = RateFloor::new(start);
        floor.record(at(59), 1).unwrap();
        assert!(floor.deadline() == at(120));
        // 64 KiB/s, one chunk a second, for ten minutes.
        let mut slow_link = RateFloor::new(start);
        for second in 1..=600 {
            slow_link.record(at(second), 64 * KIB).unwrap();
        }
        // Exactly the floor in each window passes too.
        let mut minimal = RateFloor::new(start);
        for window in 1..=5 {
            minimal
                .record(at(60 * window + 30), RATE_MIN_BYTES)
                .unwrap();
        }
        minimal.record(at(60 * 6 + 1), 1).unwrap();
    }

    #[test]
    fn a_trickle_that_dodges_the_idle_timeout_fails_the_floor() {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        // One byte every 50 s: never idle for 60 s, but far below the floor.
        let mut floor = RateFloor::new(start);
        let failed_at = (1..=72)
            .map(|n| 50 * n)
            .find(|&secs| floor.record(at(secs), 1).is_err());
        assert_eq!(failed_at, Some(150), "the window [60 s, 120 s) was short");
        // Waiting for the next chunk ends when the short window closes.
        let mut floor = RateFloor::new(start);
        floor.record(at(70), RATE_MIN_BYTES - 1).unwrap();
        assert!(floor.deadline() == at(120));
        assert!(floor.record(at(120), 1).is_err());
    }

    #[test]
    fn a_window_skipped_after_a_good_one_still_fails() {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        let mut floor = RateFloor::new(start);
        floor.record(at(61), RATE_MIN_BYTES).unwrap();
        assert!(floor.deadline() == at(180));
        // [120 s, 180 s) brought nothing.
        assert!(floor.record(at(181), 64 * KIB).is_err());
    }

    #[test]
    fn only_name_dependent_refusals_are_concealed() {
        let taken = ApiError::new(StatusCode::CONFLICT, "object_exists", "taken");
        assert!(depends_on_name(&taken));
        let refused = ApiError::row_security_refused("objects", Role::Authenticated);
        assert!(depends_on_name(&refused));
        let denied = ApiError::new(StatusCode::FORBIDDEN, "db_error", "permission denied");
        assert!(!depends_on_name(&denied));
    }
}
