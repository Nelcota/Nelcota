//! Storage metadata and bytes must agree even when COMMIT's reply is lost.
mod common;

use bytes::Bytes;
use common::{TestApp, authenticator_password};
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
    assert_uncertain_publication(false).await;
}

#[tokio::test]
async fn lost_replacement_reply_keeps_the_new_version_and_reconciles_the_old_one() {
    assert_uncertain_publication(true).await;
}

async fn assert_uncertain_publication(replace: bool) {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
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
