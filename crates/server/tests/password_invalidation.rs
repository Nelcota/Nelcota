//! Password replacement retires pending credentials in its transaction.
mod common;
use axum::http::{Method, StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{panel, *};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn password(index: usize) -> &'static str {
    static VALUES: std::sync::OnceLock<[String; 3]> = std::sync::OnceLock::new();
    &VALUES.get_or_init(|| std::array::from_fn(|_| Uuid::new_v4().to_string()))[index]
}

async fn account(app: &TestApp) -> Value {
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let session = app
        .post(
            "/auth/v1/signup",
            None,
            json!({"email": email, "password": password(0)}),
        )
        .await;
    assert_eq!(session.status, StatusCode::CREATED);
    let id = session.body["user"]["id"].as_str().unwrap();
    app.admin_client
        .execute(
            "UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1::text::uuid",
            &[&id],
        )
        .await
        .unwrap();
    session.body
}

struct Pending {
    recovery: String,
    magic: String,
    code: String,
    verifier: String,
}
async fn pending(app: &TestApp, session: &Value) -> Pending {
    let email = session["user"]["email"].as_str().unwrap();
    let start = app.outbox.sent().len();
    assert_eq!(
        app.post("/auth/v1/recover", None, json!({"email": email}))
            .await
            .status,
        StatusCode::OK
    );
    let recovery = link_token(
        &app.outbox.wait_for(start + 1).await[start],
        RECOVERY_URL,
        "recovery",
    );
    assert_eq!(
        app.post("/auth/v1/magiclink", None, json!({"email": email}))
            .await
            .status,
        StatusCode::OK
    );
    let magic = link_token(
        &app.outbox.wait_for(start + 2).await[start + 1],
        MAGIC_LINK_URL,
        "magiclink",
    );
    let code = Uuid::new_v4().to_string();
    let verifier = "a".repeat(43);
    let digest = Sha256::digest(code.as_bytes()).to_vec();
    let state = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let id = session["user"]["id"].as_str().unwrap();
    app.admin_client.execute("INSERT INTO auth.flow_states
        (state_hash, provider, provider_verifier, code_challenge, redirect_to, auth_code_hash, user_id, expires_at)
        VALUES ($1, 'github', '', $2, 'https://app.example.test/auth', $3, $4::text::uuid, now() + interval '5 minutes')",
        &[&state, &challenge, &digest, &id]).await.unwrap();
    Pending {
        recovery,
        magic,
        code,
        verifier,
    }
}
async fn change(app: &TestApp, session: &Value) -> Reply {
    app.request(
        Method::PUT,
        "/auth/v1/user",
        session["access_token"].as_str(),
        Some(json!({"current_password": password(0), "password": password(1)})),
    )
    .await
}
async fn recover(app: &TestApp, token: &str) -> Reply {
    app.post(
        "/auth/v1/verify",
        None,
        json!({"type": "recovery", "token": token, "password": password(2)}),
    )
    .await
}
async fn assert_retired(app: &TestApp, session: &Value, p: &Pending) {
    // Collect all responses before asserting, so the old-code run exercises
    // every credential class without printing credential values.
    let magic = app
        .post(
            "/auth/v1/verify",
            None,
            json!({"type": "magiclink", "token": p.magic}),
        )
        .await;
    let recovery = recover(app, &p.recovery).await;
    let code = app
        .post(
            "/auth/v1/token?grant_type=pkce",
            None,
            json!({"auth_code": p.code, "code_verifier": p.verifier}),
        )
        .await;
    assert_eq!(
        [magic.status, recovery.status, code.status],
        [StatusCode::BAD_REQUEST; 3]
    );
    let id = session["user"]["id"].as_str().unwrap();
    let row = app
        .admin_client
        .query_one(
            "SELECT count(*), count(*) FILTER (WHERE used_at IS NULL)
        FROM auth.one_time_tokens WHERE user_id = $1::text::uuid",
            &[&id],
        )
        .await
        .unwrap();
    assert!(
        row.get::<_, i64>(0) >= 2,
        "retain issuance history for send cooldowns"
    );
    assert_eq!(row.get::<_, i64>(1), 0);
    let before = app.outbox.sent().len();
    app.post(
        "/auth/v1/recover",
        None,
        json!({"email": session["user"]["email"]}),
    )
    .await;
    assert_eq!(app.outbox.sent().len(), before);
}

