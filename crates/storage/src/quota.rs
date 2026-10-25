//! Capacity reservations and serialized publication of storage metadata.
//! Reservations bound in-flight writes in this process; the transaction lock
//! makes the committed total authoritative across server instances as well.
use std::sync::{Arc, Mutex};

use deadpool_postgres::Transaction;
use nelcota_core::{ApiError, Claims, db::begin_request};

use crate::{StorageState, db, error::storage_full};

/// A failed COMMIT reply does not prove that PostgreSQL rolled back the row.
pub(crate) enum PublicationError {
    Rejected(ApiError),
    Uncertain(ApiError),
}

impl From<ApiError> for PublicationError {
    fn from(error: ApiError) -> Self {
        Self::Rejected(error)
    }
}

#[derive(Default)]
struct Reserved {
    total: u128,
    disk: u128,
}

#[derive(Default)]
pub(crate) struct Quota {
    admission: tokio::sync::Mutex<()>,
    reserved: Mutex<Reserved>,
}

pub(crate) struct Reservation {
    quota: Arc<Quota>,
    bytes: u64,
    total: u128,
    disk: bool,
}

fn full(disk: bool) -> ApiError {
    if disk {
        return storage_full("the server's disk is almost full");
    }
    storage_full("the project's storage quota is full")
}

impl Reservation {
    pub(crate) fn check(&self, size: u64) -> Result<(), ApiError> {
        if size > self.bytes {
            return Err(full(self.disk));
        }
        Ok(())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut reserved = self
            .quota
            .reserved
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reserved.total -= self.total;
        reserved.disk -= u128::from(self.bytes);
    }
}

/// Existing bytes count as credit only for the logical quota. A replacement
/// still needs disk space for its new version until publication succeeds.
pub(crate) async fn reserve(
    state: &StorageState,
    old_size: u64,
    declared: Option<u64>,
    limit: u64,
) -> Result<Reservation, ApiError> {
    let _admission = state.quota.admission.lock().await;
    let used = match state.settings.max_total_size.is_some() {
        true => db::used_bytes(&state.pool).await?,
        false => 0,
    };
    let free = state.store.free_bytes();
    let mut reserved = state
        .quota
        .reserved
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut bytes = limit;
    let mut disk = false;
    if let Some(max) = state.settings.max_total_size {
        let available = u128::from(max).saturating_sub(u128::from(used) + reserved.total);
        bytes = bytes.min((available + u128::from(old_size)).min(u128::from(u64::MAX)) as u64);
    }
    if let Some(free) = free {
        let available = u128::from(free)
            .saturating_sub(u128::from(state.settings.min_free_bytes) + reserved.disk);
        if available < u128::from(bytes) {
            bytes = available as u64;
            disk = true;
        }
    }
    if declared.is_some_and(|size| size > bytes) {
        return Err(full(disk));
    }
    let bytes = declared.unwrap_or(bytes);
    let total = u128::from(bytes.saturating_sub(old_size));
    reserved.total += total;
    reserved.disk += u128::from(bytes);
    Ok(Reservation {
        quota: state.quota.clone(),
        bytes,
        total,
        disk,
    })
}

/// All metadata writers acquire the same transaction advisory lock before
/// touching object rows, then check the complete resulting total before commit.
/// Caller policies apply to the write; the internal read-only role counts bytes.
pub(crate) async fn publish<T>(
    state: &StorageState,
    claims: &Claims,
    write: impl AsyncFnOnce(&Transaction<'_>) -> Result<T, ApiError>,
) -> Result<T, PublicationError> {
    let db_err = |e| ApiError::from_db(e, claims.role());
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_request(&mut client, claims).await.map_err(db_err)?;
    if state.settings.max_total_size.is_some() {
        tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtext('nelcota.storage.quota'))",
            &[],
        )
        .await
        .map_err(db_err)?;
    }
    let value = write(&tx).await?;
    if let Some(max) = state.settings.max_total_size {
        tx.batch_execute("SET LOCAL ROLE nelcota_storage")
            .await
            .map_err(db_err)?;
        let used: i64 = tx
            .query_one("SELECT bytes FROM storage.usage WHERE singleton", &[])
            .await
            .map_err(db_err)?
            .get(0);
        tx.execute(
            "SELECT set_config('role', $1, true)",
            &[&claims.role().as_str()],
        )
        .await
        .map_err(db_err)?;
        if used.max(0) as u64 > max {
            return Err(full(false).into());
        }
    }
    tx.commit()
        .await
        .map_err(|error| PublicationError::Uncertain(db_err(error)))?;
    Ok(value)
}
