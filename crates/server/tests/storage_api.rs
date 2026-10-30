//! Storage API against a real Postgres 17 and a disk store: users only reach
//! the files their policies allow, limits hold, and files are served inert.

mod common;

use std::path::Path;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::json;
use uuid::Uuid;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x02\0\0\0";

/// A private `docs` bucket where each user owns the folder named after
/// their id, and a public `site` bucket only `service_role` writes to.
async fn with_buckets(app: &TestApp) {
    app.admin_client
        .batch_execute(
            "INSERT INTO storage.buckets (id) VALUES ('docs');
             INSERT INTO storage.buckets (id, public) VALUES ('site', true);
             CREATE POLICY own_folder ON storage.objects FOR ALL TO authenticated
                 USING (bucket_id = 'docs' AND (storage.foldername(name))[1] = auth.uid()::text)
                 WITH CHECK (bucket_id = 'docs' AND (storage.foldername(name))[1] = auth.uid()::text);",
        )
        .await
        .unwrap();
}

/// Files in the disk store.
fn stored_files(dir: &Path) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        _ => {
            return 0;
        }
    };
    entries
        .map(|e| e.unwrap().path())
        .filter(|p| {
            !matches!(
                p.file_name().and_then(|name| name.to_str()),
                Some(".nelcota-gc-owner-v1" | ".nelcota-gc-shared-v1")
            )
        })
        .map(|p| match p.is_dir() {
            true => stored_files(&p),
            false => 1,
        })
        .sum()
}

fn header<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> &'a str {
    headers.get(name).map_or("", |v| v.to_str().unwrap())
}

impl TestApp {
    async fn upload(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        content_type: &str,
        body: &[u8],
    ) -> (StatusCode, serde_json::Value) {
        let (status, _, bytes) = self
            .bytes(
                method,
                path,
                token,
                &[("content-type", content_type)],
                body.to_vec(),
            )
            .await;
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }
}

#[tokio::test]
async fn users_only_reach_their_own_files() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let (a, b) = (user_token(app.user_a), user_token(app.user_b));
    let path = format!("/storage/v1/object/docs/{}/notes.txt", app.user_a);

    let (status, body) = app
        .upload(Method::POST, &path, Some(&a), "text/plain", b"hello from A")
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["size"], 12);
    assert_eq!(body["mime_type"], "text/plain");
    assert!(body.get("public_url").is_none());

    let (status, headers, bytes) = app.bytes(Method::GET, &path, Some(&a), &[], vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"hello from A");
    assert_eq!(
        header(&headers, "content-type"),
        "text/plain; charset=utf-8"
    );
    assert_eq!(header(&headers, "x-content-type-options"), "nosniff");
    assert!(header(&headers, "content-security-policy").contains("sandbox"));
    assert_eq!(
        header(&headers, "content-disposition"),
        "inline; filename*=UTF-8''notes.txt"
    );
    assert_eq!(header(&headers, "cache-control"), "private, no-cache");

    // B and anon do not even learn that the file exists.
    for token in [Some(b.as_str()), None] {
        let (status, _, _) = app.bytes(Method::GET, &path, token, &[], vec![]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    // B can neither write into A's folder, nor replace or delete A's file.
    let (status, _) = app
        .upload(
            Method::POST,
            &format!("/storage/v1/object/docs/{}/x.txt", app.user_a),
            Some(&b),
            "text/plain",
            b"x",
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .upload(Method::PUT, &path, Some(&b), "text/plain", b"overwritten")
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = app
        .bytes(Method::DELETE, &path, Some(&b), &[], vec![])
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Anon cannot upload anywhere.
    let (status, _) = app
        .upload(Method::POST, &path, None, "text/plain", b"x")
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A refused write took no bytes.
    assert_eq!(stored_files(&app.storage_dir), 1);
    let (_, _, bytes) = app.bytes(Method::GET, &path, Some(&a), &[], vec![]).await;
    assert_eq!(bytes, b"hello from A");
}

#[tokio::test]
async fn replace_and_delete_drop_the_old_bytes() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let a = user_token(app.user_a);
    let path = format!("/storage/v1/object/docs/{}/report.txt", app.user_a);

    let (status, _) = app
        .upload(Method::POST, &path, Some(&a), "text/plain", b"v1")
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = app
        .upload(Method::POST, &path, Some(&a), "text/plain", b"v2")
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "object_exists");

    let (status, _) = app
        .upload(Method::PUT, &path, Some(&a), "text/plain", b"v2")
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, bytes) = app.bytes(Method::GET, &path, Some(&a), &[], vec![]).await;
    assert_eq!(bytes, b"v2");
    assert_eq!(stored_files(&app.storage_dir), 1);

    // PUT on a new name creates it.
    let other = format!("/storage/v1/object/docs/{}/new.txt", app.user_a);
    let (status, _) = app
        .upload(Method::PUT, &other, Some(&a), "text/plain", b"n")
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(stored_files(&app.storage_dir), 2);

    let (status, _, _) = app
        .bytes(Method::DELETE, &path, Some(&a), &[], vec![])
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = app.bytes(Method::GET, &path, Some(&a), &[], vec![]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(stored_files(&app.storage_dir), 1);
}