#[tokio::test]
async fn authenticated_change_retires_pending_credentials() {
    let app = TestApp::spawn().await;
    let session = account(&app).await;
    let p = pending(&app, &session).await;
    assert_eq!(change(&app, &session).await.status, StatusCode::OK);
    assert_retired(&app, &session, &p).await;
}
#[tokio::test]
async fn recovery_completion_retires_pending_credentials() {
    let app = TestApp::spawn().await;
    let session = account(&app).await;
    let p = pending(&app, &session).await;
    assert_eq!(recover(&app, &p.recovery).await.status, StatusCode::OK);
    assert_retired(&app, &session, &p).await;
}
#[tokio::test]
async fn admin_reset_retires_pending_credentials() {
    let app = TestApp::spawn().await;
    let session = account(&app).await;
    let p = pending(&app, &session).await;
    let cookie = panel::login(&app).await;
    let id = session["user"]["id"].as_str().unwrap();
    assert_eq!(
        panel::send(
            &app,
            Method::PUT,
            &format!("/admin/api/users/{id}/password"),
            &cookie,
            json!({"password": password(1)})
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_retired(&app, &session, &p).await;
}
#[tokio::test]
async fn another_users_pending_credentials_are_unchanged() {
    let app = TestApp::spawn().await;
    let first = account(&app).await;
    let other = account(&app).await;
    let p = pending(&app, &other).await;
    assert_eq!(change(&app, &first).await.status, StatusCode::OK);
    assert_eq!(
        app.post(
            "/auth/v1/verify",
            None,
            json!({"type": "magiclink", "token": p.magic})
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(recover(&app, &p.recovery).await.status, StatusCode::OK);
}
async fn wait_for_lock(app: &TestApp, pattern: &str) {
    for _ in 0..1_000 {
        let waiting: bool = app
            .admin_client
            .query_one(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1)",
                &[&pattern],
            )
            .await
            .unwrap()
            .get(0);
        if waiting {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("operation did not reach its account lock");
}
#[tokio::test]
async fn queued_recovery_cannot_succeed_after_a_password_change_commits() {
    let app = TestApp::spawn().await;
    let session = account(&app).await;
    let p = pending(&app, &session).await;
    let (mut owner, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    let driver = tokio::spawn(async move {
        connection.await.unwrap();
    });
    let tx = owner.transaction().await.unwrap();
    let id = session["user"]["id"].as_str().unwrap();
    tx.query_one(
        "SELECT id FROM auth.users WHERE id = $1::text::uuid FOR UPDATE",
        &[&id],
    )
    .await
    .unwrap();
    let replacement = change(&app, &session);
    let recovery = async {
        wait_for_lock(&app, "SELECT encrypted_password FROM auth.users%FOR UPDATE").await;
        recover(&app, &p.recovery).await
    };
    let release = async {
        wait_for_lock(&app, "%JOIN auth.one_time_tokens%FOR UPDATE OF u").await;
        tx.commit().await.unwrap();
    };
    let (changed, recovered, ()) = tokio::join!(replacement, recovery, release);
    drop(owner);
    driver.await.unwrap();
    assert_eq!(changed.status, StatusCode::OK);
    assert_eq!(recovered.status, StatusCode::BAD_REQUEST);
}
#[tokio::test]
async fn invalidation_error_rolls_back_the_entire_password_replacement() {
    let app = TestApp::spawn().await;
    let session = account(&app).await;
    let p = pending(&app, &session).await;
    app.admin_client.batch_execute("CREATE FUNCTION public.reject_flow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected deletion failure'; END $$;
        CREATE TRIGGER reject_flow_delete BEFORE DELETE ON auth.flow_states FOR EACH ROW EXECUTE FUNCTION public.reject_flow_delete();").await.unwrap();
    assert_eq!(change(&app, &session).await.status, StatusCode::BAD_REQUEST);
    app.admin_client
        .batch_execute("DROP TRIGGER reject_flow_delete ON auth.flow_states")
        .await
        .unwrap();
    assert_eq!(
        app.post(
            "/auth/v1/token?grant_type=password",
            None,
            json!({"email": session["user"]["email"], "password": password(0)})
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(recover(&app, &p.recovery).await.status, StatusCode::OK);
}
