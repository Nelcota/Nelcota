//! Admin panel at `/admin`.
//!
//! - Frontend: a Svelte 5 SPA (`crates/admin/ui`), built with Vite into
//!   `ui/dist` and embedded in the binary (`rust-embed`). No Node in production.
//! - Backend: a JSON API under `/admin/api/*`, behind its own login
//!   (`NELCOTA_ADMIN_EMAIL` + argon2id hash), separate from end users.
//!   In-memory sessions, `HttpOnly; SameSite=Strict` cookie, and an origin
//!   check on every state-changing request (CSRF).
//! - The panel talks to the database over the admin connection: the admin
//!   sees and changes everything, as in `psql`. Table writes reuse the API's
//!   SQL builder (identifiers only from the catalog, values as parameters).

mod apply;
mod assets;
mod auth;
mod connect;
pub mod contracts;
mod ddl;
mod denied;
mod error;
mod metrics;
mod middleware;
mod migrations;
mod overview;
mod policies;
mod profile;
mod projects;
mod sign_in;
mod sql;
mod sso;
mod state;
mod storage;
mod storage_access;
mod tables;
mod tokens;
pub mod updates;
mod users;
mod webhooks;

pub use denied::{DeniedLog, now_rfc3339};
pub use metrics::{Area, Metrics};
pub use migrations::default_dir as default_migrations_dir;
pub use projects::HostLink;
pub use sql::{SqlBusy, SqlExecutor};
pub use sso::Sso;
pub use tokens::TokenIssuer;

use assets::{asset, spa};
pub(crate) use auth::new_session_cookie;
pub use auth::{Credentials, Sessions};
use auth::{login, logout, require_session, session, whoami};
use axum::{
    Router, middleware as axum_middleware,
    response::Redirect,
    routing::{delete, get, post, put},
};
pub use error::ApiError;
use error::api_not_found;
use middleware::{same_origin, security_headers};
pub use state::AdminState;
pub use tables::ExportExecutor;
pub fn router(state: AdminState) -> Router {
    let protected = Router::new()
        .route("/admin/api/session", get(session))
        .route("/admin/api/logout", post(logout))
        .route("/admin/api/overview", get(overview::overview))
        .route("/admin/api/schema", get(sql::schema))
        .route("/admin/api/types", get(tables::types))
        .route("/admin/api/typescript", get(connect::typescript))
        .route("/admin/api/sign-in", get(sign_in::get))
        .route("/admin/api/denied", get(denied::list))
        .route("/admin/api/metrics", get(metrics::get))
        .route(
            "/admin/api/webhooks",
            get(webhooks::list).post(webhooks::create),
        )
        .route(
            "/admin/api/webhooks/deliveries",
            get(webhooks::history).delete(webhooks::clear_history),
        )
        .route("/admin/api/webhooks/deliveries/{id}", get(webhooks::detail))
        .route(
            "/admin/api/webhooks/deliveries/{id}/replay",
            post(webhooks::replay),
        )
        .route(
            "/admin/api/webhooks/{id}",
            put(webhooks::update).delete(webhooks::delete),
        )
        .route("/admin/api/webhooks/{id}/rotate", post(webhooks::rotate))
        .route(
            "/admin/api/tables",
            get(tables::tables).post(tables::create),
        )
        .route(
            "/admin/api/tables/{name}",
            get(tables::table).patch(tables::alter).delete(tables::drop),
        )
        .route("/admin/api/tables/{name}/export", get(tables::export))
        .route("/admin/api/tables/{name}/structure", get(tables::structure))
        .route(
            "/admin/api/tables/{name}/rows",
            post(tables::insert_row)
                .patch(tables::update_row)
                .delete(tables::delete_rows),
        )
        .route("/admin/api/sql", post(sql::run))
        .route("/admin/api/users", get(users::users).post(users::create))
        .route("/admin/api/users/{id}/password", put(users::set_password))
        .route("/admin/api/users/{id}/revoke", post(users::revoke_sessions))
        .route("/admin/api/users/{id}/confirm", post(users::confirm_email))
        .route("/admin/api/users/{id}", delete(users::delete_user))
        .route("/admin/api/policies", get(policies::policies))
        .route("/admin/api/tables/{name}/policies", post(policies::create))
        .route(
            "/admin/api/tables/{name}/policies/{policy}",
            put(policies::replace).delete(policies::drop),
        )
        .route("/admin/api/projects", get(projects::list))
        .route("/admin/api/updates", get(updates::information))
        .route("/admin/api/projects/status", get(projects::status))
        .route("/admin/api/sso/handoff", post(sso::handoff))
        .route("/admin/api/tokens/service-role", post(tokens::service_role))
        .route(
            "/admin/api/migrations",
            get(migrations::list).post(migrations::export),
        )
        .route(
            "/admin/api/migrations/{version}/file",
            get(migrations::file),
        )
        .route("/admin/api/storage", get(storage::overview))
        .route("/admin/api/storage/buckets", post(storage::create_bucket))
        .route(
            "/admin/api/storage/buckets/{id}",
            put(storage::update_bucket).delete(storage::delete_bucket),
        )
        .route(
            "/admin/api/storage/buckets/{id}/access",
            get(storage_access::access).post(storage_access::create),
        )
        .route(
            "/admin/api/storage/buckets/{id}/access/{policy}",
            delete(storage_access::drop),
        )
        .route(
            "/admin/api/storage/buckets/{id}/objects",
            get(storage::list),
        )
        .route(
            "/admin/api/storage/buckets/{id}/file",
            get(storage::download).delete(storage::delete),
        )
        .route(
            "/admin/api/storage/buckets/{id}/files/delete",
            post(storage::delete_many),
        )
        .route("/admin/api/profile", get(profile::get))
        .route("/admin/api/profile/avatar/editor", get(profile::editor))
        .route(
            "/admin/api/profile/avatar",
            get(profile::image)
                .put(profile::upload)
                .delete(profile::remove),
        )
        .route_layer(axum_middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));

    Router::new()
        .route("/admin/api/login", post(login))
        .route("/admin/api/sso", post(sso::redeem))
        .route("/admin/api/whoami", get(whoami))
        .merge(protected)
        .route("/admin/api/{*rest}", get(api_not_found).post(api_not_found))
        .route("/admin/assets/{*file}", get(asset))
        .route("/admin", get(|| async { Redirect::to("/admin/") }))
        .route("/admin/", get(spa))
        .route("/admin/{*route}", get(spa))
        .layer(axum_middleware::from_fn(same_origin))
        .layer(axum_middleware::from_fn(security_headers))
        .with_state(state)
}

/// The panel's file upload, on its own so the server can mount it outside
/// the request timeout and body limit, like the storage API (D78).
pub fn upload_router(state: AdminState) -> Router {
    Router::new()
        .route(
            "/admin/api/storage/buckets/{id}/upload",
            post(storage::upload),
        )
        .route_layer(axum_middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .layer(axum_middleware::from_fn(same_origin))
        .layer(axum_middleware::from_fn(security_headers))
        .with_state(state)
}
