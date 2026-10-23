use crate::common::{Options, TestApp, service_token};
use axum::http::{Method, StatusCode};
use futures_util::future::BoxFuture;
use nelcota_auth::{Email, MailError, Mailer};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    fn validate_json(&self, json: bool) {
        if !json {
            return;
        }
        for line in self.read().lines() {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
    }
    fn clear(&self) {
        self.0.lock().unwrap().clear()
    }
}
struct FailingMailer;
impl Mailer for FailingMailer {
    fn send(&self, _: Email) -> BoxFuture<'_, Result<(), MailError>> {
        Box::pin(async {
            Err(MailError(format!(
                "mail-provider-message-canary {}",
                "x".repeat(5000)
            )))
        })
    }
}

pub(super) async fn check_provider_diagnostics(json: bool) {
    // One test in a dedicated binary owns the global subscriber so spawned mail
    // tasks are captured too. It does not alter another test binary's logger.
    let capture = Capture::default();
    let builder = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(capture.clone());
    match json {
        true => builder.json().init(),
        false => builder.init(),
    }
    let mut unsafe_sources = Vec::new();
    let app = TestApp::spawn_with(Options {
        mailer: Some(Arc::new(FailingMailer)),
        ..Options::default()
    })
    .await;
    let email = "provider-log-fixture@example.test";
    let created = app
        .post(
            "/auth/v1/signup",
            None,
            json!({"email":email,"password":"synthetic-provider-password-42"}),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED);
    capture.clear();
    let response = app
        .post("/auth/v1/recover", None, json!({"email":email}))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !capture.read().lines().any(|line| {
            if !line.contains("failed to send a link email") {
                return false;
            }
            match json {
                true => serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .is_some_and(|event| event["fields"]["kind"] == "recovery"),
                false => line.contains("kind=\"recovery\""),
            }
        }) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    capture.validate_json(json);
    assert!(capture.read().contains("auth.mail_delivery_failed"));
    if capture.read().contains("mail-provider-message-canary") {
        unsafe_sources.push("mail");
    }
    if capture.read().lines().any(|line| line.len() > 4096) {
        unsafe_sources.push("mail_size");
    }
    drop(app);

    let root = std::env::temp_dir().join(format!(
        "storage-provider-path-canary-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(nelcota_storage::Store::disk(root.clone()).unwrap());
    let app = TestApp::spawn_with(Options {
        store: Some(store.clone()),
        ..Options::default()
    })
    .await;
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets(id) VALUES('bucket-name-canary')")
        .await
        .unwrap();
    let response = app
        .bytes(
            Method::POST,
            "/storage/v1/object/bucket-name-canary/sample.txt",
            Some(&service_token()),
            &[],
            b"synthetic fixture".to_vec(),
        )
        .await;
    assert_eq!(response.0, StatusCode::CREATED);
    std::fs::remove_dir_all(&root).unwrap();
    capture.clear();
    let response = app
        .bytes(
            Method::GET,
            "/storage/v1/object/bucket-name-canary/sample.txt",
            Some(&service_token()),
            &[],
            vec![],
        )
        .await;
    assert_eq!(response.0, StatusCode::NOT_FOUND);
    capture.validate_json(json);
    assert!(capture.read().contains("a row points to missing bytes"));
    if capture.read().contains("bucket-name-canary") {
        unsafe_sources.push("missing_object_bucket");
    }
    std::fs::write(&root, b"owned fixture blocks the directory").unwrap();
    capture.clear();
    let response = app
        .bytes(
            Method::POST,
            "/storage/v1/object/bucket-name-canary/next.txt",
            Some(&service_token()),
            &[],
            b"synthetic fixture".to_vec(),
        )
        .await;
    assert_eq!(response.0, StatusCode::INTERNAL_SERVER_ERROR);
    capture.validate_json(json);
    assert!(capture.read().contains("storage backend failed"));
    if capture.read().contains("storage-provider-path-canary") {
        unsafe_sources.push("storage");
    }
    capture.clear();
    store
        .delete_quietly(&object_store::path::Path::from(
            "bucket-name-canary/owned-version",
        ))
        .await;
    capture.validate_json(json);
    assert!(capture.read().contains("storage.delete_deferred"));
    if capture.read().contains("bucket-name-canary")
        || capture.read().contains("storage-provider-path-canary")
    {
        unsafe_sources.push("deferred_delete");
    }
    drop(app);
    std::fs::remove_file(&root).unwrap();
    assert!(
        unsafe_sources.is_empty(),
        "opaque provider diagnostics: {unsafe_sources:?}"
    );
}
