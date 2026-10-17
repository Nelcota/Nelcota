//! Regression tests for resource limits, catalog reconciliation and wire DTOs.
mod common;
use axum::http::{Method, StatusCode};
use common::panel::{login, sql_response as sql};
use common::*;
use nelcota_admin::contracts::*;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;

#[tokio::test]
async fn cancelled_http_execution_interrupts_postgres_and_releases_the_slot() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let request = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/admin/api/sql")
        .header("cookie", &cookie)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            json!({"sql":"SELECT pg_sleep(25)"}).to_string(),
        ))
        .unwrap();
    let query = tokio::spawn(app.router.clone().oneshot(request));
    let active = || async {
        app.admin_client.query_one("SELECT count(*) FROM pg_stat_activity WHERE application_name='nelcota-admin-sql' AND state='active'", &[]).await.unwrap().get::<_,i64>(0)
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while active().await == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "query did not start"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    query.abort();
    let _ = query.await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while active().await != 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "HTTP cancellation left a running query"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(sql(&app, &cookie, "SELECT 1").await.status, StatusCode::OK);
}

#[tokio::test]
async fn sql_stream_limits_rows_bytes_batches_and_concurrency() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let reply = sql(&app, &cookie, "select i from generate_series(1,100000) i").await;
    if !reply.body["results"][0]["rows"].is_array() {
        let message = reply.body["error"]["message"].as_str().unwrap_or("");
        let code = reply.body["error"]["code"]
            .as_str()
            .filter(|value| value.len() == 5 && value.bytes().all(|c| c.is_ascii_alphanumeric()));
        println!(
            "::notice title=G05 SQL row budget failure::{}",
            json!({"http_status":reply.status.as_u16(), "sqlstate":code,
                "connection_closed":message.contains("connection closed"),
                "connection_refused":message.contains("Connection refused"),
                "has_error":reply.body.get("error").is_some(),
                "scope":"Fixed numeric/boolean diagnostics only; no SQL or error message publication"})
        );
    }
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.body["results"][0]["rows"].as_array().unwrap().len(),
        1000
    );
    assert_eq!(reply.body["results"][0]["count"], 100000);
    assert_eq!(reply.body["results"][0]["truncated"], true);
    let reply = sql(
        &app,
        &cookie,
        "select repeat('x', 65536) from generate_series(1,1000)",
    )
    .await;
    assert!(reply.body["results"][0]["rows"].as_array().unwrap().len() < 128);
    assert_eq!(reply.body["results"][0]["truncated"], true);
    let query = "SELECT 1;".repeat(35)
        + "CREATE TABLE public.after_budget(id int); INSERT INTO public.after_budget VALUES(7);";
    let reply = sql(&app, &cookie, &query).await;
    assert_eq!(reply.body["results"].as_array().unwrap().len(), 32);
    assert_eq!(reply.body["results_truncated"], true);
    assert_eq!(
        app.admin_client
            .query_one("SELECT id FROM public.after_budget", &[])
            .await
            .unwrap()
            .get::<_, i32>(0),
        7
    );
    let busy = async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let count: i64 = app.admin_client.query_one("SELECT count(*) FROM pg_stat_activity WHERE application_name='nelcota-admin-sql' AND state='active'", &[]).await.unwrap().get(0);
            if count == 4 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "SQL connections did not start"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let reply = sql(&app, &cookie, "SELECT 1").await;
        assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(reply.body["code"], "sql_busy");
        // The ordinary API pool is still available while SQL has all four slots.
        assert!(app.pool.get().await.is_ok());
    };
    let (a, b, c, d, ()) = tokio::join!(
        sql(&app, &cookie, "SELECT pg_sleep(1)"),
        sql(&app, &cookie, "SELECT pg_sleep(1)"),
        sql(&app, &cookie, "SELECT pg_sleep(1)"),
        sql(&app, &cookie, "SELECT pg_sleep(1)"),
        busy
    );
    for reply in [a, b, c, d] {
        assert_eq!(reply.status, StatusCode::OK);
    }
    assert_eq!(sql(&app, &cookie, "SELECT 2").await.status, StatusCode::OK);
}

#[tokio::test]
async fn failed_catalog_refresh_recovers_without_another_notification() {
    let app = TestApp::spawn().await;
    let catalog = Arc::new(nelcota_api::CatalogHandle::new(
        nelcota_api::Catalog::load(&app.admin_client, "public")
            .await
            .unwrap(),
    ));
    let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
        app.admin.clone(),
        tokio_postgres::NoTls,
    ))
    .max_size(1)
    .runtime(deadpool_postgres::Runtime::Tokio1)
    .wait_timeout(Some(Duration::from_millis(30)))
    .build()
    .unwrap();
    let held = pool.get().await.unwrap();
    app.admin_client
        .batch_execute("CREATE TABLE public.reconciled(id int)")
        .await
        .unwrap();
    assert!(!catalog.refresh(&pool).await);
    assert!(catalog.get().table("reconciled").is_none());
    drop(held);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    while catalog.get().table("reconciled").is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "refresh retry did not recover"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn real_panel_responses_satisfy_the_exported_contracts() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    async fn get(app: &TestApp, cookie: &str, path: &str) -> Value {
        let reply = app
            .raw(Method::GET, path, &[("cookie", cookie)], String::new())
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{path}: {}", reply.text);
        reply.body
    }
    serde_json::from_value::<Overview>(get(&app, &cookie, "/admin/api/overview").await).unwrap();
    serde_json::from_value::<TablesResponse>(get(&app, &cookie, "/admin/api/tables").await)
        .unwrap();
    serde_json::from_value::<TableData>(get(&app, &cookie, "/admin/api/tables/products").await)
        .unwrap();
    serde_json::from_value::<UsersResponse>(get(&app, &cookie, "/admin/api/users").await).unwrap();
    serde_json::from_value::<PoliciesData>(get(&app, &cookie, "/admin/api/policies").await)
        .unwrap();
    serde_json::from_value::<MigrationsData>(get(&app, &cookie, "/admin/api/migrations").await)
        .unwrap();
    serde_json::from_value::<StorageOverview>(get(&app, &cookie, "/admin/api/storage").await)
        .unwrap();
    serde_json::from_value::<SqlResponse>(sql(&app, &cookie, "SELECT 1").await.body).unwrap();
    serde_json::from_value::<SqlResponse>(sql(&app, &cookie, "SELECT missing_column").await.body)
        .unwrap();
    let result = app.raw(Method::POST, "/admin/api/tables", &[("cookie",&cookie),("content-type","application/json")], json!({"table":{"name":"contract_table","columns":[{"name":"id","data_type":"integer","primary_key":true}]}}).to_string()).await;
    assert_eq!(result.status, StatusCode::OK, "{}", result.text);
    let result = serde_json::from_value::<DdlResult>(result.body).unwrap();
    assert!(result.applied);
    assert!(!result.catalog_pending);
}
