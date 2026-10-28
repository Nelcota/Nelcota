//! Server assembly: shared state, routes and middleware.
//! It lives in a lib (not only in `main`) so the integration tests use the
//! same `Router` as production.

pub mod deployment;

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRef, MatchedPath, Request, State},
    http::{HeaderName, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use deadpool_postgres::Pool;
use nelcota_api::{ApiSettings, Catalog, CatalogHandle};
use nelcota_auth::{AuthState, SharedVerifier};
use nelcota_core::{ApiError, ErrorInfo};
use serde_json::json;
use std::sync::Arc;
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

#[derive(Clone, FromRef)]
pub struct AppState {
    pub pool: Pool,
    pub verifier: SharedVerifier,
    pub catalog: Arc<CatalogHandle>,
    pub api: Arc<ApiSettings>,
}

/// Runs the first introspection of the exposed schema.
pub async fn load_catalog(pool: &Pool, schema: &str) -> anyhow::Result<Arc<CatalogHandle>> {
    let mut client = pool.get().await?;
    let catalog = Catalog::load_snapshot(&mut client, schema).await?;
    tracing::info!(
        schema,
        tables = catalog.tables.len(),
        functions = catalog.functions.len(),
        "catalog loaded"
    );
    Ok(Arc::new(CatalogHandle::new(catalog)))
}

pub fn app(
    state: AppState,
    auth: AuthState,
    admin: Option<nelcota_admin::AdminState>,
    storage: Option<nelcota_storage::StorageState>,
    request_timeout: Duration,
) -> Router {
    // The API is called straight from the browser, from any origin; the
    // protection is JWT + RLS, not CORS. Cookies are not used (no credentials).
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::RANGE,
            header::IF_NONE_MATCH,
            header::IF_RANGE,
            HeaderName::from_static("prefer"),
            REQUEST_ID,
        ])
        // What a browser client needs to read: paging totals, file metadata,
        // the applied preferences and how long to wait after a 429.
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_DISPOSITION,
            header::ETAG,
            header::LAST_MODIFIED,
            header::RETRY_AFTER,
            HeaderName::from_static("preference-applied"),
            REQUEST_ID,
        ])
        // Browsers cache the preflight for 2 hours (Chromium caps it there)
        // instead of sending an OPTIONS before every non-simple request.
        .max_age(Duration::from_secs(2 * 60 * 60));

    let verifier = state.verifier.clone();
    let mut router = Router::new()
        .route("/health", get(health))
        .merge(nelcota_api::router().layer(DefaultBodyLimit::max(state.api.max_body_bytes)))
        .with_state(state)
        .merge(nelcota_auth::router(auth))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            request_timeout,
        ));
    let observed = admin.as_ref().map(|admin| Observed {
        denied: admin.denied.clone(),
        metrics: admin.metrics.clone(),
    });
    router = router.layer(CompressionLayer::new());
    // Storage stays outside the timeout (uploads take as long as they take,
    // with their own cap) and gzip (files are served byte for byte, by range).
    if let Some(storage) = storage {
        router = router.merge(nelcota_storage::router(storage));
    }
    router = router.layer(cors);
    if let Some(admin) = admin {
        // Panel statements have a 30 s database limit and may wait 5 s for
        // a pool connection. Let PostgreSQL finish before the HTTP deadline.
        router = router.merge(
            nelcota_admin::router(admin.clone())
                .layer(TimeoutLayer::with_status_code(
                    StatusCode::GATEWAY_TIMEOUT,
                    request_timeout.max(Duration::from_secs(40)),
                ))
                .layer(CompressionLayer::new()),
        );
        router = router.merge(nelcota_admin::deployment_router(admin.clone()).layer(
            TimeoutLayer::with_status_code(StatusCode::GATEWAY_TIMEOUT, Duration::from_secs(180)),
        ));
        if admin.storage.is_some() {
            router = router.merge(nelcota_admin::upload_router(admin));
        }
    }
    router = router
        .fallback(not_found)
        .layer(middleware::from_fn(json_errors));
    // API traffic feeds the panel's overview charts and its "Recently
    // blocked" list.
    if let Some(observed) = observed {
        router = router.layer(middleware::from_fn_with_state(
            (observed, verifier),
            observe,
        ));
    }
    router
        .layer(middleware::from_fn(access_log))
        // Route templates exclude both signed queries and identifying path values.
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &Request| {
                let request_id = request
                    .headers()
                    .get(&REQUEST_ID)
                    .and_then(|v| v.to_str().ok())
                    .filter(|id| {
                        id.len() <= 128
                            && !id.is_empty()
                            && id.bytes().all(|b| {
                                b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')
                            })
                    })
                    .unwrap_or("[redacted]");
                tracing::info_span!(
                    "request",
                    method = diagnostic_method(request.method()),
                    path = diagnostic_route(request),
                    request_id,
                )
            }),
        )
        // Every response carries `x-request-id`: the caller's own (from a
        // proxy in front) or a new UUID, also recorded in the request's span.
        .layer(PropagateRequestIdLayer::new(REQUEST_ID))
        .layer(SetRequestIdLayer::new(REQUEST_ID, MakeRequestUuid))
}

