//! Automatic REST API over the Postgres catalog, always executed under RLS.
//!
//! - `GET    /rest/v1/`                 OpenAPI (filtered by role)
//! - `GET    /rest/v1/{table}`          read with filters, ordering and paging
//! - `POST   /rest/v1/{table}`          insert (object or array); upsert with
//!   `Prefer: resolution=merge-duplicates|ignore-duplicates` (+ `on_conflict`)
//! - `PATCH  /rest/v1/{table}?filters`  update
//! - `DELETE /rest/v1/{table}?filters`  delete
//! - `POST   /rest/v1/rpc/{function}`   SQL function call
//!
//! Each request runs in a transaction with the JWT role and claims
//! (`nelcota_core::db::begin_request`). The API does not decide permissions:
//! Postgres does (GRANTs + RLS). Each caller runs a bounded number of
//! requests at a time ([`CallerLimit`]).

pub mod catalog;
pub mod openapi;
pub mod query;
pub mod rust;
pub mod typescript;

mod concurrency;
mod http;
mod operations;
use axum::{
    Router,
    extract::FromRef,
    routing::{get, post},
};
pub use catalog::{Catalog, CatalogHandle, ReloadListener, spawn_reload_listener};
pub use concurrency::{CallerLimit, CallerSlot};
use deadpool_postgres::Pool;
use nelcota_auth::SharedVerifier;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct ApiSettings {
    /// Row cap per root, embedded collection and set-returning RPC.
    /// `None` uses the safe default of 1000.
    pub max_rows: Option<i64>,
    /// Largest request body, in bytes (`NELCOTA_MAX_BODY_BYTES`); the server
    /// applies it to these routes, a larger body gets 413.
    pub max_body_bytes: usize,
    /// Concurrent requests per caller (`NELCOTA_API_CONCURRENCY_PER_CALLER`).
    pub callers: Arc<CallerLimit>,
    /// Trusted proxies whose `X-Forwarded-For` entries name the caller's
    /// address (`NELCOTA_TRUST_PROXY`, `NELCOTA_TRUSTED_PROXY_HOPS`); 0 reads
    /// the TCP peer.
    pub proxy_hops: u8,
}

impl Default for ApiSettings {
    fn default() -> Self {
        ApiSettings {
            max_rows: None,
            max_body_bytes: nelcota_core::config::DEFAULT_MAX_BODY_BYTES,
            callers: Arc::default(),
            proxy_hops: 0,
        }
    }
}

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Pool: FromRef<S>,
    SharedVerifier: FromRef<S>,
    Arc<CatalogHandle>: FromRef<S>,
    Arc<ApiSettings>: FromRef<S>,
{
    Router::new()
        .route("/rest/v1", get(http::openapi))
        .route("/rest/v1/", get(http::openapi))
        .route(
            "/rest/v1/{table}",
            get(http::read)
                .post(http::create)
                .patch(http::update)
                .delete(http::remove),
        )
        .route("/rest/v1/rpc/{function}", post(http::rpc))
}
