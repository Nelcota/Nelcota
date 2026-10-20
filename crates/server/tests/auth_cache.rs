//! Auth credentials and account data are never cacheable; JWKS stays public.
mod common;

use axum::http::{Method, StatusCode, header};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn private(reply: &Reply, status: StatusCode) {
    assert_eq!(reply.status, status);
    assert_eq!(
        reply
            .headers
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        reply
            .headers
            .get(header::PRAGMA)
            .and_then(|v| v.to_str().ok()),
        Some("no-cache")
    );
}

async fn signup(app: &TestApp, email: &str, password: &str) -> Value {
    let reply = app
        .post(
            "/auth/v1/signup",
            None,
            json!({
                "email": email, "password": password,
            }),
        )
        .await;
    private(&reply, StatusCode::CREATED);
    reply.body
}

#[tokio::test]
async fn session_and_account_responses_are_not_cacheable() {
    let app = TestApp::spawn().await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let password = Uuid::new_v4().to_string();
    signup(&app, &email, &password).await;
    let login = app
        .post(
            "/auth/v1/token?grant_type=password",
            None,
            json!({"email": email, "password": password}),
        )
        .await;
    private(&login, StatusCode::OK);
    let refreshed = app
        .post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({"refresh_token": login.body["refresh_token"]}),
        )
        .await;
    private(&refreshed, StatusCode::OK);
    let access = refreshed.body["access_token"].as_str();
    private(
        &app.request(Method::GET, "/auth/v1/user", access, None)
            .await,
        StatusCode::OK,
    );
    private(
        &app.request(
            Method::PUT,
            "/auth/v1/user",
            access,
            Some(json!({"data": {"review": true}})),
        )
        .await,
        StatusCode::OK,
    );
    private(
        &app.post("/auth/v1/logout", access, json!({})).await,
        StatusCode::NO_CONTENT,
    );
}

#[tokio::test]
async fn email_link_sessions_are_not_cacheable() {
    let app = TestApp::spawn_with(Options {
        confirm_email: true,
        ..Options::default()
    })
    .await;
    for (kind, page, endpoint) in [
        ("signup", CONFIRMATION_URL, "/auth/v1/resend"),
        ("magiclink", MAGIC_LINK_URL, "/auth/v1/magiclink"),
        ("recovery", RECOVERY_URL, "/auth/v1/recover"),
    ] {
        let email = format!("{}@example.test", Uuid::new_v4().simple());
        let start = app.outbox.sent().len();
        signup(&app, &email, &Uuid::new_v4().to_string()).await;
        app.outbox.wait_for(start + 1).await;
        private(
            &app.post(endpoint, None, json!({"email": email, "type": "signup"}))
                .await,
            StatusCode::OK,
        );
        let count = start + 1 + usize::from(kind != "signup");
        let mail = app.outbox.wait_for(count).await;
        let token = link_token(&mail[count - 1], page, kind);
        let reply = app
            .post(
                "/auth/v1/verify",
                None,
                json!({
                    "type": kind, "token": token, "password": Uuid::new_v4().to_string(),
                }),
            )
            .await;
        private(&reply, StatusCode::OK);
        assert!(reply.body["access_token"].is_string());
    }
}

#[tokio::test]
async fn pkce_session_and_rejected_redemption_are_not_cacheable() {
    let app = TestApp::spawn().await;
    let session = signup(
        &app,
        &format!("{}@example.test", Uuid::new_v4().simple()),
        &Uuid::new_v4().to_string(),
    )
    .await;
    let code = Uuid::new_v4().to_string();
    let verifier = URL_SAFE_NO_PAD.encode(Sha256::digest(Uuid::new_v4().as_bytes()));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    let code_hash = Sha256::digest(code.as_bytes()).to_vec();
    let id = session["user"]["id"].as_str().unwrap();
    app.admin_client
        .execute(
            "INSERT INTO auth.flow_states (state_hash, provider, provider_verifier,
             code_challenge, redirect_to, auth_code_hash, user_id, expires_at)
         VALUES ($1, 'github', '', $2, 'https://app.example.test/auth', $3,
             $4::text::uuid, now() + interval '5 minutes')",
            &[&state, &challenge, &code_hash, &id],
        )
        .await
        .unwrap();
    let body = json!({"auth_code": code, "code_verifier": verifier});
    private(
        &app.post("/auth/v1/token?grant_type=pkce", None, body.clone())
            .await,
        StatusCode::OK,
    );
    private(
        &app.post("/auth/v1/token?grant_type=pkce", None, body).await,
        StatusCode::BAD_REQUEST,
    );
}

#[tokio::test]
async fn auth_errors_are_private_but_public_keys_keep_their_cache_policy() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 1,
        ..Options::default()
    })
    .await;
    private(
        &app.post("/auth/v1/token?grant_type=unknown", None, json!({}))
            .await,
        StatusCode::BAD_REQUEST,
    );
    private(
        &app.request(Method::GET, "/auth/v1/user", None, None).await,
        StatusCode::UNAUTHORIZED,
    );
    private(
        &app.raw(
            Method::POST,
            "/auth/v1/signup",
            &[("content-type", "application/json")],
            "{".into(),
        )
        .await,
        StatusCode::BAD_REQUEST,
    );
    let login = json!({"email": "missing@example.test", "password": Uuid::new_v4().to_string()});
    private(
        &app.post("/auth/v1/token?grant_type=password", None, login.clone())
            .await,
        StatusCode::BAD_REQUEST,
    );
    private(
        &app.post("/auth/v1/token?grant_type=password", None, login)
            .await,
        StatusCode::TOO_MANY_REQUESTS,
    );
    let jwks = app
        .request(Method::GET, "/auth/v1/.well-known/jwks.json", None, None)
        .await;
    assert_eq!(jwks.status, StatusCode::OK);
    assert_eq!(jwks.headers[header::CACHE_CONTROL], "public, max-age=300");
    assert!(!jwks.headers.contains_key(header::PRAGMA));
}

#[tokio::test]
async fn oauth_redirects_are_not_cacheable() {
    let oauth = nelcota_auth::OAuth::new(
        "https://api.example.test",
        ["https://app.example.test/auth"],
        vec![nelcota_auth::Provider::github(
            "fixture",
            Uuid::new_v4().to_string(),
        )],
    )
    .unwrap();
    let app = TestApp::spawn_with(Options {
        oauth: Some(std::sync::Arc::new(oauth)),
        ..Options::default()
    })
    .await;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(Uuid::new_v4().as_bytes()));
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("provider", "github")
        .append_pair("redirect_to", "https://app.example.test/auth")
        .append_pair("code_challenge", &challenge)
        .finish();
    let redirect = app
        .request(
            Method::GET,
            &format!("/auth/v1/authorize?{query}"),
            None,
            None,
        )
        .await;
    private(&redirect, StatusCode::SEE_OTHER);
    // No provider request is needed: declining returns through a trusted state.
    let location = url::Url::parse(redirect.headers[header::LOCATION].to_str().unwrap()).unwrap();
    let state = location
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = app
        .request(
            Method::GET,
            &format!("/auth/v1/callback?state={state}&error=access_denied"),
            None,
            None,
        )
        .await;
    private(&callback, StatusCode::SEE_OTHER);
}
