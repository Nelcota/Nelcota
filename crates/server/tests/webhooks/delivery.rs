use crate::{
    common::{
        TestApp,
        panel::{get, login, send},
        user_token,
    },
    support::{self, Receiver},
};
use axum::http::{Method, StatusCode};
use nelcota_core::db;
use nelcota_webhooks::{Worker, destination::Policy, management, signing};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::Notify;

#[tokio::test]
async fn fast_destinations_refill_worker_slots_without_waiting_for_each_poll() {
    let app = TestApp::spawn().await;
    let receiver = Receiver::with_options([204], None, None).await;
    support::hook(&app, &receiver.url, 3).await;
    app.admin_client.execute("INSERT INTO public.todos(user_id,title) SELECT $1,'burst ' || i FROM generate_series(1,64) i", &[&app.user_a]).await.unwrap();
    let worker = support::worker(&app).spawn();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        while receiver.requests().len() < 64 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    worker.shutdown().await;
    assert!(
        completed.is_ok(),
        "Fast destinations were capped by the idle poll interval: {} delivered",
        receiver.requests().len()
    );
    let events: std::collections::HashSet<_> = receiver
        .requests()
        .iter()
        .map(|request| {
            request.headers["x-nelcota-event-id"]
                .to_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(events.len(), 64);
    let succeeded: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM nelcota.webhook_deliveries WHERE status='succeeded'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(succeeded, 64);
}

#[tokio::test]
async fn signed_delivery_retries_then_replay_preserves_original_history() {
    let app = TestApp::spawn().await;
    let receiver = Receiver::with_options([503, 204, 204], None, Some("30")).await;
    let hook = support::hook(&app, &receiver.url, 6).await;
    support::insert(&app, "Hello world").await;
    let id = support::latest(&app).await;
    let pool = db::admin_pool(&app.admin, 2);
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    let first = management::detail(&pool, &id).await.unwrap();
    assert_eq!(first.delivery.status, "pending");
    assert_eq!(first.delivery.attempts, 1);
    assert_eq!(first.attempts[0].status_code, Some(503));
    let seconds: f64=app.admin_client.query_one("SELECT extract(epoch FROM next_attempt_at-clock_timestamp())::float8 FROM nelcota.webhook_deliveries WHERE id=$1::text::bigint", &[&id]).await.unwrap().get(0);
    assert!(seconds > 25.0 && seconds <= 30.0);
    assert!(management::replay(&pool, &id).await.is_err());
    assert_eq!(
        support::worker(&app).run_once().await.unwrap(),
        0,
        "scheduled retry cannot run early"
    );
    support::make_due(&app).await;
    // New worker/pool: work and attempt history survive process reconstruction.
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    let detail = management::detail(&pool, &id).await.unwrap();
    assert_eq!(detail.delivery.status, "succeeded");
    assert_eq!(detail.delivery.attempts, 2);
    assert_eq!(detail.attempts.len(), 2);
    let requests = receiver.requests();
    assert_eq!(requests.len(), 2);
    for request in &requests {
        let event_id = request.headers["x-nelcota-event-id"].to_str().unwrap();
        let timestamp = request.headers["x-nelcota-timestamp"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert_eq!(
            request.headers["x-nelcota-signature"],
            signing::signature(
                hook.secret.expose(),
                event_id,
                timestamp,
                request.body.as_bytes()
            )
        );
        assert_eq!(request.headers["x-nelcota-delivery-id"], id);
        let payload: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(payload["id"], event_id);
        assert_eq!(payload["record"]["title"], "Hello world");
    }
    assert_eq!(requests[0].body, requests[1].body);
    let cookie = login(&app).await;
    let history = get(
        &app,
        &format!("/admin/api/webhooks/deliveries/{id}"),
        &cookie,
    )
    .await;
    assert_eq!(history.status, StatusCode::OK, "{}", history.text);
    assert!(!history.text.contains(hook.secret.expose()));
    assert!(!history.text.contains("a-sensitive-value"));
    let replay = send(
        &app,
        Method::POST,
        &format!("/admin/api/webhooks/deliveries/{id}/replay"),
        &cookie,
        json!({}),
    )
    .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.text);
    let new_id = replay.body["id"].as_str().unwrap();
    assert_ne!(new_id, id);
    assert_eq!(
        send(
            &app,
            Method::POST,
            &format!("/admin/api/webhooks/deliveries/{id}/replay"),
            &cookie,
            json!({})
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    let replay_detail = management::detail(&pool, new_id).await.unwrap();
    assert_eq!(replay_detail.delivery.event_id, detail.delivery.event_id);
    assert_eq!(replay_detail.payload, detail.payload);
    assert_eq!(
        replay_detail.delivery.replay_of.as_deref(),
        Some(id.as_str())
    );
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    assert_eq!(
        management::detail(&pool, &id).await.unwrap().attempts.len(),
        2
    );
    assert_eq!(
        management::detail(&pool, new_id)
            .await
            .unwrap()
            .delivery
            .status,
        "succeeded"
    );
    let usage = app
        .admin_client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(usage.get::<_, i64>(0), 0);
    assert_eq!(usage.get::<_, i64>(1), 2);
}

#[tokio::test]
async fn redirects_permanent_failures_and_retry_exhaustion_are_terminal() {
    let app = TestApp::spawn().await;
    let receiver = Receiver::new([302, 400, 503, 503]).await;
    let hook = support::hook(&app, &receiver.url, 2).await;
    let pool = db::admin_pool(&app.admin, 2);
    for expected in [302, 400] {
        support::insert(&app, "permanent").await;
        let id = support::latest(&app).await;
        support::worker(&app).run_once().await.unwrap();
        let detail = management::detail(&pool, &id).await.unwrap();
        assert_eq!(detail.delivery.status, "failed");
        assert_eq!(detail.delivery.attempts, 1);
        assert_eq!(detail.delivery.last_status, Some(expected));
    }
    assert_eq!(receiver.requests().len(), 2, "redirect was not followed");
    support::insert(&app, "retry twice").await;
    let id = support::latest(&app).await;
    support::worker(&app).run_once().await.unwrap();
    support::make_due(&app).await;
    support::worker(&app).run_once().await.unwrap();
    let detail = management::detail(&pool, &id).await.unwrap();
    assert_eq!(detail.delivery.status, "failed");
    assert_eq!(detail.delivery.attempts, 2);
    assert_eq!(detail.attempts.len(), 2);
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 0);
    assert_eq!(receiver.requests().len(), 4);
    let mut paused = support::input(&receiver.url);
    paused.enabled = false;
    management::update(
        &pool,
        &hook.endpoint.id,
        paused,
        Policy {
            allow_loopback: true,
        },
    )
    .await
    .unwrap();
    assert!(management::replay(&pool, &id).await.is_err());
}

#[tokio::test]
async fn leases_recover_without_holding_connections_and_fence_old_workers() {
    let app = TestApp::spawn().await;
    let release = Arc::new(Notify::new());
    let receiver = Receiver::with_options([204, 204], Some(release.clone()), None).await;
    support::hook(&app, &receiver.url, 3).await;
    support::insert(&app, "recover me").await;
    let id = support::latest(&app).await;
    let pool = db::admin_pool(&app.admin, 1);
    let first = Worker::new(
        pool.clone(),
        Policy {
            allow_loopback: true,
        },
    )
    .unwrap();
    let running = tokio::spawn(async move { first.run_once().await.unwrap() });
    receiver.wait_for(1).await;
    let client = tokio::time::timeout(Duration::from_millis(500), pool.get())
        .await
        .expect("HTTP must return its database connection")
        .unwrap();
    client.execute("UPDATE nelcota.webhook_deliveries SET locked_until=clock_timestamp()-interval '1 second' WHERE id=$1::text::bigint", &[&id]).await.unwrap();
    drop(client);
    let second = Worker::new(
        pool.clone(),
        Policy {
            allow_loopback: true,
        },
    )
    .unwrap();
    assert_eq!(second.run_once().await.unwrap(), 1);
    release.notify_one();
    assert_eq!(running.await.unwrap(), 1);
    let detail = management::detail(&pool, &id).await.unwrap();
    assert_eq!(detail.delivery.status, "succeeded");
    assert_eq!(detail.delivery.attempts, 2);
    assert_eq!(detail.attempts[0].status_code, Some(204));
    assert_eq!(
        detail.attempts[1].error.as_deref(),
        Some("worker_interrupted")
    );
    assert_eq!(
        detail.attempts[1].status_code, None,
        "late acknowledgement must not overwrite the recovered attempt"
    );
    assert_eq!(receiver.requests()[0].body, receiver.requests()[1].body);
}

#[tokio::test]
async fn parallel_workers_do_not_claim_the_same_live_deliveries() {
    let app = TestApp::spawn().await;
    let receiver = Receiver::new([]).await;
    // Four webhooks, so the per-webhook in-flight limit leaves work for both.
    for _ in 0..4 {
        support::hook(&app, &receiver.url, 3).await;
    }
    for n in 0..2 {
        support::insert(&app, &format!("parallel {n}")).await;
    }
    let a = support::worker(&app);
    let b = support::worker(&app);
    let mut claimed = 0;
    for _ in 0..4 {
        let (first, second) = tokio::join!(a.run_once(), b.run_once());
        claimed += first.unwrap() + second.unwrap();
    }
    assert_eq!(claimed, 8);
    let requests = receiver.requests();
    assert_eq!(requests.len(), 8);
    let ids: std::collections::BTreeSet<_> = requests
        .iter()
        .map(|r| r.headers["x-nelcota-delivery-id"].to_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 8);
    assert_eq!(app.admin_client.query_one("SELECT count(*) FROM nelcota.webhook_deliveries WHERE status='succeeded' AND attempts=1", &[]).await.unwrap().get::<_,i64>(0),8);
}

#[tokio::test]
async fn a_slow_backlog_cannot_take_every_worker_slot_from_other_webhooks() {
    let app = TestApp::spawn().await;
    let busy = Receiver::new([]).await;
    let other = Receiver::new([]).await;
    support::hook(&app, &busy.url, 3).await;
    for n in 0..6 {
        support::insert(&app, &format!("backlog {n}")).await;
    }
    // Created later: its only delivery is newer than the whole backlog.
    support::hook(&app, &other.url, 3).await;
    support::insert(&app, "newer event").await;
    // One claim of four slots: at most two for the backlog, one for the other.
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 3);
    assert_eq!(busy.requests().len(), 2);
    assert_eq!(other.requests().len(), 1);
    let waiting: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM nelcota.webhook_deliveries WHERE status='pending'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(waiting, 5);
    // A lease held elsewhere counts against the limit until it ends.
    app.admin_client.batch_execute("UPDATE nelcota.webhook_deliveries SET status='processing',attempts=1,lease_token=gen_random_uuid(),locked_until=clock_timestamp()+interval '1 minute' WHERE id=(SELECT min(id) FROM nelcota.webhook_deliveries WHERE status='pending')").await.unwrap();
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    assert_eq!(busy.requests().len(), 3);
}

#[tokio::test]
async fn paused_queue_current_key_and_new_replay_destination_are_respected() {
    let app = TestApp::spawn().await;
    let original = Receiver::new([204]).await;
    let replacement = Receiver::new([204]).await;
    let hook = support::hook(&app, &original.url, 3).await;
    support::insert(&app, "stable payload").await;
    let id = support::latest(&app).await;
    let pool = db::admin_pool(&app.admin, 2);
    let mut input = support::input(&replacement.url);
    input.enabled = false;
    management::update(
        &pool,
        &hook.endpoint.id,
        input,
        Policy {
            allow_loopback: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 0);
    assert!(original.requests().is_empty());
    let rotated = management::rotate(&pool, &hook.endpoint.id).await.unwrap();
    management::update(
        &pool,
        &hook.endpoint.id,
        support::input(&replacement.url),
        Policy {
            allow_loopback: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    assert_eq!(original.requests().len(), 1);
    assert!(replacement.requests().is_empty());
    let first = original.requests().pop().unwrap();
    let event_id = first.headers["x-nelcota-event-id"].to_str().unwrap();
    let ts = first.headers["x-nelcota-timestamp"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        first.headers["x-nelcota-signature"],
        signing::signature(rotated.secret.expose(), event_id, ts, first.body.as_bytes())
    );
    let replay = management::replay(&pool, &id).await.unwrap();
    support::worker(&app).run_once().await.unwrap();
    assert_eq!(replacement.requests().len(), 1);
    assert_eq!(
        management::detail(&pool, &replay)
            .await
            .unwrap()
            .delivery
            .url,
        replacement.url
    );
}

#[tokio::test]
async fn interrupted_paused_and_exhausted_leases_recover_and_retention_keeps_pending() {
    let app = TestApp::spawn().await;
    let receiver = Receiver::new([204]).await;
    let resumable = support::hook(&app, &receiver.url, 6).await;
    let exhausted = support::hook(&app, &receiver.url, 1).await;
    support::insert(&app, "interrupted").await;
    let pool = db::admin_pool(&app.admin, 2);
    let mut paused = support::input(&receiver.url);
    paused.enabled = false;
    management::update(
        &pool,
        &resumable.endpoint.id,
        paused,
        Policy {
            allow_loopback: true,
        },
    )
    .await
    .unwrap();
    app.admin_client.batch_execute("UPDATE nelcota.webhook_deliveries SET status='processing',attempts=1,lease_token=gen_random_uuid(),locked_until=clock_timestamp()-interval '1 second'; INSERT INTO nelcota.webhook_attempts (delivery_id,number) SELECT id,1 FROM nelcota.webhook_deliveries;").await.unwrap();
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 0);
    assert!(receiver.requests().is_empty());
    let rows = app
        .admin_client
        .query(
            "SELECT endpoint_id::text,status,attempts FROM nelcota.webhook_deliveries",
            &[],
        )
        .await
        .unwrap();
    for row in rows {
        assert_eq!(row.get::<_, i32>(2), 1);
        let status: &str = row.get(1);
        match row.get::<_, String>(0) == resumable.endpoint.id {
            true => {
                assert_eq!(status, "pending");
            }
            false => {
                assert_eq!(row.get::<_, String>(0), exhausted.endpoint.id);
                assert_eq!(status, "failed");
            }
        }
    }
    app.admin_client.batch_execute("UPDATE nelcota.webhook_deliveries SET created_at=clock_timestamp()-interval '8 days',finished_at=CASE WHEN status='failed' THEN clock_timestamp()-interval '8 days' END").await.unwrap();
    let handle = support::worker(&app).spawn();
    tokio::time::timeout(Duration::from_secs(3), async {
        while support::count(&app).await != 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    handle.shutdown().await;
    let usage = app
        .admin_client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(usage.get::<_, i64>(0), 1);
    assert_eq!(usage.get::<_, i64>(1), 1);
    management::update(
        &pool,
        &resumable.endpoint.id,
        support::input(&receiver.url),
        Policy {
            allow_loopback: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    let detail = management::detail(&pool, &support::latest(&app).await)
        .await
        .unwrap();
    assert_eq!(detail.delivery.status, "succeeded");
    assert_eq!(detail.delivery.attempts, 2);
    assert_eq!(
        detail.attempts[1].error.as_deref(),
        Some("worker_interrupted")
    );
    assert_eq!(receiver.requests().len(), 1);
}

#[tokio::test]
async fn history_beyond_the_old_cap_never_blocks_writes_and_is_pruned_to_its_limit() {
    let app = TestApp::spawn().await;
    let receiver = Receiver::new([]).await;
    let hook = support::hook(&app, &receiver.url, 3).await;
    let pool = db::admin_pool(&app.admin, 2);
    // A busy week: more terminal history than the old 100,000-row admission cap.
    app.admin_client.execute("INSERT INTO nelcota.webhook_deliveries (endpoint_id,event_id,schema_name,table_name,event,url,payload,max_attempts,status,attempts,finished_at) SELECT $1::text::uuid,gen_random_uuid(),'public','todos','INSERT','https://example.com/old','{}',3,'succeeded',1,clock_timestamp()-interval '1 hour' FROM generate_series(1,100005)", &[&hook.endpoint.id]).await.unwrap();
    let oldest: i64 = app
        .admin_client
        .query_one("SELECT min(id) FROM nelcota.webhook_deliveries", &[])
        .await
        .unwrap()
        .get(0);
    let inserted = app
        .request(
            Method::POST,
            "/rest/v1/todos",
            Some(&user_token(app.user_a)),
            Some(json!({"title":"after a busy week"})),
        )
        .await;
    assert_eq!(inserted.status, StatusCode::CREATED, "{}", inserted.text);
    assert_eq!(support::worker(&app).run_once().await.unwrap(), 1);
    let newest = support::latest(&app).await;
    let handle = support::worker(&app).spawn();
    let pruned = tokio::time::timeout(Duration::from_secs(10), async {
        while support::count(&app).await != 100_000 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    handle.shutdown().await;
    let remaining = support::count(&app).await;
    assert!(pruned.is_ok(), "{remaining} deliveries kept");
    let detail = management::detail(&pool, &newest).await.unwrap();
    assert_eq!(detail.delivery.status, "succeeded");
    let kept: i64 = app
        .admin_client
        .query_one("SELECT min(id) FROM nelcota.webhook_deliveries", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(kept, oldest + 6, "the oldest terminal rows go first");
    assert_eq!(receiver.requests().len(), 1);
}
