//! The REST and storage budget: per IP for anonymous callers, per account for
//! signed-in users, none for `service_role`, and never on the auth routes.
mod common;
use axum::http::{Method, StatusCode, header};
use common::*;
use serde_json::json;
use uuid::Uuid;

const ORIGIN: (&str, &str) = ("origin", "https://app.example.test");

async fn openapi(app: &TestApp, token: Option<&str>) -> Reply {
    app.request_with(Method::GET, "/rest/v1/", token, None, &[ORIGIN])
        .await
}

#[tokio::test]
async fn api_budget_is_per_caller_and_exempts_service_role() {
    let app = TestApp::spawn_with(Options {
        api_rate_limit_per_minute: 2,
        ..Options::default()
    })
    .await;
    for _ in 0..2 {
        assert_ne!(
            openapi(&app, None).await.status,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    let blocked = openapi(&app, None).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(blocked.body["code"], "rate_limited");
    assert!(blocked.headers.contains_key(header::RETRY_AFTER));
    assert!(
        blocked
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        "browsers can read the refusal and its Retry-After"
    );

    // A signed-in user has a budget of their own, not their network's.
    let user = user_token(Uuid::new_v4());
    for _ in 0..2 {
        let reply = openapi(&app, Some(&user)).await;
        assert_ne!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    }
    let blocked = openapi(&app, Some(&user)).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    let other = user_token(Uuid::new_v4());
    let reply = openapi(&app, Some(&other)).await;
    assert_ne!(reply.status, StatusCode::TOO_MANY_REQUESTS);

    // The project's own backend is never throttled.
    let service = service_token();
    for _ in 0..5 {
        let reply = openapi(&app, Some(&service)).await;
        assert_ne!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    }

    // Auth routes keep their own budgets.
    let reply = app
        .post("/auth/v1/token?grant_type=unknown", None, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn api_budget_is_off_when_zero() {
    let app = TestApp::spawn_with(Options::default()).await;
    for _ in 0..20 {
        assert_ne!(
            openapi(&app, None).await.status,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
}
