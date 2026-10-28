//! Authentication flow tests against a real Postgres: signup, login, refresh
//! with rotation and reuse detection, logout, JWKS, rate limit and the email
//! links (password recovery, signup confirmation and magic link).

mod common;

use axum::http::{StatusCode, header};
use common::*;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, jwk::JwkSet};
use nelcota_core::{Claims, db};
use serde_json::{Value, json};
use uuid::Uuid;

async fn signup(app: &TestApp, email: &str, password: &str) -> Reply {
    app.post(
        "/auth/v1/signup",
        None,
        json!({ "email": email, "password": password }),
    )
    .await
}

async fn login(app: &TestApp, email: &str, password: &str) -> Reply {
    app.post(
        "/auth/v1/token?grant_type=password",
        None,
        json!({ "email": email, "password": password }),
    )
    .await
}

async fn refresh(app: &TestApp, refresh_token: &str) -> Reply {
    app.post(
        "/auth/v1/token?grant_type=refresh_token",
        None,
        json!({ "refresh_token": refresh_token }),
    )
    .await
}

fn str_field<'a>(body: &'a Value, field: &str) -> &'a str {
    body[field]
        .as_str()
        .unwrap_or_else(|| panic!("campo {field} ausente em {body}"))
}

#[tokio::test]
async fn full_flow_signup_login_and_access_under_rls() {
    let app = TestApp::spawn().await;

    let reply = signup(&app, "Ana@Example.com", "strong-pass-123").await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let session = reply.body;
    assert_eq!(session["token_type"], "bearer");
    assert_eq!(session["user"]["email"], "ana@example.com");
    let user_id: Uuid = str_field(&session["user"], "id").parse().unwrap();

    // The issued JWT is EdDSA and carries the contract's claims.
    let access = str_field(&session, "access_token");
    let header = jsonwebtoken::decode_header(access).unwrap();
    assert_eq!(header.alg, Algorithm::EdDSA);
    assert!(header.kid.is_some());

    let (status, me) = app.get("/auth/v1/user", Some(access)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["id"], user_id.to_string());

    // The auth token works in the API under RLS: Ana only sees her own todo.
    app.admin_client
        .execute(
            "INSERT INTO public.todos (user_id, title) VALUES ($1, 'Ana''s todo')",
            &[&user_id],
        )
        .await
        .unwrap();
    let (status, todos) = app.get("/rest/v1/todos", Some(access)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(todos, json!([todos[0].clone()]));
    assert_eq!(todos[0]["title"], "Ana's todo");

    // Login with the same password (email in a different case) opens another session.
    let reply = login(&app, "ANA@example.com", "strong-pass-123").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_ne!(
        str_field(&reply.body, "refresh_token"),
        str_field(&session, "refresh_token")
    );
    assert!(reply.body["user"]["last_sign_in_at"].is_string());
}

#[tokio::test]
async fn password_stored_as_phc_argon2id() {
    let app = TestApp::spawn().await;
    assert_eq!(
        signup(&app, "bia@example.com", "strong-pass-123")
            .await
            .status,
        StatusCode::CREATED
    );
    let hash: String = app
        .admin_client
        .query_one(
            "SELECT encrypted_password FROM auth.users WHERE email = 'bia@example.com'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(hash.starts_with("$argon2id$v=19$"), "{hash}");
    assert!(!hash.contains("strong-pass-123"));

    // Refresh tokens are not stored in the clear either.
    let stored: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM auth.refresh_tokens WHERE length(token_hash) = 32",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(stored, 1);
}

#[tokio::test]
async fn signup_validates_input_and_duplicate_email() {
    let app = TestApp::spawn().await;
    assert_eq!(
        signup(&app, "caio@example.com", "strong-pass-123")
            .await
            .status,
        StatusCode::CREATED
    );
    let dup = signup(&app, "CAIO@example.com", "other-pass-456").await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    assert_eq!(dup.body["code"], "user_already_exists");

    let bad_email = signup(&app, "not-an-email", "strong-pass-123").await;
    assert_eq!(bad_email.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(bad_email.body["code"], "invalid_email");
    assert_eq!(bad_email.body["message"], "invalid email");
    let weak = signup(&app, "dani@example.com", "short").await;
    assert_eq!(weak.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(weak.body["code"], "weak_password");
    assert_eq!(
        weak.body["message"],
        "the password needs at least 8 characters"
    );
    let missing = app
        .post(
            "/auth/v1/signup",
            None,
            json!({ "email": "eva@example.com" }),
        )
        .await;
    assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(missing.body["code"], "invalid_body");
}

#[tokio::test]
async fn invalid_login_does_not_reveal_whether_email_exists() {
    let app = TestApp::spawn().await;
    signup(&app, "edu@example.com", "strong-pass-123").await;

    let wrong = login(&app, "edu@example.com", "wrong-pass-000").await;
    let unknown = login(&app, "nobody@example.com", "wrong-pass-000").await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert_eq!(wrong.body, unknown.body);
    assert_eq!(wrong.body["code"], "invalid_grant");
}

#[tokio::test]
async fn refresh_rotates_and_reuse_voids_the_family() {
    let app = TestApp::spawn().await;
    let session = signup(&app, "fabi@example.com", "strong-pass-123")
        .await
        .body;
    let r1 = str_field(&session, "refresh_token").to_owned();

    // Legitimate use: R1 -> R2.
    let rotated = refresh(&app, &r1).await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.body);
    let r2 = str_field(&rotated.body, "refresh_token").to_owned();
    assert_ne!(r1, r2);
    assert!(rotated.body["access_token"].is_string());

    // R2 -> R3 keeps working.
    let rotated = refresh(&app, &r2).await;
    assert_eq!(rotated.status, StatusCode::OK);
    let r3 = str_field(&rotated.body, "refresh_token").to_owned();

    // Reuse of R1 (stolen): rejected and the whole session is revoked...
    let reuse = refresh(&app, &r1).await;
    assert_eq!(reuse.status, StatusCode::BAD_REQUEST);
    assert_eq!(reuse.body["code"], "invalid_grant");

    // ...including the newest token of the family.
    let after = refresh(&app, &r3).await;
    assert_eq!(after.status, StatusCode::BAD_REQUEST);

    // Other sessions of the same user are not affected.
    let other = login(&app, "fabi@example.com", "strong-pass-123")
        .await
        .body;
    assert_eq!(
        refresh(&app, str_field(&other, "refresh_token"))
            .await
            .status,
        StatusCode::OK
    );

    assert_eq!(
        refresh(&app, "no-such-token").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn refresh_retry_within_the_grace_window_keeps_the_session() {
    let app = TestApp::spawn().await;
    let session = signup(&app, "retry@example.com", "strong-pass-123")
        .await
        .body;
    let r1 = str_field(&session, "refresh_token").to_owned();

    // R1 -> R2, but the client never saw the answer and retries with R1.
    let lost = refresh(&app, &r1).await;
    assert_eq!(lost.status, StatusCode::OK);
    let r2 = str_field(&lost.body, "refresh_token").to_owned();
    let retried = refresh(&app, &r1).await;
    assert_eq!(retried.status, StatusCode::OK, "{}", retried.body);
    let r3 = str_field(&retried.body, "refresh_token").to_owned();
    assert_ne!(r3, r2);
    assert_eq!(
        retried.body["user"]["email"], "retry@example.com",
        "{}",
        retried.body
    );
    let claims = |body: &Value| {
        let payload = str_field(body, "access_token").split('.').nth(1).unwrap();
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .unwrap();
        serde_json::from_slice::<Value>(&bytes).unwrap()
    };
    assert_eq!(
        claims(&retried.body)["session_id"],
        claims(&lost.body)["session_id"],
        "the retry stays in the same session"
    );

    // Only the newest token works: R3 rotates on; the lost R2 is gone.
    let next = refresh(&app, &r3).await;
    assert_eq!(next.status, StatusCode::OK, "{}", next.body);
    let r4 = str_field(&next.body, "refresh_token").to_owned();
    // Once R3 has rotated, presenting R1 again is reuse, not a retry.
    let reuse = refresh(&app, &r1).await;
    assert_eq!(reuse.status, StatusCode::BAD_REQUEST);
    assert_eq!(refresh(&app, &r4).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(refresh(&app, &r2).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn refresh_reuse_after_the_grace_window_revokes_the_session() {
    let app = TestApp::spawn().await;
    let session = signup(&app, "late@example.com", "strong-pass-123")
        .await
        .body;
    let r1 = str_field(&session, "refresh_token").to_owned();
    let rotated = refresh(&app, &r1).await;
    assert_eq!(rotated.status, StatusCode::OK);
    let r2 = str_field(&rotated.body, "refresh_token").to_owned();

    // The rotation happened a minute ago.
    app.admin_client
        .batch_execute(
            "UPDATE auth.refresh_tokens SET created_at = created_at - interval '1 minute';
             UPDATE auth.sessions SET refreshed_at = refreshed_at - interval '1 minute';",
        )
        .await
        .unwrap();
    let reuse = refresh(&app, &r1).await;
    assert_eq!(reuse.status, StatusCode::BAD_REQUEST);
    assert_eq!(reuse.body["code"], "invalid_grant");
    assert_eq!(refresh(&app, &r2).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn pruning_removes_expired_tokens_and_dead_sessions() {
    let app = TestApp::spawn().await;
    let live = signup(&app, "live@example.com", "strong-pass-123")
        .await
        .body;
    let expired = login(&app, "live@example.com", "strong-pass-123")
        .await
        .body;
    let logged_out = login(&app, "live@example.com", "strong-pass-123")
        .await
        .body;
    let recent_logout = login(&app, "live@example.com", "strong-pass-123")
        .await
        .body;
    let session = |body: &Value| {
        let payload = str_field(body, "access_token").split('.').nth(1).unwrap();
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .unwrap();
        let claims: Value = serde_json::from_slice(&bytes).unwrap();
        Uuid::parse_str(claims["session_id"].as_str().unwrap()).unwrap()
    };
    let (live_id, expired_id, old_id, recent_id) = (
        session(&live),
        session(&expired),
        session(&logged_out),
        session(&recent_logout),
    );
    // Rotate once so the live session also holds a revoked (unexpired) token.
    let rotated = refresh(&app, str_field(&live, "refresh_token")).await;
    assert_eq!(rotated.status, StatusCode::OK);
    app.admin_client
        .execute(
            "UPDATE auth.refresh_tokens SET expires_at = now() - interval '1 second'
             WHERE session_id = $1",
            &[&expired_id],
        )
        .await
        .unwrap();
    app.admin_client
        .execute(
            "UPDATE auth.sessions SET revoked_at = now() - interval '8 days' WHERE id = $1",
            &[&old_id],
        )
        .await
        .unwrap();
    app.admin_client
        .execute(
            "UPDATE auth.sessions SET revoked_at = now() WHERE id = $1",
            &[&recent_id],
        )
        .await
        .unwrap();

    let pruned = nelcota_auth::prune(&app.pool).await.unwrap();
    // The expired session's token, then that session and the old logout
    // (with its token, by cascade).
    assert_eq!(pruned.refresh_tokens, 1);
    assert_eq!(pruned.sessions, 2);
    let left: Vec<Uuid> = app
        .admin_client
        .query("SELECT id FROM auth.sessions ORDER BY created_at", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(left, [live_id, recent_id]);
    let live_tokens: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM auth.refresh_tokens WHERE session_id = $1",
            &[&live_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        live_tokens, 2,
        "the rotated token stays for reuse detection"
    );
    let again = refresh(&app, str_field(&rotated.body, "refresh_token")).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(
        nelcota_auth::prune(&app.pool).await.unwrap(),
        nelcota_auth::Pruned::default()
    );
}

async fn update_user(app: &TestApp, access_token: &str, body: Value) -> Reply {
    app.request(
        axum::http::Method::PUT,
        "/auth/v1/user",
        Some(access_token),
        Some(body),
    )
    .await
}

#[tokio::test]
async fn signed_in_user_updates_metadata_and_password() {
    let app = TestApp::spawn().await;
    let first = signup(&app, "upd@example.com", "strong-pass-123")
        .await
        .body;
    let access = str_field(&first, "access_token").to_owned();
    let other = login(&app, "upd@example.com", "strong-pass-123").await.body;

    // Metadata: merged one level deep; null removes a key.
    let reply = update_user(
        &app,
        &access,
        json!({ "data": { "name": "Ana", "tmp": 1 } }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        reply.body["user_metadata"],
        json!({ "name": "Ana", "tmp": 1 })
    );
    let reply = update_user(
        &app,
        &access,
        json!({ "data": { "tmp": null, "plan": "pro" } }),
    )
    .await;
    assert_eq!(
        reply.body["user_metadata"],
        json!({ "name": "Ana", "plan": "pro" })
    );
    assert_eq!(reply.body["email"], "upd@example.com");

    // Invalid requests.
    for (body, status, code) in [
        (
            json!({}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
        (
            json!({ "data": [1] }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
        (
            json!({ "password": "new-pass-456" }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
        (
            json!({ "password": "new-pass-456", "current_password": "wrong-pass-000" }),
            StatusCode::BAD_REQUEST,
            "invalid_grant",
        ),
        (
            json!({ "password": "short", "current_password": "strong-pass-123" }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "weak_password",
        ),
    ] {
        let reply = update_user(&app, &access, body.clone()).await;
        assert_eq!(reply.status, status, "{body}: {}", reply.body);
        assert_eq!(reply.body["code"], code, "{body}");
    }
    let anon = app
        .request(
            axum::http::Method::PUT,
            "/auth/v1/user",
            None,
            Some(json!({ "data": {} })),
        )
        .await;
    assert_eq!(anon.status, StatusCode::UNAUTHORIZED);

    // Password: the other session ends, this one continues.
    let reply = update_user(
        &app,
        &access,
        json!({ "password": "new-pass-456", "current_password": "strong-pass-123" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        login(&app, "upd@example.com", "strong-pass-123")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        refresh(&app, str_field(&other, "refresh_token"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let rotated = refresh(&app, str_field(&first, "refresh_token")).await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.body);
    let fresh = login(&app, "upd@example.com", "new-pass-456").await;
    assert_eq!(fresh.status, StatusCode::OK);

    // An access token of an ended session can no longer change the account.
    let ended = str_field(&other, "access_token");
    let reply = update_user(&app, ended, json!({ "data": { "x": 1 } })).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);

    // An account without a password (magic link, provider) can set one.
    app.admin_client
        .execute(
            "UPDATE auth.users SET encrypted_password = NULL WHERE email = 'upd@example.com'",
            &[],
        )
        .await
        .unwrap();
    let reply = update_user(&app, &access, json!({ "password": "third-pass-789" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        login(&app, "upd@example.com", "third-pass-789")
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn logout_ends_the_session() {
    let app = TestApp::spawn().await;
    let session = signup(&app, "gabi@example.com", "strong-pass-123")
        .await
        .body;
    let access = str_field(&session, "access_token");

    let reply = app.post("/auth/v1/logout", Some(access), json!({})).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(
        refresh(&app, str_field(&session, "refresh_token"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // Logout requires a user JWT.
    let reply = app.post("/auth/v1/logout", None, json!({})).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let reply = app
        .post("/auth/v1/logout", Some(&service_token()), json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn jwks_allows_validating_tokens_outside_nelcota() {
    let app = TestApp::spawn().await;
    let session = signup(&app, "hugo@example.com", "strong-pass-123")
        .await
        .body;

    let reply = app
        .request(
            axum::http::Method::GET,
            "/auth/v1/.well-known/jwks.json",
            None,
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.headers.contains_key(header::CACHE_CONTROL));
    let jwks: JwkSet = serde_json::from_value(reply.body).unwrap();
    assert_eq!(jwks.keys.len(), 1);

    // An external service validates the token with the public key alone.
    let key = DecodingKey::from_jwk(&jwks.keys[0]).unwrap();
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_audience(&["authenticated"]);
    validation.set_issuer(&["nelcota-test"]);
    let data =
        jsonwebtoken::decode::<Value>(str_field(&session, "access_token"), &key, &validation)
            .unwrap();
    assert_eq!(data.claims["role"], "authenticated");
    assert_eq!(data.claims["email"], "hugo@example.com");
    assert!(data.claims["session_id"].is_string());
}

#[tokio::test]
async fn rate_limit_on_login() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 3,
        ..Options::default()
    })
    .await;
    for _ in 0..3 {
        let reply = login(&app, "ivo@example.com", "wrong-pass-000").await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }
    let blocked = login(&app, "ivo@example.com", "wrong-pass-000").await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers.contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn refresh_has_its_own_rate_limit_budget() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 3,
        ..Options::default()
    })
    .await;
    let session = signup(&app, "tabs@example.com", "strong-pass-123")
        .await
        .body;
    // More refreshes than the password budget allows...
    let mut token = str_field(&session, "refresh_token").to_owned();
    for _ in 0..5 {
        let reply = refresh(&app, &token).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        token = str_field(&reply.body, "refresh_token").to_owned();
    }
    // ...leave password sign-in untouched, and the reverse.
    for _ in 0..3 {
        let reply = login(&app, "tabs@example.com", "strong-pass-123").await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    }
    let blocked = login(&app, "tabs@example.com", "strong-pass-123").await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(refresh(&app, &token).await.status, StatusCode::OK);
}

/// The `auth.*` tables are not accessible to the API roles.
#[tokio::test]
async fn api_roles_cannot_read_the_auth_schema() {
    let app = TestApp::spawn().await;
    signup(&app, "julia@example.com", "strong-pass-123").await;

    for payload in [
        json!({ "role": "anon" }),
        json!({ "role": "authenticated", "sub": app.user_a }),
        json!({ "role": "service_role" }),
    ] {
        let claims = Claims::from_payload(payload.clone()).unwrap();
        for query in [
            "SELECT encrypted_password FROM auth.users",
            "SELECT token_hash FROM auth.one_time_tokens",
        ] {
            // One transaction per query: the error aborts the whole transaction.
            let mut client = app.pool.get().await.unwrap();
            let tx = db::begin_request(&mut client, &claims).await.unwrap();
            let err = tx.query(query, &[]).await.unwrap_err();
            assert_eq!(
                err.code(),
                Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE),
                "{payload}: {query}"
            );
        }
    }

    // And no JWT can assume the internal auth role.
    let (status, _) = app
        .get(
            "/rest/v1/todos",
            Some(&token(json!({ "role": "nelcota_auth" }))),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------- password recovery

async fn recover(app: &TestApp, email: &str) -> Reply {
    app.post("/auth/v1/recover", None, json!({ "email": email }))
        .await
}

async fn verify(app: &TestApp, token: &str, password: &str) -> Reply {
    app.post(
        "/auth/v1/verify",
        None,
        json!({ "type": "recovery", "token": token, "password": password }),
    )
    .await
}

fn recovery_token(email: &nelcota_auth::Email) -> String {
    link_token(email, RECOVERY_URL, "recovery")
}

#[tokio::test]
async fn password_recovery_changes_the_password_and_ends_sessions() {
    let app = TestApp::spawn().await;
    let old = signup(&app, "ana@example.com", "old-pass-123").await.body;
    let old_refresh = str_field(&old, "refresh_token").to_owned();
    assert!(old["user"]["email_confirmed_at"].is_null());

    let reply = recover(&app, "Ana@Example.com").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body, json!({}));
    let sent = app.outbox.wait_for(1).await;
    assert_eq!(sent[0].to, "ana@example.com");
    let token = recovery_token(&sent[0]);

    // Only the token's SHA-256 is stored in the database.
    let row = app
        .admin_client
        .query_one(
            "SELECT count(*) FILTER (WHERE token_hash = sha256($1::text::bytea)),
                    count(*) FILTER (WHERE position($1::text::bytea IN token_hash) > 0)
             FROM auth.one_time_tokens",
            &[&token],
        )
        .await
        .unwrap();
    assert_eq!((row.get::<_, i64>(0), row.get::<_, i64>(1)), (1, 0));

    let reply = verify(&app, &token, "new-pass-456").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["user"]["email"], "ana@example.com");
    // Opening the link proves the person receives the account's emails.
    assert!(reply.body["user"]["email_confirmed_at"].is_string());
    assert!(reply.body["access_token"].is_string());

    assert_eq!(
        login(&app, "ana@example.com", "old-pass-123").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        login(&app, "ana@example.com", "new-pass-456").await.status,
        StatusCode::OK
    );
    // The session opened with the old password was ended.
    let reply = refresh(&app, &old_refresh).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_grant");

    // The link works only once.
    let reply = verify(&app, &token, "other-pass-789").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_grant");
}

#[tokio::test]
async fn concurrent_recovery_submissions_consume_the_link_once() {
    let app = TestApp::spawn().await;
    signup(&app, "concurrent@example.com", "old-password-123").await;
    recover(&app, "concurrent@example.com").await;
    let sent = app.outbox.wait_for(1).await;
    let token = recovery_token(&sent[0]);
    let (first, second) = tokio::join!(
        verify(&app, &token, "first-password-123"),
        verify(&app, &token, "second-password-123")
    );
    let (winner, loser, password) = match first.status == StatusCode::OK {
        true => (first, second, "first-password-123"),
        false => (second, first, "second-password-123"),
    };
    assert_eq!(winner.status, StatusCode::OK);
    assert_eq!(loser.status, StatusCode::BAD_REQUEST);
    assert_eq!(loser.body["code"], "invalid_grant");
    assert_eq!(
        login(&app, "concurrent@example.com", password).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn recovery_does_not_reveal_whether_the_account_exists() {
    let app = TestApp::spawn().await;
    signup(&app, "bia@example.com", "strong-pass-123").await;

    let existing = recover(&app, "bia@example.com").await;
    let missing = recover(&app, "nobody@example.com").await;
    assert_eq!(
        (existing.status, &existing.body),
        (missing.status, &missing.body)
    );
    app.outbox.wait_for(1).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(
        app.outbox.sent().len(),
        1,
        "only the existing account receives it"
    );

    let reply = recover(&app, "not an email").await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn recovery_sends_one_email_per_minute_and_only_the_last_link_works() {
    let app = TestApp::spawn().await;
    signup(&app, "caio@example.com", "strong-pass-123").await;

    recover(&app, "caio@example.com").await;
    let first = recovery_token(&app.outbox.wait_for(1).await[0]);
    // A repeated request right away: same response, no new email.
    assert_eq!(
        recover(&app, "caio@example.com").await.status,
        StatusCode::OK
    );
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(app.outbox.sent().len(), 1);

    // After the interval, a new request sends another link and voids the previous one.
    app.admin_client
        .execute(
            "UPDATE auth.one_time_tokens SET created_at = now() - interval '2 minutes'",
            &[],
        )
        .await
        .unwrap();
    recover(&app, "caio@example.com").await;
    let second = recovery_token(&app.outbox.wait_for(2).await[1]);
    assert_ne!(first, second);
    assert_eq!(
        verify(&app, &first, "new-pass-456").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        verify(&app, &second, "new-pass-456").await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn expired_or_invalid_link_or_weak_password() {
    let app = TestApp::spawn().await;
    signup(&app, "davi@example.com", "strong-pass-123").await;
    recover(&app, "davi@example.com").await;
    let token = recovery_token(&app.outbox.wait_for(1).await[0]);

    // A password breaking the rules does not consume the link.
    let reply = verify(&app, &token, "short").await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "weak_password");

    for bad in ["", "made-up-token", &"x".repeat(200)] {
        let reply = verify(&app, bad, "new-pass-456").await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let reply = app
        .post(
            "/auth/v1/verify",
            None,
            json!({ "type": "email", "token": token, "password": "new-pass-456" }),
        )
        .await;
    assert_eq!(reply.body["code"], "unsupported_type");
    // A recovery link does not work as another kind of link.
    let reply = app
        .post(
            "/auth/v1/verify",
            None,
            json!({ "type": "magiclink", "token": token }),
        )
        .await;
    assert_eq!(reply.body["code"], "invalid_grant");

    app.admin_client
        .execute(
            "UPDATE auth.one_time_tokens SET expires_at = now() - interval '1 second'",
            &[],
        )
        .await
        .unwrap();
    let reply = verify(&app, &token, "new-pass-456").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        login(&app, "davi@example.com", "strong-pass-123")
            .await
            .status,
        StatusCode::OK,
        "the old password still works"
    );
}

#[tokio::test]
async fn recovery_disabled_without_smtp() {
    let app = TestApp::spawn_with(Options {
        mail: false,
        ..Options::default()
    })
    .await;
    signup(&app, "eva@example.com", "strong-pass-123").await;
    let reply = recover(&app, "eva@example.com").await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.body["code"], "recovery_disabled");
}

// ---------------------------------------------------------------- signup confirmation

async fn spawn_confirming() -> TestApp {
    TestApp::spawn_with(Options {
        confirm_email: true,
        ..Options::default()
    })
    .await
}

async fn verify_link(app: &TestApp, kind: &str, token: &str) -> Reply {
    app.post(
        "/auth/v1/verify",
        None,
        json!({ "type": kind, "token": token }),
    )
    .await
}

async fn resend(app: &TestApp, email: &str) -> Reply {
    app.post(
        "/auth/v1/resend",
        None,
        json!({ "type": "signup", "email": email }),
    )
    .await
}

/// Lets the next link of any kind go out (past the per-account cooldown).
async fn age_links(app: &TestApp) {
    app.admin_client
        .execute(
            "UPDATE auth.one_time_tokens SET created_at = now() - interval '2 minutes'",
            &[],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn review_link_requests_do_not_wait_for_account_lookup_or_issuance() {
    let app = spawn_confirming().await;
    signup(&app, "link-timing@example.com", "strong-password-123").await;
    app.outbox.wait_for(1).await;
    app.admin_client
        .batch_execute("BEGIN; LOCK TABLE auth.users IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let replies = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        tokio::join!(
            recover(&app, "link-timing@example.com"),
            magic_link(&app, "link-timing@example.com"),
            resend(&app, "link-timing@example.com"),
            recover(&app, "missing@example.com")
        )
    })
    .await;
    app.admin_client.batch_execute("ROLLBACK").await.unwrap();
    let (recovery, magic, confirmation, missing) =
        replies.expect("public link endpoints must respond before account work");
    for reply in [recovery, magic, confirmation, missing] {
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    }
    app.outbox.wait_for(3).await;
}

#[tokio::test]
async fn signup_with_confirmation_waits_for_the_link_before_password_login() {
    let app = spawn_confirming().await;
    let reply = signup(&app, "fabi@example.com", "strong-pass-123").await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert!(reply.body.get("access_token").is_none(), "no session yet");
    assert_eq!(reply.body["user"]["email"], "fabi@example.com");
    assert!(reply.body["user"]["email_confirmed_at"].is_null());

    let sent = app.outbox.wait_for(1).await;
    assert_eq!(sent[0].to, "fabi@example.com");
    assert_eq!(sent[0].subject, "Confirm your email");
    let token = link_token(&sent[0], CONFIRMATION_URL, "signup");

    let reply = login(&app, "fabi@example.com", "strong-pass-123").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "email_not_confirmed");
    // A wrong password still gets the generic answer: nothing is revealed.
    let reply = login(&app, "fabi@example.com", "wrong-pass-123").await;
    assert_eq!(reply.body["code"], "invalid_grant");

    let reply = verify_link(&app, "signup", &token).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert!(reply.body["access_token"].is_string());
    assert!(reply.body["user"]["email_confirmed_at"].is_string());
    assert_eq!(
        login(&app, "fabi@example.com", "strong-pass-123")
            .await
            .status,
        StatusCode::OK
    );
    // The link works only once.
    let reply = verify_link(&app, "signup", &token).await;
    assert_eq!(reply.body["code"], "invalid_grant");
}

#[tokio::test]
async fn confirmation_can_be_resent_only_to_unconfirmed_accounts() {
    let app = spawn_confirming().await;
    signup(&app, "gil@example.com", "strong-pass-123").await;
    let first = link_token(&app.outbox.wait_for(1).await[0], CONFIRMATION_URL, "signup");

    // Within the cooldown, and for unknown accounts: same answer, no email.
    assert_eq!(resend(&app, "gil@example.com").await.status, StatusCode::OK);
    let missing = resend(&app, "nobody@example.com").await;
    assert_eq!(
        (missing.status, &missing.body),
        (StatusCode::OK, &json!({}))
    );
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(app.outbox.sent().len(), 1);

    age_links(&app).await;
    resend(&app, "Gil@Example.com").await;
    let second = link_token(&app.outbox.wait_for(2).await[1], CONFIRMATION_URL, "signup");
    assert_eq!(
        verify_link(&app, "signup", &first).await.body["code"],
        "invalid_grant",
        "a new link voids the previous one"
    );
    assert_eq!(
        verify_link(&app, "signup", &second).await.status,
        StatusCode::OK
    );

    // Confirmed accounts get nothing more.
    age_links(&app).await;
    resend(&app, "gil@example.com").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(app.outbox.sent().len(), 2);

    let reply = app
        .post(
            "/auth/v1/resend",
            None,
            json!({ "type": "recovery", "email": "gil@example.com" }),
        )
        .await;
    assert_eq!(reply.body["code"], "unsupported_type");
}

#[tokio::test]
async fn without_a_confirmation_page_signup_signs_in_and_resend_is_off() {
    let app = TestApp::spawn().await;
    let reply = signup(&app, "hana@example.com", "strong-pass-123").await;
    assert!(reply.body["access_token"].is_string());
    let reply = resend(&app, "hana@example.com").await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.body["code"], "confirmation_disabled");
}

// ---------------------------------------------------------------- magic link

async fn magic_link(app: &TestApp, email: &str) -> Reply {
    app.post("/auth/v1/magiclink", None, json!({ "email": email }))
        .await
}

#[tokio::test]
async fn magic_link_signs_in_existing_accounts_and_confirms_the_email() {
    let app = spawn_confirming().await;
    signup(&app, "ivo@example.com", "strong-pass-123").await;
    app.outbox.wait_for(1).await;

    let existing = magic_link(&app, "IVO@example.com").await;
    let missing = magic_link(&app, "nobody@example.com").await;
    assert_eq!(existing.status, StatusCode::OK, "{}", existing.body);
    assert_eq!(
        (existing.status, &existing.body),
        (missing.status, &missing.body)
    );
    let sent = app.outbox.wait_for(2).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(
        app.outbox.sent().len(),
        2,
        "only the existing account receives it"
    );
    assert_eq!(sent[1].subject, "Your sign-in link");
    let token = link_token(&sent[1], MAGIC_LINK_URL, "magiclink");

    // Tokens are bound to their kind; using a magic link as signup/recovery fails.
    assert_eq!(
        verify_link(&app, "signup", &token).await.body["code"],
        "invalid_grant"
    );
    let reply = app
        .post(
            "/auth/v1/verify",
            None,
            json!({ "type": "recovery", "token": token, "password": "new-pass-456" }),
        )
        .await;
    assert_eq!(reply.body["code"], "invalid_grant");

    // Opening it signs in and, as it proves the inbox, confirms the email.
    let reply = verify_link(&app, "magiclink", &token).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["user"]["email"], "ivo@example.com");
    assert!(reply.body["user"]["email_confirmed_at"].is_string());
    assert!(reply.body["access_token"].is_string());
    assert_eq!(
        login(&app, "ivo@example.com", "strong-pass-123")
            .await
            .status,
        StatusCode::BAD_REQUEST,
        "the password from the unverified signup is no longer trusted"
    );
    let password: Option<String> = app
        .admin_client
        .query_one(
            "SELECT encrypted_password FROM auth.users WHERE email = 'ivo@example.com'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(password.is_none());
    let signup_token = link_token(&sent[0], CONFIRMATION_URL, "signup");
    assert_eq!(
        verify_link(&app, "signup", &signup_token).await.body["code"],
        "invalid_grant"
    );
    assert_eq!(
        verify_link(&app, "magiclink", &token).await.body["code"],
        "invalid_grant",
        "the link works only once"
    );
}

#[tokio::test]
async fn magic_link_of_a_confirmed_account_preserves_password_and_existing_session() {
    let app = spawn_confirming().await;
    signup(&app, "confirmed@example.com", "strong-pass-123").await;
    let signup_token = link_token(&app.outbox.wait_for(1).await[0], CONFIRMATION_URL, "signup");
    let original = verify_link(&app, "signup", &signup_token).await;
    assert_eq!(original.status, StatusCode::OK);
    magic_link(&app, "confirmed@example.com").await;
    let token = link_token(
        &app.outbox.wait_for(2).await[1],
        MAGIC_LINK_URL,
        "magiclink",
    );
    assert_eq!(
        verify_link(&app, "magiclink", &token).await.status,
        StatusCode::OK
    );
    assert_eq!(
        login(&app, "confirmed@example.com", "strong-pass-123")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({"refresh_token": original.body["refresh_token"]})
        )
        .await
        .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn magic_link_claim_revokes_preverification_sessions_and_pending_links() {
    // With confirmation disabled, signup can have created sessions before the
    // first proof of inbox ownership. Those must not survive a later claim.
    let app = TestApp::spawn().await;
    let previous = signup(&app, "claimed@example.com", "attacker-pass-123").await;
    assert_eq!(previous.status, StatusCode::CREATED);
    recover(&app, "claimed@example.com").await;
    let recovery = link_token(&app.outbox.wait_for(1).await[0], RECOVERY_URL, "recovery");
    magic_link(&app, "claimed@example.com").await;
    let token = link_token(
        &app.outbox.wait_for(2).await[1],
        MAGIC_LINK_URL,
        "magiclink",
    );
    let owner = verify_link(&app, "magiclink", &token).await;
    assert_eq!(owner.status, StatusCode::OK);
    assert_eq!(owner.body["user"]["id"], previous.body["user"]["id"]);
    assert_eq!(
        login(&app, "claimed@example.com", "attacker-pass-123")
            .await
            .body["code"],
        "invalid_grant"
    );
    assert_eq!(
        app.post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({"refresh_token": previous.body["refresh_token"]})
        )
        .await
        .body["code"],
        "invalid_grant"
    );
    assert_eq!(
        verify(&app, &recovery, "attacker-pass-456").await.body["code"],
        "invalid_grant"
    );
    assert_eq!(
        app.post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({"refresh_token": owner.body["refresh_token"]})
        )
        .await
        .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn magic_link_expires_and_is_off_without_smtp() {
    let app = TestApp::spawn().await;
    signup(&app, "jade@example.com", "strong-pass-123").await;
    magic_link(&app, "jade@example.com").await;
    let token = link_token(
        &app.outbox.wait_for(1).await[0],
        MAGIC_LINK_URL,
        "magiclink",
    );
    app.admin_client
        .execute(
            "UPDATE auth.one_time_tokens SET expires_at = now() - interval '1 second'",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        verify_link(&app, "magiclink", &token).await.body["code"],
        "invalid_grant"
    );

    let app = TestApp::spawn_with(Options {
        mail: false,
        ..Options::default()
    })
    .await;
    let reply = magic_link(&app, "jade@example.com").await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.body["code"], "magiclink_disabled");
}

#[tokio::test]
async fn refresh_rejects_oversized_grants_but_preserves_required_field_errors() {
    let app = TestApp::spawn().await;
    for body in [json!({}), json!({ "refresh_token": "" })] {
        let reply = app
            .post("/auth/v1/token?grant_type=refresh_token", None, body)
            .await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            reply.body
        );
        assert_eq!(reply.body["code"], "validation_failed");
    }
    for token in [
        "a".repeat(128),
        "a".repeat(129),
        "a".repeat(1024),
        "é".repeat(65),
    ] {
        let reply = refresh(&app, &token).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.body);
        assert_eq!(reply.body["code"], "invalid_grant");
    }
    let password = Uuid::new_v4().to_string();
    let first = signup(&app, "refresh-boundary@example.com", &password).await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.body);
    let rotated = refresh(&app, str_field(&first.body, "refresh_token")).await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.body);
}
