//! Local runtime evidence for typed host operations. Proxy headers never grant
//! loopback authority; an external request gets no configuration values.
use axum::{
    Json,
    extract::{ConnectInfo, Request, State},
    http::{StatusCode, header},
};
use nelcota_core::settings::Snapshot;
use std::{net::SocketAddr, sync::Arc};

pub(super) async fn runtime(
    State(snapshot): State<Arc<Snapshot>>,
    request: Request,
) -> Result<Json<Snapshot>, StatusCode> {
    if request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_none_or(|peer| !peer.0.ip().is_loopback())
    {
        return Err(StatusCode::FORBIDDEN);
    }
    // Also refuse local browsers and loopback reverse proxies (native serving
    // can put Caddy on the same host). The fixed probe sends this Host and no
    // browser/forwarding headers. These checks only restrict access; no header
    // can turn a non-loopback socket into an authorized local peer.
    if request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        != Some("127.0.0.1:8000")
        || [
            "origin",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "via",
            "sec-fetch-site",
        ]
        .iter()
        .any(|name| request.headers().contains_key(*name))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json((*snapshot).clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Request as HttpRequest, routing::get};
    use http_body_util::BodyExt;
    use nelcota_core::{Config, Secret};
    use tower::ServiceExt;

    #[tokio::test]
    async fn only_socket_loopback_can_read_startup_values_and_no_secret_is_projected() {
        let mut config = Config {
            jwt_secret: Some(Secret::new("private-signing-key")),
            signup_enabled: false,
            ..Config::default()
        };
        let snapshot = Arc::new(Snapshot::new(&config));
        // Captured at startup, not reread from a file or the calling environment.
        config.signup_enabled = true;
        assert!(config.signup_enabled);
        let app = Router::new()
            .route("/health/configuration", get(runtime))
            .with_state(snapshot);
        for peer in [
            None,
            Some("192.0.2.1:1234"),
            Some("10.0.0.1:1234"),
            Some("[::ffff:127.0.0.1]:1234"),
        ] {
            let mut request = HttpRequest::get("/health/configuration")
                .header(header::HOST, "127.0.0.1:8000")
                .header("x-forwarded-for", "127.0.0.1")
                .header("forwarded", "for=127.0.0.1")
                .body(Body::empty())
                .unwrap();
            if let Some(peer) = peer {
                request
                    .extensions_mut()
                    .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
            }
            let reply = app.clone().oneshot(request).await.unwrap();
            assert_eq!(reply.status(), StatusCode::FORBIDDEN);
        }
        for peer in ["127.0.0.1:1234", "[::1]:1234"] {
            let mut request = HttpRequest::get("/health/configuration")
                .header(header::HOST, "127.0.0.1:8000")
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
            let reply = app.clone().oneshot(request).await.unwrap();
            assert_eq!(reply.status(), 200);
            let bytes = reply.into_body().collect().await.unwrap().to_bytes();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["schema"], 1);
            assert_eq!(value["values"]["signup_enabled"], false);
            assert!(value["values"].get("jwt_secret").is_none());
            assert!(!String::from_utf8_lossy(&bytes).contains("private-signing-key"));
        }
        for (name, value) in [
            ("origin", "https://external.test"),
            ("x-forwarded-for", "127.0.0.1"),
            ("forwarded", "for=127.0.0.1"),
            ("sec-fetch-site", "cross-site"),
            ("host", "api.example.test"),
        ] {
            let mut request = HttpRequest::get("/health/configuration")
                .header(header::HOST, "127.0.0.1:8000")
                .body(Body::empty())
                .unwrap();
            request.headers_mut().insert(
                axum::http::HeaderName::from_static(name),
                axum::http::HeaderValue::from_static(value),
            );
            request
                .extensions_mut()
                .insert(ConnectInfo("127.0.0.1:1234".parse::<SocketAddr>().unwrap()));
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
    }
}
