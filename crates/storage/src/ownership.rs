//! A physical store belongs to one metadata database. Ambiguous stores retain
//! bytes: automatic collection must never infer another database's files are
//! orphans. These markers are persistent and are never automatically removed.
use std::sync::atomic::Ordering;

use deadpool_postgres::Pool;
use futures_util::StreamExt;
use object_store::path::Path;
use sha2::{Digest, Sha256};

use crate::{Store, StoreError, db, gc};

const OWNER: &str = ".nelcota-gc-owner-v1";
const SHARED: &str = ".nelcota-gc-shared-v1";
const BATCH: usize = 500;

pub(crate) fn is_control(key: &Path) -> bool {
    matches!(key.as_ref(), OWNER | SHARED)
}

impl Store {
    pub(crate) async fn initialize_owner(
        &self,
        admin: &tokio_postgres::Client,
        pool: &Pool,
    ) -> Result<(), StoreError> {
        // Independent databases in one cluster and clusters on different hosts
        // must differ. Password/JWT rotation must not change the identity.
        let row = admin
            .query_one(
                "SELECT system_identifier::text, current_database(),
                    (SELECT oid::text FROM pg_database WHERE datname = current_database())
             FROM pg_control_system()",
                &[],
            )
            .await?;
        let identity = format!(
            "{}\n{}\n{}",
            row.get::<_, String>(0),
            row.get::<_, String>(1),
            row.get::<_, String>(2)
        );
        let owner = owner_tag(&identity);
        if self.gc_owner.set(owner.clone()).is_err() && self.gc_owner.get() != Some(&owner) {
            self.mark_shared().await?;
        }
        self.ensure_ownership(pool).await
    }

    async fn mark_shared(&self) -> Result<(), StoreError> {
        self.control_create(SHARED, bytes::Bytes::from_static(b"v1:shared"))
            .await?;
        self.shared.store(true, Ordering::Release);
        tracing::warn!(
            event = "storage.collector_quarantined",
            "automatic storage collection disabled: shared or unclaimed files; use a separate physical store per database"
        );
        Ok(())
    }

    pub(crate) async fn ensure_ownership(&self, pool: &Pool) -> Result<(), StoreError> {
        self.ownership_ready
            .get_or_try_init(|| async {
                if self.gc_owner.get().is_none() {
                    let client = pool
                        .get()
                        .await
                        .map_err(|_| StoreError::Ownership("database identity not initialized"))?;
                    let row = client
                        .query_one(
                            "SELECT system_identifier::text, current_database(),
                                    (SELECT oid::text FROM pg_database WHERE datname = current_database())
                             FROM pg_control_system()",
                            &[],
                        )
                        .await
                        .map_err(|_| StoreError::Ownership("database identity not initialized"))?;
                    let identity = format!(
                        "{}\n{}\n{}",
                        row.get::<_, String>(0),
                        row.get::<_, String>(1),
                        row.get::<_, String>(2)
                    );
                    let owner = owner_tag(&identity);
                    if self.gc_owner.set(owner.clone()).is_err()
                        && self.gc_owner.get() != Some(&owner)
                    {
                        self.mark_shared().await?;
                    }
                }
                let owner = self
                    .gc_owner
                    .get()
                    .ok_or(StoreError::Ownership("database identity not initialized"))?;
                if self.control_read(SHARED).await?.is_some() {
                    self.shared.store(true, Ordering::Release);
                    return Ok(());
                }
                if self.control_read(OWNER).await?.is_none() {
                    // Upgrades may contain legitimate files. Adopt only when every
                    // version-shaped key belongs to this database, regardless of age.
                    let mut listing = self.list();
                    let mut versions = Vec::with_capacity(BATCH);
                    while let Some(meta) = listing.next().await {
                        let meta = meta?;
                        if let Some(version) = gc::version(&meta.location) {
                            versions.push(version);
                        }
                        if versions.len() == BATCH {
                            if !all_known(pool, &versions).await? {
                                return self.mark_shared().await;
                            }
                            versions.clear();
                        }
                    }
                    if !versions.is_empty() && !all_known(pool, &versions).await? {
                        return self.mark_shared().await;
                    }
                    // Conditional creation resolves simultaneous claims across hosts.
                    self.control_create(OWNER, bytes::Bytes::from(owner.clone()))
                        .await?;
                }
                let stored = self
                    .control_read(OWNER)
                    .await?
                    .ok_or(StoreError::Ownership("owner marker disappeared"))?;
                let valid = stored.len() == 67
                    && stored.starts_with(b"v1:")
                    && stored[3..].iter().all(u8::is_ascii_hexdigit);
                if !valid {
                    return Err(StoreError::Ownership("invalid owner marker"));
                }
                if stored.as_ref() != owner.as_bytes() {
                    self.mark_shared().await?;
                }
                Ok(())
            })
            .await
            .copied()
    }

    pub(crate) async fn verify_collection_owner(&self) -> Result<(), StoreError> {
        let owner = self
            .gc_owner
            .get()
            .ok_or(StoreError::Ownership("collection has no database identity"))?;
        if self.shared.load(Ordering::Acquire) || self.control_read(SHARED).await?.is_some() {
            return Err(StoreError::Ownership(
                "automatic collection quarantined; separate physical stores are required",
            ));
        }
        let stored = self
            .control_read(OWNER)
            .await?
            .ok_or(StoreError::Ownership("collection owner marker is missing"))?;
        if stored.as_ref() != owner.as_bytes() {
            return Err(StoreError::Ownership(
                "collection owner marker does not match this database",
            ));
        }
        Ok(())
    }
}

async fn all_known(pool: &Pool, versions: &[uuid::Uuid]) -> Result<bool, StoreError> {
    let known = db::known_versions(pool, versions)
        .await
        .map_err(|_| StoreError::Ownership("could not verify existing file metadata"))?;
    Ok(versions.iter().all(|version| known.contains(version)))
}

/// Versioned owner tag stored next to the GC marker: the hex SHA-256 of the
/// database identity.
fn owner_tag(identity: &str) -> String {
    let digest = base16ct::lower::encode_string(&Sha256::digest(identity.as_bytes()));
    format!("v1:{digest}")
}
