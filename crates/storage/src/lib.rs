//! File storage (D77-D80): metadata in `storage.objects` under RLS, bytes on
//! disk or S3. Every read or write of a row runs as the caller's role, like
//! the REST API; the internal `nelcota_storage` role only reads bucket
//! settings, serves public and signed files, and finds orphaned bytes.

mod buckets;
mod db;
mod error;
mod gc;
pub mod http;
mod mime;
mod multipart;
mod operations;
mod ownership;
mod path;
mod private_dir;
mod quota;
mod serve;
mod signing;
mod store;
mod upload;

use std::{sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{DefaultBodyLimit, FromRef},
    routing::{get, post},
};
use deadpool_postgres::Pool;
use nelcota_auth::{CallerLimit, Keys, SharedVerifier};
use nelcota_core::{Config, config::STORAGE_CONCURRENT_UPLOADS};
use tokio::sync::Semaphore;

pub use buckets::{Bucket, BucketError, BucketSettings, mime_entry_ok};
pub use db::Object as StoredObject;
pub use gc::{collect as collect_orphans, spawn_collector};
pub use operations::{ListedObject, ObjectListing};
pub use store::{Store, StoreError};
pub use upload::{UploadOptions, UploadOutcome, UploadStream, UploadedObject};

#[derive(Clone)]
pub struct StorageState {
    pub pool: Pool,
    pub keys: Arc<Keys>,
    pub store: Arc<Store>,
    pub settings: Arc<StorageSettings>,
    uploads: Arc<Semaphore>,
    /// Upload slots per caller, so one caller cannot take all of `uploads`.
    callers: Arc<CallerLimit>,
    quota: Arc<quota::Quota>,
}

impl StorageState {
    /// Bind orphan collection to this database before accepting file writes.
    /// A provider outage leaves collection disabled; uploads retry initialization.
    pub async fn initialize_store(&self, admin: &tokio_postgres::Client) -> Result<(), StoreError> {
        self.store.initialize_owner(admin, &self.pool).await
    }

    pub fn new(pool: Pool, keys: Arc<Keys>, store: Arc<Store>, settings: StorageSettings) -> Self {
        store.collection_grace_secs.fetch_max(
            settings.upload_timeout.as_secs().saturating_add(3600),
            std::sync::atomic::Ordering::Relaxed,
        );
        StorageState {
            pool,
            keys,
            store,
            callers: Arc::new(CallerLimit::new(settings.uploads_per_caller)),
            settings: Arc::new(settings),
            uploads: Arc::new(Semaphore::new(STORAGE_CONCURRENT_UPLOADS)),
            quota: Arc::default(),
        }
    }
}

impl StorageState {
    /// `disk` or `s3`.
    pub fn backend(&self) -> &'static str {
        if self.store.is_s3() {
            return "s3";
        }
        "disk"
    }
}

/// Whether `id` is a valid bucket name (D77).
pub fn valid_bucket(id: &str) -> bool {
    path::bucket(id).is_ok()
}

impl FromRef<StorageState> for SharedVerifier {
    fn from_ref(state: &StorageState) -> Self {
        state.keys.clone()
    }
}

/// Server-wide limits (D80) and the origin of public URLs.
#[derive(Clone, Debug)]
pub struct StorageSettings {
    pub max_file_size: u64,
    pub max_total_size: Option<u64>,
    pub min_free_bytes: u64,
    pub public_url: Option<String>,
    pub upload_timeout: Duration,
    /// Uploads one caller may stream at once
    /// (`NELCOTA_STORAGE_UPLOADS_PER_CALLER`); 0 disables the limit.
    pub uploads_per_caller: usize,
    /// Trusted proxies whose `X-Forwarded-For` entries name the caller's
    /// address (`NELCOTA_TRUST_PROXY`, `NELCOTA_TRUSTED_PROXY_HOPS`); 0 reads
    /// the TCP peer.
    pub proxy_hops: u8,
}

impl StorageSettings {
    pub fn from_config(config: &Config) -> Self {
        StorageSettings {
            max_file_size: config.storage_max_file_size,
            max_total_size: config.storage_max_total_size,
            min_free_bytes: config.storage_min_free_bytes,
            public_url: config
                .storage_public_url
                .as_deref()
                .map(|u| u.trim().trim_end_matches('/').to_owned())
                .filter(|u| !u.is_empty()),
            upload_timeout: Duration::from_secs(config.storage_upload_timeout_secs),
            uploads_per_caller: config.storage_uploads_per_caller,
            proxy_hops: config.proxy_hops(),
        }
    }
}

/// Storage routes. They carry no request timeout or compression (D78): the
/// caller mounts them outside those layers.
pub fn router(state: StorageState) -> Router {
    // Only the routes that take a file lift the body limit; the JSON ones
    // keep axum's default.
    let uploads = Router::new()
        .route(
            "/storage/v1/object/{bucket}/{*name}",
            get(http::private_download)
                .post(http::create)
                .put(http::upsert)
                .delete(http::remove),
        )
        .layer(DefaultBodyLimit::disable());
    Router::new()
        .route(
            "/storage/v1/bucket",
            get(buckets::list).post(buckets::create),
        )
        .route(
            "/storage/v1/bucket/{id}",
            get(buckets::one)
                .put(buckets::update)
                .delete(buckets::remove),
        )
        .route("/storage/v1/object/list/{bucket}", post(http::list))
        .route(
            "/storage/v1/object/public/{bucket}/{*name}",
            get(http::public),
        )
        .route(
            "/storage/v1/object/sign/{bucket}/{*name}",
            get(http::signed).post(http::sign),
        )
        .merge(uploads)
        .with_state(state)
}
