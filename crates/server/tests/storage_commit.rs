//! Storage metadata and bytes must agree even when COMMIT's reply is lost.
mod common;

use bytes::Bytes;
use common::{Options, TestApp, authenticator_password};
use futures_util::stream;
use nelcota_core::{Claims, db};
use nelcota_storage::{Store, UploadOptions};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};

/// Relays PostgreSQL frames, discarding one committed command's acknowledgement.
/// The backend has emitted CommandComplete, so this is not a rollback simulation.
async fn commit_reply_cut(
    listener: TcpListener,
    port: u16,
    armed: Arc<AtomicBool>,
    cut: Arc<AtomicBool>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (client, _) = accepted.unwrap();
                let backend = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                let (mut from_client, mut to_client) = client.into_split();
                let (mut from_backend, mut to_backend) = backend.into_split();
                let armed = armed.clone();
                let cut = cut.clone();
                connections.spawn(async move {
                    let upstream = tokio::io::copy(&mut from_client, &mut to_backend);
                    let downstream = async {
                        loop {
                            let kind = from_backend.read_u8().await?;
                            let length = from_backend.read_u32().await?;
                            assert!((4..=1_048_576).contains(&length));
                            let mut payload = vec![0; (length - 4) as usize];
                            from_backend.read_exact(&mut payload).await?;
                            if kind == b'C' && payload == b"COMMIT\0" && armed.swap(false, Ordering::SeqCst) {
                                cut.store(true, Ordering::SeqCst);
                                return Ok::<(), std::io::Error>(());
                            }
                            to_client.write_u8(kind).await?;
                            to_client.write_u32(length).await?;
                            to_client.write_all(&payload).await?;
                        }
                    };
                    tokio::select! {
                        _ = upstream => {},
                        _ = downstream => {},
                    }
                });
            },
            Some(result) = connections.join_next() => { result.unwrap(); },
        }
    }
}

#[tokio::test]
async fn lost_publication_reply_keeps_the_committed_objects_bytes() {
    assert_uncertain_publication(&TestApp::spawn().await, false).await;
}

#[tokio::test]
async fn lost_replacement_reply_keeps_the_new_version_and_reconciles_the_old_one() {
    assert_uncertain_publication(&TestApp::spawn().await, true).await;
}

