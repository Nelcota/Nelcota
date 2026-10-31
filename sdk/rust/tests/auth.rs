use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use nelcota_client::{
    Client, RequestOptions,
    auth::{AuthEventKind, OAuthProvider, Session},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

fn session(token: &str, refresh: &str) -> Session {
    serde_json::from_value(json!({"access_token":token, "refresh_token":refresh, "token_type":"bearer",
        "expires_in":900, "expires_at":4_000_000_000_u64, "user":{"id":"u1","email":"a@example.com",
        "email_confirmed_at":null,"user_metadata":{},"created_at":"2026-10-09","last_sign_in_at":null}})).unwrap()
}

#[tokio::test]
async fn empty_oauth_codes_are_rejected_before_http() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route(
        "/auth/v1/token",
        post({
            let calls = calls.clone();
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Json(session("a1", "r1")) }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::builder(format!("http://{}", listener.local_addr().unwrap()))
        .build()
        .unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    for code in ["", " \n"] {
        assert!(matches!(
            client.auth().exchange_code(code, &"v".repeat(64)).await,
            Err(nelcota_client::Error::Usage(_))
        ));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    client
        .auth()
        .exchange_code("valid-code", &"v".repeat(64))
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}

async fn server(fail: bool) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let count = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route(
            "/auth/v1/token",
            post(
                move |State(count): State<Arc<AtomicUsize>>, Json(body): Json<Value>| async move {
                    assert_eq!(body["refresh_token"], "r0");
                    count.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    match fail {
                        true => (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"code":"invalid_grant","message":"spent"})),
                        ),
                        false => (
                            StatusCode::OK,
                            Json(serde_json::to_value(session("a1", "r1")).unwrap()),
                        ),
                    }
                },
            ),
        )
        .route(
            "/auth/v1/logout",
            post(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        )
        .with_state(count.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (url, count, task)
}

#[tokio::test]
async fn cancelled_auth_requests_leave_a_busy_lifecycle_gate() {
    struct HeldStorage {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    impl nelcota_client::auth::SessionStorage for HeldStorage {
        fn load(&self) -> nelcota_client::auth::StorageFuture<'_, Option<Session>> {
            Box::pin(async {
                self.entered.notify_one();
                self.release.notified().await;
                Ok(Some(session("a0", "r0")))
            })
        }
        fn save<'a>(
            &'a self,
            _: Option<&'a Session>,
        ) -> nelcota_client::auth::StorageFuture<'a, ()> {
            Box::pin(async { panic!("cancelled queued authentication must not write a session") })
        }
    }
    let store = Arc::new(HeldStorage {
        entered: Default::default(),
        release: Default::default(),
    });
    let client = Client::builder("http://127.0.0.1:1")
        .session_storage(store.clone())
        .build()
        .unwrap();
    let reading = {
        let auth = client.auth();
        tokio::spawn(async move { auth.get_session().await })
    };
    store.entered.notified().await;
    let cancellation = nelcota_client::CancellationToken::new();
    let auth = client
        .with_options(RequestOptions {
            timeout: None,
            cancellation: Some(cancellation.clone()),
        })
        .auth();
    let pending = tokio::spawn(async move {
        let mut password = [0u8; 32];
        getrandom::fill(&mut password).unwrap();
        let password = URL_SAFE_NO_PAD.encode(password);
        let link = nelcota_client::auth::EmailLink {
            kind: nelcota_client::auth::EmailLinkType::Signup,
            token: "fixture".into(),
        };
        let verifier = "a".repeat(43);
        let (login, signup, verify, exchange, read) = tokio::join!(
            auth.sign_in_with_password("a@example.com", &password),
            auth.sign_up("a@example.com", &password, None),
            auth.verify_email_link(&link),
            auth.exchange_code("fixture", &verifier),
            auth.get_session(),
        );
        [
            login.map(|_| ()),
            signup.map(|_| ()),
            verify.map(|_| ()),
            exchange.map(|_| ()),
            read.map(|_| ()),
        ]
    });
    tokio::task::yield_now().await;
    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), pending).await;
    store.release.notify_one();
    reading.await.unwrap().unwrap();
    for outcome in result
        .expect("cancelled requests must leave the gate")
        .unwrap()
    {
        assert_eq!(outcome.unwrap_err().code(), "aborted");
    }
}

