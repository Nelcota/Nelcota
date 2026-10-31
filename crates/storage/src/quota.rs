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
    growing: bool,
    old_size: u64,
    limit: u64,
}

/// How far an unknown-length upload reserves ahead of the bytes received, so
/// it consults the database about once per step instead of once per chunk.
const GROWTH_STEP: u64 = 1 << 20;

/// Which capacity an upload would exceed.
#[derive(Debug, PartialEq, Eq)]
enum Shortage {
    Quota,
    Disk,
}

/// The most one reservation may hold under the total quota, when `others`
/// bytes are committed or reserved elsewhere. A replacement is credited with
/// the size of the file it replaces.
fn quota_room(max: Option<u64>, others: u128, old_size: u64) -> u128 {
    let max = match max {
        Some(max) => u128::from(max),
        None => return u128::MAX,
    };
    match max.checked_sub(others) {
        Some(room) => room + u128::from(old_size),
        None => 0,
    }
}

/// The reservation that holds `size` bytes, given the most this upload may
/// reserve under the quota and on disk. It reaches up to [`GROWTH_STEP`]
/// past the current reservation, within the file limit and never beyond half
/// of the room left, so concurrent small uploads still share scarce capacity.
fn grown(size: u64, held: u64, limit: u64, quota: u128, disk: u128) -> Result<u64, Shortage> {
    if u128::from(size) > quota {
        return Err(Shortage::Quota);
    }
    if u128::from(size) > disk {
        return Err(Shortage::Disk);
    }
    let ahead = held.saturating_add(GROWTH_STEP).min(limit);
    let ahead = u128::from(ahead).min(quota.min(disk) / 2);
    // `ahead` is at most `limit`, so it fits in a u64.
    Ok(size.max(ahead as u64))
}

fn full(disk: bool) -> ApiError {
    if disk {
        return storage_full("the server's disk is almost full");
    }
    storage_full("the project's storage quota is full")
}

impl Reservation {
    pub(crate) async fn check(&mut self, state: &StorageState, size: u64) -> Result<(), ApiError> {
        if size <= self.bytes {
            return Ok(());
        }
        if !self.growing {
            return Err(full(self.disk));
        }
        let _admission = self.quota.admission.lock().await;
        let used = match state.settings.max_total_size {
            Some(_) => db::used_bytes(&state.pool).await?,
            None => 0,
        };
        let free = state.store.free_bytes();
        let mut reserved = self
            .quota
            .reserved
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Bytes committed and reserved by the other uploads.
        let others = u128::from(used) + reserved.total - self.total;
        let quota = quota_room(state.settings.max_total_size, others, self.old_size);
        let min_free = u128::from(state.settings.min_free_bytes);
        let needed = min_free + reserved.disk - u128::from(self.bytes);
        let disk = match free {
            Some(free) => u128::from(free).saturating_sub(needed),
            None => u128::MAX,
        };
        let bytes = grown(size, self.bytes, self.limit, quota, disk)
            .map_err(|shortage| full(shortage == Shortage::Disk))?;
        let total = u128::from(bytes.saturating_sub(self.old_size));
        reserved.total = reserved.total - self.total + total;
        reserved.disk = reserved.disk - u128::from(self.bytes) + u128::from(bytes);
        self.total = total;
        self.bytes = bytes;
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
        let required = u128::from(state.settings.min_free_bytes) + reserved.disk;
        if u128::from(free) <= required {
            return Err(full(true));
        }
        let available = u128::from(free) - required;
        if available < u128::from(bytes) {
            bytes = available as u64;
            disk = true;
        }
    }
    if declared.is_some_and(|size| size > bytes) {
        return Err(full(disk));
    }
    // Unknown-length uploads reserve only bytes received, growing under the
    // same admission lock instead of monopolizing the remaining quota.
    let bytes = declared.unwrap_or(0);
    let total = u128::from(bytes.saturating_sub(old_size));
    reserved.total += total;
    reserved.disk += u128::from(bytes);
    Ok(Reservation {
        quota: state.quota.clone(),
        bytes,
        total,
        disk,
        growing: declared.is_none(),
        old_size,
        limit,
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

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = GROWTH_STEP;
    const ANY: u128 = u128::MAX;

    #[test]
    fn unknown_lengths_reserve_a_step_ahead() {
        assert_eq!(grown(10, 0, 50 * MIB, ANY, ANY), Ok(MIB));
        assert_eq!(grown(MIB + 1, MIB, 50 * MIB, ANY, ANY), Ok(2 * MIB));
        assert_eq!(grown(3 * MIB, MIB, 50 * MIB, ANY, ANY), Ok(3 * MIB));
        // The file limit caps the step.
        assert_eq!(grown(10, 0, 100, ANY, ANY), Ok(100));
    }

    #[test]
    fn scarce_capacity_is_shared_not_taken() {
        // Two four-byte uploads share a ten-byte quota.
        assert_eq!(grown(4, 0, 50 * MIB, 10, ANY), Ok(5));
        assert_eq!(grown(4, 0, 50 * MIB, 5, ANY), Ok(4));
        assert_eq!(grown(4, 0, 50 * MIB, ANY, 9), Ok(4));
        assert_eq!(grown(10, 0, 50 * MIB, 10, ANY), Ok(10));
    }

    #[test]
    fn replacements_keep_their_credit() {
        assert_eq!(quota_room(None, 5, 3), ANY);
        assert_eq!(quota_room(Some(10), 8, 0), 2);
        assert_eq!(quota_room(Some(10), 10, 6), 6);
        // Already over a lowered quota: nothing more fits.
        assert_eq!(quota_room(Some(10), 12, 6), 0);
    }

    #[test]
    fn exceeding_the_room_names_the_shortage() {
        assert_eq!(grown(11, 0, 50 * MIB, 10, ANY), Err(Shortage::Quota));
        assert_eq!(grown(11, 0, 50 * MIB, ANY, 10), Err(Shortage::Disk));
        assert_eq!(grown(11, 0, 50 * MIB, 10, 10), Err(Shortage::Quota));
        assert_eq!(grown(1, 0, 50 * MIB, 0, ANY), Err(Shortage::Quota));
    }
}
