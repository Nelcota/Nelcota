//! Deployment tokens and migration transactions against real PostgreSQL.
use crate::common::{
    panel::{JSON, login, send},
    *,
};
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

async fn issue(app: &TestApp, cookie: &str) -> Value {
    let response = send(
        app,
        Method::POST,
        "/admin/api/tokens/deploy",
        cookie,
        json!({"name": "integration", "days": 1}),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.body
}
async fn deploy(app: &TestApp, token: &str, path: &str, body: Value) -> Reply {
    app.raw(
        Method::POST,
        path,
        &[JSON, ("authorization", &format!("Bearer {token}"))],
        body.to_string(),
    )
    .await
}
fn request(sql: &str, dry_run: bool) -> Value {
    json!({"files": [{"filename": "V1__remote.sql", "sql": sql}], "dry_run": dry_run})
}

#[tokio::test]
async fn deploy_tokens_are_scoped_revocable_and_origin_restricted() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let issued = issue(&app, &cookie).await;
    let token = issued["token"].as_str().unwrap();
    let types = app
        .raw(
            Method::GET,
            "/admin/deploy/v1/typescript",
            &[("authorization", &format!("Bearer {token}"))],
            String::new(),
        )
        .await;
    assert_eq!(types.status, StatusCode::OK);
    for path in ["/admin/api/users", "/rest/v1/todos"] {
        let reply = app
            .raw(
                Method::GET,
                path,
                &[("authorization", &format!("Bearer {token}"))],
                String::new(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let browser = app
        .raw(
            Method::GET,
            "/admin/deploy/v1/typescript",
            &[
                ("authorization", &format!("Bearer {token}")),
                ("origin", "https://example.com"),
            ],
            String::new(),
        )
        .await;
    assert_eq!(browser.status, StatusCode::UNAUTHORIZED);
    let service = deploy(
        &app,
        &service_token(),
        "/admin/deploy/v1/migrations",
        request("SELECT 1", false),
    )
    .await;
    assert_eq!(service.status, StatusCode::UNAUTHORIZED);
    let hashed: String = app
        .admin_client
        .query_one(
            "SELECT token_hash FROM nelcota.deploy_tokens WHERE id = $1",
            &[&issued["id"].as_i64().unwrap()],
        )
        .await
        .unwrap()
        .get(0);
    assert!(!hashed.contains(token));
    send(
        &app,
        Method::DELETE,
        &format!("/admin/api/tokens/deploy/{}", issued["id"]),
        &cookie,
        Value::Null,
    )
    .await;
    assert_eq!(
        deploy(
            &app,
            token,
            "/admin/deploy/v1/migrations/status",
            json!({"files": []})
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn migrations_dry_run_concurrency_checksums_and_transaction_escape() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let token = issue(&app, &cookie).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let sql = "CREATE TABLE public.remote_fixture(id int4 PRIMARY KEY); INSERT INTO public.remote_fixture VALUES (1);";
    let preview = deploy(
        &app,
        &token,
        "/admin/deploy/v1/migrations",
        request(sql, true),
    )
    .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.text);
    assert_eq!(preview.body["report"]["migrations"][0]["state"], "pending");
    let absent: bool = app
        .admin_client
        .query_one("SELECT to_regclass('public.remote_fixture') IS NULL", &[])
        .await
        .unwrap()
        .get(0);
    assert!(absent);
    let (first, second) = tokio::join!(
        deploy(
            &app,
            &token,
            "/admin/deploy/v1/migrations",
            request(sql, false)
        ),
        deploy(
            &app,
            &token,
            "/admin/deploy/v1/migrations",
            request(sql, false)
        )
    );
    for reply in [first, second] {
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    }
    let audit: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM nelcota.migration_audit WHERE version = 1",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(audit, 1);
    let diverged = deploy(
        &app,
        &token,
        "/admin/deploy/v1/migrations",
        request("SELECT 2", false),
    )
    .await;
    assert_eq!(diverged.status, StatusCode::CONFLICT);
    for (version, bad_sql) in [
        (
            2,
            "CREATE TABLE public.should_rollback(id int4); SELECT 1/0;",
        ),
        (2, "CREATE TABLE public.should_rollback(id int4); COMMIT;"),
    ] {
        let mut body = request(sql, false);
        body["files"]
            .as_array_mut()
            .unwrap()
            .push(json!({"filename": format!("V{version}__failure.sql"), "sql": bad_sql}));
        let failed = deploy(&app, &token, "/admin/deploy/v1/migrations", body).await;
        assert_eq!(
            failed.status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{}",
            failed.text
        );
        let absent: bool = app
            .admin_client
            .query_one("SELECT to_regclass('public.should_rollback') IS NULL", &[])
            .await
            .unwrap()
            .get(0);
        assert!(absent);
    }
}

#[tokio::test]
async fn production_schema_changes_use_migrations_and_panel_files_are_authenticated() {
    let app = TestApp::spawn_with(Options {
        production: true,
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let blocked = send(
        &app,
        Method::POST,
        "/admin/api/tables",
        &cookie,
        json!({"table": {"name":"blocked_production_table", "columns":[{"name":"id","data_type":"integer"}]}}),
    )
    .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN, "{}", blocked.text);
    let uploaded = send(
        &app,
        Method::POST,
        "/admin/api/migrations/apply",
        &cookie,
        request(
            "CREATE TABLE public.allowed_production_table(id int4)",
            false,
        ),
    )
    .await;
    assert_eq!(
        uploaded.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        uploaded.text
    );
    assert_eq!(uploaded.body["code"], "migration_backup_required");
    let absent: bool = app
        .admin_client
        .query_one(
            "SELECT to_regclass('public.allowed_production_table') IS NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(absent);
    let anonymous = app
        .raw(
            Method::POST,
            "/admin/api/migrations/apply",
            &[JSON],
            request("SELECT 1", true).to_string(),
        )
        .await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn migrations_discard_session_settings_before_reusing_pool_capacity() {
    let app = TestApp::spawn_with(Options {
        admin_pool_size: 1,
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let token = issue(&app, &cookie).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let reply = deploy(&app, &token, "/admin/deploy/v1/migrations", request("SET application_name = 'migration-session-only'; CREATE TEMP TABLE temporary_migration_fixture(id int4); CREATE TABLE public.session_fixture(id int4);", false)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let client = app.panel.db.get().await.unwrap();
    let application: String = client
        .query_one("SELECT current_setting('application_name')", &[])
        .await
        .unwrap()
        .get(0);
    assert_ne!(application, "migration-session-only");
    let temporary: bool = client
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'temporary_migration_fixture' AND relnamespace = pg_my_temp_schema())",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(!temporary);
}

#[cfg(unix)]
struct BackupSocketDir(std::path::PathBuf);
#[cfg(unix)]
impl BackupSocketDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("nelcota-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
#[cfg(unix)]
impl Drop for BackupSocketDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn automatic_backup_precedes_sql_and_noops_and_previews_skip_capture() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let temp = BackupSocketDir::new();
    let socket = temp.path().join("backup.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let secret = "a".repeat(64);
    let app = TestApp::spawn_with(Options {
        production: true,
        migration_backup: Some(nelcota_core::migration_backup::BackupAgent {
            socket,
            token: nelcota_core::Secret::new(&secret),
        }),
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let token = issue(&app, &cookie).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let body = request("CREATE TABLE public.after_backup(id int4)", false);
    let mut preview = body.clone();
    preview["dry_run"] = true.into();
    assert_eq!(
        deploy(&app, &token, "/admin/deploy/v1/migrations", preview)
            .await
            .status,
        StatusCode::OK
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    let agent = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut auth = [0; 65];
        stream.read_exact(&mut auth).await.unwrap();
        assert_eq!(&auth[1..], secret.as_bytes());
        let absent: bool = app
            .admin_client
            .query_one("SELECT to_regclass('public.after_backup') IS NULL", &[])
            .await
            .unwrap()
            .get(0);
        assert!(absent, "SQL must wait for a confirmed backup");
        let bytes = br#"{"backup":"nelcota-fixture-before.dump"}"#;
        stream.write_u32(bytes.len() as u32).await.unwrap();
        stream.write_all(bytes).await.unwrap();
        assert!(stream.read_u8().await.is_err());
    };
    let (reply, ()) = tokio::join!(
        deploy(&app, &token, "/admin/deploy/v1/migrations", body.clone()),
        agent
    );
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(
        reply.body["report"]["backup"],
        "nelcota-fixture-before.dump"
    );
    assert_eq!(
        deploy(&app, &token, "/admin/deploy/v1/migrations", body)
            .await
            .status,
        StatusCode::OK
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    // The session-authenticated upload uses exactly the same backup gate.
    let body = json!({"files": [
        {"filename": "V1__remote.sql", "sql": "CREATE TABLE public.after_backup(id int4)"},
        {"filename": "V2__blocked.sql", "sql": "CREATE TABLE public.backup_must_succeed(id int4)"}
    ]});
    let agent = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut auth = [0; 65];
        stream.read_exact(&mut auth).await.unwrap();
        let bytes = br#"{"backup":null}"#;
        stream.write_u32(bytes.len() as u32).await.unwrap();
        stream.write_all(bytes).await.unwrap();
    };
    let (reply, ()) = tokio::join!(
        send(
            &app,
            Method::POST,
            "/admin/api/migrations/apply",
            &cookie,
            body
        ),
        agent
    );
    assert_eq!(
        reply.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        reply.text
    );
    let absent: bool = app
        .admin_client
        .query_one(
            "SELECT to_regclass('public.backup_must_succeed') IS NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(absent);
}

#[cfg(unix)]
#[tokio::test]
async fn losing_the_backup_agent_aborts_inflight_migration_sql() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let temp = BackupSocketDir::new();
    let socket = temp.path().join("backup.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let app = TestApp::spawn_with(Options {
        production: true,
        migration_backup: Some(nelcota_core::migration_backup::BackupAgent {
            socket,
            token: nelcota_core::Secret::new("b".repeat(64)),
        }),
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let token = issue(&app, &cookie).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let agent = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut auth = [0; 65];
        stream.read_exact(&mut auth).await.unwrap();
        let bytes = br#"{"backup":"nelcota-before-interruption.dump"}"#;
        stream.write_u32(bytes.len() as u32).await.unwrap();
        stream.write_all(bytes).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let sleeping: bool = app.admin_client.query_one("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep')", &[]).await.unwrap().get(0);
                if sleeping { break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("migration entered its transaction");
        drop(stream);
    };
    let body = request(
        "CREATE TABLE public.interrupted_backup(id int4); SELECT pg_sleep(10)",
        false,
    );
    let (reply, ()) = tokio::join!(
        deploy(&app, &token, "/admin/deploy/v1/migrations", body),
        agent
    );
    assert_eq!(
        reply.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        reply.text
    );
    let absent: bool = app
        .admin_client
        .query_one(
            "SELECT to_regclass('public.interrupted_backup') IS NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(absent);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let lock_free: bool = app
                .admin_client
                .query_one(
                    "SELECT pg_try_advisory_lock(hashtext('nelcota.migration_backup'))",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            if lock_free {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the canceled SQL connection releases its deployment lock promptly");
}
