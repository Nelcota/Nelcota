use crate::{
    common::{TestApp, user_token},
    support,
};
use axum::http::{Method, StatusCode};
use nelcota_core::db;
use nelcota_webhooks::{management, models::HistoryQuery};
use serde_json::{Value, json};

#[tokio::test]
async fn capture_is_transactional_covers_every_verb_and_preserves_rls() {
    let app = TestApp::spawn().await;
    let first = support::hook(&app, "https://example.com/first", 6).await;
    let mut input = support::input("https://example.com/second");
    input.events = vec!["INSERT".into()];
    management::create(
        &db::admin_pool(&app.admin, 2),
        "public",
        input,
        Default::default(),
    )
    .await
    .unwrap();
    app.admin_client.batch_execute("BEGIN; INSERT INTO public.todos (user_id,title) VALUES (gen_random_uuid(),'rolled back'); ROLLBACK;").await.unwrap();
    assert_eq!(support::count(&app).await, 0);
    let token = user_token(app.user_a);
    let inserted = app
        .request(
            Method::POST,
            "/rest/v1/todos",
            Some(&token),
            Some(json!({"title":"New task"})),
        )
        .await;
    assert_eq!(inserted.status, StatusCode::CREATED, "{}", inserted.text);
    assert_eq!(support::count(&app).await, 2);
    let same: i64 = app
        .admin_client
        .query_one(
            "SELECT count(DISTINCT event_id) FROM nelcota.webhook_deliveries",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(same, 1);
    let id: i64 = app
        .admin_client
        .query_one("SELECT id FROM public.todos WHERE title='New task'", &[])
        .await
        .unwrap()
        .get(0);
    let hidden = app
        .request(
            Method::PATCH,
            &format!("/rest/v1/todos?id=eq.{id}"),
            Some(&user_token(app.user_b)),
            Some(json!({"title":"Not yours"})),
        )
        .await;
    assert_eq!(hidden.status, StatusCode::NO_CONTENT);
    assert_eq!(support::count(&app).await, 2);
    let updated = app
        .request(
            Method::PATCH,
            &format!("/rest/v1/todos?id=eq.{id}"),
            Some(&token),
            Some(json!({"title":"Changed"})),
        )
        .await;
    assert_eq!(updated.status, StatusCode::NO_CONTENT);
    assert_eq!(support::count(&app).await, 3);
    let deleted = app
        .request(
            Method::DELETE,
            &format!("/rest/v1/todos?id=eq.{id}"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert_eq!(support::count(&app).await, 4);
    let pool = db::admin_pool(&app.admin, 2);
    let history = management::history(
        &pool,
        HistoryQuery {
            endpoint: Some(first.endpoint.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(history.deliveries.len(), 3);
    let payload: Value = serde_json::from_str(
        &management::detail(&pool, &history.deliveries[0].id)
            .await
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(payload["type"], "DELETE");
    assert!(payload["record"].is_null());
    assert_eq!(payload["old_record"]["title"], "Changed");
    let update: Value = serde_json::from_str(
        &management::detail(&pool, &history.deliveries[1].id)
            .await
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(update["old_record"]["title"], "New task");
    assert_eq!(update["record"]["title"], "Changed");
    for role in ["anon", "authenticated", "service_role"] {
        let denied: bool=app.admin_client.query_one("SELECT NOT has_table_privilege($1::text,'nelcota.webhook_endpoints','SELECT') AND NOT has_table_privilege($1::text,'nelcota.webhook_deliveries','SELECT') AND NOT has_function_privilege($1::text,'nelcota.capture_webhook_event()','EXECUTE')", &[&role]).await.unwrap().get(0);
        assert!(denied, "{role}");
    }
    let usage = app
        .admin_client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(usage.get::<_, i64>(0), 4);
    assert_eq!(usage.get::<_, i64>(1), 4);
}

#[tokio::test]
async fn pause_rename_delete_and_large_payload_have_explicit_outcomes() {
    let app = TestApp::spawn().await;
    let hook = support::hook(&app, "https://example.com/hook", 6).await;
    let pool = db::admin_pool(&app.admin, 2);
    let mut paused = support::input(&hook.endpoint.url);
    paused.enabled = false;
    management::update(&pool, &hook.endpoint.id, paused, Default::default())
        .await
        .unwrap();
    support::insert(&app, "not captured").await;
    assert_eq!(support::count(&app).await, 0);
    management::update(
        &pool,
        &hook.endpoint.id,
        support::input(&hook.endpoint.url),
        Default::default(),
    )
    .await
    .unwrap();
    app.admin_client
        .batch_execute("ALTER TABLE public.todos RENAME TO tasks")
        .await
        .unwrap();
    app.admin_client
        .execute(
            "INSERT INTO public.tasks (user_id,title) VALUES ($1,'renamed')",
            &[&app.user_a],
        )
        .await
        .unwrap();
    assert_eq!(management::list(&pool).await.unwrap()[0].table, "tasks");
    assert_eq!(support::count(&app).await, 1);
    let large = "a".repeat(300_000);
    app.admin_client
        .execute(
            "INSERT INTO public.tasks (user_id,title) VALUES ($1,$2)",
            &[&app.user_a, &large],
        )
        .await
        .unwrap();
    let id = support::latest(&app).await;
    let detail = management::detail(&pool, &id).await.unwrap();
    assert_eq!(detail.delivery.status, "failed");
    assert_eq!(
        detail.delivery.last_error.as_deref(),
        Some("payload_too_large")
    );
    assert!(detail.payload.len() < 1024);
    assert_eq!(detail.delivery.attempts, 0);
    assert!(management::replay(&pool, &id).await.is_err());
    management::delete(&pool, &hook.endpoint.id).await.unwrap();
    let active: i64 = app
        .admin_client
        .query_one("SELECT outstanding FROM nelcota.webhook_queue_usage", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(active, 0);
    let original = app
        .admin_client
        .query_one(
            "SELECT status FROM nelcota.webhook_deliveries ORDER BY id LIMIT 1",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(original.get::<_, &str>(0), "cancelled");
    assert_eq!(management::clear_history(&pool).await.unwrap(), 2);
    assert_eq!(
        app.admin_client
            .query_one("SELECT retained FROM nelcota.webhook_queue_usage", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
}

#[tokio::test]
async fn keyset_history_pages_and_clearing_keeps_active_work() {
    let app = TestApp::spawn().await;
    support::hook(&app, "https://example.com/hook", 6).await;
    let pool = db::admin_pool(&app.admin, 2);
    app.admin_client.execute("INSERT INTO public.todos (user_id,title) SELECT $1,'page '||n FROM generate_series(1,31) n", &[&app.user_a]).await.unwrap();
    let first = management::history(&pool, Default::default())
        .await
        .unwrap();
    assert_eq!(first.deliveries.len(), 25);
    assert!(first.next_cursor.is_some());
    let second = management::history(
        &pool,
        HistoryQuery {
            before: first.next_cursor,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(second.deliveries.len(), 6);
    assert!(second.next_cursor.is_none());
    assert!(
        first
            .deliveries
            .iter()
            .all(|d| second.deliveries.iter().all(|other| other.id != d.id))
    );
    assert_eq!(
        management::clear_history(&pool).await.unwrap(),
        0,
        "active deliveries cannot be cleared"
    );
}

async fn outcomes(app: &TestApp, endpoint: &str) -> Vec<(String, Option<String>)> {
    app.admin_client
        .query(
            "SELECT status,last_error FROM nelcota.webhook_deliveries WHERE endpoint_id=$1::text::uuid ORDER BY id",
            &[&endpoint],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect()
}

#[tokio::test]
async fn overflow_is_a_visible_failure_per_webhook_and_the_write_commits() {
    let app = TestApp::spawn().await;
    let full = support::hook(&app, "https://example.com/full", 6).await;
    let healthy = support::hook(&app, "https://example.com/healthy", 6).await;
    let pool = db::admin_pool(&app.admin, 2);
    // One delivery below the per-webhook limit, as if its destination stalled.
    app.admin_client
        .execute(
            "UPDATE nelcota.webhook_queue_shards SET outstanding=9999 WHERE endpoint_id=$1::text::uuid AND shard=0",
            &[&full.endpoint.id],
        )
        .await
        .unwrap();
    // The limit is counted per row, also inside one statement.
    app.admin_client.execute("INSERT INTO public.todos (user_id,title) SELECT $1,'burst '||n FROM generate_series(1,3) n", &[&app.user_a]).await.unwrap();
    let inserted = app
        .request(
            Method::POST,
            "/rest/v1/todos",
            Some(&user_token(app.user_a)),
            Some(json!({"title":"after the limit"})),
        )
        .await;
    assert_eq!(inserted.status, StatusCode::CREATED, "{}", inserted.text);
    let committed: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM public.todos WHERE title LIKE 'burst %' OR title='after the limit'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(committed, 4);
    let pending = (String::from("pending"), None);
    let failed = (String::from("failed"), Some(String::from("queue_full")));
    assert_eq!(
        outcomes(&app, &full.endpoint.id).await,
        vec![pending.clone(), failed.clone(), failed.clone(), failed]
    );
    let unaffected = outcomes(&app, &healthy.endpoint.id).await;
    assert_eq!(unaffected, vec![pending; 4]);
    let id: String = app
        .admin_client
        .query_one(
            "SELECT id::text FROM nelcota.webhook_deliveries WHERE last_error='queue_full' ORDER BY id DESC LIMIT 1",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    let detail = management::detail(&pool, &id).await.unwrap();
    assert_eq!(detail.delivery.attempts, 0);
    assert!(detail.delivery.finished_at.is_some());
    let payload: Value = serde_json::from_str(&detail.payload).unwrap();
    assert_eq!(payload["payload_omitted"], true);
    assert_eq!(payload["type"], "INSERT");
    assert!(payload["record"].is_null());
    assert!(management::replay(&pool, &id).await.is_err());
    let outstanding: i64 = app
        .admin_client
        .query_one("SELECT outstanding FROM nelcota.webhook_queue_usage", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(outstanding, 10_000 + 4);
}

#[tokio::test]
async fn concurrent_writers_and_the_worker_do_not_wait_for_one_counter() {
    use std::time::Duration;
    let app = TestApp::spawn().await;
    let receiver = support::Receiver::new([]).await;
    support::hook(&app, &receiver.url, 6).await;
    support::insert(&app, "already queued").await;
    let queued = support::latest(&app).await;
    let (mut first, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let holding = first.transaction().await.unwrap();
    holding
        .execute(
            "INSERT INTO public.todos (user_id,title) VALUES ($1,'held open')",
            &[&app.user_a],
        )
        .await
        .unwrap();
    // The open writer keeps its counter row locked. A second writer must not
    // queue behind it: with one global counter row this hits lock_timeout.
    let (mut second, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let other = second.transaction().await.unwrap();
    other
        .batch_execute("SET LOCAL lock_timeout = '1s'")
        .await
        .unwrap();
    other
        .execute(
            "INSERT INTO public.todos (user_id,title) VALUES ($1,'concurrent')",
            &[&app.user_a],
        )
        .await
        .unwrap();
    // The worker saves its result while both writers are still open.
    let worker = support::worker(&app);
    tokio::time::timeout(Duration::from_secs(5), worker.run_once())
        .await
        .unwrap()
        .unwrap();
    let status: String = app
        .admin_client
        .query_one(
            "SELECT status FROM nelcota.webhook_deliveries WHERE id=$1::text::bigint",
            &[&queued],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(status, "succeeded");
    other.commit().await.unwrap();
    holding.commit().await.unwrap();
    let usage = app
        .admin_client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(usage.get::<_, i64>(0), 2);
    assert_eq!(usage.get::<_, i64>(1), 3);
}

#[tokio::test]
async fn deletion_does_not_deadlock_a_writer_and_truncation_resets_capacity() {
    use std::time::Duration;
    let app = TestApp::spawn().await;
    let hook = support::hook(&app, "https://example.com/hook", 6).await;
    support::insert(&app, "existing pending delivery").await;
    let (mut writer, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let tx = writer.transaction().await.unwrap();
    tx.batch_execute("LOCK TABLE public.todos IN ROW EXCLUSIVE MODE")
        .await
        .unwrap();
    let pool = db::admin_pool(&app.admin, 2);
    let id = hook.endpoint.id.clone();
    let deleting = tokio::spawn(async move { management::delete(&pool, &id).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let waiting: bool = app.admin_client.query_one("SELECT EXISTS (SELECT FROM pg_locks WHERE relation='public.todos'::regclass AND NOT granted)", &[]).await.unwrap().get(0);
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        tx.execute(
            "INSERT INTO public.todos (user_id,title) VALUES ($1,'writer while deleting')",
            &[&app.user_a],
        ),
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), deleting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(support::count(&app).await, 2);
    let statuses: Vec<String> = app
        .admin_client
        .query("SELECT status FROM nelcota.webhook_deliveries", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(statuses.iter().all(|s| s == "cancelled"));
    app.admin_client
        .batch_execute("TRUNCATE nelcota.webhook_deliveries CASCADE")
        .await
        .unwrap();
    let usage = app
        .admin_client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(usage.get::<_, i64>(0), 0);
    assert_eq!(usage.get::<_, i64>(1), 0);
}
