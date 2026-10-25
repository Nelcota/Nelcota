//! Independent metadata databases must never collect each other's bytes.
mod common;

use common::{Options, TestApp};
use nelcota_storage::{StorageState, Store, collect_orphans};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("nelcota-owner-{}", Uuid::new_v4())))
    }
    fn store(&self) -> Arc<Store> {
        Arc::new(Store::disk(self.0.clone()).unwrap())
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

async fn app(directory: &Directory) -> TestApp {
    TestApp::spawn_with(Options {
        store: Some(directory.store()),
        ..Options::default()
    })
    .await
}

async fn retained_file(app: &TestApp) -> object_store::path::Path {
    let version = Uuid::now_v7();
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    app.admin_client.execute(
        "INSERT INTO storage.objects (bucket_id, name, version, size, mime_type, etag) VALUES ('docs', 'retained.txt', $1, 8, 'text/plain', 'fixture')",
        &[&version],
    ).await.unwrap();
    let key = Store::key("docs", version);
    app.storage
        .store
        .put(&key, bytes::Bytes::from_static(b"retained"))
        .await
        .unwrap();
    key
}

fn later() -> SystemTime {
    SystemTime::now() + Duration::from_secs(2 * 86_400)
}

#[tokio::test]
async fn independent_databases_sharing_a_store_preserve_referenced_bytes_after_restart() {
    let directory = Directory::new();
    let a = app(&directory).await;
    let b = app(&directory).await;
    let key = retained_file(&b).await;
    for application in [&a, &b] {
        assert!(
            collect_orphans(&application.pool, &application.storage.store, later())
                .await
                .is_err(),
            "shared stores must refuse automatic deletion"
        );
        assert_eq!(
            application
                .storage
                .store
                .get(&key, None)
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap(),
            "retained"
        );
    }
    let restarted = StorageState::new(
        a.pool.clone(),
        a.keys.clone(),
        directory.store(),
        (*a.storage.settings).clone(),
    );
    restarted.initialize_store(&a.admin_client).await.unwrap();
    assert!(
        collect_orphans(&a.pool, &restarted.store, later())
            .await
            .is_err()
    );
    assert!(restarted.store.get(&key, None).await.is_ok());
}

#[tokio::test]
async fn legacy_unmarked_store_with_unknown_versions_is_quarantined() {
    let directory = Directory::new();
    let store = directory.store();
    let key = Store::key("docs", Uuid::now_v7());
    store
        .put(&key, bytes::Bytes::from_static(b"unclaimed"))
        .await
        .unwrap();
    let a = app(&directory).await;
    assert!(
        collect_orphans(&a.pool, &a.storage.store, later())
            .await
            .is_err()
    );
    assert_eq!(
        store.get(&key, None).await.unwrap().bytes().await.unwrap(),
        "unclaimed"
    );
    assert!(directory.0.join(".nelcota-gc-shared-v1").is_file());
}

#[tokio::test]
async fn replicas_of_one_database_can_collect_real_orphans_and_keep_referenced_files() {
    let directory = Directory::new();
    let a = app(&directory).await;
    let retained = retained_file(&a).await;
    // An existing installation may predate ownership markers. All its known
    // files can be adopted without changing keys, metadata or download URLs.
    std::fs::remove_file(directory.0.join(".nelcota-gc-owner-v1")).unwrap();
    let other = StorageState::new(
        a.pool.clone(),
        a.keys.clone(),
        directory.store(),
        (*a.storage.settings).clone(),
    );
    other.initialize_store(&a.admin_client).await.unwrap();
    let orphan = Store::key("docs", Uuid::now_v7());
    other
        .store
        .put(&orphan, bytes::Bytes::from_static(b"orphan"))
        .await
        .unwrap();
    assert_eq!(
        collect_orphans(&a.pool, &other.store, later())
            .await
            .unwrap(),
        1
    );
    assert!(other.store.get(&retained, None).await.is_ok());
    assert!(other.store.get(&orphan, None).await.is_err());
}

#[tokio::test]
async fn simultaneous_independent_claims_disable_collection_for_both_databases() {
    let directory = Directory::new();
    let a = TestApp::spawn().await;
    let b = TestApp::spawn().await;
    let sa = StorageState::new(
        a.pool.clone(),
        a.keys.clone(),
        directory.store(),
        (*a.storage.settings).clone(),
    );
    let sb = StorageState::new(
        b.pool.clone(),
        b.keys.clone(),
        directory.store(),
        (*b.storage.settings).clone(),
    );
    let (ra, rb) = tokio::join!(
        sa.initialize_store(&a.admin_client),
        sb.initialize_store(&b.admin_client)
    );
    ra.unwrap();
    rb.unwrap();
    for (application, storage) in [(&a, &sa), (&b, &sb)] {
        assert!(
            collect_orphans(&application.pool, &storage.store, later())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn missing_modified_or_unsafe_owner_state_refuses_deletion() {
    for replacement in [None, Some(b"modified".as_slice()), Some(&[b'x'; 129])] {
        let directory = Directory::new();
        let a = app(&directory).await;
        let key = Store::key("docs", Uuid::now_v7());
        a.storage
            .store
            .put(&key, bytes::Bytes::from_static(b"preserve"))
            .await
            .unwrap();
        let marker = directory.0.join(".nelcota-gc-owner-v1");
        std::fs::remove_file(&marker).unwrap();
        if let Some(bytes) = replacement {
            std::fs::write(&marker, bytes).unwrap();
        }
        assert!(
            collect_orphans(&a.pool, &a.storage.store, later())
                .await
                .is_err()
        );
        assert!(a.storage.store.get(&key, None).await.is_ok());
    }
    #[cfg(unix)]
    {
        let directory = Directory::new();
        let a = app(&directory).await;
        let marker = directory.0.join(".nelcota-gc-owner-v1");
        let saved = directory.0.join("saved-owner");
        std::fs::rename(&marker, &saved).unwrap();
        std::os::unix::fs::symlink(&saved, &marker).unwrap();
        assert!(
            collect_orphans(&a.pool, &a.storage.store, later())
                .await
                .is_err()
        );
        assert!(saved.is_file());
    }
}
