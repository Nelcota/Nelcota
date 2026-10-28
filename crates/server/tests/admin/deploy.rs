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
    assert_eq!(uploaded.status, StatusCode::OK, "{}", uploaded.text);
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
