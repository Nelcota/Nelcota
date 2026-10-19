use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::header,
    response::Response,
    routing::any,
};
use nelcota_client::{
    Client,
    storage::{BucketUpdate, OpenOptions, UploadOptions, guess_content_type},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (
        url,
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }),
    )
}

#[tokio::test]
async fn storage_redirect_does_not_leak_bearer_token_to_another_origin() {
    let seen = Arc::new(tokio::sync::Mutex::new(None));
    let destination = Router::new().fallback(any(|State(seen): State<Arc<tokio::sync::Mutex<Option<bool>>>>, request: Request| async move {
        *seen.lock().await = Some(request.headers().contains_key(header::AUTHORIZATION));
        Response::builder().status(206).body(Body::from("file bytes")).unwrap()
    })).with_state(seen.clone());
    let (target, task2) = serve(destination).await;
    let origin = Router::new().fallback(any(move |request: Request| {
        let target = target.clone();
        async move {
            assert_eq!(
                request.headers()[header::AUTHORIZATION],
                "Bearer private-token"
            );
            Response::builder()
                .status(307)
                .header(
                    header::LOCATION,
                    format!("{target}/signed-file?token=secret"),
                )
                .body(Body::empty())
                .unwrap()
        }
    }));
    let (url, task1) = serve(origin).await;
    let client = Client::builder(url)
        .access_token("private-token")
        .build()
        .unwrap();
    let response = client
        .storage()
        .from("files")
        .unwrap()
        .open("hello.txt", OpenOptions::default())
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.text().await.unwrap(), "file bytes");
    assert_eq!(*seen.lock().await, Some(false));
    task1.abort();
    task2.abort();
}

#[tokio::test]
async fn interrupted_buffered_reads_retry_but_write_responses_do_not() {
    let seen = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .fallback(any(
            |State(seen): State<Arc<AtomicUsize>>, request: Request| async move {
                let attempt = seen.fetch_add(1, Ordering::SeqCst);
                if request.method() == "GET" && attempt == 1 {
                    return Response::new(Body::from("[]"));
                }
                let body = Body::from_stream(futures_util::stream::iter([
                    Ok(bytes::Bytes::from_static(b"[")),
                    Err(std::io::Error::other("interrupted response")),
                ]));
                Response::new(body)
            },
        ))
        .with_state(seen.clone());
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    client.from("notes").execute::<Vec<Value>>().await.unwrap();
    assert_eq!(seen.load(Ordering::SeqCst), 2);
    let error = client
        .from("notes")
        .insert(&json!({"body":"only once"}))
        .select("id")
        .execute::<Vec<Value>>()
        .await
        .unwrap_err();
    assert_eq!(error.code(), "network_error");
    assert_eq!(seen.load(Ordering::SeqCst), 3);
    task.abort();
}

type Seen = Arc<tokio::sync::Mutex<Vec<Value>>>;

