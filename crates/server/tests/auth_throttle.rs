//! Password login admission under targeted abuse: account-wide budgets that
//! keep the owner's known sources usable, and per-source hard ceilings.
mod common;
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use common::*;
use http_body_util::BodyExt;
use serde_json::json;
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

async fn login_from(app: &TestApp, email: &str, password: &str, source: &str) -> Reply {
    let response = app
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/auth/v1/token?grant_type=password")
                .header(header::CONTENT_TYPE, "application/json")
                .extension(ConnectInfo(
                    format!("{source}:1234")
                        .parse::<std::net::SocketAddr>()
                        .unwrap(),
                ))
                .body(Body::from(
                    json!({"email": email, "password": password}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        headers,
        body: serde_json::from_slice(&bytes).unwrap(),
        text: String::new(),
    }
}

#[tokio::test]
async fn account_budget_refuses_fresh_sources_but_admits_a_known_one() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 2,
        mail: false,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let password = Uuid::new_v4().to_string();
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
    // The owner signs in once from their usual network.
    let home = "192.0.2.9";
    assert_eq!(
        login_from(&app, &email, &password, home).await.status,
        StatusCode::OK
    );
    let wrong = Uuid::new_v4().to_string();
    assert_eq!(
        login_from(&app, &email, &wrong, "192.0.2.1").await.status,
        StatusCode::BAD_REQUEST
    );
    // Many addresses cannot guess faster than the account budget allows.
    let blocked = login_from(&app, &email, &wrong, "192.0.2.2").await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers.contains_key(header::RETRY_AFTER));
    assert_eq!(
        login_from(&app, &email, &password, "192.0.2.3")
            .await
            .status,
        StatusCode::TOO_MANY_REQUESTS,
        "a fresh source is refused even with the right password"
    );
    // This is a bound on the deliberately introduced throttle delay plus local
    // test work, not a production latency SLO or a hash-admission change.
    let reply = tokio::time::timeout(
        Duration::from_secs(10),
        login_from(&app, &email, &password, home),
    )
    .await
    .unwrap();
    assert_eq!(reply.status, StatusCode::OK, "the owner keeps access");
    assert_eq!(
        app.post("/auth/v1/recover", None, json!({"email": email}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn one_source_keeps_its_existing_hard_ceiling() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 2,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let wrong = Uuid::new_v4().to_string();
    for _ in 0..2 {
        assert_eq!(
            login_from(&app, &email, &wrong, "192.0.2.4").await.status,
            StatusCode::BAD_REQUEST
        );
    }
    let blocked = login_from(&app, &email, &wrong, "192.0.2.4").await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers.contains_key(header::RETRY_AFTER));
    // Another source keeps its own ceiling (a different account, so the
    // exhausted account-wide budget is not what is being checked).
    let other = format!("{}@example.test", Uuid::new_v4().simple());
    assert_eq!(
        login_from(&app, &other, &wrong, "192.0.2.5").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn ipv6_addresses_in_one_64_share_a_budget() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 2,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let wrong = Uuid::new_v4().to_string();
    for source in ["[2001:db8:0:1::1]", "[2001:db8:0:1::2]"] {
        assert_eq!(
            login_from(&app, &email, &wrong, source).await.status,
            StatusCode::BAD_REQUEST
        );
    }
    let blocked = login_from(&app, &email, &wrong, "[2001:db8:0:1:ffff::3]").await;
    assert_eq!(
        blocked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "a new address in the same /64 has no fresh budget"
    );
    // A different account, so only the per-network budget is in play.
    let other = format!("{}@example.test", Uuid::new_v4().simple());
    assert_eq!(
        login_from(&app, &other, &wrong, "[2001:db8:0:2::1]")
            .await
            .status,
        StatusCode::BAD_REQUEST,
        "another /64 keeps its own budget"
    );
}
