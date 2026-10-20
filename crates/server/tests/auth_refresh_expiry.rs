//! Expiration bounds retry grace without weakening refresh reuse detection.
mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};
use tokio_postgres::NoTls;
use uuid::Uuid;

async fn signup(app: &TestApp) -> Value {
    let reply = app
        .post(
            "/auth/v1/signup",
            None,
            json!({
                "email": format!("{}@example.test", Uuid::new_v4().simple()),
                "password": Uuid::new_v4().to_string(),
            }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    reply.body
}

async fn refresh(app: &TestApp, token: &str) -> Reply {
    app.post(
        "/auth/v1/token?grant_type=refresh_token",
        None,
        json!({"refresh_token": token}),
    )
    .await
}

#[tokio::test]
async fn expired_rotated_token_cannot_use_retry_grace() {
    let app = TestApp::spawn().await;
    let initial = signup(&app).await;
    let original = initial["refresh_token"].as_str().unwrap();
    let rotated = refresh(&app, original).await;
    assert_eq!(rotated.status, StatusCode::OK);
    let digest = Sha256::digest(original.as_bytes()).to_vec();
    app.admin_client
        .execute(
            "UPDATE auth.refresh_tokens SET expires_at = now() - interval '1 second'
         WHERE token_hash = $1",
            &[&digest],
        )
        .await
        .unwrap();

    let rejected = refresh(&app, original).await;
    assert_eq!(rejected.status, StatusCode::BAD_REQUEST);
    assert_eq!(rejected.body["code"], "invalid_grant");
    // An expired, rotated credential follows reuse handling, not retry issuance.
    assert_eq!(
        refresh(&app, rotated.body["refresh_token"].as_str().unwrap())
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let count: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM auth.refresh_tokens WHERE session_id = (
             SELECT session_id FROM auth.refresh_tokens WHERE token_hash = $1)",
            &[&digest],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 2, "rejection must not mint another token");
}

async fn waiting_transaction_start(app: &TestApp) -> SystemTime {
    for _ in 0..500 {
        let row = app
            .admin_client
            .query_opt(
                "SELECT xact_start FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%FROM auth.refresh_tokens rt%'
               AND xact_start IS NOT NULL",
                &[],
            )
            .await
            .unwrap();
        if let Some(row) = row {
            return row.get(0);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("refresh did not reach its token lock");
}

async fn assert_exact_expiration(rotated: bool) {
    let app = TestApp::spawn().await;
    let initial = signup(&app).await;
    let original = initial["refresh_token"].as_str().unwrap();
    if rotated {
        assert_eq!(refresh(&app, original).await.status, StatusCode::OK);
    }
    let digest = Sha256::digest(original.as_bytes()).to_vec();
    let (mut blocker, connection) = app.admin.connect(NoTls).await.unwrap();
    let connection = tokio::spawn(connection);
    let tx = blocker.transaction().await.unwrap();
    tx.query_one(
        "SELECT id FROM auth.refresh_tokens WHERE token_hash = $1 FOR UPDATE",
        &[&digest],
    )
    .await
    .unwrap();
    // Pin the deadline to the actual request transaction clock, without sleeps
    // to approximate expiry or changing the product clock/TTL.
    let expire = async {
        let at = waiting_transaction_start(&app).await;
        tx.execute(
            "UPDATE auth.refresh_tokens SET expires_at = $2 WHERE token_hash = $1",
            &[&digest, &at],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    };
    let (reply, ()) = tokio::join!(refresh(&app, original), expire);
    drop(blocker);
    connection.await.unwrap().unwrap();
    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "the exact deadline is expired"
    );
    assert_eq!(reply.body["code"], "invalid_grant");
}

#[tokio::test]
async fn first_use_at_the_exact_expiration_is_rejected() {
    assert_exact_expiration(false).await;
}

#[tokio::test]
async fn retry_at_the_exact_expiration_is_rejected() {
    assert_exact_expiration(true).await;
}
