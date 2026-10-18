//! Sign-in through an external provider against a real Postgres, with a local
//! fake of GitHub's endpoints: PKCE on both legs, the redirect allowlist,
//! account linking and takeover rules, and single-use codes.

mod common;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    Form, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::*;
use nelcota_auth::{OAuth, Provider, ProviderEndpoints};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const APP: &str = "https://app.example.com/auth";
const AUTHORIZE: &str = "https://github.example/login/oauth/authorize";
const VERIFIER: &str = "app-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";

#[tokio::test]
async fn rust_sdk_finishes_a_real_pkce_flow() {
    let harness = Harness::spawn().await;
    harness.account(9900, Some("rust-oauth@example.com"), true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = harness.app.router.clone();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = nelcota_client::Client::builder(url).build().unwrap();
    let flow = client
        .auth()
        .begin_oauth(nelcota_client::auth::OAuthProvider::Github, APP)
        .unwrap();
    let reply = harness
        .app
        .raw(
            axum::http::Method::GET,
            &format!("{}?{}", flow.url.path(), flow.url.query().unwrap()),
            &[],
            String::new(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::SEE_OTHER);
    let state = query_of(&location(&reply))["state"].clone();
    let reply = harness
        .callback(&format!("code=good-code&state={state}"))
        .await;
    assert_eq!(reply.status, StatusCode::SEE_OTHER);
    let mut callback = url::Url::parse(&location(&reply)).unwrap();
    let session = client
        .auth()
        .handle_redirect(&mut callback, flow)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.user.email, "rust-oauth@example.com");
    assert!(
        !callback
            .query_pairs()
            .any(|(k, _)| k == "code" || k == "error")
    );
    assert_eq!(client.auth().get_user().await.unwrap().id, session.user.id);
    task.abort();
}

/// What the fake provider answers and what it was sent.
#[derive(Default)]
struct Fake {
    profile: Value,
    emails: Value,
    token_requests: Vec<HashMap<String, String>>,
    /// How long the code exchange takes (to overlap concurrent callbacks).
    token_delay: std::time::Duration,
    token_gate: Option<Arc<tokio::sync::Notify>>,
}

type Shared = Arc<Mutex<Fake>>;

async fn token(
    State(fake): State<Shared>,
    Form(form): Form<HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    let good = form.get("code").map(String::as_str) == Some("good-code");
    let (delay, gate) = {
        let mut fake = fake.lock().unwrap();
        fake.token_requests.push(form);
        (fake.token_delay, fake.token_gate.clone())
    };
    if let Some(gate) = gate {
        gate.notified().await;
    }
    tokio::time::sleep(delay).await;
    if good {
        return (
            StatusCode::OK,
            Json(json!({ "access_token": "provider-token", "token_type": "bearer" })),
        );
    }
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "bad_verification_code" })),
    )
}

fn authorized(headers: &HeaderMap) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer provider-token")
}

async fn user(State(fake): State<Shared>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({})));
    }
    (StatusCode::OK, Json(fake.lock().unwrap().profile.clone()))
}

async fn emails(State(fake): State<Shared>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!([])));
    }
    (StatusCode::OK, Json(fake.lock().unwrap().emails.clone()))
}

struct Harness {
    app: TestApp,
    fake: Shared,
}

impl Harness {
    async fn spawn() -> Self {
        Self::spawn_with(Options::default()).await
    }

    async fn spawn_with(options: Options) -> Self {
        let fake: Shared = Arc::default();
        let router = Router::new()
            .route("/token", post(token))
            .route("/user", get(user))
            .route("/emails", get(emails))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let provider =
            Provider::github("client-1", "client-secret-1").with_endpoints(ProviderEndpoints {
                authorize: AUTHORIZE.into(),
                token: format!("{base}/token"),
                profile: format!("{base}/user"),
                emails: Some(format!("{base}/emails")),
            });
        let oauth = OAuth::new("https://api.example.com/", [APP], vec![provider]).unwrap();
        let app = TestApp::spawn_with(Options {
            oauth: Some(Arc::new(oauth)),
            ..options
        })
        .await;
        Harness { app, fake }
    }

