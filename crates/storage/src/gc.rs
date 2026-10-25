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

fn candidate(key: &Key, now: SystemTime) -> Option<Uuid> {
    let version = version(key)?;
    let (secs, nanos) = version.get_timestamp()?.to_unix();
    let created = UNIX_EPOCH + Duration::new(secs, nanos);
    (version.get_version_num() == 7 && created + GRACE <= now).then_some(version)
}

/// One pass: returns how many keys were removed.
pub async fn collect(pool: &Pool, store: &Store, now: SystemTime) -> Result<usize, String> {
    store
        .verify_collection_owner()
        .await
        .map_err(|error| error.to_string())?;
    let mut listing = store.list();
    let mut batch: Vec<(Key, Uuid)> = Vec::new();
    let mut removed = 0;
    while let Some(meta) = listing.next().await {
        let meta = meta.map_err(|e| e.to_string())?;
        if let Some(version) = candidate(&meta.location, now) {
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
            if store.delete(&key).await.is_ok() {
                removed += 1;
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
        assert_eq!(candidate(&Key::from(format!("docs/{old}")), now), Some(old));
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
            assert_eq!(candidate(&Key::from(key.as_str()), now), None, "{key}");
        }
    }
}