/// Header that identifies a request in the logs and in its response.
const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// One INFO line per response: method, route template, status and time to the
/// response head. Raw paths and queries can carry identifying/signed values.
/// Health probes log at DEBUG so they do not drown the rest.
async fn access_log(request: Request, next: Next) -> Response {
    let method = diagnostic_method(request.method());
    let path = diagnostic_route(&request).to_owned();
    let health = request.uri().path() == "/health";
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
    match health {
        true => {
            tracing::debug!(%method, path, status, latency_ms, "response");
        }
        false => {
            tracing::info!(%method, path, status, latency_ms, "response");
        }
    }
    response
}

fn diagnostic_route(request: &Request) -> &str {
    request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or("[unmatched]")
}

fn diagnostic_method(method: &Method) -> &'static str {
    match *method {
        Method::GET => "GET",
        Method::HEAD => "HEAD",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::PATCH => "PATCH",
        Method::DELETE => "DELETE",
        Method::OPTIONS => "OPTIONS",
        Method::CONNECT => "CONNECT",
        Method::TRACE => "TRACE",
        _ => "OTHER",
    }
}

/// Where API traffic is recorded for the panel.
#[derive(Clone)]
struct Observed {
    denied: Arc<nelcota_admin::DeniedLog>,
    metrics: Arc<nelcota_admin::Metrics>,
}

/// Counts every API request (not the panel's own routes) per minute, and
/// records those answered with 401, 403 or 429. The role comes from verifying
/// the token again, only for refused requests; the token itself and the
/// query string are never kept. Latency is time to the response head.
async fn observe(
    State((observed, verifier)): State<(Observed, SharedVerifier)>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    if path.starts_with("/admin") || path == "/health" {
        return next.run(request).await;
    }
    let started = std::time::Instant::now();
    let method = request.method().to_string();
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| nelcota_auth::bearer_token(v).unwrap_or(v).to_owned());
    let response = next.run(request).await;
    let status = response.status();
    observed.metrics.record(
        nelcota_admin::Area::of(&path),
        status.as_u16(),
        started.elapsed(),
    );
    if !matches!(status.as_u16(), 401 | 403 | 429) {
        return response;
    }
    let (role, user_id, email) = match bearer.map(|token| verifier.verify(&token)) {
        None => ("anon".to_owned(), None, None),
        Some(Ok(claims)) => (
            claims.role().as_str().to_owned(),
            claims.sub().map(|id| id.to_string()),
            claims
                .claim("email")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
        ),
        Some(Err(_)) => ("invalid_token".to_owned(), None, None),
    };
    let info = response.extensions().get::<ErrorInfo>();
    observed
        .denied
        .record(nelcota_admin::contracts::DeniedRequest {
            at: nelcota_admin::now_rfc3339(),
            method,
            path,
            status: status.as_u16(),
            code: info.map_or_else(
                || format!("http_{}", status.as_u16()),
                |i| i.code.to_owned(),
            ),
            message: info.map_or_else(String::new, |i| i.message.clone()),
            role,
            user_id,
            email,
        });
    response
}