#[tokio::test]
async fn uploads_do_not_reveal_names_taken_by_hidden_files() {
    let app = TestApp::spawn().await;
    // Anyone may drop files outside `closed/`; only owners see them.
    app.admin_client
        .batch_execute(
            "INSERT INTO storage.buckets (id) VALUES ('inbox');
             CREATE POLICY inbox_drop ON storage.objects FOR INSERT TO anon, authenticated
                 WITH CHECK (bucket_id = 'inbox' AND name NOT LIKE 'closed/%');
             CREATE POLICY inbox_read ON storage.objects FOR SELECT TO authenticated
                 USING (bucket_id = 'inbox' AND owner = auth.uid());",
        )
        .await
        .unwrap();
    let (a, b) = (user_token(app.user_a), user_token(app.user_b));
    let taken = "/storage/v1/object/inbox/report.txt";
    let closed = "/storage/v1/object/inbox/closed/report.txt";
    let (status, _) = app
        .upload(Method::POST, taken, Some(&a), "text/plain", b"from A")
        .await;
    assert_eq!(status, StatusCode::CREATED);
    // The owner sees the file, so learning that it exists reveals nothing.
    let (status, body) = app
        .upload(Method::POST, taken, Some(&a), "text/plain", b"again")
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "object_exists");

    // Others get exactly what a policy refusal answers, never `object_exists`.
    for (token, status) in [
        (Some(b.as_str()), StatusCode::FORBIDDEN),
        (None, StatusCode::UNAUTHORIZED),
    ] {
        let refused = app
            .upload(Method::POST, closed, token, "text/plain", b"x")
            .await;
        assert_eq!(refused.0, status, "{}", refused.1);
        assert_eq!(refused.1["sqlstate"], "42501");
        let hidden = app
            .upload(Method::POST, taken, token, "text/plain", b"x")
            .await;
        assert_eq!(hidden, refused);
        // A replacement of the hidden file answers like one of a free name.
        let refused = app
            .upload(Method::PUT, closed, token, "text/plain", b"x")
            .await;
        assert_eq!(refused.0, status, "{}", refused.1);
        let hidden = app
            .upload(Method::PUT, taken, token, "text/plain", b"x")
            .await;
        assert_eq!(hidden, refused, "PUT must not tell a hidden name either");
    }

    // The hidden file is untouched and no refused upload kept bytes.
    let (status, _, bytes) = app.bytes(Method::GET, taken, Some(&a), &[], vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"from A");
    assert_eq!(stored_files(&app.storage_dir), 1);
}

