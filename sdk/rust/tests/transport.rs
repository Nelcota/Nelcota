use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::header,
    response::Response,
    routing::any,
};
use nelcota_client::{
    Client, Error, RequestOptions,
    rest::{Condition, IsValue, Order, UpsertOptions},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (url, task)
}

#[tokio::test]
async fn cardinality_without_representation_is_rejected_before_http() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = Router::new().fallback(any({
        let calls = calls.clone();
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { axum::http::StatusCode::CREATED }
        }
    }));
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    let minimal = [
        client.from("notes").insert(&json!({"body": "one"})),
        client
            .from("notes")
            .upsert(&json!({"id": 1}), UpsertOptions::default()),
        client
            .from("notes")
            .update(&json!({"body": "two"}))
            .eq("id", 1),
        client.from("notes").delete().eq("id", 1),
        client
            .from("notes")
            .select("*")
            .insert(&json!({"body": "three"})),
        client.from("notes").head(),
    ];
    for query in minimal {
        for query in [query.clone().single(), query.maybe_single()] {
            assert!(matches!(
                query.execute::<Value>().await,
                Err(Error::Usage(_))
            ));
        }
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn cardinality_accepts_explicit_representation_and_rpc_arrays() {
    let (url, task) =
        serve(Router::new().fallback(any(|| async { axum::Json(json!([{"id": 1}])) }))).await;
    let client = Client::builder(url).build().unwrap();
    for query in [
        client
            .from("notes")
            .insert(&json!({"body": "one"}))
            .single()
            .select("*"),
        client.rpc("rows", &json!({})).single(),
    ] {
        assert_eq!(
            query.execute::<Value>().await.unwrap().data,
            json!({"id": 1})
        );
    }
    task.abort();
}

#[tokio::test]
async fn non_finite_json_never_reaches_writes_or_rpc_but_explicit_null_does() {
    #[derive(serde::Serialize)]
    struct Input {
        value: Option<f64>,
        nested: Vec<f32>,
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let router = Router::new().fallback(any({
        let calls = calls.clone();
        move |body: String| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move {
                assert_eq!(
                    serde_json::from_str::<Value>(&body).unwrap(),
                    json!({ "value": null, "nested": [1.25] })
                );
                axum::Json(Value::Null)
            }
        }
    }));
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let input = Input {
            value: Some(value),
            nested: Vec::new(),
        };
        for query in [
            client.from("notes").insert(&input),
            client.from("notes").update(&input),
            client
                .from("notes")
                .upsert(&input, UpsertOptions::default()),
            client.rpc("echo", &input),
        ] {
            assert!(matches!(
                query.execute::<Value>().await.unwrap_err(),
                Error::Usage(_)
            ));
        }
    }
    let nested = Input {
        value: None,
        nested: vec![f32::NAN],
    };
    assert!(matches!(
        client
            .from("notes")
            .insert(&nested)
            .execute::<Value>()
            .await
            .unwrap_err(),
        Error::Usage(_)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let valid = Input {
        value: None,
        nested: vec![1.25],
    };
    client
        .from("notes")
        .insert(&valid)
        .execute::<Value>()
        .await
        .unwrap();
    client.rpc("echo", &valid).execute::<Value>().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    task.abort();
}

#[tokio::test]
async fn error_bodies_are_bounded_without_losing_status_or_retry_after() {
    let router = Router::new().fallback(any(|request: Request| async move {
        let text = format!(
            "{}{}",
            r#"{"code":"too_large","message":"ignored"}"#,
            " ".repeat(65536)
        );
        let body = match request.uri().path().rsplit('/').next() {
            Some("chunked") => {
                Body::from_stream(futures_util::stream::iter([Ok::<_, std::io::Error>(
                    bytes::Bytes::from(text),
                )]))
            }
            _ => Body::from(text),
        };
        Response::builder()
            .status(503)
            .header("retry-after", "90")
            .body(body)
            .unwrap()
    }));
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    for table in ["length", "chunked"] {
        let error = client.from(table).execute::<Value>().await.unwrap_err();
        assert_eq!(error.status(), Some(503));
        assert_eq!(error.code(), "unavailable");
        assert_eq!(error.retry_after(), Some(Duration::from_secs(90)));
    }
    task.abort();
}

#[tokio::test]
async fn exact_error_body_budget_preserves_the_server_error() {
    let router = Router::new().fallback(any(|| async {
        let text = r#"{"code":"db_error","message":"ação"}"#;
        let body = format!("{text}{}", " ".repeat(65536 - text.len()));
        Response::builder()
            .status(409)
            .body(Body::from(body))
            .unwrap()
    }));
    let (url, task) = serve(router).await;
    let error = Client::builder(url)
        .build()
        .unwrap()
        .from("notes")
        .execute::<Value>()
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(409));
    assert_eq!(error.code(), "db_error");
    task.abort();
}

#[test]
fn negation_uses_the_server_grammar_and_double_negation_restores_conditions() {
    let client = Client::builder("https://api.example.com").build().unwrap();
    for (condition, expected) in [
        (!Condition::eq("name", "Ana"), "(name.not.eq.\"Ana\")"),
        (!!Condition::eq("name", "Ana"), "(name.eq.\"Ana\")"),
        (
            !Condition::is("deleted", IsValue::True),
            "(deleted.not.is.true)",
        ),
        (
            !!Condition::is("deleted", IsValue::True),
            "(deleted.is.true)",
        ),
        (
            !Condition::in_values("id", [1, 2]),
            "(id.not.in.(\"1\",\"2\"))",
        ),
        (
            !!Condition::in_values("id", [1, 2]),
            "(id.in.(\"1\",\"2\"))",
        ),
        (
            !Condition::all([Condition::eq("id", 1)]),
            "(not.and(id.eq.\"1\"))",
        ),
        (
            !!Condition::any([Condition::eq("id", 1)]),
            "(or(id.eq.\"1\"))",
        ),
    ] {
        let query = client.from("notes").or([condition]).query_string().unwrap();
        let params: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(params, [("or".into(), expected.into())]);
    }
    assert!(
        client
            .from("notes")
            .or([!Condition::eq("bad,column", 1)])
            .query_string()
            .is_err()
    );
}

#[tokio::test]
async fn read_write_headers_cardinality_and_rpc() {
    let seen = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let router = Router::new()
        .fallback(any(
            |State(seen): State<Arc<tokio::sync::Mutex<Vec<Value>>>>, request: Request| async move {
                let (parts, body) = request.into_parts();
                let body = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
                seen.lock().await.push(
                    json!({"method":parts.method.as_str(), "uri":parts.uri.to_string(),
            "auth":parts.headers.get(header::AUTHORIZATION).map(|v| v.to_str().unwrap()),
            "prefer":parts.headers.get("prefer").map(|v| v.to_str().unwrap()),
            "body":serde_json::from_slice::<Value>(&body).ok()}),
                );
                let body = match () {
                    _ if parts.method == "HEAD" || parts.method == "DELETE" => "",
                    _ if parts.uri.path().ends_with("/rpc/add") => "12",
                    _ => r#"[{"id":1,"body":"hello"}]"#,
                };
                Response::builder()
                    .status(match parts.method == "DELETE" {
                        true => 204,
                        false => 200,
                    })
                    .header("content-range", "0-0/17")
                    .body(Body::from(body))
                    .unwrap()
            },
        ))
        .with_state(seen.clone());
    let (url, task) = serve(router).await;
    let client = Client::builder(url)
        .access_token("caller-token")
        .build()
        .unwrap();
    let base = client
        .from("notes")
        .select("id, body")
        .eq("owner", "a,b()\"\\&x=1");
    let query = base
        .clone()
        .or([
            Condition::eq("body", "a,b()\"\\"),
            Condition::all([
                Condition::gt("id", 0),
                !Condition::is("deleted", IsValue::True),
            ]),
        ])
        .order("id", Order::descending())
        .order("body", Order::ascending().nulls_first(false))
        .range(0, 19)
        .count_exact();
    let response = query.execute::<Vec<Value>>().await.unwrap();
    assert_eq!(response.count, Some(17));
    assert_eq!(
        base.clone().single().execute::<Value>().await.unwrap().data["id"],
        1
    );
    assert_eq!(
        base.count_exact()
            .head()
            .execute::<()>()
            .await
            .unwrap()
            .count,
        Some(17)
    );
    client
        .from("notes")
        .insert(&json!({"body":"hello"}))
        .select("id")
        .execute::<Vec<Value>>()
        .await
        .unwrap();
    client
        .from("notes")
        .upsert(
            &json!({"id":1}),
            UpsertOptions {
                on_conflict: vec!["id".into()],
                ignore_duplicates: true,
            },
        )
        .select("id")
        .execute::<Vec<Value>>()
        .await
        .unwrap();
    client
        .from("notes")
        .delete()
        .in_values("id", [1, 2])
        .execute::<()>()
        .await
        .unwrap();
    assert_eq!(
        client
            .rpc("add", &json!({"a":2}))
            .execute::<i32>()
            .await
            .unwrap()
            .data,
        12
    );
    let requests = seen.lock().await;
    let uri = url::Url::parse(&format!(
        "http://test{}",
        requests[0]["uri"].as_str().unwrap()
    ))
    .unwrap();
    let params: Vec<_> = uri.query_pairs().into_owned().collect();
    assert!(params.contains(&("owner".into(), "eq.a,b()\"\\&x=1".into())));
    assert!(
        params
            .iter()
            .any(|(k, v)| k == "or" && v.contains("body.eq.\"a,b()\\\"\\\\\""))
    );
    assert!(params.contains(&("order".into(), "id.desc,body.asc.nullslast".into())));
    assert_eq!(requests[0]["auth"], "Bearer caller-token");
    assert_eq!(requests[0]["prefer"], "count=exact");
    assert_eq!(requests[3]["prefer"], "return=representation");
    assert_eq!(
        requests[4]["prefer"],
        "resolution=ignore-duplicates,return=representation"
    );
    assert_eq!(requests[5]["method"], "DELETE");
    task.abort();
}

#[tokio::test]
async fn retries_are_bounded_and_mutations_are_never_replayed() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .fallback(any(
            |State(count): State<Arc<AtomicUsize>>, request: Request| async move {
                let n = count.fetch_add(1, Ordering::SeqCst);
                match request.method() == "GET" && n == 2 {
                    true => Response::builder().body(Body::from("[]")).unwrap(),
                    false => Response::builder()
                        .status(503)
                        .header("retry-after", "0")
                        .body(Body::from(
                            r#"{"code":"unavailable","message":"try later"}"#,
                        ))
                        .unwrap(),
                }
            },
        ))
        .with_state(attempts.clone());
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    client.from("notes").execute::<Vec<Value>>().await.unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    let error = client
        .from("notes")
        .insert(&json!({"body":"once"}))
        .execute::<()>()
        .await
        .unwrap_err();
    assert_eq!(attempts.load(Ordering::SeqCst), 4);
    assert_eq!(error.code(), "unavailable");
    assert_eq!(error.status(), Some(503));
    assert_eq!(error.retry_after(), Some(Duration::ZERO));
    task.abort();
}

