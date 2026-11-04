//! Public API CORS, deliberately separate from administrator same-origin checks.
use axum::http::{HeaderName, HeaderValue, Method, header};
use nelcota_core::{Config, config::ConfigError};
use std::time::Duration;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

#[derive(Clone, Default)]
pub struct ApiCors {
    origins: Option<Vec<HeaderValue>>,
}
impl ApiCors {
    pub fn from_config(config: &Config) -> Result<Self, ConfigError> {
        let origins = config
            .cors_origins()?
            .map(|origins| {
                origins
                    .into_iter()
                    .map(|origin| {
                        HeaderValue::from_str(&origin)
                            .map_err(|_| ConfigError::Invalid("invalid API CORS origin header"))
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        Ok(Self { origins })
    }

    pub(super) fn layer(&self) -> CorsLayer {
        let origins = match &self.origins {
            None => AllowOrigin::from(Any),
            Some(origins) => AllowOrigin::list(origins.clone()),
        };
        CorsLayer::new()
            .allow_origin(origins)
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
                crate::REQUEST_ID,
            ])
            .expose_headers([
                header::CONTENT_RANGE,
                header::CONTENT_DISPOSITION,
                header::ETAG,
                header::LAST_MODIFIED,
                header::RETRY_AFTER,
                HeaderName::from_static("preference-applied"),
                crate::REQUEST_ID,
            ])
            // Preserve the browser contract and the existing two-hour preflight
            // cache. Changing the allowlist does not revoke a cached preflight.
            .max_age(Duration::from_secs(2 * 60 * 60))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Request, routing::get};
    use tower::ServiceExt;

    fn router(origins: Option<&str>) -> Router {
        let policy = ApiCors::from_config(&Config {
            cors_allow_origins: origins.map(str::to_owned),
            ..Config::default()
        })
        .unwrap();
        Router::new()
            .route("/rest/v1/probe", get(|| async { "public" }))
            .layer(policy.layer())
            .merge(Router::new().route("/admin/probe", get(|| async { "panel" })))
    }
    fn request(method: Method, path: &str, origin: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "authorization,content-type,x-request-id",
            )
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn default_keeps_wildcard_without_credentials_and_existing_browser_headers() {
        let app = router(None);
        for method in [Method::GET, Method::OPTIONS] {
            let reply = app
                .clone()
                .oneshot(request(
                    method.clone(),
                    "/rest/v1/probe",
                    "https://any.example.test",
                ))
                .await
                .unwrap();
            assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
            assert!(
                !reply
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            );
            if method == Method::OPTIONS {
                assert_eq!(reply.headers()[header::ACCESS_CONTROL_MAX_AGE], "7200");
                assert!(
                    reply.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
                        .to_str()
                        .unwrap()
                        .contains("authorization")
                );
            }
        }
    }
    #[tokio::test]
    async fn allowlist_matches_exact_origin_on_preflight_and_actual_responses() {
        let app = router(Some("https://app.example.test,http://localhost:5173"));
        for method in [Method::GET, Method::OPTIONS] {
            for origin in ["https://app.example.test", "http://localhost:5173"] {
                let reply = app
                    .clone()
                    .oneshot(request(method.clone(), "/rest/v1/probe", origin))
                    .await
                    .unwrap();
                assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], origin);
                assert!(
                    reply.headers()[header::VARY]
                        .to_str()
                        .unwrap()
                        .contains("origin")
                );
                assert!(
                    !reply
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                );
            }
            for origin in [
                "https://evil.example.test",
                "https://app.example.test.evil.test",
                "http://app.example.test",
                "null",
            ] {
                let reply = app
                    .clone()
                    .oneshot(request(method.clone(), "/rest/v1/probe", origin))
                    .await
                    .unwrap();
                assert!(
                    !reply
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                );
            }
        }
    }
    #[tokio::test]
    async fn empty_allowlist_disables_browser_access_not_the_public_api() {
        let reply = router(Some(""))
            .oneshot(request(
                Method::GET,
                "/rest/v1/probe",
                "https://app.example.test",
            ))
            .await
            .unwrap();
        assert_eq!(reply.status(), 200);
        assert!(
            !reply
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
    #[tokio::test]
    async fn api_cors_never_covers_routes_merged_for_the_panel() {
        for origins in [None, Some("https://app.example.test")] {
            for method in [Method::GET, Method::OPTIONS] {
                let reply = router(origins)
                    .oneshot(request(method, "/admin/probe", "https://app.example.test"))
                    .await
                    .unwrap();
                assert!(
                    !reply
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                );
            }
        }
    }
}
