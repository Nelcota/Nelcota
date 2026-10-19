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

#[tokio::test]
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
    token.cancel();
    assert_eq!(task.await.unwrap().unwrap_err().code(), "aborted");
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

#[tokio::test]
async fn file_storage_round_trips_atomically_and_privately() {
    use nelcota_client::auth::{FileStorage, SessionStorage};
    let dir = std::env::temp_dir().join(format!(
        "nelcota-sdk-file-storage-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(store.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    store.save(None).await.unwrap();
    store.save(None).await.unwrap();
    assert!(store.load().await.unwrap().is_none());
    std::fs::write(store.path(), "not json").unwrap();
    assert_eq!(
        store.load().await.unwrap_err().code(),
        "session_storage_error"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