#[tokio::test]
async fn long_retry_after_returns_immediately_and_body_deadline_applies() {
    let router = Router::new()
        .route(
            "/rest/v1/rate",
            any(|| async {
                Response::builder()
                    .status(429)
                    .header("retry-after", "31")
                    .body(Body::from("{}"))
                    .unwrap()
            }),
        )
        .route(
            "/rest/v1/slow",
            any(|| async {
                let stream = futures_util::stream::once(async {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"[]"))
                });
                Response::builder().body(Body::from_stream(stream)).unwrap()
            }),
        );
    let (url, task) = serve(router).await;
    let client = Client::builder(url)
        .timeout(Duration::from_millis(40))
        .build()
        .unwrap();
    assert_eq!(
        client
            .from("rate")
            .execute::<Value>()
            .await
            .unwrap_err()
            .retry_after(),
        Some(Duration::from_secs(31))
    );
    assert!(matches!(
        client.from("slow").execute::<Value>().await,
        Err(Error::Timeout)
    ));
    let token = nelcota_client::CancellationToken::new();
    token.cancel();
    let cancelled = client.with_options(RequestOptions {
        timeout: None,
        cancellation: Some(token),
    });
    assert!(matches!(
        cancelled.from("slow").execute::<Value>().await,
        Err(Error::Cancelled)
    ));
    task.abort();
}

