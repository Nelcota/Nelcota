use nelcota_client::auth::{FileStorage, Session, SessionStorage};
use serde_json::json;

#[tokio::test]
async fn cancelling_a_file_save_removes_only_its_temporary_file() {
    let dir = std::env::temp_dir().join(format!(
        "nelcota-cancel-save-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("session.json");
    let original = b"original session must remain unchanged";
    std::fs::write(&path, original).unwrap();
    let foreign = dir.join("other-operation.tmp");
    std::fs::write(&foreign, "unrelated").unwrap();
    let session: Session = serde_json::from_value(json!({
        "access_token":"fixture", "refresh_token":"fixture", "token_type":"bearer",
        "expires_in":900, "expires_at":1800000000u64,
        "user":{"id":"fixture", "email":"fixture@example.com", "email_confirmed_at":null,
          "created_at":"", "last_sign_in_at":null, "user_metadata":{"large":"x".repeat(8*1024*1024)}}
    })).unwrap();
    let store = FileStorage::new(&path);
    let saving = tokio::spawn(async move { store.save(Some(&session)).await });
    let appeared = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if std::fs::read_dir(&dir).unwrap().count() > 2 {
                return;
            }
            assert!(
                !saving.is_finished(),
                "save finished before cancellation boundary"
            );
            tokio::task::yield_now().await;
        }
    })
    .await;
    saving.abort();
    assert!(saving.await.unwrap_err().is_cancelled());
    appeared.unwrap();
    let entries = std::fs::read_dir(&dir).unwrap().count();
    let content = std::fs::read(&path).unwrap();
    let other = std::fs::read_to_string(&foreign).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(entries, 2, "cancelled save left an owned temporary file");
    assert_eq!(content, original);
    assert_eq!(other, "unrelated");
}

#[tokio::test]
async fn a_failed_promotion_preserves_foreign_paths_and_removes_its_temporary() {
    let dir = std::env::temp_dir().join(format!(
        "nelcota-failed-save-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let target = dir.join("session.json");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(dir.join("foreign.tmp"), "keep").unwrap();
    let session: Session = serde_json::from_value(json!({
        "access_token":"fixture", "refresh_token":"fixture", "token_type":"bearer",
        "expires_in":900, "expires_at":1800000000u64,
        "user":{"id":"fixture", "email":"fixture@example.com", "email_confirmed_at":null,
          "created_at":"", "last_sign_in_at":null, "user_metadata":{}}
    }))
    .unwrap();
    assert_eq!(
        FileStorage::new(&target)
            .save(Some(&session))
            .await
            .unwrap_err()
            .code(),
        "session_storage_error"
    );
    assert!(target.is_dir());
    assert_eq!(
        std::fs::read_to_string(dir.join("foreign.tmp")).unwrap(),
        "keep"
    );
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
    std::fs::remove_dir_all(dir).unwrap();
}