#[tokio::test]
async fn missing_bytes_of_the_current_version_remain_a_not_found_response() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let path = "/storage/v1/object/site/missing.txt";
    let (status, _) = app
        .upload(
            Method::POST,
            path,
            Some(&service_token()),
            "text/plain",
            b"original",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let version: Uuid = app
        .admin_client
        .query_one(
            "SELECT version FROM storage.objects WHERE bucket_id='site' AND name='missing.txt'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    app.storage
        .store
        .delete(&nelcota_storage::Store::key("site", version))
        .await
        .unwrap();
    let (status, _) = app
        .get("/storage/v1/object/public/site/missing.txt", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn size_and_type_limits() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    app.admin_client
        .batch_execute(
            "INSERT INTO storage.buckets (id, file_size_limit, allowed_mime_types)
             VALUES ('pics', 64, '{image/*}')",
        )
        .await
        .unwrap();
    let service = service_token();

    // The type comes from the bytes, not from the client.
    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/pics/a.png",
            Some(&service),
            "text/plain",
            PNG,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["mime_type"], "image/png");
    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/pics/b.png",
            Some(&service),
            "image/png",
            b"<html><script>x</script></html>",
        )
        .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(body["code"], "mime_type_not_allowed");

    // Bucket limit (64 bytes) and server limit (1 MiB in the tests).
    let mut big = PNG.to_vec();
    big.resize(65, 0);
    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/pics/big.png",
            Some(&service),
            "image/png",
            &big,
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "file_too_large");
    let huge = vec![b'x'; 1024 * 1024 + 1];
    let (status, _) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/huge.txt",
            Some(&service),
            "text/plain",
            &huge,
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    // Bigger than the sniffing window but under the limit: written in parts.
    let large = vec![b'y'; 300 * 1024];
    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/large.txt",
            Some(&service),
            "text/plain",
            &large,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (_, _, bytes) = app
        .bytes(
            Method::GET,
            "/storage/v1/object/public/site/large.txt",
            None,
            &[],
            vec![],
        )
        .await;
    assert_eq!(bytes, large);

    // Only the accepted file's and the large file's bytes are stored.
    assert_eq!(stored_files(&app.storage_dir), 2);
}

#[tokio::test]
async fn the_total_quota_holds() {
    let mut options = Options::default();
    options.storage.max_total_size = Some(10);
    let app = TestApp::spawn_with(options).await;
    with_buckets(&app).await;
    let service = service_token();
    let (status, _) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/a.txt",
            Some(&service),
            "text/plain",
            b"12345678",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/b.txt",
            Some(&service),
            "text/plain",
            b"12345",
        )
        .await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(body["code"], "storage_full");
}

#[tokio::test]
async fn the_disk_guard_refuses_uploads() {
    let mut options = Options::default();
    options.storage.min_free_bytes = u64::MAX / 2;
    let app = TestApp::spawn_with(options).await;
    with_buckets(&app).await;
    let (status, _) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/a.txt",
            Some(&service_token()),
            "text/plain",
            b"x",
        )
        .await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE);
}

#[tokio::test]
async fn active_content_is_downloaded_not_rendered() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let service = service_token();
    for (name, mime, body) in [
        (
            "page.html",
            "text/html",
            &b"<html><script>alert(1)</script></html>"[..],
        ),
        (
            "logo.svg",
            "image/svg+xml",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        ),
    ] {
        let path = format!("/storage/v1/object/site/{name}");
        let (status, _) = app
            .upload(Method::POST, &path, Some(&service), mime, body)
            .await;
        assert_eq!(status, StatusCode::CREATED);
        let (_, headers, _) = app
            .bytes(
                Method::GET,
                &format!("/storage/v1/object/public/site/{name}"),
                None,
                &[],
                vec![],
            )
            .await;
        assert!(
            header(&headers, "content-disposition").starts_with("attachment;"),
            "{name}"
        );
        assert!(header(&headers, "content-security-policy").contains("sandbox"));
    }
    // ?download forces an attachment for inline types too.
    let (status, _) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/p.png",
            Some(&service),
            "image/png",
            PNG,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, headers, _) = app
        .bytes(
            Method::GET,
            "/storage/v1/object/public/site/p.png?download=1",
            None,
            &[],
            vec![],
        )
        .await;
    assert!(header(&headers, "content-disposition").starts_with("attachment;"));
}