#[tokio::test]
async fn malformed_json_empty_results_and_cardinality() {
    let router = Router::new()
        .route("/rest/v1/bad", any(|| async { "not json" }))
        .route("/rest/v1/zero", any(|| async { "[]" }))
        .route("/rest/v1/two", any(|| async { "[{\"id\":1},{\"id\":2}]" }));
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    assert!(matches!(
        client.from("bad").execute::<Value>().await,
        Err(Error::InvalidResponse { status: 200, .. })
    ));
    assert!(
        client
            .from("zero")
            .maybe_single()
            .execute::<Option<Value>>()
            .await
            .unwrap()
            .data
            .is_none()
    );
    assert_eq!(
        client
            .from("zero")
            .single()
            .execute::<Value>()
            .await
            .unwrap_err()
            .code(),
        "not_single"
    );
    assert_eq!(
        client
            .from("two")
            .maybe_single()
            .execute::<Option<Value>>()
            .await
            .unwrap_err()
            .code(),
        "not_single"
    );
    task.abort();
}

#[tokio::test]
async fn error_bodies_keep_postgres_fields_and_bodyless_codes() {
    let router = Router::new()
        .route(
            "/rest/v1/dup",
            any(|| async {
                Response::builder()
                    .status(409)
                    .body(Body::from(
                        r#"{"code":"db_error","message":"duplicate (23505)","sqlstate":"23505","details":"Key (slug)=(a) already exists.","hint":"pick another","constraint":"notes_slug_key"}"#,
                    ))
                    .unwrap()
            }),
        )
        .route(
            "/rest/v1/hidden",
            any(|| async { Response::builder().status(403).body(Body::empty()).unwrap() }),
        );
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    let error = client
        .from("dup")
        .insert(&json!({"slug":"a"}))
        .execute::<()>()
        .await
        .unwrap_err();
    assert_eq!(error.code(), "db_error");
    assert_eq!(error.sqlstate(), Some("23505"));
    assert_eq!(error.details(), Some("Key (slug)=(a) already exists."));
    assert_eq!(error.hint(), Some("pick another"));
    assert_eq!(error.constraint(), Some("notes_slug_key"));
    assert!(error.is_conflict() && error.is_unique_violation());
    let hidden = client
        .from("hidden")
        .select("*")
        .count_exact()
        .head()
        .execute::<Value>()
        .await
        .unwrap_err();
    assert_eq!(hidden.code(), "forbidden");
    assert!(hidden.is_forbidden() && hidden.db_info().is_none());
    task.abort();
}

