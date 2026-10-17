//! Dedicated SQL admission must include database cleanup after caller cancellation.
mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::TestApp;
use http_body_util::BodyExt;
use nelcota_admin::{SqlBusy, SqlExecutor, contracts::SqlResponse};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, oneshot},
    task::{JoinHandle, JoinSet},
    time::{Instant, timeout},
};
use tokio_postgres::{Config, config::Host};
use tower::ServiceExt;

/// Forward real PostgreSQL traffic, holding only CancelRequest packets until
/// the test releases them. No SQL, password or cancellation key is recorded.
struct CancelGate {
    address: SocketAddr,
    seen: Arc<AtomicUsize>,
    release: Arc<Notify>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl CancelGate {
    async fn start(config: &Config) -> Self {
        let host = match config.get_hosts() {
            [Host::Tcp(host)] if matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") => {
                host.clone()
            }
            _ => panic!("cancellation gate requires the owned loopback test database"),
        };
        let port = *config.get_ports().first().expect("test database port");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let seen = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let (stop, mut stopped) = oneshot::channel();
        let counted = seen.clone();
        let released = release.clone();
        let task = tokio::spawn(async move {
            let mut handlers = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    Some(_) = handlers.join_next(), if !handlers.is_empty() => {},
                    accepted = listener.accept() => {
                        let incoming = match accepted {
                            Ok((incoming, _)) => incoming,
                            Err(_) => break,
                        };
                        if handlers.len() >= 12 {
                            drop(incoming);
                            continue;
                        }
                        let host = host.clone();
                        let counted = counted.clone();
                        let released = released.clone();
                        handlers.spawn(async move {
                            let _ = timeout(Duration::from_secs(25), relay(incoming, &host, port, counted, released)).await;
                        });
                    },
                }
            }
            handlers.shutdown().await;
        });
        Self {
            address,
            seen,
            release,
            stop: Some(stop),
            task: Some(task),
        }
    }

    fn config(&self, source: &Config) -> Config {
        let mut config = Config::new();
        config.host("127.0.0.1").port(self.address.port());
        config.user(source.get_user().expect("test database user"));
        config.dbname(source.get_dbname().expect("owned test database name"));
        if let Some(password) = source.get_password() {
            config.password(password);
        }
        config
    }

    async fn close(mut self) {
        self.release.notify_waiters();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
    }
}