#[tokio::test]
#[ignore = "needs an empty, dedicated loopback NELCOTA_TEST_S3_COMMIT_BUCKET and provider settings"]
async fn uncertain_s3_publication_preserves_created_and_replaced_bytes() {
    use nelcota_core::{Config, Secret, config::StorageBackend};

    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let endpoint = var("NELCOTA_TEST_S3_ENDPOINT");
    let parsed = url::Url::parse(&endpoint).unwrap();
    // This regression advances the collector's clock. Keep that destructive
    // fixture operation off remote or shared production providers.
    assert!(matches!(
        parsed.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    ));
    let config = Config {
        storage_backend: StorageBackend::S3,
        storage_s3_endpoint: Some(endpoint),
        storage_s3_bucket: Some(var("NELCOTA_TEST_S3_COMMIT_BUCKET")),
        storage_s3_region: "us-east-1".into(),
        storage_s3_access_key_id: Some(var("NELCOTA_TEST_S3_ACCESS_KEY_ID")),
        storage_s3_secret_access_key: Some(Secret::new(var("NELCOTA_TEST_S3_SECRET_ACCESS_KEY"))),
        ..Config::default()
    };
    let store = Arc::new(Store::from_config(&config).unwrap().unwrap());
    use futures_util::StreamExt;
    assert!(
        store.list().next().await.is_none(),
        "use an empty dedicated test bucket"
    );
    let options = Options {
        store: Some(store.clone()),
        ..Options::default()
    };
    let app = TestApp::spawn_with(options).await;
    for replace in [false, true] {
        assert_uncertain_publication(&app, replace).await;
    }
    assert!(store.list().next().await.is_none());

    // A second independent metadata database must quarantine this real S3
    // target durably, including across a fresh Store instance.
    let other = TestApp::spawn_with(Options {
        store: Some(Arc::new(Store::from_config(&config).unwrap().unwrap())),
        ..Options::default()
    })
    .await;
    other
        .admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    let caller = Claims::from_payload(json!({"role":"service_role"})).unwrap();
    other
        .storage
        .upload(
            caller,
            "docs",
            "retained.txt",
            UploadOptions::default(),
            Box::pin(stream::iter([Ok(Bytes::from_static(
                b"shared provider bytes",
            ))])),
        )
        .await
        .unwrap();
    let version = other
        .admin_client
        .query_one(
            "SELECT version FROM storage.objects WHERE name = 'retained.txt'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    let retained = Store::key("docs", version);
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(2 * 86_400);
    for application in [&app, &other] {
        assert!(
            nelcota_storage::collect_orphans(&application.pool, &application.storage.store, later)
                .await
                .is_err()
        );
        assert_eq!(
            application
                .storage
                .store
                .get(&retained, None)
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap(),
            "shared provider bytes"
        );
    }
    let restarted = nelcota_storage::StorageState::new(
        other.pool.clone(),
        other.keys.clone(),
        Arc::new(Store::from_config(&config).unwrap().unwrap()),
        (*other.storage.settings).clone(),
    );
    restarted
        .initialize_store(&other.admin_client)
        .await
        .unwrap();
    assert!(
        nelcota_storage::collect_orphans(&other.pool, &restarted.store, later)
            .await
            .is_err()
    );
    restarted.store.delete(&retained).await.unwrap();
    assert!(store.list().next().await.is_none());
}

async fn assert_uncertain_publication(app: &TestApp, replace: bool) {
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs') ON CONFLICT DO NOTHING")
        .await
        .unwrap();
    let caller = Claims::from_payload(json!({"role":"service_role"})).unwrap();
    if replace {
        app.storage
            .upload(
                caller.clone(),
                "docs",
                "commit.txt",
                UploadOptions::default(),
                Box::pin(stream::iter([Ok(Bytes::from_static(b"previous version"))])),
            )
            .await
            .unwrap();
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    let armed = Arc::new(AtomicBool::new(false));
    let cut = Arc::new(AtomicBool::new(false));
    let proxy = tokio::spawn(commit_reply_cut(
        listener,
        app.admin.get_ports()[0],
        armed.clone(),
        cut.clone(),
    ));
    let mut config = tokio_postgres::Config::new();
    config
        .host("127.0.0.1")
        .port(proxy_port)
        .dbname(app.admin.get_dbname().unwrap());
    let mut storage = app.storage.clone();
    storage.pool = db::api_pool(&config, authenticator_password(), 1);
    let body = stream::once(async move {
        // Preflight is complete. Only the metadata publication is faulted.
        armed.store(true, Ordering::SeqCst);
        Ok(Bytes::from_static(b"preserve committed bytes"))
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        storage.upload(
            caller,
            "docs",
            "commit.txt",
            UploadOptions {
                replace,
                ..Default::default()
            },
            Box::pin(body),
        ),
    )
    .await
    .expect("faulted upload must finish");
    proxy.abort();
    assert!(proxy.await.unwrap_err().is_cancelled());
    assert!(result.is_err(), "a lost reply cannot acknowledge success");
    assert!(cut.load(Ordering::SeqCst), "a real COMMIT reply was cut");
    let row = app
        .admin_client
        .query_one(
            "SELECT version FROM storage.objects WHERE bucket_id = 'docs' AND name = 'commit.txt'",
            &[],
        )
        .await
        .expect("metadata really committed");
    let key = Store::key("docs", row.get(0));
    let object = app.storage.store.get(&key, None).await;
    assert!(
        object.is_ok(),
        "uncertain publication must not delete committed bytes"
    );
    assert_eq!(
        object.unwrap().bytes().await.unwrap(),
        "preserve committed bytes"
    );
    let future = std::time::SystemTime::now() + std::time::Duration::from_secs(2 * 86_400);
    let removed = nelcota_storage::collect_orphans(&app.pool, &app.storage.store, future)
        .await
        .unwrap();
    assert_eq!(removed, usize::from(replace));
    assert!(app.storage.store.get(&key, None).await.is_ok());
    // The S3 cases share only an otherwise empty disposable bucket. Remove
    // this case's known version after all persistence/collector assertions.
    app.storage.store.delete(&key).await.unwrap();
    app.admin_client
        .execute(
            "DELETE FROM storage.objects WHERE bucket_id = 'docs' AND name = 'commit.txt'",
            &[],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn rejected_publication_removes_only_its_unpublished_bytes() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    let storage = app.storage.clone();
    let caller = Claims::from_payload(json!({"role":"service_role"})).unwrap();
    let concurrent = caller.clone();
    let body = stream::once(async move {
        // Publish this name after the outer upload passed preflight, creating
        // a real conflict at its final INSERT rather than at admission.
        storage
            .upload(
                concurrent,
                "docs",
                "conflict.txt",
                UploadOptions::default(),
                Box::pin(stream::iter([Ok(Bytes::from_static(b"winner"))])),
            )
            .await
            .unwrap();
        Ok(Bytes::from_static(b"rejected"))
    });
    let result = app
        .storage
        .upload(
            caller,
            "docs",
            "conflict.txt",
            UploadOptions::default(),
            Box::pin(body),
        )
        .await;
    assert!(result.is_err());
    let row = app
        .admin_client
        .query_one(
            "SELECT version FROM storage.objects WHERE name = 'conflict.txt'",
            &[],
        )
        .await
        .unwrap();
    let key = Store::key("docs", row.get(0));
    let bytes = app
        .storage
        .store
        .get(&key, None)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(bytes, "winner");
    use futures_util::StreamExt;
    assert_eq!(app.storage.store.list().count().await, 1);
}
