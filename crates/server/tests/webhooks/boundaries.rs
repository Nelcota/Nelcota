use crate::{
    common::{TestApp, user_token},
    support::{self, Receiver},
};
use axum::http::{Method, StatusCode};
use futures_util::future::join_all;
use nelcota_core::db;
use nelcota_webhooks::{Error, management, models::HistoryQuery, signing};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn full_retained_history_rejects_concurrent_writes_and_recovers_without_data_loss() {
    let app = TestApp::spawn().await;
    let receiver = Receiver::new([204, 204]).await;
    let hook = support::hook(&app, &receiver.url, 3).await;
    let token = user_token(app.user_a);
    let accepted = app
        .post(
            "/rest/v1/todos",
            Some(&token),
            json!({"title":"g05 history accepted before capacity"}),
        )
        .await;
    assert_eq!(accepted.status, StatusCode::CREATED, "{}", accepted.text);
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    let original_delivery = support::latest(&app).await;

    // Seed actual captured events, not a forged usage counter. Explicitly
    // cancelled fixture events exercise terminal-history admission without
    // sending 99,999 requests or claiming that cancelled work was delivered.
    for count in [10_000_i32; 9].into_iter().chain([9_999]) {
        let inserted = app
            .admin_client
            .execute(
                "INSERT INTO public.todos(user_id,title) SELECT $1,'g05 history fixture '||n FROM generate_series(1,$2::integer)n",
                &[&app.user_a, &count],
            )
            .await
            .unwrap();
        assert_eq!(inserted, count as u64);
        let cancelled = app
            .admin_client
            .execute(
                "UPDATE nelcota.webhook_deliveries SET status='cancelled',finished_at=clock_timestamp() WHERE status='pending'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(cancelled, count as u64);
    }
    let usage = app
        .admin_client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(usage.get::<_, i64>(0), 0);
    assert_eq!(usage.get::<_, i64>(1), 100_000);
    assert_eq!(support::count(&app).await, 100_000);

    let attempts = (0..16).map(|index| {
        app.post(
            "/rest/v1/todos",
            Some(&token),
            json!({"title":format!("g05 capacity rejected {index}")}),
        )
    });
    let rejected = tokio::time::timeout(Duration::from_secs(10), join_all(attempts))
        .await
        .expect("full-history admission must release concurrent callers");
    for reply in rejected {
        assert_eq!(
            reply.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            reply.text
        );
        assert_eq!(reply.body["code"], "unavailable");
        assert_eq!(reply.body["sqlstate"], "53300");
    }
    let partial: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM public.todos WHERE title LIKE 'g05 capacity rejected %'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        partial, 0,
        "rejected business writes must roll back with enqueue"
    );
    assert_eq!(support::count(&app).await, 100_000);

    let pool = db::admin_pool(&app.admin, 2);
    let history = management::history(&pool, HistoryQuery::default())
        .await
        .unwrap();
    assert_eq!(history.deliveries.len(), 25);
    assert!(
        history.next_cursor.is_some(),
        "status stays readable at capacity"
    );
    let error = match management::replay(&pool, &original_delivery)
        .await
        .unwrap_err()
    {
        Error::Database(error) => error,
        _ => panic!("replay must reach the same database admission boundary"),
    };
    assert_eq!(error.code().unwrap().code(), "53300");
    let (status, rows) = app
        .get("/rest/v1/todos?title=like.g05*&limit=1", Some(&token))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    let (status, hidden) = app
        .get(
            "/rest/v1/todos?title=like.g05*&limit=1",
            Some(&user_token(app.user_b)),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hidden, json!([]));
    let (status, _) = app.get("/rest/v1/todos?limit=1", Some("malformed")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // No maintenance happens before the full-limit rejection. The documented
    // explicit clear is the recovery action; it cannot delete business rows.
    assert_eq!(management::clear_history(&pool).await.unwrap(), 100_000);
    let preserved: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM public.todos WHERE title LIKE 'g05 history %'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(preserved, 100_000);
    let recovered = app
        .request(
            Method::POST,
            "/rest/v1/todos",
            Some(&token),
            Some(json!({"title":"g05 recovered after explicit clear"})),
        )
        .await;
    assert_eq!(recovered.status, StatusCode::CREATED, "{}", recovered.text);
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    let deliveries = receiver.requests();
    assert_eq!(deliveries.len(), 2);
    for delivery in &deliveries {
        let event = delivery.headers["x-nelcota-event-id"].to_str().unwrap();
        let timestamp = delivery.headers["x-nelcota-timestamp"]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            delivery.headers["x-nelcota-signature"],
            signing::signature(
                hook.secret.expose(),
                event,
                timestamp,
                delivery.body.as_bytes()
            )
        );
    }
    let usage = app
        .admin_client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(usage.get::<_, i64>(0), 0);
    assert_eq!(usage.get::<_, i64>(1), 1);
}