#[tokio::test]
async fn default_headers_are_sent_and_validated() {
    let router = Router::new().fallback(any(|request: Request| async move {
        let get = |name: &str| {
            request
                .headers()
                .get(name)
                .map(|v| v.to_str().unwrap().to_owned())
        };
        Response::new(Body::from(
            json!([get("x-app"), get("x-trace"), get("authorization")]).to_string(),
        ))
    }));
    let (url, task) = serve(router).await;
    let client = Client::builder(&url)
        .header("x-app", "first")
        .header("X-App", "notes")
        .header("x-trace", "abc")
        .access_token("token")
        .build()
        .unwrap();
    let seen = client.from("t").execute::<Value>().await.unwrap().data;
    assert_eq!(seen, json!(["notes", "abc", "Bearer token"]));
    for (name, value) in [
        ("authorization", "Bearer x"),
        ("bad name", "v"),
        ("x-ok", "a\nb"),
    ] {
        let error = Client::builder(&url)
            .header(name, value)
            .build()
            .unwrap_err();
        assert_eq!(error.code(), "invalid_input");
    }
    task.abort();
}

#[tokio::test]
async fn unsafe_input_is_rejected_without_network() {
    let client = Client::builder("http://127.0.0.1:1").build().unwrap();
    for query in [
        client.from("../notes"),
        client.from("notes").eq("x&order", 1).range(9, 2),
        client.from("notes").update(&json!({"body":"no filter"})),
        client.from("notes").delete().eq("items.id", 1),
        client.from("notes").insert(&json!([])),
        client.from("notes").eq("x", f64::NAN),
        client.from("notes").or(Vec::new()),
        client.from("notes").select("id\"evil"),
    ] {
        assert!(matches!(
            query.execute::<Value>().await,
            Err(Error::Usage(_))
        ));
    }
    assert!(
        Client::builder("https://secret:password@example.com")
            .build()
            .is_err()
    );
    assert!(Client::builder("https://example.com?q=x").build().is_err());
    assert!(
        Client::builder("https://example.com")
            .access_token("bad\r\nvalue")
            .build()
            .is_err()
    );
    assert!(client.storage().from("sign").is_err());
    let files = client.storage().from("files").unwrap();
    for name in ["../x", "a//b", "a\\b", "a/./b", "a/\u{0000}"] {
        assert!(files.public_url(name).is_err());
    }
    let normalized = files.public_url("cafe\u{0301}/a?#%.txt").unwrap();
    assert!(normalized.as_str().contains("caf%C3%A9/a%3F%23%25.txt"));
}

