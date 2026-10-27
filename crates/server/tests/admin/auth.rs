//! Panel auth integration scenarios.
use crate::common::panel::{JSON, get, login, send};
use crate::common::*;
use axum::http::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn separate_login_and_protected_api() {
    let app = TestApp::spawn().await;

    for path in [
        "/admin/api/overview",
        "/admin/api/tables/products",
        "/admin/api/users",
    ] {
        let reply = app.raw(Method::GET, path, &[], String::new()).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let reply = app
        .raw(
            Method::POST,
            "/admin/api/sql",
            &[JSON],
            json!({ "sql": "select 1" }).to_string(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);

    for (email, password) in [
        (ADMIN_EMAIL, "wrong-password"),
        ("someone@example.com", ADMIN_PASSWORD),
    ] {
        let reply = app
            .raw(
                Method::POST,
                "/admin/api/login",
                &[JSON],
                json!({ "email": email, "password": password }).to_string(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.body["error"], "Invalid email or password.");
        // The panel translates by code (crates/admin/ui/src/lib/i18n/messages/<language>/errors.ts).
        assert_eq!(reply.body["code"], "invalid_credentials");
    }

    // A JWT (not even service_role) does not open the panel.
    let reply = app
        .raw(
            Method::GET,
            "/admin/api/overview",
            &[("authorization", &format!("Bearer {}", service_token()))],
            String::new(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);

    let cookie = login(&app).await;
    let reply = get(&app, "/admin/api/session", &cookie).await;
    assert_eq!(reply.body["email"], ADMIN_EMAIL);

    // Login the way a browser does it (same origin) passes; `Origin: null` does not.
    let browser = |origin: &'static str| {
        [
            JSON,
            ("host", "localhost"),
            ("origin", origin),
            ("sec-fetch-site", "same-origin"),
        ]
    };
    let credentials = json!({ "email": ADMIN_EMAIL, "password": ADMIN_PASSWORD }).to_string();
    let reply = app
        .raw(
            Method::POST,
            "/admin/api/login",
            &browser("https://localhost"),
            credentials.clone(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = app
        .raw(
            Method::POST,
            "/admin/api/login",
            &browser("null"),
            credentials,
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.body["code"], "origin_not_allowed");

    // Logout invalidates the session.
    let reply = send(&app, Method::POST, "/admin/api/logout", &cookie, json!({})).await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = get(&app, "/admin/api/session", &cookie).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    assert_eq!(reply.body["code"], "session_expired");
}
