//! The storage operation interface, without constructing HTTP requests.
mod common;

use bytes::Bytes;
use common::{Options, TestApp};
use futures_util::stream;
use nelcota_core::Claims;
use nelcota_storage::{BucketError, BucketSettings, UploadOptions};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

async fn bucket(app: &TestApp) {
    app.admin_client
        .batch_execute(
            "INSERT INTO storage.buckets (id) VALUES ('docs');
         CREATE POLICY own_folder ON storage.objects FOR ALL TO authenticated
           USING (bucket_id = 'docs' AND (storage.foldername(name))[1] = auth.uid()::text)
           WITH CHECK (bucket_id = 'docs' AND (storage.foldername(name))[1] = auth.uid()::text);",
        )
        .await
        .unwrap();
}
fn claims(user: uuid::Uuid) -> Claims {
    Claims::from_payload(json!({"role": "authenticated", "sub": user})).unwrap()
}

#[tokio::test]
async fn typed_operations_preserve_rls_and_reject_before_polling_bytes() {
    let app = TestApp::spawn().await;
    bucket(&app).await;
    let a = claims(app.user_a);
    let b = claims(app.user_b);
    let name = format!("{}/notes.txt", app.user_a);
    let outcome = app
        .storage
        .upload(
            a.clone(),
            "docs",
            &name,
            UploadOptions {
                content_length: Some(5),
                content_type: Some("text/plain".into()),
                replace: false,
                client: None,
            },
            Box::pin(stream::iter([Ok(Bytes::from_static(b"hello"))])),
        )
        .await
        .unwrap();
    assert_eq!(outcome.object.name, name);
    assert_eq!(outcome.object.size, 5);
    assert!(!outcome.replaced && !outcome.public);
    let listing = app
        .storage
        .list(&a, "docs", &format!("{}/", app.user_a), None, 0)
        .await
        .unwrap();
    assert_eq!(listing.objects.len(), 1);
    assert_eq!(listing.objects[0].id, outcome.object.id);
    assert!(
        app.storage
            .list(&b, "docs", &format!("{}/", app.user_a), None, 0)
            .await
            .unwrap()
            .objects
            .is_empty()
    );
    assert!(app.storage.object(&b, "docs", &name).await.is_err());

    let polled = Arc::new(AtomicBool::new(false));
    let counter = polled.clone();
    let bytes = stream::once(async move {
        counter.store(true, Ordering::SeqCst);
        Ok(Bytes::from_static(b"forbidden"))
    });
    let denied = app
        .storage
        .upload(
            b,
            "docs",
            &name,
            UploadOptions {
                replace: true,
                ..Default::default()
            },
            Box::pin(bytes),
        )
        .await;
    assert!(denied.is_err());
    assert!(
        !polled.load(Ordering::SeqCst),
        "authorization must precede byte consumption"
    );
    assert_eq!(app.storage.object(&a, "docs", &name).await.unwrap().size, 5);
    app.storage.delete(&a, "docs", &name).await.unwrap();
    assert!(app.storage.object(&a, "docs", &name).await.is_err());
}

#[tokio::test]
async fn interrupted_operation_does_not_publish_metadata_or_leave_bytes() {
    let app = TestApp::spawn().await;
    bucket(&app).await;
    let name = format!("{}/interrupted.txt", app.user_a);
    let chunks = stream::iter([
        Ok(Bytes::from(vec![b'x'; 64 * 1024])),
        Err(std::io::Error::other("connection interrupted")),
    ]);
    let result = app
        .storage
        .upload(
            claims(app.user_a),
            "docs",
            &name,
            UploadOptions {
                content_type: Some("text/plain".into()),
                ..Default::default()
            },
            Box::pin(chunks),
        )
        .await;
    assert!(result.is_err());
    let row = app
        .admin_client
        .query_one("SELECT count(*) FROM storage.objects", &[])
        .await
        .unwrap();
    assert_eq!(row.get::<_, i64>(0), 0);
    let files = app.storage.store.list();
    use futures_util::StreamExt;
    assert_eq!(files.count().await, 0);
}