#[test]
fn group_limits_and_query_clone() {
    let client = Client::builder("https://api.example.com/prefix/")
        .build()
        .unwrap();
    let base = client.from("notes").eq("id", 1);
    assert!(
        !base
            .clone()
            .limit(5)
            .query_string()
            .unwrap()
            .contains("limit=10")
    );
    assert!(!base.query_string().unwrap().contains("limit="));
    let mut nested = Condition::eq("x", "a,b)");
    for _ in 0..8 {
        nested = Condition::all([nested]);
    }
    assert!(client.from("notes").or([nested]).query_string().is_err());
    assert!(
        client
            .from("notes")
            .or((0..101).map(|n| Condition::eq("x", n)))
            .query_string()
            .is_err()
    );
}

#[tokio::test]
async fn explicit_query_timeout_overrides_a_scoped_default() {
    let (url, task) = serve(Router::new().fallback(any(|| async {
        tokio::time::sleep(Duration::from_millis(80)).await;
        axum::Json(json!([]))
    })))
    .await;
    let client = Client::builder(url)
        .retries(0)
        .build()
        .unwrap()
        .with_options(RequestOptions {
            timeout: Some(Duration::from_millis(300)),
            cancellation: None,
        });
    assert!(matches!(
        client
            .from("notes")
            .select("*")
            .timeout(Duration::from_millis(10))
            .execute::<Value>()
            .await,
        Err(Error::Timeout)
    ));
    assert!(
        client
            .from("notes")
            .select("*")
            .timeout(Duration::ZERO)
            .execute::<Value>()
            .await
            .is_ok()
    );
    task.abort();
}

#[tokio::test]
async fn shared_row_precision_and_error_fixtures_preserve_the_wire_contract() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/protocol.json")).unwrap();
    let failure = fixture["http_error"].clone();
    let failure_body = failure["body"].clone();
    let retry_after = failure["retry_after"].as_str().unwrap().to_owned();
    let rows = fixture["numeric_rows"].as_str().unwrap().to_owned();
    let (url, task) = serve(Router::new().fallback(any(move |request: Request| {
        let body = failure_body.clone();
        let retry = retry_after.clone();
        let rows = rows.clone();
        async move {
            if request.uri().path().ends_with("failure") {
                return Response::builder()
                    .status(429)
                    .header("retry-after", retry)
                    .body(Body::from(body.to_string()))
                    .unwrap();
            }
            Response::new(Body::from(rows))
        }
    })))
    .await;
    let client = Client::builder(url).retries(0).build().unwrap();
    let response = client
        .from("notes")
        .select("*")
        .execute::<Value>()
        .await
        .unwrap();
    assert_eq!(
        response.data[0]["id"].to_string(),
        fixture["exact_id"].as_str().unwrap()
    );
    assert_eq!(
        response.data[0]["decimal"].to_string(),
        fixture["exact_decimal"].as_str().unwrap()
    );
    let error = client
        .from("failure")
        .select("*")
        .execute::<Value>()
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(429));
    assert_eq!(error.code(), failure["body"]["code"].as_str().unwrap());
    assert_eq!(error.retry_after(), Some(Duration::from_secs(17)));
    task.abort();
}

#[tokio::test]
async fn reserved_filter_columns_are_kept_separate_from_modifiers() {
    let observed = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let router = Router::new().fallback(any({
        let observed = observed.clone();
        move |request: Request| {
            observed
                .lock()
                .unwrap()
                .push(request.uri().query().unwrap_or_default().to_owned());
            async { axum::Json(json!([])) }
        }
    }));
    let (url, task) = serve(router).await;
    let client = Client::builder(url).build().unwrap();
    client
        .from("notes")
        .select("*")
        .eq("limit", 5)
        .limit(10)
        .execute::<Value>()
        .await
        .unwrap();
    client
        .from("notes")
        .select("items(limit)")
        .is_null("items.limit")
        .execute::<Value>()
        .await
        .unwrap();
    task.abort();
    let paths = observed.lock().unwrap();
    let first: Vec<_> = url::form_urlencoded::parse(paths[0].as_bytes()).collect();
    let second: Vec<_> = url::form_urlencoded::parse(paths[1].as_bytes()).collect();
    assert!(
        first
            .iter()
            .any(|(key, value)| key == "and" && value == "(limit.eq.\"5\")")
    );
    assert!(
        first
            .iter()
            .any(|(key, value)| key == "limit" && value == "10")
    );
    assert!(
        second
            .iter()
            .any(|(key, value)| key == "items.and" && value == "(limit.is.null)")
    );
}