#[tokio::test]
async fn ranges_and_conditional_requests() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/abc.txt",
            Some(&service_token()),
            "text/plain",
            b"0123456789",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let url = "/storage/v1/object/public/site/abc.txt";

    let (status, headers, bytes) = app
        .bytes(Method::GET, url, None, &[("range", "bytes=2-4")], vec![])
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes, b"234");
    assert_eq!(header(&headers, "content-range"), "bytes 2-4/10");
    assert_eq!(header(&headers, "cache-control"), "public, max-age=60");

    let (status, _, bytes) = app
        .bytes(Method::GET, url, None, &[("range", "bytes=-3")], vec![])
        .await;
    assert_eq!(
        (status, bytes.as_slice()),
        (StatusCode::PARTIAL_CONTENT, &b"789"[..])
    );
    let (status, headers, _) = app
        .bytes(Method::GET, url, None, &[("range", "bytes=10-")], vec![])
        .await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(header(&headers, "content-range"), "bytes */10");

    let etag = format!("\"{}\"", body["etag"].as_str().unwrap());
    let (status, _, bytes) = app
        .bytes(Method::GET, url, None, &[("if-none-match", &etag)], vec![])
        .await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(bytes.is_empty());
    // A stale If-Range serves the whole file.
    let (status, _, bytes) = app
        .bytes(
            Method::GET,
            url,
            None,
            &[("range", "bytes=0-0"), ("if-range", "\"old\"")],
            vec![],
        )
        .await;
    assert_eq!((status, bytes.len()), (StatusCode::OK, 10));
}

