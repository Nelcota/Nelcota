//! Resource budgets and credential/log hygiene, against the production router.
mod common;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
};
use bytes::Bytes;
use common::{ADMIN_EMAIL, ADMIN_PASSWORD, Options, TestApp, service_token};
use futures_util::stream;
use nelcota_core::{Claims, db::begin_request};
use nelcota_storage::UploadOptions;
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

#[tokio::test]
async fn mail_delivery_overload_does_not_issue_tokens_or_reveal_accounts() {
    struct SlowMailer {
        started: tokio::sync::mpsc::Sender<()>,
        release: Arc<tokio::sync::Semaphore>,
    }
    impl nelcota_auth::Mailer for SlowMailer {
        fn send(
            &self,
            _: nelcota_auth::Email,
        ) -> futures_util::future::BoxFuture<'_, Result<(), nelcota_auth::MailError>> {
            Box::pin(async {
                self.started.send(()).await.unwrap();
                self.release.acquire().await.unwrap().forget();
                Ok(())
            })
        }
    }
    let (started, mut receiver) = tokio::sync::mpsc::channel(16);
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let app = TestApp::spawn_with(Options {
        mailer: Some(Arc::new(SlowMailer {
            started,
            release: release.clone(),
        })),
        confirm_email: true,
        ..Options::default()
    })
    .await;
    app.admin_client.batch_execute("INSERT INTO auth.users(email) SELECT 'mail-budget-' || n || '@example.com' FROM generate_series(1,17) n").await.unwrap();
    for n in 1..=16 {
        let reply = app
            .post(
                "/auth/v1/recover",
                None,
                json!({"email":format!("mail-budget-{n}@example.com")}),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
    }
    for path in ["/auth/v1/recover", "/auth/v1/magiclink", "/auth/v1/resend"] {
        for email in ["mail-budget-17@example.com", "unknown@example.com"] {
            let reply = app
                .post(path, None, json!({"email":email,"type":"signup"}))
                .await;
            assert_eq!(
                reply.status,
                StatusCode::SERVICE_UNAVAILABLE,
                "{path}: {}",
                reply.body
            );
            assert_eq!(reply.body["code"], "mail_busy");
        }
    }
    let reply = app
        .post(
            "/auth/v1/signup",
            None,
            json!({"email":"mail-busy-signup@example.com","password":"a-secure-password"}),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        reply.body
    );
    let tokens: i64 = app.admin_client.query_one("SELECT count(*) FROM auth.one_time_tokens t JOIN auth.users u ON u.id=t.user_id WHERE u.email='mail-budget-17@example.com'", &[]).await.unwrap().get(0);
    assert_eq!(tokens, 0, "overload must not consume the resend cooldown");
    assert!(
        app.admin_client
            .query_opt(
                "SELECT id FROM auth.users WHERE email='mail-busy-signup@example.com'",
                &[]
            )
            .await
            .unwrap()
            .is_none()
    );
    release.add_permits(16);
}

