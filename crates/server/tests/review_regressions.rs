//! Regressions for typed filters, exact writes and panel HTTP boundaries.
mod common;

use axum::http::{Method, StatusCode, header};
use common::{panel, *};
use serde_json::json;
use std::time::{Duration, SystemTime};

#[tokio::test]
async fn fixed_width_and_array_filters_compare_complete_values() {
    let app = TestApp::spawn().await;
    app.admin_client.batch_execute(
        "CREATE TABLE public.typed_filters (id int, code char(3), bits bit(3), items int[]);
         INSERT INTO public.typed_filters VALUES (1, 'ABC', B'101', '{1,2}'), (2, 'A', B'100', '{3}');
         GRANT SELECT ON public.typed_filters TO anon;"
    ).await.unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    for (filter, expected) in [
        ("code=eq.ABC", json!([{"id":1}])),
        ("code=eq.AXYZ", json!([])),
        ("code=eq.ABCX", json!([])),
        ("code=in.(ABC,DEF)", json!([{"id":1}])),
        ("bits=eq.101", json!([{"id":1}])),
        ("bits=eq.1011", json!([])),
        ("bits=in.(101,111)", json!([{"id":1}])),
        ("items=in.(\"{1,2}\",\"{4}\")", json!([{"id":1}])),
        ("items=not.in.(\"{1,2}\")", json!([{"id":2}])),
    ] {
        let (status, body) = app
            .get(&format!("/rest/v1/typed_filters?select=id&{filter}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{filter}: {body}");
        assert_eq!(body, expected, "{filter}");
    }
    let cookie = panel::login(&app).await;
    let result = panel::get(
        &app,
        r#"/admin/api/tables/typed_filters?filters=[{"column":"code","op":"eq","value":"ABC"}]"#,
        &cookie,
    )
    .await;
    assert_eq!(result.status, StatusCode::OK, "{}", result.text);
    assert_eq!(result.body["rows"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn numeric_write_bodies_keep_all_decimal_digits() {
    let app = TestApp::spawn().await;
    app.admin_client.batch_execute(
        "CREATE TABLE public.exact_writes (id int PRIMARY KEY, amount numeric(30,2));
         GRANT ALL ON public.exact_writes TO service_role;
         CREATE FUNCTION public.echo_decimal(amount numeric) RETURNS numeric LANGUAGE sql AS 'SELECT amount';"
    ).await.unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let service = format!("Bearer {}", service_token());
    let headers = [("authorization", service.as_str()), panel::JSON];
    for (method, path, body, expected) in [
        (
            Method::POST,
            "/rest/v1/exact_writes",
            "{\"id\":1,\"amount\":12345678901234567.89}",
            "12345678901234567.89",
        ),
        (
            Method::PATCH,
            "/rest/v1/exact_writes?id=eq.1",
            "{\"amount\":98765432109876543.21}",
            "98765432109876543.21",
        ),
    ] {
        let reply = app.raw(method, path, &headers, body.into()).await;
        assert!(reply.status.is_success(), "{}", reply.text);
        let saved: String = app
            .admin_client
            .query_one(
                "SELECT amount::text FROM public.exact_writes WHERE id = 1",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(saved, expected);
    }
    let reply = app
        .raw(
            Method::POST,
            "/rest/v1/rpc/echo_decimal",
            &headers,
            "{\"amount\":12345678901234567.89}".into(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(reply.text, "12345678901234567.89");
}

#[tokio::test]
async fn unsupported_rpc_signatures_are_absent_from_the_catalog() {
    let app = TestApp::spawn().await;
    app.admin_client.batch_execute(
        "CREATE FUNCTION public.poly(arg anyelement) RETURNS anyelement LANGUAGE sql AS 'SELECT arg';
         CREATE FUNCTION public.variadic_args(VARIADIC args int[]) RETURNS int LANGUAGE sql AS 'SELECT cardinality(args)';"
    ).await.unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    for name in ["poly", "variadic_args"] {
        assert!(!app.catalog.get().functions.contains_key(name));
        let reply = app
            .post(&format!("/rest/v1/rpc/{name}"), None, json!({"arg":1}))
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.text);
    }
}

#[tokio::test]
async fn panel_rejections_are_json_and_public_cors_does_not_cover_the_panel() {
    let app = TestApp::spawn().await;
    let cookie = panel::login(&app).await;
    for (headers, body, status) in [
        (
            vec![("cookie", cookie.as_str())],
            "{}",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            vec![("cookie", cookie.as_str()), panel::JSON],
            "[]",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let reply = app
            .raw(Method::POST, "/admin/api/sql", &headers, body.into())
            .await;
        assert_eq!(reply.status, status, "{}", reply.text);
        assert!(reply.body["error"].is_string());
        assert!(reply.body["code"].is_string());
    }
    for method in [Method::GET, Method::OPTIONS] {
        let panel = app
            .raw(
                method.clone(),
                "/admin/api/me",
                &[
                    ("origin", "https://foreign.example"),
                    ("access-control-request-method", "GET"),
                ],
                String::new(),
            )
            .await;
        assert!(
            !panel
                .headers
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
        let api = app
            .raw(
                method,
                "/rest/v1/products",
                &[
                    ("origin", "https://foreign.example"),
                    ("access-control-request-method", "GET"),
                ],
                String::new(),
            )
            .await;
        assert_eq!(api.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }
}

#[tokio::test]
async fn pooled_connections_rollback_unowned_transactions_before_reuse() {
    let app = TestApp::spawn().await;
    let pool = nelcota_core::db::api_pool(&app.admin, common::authenticator_password(), 1);
    let client = pool.get().await.unwrap();
    // Models BEGIN accepted by PostgreSQL before cancellation creates its guard.
    client.batch_execute("BEGIN; SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)").await.unwrap();
    drop(client);
    let client = pool.get().await.unwrap();
    let row = client
        .query_one(
            "SELECT current_user::text, current_setting('request.jwt.claims', true)",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "authenticator");
    assert_ne!(
        row.get::<_, Option<String>>(1).as_deref(),
        Some("{\"role\":\"service_role\"}")
    );
}

#[tokio::test]
async fn incomplete_disk_uploads_are_collected_without_touching_foreign_or_recent_files() {
    let app = TestApp::spawn().await;
    let bucket = app.storage_dir.join("docs");
    std::fs::create_dir_all(&bucket).unwrap();
    let version = uuid::Uuid::now_v7();
    let orphan = bucket.join(format!("{version}#1"));
    let foreign = bucket.join("readme#1");
    let malformed = bucket.join(format!("{version}#not-a-part"));
    for path in [&orphan, &foreign, &malformed] {
        std::fs::write(path, b"keep unless ours").unwrap();
    }
    assert_eq!(
        nelcota_storage::collect_orphans(&app.pool, &app.storage.store, SystemTime::now())
            .await
            .unwrap(),
        0
    );
    let later = SystemTime::now() + Duration::from_secs(2 * 86_400);
    assert_eq!(
        nelcota_storage::collect_orphans(&app.pool, &app.storage.store, later)
            .await
            .unwrap(),
        1
    );
    assert!(!orphan.exists());
    assert!(foreign.exists() && malformed.exists());
}

#[tokio::test]
async fn panel_policy_urls_cannot_alias_a_truncated_identifier() {
    let app = TestApp::spawn().await;
    let original = "p".repeat(63);
    app.admin_client
        .batch_execute(&format!(
            "CREATE POLICY \"{original}\" ON public.products USING (true)"
        ))
        .await
        .unwrap();
    let cookie = panel::login(&app).await;
    let path = format!("/admin/api/tables/products/policies/{original}x");
    for method in [Method::DELETE, Method::PUT] {
        let reply = panel::send(
            &app,
            method,
            &path,
            &cookie,
            json!({"policy":{"name":"replacement", "command":"select", "using":"true"}}),
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text);
        assert_eq!(reply.body["code"], "name_too_long");
        let count: i64 = app.admin_client.query_one("SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'products' AND policyname = $1", &[&original]).await.unwrap().get(0);
        assert_eq!(count, 1);
    }
}

#[tokio::test]
async fn panel_ddl_can_finish_after_the_public_request_deadline() {
    let app = TestApp::spawn().await;
    let cookie = panel::login(&app).await;
    app.admin_client.batch_execute(
        "CREATE TABLE public.slow_ddl (id int); INSERT INTO public.slow_ddl VALUES (1);
         CREATE FUNCTION public.slow_default() RETURNS int LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(11); RETURN 7; END $$;"
    ).await.unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let reply = panel::send(&app, Method::PATCH, "/admin/api/tables/slow_ddl", &cookie,
        json!({"actions":[{"action":"add_column", "column":{"name":"value", "data_type":"integer", "default":"public.slow_default()"}}]})).await;
    // The harness gives public routes 10 s; the DDL owns a longer panel budget.
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(
        app.admin_client
            .query_one("SELECT value FROM public.slow_ddl", &[])
            .await
            .unwrap()
            .get::<_, i32>(0),
        7
    );
}

#[tokio::test]
async fn unique_actions_in_one_batch_track_constraints_across_renames() {
    let app = TestApp::spawn().await;
    let cookie = panel::login(&app).await;
    let reply = panel::send(
        &app,
        Method::PATCH,
        "/admin/api/tables/products",
        &cookie,
        json!({"actions":[
            {"action":"add_column", "column":{"name":"sku", "data_type":"text", "unique":true}},
            {"action":"set_unique", "column":"sku", "unique":true},
            {"action":"rename_column", "from":"sku", "to":"code"},
            {"action":"set_unique", "column":"code", "unique":false},
            {"action":"set_unique", "column":"code", "unique":true},
            {"action":"set_unique", "column":"code", "unique":true}
        ]}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let count: i64 = app.admin_client.query_one("SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.products'::regclass AND contype = 'u'", &[]).await.unwrap().get(0);
    assert_eq!(count, 1);
}

#[tokio::test]
async fn concurrent_unknown_length_uploads_share_the_available_quota() {
    use bytes::Bytes;
    use futures_util::stream;
    use std::sync::Arc;
    let mut options = Options::default();
    options.storage.max_total_size = Some(10);
    let app = TestApp::spawn_with(options).await;
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let body = || {
        let barrier = barrier.clone();
        Box::pin(stream::once(async move {
            barrier.wait().await;
            Ok(Bytes::from_static(b"four"))
        })) as nelcota_storage::UploadStream
    };
    let claims = nelcota_core::Claims::from_payload(json!({"role":"service_role"})).unwrap();
    let (first, second) = tokio::join!(
        app.storage.upload(
            claims.clone(),
            "docs",
            "one.txt",
            Default::default(),
            body()
        ),
        app.storage
            .upload(claims, "docs", "two.txt", Default::default(), body()),
    );
    assert!(first.is_ok(), "first upload failed: {:?}", first.err());
    assert!(second.is_ok(), "second upload failed: {:?}", second.err());
    let used: i64 = app
        .admin_client
        .query_one("SELECT bytes FROM storage.usage WHERE singleton", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(used, 8);
}

#[tokio::test]
async fn migration_exports_separate_statements_after_trailing_line_comments() {
    let app = TestApp::spawn().await;
    let statements = vec![
        "CREATE TEMP TABLE review_export (id int) -- keep this explanation".to_owned(),
        "INSERT INTO review_export VALUES (7) -- and the next statement".to_owned(),
    ];
    app.admin_client.execute("INSERT INTO nelcota.panel_changes (summary, statements, kind, target) VALUES ('Review export', $1, 'table_created', 'review_export')", &[&statements]).await.unwrap();
    let cookie = panel::login(&app).await;
    let reply = panel::send(
        &app,
        Method::POST,
        "/admin/api/migrations",
        &cookie,
        json!({"name":"review_export"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    app.admin_client
        .batch_execute(reply.body["sql"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        app.admin_client
            .query_one("SELECT id FROM review_export", &[])
            .await
            .unwrap()
            .get::<_, i32>(0),
        7
    );
}