/// Unknown route: the same JSON error as everything else.
async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "route not found")
}

/// Turns any error response that is not already an [`ApiError`] (axum's 405
/// and plain-text rejections, the body limit's 413, the request timeout's
/// 504) into the API's `{"code", "message"}` JSON. The panel's routes keep
/// their own error shape.
async fn json_errors(request: Request, next: Next) -> Response {
    let panel = request.uri().path() == "/admin" || request.uri().path().starts_with("/admin/");
    let response = next.run(request).await;
    if response.status().as_u16() < 400
        || response.extensions().get::<ErrorInfo>().is_some()
        || (panel
            && response
                .headers()
                .get(header::CONTENT_TYPE)
                .is_some_and(|value| value == "application/json"))
    {
        return response;
    }
    let (parts, body) = response.into_parts();
    let status = parts.status;
    // axum's rejections explain themselves in a short plain-text body.
    let text = match parts.headers.contains_key(header::CONTENT_ENCODING) {
        true => None,
        false => axum::body::to_bytes(body, 4096)
            .await
            .ok()
            .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty()),
    };
    let (code, default) = match status {
        StatusCode::BAD_REQUEST => ("bad_request", "bad request"),
        StatusCode::NOT_FOUND => ("not_found", "route not found"),
        StatusCode::METHOD_NOT_ALLOWED => (
            "method_not_allowed",
            "this method is not allowed on this route",
        ),
        StatusCode::PAYLOAD_TOO_LARGE => (
            "payload_too_large",
            "the request body exceeds the size limit",
        ),
        StatusCode::UNSUPPORTED_MEDIA_TYPE => {
            ("unsupported_media_type", "unsupported Content-Type")
        }
        StatusCode::RANGE_NOT_SATISFIABLE => (
            "range_not_satisfiable",
            "the requested range is not satisfiable",
        ),
        StatusCode::UNPROCESSABLE_ENTITY => ("invalid_body", "invalid request body"),
        StatusCode::GATEWAY_TIMEOUT => (
            "timeout",
            "the request took longer than the server's request timeout",
        ),
        StatusCode::SERVICE_UNAVAILABLE => ("unavailable", "service unavailable"),
        status if status.is_server_error() => ("internal", "internal error"),
        _ => ("bad_request", "the request was refused"),
    };
    let message = match (status, text) {
        // The timeout and server errors never echo a body.
        (StatusCode::GATEWAY_TIMEOUT, _) => default.to_owned(),
        (status, _) if status.is_server_error() => default.to_owned(),
        (_, Some(text)) => text,
        (_, None) => default.to_owned(),
    };
    let mut response = match panel {
        true => nelcota_admin::ApiError::new(status, code, message).into_response(),
        false => ApiError::new(status, code, message).into_response(),
    };
    // Keep what the original said besides its body (`Allow` on a 405,
    // `Content-Range` on a 416).
    let own: Vec<HeaderName> = response.headers().keys().cloned().collect();
    for (name, value) in &parts.headers {
        if !own.contains(name) && name != header::CONTENT_LENGTH && name != header::CONTENT_ENCODING
        {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    response
}

/// `GET /health`: 200 if Postgres answers, 503 otherwise.
async fn health(State(pool): State<Pool>) -> impl IntoResponse {
    let ok = match pool.get().await {
        Ok(client) => client.simple_query("SELECT 1").await.is_ok(),
        Err(_) => false,
    };
    let version = env!("CARGO_PKG_VERSION");
    if ok {
        return (
            StatusCode::OK,
            Json(json!({ "status": "ok", "version": version })),
        );
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "status": "unavailable", "version": version })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[tokio::test]
    async fn request_timeout_answers_json() {
        let router = Router::new()
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    "late"
                }),
            )
            .layer(TimeoutLayer::with_status_code(
                StatusCode::GATEWAY_TIMEOUT,
                Duration::from_millis(10),
            ))
            .layer(middleware::from_fn(json_errors));
        let response = router
            .oneshot(Request::get("/slow").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "timeout");
    }
}
