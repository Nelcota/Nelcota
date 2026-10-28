//! Panel users integration scenarios.
use crate::common::panel::{JSON, get, login, send};
use crate::common::*;
use axum::http::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn users_and_sessions() {
    let app = TestApp::spawn().await;
    let session = app
        .post(
            "/auth/v1/signup",
            None,
            json!({ "email": "panel@example.com", "password": "strong-password-123" }),
        )
        .await
        .body;
    let user_id = session["user"]["id"].as_str().unwrap().to_owned();
    let cookie = login(&app).await;

    let users = get(&app, "/admin/api/users?q=panel", &cookie).await;
    assert_eq!(users.body["users"][0]["email"], "panel@example.com");
    assert_eq!(users.body["users"][0]["sessions"], 1);
    assert_eq!(users.body["total"], 1);
    assert!(
        !users.text.contains("argon2id"),
        "the hash never leaves the database"
    );

    let reply = send(
        &app,
        Method::POST,
        &format!("/admin/api/users/{user_id}/revoke"),
        &cookie,
        json!({}),
    )
    .await;
    assert_eq!(reply.body["count"], 1);
    let refresh = app
        .post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({ "refresh_token": session["refresh_token"] }),
        )
        .await;
    assert_eq!(refresh.status, StatusCode::BAD_REQUEST);

    let reply = send(
        &app,
        Method::DELETE,
        &format!("/admin/api/users/{user_id}"),
        &cookie,
        json!(null),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let users = get(&app, "/admin/api/users", &cookie).await;
    assert!(!users.text.contains("panel@example.com"));

    let reply = send(
        &app,
        Method::DELETE,
        "/admin/api/users/not-a-uuid",
        &cookie,
        json!(null),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

async fn password_login(app: &TestApp, email: &str, password: &str) -> Reply {
    app.raw(
        Method::POST,
        "/auth/v1/token?grant_type=password",
        &[JSON],
        json!({ "email": email, "password": password }).to_string(),
    )
    .await
}

#[tokio::test]
async fn failed_session_revocation_rolls_back_the_password_change() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let session = app
        .post(
            "/auth/v1/signup",
            None,
            json!({
                "email": "atomic@example.com", "password": "original-password-123",
            }),
        )
        .await;
    assert_eq!(session.status, StatusCode::CREATED);
    let id = session.body["user"]["id"].as_str().unwrap();
    let original_hash: String = app
        .admin_client
        .query_one(
            "SELECT encrypted_password FROM auth.users WHERE id = $1::text::uuid",
            &[&id],
        )
        .await
        .unwrap()
        .get(0);
    app.admin_client
        .batch_execute(
            "CREATE FUNCTION public.reject_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'test revocation failure'; END $$;
         CREATE TRIGGER reject_revocation BEFORE UPDATE OF revoked_at ON auth.sessions
             FOR EACH ROW EXECUTE FUNCTION public.reject_revocation();",
        )
        .await
        .unwrap();

    let reset = send(
        &app,
        Method::PUT,
        &format!("/admin/api/users/{id}/password"),
        &cookie,
        json!({ "password": "replacement-password-456" }),
    )
    .await;
    assert_eq!(reset.status, StatusCode::INTERNAL_SERVER_ERROR);
    let unchanged_hash: String = app
        .admin_client
        .query_one(
            "SELECT encrypted_password FROM auth.users WHERE id = $1::text::uuid",
            &[&id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(unchanged_hash, original_hash);
    let active: i64 = app.admin_client.query_one(
        "SELECT count(*) FROM auth.sessions WHERE user_id = $1::text::uuid AND revoked_at IS NULL",
        &[&id],
    ).await.unwrap().get(0);
    assert_eq!(active, 1);
    app.admin_client
        .batch_execute("DROP TRIGGER reject_revocation ON auth.sessions")
        .await
        .unwrap();
    let refreshed = app
        .post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({ "refresh_token": session.body["refresh_token"] }),
        )
        .await;
    assert_eq!(refreshed.status, StatusCode::OK);
    assert_eq!(
        password_login(&app, "atomic@example.com", "original-password-123")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        password_login(&app, "atomic@example.com", "replacement-password-456")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn create_user_and_reset_password_from_the_panel() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;

    let created = send(
        &app,
        Method::POST,
        "/admin/api/users",
        &cookie,
        json!({ "email": "  New@Example.com ", "password": "initial-password-123" }),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    // Same rules as public signup: normalized email.
    assert_eq!(created.body["email"], "new@example.com");
    let id = created.body["id"].as_str().unwrap().to_owned();

    // The created user signs in through the public API, with the same hash as signup.
    let session = password_login(&app, "new@example.com", "initial-password-123").await;
    assert_eq!(session.status, StatusCode::OK, "{}", session.text);
    let refresh = session.body["refresh_token"].as_str().unwrap().to_owned();

    for (body, status, code) in [
        (
            json!({ "email": "new@example.com", "password": "other-password-123" }),
            StatusCode::CONFLICT,
            "user_already_exists",
        ),
        (
            json!({ "email": "no-at-sign", "password": "valid-password-123" }),
            StatusCode::BAD_REQUEST,
            "invalid_email",
        ),
        (
            json!({ "email": "short@example.com", "password": "1234567" }),
            StatusCode::BAD_REQUEST,
            "password_too_short",
        ),
    ] {
        let reply = send(&app, Method::POST, "/admin/api/users", &cookie, body).await;
        assert_eq!(reply.status, status, "{}", reply.text);
        assert_eq!(reply.body["code"], code, "{}", reply.text);
    }

    // Reset: the old password stops working and the open session is ended.
    let reset = send(
        &app,
        Method::PUT,
        &format!("/admin/api/users/{id}/password"),
        &cookie,
        json!({ "password": "new-password-456" }),
    )
    .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text);
    assert_eq!(reset.body["sessions_revoked"], 1);
    assert_eq!(
        password_login(&app, "new@example.com", "initial-password-123")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        password_login(&app, "new@example.com", "new-password-456")
            .await
            .status,
        StatusCode::OK
    );
    let reused = app
        .raw(
            Method::POST,
            "/auth/v1/token?grant_type=refresh_token",
            &[JSON],
            json!({ "refresh_token": refresh }).to_string(),
        )
        .await;
    assert_ne!(
        reused.status,
        StatusCode::OK,
        "a session from before the password change cannot refresh"
    );

    let weak = send(
        &app,
        Method::PUT,
        &format!("/admin/api/users/{id}/password"),
        &cookie,
        json!({ "password": "short" }),
    )
    .await;
    assert_eq!(weak.status, StatusCode::BAD_REQUEST);
    let missing = send(
        &app,
        Method::PUT,
        "/admin/api/users/00000000-0000-0000-0000-000000000000/password",
        &cookie,
        json!({ "password": "valid-password-123" }),
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.body["code"], "user_not_found");
    let bad_id = send(
        &app,
        Method::PUT,
        "/admin/api/users/not-a-uuid/password",
        &cookie,
        json!({ "password": "valid-password-123" }),
    )
    .await;
    assert_eq!(bad_id.status, StatusCode::BAD_REQUEST);
}

async fn confirm(app: &TestApp, cookie: &str, id: &str) -> Reply {
    send(
        app,
        Method::POST,
        &format!("/admin/api/users/{id}/confirm"),
        cookie,
        json!({}),
    )
    .await
}

#[tokio::test]
async fn panel_accounts_are_confirmed_and_pending_ones_can_be_confirmed() {
    let app = TestApp::spawn_with(Options {
        confirm_email: true,
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;

    // Created by the administrator: signs in right away, even with
    // confirmation on.
    let created = send(
        &app,
        Method::POST,
        "/admin/api/users",
        &cookie,
        json!({ "email": "staff@example.com", "password": "strong-password-123" }),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(
        password_login(&app, "staff@example.com", "strong-password-123")
            .await
            .status,
        StatusCode::OK
    );

    // Signed up on their own: held until confirmed, here by the panel.
    let pending = app
        .post(
            "/auth/v1/signup",
            None,
            json!({ "email": "pending@example.com", "password": "strong-password-123" }),
        )
        .await;
    let id = pending.body["user"]["id"].as_str().unwrap().to_owned();
    let listed = get(&app, "/admin/api/users?q=pending", &cookie).await;
    assert!(listed.body["users"][0]["email_confirmed_at"].is_null());
    assert_eq!(
        password_login(&app, "pending@example.com", "strong-password-123")
            .await
            .body["code"],
        "email_not_confirmed"
    );

    assert_eq!(confirm(&app, &cookie, &id).await.status, StatusCode::OK);
    let listed = get(&app, "/admin/api/users?q=pending", &cookie).await;
    let confirmed_at = listed.body["users"][0]["email_confirmed_at"].clone();
    assert!(confirmed_at.is_string());
    assert_eq!(
        password_login(&app, "pending@example.com", "strong-password-123")
            .await
            .status,
        StatusCode::OK
    );

    // Idempotent: the first confirmation date stays.
    assert_eq!(confirm(&app, &cookie, &id).await.status, StatusCode::OK);
    let listed = get(&app, "/admin/api/users?q=pending", &cookie).await;
    assert_eq!(listed.body["users"][0]["email_confirmed_at"], confirmed_at);

    let missing = confirm(&app, &cookie, "054f8cd2-decb-4c78-91a1-f351bd8f5b92").await;
    assert_eq!(missing.body["code"], "user_not_found");
    let invalid = confirm(&app, &cookie, "not-a-uuid").await;
    assert_eq!(invalid.body["code"], "invalid_id");
}

#[tokio::test]
async fn users_list_how_each_account_signs_in() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    send(
        &app,
        Method::POST,
        "/admin/api/users",
        &cookie,
        json!({ "email": "with-password@example.com", "password": "strong-password-123" }),
    )
    .await;
    // An account born at providers: no password, two identities.
    app.admin_client
        .batch_execute(
            "WITH u AS (INSERT INTO auth.users (email) VALUES ('octo@example.com') RETURNING id)
             INSERT INTO auth.identities (user_id, provider, provider_id)
             SELECT id, provider, '42' FROM u, (VALUES ('google'), ('github')) AS p(provider)",
        )
        .await
        .unwrap();

    let users = get(&app, "/admin/api/users", &cookie).await.body;
    let user = |email: &str| {
        users["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["email"] == email)
            .cloned()
            .unwrap()
    };
    let password = user("with-password@example.com");
    assert_eq!(password["has_password"], true);
    assert_eq!(password["providers"], json!([]));
    let octo = user("octo@example.com");
    assert_eq!(octo["has_password"], false);
    assert_eq!(octo["providers"], json!(["github", "google"]));
}
