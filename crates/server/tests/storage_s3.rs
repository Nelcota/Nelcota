//! Storage on a real S3-compatible service. Ignored by default: it needs
//! one running, e.g.
//!
//! ```sh
//! docker run -d --rm -p 127.0.0.1:9100:9000 \
//!   -e RUSTFS_ACCESS_KEY=nelcotatest -e RUSTFS_SECRET_KEY=nelcotatestsecret rustfs/rustfs
//! # create the bucket `nelcota-files`, then:
//! NELCOTA_TEST_S3_ENDPOINT=http://127.0.0.1:9100 NELCOTA_TEST_S3_BUCKET=nelcota-files \
//! NELCOTA_TEST_S3_ACCESS_KEY_ID=nelcotatest NELCOTA_TEST_S3_SECRET_ACCESS_KEY=nelcotatestsecret \
//!   cargo test -p nelcota-server --test storage_s3 -- --ignored
//! ```

mod common;

use std::sync::Arc;

use axum::http::{Method, StatusCode};
use common::*;
use nelcota_core::{Config, Secret, config::StorageBackend};
use serde_json::json;

fn s3_config() -> Config {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    Config {
        storage_backend: StorageBackend::S3,
        storage_s3_endpoint: Some(var("NELCOTA_TEST_S3_ENDPOINT")),
        storage_s3_bucket: Some(var("NELCOTA_TEST_S3_BUCKET")),
        storage_s3_region: "us-east-1".into(),
        storage_s3_access_key_id: Some(var("NELCOTA_TEST_S3_ACCESS_KEY_ID")),
        storage_s3_secret_access_key: Some(Secret::new(var("NELCOTA_TEST_S3_SECRET_ACCESS_KEY"))),
        ..Config::default()
    }
}

/// Follows a presigned URL with a plain HTTP/1.1 request.
async fn fetch(url: &str) -> (u16, String, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = url
        .strip_prefix("http://")
        .expect("plain-HTTP test endpoint");
    let (host, path) = rest.split_once('/').unwrap();
    let mut stream = tokio::net::TcpStream::connect(host).await.unwrap();
    stream
        .write_all(
            format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&response[..split]).into_owned();
    let status = head[9..12].parse().unwrap();
    let mut body = response[split + 4..].to_vec();
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body = dechunk(&body);
    }
    (status, head, body)
}

fn dechunk(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let line = raw.windows(2).position(|w| w == b"\r\n").unwrap();
        let size =
            usize::from_str_radix(std::str::from_utf8(&raw[..line]).unwrap().trim(), 16).unwrap();
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&raw[line + 2..line + 2 + size]);
        raw = &raw[line + 4 + size..];
    }
}

async fn signed_expiration(app: &TestApp, name: &str, body: &[u8]) {
    let sign = format!("/storage/v1/object/sign/docs/{name}");
    let reply = app
        .post(&sign, Some(&service_token()), json!({ "expires_in": 2 }))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let signed = reply.body["signed_url"].as_str().unwrap();
    let (status, headers, _) = app.bytes(Method::GET, signed, None, &[], vec![]).await;
    assert_eq!(status, StatusCode::FOUND);
    let presigned = headers["location"].to_str().unwrap();
    let url = url::Url::parse(presigned).unwrap();
    let ttl = url
        .query_pairs()
        .find(|(k, _)| k == "X-Amz-Expires")
        .unwrap()
        .1
        .parse::<u64>()
        .unwrap();
    assert!(
        (1..=2).contains(&ttl),
        "S3 must inherit the grant's remaining time"
    );
    assert_eq!(fetch(presigned).await.2, body);
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let (status, headers, _) = app.bytes(Method::GET, signed, None, &[], vec![]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        !headers.contains_key("location"),
        "expired grants must not presign again"
    );

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
    for exp in [now, now - 1, now - 10, now - 29] {
        let token = app
            .keys
            .sign(&json!({
                "typ": "nelcota-storage-url", "bucket": "docs", "name": name, "exp": exp,
                "version": version.to_string()
            }))
            .unwrap();
        let (status, headers, _) = app
            .bytes(
                Method::GET,
                &format!("{sign}?token={token}"),
                None,
                &[],
                vec![],
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "exp={exp}, now={now}");
        assert!(!headers.contains_key("location"));
    }
}