#[tokio::test]
async fn fresh_sessions_do_not_rotate_with_short_lifetimes_or_large_margins() {
    for (lifetime, margin) in [(30, 60), (900, 10_000)] {
        let (url, count, server_task) = server(false).await;
        let client = Client::builder(url)
            .refresh_margin(Duration::from_secs(margin))
            .build()
            .unwrap();
        let mut fresh = session("a0", "r0");
        fresh.expires_in = lifetime;
        fresh.expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + lifetime;
        client.auth().set_session(fresh).await.unwrap();
        for _ in 0..20 {
            assert_eq!(
                client
                    .auth()
                    .get_session()
                    .await
                    .unwrap()
                    .unwrap()
                    .refresh_token,
                "r0"
            );
        }
        let background = client.auth().start_auto_refresh();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        drop(background);
        server_task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_clones_refresh_once_and_logout_cannot_restore_session() {
    let (url, count, server) = server(false).await;
    let client = Client::builder(url).build().unwrap();
    client
        .auth()
        .set_session(session("a0", "r0"))
        .await
        .unwrap();
    let mut events = client.auth().subscribe();
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let auth = client.clone().auth();
        tasks.push(tokio::spawn(async move {
            auth.refresh_session().await.unwrap()
        }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap().refresh_token, "r1");
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(events.recv().await.unwrap().kind, AuthEventKind::Refreshed);
    assert_eq!(
        client.auth().sign_out().await.unwrap_err().status(),
        Some(503)
    );
    assert!(client.auth().get_session().await.unwrap().is_none());
    assert_eq!(events.recv().await.unwrap().kind, AuthEventKind::SignedOut);
    server.abort();
}

#[tokio::test]
async fn rotation_finishes_when_waiter_is_cancelled_and_failed_rotation_is_shared() {
    let (url, count, server_task) = server(false).await;
    let client = Client::builder(url).build().unwrap();
    client
        .auth()
        .set_session(session("a0", "r0"))
        .await
        .unwrap();
    let token = nelcota_client::CancellationToken::new();
    let auth = client
        .with_options(RequestOptions {
            timeout: None,
            cancellation: Some(token.clone()),
        })
        .auth();
    let task = tokio::spawn(async move { auth.refresh_session().await });
    while count.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let mut events = client.auth().subscribe();
    token.cancel();
    assert_eq!(task.await.unwrap().unwrap_err().code(), "aborted");
    // Reads do not wait for the rotation; it still finishes and publishes.
    let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.kind, AuthEventKind::Refreshed);
    assert_eq!(
        client
            .auth()
            .get_session()
            .await
            .unwrap()
            .unwrap()
            .refresh_token,
        "r1"
    );
    server_task.abort();

    let (url, count, server_task) = server(true).await;
    let client = Client::builder(url).build().unwrap();
    let mut expired = session("a0", "r0");
    expired.expires_at = 1;
    client.auth().set_session(expired).await.unwrap();
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let auth = client.auth();
        tasks.push(tokio::spawn(async move { auth.refresh_session().await }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap().unwrap_err().code(), "invalid_grant");
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(client.auth().get_session().await.unwrap().is_none());
    server_task.abort();
}

#[tokio::test]
async fn shared_rotation_ignores_the_first_callers_timeout() {
    // The server takes 100 ms; a 10 ms caller must not cut short everyone's rotation.
    let (url, count, server_task) = server(false).await;
    let client = Client::builder(url).build().unwrap();
    client
        .auth()
        .set_session(session("a0", "r0"))
        .await
        .unwrap();
    let auth = client
        .with_options(RequestOptions {
            timeout: Some(Duration::from_millis(10)),
            cancellation: None,
        })
        .auth();
    assert_eq!(auth.refresh_session().await.unwrap().refresh_token, "r1");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server_task.abort();
}

#[tokio::test]
async fn cancelled_refresh_waiters_leave_only_one_background_rotation() {
    struct SlowStorage {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    impl nelcota_client::auth::SessionStorage for SlowStorage {
        fn load(&self) -> nelcota_client::auth::StorageFuture<'_, Option<Session>> {
            Box::pin(async {
                self.started.notify_one();
                self.release.notified().await;
                Ok(None)
            })
        }
        fn save<'a>(
            &'a self,
            _: Option<&'a Session>,
        ) -> nelcota_client::auth::StorageFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }
    let runtime = tokio::runtime::Handle::current();
    let baseline = runtime.metrics().num_alive_tasks();
    let storage = Arc::new(SlowStorage {
        started: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let client = Client::builder("http://127.0.0.1:1")
        .session_storage(storage.clone())
        .build()
        .unwrap();
    let cancellation = nelcota_client::CancellationToken::new();
    let (started, mut receiver) = tokio::sync::mpsc::channel(100);
    let mut callers = Vec::new();
    for _ in 0..100 {
        let auth = client
            .with_options(RequestOptions {
                timeout: None,
                cancellation: Some(cancellation.clone()),
            })
            .auth();
        let started = started.clone();
        callers.push(tokio::spawn(async move {
            started.send(()).await.unwrap();
            auth.refresh_session().await
        }));
    }
    for _ in 0..100 {
        receiver.recv().await.unwrap();
    }
    storage.started.notified().await;
    cancellation.cancel();
    for caller in callers {
        assert_eq!(caller.await.unwrap().unwrap_err().code(), "aborted");
    }
    tokio::task::yield_now().await;
    assert_eq!(
        runtime.metrics().num_alive_tasks(),
        baseline + 1,
        "cancelled waiters must not leave a task per caller"
    );
    storage.release.notify_one();
    tokio::time::timeout(Duration::from_secs(1), async {
        while runtime.metrics().num_alive_tasks() > baseline {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn logout_serializes_with_rotation_and_sessions_are_redacted() {
    let (url, count, server_task) = server(false).await;
    let client = Client::builder(url).build().unwrap();
    let initial = session("secret-access", "r0");
    assert!(!format!("{initial:?}").contains("secret-access"));
    client.auth().set_session(initial).await.unwrap();
    let auth = client.auth();
    let rotating = tokio::spawn(async move { auth.refresh_session().await });
    while count.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    assert!(client.auth().sign_out().await.is_err());
    rotating.await.unwrap().unwrap();
    assert!(client.auth().get_session().await.unwrap().is_none());
    server_task.abort();
}

#[test]
fn oauth_and_email_links_keep_secrets_out_of_debug_and_clean_callback_urls() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use sha2::{Digest, Sha256};
    let client = Client::builder("https://api.example.com").build().unwrap();
    let flow = client
        .auth()
        .begin_oauth(OAuthProvider::Github, "https://app.example.com/callback")
        .unwrap();
    assert_eq!(flow.verifier.len(), 43);
    let params: std::collections::BTreeMap<_, _> = flow.url.query_pairs().into_owned().collect();
    assert_eq!(params.len(), 4);
    assert_eq!(params["code_challenge_method"], "S256");
    assert!(!flow.url.as_str().contains(&flow.verifier));
    assert_eq!(
        params["code_challenge"],
        URL_SAFE_NO_PAD.encode(Sha256::digest(flow.verifier.as_bytes()))
    );
    assert!(!format!("{flow:?}").contains(&flow.verifier));
    let mut url =
        url::Url::parse("https://app.example.com/callback#type=signup&token=secret-email").unwrap();
    let link = nelcota_client::auth::EmailLink::parse(&mut url).unwrap();
    assert!(url.fragment().is_none());
    assert_eq!(link.token, "secret-email");
    assert!(!format!("{link:?}").contains("secret-email"));
}

#[tokio::test]
async fn custom_storage_restores_sessions_and_background_refresh_stops_on_drop() {
    use nelcota_client::auth::{MemoryStorage, SessionStorage};
    let (url, count, server_task) = server(false).await;
    let storage = Arc::new(MemoryStorage::default());
    let mut expired = session("a0", "r0");
    expired.expires_at = 1;
    storage.save(Some(&expired)).await.unwrap();
    let client = Client::builder(url)
        .session_storage(storage.clone())
        .build()
        .unwrap();
    let mut events = client.auth().subscribe();
    let background = client.auth().start_auto_refresh();
    let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.kind, AuthEventKind::Refreshed);
    assert_eq!(storage.load().await.unwrap().unwrap().refresh_token, "r1");
    drop(background);
    client.auth().set_session(expired).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server_task.abort();
}

fn temporary_dir(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "nelcota-sdk-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[tokio::test]
async fn file_storage_round_trips_atomically() {
    use nelcota_client::auth::{FileStorage, SessionStorage};
    let dir = temporary_dir("file-storage");
    let store = FileStorage::new(dir.join("nested").join("session.json"));
    assert!(store.load().await.unwrap().is_none());
    store.save(Some(&session("a0", "r0"))).await.unwrap();
    store.save(Some(&session("a1", "r1"))).await.unwrap();
    assert_eq!(store.load().await.unwrap(), Some(session("a1", "r1")));
    let entries: Vec<_> = std::fs::read_dir(dir.join("nested"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(entries, vec![std::ffi::OsString::from("session.json")]);
    store.save(None).await.unwrap();
    store.save(None).await.unwrap();
    assert!(store.load().await.unwrap().is_none());
    std::fs::write(store.path(), "not json").unwrap();
    assert_eq!(store.load().await.unwrap_err().code(), "session_invalid");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn file_storage_creates_owner_only_files_and_directories_on_unix() {
    use nelcota_client::auth::{FileStorage, SessionStorage};
    use std::os::unix::fs::PermissionsExt;
    let dir = temporary_dir("file-storage-private");
    let store = FileStorage::new(dir.join("nested").join("session.json"));
    store.save(Some(&session("a0", "r0"))).await.unwrap();
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(store.path()), 0o600);
    assert_eq!(mode(&dir.join("nested")), 0o700);
    assert_eq!(mode(&dir), 0o700);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn an_unreadable_stored_session_counts_as_signed_out_and_is_removed() {
    use nelcota_client::auth::FileStorage;
    let dir = temporary_dir("corrupt-session");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("session.json");
    std::fs::write(&path, "not json").unwrap();
    let client = Client::builder("http://127.0.0.1:1")
        .session_storage(Arc::new(FileStorage::new(&path)))
        .build()
        .unwrap();
    let mut events = client.auth().subscribe();
    assert!(client.auth().get_session().await.unwrap().is_none());
    assert_eq!(kinds(&mut events), [AuthEventKind::SignedOut]);
    assert!(!path.exists(), "the unreadable session must be removed");
    client.auth().sign_out().await.unwrap();
    assert!(client.auth().get_session().await.unwrap().is_none());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn sign_out_clears_a_session_the_store_cannot_load() {
    use nelcota_client::auth::{SessionStorage, StorageFuture};
    #[derive(Default)]
    struct Broken(std::sync::Mutex<Vec<bool>>);
    impl SessionStorage for Broken {
        fn load(&self) -> StorageFuture<'_, Option<Session>> {
            Box::pin(async { Err(nelcota_client::Error::SessionInvalid("corrupt".into())) })
        }
        fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()> {
            self.0.lock().unwrap().push(session.is_some());
            Box::pin(async { Ok(()) })
        }
    }
    let store = Arc::new(Broken::default());
    let client = Client::builder("http://127.0.0.1:1")
        .session_storage(store.clone())
        .build()
        .unwrap();
    client.auth().sign_out().await.unwrap();
    assert!(client.auth().get_session().await.unwrap().is_none());
    // Removed when found unreadable, then again by sign-out; never written.
    assert_eq!(*store.0.lock().unwrap(), [false, false]);
}

#[tokio::test]
async fn a_transient_load_failure_keeps_the_stored_session() {
    use nelcota_client::auth::{SessionStorage, StorageFuture};
    #[derive(Default)]
    struct Flaky {
        loads: AtomicUsize,
        saves: std::sync::Mutex<Vec<bool>>,
    }
    impl SessionStorage for Flaky {
        fn load(&self) -> StorageFuture<'_, Option<Session>> {
            let first = self.loads.fetch_add(1, Ordering::SeqCst) == 0;
            Box::pin(async move {
                match first {
                    // A sharing violation or EMFILE, not a corrupt session.
                    true => Err(nelcota_client::Error::SessionStorage("busy".into())),
                    false => Ok(Some(session("a0", "r0"))),
                }
            })
        }
        fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()> {
            self.saves.lock().unwrap().push(session.is_some());
            Box::pin(async { Ok(()) })
        }
    }
    let store = Arc::new(Flaky::default());
    let client = Client::builder("http://127.0.0.1:1")
        .session_storage(store.clone())
        .build()
        .unwrap();
    let mut events = client.auth().subscribe();
    let error = client.auth().get_session().await.unwrap_err();
    assert_eq!(error.code(), "session_storage_error");
    assert!(store.saves.lock().unwrap().is_empty(), "nothing is removed");
    assert!(kinds(&mut events).is_empty(), "no SignedOut is announced");
    let restored = client.auth().get_session().await.unwrap().unwrap();
    assert_eq!(restored.refresh_token, "r0");
    assert_eq!(store.loads.load(Ordering::SeqCst), 2);
}

type TokenReply = Arc<dyn Fn() -> (StatusCode, Value) + Send + Sync>;

async fn rest_server(
    token: TokenReply,
    token_delay: Duration,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let count = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route(
            "/auth/v1/token",
            post({
                let count = count.clone();
                move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    let (status, body) = token();
                    async move {
                        tokio::time::sleep(token_delay).await;
                        (status, Json(body))
                    }
                }
            }),
        )
        .route(
            "/rest/v1/notes",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                let auth = headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                Json(json!([{ "auth": auth }]))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, count, task)
}

fn replying(status: StatusCode, body: Value) -> TokenReply {
    Arc::new(move || (status, body.clone()))
}

async fn sent_token(client: &Client) -> nelcota_client::Result<String> {
    let rows = client
        .from("notes")
        .select("*")
        .execute::<Vec<Value>>()
        .await?;
    Ok(rows.data[0]["auth"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn a_stalled_refresh_does_not_hold_up_requests_with_a_valid_token() {
    let fresh = serde_json::to_value(session("a1", "r1")).unwrap();
    let (url, count, task) =
        rest_server(replying(StatusCode::OK, fresh), Duration::from_secs(60)).await;
    let client = Client::builder(url).build().unwrap();
    // Inside the 60 s refresh margin, but still valid.
    client.auth().set_session(expiring_in(30)).await.unwrap();
    for _ in 0..3 {
        let token = tokio::time::timeout(Duration::from_secs(5), sent_token(&client))
            .await
            .expect("a request waited for the stalled refresh")
            .unwrap();
        assert_eq!(token, "Bearer a0");
    }
    assert_eq!(count.load(Ordering::SeqCst), 1, "one shared rotation");
    task.abort();
}

#[tokio::test]
async fn an_expired_token_is_not_sent_when_its_refresh_fails() {
    let failure = json!({"code":"unavailable","message":"try later"});
    let (url, count, task) = rest_server(
        replying(StatusCode::SERVICE_UNAVAILABLE, failure),
        Duration::ZERO,
    )
    .await;
    let client = Client::builder(url).build().unwrap();
    client.auth().set_session(expiring_in(-60)).await.unwrap();
    let error = sent_token(&client).await.unwrap_err();
    task.abort();
    assert_eq!(error.code(), "unavailable");
    assert!(error.is_retryable());
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn requests_keep_a_valid_token_without_rotating_during_the_backoff() {
    let failure = json!({"code":"unavailable","message":"try later"});
    let (url, count, task) = rest_server(
        replying(StatusCode::SERVICE_UNAVAILABLE, failure),
        Duration::ZERO,
    )
    .await;
    let client = Client::builder(url).build().unwrap();
    // Inside the 60 s refresh margin, but still valid.
    client.auth().set_session(expiring_in(30)).await.unwrap();
    let error = client.auth().refresh_session().await.unwrap_err();
    assert_eq!(error.code(), "unavailable");
    for _ in 0..3 {
        assert_eq!(sent_token(&client).await.unwrap(), "Bearer a0");
    }
    // A request that started a rotation would have reached the server by now.
    tokio::time::sleep(Duration::from_millis(200)).await;
    task.abort();
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "no rotation during the backoff"
    );
}

#[tokio::test]
async fn an_absurd_token_lifetime_does_not_panic() {
    let mut issued = serde_json::to_value(session("a1", "r1")).unwrap();
    issued["expires_in"] = json!(u64::MAX);
    let (url, _, task) = rest_server(replying(StatusCode::OK, issued), Duration::ZERO).await;
    let client = Client::builder(url).build().unwrap();
    let signed_in = client
        .auth()
        .sign_in_with_password("a@example.com", "fixture")
        .await
        .unwrap();
    assert_eq!(signed_in.expires_at, u64::MAX);
    assert_eq!(sent_token(&client).await.unwrap(), "Bearer a1");
    let mut restored = session("a2", "r2");
    restored.expires_at = u64::MAX;
    client.auth().set_session(restored).await.unwrap();
    assert_eq!(sent_token(&client).await.unwrap(), "Bearer a2");
    task.abort();
}

#[tokio::test]
async fn an_absurd_retry_after_does_not_kill_the_rotation() {
    let count = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route(
        "/auth/v1/token",
        post({
            let count = count.clone();
            move || {
                count.fetch_add(1, Ordering::SeqCst);
                async {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [("retry-after", u64::MAX.to_string())],
                        Json(json!({"code":"rate_limited","message":"slow down"})),
                    )
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::builder(format!("http://{}", listener.local_addr().unwrap()))
        .build()
        .unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    // Inside the 60 s refresh margin, but still valid.
    client.auth().set_session(expiring_in(30)).await.unwrap();
    let error = client.auth().refresh_session().await.unwrap_err();
    // The server's answer, not a rotation task that died computing its backoff.
    assert_eq!(error.code(), "rate_limited");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn a_rotation_that_panics_does_not_block_later_refreshes() {
    use nelcota_client::auth::{SessionStorage, StorageFuture};
    #[derive(Default)]
    struct PanicsOnce(std::sync::atomic::AtomicBool);
    impl SessionStorage for PanicsOnce {
        fn load(&self) -> StorageFuture<'_, Option<Session>> {
            let first = !self.0.swap(true, Ordering::SeqCst);
            Box::pin(async move {
                assert!(!first, "first load panics inside the rotation task");
                Ok(Some(expiring_in(-60)))
            })
        }
        fn save<'a>(&'a self, _: Option<&'a Session>) -> StorageFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }
    let fresh = serde_json::to_value(session("a1", "r1")).unwrap();
    let (url, count, task) = rest_server(replying(StatusCode::OK, fresh), Duration::ZERO).await;
    let client = Client::builder(url)
        .session_storage(Arc::new(PanicsOnce::default()))
        .build()
        .unwrap();
    // The first rotation loads the session and panics before reporting.
    let error = client.auth().refresh_session().await.unwrap_err();
    assert_eq!(error.code(), "network_error");
    let refreshed = tokio::time::timeout(Duration::from_secs(5), client.auth().refresh_session())
        .await
        .expect("a later refresh joined the dead rotation")
        .unwrap();
    task.abort();
    assert_eq!(refreshed.refresh_token, "r1");
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn session_lifetime_follows_expires_in_not_the_servers_clock() {
    // A server clock far behind this machine's: its expires_at is in the past.
    let mut issued = session("a1", "r1");
    issued.expires_at = 1;
    let issued = serde_json::to_value(issued).unwrap();
    let (url, count, task) = rest_server(replying(StatusCode::OK, issued), Duration::ZERO).await;
    let client = Client::builder(url).build().unwrap();
    let signed_in = client
        .auth()
        .sign_in_with_password("a@example.com", "fixture")
        .await
        .unwrap();
    assert!(signed_in.expires_in_now() > Duration::from_secs(890));
    assert_eq!(sent_token(&client).await.unwrap(), "Bearer a1");
    assert_eq!(
        client
            .auth()
            .get_session()
            .await
            .unwrap()
            .unwrap()
            .access_token,
        "a1"
    );
    task.abort();
    assert_eq!(count.load(Ordering::SeqCst), 1, "no refresh after sign-in");
}

#[test]
fn auto_refresh_outside_a_runtime_is_an_error() {
    let client = Client::builder("http://127.0.0.1:1").build().unwrap();
    assert_eq!(
        client.auth().try_start_auto_refresh().err().unwrap().code(),
        "invalid_input"
    );
}

#[tokio::test]
async fn auto_refresh_backs_off_while_the_session_stays_due() {
    // Every refresh returns a session that is already inside its margin.
    let mut short = session("a1", "r1");
    short.expires_in = 1;
    let short = serde_json::to_value(short).unwrap();
    let (url, count, task) = rest_server(replying(StatusCode::OK, short), Duration::ZERO).await;
    let client = Client::builder(url).build().unwrap();
    client.auth().set_session(expiring_in(-1)).await.unwrap();
    let background = client.auth().start_auto_refresh();
    tokio::time::sleep(Duration::from_millis(5500)).await;
    drop(background);
    task.abort();
    // Once a second would be five or six refreshes.
    let refreshes = count.load(Ordering::SeqCst);
    assert!((1..=3).contains(&refreshes), "refreshed {refreshes} times");
}

#[tokio::test]
async fn expired_logout_renews_before_revoking_and_always_clears_local_state() {
    let count = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route(
            "/auth/v1/token",
            post({
                let count = count.clone();
                move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    async { Json(session("fresh-access", "fresh-refresh")) }
                }
            }),
        )
        .route(
            "/auth/v1/logout",
            post(|headers: axum::http::HeaderMap| async move {
                match headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                {
                    Some("Bearer fresh-access") => StatusCode::NO_CONTENT,
                    _ => StatusCode::UNAUTHORIZED,
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::builder(format!("http://{}", listener.local_addr().unwrap()))
        .build()
        .unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut expired = session("expired-access", "expired-refresh");
    expired.expires_at = 1;
    client.auth().set_session(expired).await.unwrap();
    let result = client.auth().sign_out().await;
    let local = client.auth().get_session().await.unwrap();
    task.abort();
    assert!(
        result.is_ok(),
        "logout did not revoke the renewed session: {result:?}"
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(local.is_none());
}

type Revocations = Arc<std::sync::Mutex<Vec<String>>>;

async fn revocation_server(
    status: StatusCode,
    body: Value,
) -> (
    String,
    Arc<AtomicUsize>,
    Revocations,
    tokio::task::JoinHandle<()>,
) {
    let renewals = Arc::new(AtomicUsize::new(0));
    let revoked = Revocations::default();
    let router = Router::new()
        .route(
            "/auth/v1/token",
            post({
                let renewals = renewals.clone();
                move || {
                    renewals.fetch_add(1, Ordering::SeqCst);
                    async move { (status, Json(body)) }
                }
            }),
        )
        .route(
            "/auth/v1/logout",
            post({
                let revoked = revoked.clone();
                move |headers: axum::http::HeaderMap| {
                    let token = headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    revoked.lock().unwrap().push(token);
                    async { StatusCode::NO_CONTENT }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, renewals, revoked, task)
}

fn expiring_in(seconds: i64) -> Session {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut session = session("a0", "r0");
    session.expires_at = now.saturating_add_signed(seconds);
    session
}

fn kinds(
    events: &mut tokio::sync::broadcast::Receiver<nelcota_client::auth::AuthEvent>,
) -> Vec<AuthEventKind> {
    std::iter::from_fn(|| events.try_recv().ok().map(|event| event.kind)).collect()
}

#[tokio::test]
async fn logout_revokes_a_valid_near_expiry_token_without_renewing() {
    let fresh = serde_json::to_value(session("fresh-access", "fresh-refresh")).unwrap();
    let (url, renewals, revoked, task) = revocation_server(StatusCode::OK, fresh).await;
    let client = Client::builder(url).build().unwrap();
    client.auth().set_session(expiring_in(30)).await.unwrap();
    let mut events = client.auth().subscribe();
    client.auth().sign_out().await.unwrap();
    task.abort();
    assert_eq!(renewals.load(Ordering::SeqCst), 0);
    assert_eq!(*revoked.lock().unwrap(), ["Bearer a0"]);
    assert_eq!(kinds(&mut events), [AuthEventKind::SignedOut]);
}

#[tokio::test]
async fn logout_revokes_the_current_token_when_renewal_inside_clock_skew_fails() {
    let failure = json!({"code":"unavailable","message":"gateway failure"});
    let (url, renewals, revoked, task) =
        revocation_server(StatusCode::SERVICE_UNAVAILABLE, failure).await;
    let client = Client::builder(url).build().unwrap();
    client.auth().set_session(expiring_in(3)).await.unwrap();
    client.auth().sign_out().await.unwrap();
    task.abort();
    assert_eq!(renewals.load(Ordering::SeqCst), 1);
    assert_eq!(*revoked.lock().unwrap(), ["Bearer a0"]);
}

#[tokio::test]
async fn expired_logout_does_not_revoke_with_a_token_whose_renewal_failed() {
    for (status, code) in [
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        (StatusCode::BAD_REQUEST, "invalid_grant"),
    ] {
        let failure = json!({"code":code,"message":"renewal failed"});
        let (url, renewals, revoked, task) = revocation_server(status, failure).await;
        let client = Client::builder(url).build().unwrap();
        client.auth().set_session(expiring_in(-60)).await.unwrap();
        let mut events = client.auth().subscribe();
        let error = client.auth().sign_out().await.unwrap_err();
        let local = client.auth().get_session().await.unwrap();
        task.abort();
        assert_eq!(error.code(), code);
        assert_eq!(renewals.load(Ordering::SeqCst), 1);
        assert!(revoked.lock().unwrap().is_empty());
        assert!(local.is_none());
        assert_eq!(kinds(&mut events), [AuthEventKind::SignedOut]);
    }
}

#[tokio::test]
async fn logout_revokes_a_renewal_held_in_memory_when_storage_fails() {
    use nelcota_client::auth::{SessionStorage, StorageFuture};
    struct Failing(Session);
    impl SessionStorage for Failing {
        fn load(&self) -> StorageFuture<'_, Option<Session>> {
            Box::pin(async { Ok(Some(self.0.clone())) })
        }
        fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()> {
            assert!(session.is_none(), "sign-out must not persist its renewal");
            Box::pin(async { Err(nelcota_client::Error::SessionStorage("unavailable".into())) })
        }
    }
    let fresh = serde_json::to_value(session("fresh-access", "fresh-refresh")).unwrap();
    let (url, renewals, revoked, task) = revocation_server(StatusCode::OK, fresh).await;
    let client = Client::builder(url)
        .session_storage(Arc::new(Failing(expiring_in(-60))))
        .build()
        .unwrap();
    let mut events = client.auth().subscribe();
    let error = client.auth().sign_out().await.unwrap_err();
    task.abort();
    assert!(matches!(error, nelcota_client::Error::SessionStorage(_)));
    assert_eq!(renewals.load(Ordering::SeqCst), 1);
    assert_eq!(*revoked.lock().unwrap(), ["Bearer fresh-access"]);
    assert_eq!(kinds(&mut events), [AuthEventKind::SignedOut]);
}