    /// The account the provider reports for the next sign-in.
    fn account(&self, id: u64, email: Option<&str>, verified: bool) {
        let mut fake = self.fake.lock().unwrap();
        fake.profile = json!({ "id": id, "login": format!("user{id}"), "name": "Octo Cat", "avatar_url": "https://avatars.example/1" });
        fake.emails = match email {
            Some(email) => json!([{ "email": email, "primary": true, "verified": verified }]),
            None => json!([]),
        };
    }

    /// `/authorize` with the app's challenge; returns the provider URL.
    async fn authorize(&self, redirect_to: &str) -> Reply {
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("provider", "github")
            .append_pair("redirect_to", redirect_to)
            .append_pair("code_challenge", &challenge(VERIFIER))
            .append_pair("code_challenge_method", "S256")
            .finish();
        self.app
            .raw(
                axum::http::Method::GET,
                &format!("/auth/v1/authorize?{query}"),
                &[],
                String::new(),
            )
            .await
    }

    async fn callback(&self, query: &str) -> Reply {
        self.app
            .raw(
                axum::http::Method::GET,
                &format!("/auth/v1/callback?{query}"),
                &[],
                String::new(),
            )
            .await
    }

    /// Up to the provider's callback; returns where the app was sent.
    async fn sign_in(&self) -> HashMap<String, String> {
        let reply = self.authorize(APP).await;
        assert_eq!(reply.status, StatusCode::SEE_OTHER, "{}", reply.text);
        let state = &query_of(&location(&reply))["state"];
        let reply = self
            .callback(&format!("code=good-code&state={state}"))
            .await;
        assert_eq!(reply.status, StatusCode::SEE_OTHER, "{}", reply.text);
        let back = location(&reply);
        assert!(back.starts_with(&format!("{APP}?")), "{back}");
        query_of(&back)
    }

    async fn redeem(&self, code: &str, verifier: &str) -> Reply {
        self.app
            .post(
                "/auth/v1/token?grant_type=pkce",
                None,
                json!({ "auth_code": code, "code_verifier": verifier }),
            )
            .await
    }

