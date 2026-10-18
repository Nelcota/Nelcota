//! The shared verifier enforces time claims before REST role/RLS dispatch.
mod common;
use axum::http::StatusCode;
use common::*;
use serde_json::json;

#[tokio::test]
async fn future_time_claims_never_reach_rest_or_fall_back_to_anon() {
    let app = TestApp::spawn().await;
    for name in ["nbf", "iat"] {
        let mut claims = json!({"role": "authenticated", "sub": app.user_a});
        claims[name] = json!(jsonwebtoken::get_current_timestamp() + 300);
        let (status, body) = app.get("/rest/v1/todos", Some(&token(claims))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["code"], "invalid_token");
    }
    let (status, body) = app
        .get("/rest/v1/todos", Some(&user_token(app.user_a)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);
}
