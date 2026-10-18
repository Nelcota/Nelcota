//! Account password bounds are checked before acquiring scarce resources.
mod common;
use axum::http::{Method, StatusCode};
use common::*;
use serde_json::json;
use std::time::Duration;
use uuid::Uuid;

#[tokio::test]
async fn oversized_login_passwords_are_refused_before_pool_admission() {
    let app = TestApp::spawn_with(Options {
        pool_size: 1,
        ..Options::default()
    })
    .await;
    let held = app.pool.get().await.unwrap();
    for password in ["x".repeat(257), "界".repeat(257)] {
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            app.post(
                "/auth/v1/token?grant_type=password",
                None,
                json!({"email": "bounded@example.test", "password": password}),
            ),
        )
        .await;
        assert!(
            result.is_ok(),
            "oversized credentials must not wait for a database connection"
        );
        let reply = result.unwrap();
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(reply.body["code"], "invalid_grant");
    }
    drop(held);
}

#[tokio::test]
async fn oversized_current_password_is_refused_before_pool_admission() {
    let app = TestApp::spawn_with(Options {
        pool_size: 1,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let password = Uuid::new_v4().to_string();
    let initial = app
        .post(
            "/auth/v1/signup",
            None,
            json!({"email": email, "password": password}),
        )
        .await;
    assert_eq!(initial.status, StatusCode::CREATED);
    let access = initial.body["access_token"].as_str().unwrap();
    let held = app.pool.get().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), app.request(
        Method::PUT, "/auth/v1/user", Some(access),
        Some(json!({"password": Uuid::new_v4().to_string(), "current_password": "界".repeat(257)})),
    )).await;
    drop(held);
    assert!(
        result.is_ok(),
        "oversized credentials must not wait for a database connection"
    );
    let reply = result.unwrap();
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_grant");
}

#[tokio::test]
async fn maximum_length_ascii_and_unicode_passwords_still_sign_in() {
    let app = TestApp::spawn().await;
    for password in ["x".repeat(256), "界".repeat(256)] {
        let email = format!("{}@example.test", Uuid::new_v4().simple());
        assert_eq!(
            app.post(
                "/auth/v1/signup",
                None,
                json!({"email": email, "password": password})
            )
            .await
            .status,
            StatusCode::CREATED
        );
        assert_eq!(
            app.post(
                "/auth/v1/token?grant_type=password",
                None,
                json!({"email": email, "password": password})
            )
            .await
            .status,
            StatusCode::OK
        );
    }
}
