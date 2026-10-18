//! Database budgets must hold under concurrent previews and slow consumers.
use crate::common::{
    Options, TestApp,
    panel::{get, login},
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::json;
use std::time::Duration;
use tower::ServiceExt;

#[tokio::test]
async fn previews_reuse_one_connection_and_restore_owner_permissions() {
    let app = TestApp::spawn_with(Options {
        admin_pool_size: 1,
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let account = app
        .post(
            "/auth/v1/signup",
            None,
            json!({ "email": "preview@example.com", "password": "strong-password-1" }),
        )
        .await;
    let user = account.body["user"]["id"].as_str().unwrap();
    app.admin_client
        .execute(
            "INSERT INTO public.todos (user_id,title) VALUES ($1::text::uuid,'private preview')",
            &[&user],
        )
        .await
        .unwrap();
    let path = format!("/admin/api/tables/todos?as=authenticated&user={user}");
    let (anon, authenticated, denied) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(
            get(&app, "/admin/api/tables/products?as=anon", &cookie),
            get(&app, &path, &cookie),
            get(&app, "/admin/api/tables/todos?as=anon", &cookie)
        )
    })
    .await
    .expect("previews must complete with one admin connection");
    assert_eq!(anon.status, StatusCode::OK, "{}", anon.text);
    assert_eq!(
        authenticated.status,
        StatusCode::OK,
        "{}",
        authenticated.text
    );
    assert_eq!(authenticated.body["rows"].as_array().unwrap().len(), 1);
    assert_eq!(authenticated.body["rows"][0]["title"], "private preview");
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    let owner = get(&app, "/admin/api/tables/todos", &cookie).await;
    assert_eq!(owner.status, StatusCode::OK, "{}", owner.text);
    assert_eq!(owner.body["rows"].as_array().unwrap().len(), 3);
    let client = app.admin_pool.get().await.unwrap();
    let row = client
        .query_one(
            "SELECT current_user::text, nullif(current_setting('request.jwt.claims',true),'')",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "postgres");
    assert_eq!(row.get::<_, Option<String>>(1), None);
}

async fn export(app: &TestApp, cookie: &str) -> axum::response::Response {
    app.router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/admin/api/tables/products/export?format=json")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn slow_exports_have_their_own_budget_and_cancel_on_drop() {
    let app = TestApp::spawn_with(Options {
        admin_pool_size: 1,
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let first = export(&app, &cookie).await;
    let second = export(&app, &cookie).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(
        export(&app, &cookie).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let panel = tokio::time::timeout(
        Duration::from_secs(2),
        get(&app, "/admin/api/tables/products", &cookie),
    )
    .await
    .unwrap();
    assert_eq!(panel.status, StatusCode::OK, "{}", panel.text);
    drop(first);
    drop(second);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let next = export(&app, &cookie).await;
            if next.status() == StatusCode::OK {
                let body = next.into_body().collect().await.unwrap().to_bytes();
                let rows: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(rows.as_array().unwrap().len(), 4);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("abandoned exports must return their admission slots");
}

#[tokio::test]
async fn export_lifetime_expires_even_when_the_body_is_not_polled() {
    let app = TestApp::spawn_with(Options {
        export_timeout: Duration::from_millis(500),
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let first = export(&app, &cookie).await;
    let second = export(&app, &cookie).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let row = app.admin_client.query_one("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-export'", &[]).await.unwrap();
            if row.get::<_, i64>(0) == 0 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("deadline must close dedicated connections without a body poll");
    assert!(
        first.into_body().collect().await.is_err(),
        "a timed-out JSON stream must fail rather than append a valid footer"
    );
    assert!(second.into_body().collect().await.is_err());
    let next = export(&app, &cookie).await;
    assert_eq!(next.status(), StatusCode::OK);
    assert!(next.into_body().collect().await.is_ok());
}

#[tokio::test]
async fn large_unpolled_exports_close_database_connections_at_the_response_deadline() {
    let app = TestApp::spawn_with(Options {
        export_timeout: Duration::from_millis(500),
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    app.admin_client.batch_execute(
        "CREATE VIEW public.large_deadline_export AS SELECT i AS id, repeat('x',1024) AS payload FROM generate_series(1,8192)i"
    ).await.unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let mut responses = Vec::new();
    for _ in 0..2 {
        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/admin/api/tables/large_deadline_export/export?format=json")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        responses.push(response);
    }
    let released = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let connections: i64 = app.admin_client.query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-export'",
                &[],
            ).await.unwrap().get(0);
            if connections == 0 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.is_ok();
    let retained: i64 = app.admin_client.query_one(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-export'",
        &[],
    ).await.unwrap().get(0);
    // Retire both bodies before asserting the before-fix failure so their
    // actual response channels and backend queries are always cleaned.
    for response in responses {
        assert!(
            tokio::time::timeout(Duration::from_secs(3), response.into_body().collect())
                .await
                .unwrap()
                .is_err(),
            "an expired large export must not produce a successful complete body"
        );
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let connections: i64 = app.admin_client.query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-export'",
                &[],
            ).await.unwrap().get(0);
            if connections == 0 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("consumed expired exports must clean their owned database connections");
    println!(
        "::notice title=G05 large unpolled export deadline::{}",
        serde_json::json!({
            "case":"large_unpolled_exports_close_database_connections_at_the_response_deadline",
            "unpolled_exports":2, "rows_each":8192, "payload_bytes_per_row":1024,
            "response_deadline_milliseconds":500, "connection_release_budget_seconds":3,
            "database_connections_released_without_body_poll":released,
            "database_connections_before_retiring_bodies":retained,
            "expired_complete_bodies_rejected":2, "database_connections_after_cleanup":0,
            "scope":"Real owned PostgreSQL and deliberately unpolled response channels; generated fixture only, no load-time credit"
        })
    );
    assert!(
        released,
        "large unpolled exports retained database connections after their response deadline"
    );
    assert_eq!(retained, 0);
}

#[tokio::test]
async fn stale_and_missing_statistics_do_not_trigger_full_exact_counts() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.stale_count (id integer) WITH (autovacuum_enabled=false);
         ANALYZE public.stale_count;
         INSERT INTO public.stale_count SELECT n FROM generate_series(1,20000) n;
         CREATE TABLE public.unknown_count (id integer) WITH (autovacuum_enabled=false);
         INSERT INTO public.unknown_count SELECT n FROM generate_series(1,20000) n;
         CREATE TABLE public.small_count (id integer);
         INSERT INTO public.small_count SELECT n FROM generate_series(1,10) n;",
        )
        .await
        .unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let overview = get(&app, "/admin/api/overview", &cookie).await;
    assert_eq!(overview.status, StatusCode::OK, "{}", overview.text);
    for name in ["stale_count", "unknown_count"] {
        let entry = overview.body["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|table| table["name"] == name)
            .unwrap();
        assert!(
            entry["rows"].is_null(),
            "large counts with inaccurate statistics must remain unknown"
        );
        assert_eq!(entry["rows_exact"], false);
        let page = get(&app, &format!("/admin/api/tables/{name}"), &cookie).await;
        assert_eq!(page.status, StatusCode::OK, "{}", page.text);
        assert!(page.body["total"].is_null());
        assert_eq!(page.body["total_exact"], false);
        assert_eq!(page.body["has_next"], true);
    }
    let small = get(&app, "/admin/api/tables/small_count", &cookie).await;
    assert_eq!(small.body["total"], 10);
    assert_eq!(small.body["total_exact"], true);
    app.admin_client
        .batch_execute("ANALYZE public.stale_count")
        .await
        .unwrap();
    let analysed = get(&app, "/admin/api/tables/stale_count", &cookie).await;
    assert_eq!(analysed.body["total"], 20000);
    assert_eq!(analysed.body["total_exact"], false);
}

#[tokio::test]
async fn overview_count_timeout_keeps_the_connection_usable() {
    let app = TestApp::spawn_with(Options {
        admin_pool_size: 1,
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let mut lock = app
        .admin
        .clone()
        .connect(tokio_postgres::NoTls)
        .await
        .unwrap();
    let driver = tokio::spawn(lock.1);
    let tx = lock.0.transaction().await.unwrap();
    tx.batch_execute("LOCK TABLE public.products IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let overview = tokio::time::timeout(
        Duration::from_secs(2),
        get(&app, "/admin/api/overview", &cookie),
    )
    .await
    .expect("a count blocked by DDL must respect its short budget");
    assert_eq!(overview.status, StatusCode::OK, "{}", overview.text);
    let products = overview.body["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|table| table["name"] == "products")
        .unwrap();
    assert!(products["rows"].is_null());
    assert_eq!(products["rows_exact"], false);
    tx.rollback().await.unwrap();
    let page = get(&app, "/admin/api/tables/products", &cookie).await;
    assert_eq!(page.body["total"], 4);
    assert_eq!(page.body["total_exact"], true);
    drop(lock.0);
    driver.await.unwrap().unwrap();
}

#[tokio::test]
async fn user_pages_use_the_ordering_index_and_break_creation_time_ties() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    app.admin_client.batch_execute("INSERT INTO auth.users (email) SELECT 'indexed-'||n||'@example.com' FROM generate_series(1,5000) n; ANALYZE auth.users;").await.unwrap();
    let expected: Vec<String> = app
        .admin_client
        .query(
            "SELECT id::text FROM auth.users ORDER BY created_at DESC,id DESC LIMIT 100",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    let first = get(&app, "/admin/api/users", &cookie).await;
    let second = get(&app, "/admin/api/users?page=1", &cookie).await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(second.status, StatusCode::OK);
    let actual: Vec<&str> = first.body["users"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second.body["users"].as_array().unwrap())
        .map(|user| user["id"].as_str().unwrap())
        .collect();
    assert_eq!(actual, expected);
    let plan: serde_json::Value = app.admin_client.query_one("EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM auth.users ORDER BY created_at DESC,id DESC LIMIT 51", &[]).await.unwrap().get(0);
    assert!(plan.to_string().contains("users_created_id_idx"));
    assert_eq!(plan[0]["Plan"]["Plans"][0]["Actual Rows"], 51);
}

#[tokio::test]
async fn a_failed_preview_count_rolls_back_before_owner_metadata_is_read() {
    let app = TestApp::spawn_with(Options {
        admin_pool_size: 1,
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.preview_count_error (id integer);
        INSERT INTO public.preview_count_error SELECT n FROM generate_series(1,100) n;
        GRANT SELECT ON public.preview_count_error TO anon;
        ALTER TABLE public.preview_count_error ENABLE ROW LEVEL SECURITY;
        CREATE POLICY visible_rows ON public.preview_count_error TO anon
          USING (CASE WHEN id < 70 THEN true WHEN id = 70 THEN 1/(id-70)>0 END);",
        )
        .await
        .unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let preview = get(
        &app,
        "/admin/api/tables/preview_count_error?as=anon",
        &cookie,
    )
    .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.text);
    assert_eq!(preview.body["rows"].as_array().unwrap().len(), 50);
    assert!(preview.body["total"].is_null());
    assert_eq!(preview.body["table"]["rls"]["policies"], 1);
    let owner = get(&app, "/admin/api/tables/preview_count_error", &cookie).await;
    assert_eq!(owner.status, StatusCode::OK, "{}", owner.text);
    assert_eq!(owner.body["total"], 100);
}

#[tokio::test]
async fn cancelling_an_export_cancels_its_running_postgres_query() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    app.admin_client
        .batch_execute("CREATE VIEW public.slow_export AS SELECT pg_sleep(30)::text AS value;")
        .await
        .unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let router = app.router.clone();
    let pending = tokio::spawn(async move {
        router
            .oneshot(
                Request::builder()
                    .uri("/admin/api/tables/slow_export/export?format=json")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let row = app.admin_client.query_one("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-export' AND state='active' AND wait_event='PgSleep'", &[]).await.unwrap();
            if row.get::<_, i64>(0) == 1 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("export query did not start");
    pending.abort();
    let _ = pending.await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let row = app.admin_client.query_one("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-export'", &[]).await.unwrap();
            if row.get::<_, i64>(0) == 0 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("cancelled export must not keep a running backend");
}

#[tokio::test]
async fn review_export_footer_obeys_deadline_when_the_timer_is_not_scheduled() {
    let app = TestApp::spawn_with(Options {
        export_timeout: Duration::from_millis(500),
        ..Options::default()
    })
    .await;
    let cookie = login(&app).await;
    let mut body = export(&app, &cookie).await.into_body();
    // Consume the header and four rows, leaving only the final footer.
    for _ in 0..5 {
        body.frame().await.unwrap().unwrap();
    }
    tokio::task::yield_now().await;
    // This current-thread runtime cannot schedule its watchdog during the stall.
    std::thread::sleep(Duration::from_millis(550));
    let footer = body
        .frame()
        .await
        .expect("export must report an interrupted footer");
    assert!(
        footer.is_err(),
        "a delayed watchdog must not allow completion past the deadline"
    );
}
