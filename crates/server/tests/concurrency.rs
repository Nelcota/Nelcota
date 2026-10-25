//! Regression coverage for authentication and storage invariants under overlap.
mod common;

use axum::http::StatusCode;
use bytes::Bytes;
use common::{Options, TestApp};
use futures_util::stream;
use nelcota_core::Claims;
use nelcota_storage::{StorageState, UploadOptions};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

#[tokio::test]
async fn password_changed_during_login_cannot_create_a_new_session() {
    let app = Arc::new(TestApp::spawn().await);
    let reply = app
        .post(
            "/auth/v1/signup",
            None,
            json!({"email":"race@example.com", "password":"old-password-123"}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let id: Uuid = reply.body["user"]["id"].as_str().unwrap().parse().unwrap();
    let hash = nelcota_auth::hash_password("new-password-123").unwrap();
    let (mut locker, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let reset = locker.transaction().await.unwrap();
    reset
        .query_one("SELECT id FROM auth.users WHERE id=$1 FOR UPDATE", &[&id])
        .await
        .unwrap();
    let logging_in = app.clone();
    let pending = tokio::spawn(async move {
        logging_in
            .post(
                "/auth/v1/token?grant_type=password",
                None,
                json!({"email":"race@example.com", "password":"old-password-123"}),
            )
            .await
    });
    wait_for_locks(
        &app,
        1,
        "query LIKE 'SELECT encrypted_password%' OR query LIKE 'INSERT INTO auth.sessions%'",
    )
    .await;
    reset
        .execute(
            "UPDATE auth.users SET encrypted_password=$2 WHERE id=$1",
            &[&id, &hash],
        )
        .await
        .unwrap();
    reset
        .execute(
            "UPDATE auth.sessions SET revoked_at=now() WHERE user_id=$1",
            &[&id],
        )
        .await
        .unwrap();
    reset.commit().await.unwrap();
    let reply = pending.await.unwrap();
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_grant");
    let active: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM auth.sessions WHERE user_id=$1 AND revoked_at IS NULL",
            &[&id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(active, 0);
}

#[tokio::test]
async fn concurrent_recovery_requests_issue_one_link_and_one_email() {
    let app = Arc::new(TestApp::spawn().await);
    app.post(
        "/auth/v1/signup",
        None,
        json!({"email":"links@example.com", "password":"old-password-123"}),
    )
    .await;
    let (mut locker, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let lock = locker.transaction().await.unwrap();
    lock.batch_execute("LOCK TABLE auth.one_time_tokens IN SHARE MODE")
        .await
        .unwrap();
    let a = app.clone();
    let first = tokio::spawn(async move {
        a.post(
            "/auth/v1/recover",
            None,
            json!({"email":"links@example.com"}),
        )
        .await
    });
    let b = app.clone();
    let second = tokio::spawn(async move {
        b.post(
            "/auth/v1/recover",
            None,
            json!({"email":"links@example.com"}),
        )
        .await
    });
    wait_for_locks(&app, 2,
        "query LIKE 'DELETE FROM auth.one_time_tokens%' OR query LIKE 'SELECT id FROM auth.users%FOR UPDATE%'").await;
    lock.commit().await.unwrap();
    assert_eq!(first.await.unwrap().status, StatusCode::OK);
    assert_eq!(second.await.unwrap().status, StatusCode::OK);
    let active: i64 = app
        .admin_client
        .query_one(
            "SELECT count(*) FROM auth.one_time_tokens WHERE kind='recovery' AND used_at IS NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(active, 1);
    app.outbox.wait_for(1).await;
    assert_eq!(app.outbox.sent().len(), 1);
}

async fn wait_for_locks(app: &TestApp, count: i64, predicate: &str) {
    let query = format!(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ({predicate})"
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if app
            .admin_client
            .query_one(&query, &[])
            .await
            .unwrap()
            .get::<_, i64>(0)
            == count
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "operations never reached the synchronization point"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn concurrent_first_upserts_remove_the_displaced_bytes_without_a_quota() {
    use futures_util::StreamExt;

    let app = TestApp::spawn().await;
    assert!(app.storage.settings.max_total_size.is_none());
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    // Independent instances share the database and byte store, not a mutex.
    let second = StorageState::new(
        app.pool.clone(),
        app.keys.clone(),
        app.storage.store.clone(),
        (*app.storage.settings).clone(),
    );
    let mut pending = Vec::new();
    let mut gates = Vec::new();
    for storage in [app.storage.clone(), second] {
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, gate) = tokio::sync::oneshot::channel();
        pending.push(tokio::spawn(async move {
            storage
                .upload(
                    service(),
                    "docs",
                    "same.txt",
                    UploadOptions {
                        content_length: Some(6),
                        replace: true,
                        ..Default::default()
                    },
                    Box::pin(stream::once(async move {
                        ready.send(()).unwrap();
                        gate.await.unwrap();
                        Ok(Bytes::from_static(b"abcdef"))
                    })),
                )
                .await
        }));
        // Both policy checks have rolled back before locking publication.
        started.await.unwrap();
        gates.push(release);
    }
    let (mut locker, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let lock = locker.transaction().await.unwrap();
    lock.batch_execute("LOCK TABLE storage.objects IN SHARE MODE")
        .await
        .unwrap();
    for gate in gates {
        gate.send(()).unwrap();
    }
    wait_for_locks(
        &app,
        2,
        "query LIKE 'INSERT INTO storage.objects%' OR query LIKE 'SELECT pg_advisory_xact_lock%'",
    )
    .await;
    lock.commit().await.unwrap();
    let mut replaced = 0;
    for upload in pending {
        replaced += usize::from(upload.await.unwrap().unwrap().replaced);
    }
    assert_eq!(
        replaced, 1,
        "the second publication must observe its predecessor"
    );
    let current = app
        .storage
        .object(&service(), "docs", "same.txt")
        .await
        .unwrap();
    let files: Vec<_> = app.storage.store.list().collect().await;
    assert_eq!(
        files.len(),
        1,
        "superseded bytes must be removed immediately"
    );
    assert_eq!(
        files[0].as_ref().unwrap().location,
        nelcota_storage::Store::key("docs", current.version)
    );
}

fn service() -> Claims {
    Claims::from_payload(json!({"role":"service_role"})).unwrap()
}

#[tokio::test]
async fn logout_while_an_account_update_waits_cannot_authorize_the_old_session() {
    update_after_logout_is_refused(json!({"data":{"should_not_be_written":true}})).await;
}

#[tokio::test]
async fn logout_while_a_password_change_waits_cannot_change_the_account() {
    update_after_logout_is_refused(json!({
        "password":"new-password-456", "current_password":"strong-password-123"
    }))
    .await;
}

async fn update_after_logout_is_refused(body: serde_json::Value) {
    let app = Arc::new(TestApp::spawn().await);
    let signed_in = app
        .post(
            "/auth/v1/signup",
            None,
            json!({"email":"update-race@example.com", "password":"strong-password-123"}),
        )
        .await;
    assert_eq!(signed_in.status, StatusCode::CREATED);
    let id: Uuid = signed_in.body["user"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let access = signed_in.body["access_token"].as_str().unwrap().to_owned();
    let (mut locker, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let lock = locker.transaction().await.unwrap();
    lock.query_one("SELECT id FROM auth.users WHERE id=$1 FOR UPDATE", &[&id])
        .await
        .unwrap();
    let updating = app.clone();
    let token = access.clone();
    let pending = tokio::spawn(async move {
        updating
            .request(
                axum::http::Method::PUT,
                "/auth/v1/user",
                Some(&token),
                Some(body),
            )
            .await
    });
    wait_for_locks(
        &app,
        1,
        "query LIKE 'SELECT u.encrypted_password%' OR query LIKE 'SELECT encrypted_password%'",
    )
    .await;
    assert_eq!(
        app.post("/auth/v1/logout", Some(&access), json!({}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    lock.commit().await.unwrap();
    let reply = pending.await.unwrap();
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
    let metadata: serde_json::Value = app
        .admin_client
        .query_one(
            "SELECT raw_user_meta_data FROM auth.users WHERE id=$1",
            &[&id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(metadata, json!({}));
}

#[tokio::test]
async fn a_download_retries_a_version_replaced_after_its_metadata_snapshot() {
    download_during_replacement(b"new complete bytes", true).await;
}

#[tokio::test]
async fn a_download_cannot_bypass_changed_policies_when_retrying_a_replacement() {
    download_during_replacement(
        b"new bytes that the caller is no longer allowed to read",
        false,
    )
    .await;
}

async fn download_during_replacement(bytes: &'static [u8], readable: bool) {
    use axum::{
        body::to_bytes,
        http::{HeaderMap, HeaderValue, header},
    };

    let app = Arc::new(TestApp::spawn().await);
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    let old = app
        .storage
        .upload(
            service(),
            "docs",
            "same.txt",
            UploadOptions::default(),
            Box::pin(stream::iter([Ok(Bytes::from_static(b"old bytes"))])),
        )
        .await
        .unwrap();
    // Pause the SELECT policy after its statement snapshot sees the old row.
    // Service-role replacement bypasses this policy and commits while it waits.
    app.admin_client
        .batch_execute(
            "CREATE FUNCTION storage.pause_read() RETURNS boolean LANGUAGE plpgsql AS $$
           BEGIN PERFORM pg_advisory_xact_lock(876120, 1); RETURN true; END $$;
         CREATE POLICY paused_read ON storage.objects FOR SELECT TO authenticated
           USING (bucket_id='docs' AND size<32 AND storage.pause_read());",
        )
        .await
        .unwrap();
    let (mut locker, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let lock = locker.transaction().await.unwrap();
    lock.query_one("SELECT pg_advisory_xact_lock(876120, 1)", &[])
        .await
        .unwrap();
    let downloading = app.clone();
    let pending = tokio::spawn(async move {
        let claims =
            Claims::from_payload(json!({"role":"authenticated", "sub":downloading.user_a}))
                .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=2-4"));
        headers.insert(
            header::IF_RANGE,
            HeaderValue::from_str(&format!("\"{}\"", old.object.etag)).unwrap(),
        );
        nelcota_storage::http::download(
            &downloading.storage,
            &claims,
            "docs",
            "same.txt",
            &headers,
            false,
        )
        .await
    });
    wait_for_locks(&app, 1, "query LIKE 'SELECT %FROM storage.objects%'").await;
    let new = app
        .storage
        .upload(
            service(),
            "docs",
            "same.txt",
            UploadOptions {
                replace: true,
                ..Default::default()
            },
            Box::pin(stream::iter([Ok(Bytes::from_static(bytes))])),
        )
        .await
        .unwrap();
    lock.commit().await.unwrap();
    let result = pending.await.unwrap();
    if !readable {
        assert_eq!(result.unwrap_err().status(), StatusCode::NOT_FOUND);
        return;
    }
    let response = result.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "If-Range must be evaluated against the current version"
    );
    assert_eq!(
        response.headers()[header::ETAG],
        format!("\"{}\"", new.object.etag)
    );
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap(),
        Bytes::from_static(bytes)
    );
}

async fn quota_app() -> TestApp {
    let app = TestApp::spawn_with(Options {
        storage: nelcota_storage::StorageSettings {
            max_total_size: Some(10),
            ..Options::default().storage
        },
        ..Options::default()
    })
    .await;
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    app
}

async fn six_bytes(
    storage: &StorageState,
    name: &str,
    declared: bool,
    replace: bool,
) -> Result<nelcota_storage::UploadOutcome, nelcota_core::ApiError> {
    storage
        .upload(
            service(),
            "docs",
            name,
            UploadOptions {
                content_length: declared.then_some(6),
                replace,
                ..Default::default()
            },
            Box::pin(stream::once(async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Ok(Bytes::from_static(b"abcdef"))
            })),
        )
        .await
}

#[tokio::test]
async fn concurrent_uploads_reserve_capacity_with_and_without_a_length() {
    let app = quota_app().await;
    for declared in [true, false] {
        let (first, second) = tokio::join!(
            six_bytes(&app.storage, "a.txt", declared, false),
            six_bytes(&app.storage, "b.txt", declared, false),
        );
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        let used: i64 = app
            .admin_client
            .query_one("SELECT sum(size)::bigint FROM storage.objects", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(used, 6);
        let name = match first.is_ok() {
            true => "a.txt",
            false => "b.txt",
        };
        app.storage.delete(&service(), "docs", name).await.unwrap();
    }
}

#[tokio::test]
async fn separate_instances_check_the_final_committed_quota() {
    let app = quota_app().await;
    let second = StorageState::new(
        app.pool.clone(),
        app.keys.clone(),
        app.storage.store.clone(),
        (*app.storage.settings).clone(),
    );
    let (first, second) = tokio::join!(
        six_bytes(&app.storage, "a.txt", true, false),
        six_bytes(&second, "b.txt", true, false),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let used: i64 = app
        .admin_client
        .query_one("SELECT sum(size)::bigint FROM storage.objects", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(used, 6);
    use futures_util::StreamExt;
    assert_eq!(
        app.storage.store.list().count().await,
        1,
        "failed publication cleans its bytes"
    );
}

#[tokio::test]
async fn replacements_credit_existing_bytes_and_cancellation_releases_reservations() {
    let app = Arc::new(quota_app().await);
    six_bytes(&app.storage, "a.txt", true, false).await.unwrap();
    // Fill the quota exactly, then replace without growing it.
    app.storage
        .upload(
            service(),
            "docs",
            "b.txt",
            UploadOptions::default(),
            Box::pin(stream::iter([Ok(Bytes::from_static(b"1234"))])),
        )
        .await
        .unwrap();
    assert!(
        six_bytes(&app.storage, "a.txt", true, true)
            .await
            .unwrap()
            .replaced
    );
    assert!(
        six_bytes(&app.storage, "a.txt", false, true)
            .await
            .unwrap()
            .replaced
    );
    app.storage
        .delete(&service(), "docs", "a.txt")
        .await
        .unwrap();
    app.storage
        .delete(&service(), "docs", "b.txt")
        .await
        .unwrap();
    let (started, running) = tokio::sync::oneshot::channel();
    let uploading = app.clone();
    let pending = tokio::spawn(async move {
        uploading
            .storage
            .upload(
                service(),
                "docs",
                "cancelled.txt",
                UploadOptions::default(),
                Box::pin(stream::once(async move {
                    started.send(()).unwrap();
                    std::future::pending::<Result<Bytes, std::io::Error>>().await
                })),
            )
            .await
    });
    running.await.unwrap();
    pending.abort();
    let _ = pending.await;
    six_bytes(&app.storage, "after.txt", true, false)
        .await
        .unwrap();
}

#[tokio::test]
async fn folders_and_files_advance_independently_under_the_same_offset() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute(
            "INSERT INTO storage.buckets (id) VALUES ('docs');
         INSERT INTO storage.objects (bucket_id,name,version,size,mime_type,etag)
         SELECT 'docs', name, gen_random_uuid(), 1, 'text/plain', 'x'
         FROM unnest(ARRAY['a/file.txt','b/file.txt','c/file.txt','x.txt','y.txt','z.txt']) name;",
        )
        .await
        .unwrap();
    let first = app
        .storage
        .list(&service(), "docs", "", Some(2), 0)
        .await
        .unwrap();
    let next = app
        .storage
        .list(&service(), "docs", "", Some(2), 2)
        .await
        .unwrap();
    assert_eq!(first.folders, ["a", "b"]);
    assert_eq!(next.folders, ["c"]);
    assert_eq!(next.objects[0].name, "z.txt");
}

#[tokio::test]
async fn refresh_retry_and_successor_use_one_lock_order() {
    let app = Arc::new(TestApp::spawn().await);
    for iteration in 0..4 {
        // Pacing limits request starts; database locks establish the interleaving.
        tokio::time::sleep(Duration::from_millis(60)).await;
        let initial = app.post("/auth/v1/signup", None,
            json!({"email":format!("refresh-overlap-{iteration}@example.test"),"password":Uuid::new_v4().to_string()})).await;
        assert_eq!(initial.status, StatusCode::CREATED);
        let predecessor = initial.body["refresh_token"].as_str().unwrap().to_owned();
        tokio::time::sleep(Duration::from_millis(60)).await;
        let rotated = app
            .post(
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token":predecessor}),
            )
            .await;
        assert_eq!(rotated.status, StatusCode::OK);
        let successor = rotated.body["refresh_token"].as_str().unwrap().to_owned();
        let user: Uuid = initial.body["user"]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let (mut locker, connection) = app.admin.connect(tokio_postgres::NoTls).await.unwrap();
        let driver = tokio::spawn(connection);
        let gate = locker.transaction().await.unwrap();
        gate.query_one(
            "SELECT id FROM auth.sessions WHERE user_id=$1 FOR UPDATE",
            &[&user],
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        let a = app.clone();
        let retry = tokio::spawn(async move {
            a.post(
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token":predecessor}),
            )
            .await
        });
        wait_for_locks(&app, 1, "query LIKE '%auth.refresh_tokens%'").await;
        tokio::time::sleep(Duration::from_millis(60)).await;
        let b = app.clone();
        let current = tokio::spawn(async move {
            b.post(
                "/auth/v1/token?grant_type=refresh_token",
                None,
                json!({"refresh_token":successor}),
            )
            .await
        });
        wait_for_locks(&app, 2, "query LIKE '%auth.refresh_tokens%'").await;
        gate.commit().await.unwrap();
        let first = retry.await.unwrap();
        let second = current.await.unwrap();
        if first.status.is_server_error() || second.status.is_server_error() {
            let mut deadlocks = 0i64;
            for _ in 0..20 {
                deadlocks = app
                    .admin_client
                    .query_one(
                        "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()",
                        &[],
                    )
                    .await
                    .unwrap()
                    .get(0);
                if deadlocks > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert_eq!(
                deadlocks, 0,
                "refresh overlap produced a PostgreSQL deadlock"
            );
        }
        assert!(
            !first.status.is_server_error(),
            "retry failed at interleaving {iteration}: {}",
            first.status
        );
        assert!(
            !second.status.is_server_error(),
            "successor failed at interleaving {iteration}: {}",
            second.status
        );
        assert_eq!(first.status, StatusCode::OK);
        assert!(matches!(
            second.status,
            StatusCode::OK | StatusCode::BAD_REQUEST
        ));
        let active: i64 = app.admin_client.query_one(
            "SELECT count(*) FROM auth.refresh_tokens t JOIN auth.sessions s ON s.id=t.session_id WHERE s.user_id=$1 AND s.revoked_at IS NULL AND NOT t.revoked", &[&user]).await.unwrap().get(0);
        assert!(active <= 1, "only one live successor may remain");
        drop(locker);
        driver.await.unwrap().unwrap();
    }
}