#[tokio::test]
async fn public_buckets_only() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let a = user_token(app.user_a);
    let name = format!("{}/private.txt", app.user_a);
    let (status, _) = app
        .upload(
            Method::POST,
            &format!("/storage/v1/object/docs/{name}"),
            Some(&a),
            "text/plain",
            b"secret",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _, _) = app
        .bytes(
            Method::GET,
            &format!("/storage/v1/object/public/docs/{name}"),
            None,
            &[],
            vec![],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/hello.txt",
            Some(&service_token()),
            "text/plain",
            b"hi",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        body["public_url"],
        "/storage/v1/object/public/site/hello.txt"
    );
    let (status, _, bytes) = app
        .bytes(
            Method::GET,
            "/storage/v1/object/public/site/hello.txt",
            None,
            &[],
            vec![],
        )
        .await;
    assert_eq!((status, bytes.as_slice()), (StatusCode::OK, &b"hi"[..]));
    // Writing to a public bucket still goes through the policies.
    let (status, _) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/x.txt",
            Some(&a),
            "text/plain",
            b"x",
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn signed_urls() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let (a, b) = (user_token(app.user_a), user_token(app.user_b));
    let name = format!("{}/contract.pdf", app.user_a);
    let (status, _) = app
        .upload(
            Method::POST,
            &format!("/storage/v1/object/docs/{name}"),
            Some(&a),
            "application/pdf",
            b"%PDF-1.7 contract",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let sign = format!("/storage/v1/object/sign/docs/{name}");

    // Only someone who can read the file can sign it.
    let reply = app.post(&sign, Some(&b), json!({ "expires_in": 60 })).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app.post(&sign, Some(&a), json!({ "expires_in": 0 })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let reply = app.post(&sign, Some(&a), json!({ "expires_in": 60 })).await;
    assert_eq!(reply.status, StatusCode::OK);
    let url = reply.body["signed_url"].as_str().unwrap().to_owned();
    let (status, headers, bytes) = app.bytes(Method::GET, &url, None, &[], vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"%PDF-1.7 contract");
    assert!(header(&headers, "content-disposition").starts_with("attachment;"));

    // The signature is bound to the file.
    let token = url.split("token=").nth(1).unwrap();
    let other = format!(
        "/storage/v1/object/sign/docs/{}/other.pdf?token={token}",
        app.user_a
    );
    let (status, _, _) = app.bytes(Method::GET, &other, None, &[], vec![]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // An API token is not a signature, and a signature is not an API token.
    let (status, _, _) = app
        .bytes(Method::GET, &format!("{sign}?token={a}"), None, &[], vec![])
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app.get("/rest/v1/todos", Some(token)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // A file grant has a strict deadline, including the API JWT's 30 s leeway.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Carry the signed file's real version, so only the deadline is tested.
    let version: uuid::Uuid = app
        .admin_client
        .query_one(
            "SELECT version FROM storage.objects WHERE bucket_id = 'docs' AND name = $1",
            &[&name],
        )
        .await
        .unwrap()
        .get(0);
    for exp in [1, now, now - 1, now - 10, now - 29, now - 31] {
        let expired = app
            .keys
            .sign(&json!({
                "typ": "nelcota-storage-url", "bucket": "docs", "name": name, "exp": exp,
                "version": version.to_string()
            }))
            .unwrap();
        let (status, _, bytes) = app
            .bytes(
                Method::GET,
                &format!("{sign}?token={expired}"),
                None,
                &[],
                vec![],
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "exp={exp}, now={now}");
        assert_ne!(bytes, b"%PDF-1.7 contract");
    }

    let reply = app.post(&sign, Some(&a), json!({ "expires_in": 1 })).await;
    assert_eq!(reply.status, StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let (status, _, _) = app
        .bytes(
            Method::GET,
            reply.body["signed_url"].as_str().unwrap(),
            None,
            &[],
            vec![],
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a real one-second grant expired"
    );
}

#[tokio::test]
async fn signed_urls_cover_only_the_signed_version() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let a = user_token(app.user_a);
    let name = format!("{}/offer.txt", app.user_a);
    let path = format!("/storage/v1/object/docs/{name}");
    let sign = format!("/storage/v1/object/sign/docs/{name}");
    let (status, _) = app
        .upload(Method::POST, &path, Some(&a), "text/plain", b"first")
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let reply = app
        .post(&sign, Some(&a), json!({ "expires_in": 600 }))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let first = reply.body["signed_url"].as_str().unwrap().to_owned();
    let (status, _, bytes) = app.bytes(Method::GET, &first, None, &[], vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"first");

    // A replacement is another file: the old grant does not reach it.
    let (status, _) = app
        .upload(Method::PUT, &path, Some(&a), "text/plain", b"second")
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, bytes) = app.bytes(Method::GET, &first, None, &[], vec![]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_ne!(bytes, b"second");
    let reply = app
        .post(&sign, Some(&a), json!({ "expires_in": 600 }))
        .await;
    let second = reply.body["signed_url"].as_str().unwrap().to_owned();
    let (status, _, bytes) = app.bytes(Method::GET, &second, None, &[], vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"second");

    // Neither does a file deleted and created again under the same name.
    let (status, _, _) = app
        .bytes(Method::DELETE, &path, Some(&a), &[], vec![])
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = app
        .upload(Method::POST, &path, Some(&a), "text/plain", b"third")
        .await;
    assert_eq!(status, StatusCode::CREATED);
    for url in [&first, &second] {
        let (status, _, bytes) = app.bytes(Method::GET, url, None, &[], vec![]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_ne!(bytes, b"third");
    }

    // A grant that names no version (signed before versions were bound) is
    // refused even while its deadline holds.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let legacy = app
        .keys
        .sign(&json!({
            "typ": "nelcota-storage-url", "bucket": "docs", "name": name, "exp": now + 600
        }))
        .unwrap();
    let (status, _, bytes) = app
        .bytes(
            Method::GET,
            &format!("{sign}?token={legacy}"),
            None,
            &[],
            vec![],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_ne!(bytes, b"third");
}

#[tokio::test]
async fn listing_shows_folders_and_only_visible_files() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let (a, b) = (user_token(app.user_a), user_token(app.user_b));
    for name in [
        "a.txt",
        "photos/1.txt",
        "photos/2.txt",
        "photos/trip/3.txt",
        "100%_done.txt",
    ] {
        let (status, _) = app
            .upload(
                Method::POST,
                &format!("/storage/v1/object/docs/{}/{name}", app.user_a),
                Some(&a),
                "text/plain",
                b"x",
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{name}");
    }
    let list = "/storage/v1/object/list/docs";
    let reply = app
        .post(
            list,
            Some(&a),
            json!({ "prefix": format!("{}/", app.user_a) }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["folders"], json!(["photos"]));
    let names: Vec<&str> = reply.body["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["name"].as_str().unwrap().rsplit('/').next().unwrap())
        .collect();
    assert_eq!(names, ["100%_done.txt", "a.txt"]);

    let reply = app
        .post(
            list,
            Some(&a),
            json!({ "prefix": format!("{}/photos/", app.user_a), "limit": 1 }),
        )
        .await;
    assert_eq!(reply.body["folders"], json!(["trip"]));
    assert_eq!(reply.body["objects"].as_array().unwrap().len(), 1);
    // `%` and `_` in a prefix are literal.
    let reply = app
        .post(
            list,
            Some(&a),
            json!({ "prefix": format!("{}/100%_done.txt/", app.user_a) }),
        )
        .await;
    assert_eq!(reply.body["objects"], json!([]));

    // B sees nothing of A's.
    let reply = app
        .post(
            list,
            Some(&b),
            json!({ "prefix": format!("{}/", app.user_a) }),
        )
        .await;
    assert_eq!(reply.body, json!({ "folders": [], "objects": [] }));
    let reply = app
        .post(list, Some(&a), json!({ "prefix": "no-slash" }))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn hostile_paths_are_refused() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let service = service_token();
    for path in [
        "/storage/v1/object/site/../docs/x.txt",
        "/storage/v1/object/site/a/%2e%2e/b.txt",
        "/storage/v1/object/site/a//b.txt",
        "/storage/v1/object/site/a%00b.txt",
        "/storage/v1/object/site/a%5Cb.txt",
        "/storage/v1/object/Site/a.txt",
    ] {
        let (status, body) = app
            .upload(Method::POST, path, Some(&service), "text/plain", b"x")
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
    }
    let (status, body) = app
        .upload(
            Method::POST,
            "/storage/v1/object/nope/a.txt",
            Some(&service),
            "text/plain",
            b"x",
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "bucket_not_found");
    assert_eq!(stored_files(&app.storage_dir), 0);
}

#[tokio::test]
async fn buckets_are_managed_by_service_role() {
    let app = TestApp::spawn().await;
    let service = service_token();
    let user = user_token(app.user_a);

    let reply = app
        .post("/storage/v1/bucket", Some(&user), json!({ "id": "mine" }))
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app
        .post("/storage/v1/bucket", None, json!({ "id": "mine" }))
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);

    let reply = app
        .post(
            "/storage/v1/bucket",
            Some(&service),
            json!({ "id": "avatars", "public": true, "file_size_limit": 1000, "allowed_mime_types": ["Image/*"] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.body["allowed_mime_types"], json!(["image/*"]));
    let reply = app
        .post(
            "/storage/v1/bucket",
            Some(&service),
            json!({ "id": "avatars" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    for bad in [
        json!({ "id": "list" }),
        json!({ "id": "x", "allowed_mime_types": ["png"] }),
        json!({ "id": "x", "file_size_limit": 0 }),
    ] {
        let reply = app
            .post("/storage/v1/bucket", Some(&service), bad.clone())
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{bad}");
    }

    let (status, body) = app.get("/storage/v1/bucket", Some(&service)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);
    // No policy on storage.buckets: other roles see none.
    let (_, body) = app.get("/storage/v1/bucket", Some(&user)).await;
    assert_eq!(body, json!([]));

    let reply = app
        .request(
            Method::PUT,
            "/storage/v1/bucket/avatars",
            Some(&service),
            Some(json!({ "public": false })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["public"], false);
    assert_eq!(reply.body["file_size_limit"], json!(null));

    let (status, _) = app
        .upload(
            Method::POST,
            "/storage/v1/object/avatars/a.txt",
            Some(&service),
            "text/plain",
            b"x",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let reply = app
        .request(
            Method::DELETE,
            "/storage/v1/bucket/avatars",
            Some(&service),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.body["code"], "bucket_not_empty");
    let (status, _, _) = app
        .bytes(
            Method::DELETE,
            "/storage/v1/object/avatars/a.txt",
            Some(&service),
            &[],
            vec![],
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let reply = app
        .request(
            Method::DELETE,
            "/storage/v1/bucket/avatars",
            Some(&service),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let (status, _) = app.get("/storage/v1/bucket/avatars", Some(&service)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_collector_removes_only_old_orphans() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    let (status, _) = app
        .upload(
            Method::POST,
            "/storage/v1/object/site/kept.txt",
            Some(&service_token()),
            "text/plain",
            b"kept",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let site = app.storage_dir.join("site");
    std::fs::write(site.join(Uuid::now_v7().to_string()), b"orphan").unwrap();
    std::fs::write(site.join("readme.txt"), b"not ours").unwrap();
    assert_eq!(stored_files(&app.storage_dir), 3);

    // Today, the orphan is still inside the grace period.
    let now = std::time::SystemTime::now();
    let removed = nelcota_storage::collect_orphans(&app.pool, &app.storage.store, now)
        .await
        .unwrap();
    assert_eq!(removed, 0);
    // Two days later it goes; the referenced file and the foreign one stay.
    let later = now + std::time::Duration::from_secs(2 * 86_400);
    let removed = nelcota_storage::collect_orphans(&app.pool, &app.storage.store, later)
        .await
        .unwrap();
    assert_eq!(removed, 1);
    assert_eq!(stored_files(&app.storage_dir), 2);
    let (_, _, bytes) = app
        .bytes(
            Method::GET,
            "/storage/v1/object/public/site/kept.txt",
            None,
            &[],
            vec![],
        )
        .await;
    assert_eq!(bytes, b"kept");
}

#[tokio::test]
async fn a_per_user_quota_is_a_policy() {
    let app = TestApp::spawn().await;
    with_buckets(&app).await;
    // The policy from docs/storage.md, with a 10-byte quota.
    app.admin_client
        .batch_execute(
            "CREATE POLICY quota ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
                 WITH CHECK ((SELECT coalesce(sum(size), 0) FROM storage.objects
                               WHERE owner = auth.uid()) + size <= 10)",
        )
        .await
        .unwrap();
    let a = user_token(app.user_a);
    let url = |name: &str| format!("/storage/v1/object/docs/{}/{name}", app.user_a);
    let (status, _) = app
        .upload(
            Method::POST,
            &url("one.txt"),
            Some(&a),
            "text/plain",
            b"12345678",
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = app
        .upload(
            Method::POST,
            &url("two.txt"),
            Some(&a),
            "text/plain",
            b"12345",
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // The refused upload left no bytes behind.
    assert_eq!(stored_files(&app.storage_dir), 1);
}