    /// A full sign-in that must succeed; returns the session.
    async fn session(&self) -> Value {
        let back = self.sign_in().await;
        let code = back
            .get("code")
            .unwrap_or_else(|| panic!("no code: {back:?}"));
        let reply = self.redeem(code, VERIFIER).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.body
    }
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn location(reply: &Reply) -> String {
    reply.headers["location"].to_str().unwrap().to_owned()
}

fn query_of(url: &str) -> HashMap<String, String> {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or_default();
    form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

async fn password_login(app: &TestApp, email: &str, password: &str) -> Reply {
    app.post(
        "/auth/v1/token?grant_type=password",
        None,
        json!({ "email": email, "password": password }),
    )
    .await
}

#[tokio::test]
async fn new_account_signs_in_with_pkce_on_both_legs() {
    let h = Harness::spawn().await;
    h.account(42, Some("Octo@Example.com"), true);

    let reply = h.authorize(APP).await;
    let provider_url = location(&reply);
    assert!(provider_url.starts_with(&format!("{AUTHORIZE}?")));
    let sent = query_of(&provider_url);
    assert_eq!(sent["client_id"], "client-1");
    assert_eq!(
        sent["redirect_uri"],
        "https://api.example.com/auth/v1/callback"
    );
    assert_eq!(sent["code_challenge_method"], "S256");
    assert_ne!(sent["code_challenge"], challenge(VERIFIER), "its own PKCE");

    let reply = h
        .callback(&format!("code=good-code&state={}", sent["state"]))
        .await;
    let back = query_of(&location(&reply));
    // Nelcota redeemed the provider's code with the verifier behind its challenge.
    let exchange = h.fake.lock().unwrap().token_requests[0].clone();
    assert_eq!(exchange["client_secret"], "client-secret-1");
    assert_eq!(
        challenge(&exchange["code_verifier"]),
        sent["code_challenge"]
    );

    let session = h.redeem(&back["code"], VERIFIER).await;
    assert_eq!(session.status, StatusCode::OK, "{}", session.text);
    let user = &session.body["user"];
    assert_eq!(user["email"], "octo@example.com");
    assert!(user["email_confirmed_at"].is_string(), "verified by GitHub");
    assert_eq!(user["user_metadata"]["name"], "Octo Cat");

    let row = h
        .app
        .admin_client
        .query_one(
            "SELECT u.encrypted_password IS NULL, i.provider, i.provider_id
               FROM auth.users u JOIN auth.identities i ON i.user_id = u.id",
            &[],
        )
        .await
        .unwrap();
    assert!(row.get::<_, bool>(0), "no password for a provider account");
    assert_eq!(row.get::<_, String>(1), "github");
    assert_eq!(row.get::<_, String>(2), "42");

    // The provider account id identifies the person, even after an email change.
    h.account(42, Some("renamed@example.com"), true);
    let again = h.session().await;
    assert_eq!(again["user"]["id"], user["id"]);
}

#[tokio::test]
async fn the_app_code_needs_its_verifier_and_works_once() {
    let h = Harness::spawn().await;
    h.account(7, Some("seven@example.com"), true);
    let back = h.sign_in().await;
    let code = &back["code"];

    let reply = h
        .redeem(code, "wrong-verifier-0123456789-abcdefghijklmnopqrstu")
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_grant");
    // A failed attempt spends the code: a stolen code cannot be retried.
    assert_eq!(h.redeem(code, VERIFIER).await.body["code"], "invalid_grant");

    let back = h.sign_in().await;
    assert_eq!(
        h.redeem(&back["code"], VERIFIER).await.status,
        StatusCode::OK
    );
    assert_eq!(
        h.redeem(&back["code"], VERIFIER).await.body["code"],
        "invalid_grant"
    );
    let missing = h
        .app
        .post("/auth/v1/token?grant_type=pkce", None, json!({}))
        .await;
    assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn authorize_refuses_foreign_redirects_and_weak_challenges() {
    let h = Harness::spawn().await;
    for target in [
        "https://evil.example/auth",
        "https://app.example.com/other",
        "javascript:alert(1)",
    ] {
        let reply = h.authorize(target).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{target}");
        assert_eq!(reply.body["code"], "redirect_not_allowed");
    }
    let path = format!(
        "/auth/v1/authorize?provider=github&redirect_to={APP}&code_challenge={VERIFIER}&code_challenge_method=plain"
    );
    let reply = h
        .app
        .raw(axum::http::Method::GET, &path, &[], String::new())
        .await;
    assert_eq!(reply.body["code"], "invalid_code_challenge");
    let path = format!(
        "/auth/v1/authorize?provider=google&redirect_to={APP}&code_challenge={}",
        challenge(VERIFIER)
    );
    let reply = h
        .app
        .raw(axum::http::Method::GET, &path, &[], String::new())
        .await;
    assert_eq!(
        reply.status,
        StatusCode::FORBIDDEN,
        "google is not configured"
    );
    assert_eq!(reply.body["code"], "provider_disabled");

    let plain = TestApp::spawn().await;
    let reply = plain
        .raw(axum::http::Method::GET, &path, &[], String::new())
        .await;
    assert_eq!(reply.body["code"], "provider_disabled");
}

#[tokio::test]
async fn callbacks_without_a_live_sign_in_go_nowhere() {
    let h = Harness::spawn().await;
    h.account(9, Some("nine@example.com"), true);
    let reply = h.callback("code=good-code&state=made-up").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_state");

    // A replayed callback finds its sign-in already answered.
    let reply = h.authorize(APP).await;
    let state = query_of(&location(&reply))["state"].clone();
    let first = h.callback(&format!("code=good-code&state={state}")).await;
    assert_eq!(first.status, StatusCode::SEE_OTHER);
    let replay = h.callback(&format!("code=good-code&state={state}")).await;
    assert_eq!(replay.body["code"], "invalid_state");

    // The person declined at the provider; the provider refused the code.
    for (query, error) in [
        ("error=access_denied", "access_denied"),
        ("code=bad-code", "provider_error"),
    ] {
        let reply = h.authorize(APP).await;
        let state = query_of(&location(&reply))["state"].clone();
        let reply = h.callback(&format!("{query}&state={state}")).await;
        assert_eq!(query_of(&location(&reply))["error"], error, "{query}");
        // The sign-in is over: its state does not work again.
        let again = h.callback(&format!("code=good-code&state={state}")).await;
        assert_eq!(again.body["code"], "invalid_state");
    }
}

#[tokio::test]
async fn verified_emails_link_confirmed_accounts() {
    let h = Harness::spawn().await;
    let signup = h
        .app
        .post(
            "/auth/v1/signup",
            None,
            json!({ "email": "linked@example.com", "password": "strong-password-123" }),
        )
        .await;
    let id = signup.body["user"]["id"].clone();
    h.app
        .admin_client
        .execute(
            "UPDATE auth.users SET email_confirmed_at = now() WHERE email = 'linked@example.com'",
            &[],
        )
        .await
        .unwrap();

    h.account(100, Some("linked@example.com"), true);
    let session = h.session().await;
    assert_eq!(session["user"]["id"], id);
    // The password the owner set keeps working.
    assert_eq!(
        password_login(&h.app, "linked@example.com", "strong-password-123")
            .await
            .status,
        StatusCode::OK
    );
    h.app
        .post(
            "/auth/v1/magiclink",
            None,
            json!({"email":"linked@example.com"}),
        )
        .await;
    let token = link_token(
        &h.app.outbox.wait_for(1).await[0],
        MAGIC_LINK_URL,
        "magiclink",
    );
    let reply = h
        .app
        .post(
            "/auth/v1/verify",
            None,
            json!({"type":"magiclink","token":token}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        h.session().await["user"]["id"],
        id,
        "confirmed provider links remain usable"
    );
}

#[tokio::test]
async fn magic_link_claim_invalidates_unverified_provider_identity_and_pending_code() {
    let h = Harness::spawn().await;
    h.account(700, Some("provider-victim@example.com"), false);
    let old = h.session().await;
    assert!(old["user"]["email_confirmed_at"].is_null());
    let pending = h.sign_in().await;
    h.app
        .post(
            "/auth/v1/magiclink",
            None,
            json!({"email":"provider-victim@example.com"}),
        )
        .await;
    let token = link_token(
        &h.app.outbox.wait_for(1).await[0],
        MAGIC_LINK_URL,
        "magiclink",
    );
    let owner = h
        .app
        .post(
            "/auth/v1/verify",
            None,
            json!({"type":"magiclink","token":token}),
        )
        .await;
    assert_eq!(owner.status, StatusCode::OK);
    assert_eq!(owner.body["user"]["id"], old["user"]["id"]);
    assert_eq!(
        h.redeem(&pending["code"], VERIFIER).await.body["code"],
        "invalid_grant",
        "a provider code authorized before inbox proof must not open a new session"
    );
    assert_eq!(
        h.sign_in().await.get("error").map(String::as_str),
        Some("email_conflict"),
        "the old unverified provider identity must no longer open the claimed account"
    );
    assert_eq!(
        h.app
            .post(
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token": old["refresh_token"]})
            )
            .await
            .body["code"],
        "invalid_grant"
    );
}

#[tokio::test]
async fn verified_provider_claim_invalidates_old_identity_and_code() {
    let h = Harness::spawn().await;
    h.account(710, Some("provider-claim@example.com"), false);
    let old = h.session().await;
    let pending = h.sign_in().await;
    h.account(711, Some("provider-claim@example.com"), true);
    let owner = h.session().await;
    assert_eq!(owner["user"]["id"], old["user"]["id"]);
    assert_eq!(
        h.redeem(&pending["code"], VERIFIER).await.body["code"],
        "invalid_grant"
    );
    assert_eq!(
        h.session().await["user"]["id"],
        old["user"]["id"],
        "the verified identity is retained"
    );
    h.account(710, Some("provider-claim@example.com"), false);
    assert_eq!(
        h.sign_in().await.get("error").map(String::as_str),
        Some("email_conflict")
    );
}

#[tokio::test]
async fn inbox_claim_serializes_with_pending_pkce_redemption() {
    claim_serializes_with_pending_pkce("magiclink").await;
}

#[tokio::test]
async fn recovery_claim_serializes_with_pending_pkce_redemption() {
    claim_serializes_with_pending_pkce("recovery").await;
}

async fn claim_serializes_with_pending_pkce(kind: &str) {
    let h = Arc::new(Harness::spawn().await);
    h.account(720, Some("pkce-race@example.com"), false);
    let old = h.session().await;
    let pending = h.sign_in().await;
    let code = pending["code"].clone();
    let id: uuid::Uuid = old["user"]["id"].as_str().unwrap().parse().unwrap();
    let (path, page) = match kind == "recovery" {
        true => ("/auth/v1/recover", RECOVERY_URL),
        false => ("/auth/v1/magiclink", MAGIC_LINK_URL),
    };
    h.app
        .post(path, None, json!({"email":"pkce-race@example.com"}))
        .await;
    let token = link_token(&h.app.outbox.wait_for(1).await[0], page, kind);
    let (mut locker, connection) = h.app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let lock = locker.transaction().await.unwrap();
    lock.query_one("SELECT id FROM auth.users WHERE id=$1 FOR UPDATE", &[&id])
        .await
        .unwrap();
    let owner_app = h.clone();
    let kind = kind.to_owned();
    let owner = tokio::spawn(async move {
        owner_app
            .app
            .post(
                "/auth/v1/verify",
                None,
                json!({"type":kind,"token":token,"password":"owner-password-123"}),
            )
            .await
    });
    async fn wait(h: &Harness, table: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let found: bool = h
                .app
                .admin_client
                .query_one(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
                    AND query LIKE 'SELECT u.id FROM auth.users u%' AND query LIKE $1)",
                    &[&format!("%{table}%")],
                )
                .await
                .unwrap()
                .get(0);
            if found {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "request never reached the account lock"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    wait(&h, "auth.one_time_tokens").await;
    let attacker_app = h.clone();
    let attacker = tokio::spawn(async move { attacker_app.redeem(&code, VERIFIER).await });
    wait(&h, "auth.flow_states").await;
    lock.commit().await.unwrap();
    assert_eq!(owner.await.unwrap().status, StatusCode::OK);
    let denied = attacker.await.unwrap();
    assert_eq!(denied.status, StatusCode::BAD_REQUEST, "{}", denied.text);
    assert_eq!(denied.body["code"], "invalid_grant");
    let active: i64 = h
        .app
        .admin_client
        .query_one(
            "SELECT count(*) FROM auth.sessions WHERE user_id=$1 AND revoked_at IS NULL",
            &[&id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(active, 1, "only the inbox owner's session survives");
}

#[tokio::test]
async fn recovery_claim_removes_unverified_identity_codes_and_links_but_keeps_new_password() {
    let h = Harness::spawn().await;
    h.account(730, Some("recovery-claim@example.com"), false);
    let previous = h.session().await;
    assert!(previous["user"]["email_confirmed_at"].is_null());
    let pending = h.sign_in().await;
    h.app
        .post(
            "/auth/v1/magiclink",
            None,
            json!({"email":"recovery-claim@example.com"}),
        )
        .await;
    let old_link = link_token(
        &h.app.outbox.wait_for(1).await[0],
        MAGIC_LINK_URL,
        "magiclink",
    );
    h.app
        .post(
            "/auth/v1/recover",
            None,
            json!({"email":"recovery-claim@example.com"}),
        )
        .await;
    let token = link_token(&h.app.outbox.wait_for(2).await[1], RECOVERY_URL, "recovery");
    let owner = h
        .app
        .post(
            "/auth/v1/verify",
            None,
            json!({"type":"recovery","token":token,"password":"owner-password-123"}),
        )
        .await;
    assert_eq!(owner.status, StatusCode::OK, "{}", owner.text);
    assert_eq!(owner.body["user"]["id"], previous["user"]["id"]);
    assert!(owner.body["user"]["email_confirmed_at"].is_string());
    assert_eq!(
        h.redeem(&pending["code"], VERIFIER).await.body["code"],
        "invalid_grant"
    );
    assert_eq!(
        h.sign_in().await.get("error").map(String::as_str),
        Some("email_conflict")
    );
    assert_eq!(
        h.app
            .post(
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token":previous["refresh_token"]})
            )
            .await
            .body["code"],
        "invalid_grant"
    );
    assert_eq!(
        h.app
            .post(
                "/auth/v1/verify",
                None,
                json!({"type":"magiclink","token":old_link})
            )
            .await
            .body["code"],
        "invalid_grant"
    );
    assert_eq!(
        password_login(&h.app, "recovery-claim@example.com", "owner-password-123")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        h.app
            .post(
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token":owner.body["refresh_token"]})
            )
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn recovery_of_a_confirmed_account_preserves_its_verified_provider_identity() {
    let h = Harness::spawn().await;
    h.account(740, Some("confirmed-recovery@example.com"), true);
    let previous = h.session().await;
    let pending = h.sign_in().await;
    h.app
        .post(
            "/auth/v1/recover",
            None,
            json!({"email":"confirmed-recovery@example.com"}),
        )
        .await;
    let token = link_token(&h.app.outbox.wait_for(1).await[0], RECOVERY_URL, "recovery");
    let owner = h
        .app
        .post(
            "/auth/v1/verify",
            None,
            json!({"type":"recovery","token":token,"password":"owner-password-123"}),
        )
        .await;
    assert_eq!(owner.status, StatusCode::OK, "{}", owner.text);
    assert_eq!(owner.body["user"]["id"], previous["user"]["id"]);
    assert_eq!(
        h.app
            .post(
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token":previous["refresh_token"]})
            )
            .await
            .body["code"],
        "invalid_grant"
    );
    let stale = h.redeem(&pending["code"], VERIFIER).await;
    assert_eq!(stale.status, StatusCode::BAD_REQUEST);
    assert_eq!(stale.body["code"], "invalid_grant");
    assert_eq!(h.session().await["user"]["id"], owner.body["user"]["id"]);
    assert_eq!(
        password_login(
            &h.app,
            "confirmed-recovery@example.com",
            "owner-password-123"
        )
        .await
        .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_verified_owner_takes_over_an_unconfirmed_account() {
    let h = Harness::spawn().await;
    // Someone signed up first with an address they may not own.
    let squatter = h
        .app
        .post(
            "/auth/v1/signup",
            None,
            json!({ "email": "victim@example.com", "password": "squatter-password-1" }),
        )
        .await;
    let refresh = squatter.body["refresh_token"].as_str().unwrap().to_owned();

    h.account(200, Some("victim@example.com"), true);
    let session = h.session().await;
    assert_eq!(session["user"]["id"], squatter.body["user"]["id"]);
    assert!(session["user"]["email_confirmed_at"].is_string());

    let login = password_login(&h.app, "victim@example.com", "squatter-password-1").await;
    assert_eq!(
        login.body["code"], "invalid_grant",
        "the old password is gone"
    );
    let reply = h
        .app
        .post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({ "refresh_token": refresh }),
        )
        .await;
    assert_eq!(reply.body["code"], "invalid_grant", "its sessions ended");
}

#[tokio::test]
async fn unverified_or_missing_emails_and_closed_signup_are_refused() {
    let h = Harness::spawn_with(Options {
        signup_enabled: false,
        ..Options::default()
    })
    .await;
    h.app
        .admin_client
        .execute(
            "INSERT INTO auth.users (email, email_confirmed_at) VALUES ('taken@example.com', now())",
            &[],
        )
        .await
        .unwrap();

    for (account, error) in [
        ((300, Some("taken@example.com"), false), "email_conflict"),
        ((301, None, false), "email_required"),
        ((302, Some("new@example.com"), true), "signup_disabled"),
    ] {
        let (id, email, verified) = account;
        h.account(id, email, verified);
        let back = h.sign_in().await;
        assert_eq!(back.get("error").map(String::as_str), Some(error));
        assert!(!back.contains_key("code"));
    }
    let identities: i64 = h
        .app
        .admin_client
        .query_one(
            "SELECT (SELECT count(*) FROM auth.identities) + (SELECT count(*) FROM auth.flow_states)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(identities, 0, "refused sign-ins leave nothing behind");
}

#[tokio::test]
async fn a_duplicate_callback_does_not_void_the_code_already_issued() {
    let h = Harness::spawn().await;
    h.account(500, Some("double@example.com"), true);
    h.session().await;

    // The browser loads the provider's redirect twice at the same time; a slow
    // provider makes both read the sign-in before either finishes (with two
    // pooled connections ready, so neither waits for a new one).
    tokio::join!(h.authorize(APP), h.authorize(APP));
    h.fake.lock().unwrap().token_delay = std::time::Duration::from_millis(500);
    let reply = h.authorize(APP).await;
    let state = query_of(&location(&reply))["state"].clone();
    let query = format!("code=good-code&state={state}");
    let (first, second) = tokio::join!(h.callback(&query), h.callback(&query));
    let codes: Vec<String> = [first, second]
        .iter()
        .filter(|reply| reply.status == StatusCode::SEE_OTHER)
        .filter_map(|reply| query_of(&location(reply)).get("code").cloned())
        .collect();
    assert_eq!(codes.len(), 1, "exactly one callback hands out a code");
    assert_eq!(h.redeem(&codes[0], VERIFIER).await.status, StatusCode::OK);
    assert_eq!(
        h.fake.lock().unwrap().token_requests.len(),
        2,
        "one exchange for each distinct sign-in"
    );
}

#[tokio::test]
async fn concurrent_callbacks_exchange_one_code_even_when_the_provider_fails() {
    let h = Harness::spawn().await;
    let state = query_of(&location(&h.authorize(APP).await))["state"].clone();
    h.fake.lock().unwrap().token_delay = std::time::Duration::from_millis(500);
    let query = format!("code=invalid-code&state={state}");
    let replies = futures_util::future::join_all((0..32).map(|_| h.callback(&query))).await;
    assert_eq!(h.fake.lock().unwrap().token_requests.len(), 1);
    assert_eq!(
        replies
            .iter()
            .filter(|r| r.status == StatusCode::SEE_OTHER)
            .count(),
        1
    );
    assert_eq!(
        replies
            .iter()
            .filter(|r| r.status == StatusCode::BAD_REQUEST)
            .count(),
        31
    );
    assert_eq!(h.callback(&query).await.status, StatusCode::BAD_REQUEST);

    // A failed exchange cannot be retried; a fresh authorize can succeed.
    h.account(9921, Some("restart@example.com"), true);
    let redirect = h.sign_in().await;
    assert_eq!(
        h.redeem(&redirect["code"], VERIFIER).await.status,
        StatusCode::OK
    );
    assert_eq!(h.fake.lock().unwrap().token_requests.len(), 2);
}

#[tokio::test]
async fn callbacks_have_their_own_ip_budget() {
    let h = Harness::spawn_with(Options {
        rate_limit_per_minute: 1,
        ..Options::default()
    })
    .await;
    let reply = h.authorize(APP).await;
    assert_eq!(reply.status, StatusCode::SEE_OTHER);
    let state = query_of(&location(&reply))["state"].clone();
    let query = format!("code=invalid-code&state={state}");
    assert_eq!(h.callback(&query).await.status, StatusCode::SEE_OTHER);
    let blocked = h.callback(&query).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers.contains_key("retry-after"));
    assert_eq!(h.fake.lock().unwrap().token_requests.len(), 1);
}

#[tokio::test]
async fn a_cancelled_callback_cannot_restart_the_provider_exchange() {
    let h = Harness::spawn().await;
    let state = query_of(&location(&h.authorize(APP).await))["state"].clone();
    let gate = Arc::new(tokio::sync::Notify::new());
    h.fake.lock().unwrap().token_gate = Some(gate.clone());
    let query = format!("code=good-code&state={state}");
    {
        let callback = h.callback(&query);
        tokio::pin!(callback);
        tokio::select! {
            _ = &mut callback => panic!("provider exchange should still be pending"),
            started = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while h.fake.lock().unwrap().token_requests.is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            }) => { started.expect("the provider exchange must start"); }
        }
        assert_eq!(h.fake.lock().unwrap().token_requests.len(), 1);
    } // Drop the request while the HTTP provider is still pending.
    assert_eq!(h.callback(&query).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(h.fake.lock().unwrap().token_requests.len(), 1);
    gate.notify_waiters();
    h.fake.lock().unwrap().token_gate = None;
    h.account(9922, Some("cancel-restart@example.com"), true);
    let redirect = h.sign_in().await;
    assert_eq!(
        h.redeem(&redirect["code"], VERIFIER).await.status,
        StatusCode::OK
    );
}