#[tokio::test]
async fn empty_mime_components_are_rejected_before_upload_but_empty_files_are_valid() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = Router::new().fallback(any({
        let calls = calls.clone();
        move |request: Request| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move {
                let content_type = request.headers()[header::CONTENT_TYPE].to_str().unwrap();
                axum::Json(json!({"id":"o1", "bucket":"docs", "name":"empty.txt",
                    "size":0, "mime_type":content_type, "etag":"e"}))
            }
        }
    }));
    let (url, server) = serve(router).await;
    let files = Client::builder(url)
        .build()
        .unwrap()
        .storage()
        .from("docs")
        .unwrap();
    for content_type in ["", "/", "/plain", "text/", "text /plain", " text/plain"] {
        assert!(matches!(
            files
                .upload(
                    "empty.txt",
                    "",
                    UploadOptions {
                        content_type: Some(content_type.into()),
                        ..Default::default()
                    }
                )
                .await,
            Err(nelcota_client::Error::Usage(_))
        ));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    for content_type in [
        "text/plain;charset=utf-8",
        "text/plain ; charset=utf-8",
        "text/plain\t; charset=utf-8",
    ] {
        let stored = files
            .upload(
                "empty.txt",
                "",
                UploadOptions {
                    content_type: Some(content_type.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(stored.size, 0);
        assert_eq!(stored.mime_type, content_type);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    server.abort();
}

/// Records method, path, content type and JSON body; answers with a bucket.
fn recorder(seen: Seen) -> Router {
    Router::new()
        .fallback(any(|State(seen): State<Seen>, request: Request| async move {
            let method = request.method().to_string();
            let path = request.uri().path().to_owned();
            let content_type = request
                .headers()
                .get(header::CONTENT_TYPE)
                .map(|v| v.to_str().unwrap().to_owned());
            let bytes = axum::body::to_bytes(request.into_body(), 1 << 16)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            seen.lock().await.push(
                json!({"method": method, "path": path, "content_type": content_type, "body": body}),
            );
            Response::new(Body::from(
                r#"{"id":"avatars","public":false,"file_size_limit":1000,"allowed_mime_types":["image/png"],"created_at":"t","updated_at":"t"}"#,
            ))
        }))
        .with_state(seen)
}

#[test]
fn content_types_are_guessed_from_common_extensions() {
    assert_eq!(
        guess_content_type("a/b/report.PDF"),
        Some("application/pdf")
    );
    assert_eq!(guess_content_type("data.json"), Some("application/json"));
    assert_eq!(guess_content_type("x.tar.gz"), Some("application/gzip"));
    assert_eq!(guess_content_type("photo.jpeg"), Some("image/jpeg"));
    assert_eq!(guess_content_type("README"), None);
    assert_eq!(guess_content_type("dir.png/README"), None);
    assert_eq!(guess_content_type(".png"), None);
    assert_eq!(guess_content_type("archive.unknown"), None);
}

#[tokio::test]
async fn uploads_guess_the_type_unless_one_is_given() {
    let seen = Seen::default();
    let (url, task) = serve(recorder(seen.clone())).await;
    let files = Client::builder(url)
        .build()
        .unwrap()
        .storage()
        .from("files")
        .unwrap();
    let cases = [
        ("u/logo.svg", None, "image/svg+xml"),
        ("u/data.CSV", None, "text/csv"),
        ("u/blob", None, "application/octet-stream"),
        (
            "u/notes.txt",
            Some("text/plain;charset=utf-8"),
            "text/plain;charset=utf-8",
        ),
    ];
    for (name, explicit, _) in &cases {
        // The recorder answers with a bucket, not a stored object: only the request matters.
        let _ = files
            .upload(
                name,
                "x",
                UploadOptions {
                    content_type: explicit.map(str::to_owned),
                    upsert: false,
                },
            )
            .await;
    }
    let seen = seen.lock().await;
    let sent: Vec<_> = seen.iter().map(|r| r["content_type"].clone()).collect();
    let expected: Vec<_> = cases.iter().map(|(_, _, mime)| json!(mime)).collect();
    assert_eq!(sent, expected);
    task.abort();
}

#[tokio::test]
async fn update_bucket_sends_every_setting_including_cleared_limits() {
    let seen = Seen::default();
    let (url, task) = serve(recorder(seen.clone())).await;
    let storage = Client::builder(url).build().unwrap().storage();
    let current = storage.get_bucket("avatars").await.unwrap();
    storage
        .update_bucket(
            "avatars",
            BucketUpdate {
                public: true,
                ..current.into()
            },
        )
        .await
        .unwrap();
    storage
        .update_bucket(
            "avatars",
            BucketUpdate {
                public: false,
                file_size_limit: None,
                allowed_mime_types: None,
            },
        )
        .await
        .unwrap();
    let invalid = BucketUpdate {
        public: false,
        file_size_limit: Some(0),
        allowed_mime_types: None,
    };
    assert_eq!(
        storage
            .update_bucket("avatars", invalid)
            .await
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    let seen = seen.lock().await;
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[1]["method"], "PUT");
    assert_eq!(
        seen[1]["body"],
        json!({"public":true,"file_size_limit":1000,"allowed_mime_types":["image/png"]})
    );
    assert_eq!(
        seen[2]["body"],
        json!({"public":false,"file_size_limit":null,"allowed_mime_types":null})
    );
    task.abort();
}