#[tokio::test]
async fn api_caps_every_collection_bytes_and_prepared_cache() {
    let app = TestApp::spawn_with(Options {
        pool_size: 1,
        max_rows: Some(3),
        ..Options::default()
    })
    .await;
    app.admin_client.batch_execute("
        CREATE TABLE public.budget_parents(id int PRIMARY KEY);
        CREATE TABLE public.budget_children(id int PRIMARY KEY, parent int REFERENCES public.budget_parents, payload text);
        INSERT INTO public.budget_parents SELECT generate_series(1,20);
        INSERT INTO public.budget_children SELECT n, 1, repeat('x',1024) FROM generate_series(1,2000) n;
        CREATE FUNCTION public.budget_many() RETURNS SETOF public.budget_children LANGUAGE sql AS 'SELECT * FROM public.budget_children';
        CREATE FUNCTION public.budget_scalars() RETURNS SETOF integer LANGUAGE sql AS 'SELECT generate_series(1,2000)';
        CREATE TABLE public.budget_wide(id int PRIMARY KEY, payload text, mark text DEFAULT 'initial');
        INSERT INTO public.budget_wide(id,payload) SELECT n, repeat('x',5*1024*1024) FROM generate_series(1,2) n;
        CREATE FUNCTION public.budget_big() RETURNS json LANGUAGE sql AS $$ SELECT json_build_object('payload',repeat('x',9*1024*1024)) $$;
        GRANT SELECT ON public.budget_parents, public.budget_children TO anon;
        GRANT SELECT,UPDATE ON public.budget_wide TO service_role;
    ").await.unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let (status, body) = app.get("/rest/v1/budget_parents?select=id,budget_children(id)&order=id&budget_children.limit=2000", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body.as_array().unwrap().len(), 3);
    assert_eq!(body[0]["budget_children"].as_array().unwrap().len(), 3);
    let reply = app.post("/rest/v1/rpc/budget_many", None, json!({})).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body.as_array().unwrap().len(), 3);
    let reply = app
        .post("/rest/v1/rpc/budget_scalars", None, json!({}))
        .await;
    assert_eq!(reply.body, json!([1, 2, 3]));
    assert_eq!(
        app.get("/rest/v1/budget_children?select=payload,payload", None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let token = service_token();
    let reply = app
        .request(Method::GET, "/rest/v1/budget_wide", Some(&token), None)
        .await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.body["code"], "response_too_large");
    assert_eq!(
        app.post("/rest/v1/rpc/budget_big", None, json!({}))
            .await
            .status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let reply = app
        .request_with(
            Method::PATCH,
            "/rest/v1/budget_wide?id=gt.0",
            Some(&token),
            Some(json!({"mark":"changed"})),
            &[("prefer", "return=representation")],
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{}",
        reply.body
    );
    let changed: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM public.budget_wide WHERE mark <> 'initial'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        changed, 0,
        "representation overflow must roll back the write"
    );
    let reply = app
        .post(
            "/rest/v1/products",
            Some(&token),
            json!(vec![json!({}); 1001]),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    app.get("/rest/v1/products", None).await;
    let cached = app.pool.get().await.unwrap().statement_cache.size();
    for n in 1..=80 {
        let order = vec!["id"; n].join(",");
        assert_eq!(
            app.get(&format!("/rest/v1/products?order={order}"), None)
                .await
                .0,
            StatusCode::OK
        );
    }
    let client = app.pool.get().await.unwrap();
    assert_eq!(client.statement_cache.size(), cached);
    let prepared: i64 = client
        .query_one("SELECT count(*) FROM pg_prepared_statements", &[])
        .await
        .unwrap()
        .get(0);
    assert!(
        prepared <= cached as i64 + 1,
        "dynamic prepared statements must be closed: {prepared}"
    );
}

#[tokio::test]
async fn storage_counter_tracks_bulk_upsert_delete_truncate_and_rollback() {
    let app = TestApp::spawn().await;
    app.admin_client.batch_execute("
        INSERT INTO storage.buckets(id) VALUES ('counter');
        INSERT INTO storage.objects(bucket_id,name,version,size,mime_type,etag)
        SELECT 'counter',n::text,gen_random_uuid(),n,'text/plain','x' FROM generate_series(1,10000) n;
    ").await.unwrap();
    async fn total(app: &TestApp) -> i64 {
        let row = app.admin_client.query_one("SELECT bytes, (SELECT coalesce(sum(size),0)::bigint FROM storage.objects) FROM storage.usage WHERE singleton", &[]).await.unwrap();
        let bytes: i64 = row.get(0);
        assert_eq!(bytes, row.get::<_, i64>(1));
        bytes
    }
    assert_eq!(total(&app).await, 50_005_000);
    app.admin_client.batch_execute("
        INSERT INTO storage.objects(bucket_id,name,version,size,mime_type,etag)
        VALUES ('counter','1',gen_random_uuid(),10,'text/plain','x'), ('counter','extra',gen_random_uuid(),7,'text/plain','x')
        ON CONFLICT(bucket_id,name) DO UPDATE SET size=EXCLUDED.size;
        UPDATE storage.objects SET size=size+1 WHERE name IN ('2','3');
        DELETE FROM storage.objects WHERE name='4';
    ").await.unwrap();
    let committed = total(&app).await;
    let mut client = app.pool.get().await.unwrap();
    let claims = Claims::from_payload(json!({"role":"service_role"})).unwrap();
    let tx = begin_request(&mut client, &claims).await.unwrap();
    tx.execute("UPDATE storage.objects SET size=0", &[])
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(total(&app).await, committed);
    let tx = begin_request(&mut client, &claims).await.unwrap();
    assert_eq!(
        tx.execute("UPDATE storage.usage SET bytes=0", &[])
            .await
            .unwrap_err()
            .code()
            .unwrap()
            .code(),
        "42501"
    );
    tx.rollback().await.unwrap();
    app.admin_client
        .batch_execute("TRUNCATE storage.objects")
        .await
        .unwrap();
    assert_eq!(total(&app).await, 0);
}

#[tokio::test]
async fn upload_overload_is_immediate_and_pool_wait_has_a_deadline() {
    let mut options = Options {
        pool_size: 1,
        ..Options::default()
    };
    options.storage.upload_timeout = Duration::from_millis(600);
    let app = Arc::new(TestApp::spawn_with(options).await);
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets(id) VALUES ('wait')")
        .await
        .unwrap();
    let claims = Claims::from_payload(json!({"role":"service_role"})).unwrap();
    let connection = app.pool.get().await.unwrap();
    let start = tokio::time::Instant::now();
    let error = app
        .storage
        .upload(
            claims.clone(),
            "wait",
            "blocked",
            UploadOptions::default(),
            Box::pin(stream::pending()),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.code(), "upload_timeout");
    assert!(start.elapsed() < Duration::from_millis(1100));
    drop(connection);
    let (started, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut active = Vec::new();
    for n in 0..32 {
        let app = app.clone();
        let claims = claims.clone();
        let started = started.clone();
        active.push(tokio::spawn(async move {
            let body = stream::once(async move {
                started.send(()).unwrap();
                futures_util::future::pending::<Result<Bytes, std::io::Error>>().await
            });
            app.storage
                .upload(
                    claims,
                    "wait",
                    &format!("{n}"),
                    UploadOptions::default(),
                    Box::pin(body),
                )
                .await
        }));
    }
    for _ in 0..32 {
        tokio::time::timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap()
            .unwrap();
    }
    let start = tokio::time::Instant::now();
    let error = app
        .storage
        .upload(
            claims.clone(),
            "wait",
            "excess",
            UploadOptions::default(),
            Box::pin(stream::pending()),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.code(), "upload_busy");
    assert!(start.elapsed() < Duration::from_millis(200));
    for upload in active {
        upload.abort();
        let _ = upload.await;
    }
    let body = stream::iter([Ok(Bytes::from_static(b"ok"))]);
    app.storage
        .upload(
            claims,
            "wait",
            "later",
            UploadOptions::default(),
            Box::pin(body),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn panel_login_limit_is_per_peer_and_ignores_untrusted_forwarded_header() {
    let app = TestApp::spawn_with(Options {
        panel_rate_limit_per_minute: 1,
        ..Options::default()
    })
    .await;
    async fn login(app: &TestApp, peer: &str, password: &str, forwarded: &str) -> StatusCode {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/admin/api/login")
            .header("content-type", "application/json")
            .header("x-forwarded-for", forwarded)
            .extension(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()))
            .body(Body::from(
                json!({"email":ADMIN_EMAIL,"password":password}).to_string(),
            ))
            .unwrap();
        app.router.clone().oneshot(request).await.unwrap().status()
    }
    assert_eq!(
        login(&app, "192.0.2.1:1", "wrong", "203.0.113.1").await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, "192.0.2.1:2", "wrong", "203.0.113.2").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login(&app, "192.0.2.2:1", ADMIN_PASSWORD, "203.0.113.1").await,
        StatusCode::OK
    );
}

#[derive(Clone, Default)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for LogCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[tokio::test]
async fn valid_signed_download_never_records_the_query_token() {
    use tracing::instrument::WithSubscriber;
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets(id) VALUES ('logs')")
        .await
        .unwrap();
    let token = service_token();
    assert_eq!(
        app.bytes(
            Method::POST,
            "/storage/v1/object/logs/file.txt",
            Some(&token),
            &[],
            b"secret".to_vec()
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let reply = app
        .post(
            "/storage/v1/object/sign/logs/file.txt",
            Some(&token),
            json!({"expires_in":300}),
        )
        .await;
    let url = reply.body["signed_url"].as_str().unwrap();
    let signed = url.split("token=").nth(1).unwrap();
    let capture = LogCapture::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(capture.clone())
        .finish();
    let reply = app
        .bytes(Method::GET, url, None, &[], vec![])
        .with_subscriber(subscriber)
        .await;
    assert_eq!(reply.0, StatusCode::OK);
    let log = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    assert!(
        log.contains("/storage/v1/object/sign/{bucket}/{*name}"),
        "expected a request span: {log}"
    );
    assert!(!log.contains(signed));
    assert!(!log.contains("token="));
}

#[tokio::test]
async fn malformed_email_is_rejected_before_any_account_is_written() {
    let app = TestApp::spawn().await;
    for email in [
        "a\0@example.com",
        "<victim@example.com>",
        "a@.com",
        "a..b@example.com",
    ] {
        let reply = app
            .post(
                "/auth/v1/signup",
                None,
                json!({"email":email,"password":"valid-password"}),
            )
            .await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            reply.body
        );
        assert_eq!(reply.body["code"], "invalid_email");
    }
}
