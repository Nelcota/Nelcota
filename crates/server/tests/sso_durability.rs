//! Panel handoff redemption is durable across owners of the same database.
mod common;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use common::*;
use serde_json::json;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

fn instance(app: &TestApp, secret: &str) -> Router {
    let mut state = app.panel.clone();
    state.sessions = Arc::default();
    state.host = Arc::new(nelcota_admin::HostLink {
        project: "shop".into(),
        registry: None,
        sso: Some(nelcota_admin::Sso::new(secret.as_bytes())),
    });
    nelcota_admin::router(state)
}
fn handoff(secret: &str) -> String {
    nelcota_admin::Sso::new(secret.as_bytes())
        .issue(ADMIN_EMAIL, "shop")
        .unwrap()
}
async fn redeem(router: Router, token: &str) -> StatusCode {
    router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/admin/api/sso")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({"token": token}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}
#[tokio::test]
async fn second_instance_on_same_database_refuses_replay() {
    let app = TestApp::spawn().await;
    let secret = Uuid::new_v4().simple().to_string();
    let token = handoff(&secret);
    assert_eq!(
        redeem(instance(&app, &secret), &token).await,
        StatusCode::OK
    );
    assert_eq!(
        redeem(instance(&app, &secret), &token).await,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn concurrent_owners_redeem_exactly_once() {
    let app = TestApp::spawn().await;
    let secret = Uuid::new_v4().simple().to_string();
    let token = handoff(&secret);
    let (a, b) = tokio::join!(
        redeem(instance(&app, &secret), &token),
        redeem(instance(&app, &secret), &token)
    );
    let mut statuses = [a.as_u16(), b.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 401]);
}
#[tokio::test]
async fn database_failure_refuses_handoff_without_memory_fallback() {
    let app = TestApp::spawn().await;
    let secret = Uuid::new_v4().simple().to_string();
    app.admin_pool.close();
    assert_eq!(
        redeem(instance(&app, &secret), &handoff(&secret)).await,
        StatusCode::UNAUTHORIZED
    );
}
async fn fixture_table(app: &TestApp) {
    // Makes this regression runnable on the old source before V16 exists.
    app.admin_client.batch_execute("CREATE TABLE IF NOT EXISTS nelcota.admin_sso_replays (
        digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32), expires_at timestamptz NOT NULL)").await.unwrap();
}
#[tokio::test]
async fn cleanup_failure_rolls_back_receipt_and_refuses_redemption() {
    let app = TestApp::spawn().await;
    fixture_table(&app).await;
    app.admin_client.batch_execute("CREATE FUNCTION public.reject_receipt_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected receipt cleanup failure'; END $$;
        CREATE TRIGGER reject_receipt_cleanup BEFORE DELETE ON nelcota.admin_sso_replays FOR EACH STATEMENT EXECUTE FUNCTION public.reject_receipt_cleanup();").await.unwrap();
    let secret = Uuid::new_v4().simple().to_string();
    let token = handoff(&secret);
    assert_eq!(
        redeem(instance(&app, &secret), &token).await,
        StatusCode::UNAUTHORIZED
    );
    let count: i64 = app
        .admin_client
        .query_one("SELECT count(*) FROM nelcota.admin_sso_replays", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 0);
    app.admin_client
        .batch_execute("DROP TRIGGER reject_receipt_cleanup ON nelcota.admin_sso_replays")
        .await
        .unwrap();
    assert_eq!(
        redeem(instance(&app, &secret), &token).await,
        StatusCode::OK
    );
    assert_eq!(
        redeem(instance(&app, &secret), &token).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn expired_cleanup_is_bounded_and_keeps_live_replay_receipts() {
    let app = TestApp::spawn().await;
    fixture_table(&app).await;
    app.admin_client.batch_execute("INSERT INTO nelcota.admin_sso_replays
        SELECT sha256(i::text::bytea), now() - interval '2 days' FROM generate_series(1, 6000) i;
        INSERT INTO nelcota.admin_sso_replays VALUES (sha256('live'::bytea), now() + interval '1 hour')").await.unwrap();
    let secret = Uuid::new_v4().simple().to_string();
    assert_eq!(
        redeem(instance(&app, &secret), &handoff(&secret)).await,
        StatusCode::OK
    );
    let count: i64 = app.admin_client.query_one("SELECT count(*) FROM nelcota.admin_sso_replays WHERE expires_at < now() - interval '1 day'", &[]).await.unwrap().get(0);
    assert_eq!(count, 1000);
    assert_eq!(
        redeem(instance(&app, &secret), &handoff(&secret)).await,
        StatusCode::OK
    );
    let row = app.admin_client.query_one("SELECT count(*), count(*) FILTER (WHERE digest = sha256('live'::bytea)) FROM nelcota.admin_sso_replays", &[]).await.unwrap();
    assert_eq!(row.get::<_, i64>(0), 3);
    assert_eq!(row.get::<_, i64>(1), 1);
}
#[tokio::test]
async fn receipts_cover_the_same_expiration_leeway_as_handoffs() {
    let app = TestApp::spawn().await;
    fixture_table(&app).await;
    let secret = Uuid::new_v4().simple().to_string();
    let expires = jsonwebtoken::get_current_timestamp() + 10;
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({
            "iss": "nelcota-admin", "sub": ADMIN_EMAIL, "aud": "shop", "iat": expires - 60,
            "exp": expires, "jti": Uuid::new_v4().to_string()
        }),
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap();
    assert_eq!(
        redeem(instance(&app, &secret), &token).await,
        StatusCode::OK
    );
    let through = (expires + 5) as f64;
    let valid: bool = app.admin_client.query_one("SELECT EXISTS (SELECT 1 FROM nelcota.admin_sso_replays WHERE expires_at = to_timestamp($1))", &[&through]).await.unwrap().get(0);
    assert!(valid);
    assert_eq!(
        redeem(instance(&app, &secret), &token).await,
        StatusCode::UNAUTHORIZED
    );
    for role in ["anon", "authenticated", "service_role", "nelcota_auth"] {
        let can_read: bool = app
            .admin_client
            .query_one(
                "SELECT has_table_privilege($1, 'nelcota.admin_sso_replays', 'SELECT')",
                &[&role],
            )
            .await
            .unwrap()
            .get(0);
        assert!(!can_read);
    }
}

#[tokio::test]
async fn process_restart_keeps_replay_protection() {
    let app = TestApp::spawn().await;
    let secret = Uuid::new_v4().simple().to_string();
    let token = handoff(&secret);
    // Two independent OS processes, each with a fresh Sso and session registry.
    // The second starts only after the first has exited successfully.
    for expected in [200, 401] {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process_redemption_child",
                "--ignored",
                "--nocapture",
            ])
            .env("NELCOTA_REVIEW_DB", app.admin.get_dbname().unwrap())
            .env("NELCOTA_REVIEW_PORT", app.admin.get_ports()[0].to_string())
            .env("NELCOTA_REVIEW_DB_USER", app.admin.get_user().unwrap())
            .env(
                "NELCOTA_REVIEW_DB_PASSWORD",
                std::str::from_utf8(app.admin.get_password().unwrap()).unwrap(),
            )
            .env("NELCOTA_REVIEW_SECRET", &secret)
            .env("NELCOTA_REVIEW_TOKEN", &token)
            .env(
                "NELCOTA_REVIEW_SIGN_IN",
                serde_json::to_string(&*app.panel.sign_in).unwrap(),
            )
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(20), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(output.status.success(), "child process failed");
        let output = String::from_utf8(output.stdout).unwrap();
        assert!(
            output
                .lines()
                .any(|line| line == format!("redemption_status={expected}")),
            "unexpected child redemption status"
        );
    }
}

#[tokio::test]
#[ignore = "invoked twice as an isolated child by process_restart_keeps_replay_protection"]
async fn process_redemption_child() {
    let read = |key| std::env::var(key).expect("parent supplies disposable fixture configuration");
    let mut config = tokio_postgres::Config::new();
    config
        .host("127.0.0.1")
        .port(read("NELCOTA_REVIEW_PORT").parse().unwrap())
        .user(read("NELCOTA_REVIEW_DB_USER"))
        .password(read("NELCOTA_REVIEW_DB_PASSWORD"))
        .dbname(read("NELCOTA_REVIEW_DB"));
    let pool = nelcota_core::db::admin_pool(&config, 2);
    let keys = Arc::new(
        nelcota_auth::Keys::new(Some(&nelcota_auth::generate_ed25519_private_key()), None).unwrap(),
    );
    let state = nelcota_admin::AdminState {
        production: false,
        webhooks: Default::default(),
        sql: Arc::default(),
        exports: Arc::new(nelcota_admin::ExportExecutor::new(
            std::time::Duration::from_secs(5),
        )),
        catalog: nelcota_server::load_catalog(&pool, "public").await.unwrap(),
        db: pool.clone(),
        db_config: config,
        credentials: Arc::new(nelcota_admin::Credentials {
            email: ADMIN_EMAIL.into(),
            password_hash: String::new(),
        }),
        sessions: Arc::default(),
        limiter: Arc::new(nelcota_auth::RateLimiter::new(30)),
        passwords: Arc::new(nelcota_auth::Passwords::new(1)),
        trust_proxy: false,
        secure_cookies: false,
        host: Arc::new(nelcota_admin::HostLink {
            project: "shop".into(),
            registry: None,
            sso: Some(nelcota_admin::Sso::new(
                read("NELCOTA_REVIEW_SECRET").as_bytes(),
            )),
        }),
        tokens: Arc::new(nelcota_admin::TokenIssuer {
            keys,
            issuer: "fixture".into(),
        }),
        migrations_dir: None,
        storage: None,
        sign_in: Arc::new(serde_json::from_str(&read("NELCOTA_REVIEW_SIGN_IN")).unwrap()),
        denied: Arc::default(),
        metrics: Arc::default(),
    };
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        redeem(nelcota_admin::router(state), &read("NELCOTA_REVIEW_TOKEN")),
    )
    .await
    .unwrap();
    println!("redemption_status={}", status.as_u16());
    pool.close();
}