impl Drop for CancelGate {
    fn drop(&mut self) {
        self.release.notify_waiters();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn relay(
    mut incoming: TcpStream,
    host: &str,
    port: u16,
    seen: Arc<AtomicUsize>,
    release: Arc<Notify>,
) -> std::io::Result<()> {
    let mut header = [0_u8; 8];
    incoming.read_exact(&mut header).await?;
    let length = u32::from_be_bytes(header[..4].try_into().unwrap());
    if !(8..=65536).contains(&length) {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    // PostgreSQL's protocol-defined, unauthenticated CancelRequest discriminator.
    if length == 16 && u32::from_be_bytes(header[4..].try_into().unwrap()) == 80877102 {
        let released = release.notified();
        tokio::pin!(released);
        let _ = released.as_mut().enable();
        seen.fetch_add(1, Ordering::Release);
        released.await;
    }
    let mut upstream = TcpStream::connect((host, port)).await?;
    upstream.write_all(&header).await?;
    tokio::io::copy_bidirectional(&mut incoming, &mut upstream).await?;
    Ok(())
}

struct Queries(Vec<JoinHandle<Result<SqlResponse, SqlBusy>>>);

impl Drop for Queries {
    fn drop(&mut self) {
        for query in &self.0 {
            query.abort();
        }
    }
}

async fn active_sql(app: &TestApp) -> i64 {
    app.admin_client.query_one(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-sql' AND state='active'",
        &[],
    ).await.unwrap().get(0)
}

fn successful_read(result: Result<SqlResponse, SqlBusy>) -> bool {
    match result {
        Ok(SqlResponse::Success { results, .. }) => {
            results.len() == 1 && results[0].rows == vec![vec![Some("2".to_owned())]]
        }
        _ => false,
    }
}

async fn start_and_cancel_four(
    app: &TestApp,
    gate: &CancelGate,
    config: &Config,
    executor: &Arc<SqlExecutor>,
) -> i64 {
    let mut queries = Queries(Vec::new());
    for _ in 0..4 {
        let executor = executor.clone();
        let config = config.clone();
        queries.0.push(tokio::spawn(async move {
            executor.execute(&config, "SELECT pg_sleep(20)", None).await
        }));
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while active_sql(app).await != 4 {
        assert!(Instant::now() < deadline, "four SQL queries did not start");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    for query in &queries.0 {
        query.abort();
    }
    for query in queries.0.drain(..) {
        let cancelled = match query.await {
            Err(error) => error.is_cancelled(),
            Ok(_) => false,
        };
        assert!(cancelled);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while gate.seen.load(Ordering::Acquire) != 4 {
        assert!(
            Instant::now() < deadline,
            "real cancellation requests did not reach the gate"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    active_sql(app).await
}

async fn recover_sql(executor: &SqlExecutor, config: &Config, budget: Duration) -> Duration {
    let began = Instant::now();
    let deadline = began + budget;
    loop {
        let (a, b, c, d) = tokio::join!(
            executor.execute(config, "SELECT 2", None),
            executor.execute(config, "SELECT 2", None),
            executor.execute(config, "SELECT 2", None),
            executor.execute(config, "SELECT 2", None),
        );
        assert!(
            Instant::now() < deadline,
            "SQL admission did not recover after backend cleanup"
        );
        if [a, b, c, d].into_iter().all(successful_read) {
            return began.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn cancelled_sql_keeps_admission_until_postgres_finishes_cleanup() {
    let app = TestApp::spawn().await;
    let gate = CancelGate::start(&app.admin).await;
    let config = gate.config(&app.admin);
    let executor = Arc::new(SqlExecutor::default());
    let still_active = start_and_cancel_four(&app, &gate, &config, &executor).await;
    let fifth_is_busy = executor.execute(&config, "SELECT 1", None).await.is_err();
    let (api_status, rows) = app.get("/rest/v1/products?limit=1", None).await;
    let (negative_status, _) = app
        .get("/rest/v1/products?limit=1", Some("invalid-jwt"))
        .await;

    // Release every held packet before asserting the admission result, so the
    // intentionally failing before-fix control still cleans its owned queries.
    gate.release.notify_waiters();
    let deadline = Instant::now() + Duration::from_secs(3);
    while active_sql(&app).await != 0 {
        assert!(
            Instant::now() < deadline,
            "cancelled SQL did not finish cleanup"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    recover_sql(&executor, &config, Duration::from_secs(3)).await;
    gate.close().await;
    println!(
        "::notice title=G05 SQL cancellation admission::{}",
        serde_json::json!({
            "case": "cancelled_sql_keeps_admission_until_postgres_finishes_cleanup",
            "backend_queries_before_releasing_cancellation": still_active,
            "held_cancellation_packets": 4,
            "fifth_rejected_while_cleanup_pending": fifth_is_busy,
            "authorized_api_status": api_status.as_u16(),
            "unauthorized_api_status": negative_status.as_u16(),
            "backend_queries_after_release": 0,
            "recovered_parallel_read_queries": 4,
            "scope": "Real owned PostgreSQL and bounded loopback CancelRequest gate; no load-time credit"
        })
    );
    assert_eq!(
        still_active, 4,
        "the network fault did not retain active backend work"
    );
    assert_eq!(api_status, StatusCode::OK);
    assert_eq!(negative_status, StatusCode::UNAUTHORIZED);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert!(
        fifth_is_busy,
        "SQL admission reopened while four cancelled queries were still active"
    );
}

#[tokio::test]
async fn lost_sql_transport_has_bounded_cleanup_admission_and_recovers() {
    let app = TestApp::spawn().await;
    let gate = CancelGate::start(&app.admin).await;
    let config = gate.config(&app.admin);
    let executor = Arc::new(SqlExecutor::default());
    let still_active = start_and_cancel_four(&app, &gate, &config, &executor).await;
    // Only this TestApp's four SQL sessions are terminated. Other databases,
    // roles, the ordinary API pool and the cluster itself are unchanged.
    let terminated: i64 = app.admin_client.query_one(
        "SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-sql' AND pid<>pg_backend_pid()",
        &[],
    ).await.unwrap().get(0);
    gate.release.notify_waiters();
    let deadline = Instant::now() + Duration::from_secs(3);
    while active_sql(&app).await != 0 {
        assert!(
            Instant::now() < deadline,
            "owned SQL sessions did not terminate"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let blocked = executor.execute(&config, "SELECT 2", None).await.is_err();
    let (api_status, rows) = app.get("/rest/v1/products?limit=1", None).await;
    let recovered = recover_sql(&executor, &config, Duration::from_secs(40)).await;
    gate.close().await;
    println!(
        "::notice title=G05 SQL transport cleanup::{}",
        serde_json::json!({
            "case": "lost_sql_transport_has_bounded_cleanup_admission_and_recovers",
            "backend_queries_before_termination": still_active,
            "owned_sql_sessions_terminated": terminated,
            "admission_blocked_during_uncertain_cleanup": blocked,
            "recovered_parallel_read_queries": 4,
            "recovery_seconds": recovered.as_secs_f64(),
            "recovery_budget_seconds": 40,
            "authorized_api_status": api_status.as_u16(),
            "scope": "Owned database sessions only; bounded degraded cleanup, no load-time credit"
        })
    );
    assert_eq!(still_active, 4);
    assert_eq!(terminated, 4);
    assert!(blocked, "lost transport prematurely reopened SQL admission");
    assert!(
        recovered >= Duration::from_secs(34),
        "uncertain cleanup did not retain its declared grace"
    );
    assert_eq!(api_status, StatusCode::OK);
    assert_eq!(rows.as_array().unwrap().len(), 1);
}

async fn active_exports(app: &TestApp) -> i64 {
    app.admin_client.query_one(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nelcota-admin-export' AND state='active'",
        &[],
    ).await.unwrap().get(0)
}

async fn export_response(
    router: axum::Router,
    cookie: String,
    table: &str,
) -> axum::response::Response {
    router
        .oneshot(
            Request::builder()
                .uri(format!("/admin/api/tables/{table}/export?format=json"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn recover_exports(router: &axum::Router, cookie: &str, budget: Duration) -> Duration {
    let began = Instant::now();
    loop {
        let (a, b) = tokio::join!(
            export_response(router.clone(), cookie.to_owned(), "products"),
            export_response(router.clone(), cookie.to_owned(), "products"),
        );
        let mut valid = true;
        for response in [a, b] {
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let rows: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            valid &= status == StatusCode::OK
                && rows.as_array().is_some_and(|rows| {
                    let mut ids: Vec<_> = rows.iter().map(|row| row["id"].as_i64()).collect();
                    ids.sort();
                    ids == [Some(1), Some(2), Some(3), Some(4)]
                });
        }
        assert!(began.elapsed() < budget, "export admission did not recover");
        if valid {
            return began.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn cancelled_exports_keep_admission_until_postgres_finishes_cleanup() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute(
            "CREATE VIEW public.slow_cancel_export AS SELECT pg_sleep(20)::text AS value",
        )
        .await
        .unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let cookie = common::panel::login(&app).await;
    let gate = CancelGate::start(&app.admin).await;
    let panel = nelcota_admin::AdminState {
        db_config: gate.config(&app.admin),
        ..app.panel.clone()
    };
    let router = nelcota_admin::router(panel);
    let mut requests = JoinSet::new();
    for _ in 0..2 {
        let router = router.clone();
        let cookie = cookie.clone();
        requests.spawn(async move { export_response(router, cookie, "slow_cancel_export").await });
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while active_exports(&app).await != 2 {
        assert!(
            Instant::now() < deadline,
            "two export queries did not start"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    requests.abort_all();
    while let Some(result) = requests.join_next().await {
        assert!(result.unwrap_err().is_cancelled());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while gate.seen.load(Ordering::Acquire) != 2 {
        assert!(
            Instant::now() < deadline,
            "export cancellation did not reach the gate"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Exceed only the existing two-second cancellation write timeout. The
    // backend queries remain inside their original twenty-second sleep.
    tokio::time::sleep(Duration::from_millis(2200)).await;
    let still_active = active_exports(&app).await;
    let third = export_response(router.clone(), cookie.clone(), "products").await;
    let third_status = third.status();
    let third_body = third.into_body().collect().await.unwrap().to_bytes();
    let third_json: serde_json::Value = serde_json::from_slice(&third_body).unwrap();
    let (api_status, rows) = app.get("/rest/v1/products?limit=1", None).await;
    let (negative_status, _) = app
        .get("/rest/v1/products?limit=1", Some("invalid-jwt"))
        .await;
    gate.release.notify_waiters();
    let deadline = Instant::now() + Duration::from_secs(3);
    while active_exports(&app).await != 0 {
        assert!(
            Instant::now() < deadline,
            "cancelled export backend did not stop"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let recovered = recover_exports(&router, &cookie, Duration::from_secs(3)).await;
    gate.close().await;
    println!(
        "::notice title=G05 export cancellation admission::{}",
        serde_json::json!({
            "case": "cancelled_exports_keep_admission_until_postgres_finishes_cleanup",
            "backend_queries_before_releasing_cancellation": still_active,
            "held_cancellation_packets": 2,
            "third_export_status_while_cleanup_pending": third_status.as_u16(),
            "third_export_busy_code": third_json.get("code").and_then(|value| value.as_str()),
            "authorized_api_status": api_status.as_u16(),
            "unauthorized_api_status": negative_status.as_u16(),
            "backend_queries_after_release": 0,
            "recovered_parallel_exports": 2,
            "recovered_exact_product_ids": [1, 2, 3, 4],
            "recovery_seconds": recovered.as_secs_f64(),
            "scope": "Real owned PostgreSQL, two bounded export queries, delayed CancelRequest only; no load-time credit"
        })
    );
    assert_eq!(still_active, 2);
    assert_eq!(api_status, StatusCode::OK);
    assert_eq!(negative_status, StatusCode::UNAUTHORIZED);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(
        third_status,
        StatusCode::SERVICE_UNAVAILABLE,
        "export admission reopened before backend cleanup"
    );
    assert_eq!(third_json["code"], "export_busy");
}
