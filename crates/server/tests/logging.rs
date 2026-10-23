//! Diagnostic boundaries use only synthetic canaries, never real credentials.
mod common;

use axum::{
    http::{Method, StatusCode},
    response::IntoResponse,
};
use common::TestApp;
use nelcota_core::{ApiError, Role};
use std::sync::{Arc, Mutex};
use tracing::instrument::WithSubscriber;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}
impl Capture {
    fn read(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
    fn subscriber(&self, json: bool) -> tracing::Dispatch {
        let builder = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(self.clone());
        match json {
            true => tracing::Dispatch::new(builder.json().finish()),
            false => tracing::Dispatch::new(builder.finish()),
        }
    }
    fn valid(&self, json: bool) -> String {
        let log = self.read();
        assert!(!log.is_empty());
        for line in log.lines() {
            assert!(line.len() < 4096, "diagnostic line was not bounded");
            if json {
                serde_json::from_str::<serde_json::Value>(line).unwrap();
            }
        }
        log
    }
}

#[tokio::test]
async fn ordinary_proxy_correlation_keeps_the_http_contract() {
    let app = TestApp::spawn().await;
    for json in [false, true] {
        let capture = Capture::default();
        let reply = app
            .request_with(
                Method::GET,
                "/health",
                None,
                None,
                &[("x-request-id", "from-the-proxy")],
            )
            .with_subscriber(capture.subscriber(json))
            .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.headers["x-request-id"], "from-the-proxy");
        let log = capture.valid(json);
        assert!(log.contains("from-the-proxy"));
        assert!(log.contains("latency_ms"));
    }
}

#[tokio::test]
async fn request_diagnostics_use_routes_instead_of_private_path_values() {
    let app = TestApp::spawn().await;
    for json in [false, true] {
        let capture = Capture::default();
        let reply = app
            .request(
                Method::GET,
                "/rest/v1/path-value-canary?token=query-value-canary",
                None,
                None,
            )
            .with_subscriber(capture.subscriber(json))
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        let log = capture.valid(json);
        assert!(
            !log.contains("path-value-canary"),
            "raw path appeared in a diagnostic"
        );
        assert!(!log.contains("query-value-canary"));
        assert!(log.contains("/rest/v1/{table}"));
        assert!(log.contains("request_id"));
    }
}

#[tokio::test]
async fn oversized_request_ids_are_redacted_without_changing_the_response() {
    let app = TestApp::spawn().await;
    let id = "request-id-canary".repeat(256);
    for json in [false, true] {
        let capture = Capture::default();
        let reply = app
            .request_with(
                Method::GET,
                "/health",
                None,
                None,
                &[("x-request-id", id.as_str())],
            )
            .with_subscriber(capture.subscriber(json))
            .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.headers["x-request-id"].to_str().unwrap(), id);
        let log = capture.valid(json);
        assert!(!log.contains("request-id-canary"));
        assert!(log.contains("request_id"));
    }
}

#[tokio::test]
async fn extension_methods_do_not_amplify_diagnostic_lines() {
    let app = TestApp::spawn().await;
    let method = Method::from_bytes("METHODCANARY".repeat(256).as_bytes()).unwrap();
    for json in [false, true] {
        let capture = Capture::default();
        let reply = app
            .request(method.clone(), "/health", None, None)
            .with_subscriber(capture.subscriber(json))
            .await;
        assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED);
        let log = capture.valid(json);
        assert!(!log.contains("METHODCANARY"));
        assert!(log.contains("OTHER"));
    }
}

async fn database_diagnostic_case(code: &str, expected: StatusCode) {
    let app = TestApp::spawn().await;
    for json in [false, true] {
        let error = app.admin_client.batch_execute(&format!(
            "DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='{code}', MESSAGE='database-message-canary'; END $$;"
        )).await.unwrap_err();
        let capture = Capture::default();
        let error = tracing::dispatcher::with_default(&capture.subscriber(json), || {
            ApiError::from_db(error, Role::ServiceRole)
        });
        assert_eq!(error.into_response().status(), expected);
        let log = capture.valid(json);
        assert!(!log.contains("database-message-canary"));
        assert!(log.contains(code));
    }
}
#[tokio::test]
async fn internal_database_diagnostics_keep_sqlstate_without_opaque_messages() {
    database_diagnostic_case("XX000", StatusCode::INTERNAL_SERVER_ERROR).await;
}
#[tokio::test]
async fn transient_database_diagnostics_keep_sqlstate_without_opaque_messages() {
    database_diagnostic_case("40001", StatusCode::SERVICE_UNAVAILABLE).await;
}

#[tokio::test]
async fn pool_diagnostics_classify_backend_failures_without_the_message() {
    let app = TestApp::spawn().await;
    for json in [false, true] {
        let error = app.admin_client.batch_execute(
            "DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='XX000', MESSAGE='pool-message-canary'; END $$;"
        ).await.unwrap_err();
        let capture = Capture::default();
        let error = tracing::dispatcher::with_default(&capture.subscriber(json), || {
            ApiError::from_pool(deadpool_postgres::PoolError::Backend(error))
        });
        assert_eq!(
            error.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let log = capture.valid(json);
        assert!(!log.contains("pool-message-canary"));
        assert!(log.contains("backend"));
    }
}