#[tokio::test]
#[ignore = "needs an S3-compatible service (see the module docs)"]
async fn files_on_s3() {
    let store = nelcota_storage::Store::from_config(&s3_config())
        .unwrap()
        .unwrap();
    let mut options = Options::default();
    options.storage.max_file_size = 32 * 1024 * 1024;
    options.store = Some(Arc::new(store));
    let app = TestApp::spawn_with(options).await;
    app.admin_client
        .batch_execute("INSERT INTO storage.buckets (id) VALUES ('docs')")
        .await
        .unwrap();
    let service = service_token();

    // Small (one request) and large (multipart, several 8 MiB parts).
    let large: Vec<u8> = (0..20 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    for (name, body) in [("small.txt", b"hello s3".to_vec()), ("big.bin", large)] {
        let path = format!("/storage/v1/object/docs/{name}");
        let (status, _, reply) = app
            .bytes(
                Method::POST,
                &path,
                Some(&service),
                &[("content-type", "text/plain")],
                body.clone(),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&reply)
        );

        // A download is a redirect to a short presigned URL on the provider.
        let (status, headers, _) = app
            .bytes(Method::GET, &path, Some(&service), &[], vec![])
            .await;
        assert_eq!(status, StatusCode::FOUND);
        let location = headers["location"].to_str().unwrap().to_owned();
        assert!(location.contains("X-Amz-Signature="));
        let (status, head, bytes) = fetch(&location).await;
        assert_eq!(status, 200, "{head}");
        assert_eq!(bytes.len(), body.len());
        assert!(bytes == body, "{name}: content differs");
        assert!(
            head.to_ascii_lowercase().contains("content-disposition: "),
            "{head}"
        );
        if name == "small.txt" {
            signed_expiration(&app, name, &body).await;
        }

        let (status, _, _) = app
            .bytes(Method::DELETE, &path, Some(&service), &[], vec![])
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _, _) = fetch(&location).await;
        assert_eq!(status, 404, "the bytes are gone from the bucket");
    }
}

#[tokio::test]
#[ignore = "needs an S3-compatible service (see the module docs)"]
async fn timed_out_and_canceled_uploads_leave_no_multipart_parts() {
    use bytes::Bytes;
    use futures_util::{StreamExt, stream};
    use nelcota_core::Claims;
    use nelcota_storage::UploadOptions;
    use object_store::{
        aws::AmazonS3Builder,
        path::Path,
        signer::{Method as SignMethod, SignedUrlOptions, Signer},
    };
    use std::time::Duration;

    let config = s3_config();
    let store = nelcota_storage::Store::from_config(&config)
        .unwrap()
        .unwrap();
    let s3 = AmazonS3Builder::new()
        .with_bucket_name(config.storage_s3_bucket.as_deref().unwrap())
        .with_region(&config.storage_s3_region)
        .with_access_key_id(config.storage_s3_access_key_id.as_deref().unwrap())
        .with_secret_access_key(
            config
                .storage_s3_secret_access_key
                .as_ref()
                .unwrap()
                .expose(),
        )
        .with_endpoint(config.storage_s3_endpoint.as_deref().unwrap())
        .with_allow_http(
            config
                .storage_s3_endpoint
                .as_deref()
                .unwrap()
                .starts_with("http://"),
        )
        .build()
        .unwrap();
    let mut options = Options::default();
    options.storage.max_file_size = 32 * 1024 * 1024;
    options.storage.upload_timeout = Duration::from_secs(3);
    options.store = Some(Arc::new(store));
    let app = TestApp::spawn_with(options).await;
    let bucket = format!("abort-{}", uuid::Uuid::new_v4());
    app.admin_client
        .execute("INSERT INTO storage.buckets (id) VALUES ($1)", &[&bucket])
        .await
        .unwrap();
    let prefix = format!("{bucket}/");
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let listing = async || {
        let signed = s3
            .signed_url_opts(
                SignMethod::GET,
                &Path::from(""),
                Duration::from_secs(30),
                &SignedUrlOptions::new().with_query([("uploads", ""), ("prefix", prefix.as_str())]),
            )
            .await
            .unwrap();
        let response = http.get(signed).send().await.unwrap();
        assert!(response.status().is_success());
        response.text().await.unwrap().contains("<Upload>")
    };
    for canceled in [false, true] {
        let state = app.storage.clone();
        let upload_bucket = bucket.clone();
        let task = tokio::spawn(async move {
            let body = stream::iter([
                Ok(Bytes::from(vec![b'x'; 8 * 1024 * 1024])),
                Ok(Bytes::from(vec![b'x'; 2 * 1024 * 1024])),
            ])
            .chain(stream::pending());
            state
                .upload(
                    Claims::from_payload(json!({"role":"service_role"})).unwrap(),
                    &upload_bucket,
                    "unfinished.bin",
                    UploadOptions::default(),
                    Box::pin(body),
                )
                .await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while !listing().await {
            assert!(
                tokio::time::Instant::now() < deadline,
                "multipart upload never started"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        match canceled {
            true => {
                task.abort();
                let error = match task.await {
                    Err(error) => error,
                    _ => {
                        panic!("canceled upload completed");
                    }
                };
                assert!(error.is_cancelled());
            }
            false => {
                let error = task.await.unwrap().err().unwrap();
                assert_eq!(error.status(), StatusCode::REQUEST_TIMEOUT);
                assert_eq!(error.code(), "upload_timeout");
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(11);
        while listing().await {
            assert!(
                tokio::time::Instant::now() < deadline,
                "multipart parts were not aborted"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let count: i64 = app
            .admin_client
            .query_one(
                "SELECT count(*) FROM storage.objects WHERE bucket_id = $1",
                &[&bucket],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 0, "unfinished uploads must not publish metadata");
    }
}