#[tokio::test]
async fn bucket_operations_preserve_policies_and_pool_isolation() {
    let app = TestApp::spawn_with(Options {
        pool_size: 1,
        ..Options::default()
    })
    .await;
    let service = Claims::from_payload(json!({ "role": "service_role" })).unwrap();
    let user = claims(app.user_a);
    let denied = app
        .storage
        .create_bucket(&Claims::anon(), "docs", BucketSettings::default())
        .await
        .unwrap_err();
    assert_eq!(
        nelcota_core::ApiError::from(denied).status(),
        axum::http::StatusCode::UNAUTHORIZED
    );
    let denied = app
        .storage
        .create_bucket(&user, "mine", BucketSettings::default())
        .await
        .unwrap_err();
    assert_eq!(
        nelcota_core::ApiError::from(denied).status(),
        axum::http::StatusCode::FORBIDDEN
    );

    app.storage
        .create_bucket(&service, "docs", BucketSettings::default())
        .await
        .unwrap();
    app.storage
        .create_bucket(&service, "user-docs", BucketSettings::default())
        .await
        .unwrap();
    app.admin_client
        .batch_execute(
            "GRANT INSERT, UPDATE, DELETE ON storage.buckets TO authenticated;
         CREATE POLICY own_buckets ON storage.buckets FOR ALL TO authenticated
             USING (id LIKE 'user-%') WITH CHECK (id LIKE 'user-%');",
        )
        .await
        .unwrap();
    let listed = app.storage.buckets(&user).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "user-docs");
    assert!(matches!(
        app.storage.bucket(&user, "docs").await,
        Err(BucketError::NotFound)
    ));
    assert!(matches!(
        app.storage
            .update_bucket(&user, "docs", BucketSettings::default())
            .await,
        Err(BucketError::NotFound)
    ));
    assert!(matches!(
        app.storage.delete_bucket(&user, "docs").await,
        Err(BucketError::NotFound)
    ));
    let denied = app
        .storage
        .create_bucket(&user, "denied", BucketSettings::default())
        .await
        .unwrap_err();
    assert_eq!(
        nelcota_core::ApiError::from(denied).status(),
        axum::http::StatusCode::FORBIDDEN
    );

    app.storage
        .create_bucket(&user, "user-new", BucketSettings::default())
        .await
        .unwrap();
    let updated = app
        .storage
        .update_bucket(
            &user,
            "user-docs",
            BucketSettings {
                public: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(updated.public);
    app.storage.delete_bucket(&user, "user-new").await.unwrap();
    assert_eq!(app.storage.buckets(&service).await.unwrap().len(), 2);
    assert!(
        app.storage
            .buckets(&Claims::anon())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!app.storage.bucket(&service, "docs").await.unwrap().public);
    let client = app.pool.get().await.unwrap();
    let row = client
        .query_one("SELECT current_user::text", &[])
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "authenticator");
}

#[tokio::test]
async fn bucket_operations_keep_records_and_bytes_after_conflicts() {
    let app = TestApp::spawn_with(Options {
        pool_size: 1,
        ..Options::default()
    })
    .await;
    let service = Claims::from_payload(json!({ "role": "service_role" })).unwrap();
    let created = app
        .storage
        .create_bucket(
            &service,
            "docs",
            BucketSettings {
                public: true,
                file_size_limit: Some(5),
                allowed_mime_types: Some(vec!["Text/*".into()]),
            },
        )
        .await
        .unwrap();
    assert_eq!(created.allowed_mime_types, Some(vec!["text/*".into()]));
    assert!(matches!(
        app.storage
            .create_bucket(&service, "docs", BucketSettings::default())
            .await,
        Err(BucketError::Exists)
    ));
    assert!(matches!(
        app.storage
            .update_bucket(
                &service,
                "docs",
                BucketSettings {
                    file_size_limit: Some(0),
                    ..Default::default()
                }
            )
            .await,
        Err(BucketError::InvalidSizeLimit)
    ));
    assert!(matches!(
        app.storage
            .update_bucket(
                &service,
                "docs",
                BucketSettings {
                    allowed_mime_types: Some(vec!["png".into()]),
                    ..Default::default()
                }
            )
            .await,
        Err(BucketError::InvalidMimeType(_))
    ));
    let unchanged = app.storage.bucket(&service, "docs").await.unwrap();
    assert!(unchanged.public);
    assert_eq!(unchanged.file_size_limit, Some(5));

    app.storage
        .upload(
            service.clone(),
            "docs",
            "notes.txt",
            UploadOptions {
                content_type: Some("text/plain".into()),
                ..Default::default()
            },
            Box::pin(stream::iter([Ok(Bytes::from_static(b"hello"))])),
        )
        .await
        .unwrap();
    assert!(matches!(
        app.storage.delete_bucket(&service, "docs").await,
        Err(BucketError::NotEmpty { count: Some(1) })
    ));
    let object = app
        .storage
        .object(&service, "docs", "notes.txt")
        .await
        .unwrap();
    assert_eq!(object.size, 5);
    let stored = app
        .storage
        .store
        .get(&nelcota_storage::Store::key("docs", object.version), None)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(stored, Bytes::from_static(b"hello"));

    let updated = app
        .storage
        .update_bucket(&service, "docs", BucketSettings::default())
        .await
        .unwrap();
    assert!(!updated.public);
    assert!(updated.file_size_limit.is_none() && updated.allowed_mime_types.is_none());
    app.storage
        .delete(&service, "docs", "notes.txt")
        .await
        .unwrap();
    app.storage.delete_bucket(&service, "docs").await.unwrap();
    assert!(matches!(
        app.storage.bucket(&service, "docs").await,
        Err(BucketError::NotFound)
    ));
    assert!(matches!(
        app.storage.delete_bucket(&service, "docs").await,
        Err(BucketError::NotFound)
    ));
}
