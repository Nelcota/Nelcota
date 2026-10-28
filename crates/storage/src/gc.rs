//! Collector of orphaned bytes (D78): bytes no row points to, left by a
//! crash or a failed delete. Only keys shaped `<bucket>/<uuidv7>` older than
//! a day are candidates, so an upload in flight (bytes written, row not yet)
//! and files someone else put in the store are never touched.

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use deadpool_postgres::Pool;
use futures_util::StreamExt;
use object_store::path::Path as Key;
use uuid::Uuid;

use crate::{db, path, store::Store};

const GRACE: Duration = Duration::from_secs(86_400);
const EVERY: Duration = Duration::from_secs(3600);
const BATCH: usize = 500;

/// Runs the collector in the background, once an hour.
pub fn spawn_collector(pool: Pool, store: Arc<Store>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(EVERY);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // The first tick fires at once; give the server a minute first.
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            interval.tick().await;
            match collect(&pool, &store, SystemTime::now()).await {
                Ok(0) => {}
                Ok(removed) => tracing::info!(removed, "orphaned storage bytes removed"),
                Err(err) => tracing::warn!(
                    event = "storage.collector_failed",
                    error_type = std::any::type_name_of_val(&err),
                    "storage collector failed"
                ),
            }
        }
    });
}

/// The version a key holds, if the key is one of ours and old enough.
pub(crate) fn version(key: &Key) -> Option<Uuid> {
    let mut parts = key.parts();
    let bucket = parts.next()?;
    let version = parts.next()?;
    if parts.next().is_some() || path::bucket(bucket.as_ref()).is_err() {
        return None;
    }
    let version = Uuid::parse_str(version.as_ref()).ok()?;
    (version.get_version_num() == 7).then_some(version)
}

fn candidate(key: &Key, now: SystemTime, grace: Duration) -> Option<Uuid> {
    let version = version(key)?;
    let (secs, nanos) = version.get_timestamp()?.to_unix();
    let created = UNIX_EPOCH + Duration::new(secs, nanos);
    (created.checked_add(grace)? <= now).then_some(version)
}

/// One pass: returns how many keys were removed.
pub async fn collect(pool: &Pool, store: &Store, now: SystemTime) -> Result<usize, String> {
    store
        .verify_collection_owner()
        .await
        .map_err(|error| error.to_string())?;
    let grace = Duration::from_secs(
        store
            .collection_grace_secs
            .load(std::sync::atomic::Ordering::Relaxed),
    )
    .max(GRACE);
    let mut removed = collect_incomplete(store, now, grace).await?;
    let mut listing = store.list();
    let mut batch: Vec<(Key, Uuid)> = Vec::new();
    while let Some(meta) = listing.next().await {
        let meta = meta.map_err(|e| e.to_string())?;
        if let Some(version) = candidate(&meta.location, now, grace) {
            batch.push((meta.location, version));
        }
        if batch.len() >= BATCH {
            removed += sweep(pool, store, std::mem::take(&mut batch)).await?;
        }
    }
    if !batch.is_empty() {
        removed += sweep(pool, store, batch).await?;
    }
    Ok(removed)
}

// object_store hides local `<uuid>#<part>` files from listings. Walk only our
// two-level namespace and regular files; foreign names and symlinks stay put.
async fn collect_incomplete(
    store: &Store,
    now: SystemTime,
    grace: Duration,
) -> Result<usize, String> {
    let root = match store.disk_root() {
        Some(root) => root,
        None => return Ok(0),
    };
    let mut buckets = tokio::fs::read_dir(root).await.map_err(|e| e.to_string())?;
    let mut removed = 0;
    while let Some(bucket) = buckets.next_entry().await.map_err(|e| e.to_string())? {
        let name = bucket.file_name();
        let name = match name.to_str() {
            Some(name) if path::bucket(name).is_ok() => name,
            _ => continue,
        };
        if !bucket
            .file_type()
            .await
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            continue;
        }
        let mut files = tokio::fs::read_dir(bucket.path())
            .await
            .map_err(|e| e.to_string())?;
        while let Some(file) = files.next_entry().await.map_err(|e| e.to_string())? {
            let filename = file.file_name();
            let version = match filename.to_str().and_then(|name| name.rsplit_once('#')) {
                Some((version, part))
                    if !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()) =>
                {
                    version
                }
                _ => continue,
            };
            if candidate(&Key::from(format!("{name}/{version}")), now, grace).is_none()
                || !file.file_type().await.map_err(|e| e.to_string())?.is_file()
            {
                continue;
            }
            let metadata = match file.metadata().await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            if metadata
                .modified()
                .ok()
                .and_then(|time| time.checked_add(grace))
                .is_none_or(|deadline| deadline > now)
            {
                continue;
            }
            store
                .verify_collection_owner()
                .await
                .map_err(|e| e.to_string())?;
            match tokio::fs::remove_file(file.path()).await {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(event = "storage.collector_delete_failed", io_kind = ?error.kind(), "could not delete an incomplete upload; the collector will retry")
                }
            }
        }
    }
    Ok(removed)
}

async fn sweep(pool: &Pool, store: &Store, batch: Vec<(Key, Uuid)>) -> Result<usize, String> {
    let versions: Vec<Uuid> = batch.iter().map(|(_, v)| *v).collect();
    let known = db::known_versions(pool, &versions)
        .await
        .map_err(|e| format!("{:?}", e.status()))?;
    let mut removed = 0;
    for (key, version) in batch {
        if !known.contains(&version) {
            // Recheck after the metadata round trip and before each deletion.
            store
                .verify_collection_owner()
                .await
                .map_err(|error| error.to_string())?;
            match store.delete(&key).await {
                Ok(()) => removed += 1,
                Err(err) => {
                    tracing::warn!(event = "storage.collector_delete_failed", error_type = std::any::type_name_of_val(&err), io_kind = ?crate::error::diagnostic_io_kind(&err), "could not delete orphaned storage bytes; the collector will retry")
                }
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::{NoContext, Timestamp};

    #[test]
    fn only_old_versioned_keys_are_candidates() {
        let now = SystemTime::now();
        let old = Uuid::new_v7(Timestamp::from_unix(NoContext, 1_700_000_000, 0));
        let fresh = Uuid::now_v7();
        assert_eq!(
            candidate(&Key::from(format!("docs/{old}")), now, GRACE),
            Some(old)
        );
        for key in [
            format!("docs/{fresh}"),
            format!(
                "docs/{}",
                Uuid::from_u128(0x67e5_5044_10b1_426f_9247_bb68_0e5f_e0c8)
            ),
            format!("Docs/{old}"),
            format!("docs/x/{old}"),
            format!("{old}"),
            "docs/readme.txt".to_owned(),
        ] {
            assert_eq!(
                candidate(&Key::from(key.as_str()), now, GRACE),
                None,
                "{key}"
            );
        }
    }
}
