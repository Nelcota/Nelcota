//! Tests of the automatic REST API against a real Postgres: CRUD, filters, RLS
//! on every verb, SQL injection, RPC, OpenAPI, catalog reload and a basic
//! performance check.

mod common;

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode, header};
use common::*;
use serde_json::{Value, json};

const REPR: (&str, &str) = ("prefer", "return=representation");

fn ids(body: &Value) -> Vec<i64> {
    body.as_array()
        .unwrap_or_else(|| panic!("expected an array: {body}"))
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

fn names(body: &Value) -> Vec<&str> {
    body.as_array()
        .unwrap_or_else(|| panic!("expected an array: {body}"))
        .iter()
        .map(|r| r["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn full_crud_with_representation() {
    let app = TestApp::spawn().await;
    let a = user_token(app.user_a);

    // POST with representation: user_id comes from the DEFAULT auth.uid().
    let created = app
        .request_with(
            Method::POST,
            "/rest/v1/todos",
            Some(&a),
            Some(json!({ "title": "new", "tags": ["home", "urgent"], "extra": { "x": 1 } })),
            &[REPR],
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let row = &created.body[0];
    assert_eq!(row["user_id"], app.user_a.to_string());
    assert_eq!(row["priority"], "medium");
    assert_eq!(row["tags"], json!(["home", "urgent"]));
    assert_eq!(row["extra"], json!({ "x": 1 }));
    let id = row["id"].as_i64().unwrap();

    // Minimal POST: 201 without a body.
    let minimal = app
        .post(
            "/rest/v1/todos",
            Some(&a),
            json!([{ "title": "x" }, { "title": "y" }]),
        )
        .await;
    assert_eq!(minimal.status, StatusCode::CREATED);
    assert_eq!(minimal.body, Value::Null);

    let (status, body) = app
        .get(
            &format!("/rest/v1/todos?id=eq.{id}&select=id,title,done"),
            Some(&a),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([{ "id": id, "title": "new", "done": false }]));

    let patched = app
        .request_with(
            Method::PATCH,
            &format!("/rest/v1/todos?id=eq.{id}&select=id,done"),
            Some(&a),
            Some(json!({ "done": true, "priority": "high" })),
            &[REPR],
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
    assert_eq!(patched.body, json!([{ "id": id, "done": true }]));

    let minimal = app
        .request(
            Method::PATCH,
            &format!("/rest/v1/todos?id=eq.{id}"),
            Some(&a),
            Some(json!({ "title": "renamed" })),
        )
        .await;
    assert_eq!(minimal.status, StatusCode::NO_CONTENT);

    let deleted = app
        .request_with(
            Method::DELETE,
            &format!("/rest/v1/todos?id=eq.{id}"),
            Some(&a),
            None,
            &[REPR],
        )
        .await;
    assert_eq!(deleted.status, StatusCode::OK);
    assert_eq!(deleted.body[0]["title"], "renamed");

    let (_, body) = app
        .get(&format!("/rest/v1/todos?id=eq.{id}"), Some(&a))
        .await;
    assert_eq!(body, json!([]));
}

#[tokio::test]
async fn rls_holds_on_every_verb() {
    let app = TestApp::spawn().await;
    let a = user_token(app.user_a);
    let b_id: i64 = app
        .admin_client
        .query_one(
            "SELECT id FROM public.todos WHERE user_id = $1",
            &[&app.user_b],
        )
        .await
        .unwrap()
        .get(0);

    // GET: A does not see B's row, not even filtering by its id.
    let (_, body) = app
        .get(&format!("/rest/v1/todos?id=eq.{b_id}"), Some(&a))
        .await;
    assert_eq!(body, json!([]));

    // PATCH/DELETE on B's row: zero rows affected.
    for method in [Method::PATCH, Method::DELETE] {
        let reply = app
            .request_with(
                method.clone(),
                &format!("/rest/v1/todos?id=eq.{b_id}"),
                Some(&a),
                (method == Method::PATCH).then(|| json!({ "title": "hijacked" })),
                &[REPR],
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{method}");
        assert_eq!(reply.body, json!([]), "{method}");
    }

    // POST on behalf of B: policy violation (WITH CHECK).
    let reply = app
        .post(
            "/rest/v1/todos",
            Some(&a),
            json!({ "title": "forged", "user_id": app.user_b }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{}", reply.body);

    // PATCH trying to hand one's own row to B: also blocked.
    let reply = app
        .request(
            Method::PATCH,
            "/rest/v1/todos?title=eq.task%20of%20A",
            Some(&a),
            Some(json!({ "user_id": app.user_b })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    // B's row stays intact.
    let title: String = app
        .admin_client
        .query_one("SELECT title FROM public.todos WHERE id = $1", &[&b_id])
        .await
        .unwrap()
        .get(0);
    assert_eq!(title, "task of B");

    // anon: no GRANT, 401 on every verb.
    for (method, body) in [
        (Method::GET, None),
        (Method::POST, Some(json!({ "title": "x" }))),
        (Method::PATCH, Some(json!({ "title": "x" }))),
        (Method::DELETE, None),
    ] {
        let path = match method == Method::POST {
            true => "/rest/v1/todos",
            false => "/rest/v1/todos?id=gt.0",
        };
        let reply = app.request(method.clone(), path, None, body).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method}");
    }

    // authenticated without a write GRANT on products: 403. service_role: ok.
    let reply = app
        .post(
            "/rest/v1/products",
            Some(&a),
            json!({ "name": "X", "price": 1 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app
        .post(
            "/rest/v1/products",
            Some(&service_token()),
            json!({ "name": "X", "price": 1 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);

    // Table without a GRANT for users.
    let (status, _) = app.get("/rest/v1/secrets", Some(&a)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app.get("/rest/v1/secrets", Some(&service_token())).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn filters_order_paging_and_count() {
    let app = TestApp::spawn().await;
    let get = |q: &str| {
        let path = format!("/rest/v1/products?{q}");
        let app = &app;
        async move { app.get(&path, None).await }
    };

    let (_, b) = get("price=gt.10&order=price.desc").await;
    assert_eq!(names(&b), ["Backpack", "Notebook"]);
    let (_, b) = get("stock=eq.0").await;
    assert_eq!(names(&b), ["Backpack"]);
    let (_, b) = get("stock=neq.0&order=name").await;
    assert_eq!(names(&b), ["Notebook", "Pen", "Ruler, 30cm"]);
    let (_, b) = get("price=lte.4&price=gte.3").await;
    assert_eq!(names(&b), ["Ruler, 30cm"]);
    let (_, b) = get("name=in.(Pen,\"Ruler, 30cm\")&order=id").await;
    assert_eq!(names(&b), ["Pen", "Ruler, 30cm"]);
    let (_, b) = get("name=in.()").await;
    assert_eq!(b, json!([]));
    let (_, b) = get("name=like.*e*&order=name").await;
    assert_eq!(names(&b), ["Notebook", "Pen", "Ruler, 30cm"]);
    let (_, b) = get("name=ilike.*PACK").await;
    assert_eq!(names(&b), ["Backpack"]);
    let (_, b) = get("name=not.like.P*&order=name.desc").await;
    assert_eq!(names(&b), ["Ruler, 30cm", "Notebook", "Backpack"]);
    let (_, b) = get("slug=eq.backpack&select=name,slug").await;
    assert_eq!(b, json!([{ "name": "Backpack", "slug": "backpack" }]));
    let (_, b) = get("created_at=not.is.null&select=id&order=id&limit=2&offset=1").await;
    assert_eq!(ids(&b), [2, 3]);

    // Content-Range and count=exact.
    let reply = app
        .request_with(
            Method::GET,
            "/rest/v1/products?order=id&limit=2&offset=1",
            None,
            None,
            &[("prefer", "count=exact")],
        )
        .await;
    assert_eq!(reply.headers[header::CONTENT_RANGE], "1-2/4");
    let reply = app
        .request(Method::GET, "/rest/v1/products?stock=gt.1000", None, None)
        .await;
    assert_eq!(reply.headers[header::CONTENT_RANGE], "*/*");

    // Filters on enum, array and boolean (as a user).
    let a = user_token(app.user_a);
    // Batch with different keys: missing columns get the DEFAULT.
    let reply = app
        .post(
            "/rest/v1/todos",
            Some(&a),
            json!([
                { "title": "high", "priority": "high", "tags": ["x"] },
                { "title": "low", "priority": "low", "done": true },
            ]),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let (_, b) = app
        .get("/rest/v1/todos?priority=eq.high&select=title", Some(&a))
        .await;
    assert_eq!(b, json!([{ "title": "high" }]));
    let (_, b) = app
        .get("/rest/v1/todos?done=is.true&select=title", Some(&a))
        .await;
    assert_eq!(b, json!([{ "title": "low" }]));
    let (_, b) = app
        .get(
            "/rest/v1/todos?priority=in.(high,low)&select=title&order=title",
            Some(&a),
        )
        .await;
    assert_eq!(b, json!([{ "title": "high" }, { "title": "low" }]));
}

#[tokio::test]
async fn max_rows_caps_reads() {
    let app = TestApp::spawn_with(Options {
        max_rows: Some(2),
        ..Options::default()
    })
    .await;
    let (_, b) = app.get("/rest/v1/products?order=id", None).await;
    assert_eq!(ids(&b), [1, 2]);
    let (_, b) = app.get("/rest/v1/products?order=id&limit=100", None).await;
    assert_eq!(ids(&b).len(), 2);
}

#[tokio::test]
async fn data_errors_become_400() {
    let app = TestApp::spawn().await;
    let s = service_token();
    for (case, body) in [
        ("check", json!({ "name": "X", "price": -1 })),
        ("not null", json!({ "price": 1 })),
        ("type", json!({ "name": "X", "price": "expensive" })),
        (
            "generated column",
            json!({ "name": "X", "price": 1, "slug": "y" }),
        ),
        (
            "unknown column",
            json!({ "name": "X", "price": 1, "color": "blue" }),
        ),
    ] {
        let reply = app.post("/rest/v1/products", Some(&s), body).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{case}: {}",
            reply.body
        );
    }
    let (status, _) = app.get("/rest/v1/products?price=eq.abc", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.get("/rest/v1/products?id=gt.1&stock=lt.x", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Duplicate PK: 409.
    let reply = app
        .post(
            "/rest/v1/products",
            Some(&s),
            json!({ "id": 1, "name": "X", "price": 1 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);

    // An empty body is refused, not inserted as a row of defaults.
    let reply = app
        .request_with(Method::POST, "/rest/v1/products", Some(&s), None, &[])
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_body", "{}", reply.body);
    let before = app.get("/rest/v1/todos?select=id", Some(&s)).await.1;
    let reply = app
        .request_with(Method::POST, "/rest/v1/todos", Some(&s), None, &[])
        .await;
    assert_eq!(reply.body["code"], "invalid_body", "{}", reply.body);
    assert_eq!(
        app.get("/rest/v1/todos?select=id", Some(&s)).await.1,
        before
    );
    // A body that is not JSON.
    let reply = app
        .raw(
            Method::POST,
            "/rest/v1/products",
            &[("authorization", &format!("Bearer {s}"))],
            "{".into(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["code"], "invalid_body");
    // RPC without a body still means "no arguments".
    let reply = app
        .request(Method::POST, "/rest/v1/rpc/add", None, None)
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "a is required");
    let reply = app
        .request(Method::POST, "/rest/v1/rpc/nothing", None, None)
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);

    // PATCH/DELETE without a filter are refused.
    let reply = app
        .request(Method::DELETE, "/rest/v1/products", Some(&s), None)
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = app
        .request(
            Method::PATCH,
            "/rest/v1/products",
            Some(&s),
            Some(json!({ "stock": 0 })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let (status, _) = app.get("/rest/v1/does_not_exist", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sql_injection_in_identifiers_and_values() {
    let app = TestApp::spawn().await;
    let s = service_token();

    // Malicious identifiers: rejected before reaching the database.
    for path in [
        "/rest/v1/products;DROP%20TABLE%20products",
        "/rest/v1/products%22;DROP%20TABLE%20products;--",
        "/rest/v1/pg_catalog.pg_authid",
        "/rest/v1/..%2Fauth.users",
    ] {
        let (status, _) = app.get(path, Some(&s)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    for query in [
        "select=name,(SELECT%20password%20FROM%20auth.users)",
        "select=name%22,%22price",
        "select=*;DROP%20TABLE%20products",
        "order=name;DROP%20TABLE%20products",
        "order=(SELECT%201)",
        "name%22%3D%27x%27%20OR%201%3D1--=eq.1",
        "id=eq.1&1=1",
        "limit=1;DROP%20TABLE%20products",
        "id=in.(1)%29%20OR%20(1=1",
    ] {
        let (status, body) = app
            .get(&format!("/rest/v1/products?{query}"), Some(&s))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
    }

    // Malicious values: treated as data.
    let payload = "x'); DROP TABLE products; --";
    let (status, body) = app
        .get(
            &format!("/rest/v1/products?name=eq.{}", urlencode(payload)),
            Some(&s),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!([])));
    let (status, _) = app
        .get(
            &format!(
                "/rest/v1/products?name=in.({},\"a\\\"b\")",
                urlencode(payload)
            ),
            Some(&s),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let created = app
        .request_with(
            Method::POST,
            "/rest/v1/products",
            Some(&s),
            Some(json!({ "name": payload, "price": 1 })),
            &[REPR],
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(created.body[0]["name"], payload);

    // Malicious keys in the body and function names.
    let reply = app
        .post(
            "/rest/v1/products",
            Some(&s),
            json!({ "name\" text); DROP TABLE products; --": "x" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = app
        .post(
            "/rest/v1/rpc/add;DROP%20TABLE%20products",
            Some(&s),
            json!({}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app
        .post(
            "/rest/v1/rpc/add",
            Some(&s),
            json!({ "a) ; DROP TABLE products; --": 1 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    // Everything is still there.
    let count: i64 = app
        .admin_client
        .query_one("SELECT count(*) FROM public.products", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 5);
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tokio::test]
async fn rpc_calls_functions_under_the_jwt_role() {
    let app = TestApp::spawn().await;
    let a = user_token(app.user_a);

    let reply = app.post("/rest/v1/rpc/add", None, json!({ "a": 1 })).await;
    assert_eq!((reply.status, reply.body), (StatusCode::OK, json!(11)));
    let reply = app
        .post("/rest/v1/rpc/add", None, json!({ "a": 1, "b": 2 }))
        .await;
    assert_eq!(reply.body, json!(3));
    let reply = app
        .post("/rest/v1/rpc/add", None, json!({ "a": 1, "c": 2 }))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = app.post("/rest/v1/rpc/add", None, json!({})).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    // SETOF functions obey the table's RLS.
    let reply = app
        .post("/rest/v1/rpc/my_open_todos", Some(&a), json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body.as_array().unwrap().len(), 1);
    assert_eq!(reply.body[0]["title"], "task of A");

    // auth.uid()/auth.role() inside the function reflect the JWT.
    let reply = app.post("/rest/v1/rpc/who_am_i", Some(&a), json!({})).await;
    assert_eq!(
        reply.body,
        json!({ "uid": app.user_a, "role": "authenticated" })
    );
    let reply = app
        .request(Method::POST, "/rest/v1/rpc/who_am_i", None, None)
        .await;
    assert_eq!(reply.body, json!({ "uid": null, "role": "anon" }));

    let reply = app.post("/rest/v1/rpc/nothing", None, json!({})).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = app.post("/rest/v1/rpc/fail", None, json!({})).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(
        reply.body["message"]
            .as_str()
            .unwrap()
            .contains("business rule")
    );
    let reply = app
        .post("/rest/v1/rpc/does_not_exist", None, json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // EXECUTE revoked from PUBLIC: anon 401, authenticated 403, service ok.
    let reply = app.post("/rest/v1/rpc/service_only", None, json!({})).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let reply = app
        .post("/rest/v1/rpc/service_only", Some(&a), json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app
        .post(
            "/rest/v1/rpc/service_only",
            Some(&service_token()),
            json!({}),
        )
        .await;
    assert_eq!(reply.body, json!("ok"));
}

#[tokio::test]
async fn openapi_follows_the_role_privileges() {
    let app = TestApp::spawn().await;

    let (status, anon) = app.get("/rest/v1/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(anon["openapi"], "3.0.3");
    let paths = anon["paths"].as_object().unwrap();
    assert!(paths.contains_key("/products"));
    assert!(paths["/products"].get("get").is_some());
    assert!(paths["/products"].get("post").is_none());
    assert!(!paths.contains_key("/todos"));
    assert!(!paths.contains_key("/secrets"));
    assert!(paths.contains_key("/rpc/add"));
    assert!(!paths.contains_key("/rpc/service_only"));
    let product = &anon["components"]["schemas"]["products"];
    assert_eq!(product["properties"]["price"]["type"], "number");
    assert_eq!(product["properties"]["id"]["type"], "integer");
    assert_eq!(product["description"], "Product catalog");

    let (_, user) = app.get("/rest/v1/", Some(&user_token(app.user_a))).await;
    let todos = &user["paths"]["/todos"];
    for verb in ["get", "post", "patch", "delete"] {
        assert!(todos.get(verb).is_some(), "{verb}");
    }
    let priority = &user["components"]["schemas"]["todos"]["properties"]["priority"];
    assert_eq!(priority["enum"], json!(["low", "medium", "high"]));

    let (_, service) = app.get("/rest/v1/", Some(&service_token())).await;
    assert!(service["paths"].get("/secrets").is_some());
    assert!(service["paths"].get("/rpc/service_only").is_some());
}

#[tokio::test]
async fn catalog_reloads_on_its_own_after_ddl() {
    let app = TestApp::spawn().await;
    let (status, _) = app.get("/rest/v1/news", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    app.admin_client
        .batch_execute(
            "CREATE TABLE public.news (id int PRIMARY KEY, body text);
             INSERT INTO public.news VALUES (1, 'hello');
             GRANT SELECT ON public.news TO anon;",
        )
        .await
        .unwrap();

    // The event trigger notifies; the listener reloads within ~100 ms.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (status, body) = app.get("/rest/v1/news", None).await;
        if status == StatusCode::OK {
            assert_eq!(body, json!([{ "id": 1, "body": "hello" }]));
            break;
        }
        assert!(Instant::now() < deadline, "catalog did not reload");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // New columns show up too.
    app.admin_client
        .batch_execute("ALTER TABLE public.news ADD COLUMN read boolean DEFAULT false")
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while app
        .catalog
        .get()
        .table("news")
        .unwrap()
        .column("read")
        .is_none()
    {
        assert!(Instant::now() < deadline, "the new column did not show up");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (status, _) = app.get("/rest/v1/news?read=is.false", None).await;
    assert_eq!(status, StatusCode::OK);

    // A slow introspection must coalesce notices without blocking the
    // PostgreSQL connection driver or losing the final schema snapshot.
    let mut held = Vec::new();
    for _ in 0..app.pool.status().max_size {
        held.push(app.pool.get().await.unwrap());
    }
    app.admin_client
        .batch_execute("NOTIFY nelcota, 'blocked-refresh'")
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.pool.status().waiting == 0 {
        assert!(
            Instant::now() < deadline,
            "listener did not request a reload"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    app.admin_client
        .batch_execute(
            "ALTER TABLE public.news ADD COLUMN priority int DEFAULT 1;
             SELECT pg_notify('nelcota', i::text) FROM generate_series(1, 2000) i;",
        )
        .await
        .unwrap();
    assert!(
        app.catalog
            .get()
            .table("news")
            .unwrap()
            .column("priority")
            .is_none()
    );
    drop(held);
    let deadline = Instant::now() + Duration::from_secs(10);
    while app
        .catalog
        .get()
        .table("news")
        .unwrap()
        .column("priority")
        .is_none()
    {
        assert!(
            Instant::now() < deadline,
            "burst lost the final catalog change"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Not a benchmark (that lives in `bench/`): it only ensures a simple read does
/// not degrade absurdly, even in a debug build.
#[tokio::test]
async fn basic_read_performance() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute(
            "INSERT INTO public.products (name, price, stock)
             SELECT 'product ' || i, (i % 500) + 0.99, i % 7 FROM generate_series(1, 20000) i;
             ANALYZE public.products;",
        )
        .await
        .unwrap();

    let requests = 300;
    let started = Instant::now();
    for i in 0..requests {
        let (status, body) = app
            .get(
                &format!("/rest/v1/products?stock=eq.{}&order=id&limit=20", i % 7),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 20);
    }
    let average = started.elapsed() / requests;
    println!("simple read: average of {average:?} per request ({requests} requests)");
    assert!(average < Duration::from_millis(100), "average {average:?}");
}

#[tokio::test]
async fn or_and_groups_filter_like_postgrest() {
    let app = TestApp::spawn().await;
    let get = |q: &str| {
        let path = format!("/rest/v1/products?{q}");
        let app = &app;
        async move { app.get(&path, None).await }
    };

    let (_, b) = get("or=(stock.eq.0,price.lt.3)&order=name").await;
    assert_eq!(names(&b), ["Backpack", "Pen"]);
    // Nested group, and a quoted value with a comma.
    let (_, b) = get("or=(name.eq.\"Ruler, 30cm\",and(price.gt.10,stock.gt.0))&order=name").await;
    assert_eq!(names(&b), ["Notebook", "Ruler, 30cm"]);
    let (_, b) = get("not.or=(stock.eq.0,price.lt.3)&order=name").await;
    assert_eq!(names(&b), ["Notebook", "Ruler, 30cm"]);
    // A tree is ANDed with the other filters.
    let (_, b) = get("or=(price.gt.100,price.lt.3)&stock=gt.0").await;
    assert_eq!(names(&b), ["Pen"]);
    let (_, b) = get("and=(price.gte.4,price.lte.15)&order=price").await;
    assert_eq!(names(&b), ["Ruler, 30cm", "Notebook"]);

    let (status, b) = get("or=(name.eq.Pen").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(b["code"], "invalid_query");
}

/// An `or` cannot widen what RLS allows: the policy is ANDed by Postgres.
#[tokio::test]
async fn rls_still_filters_inside_or() {
    let app = TestApp::spawn().await;
    let a = user_token(app.user_a);
    let b = user_token(app.user_b);
    let titles = |body: &Value| -> Vec<String> {
        body.as_array()
            .unwrap()
            .iter()
            .map(|r| r["title"].as_str().unwrap().to_owned())
            .collect()
    };

    let path = format!(
        "/rest/v1/todos?or=(user_id.eq.{},title.eq.task of B,title.eq.task of A)",
        app.user_b
    );
    let (status, body) = app.get(&path, Some(&a)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(titles(&body), ["task of A"]);

    // PATCH with the same tree changes only A's row.
    let reply = app
        .request_with(
            Method::PATCH,
            "/rest/v1/todos?or=(title.eq.task of A,title.eq.task of B)",
            Some(&a),
            Some(json!({ "done": true })),
            &[REPR],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(titles(&reply.body), ["task of A"]);
    let (_, theirs) = app.get("/rest/v1/todos", Some(&b)).await;
    assert_eq!(theirs[0]["done"], false, "B's row is untouched");
}

#[tokio::test]
async fn upsert_merges_or_ignores_duplicates() {
    let app = TestApp::spawn().await;
    let service = token(json!({ "role": "service_role" }));
    let post = |path: &'static str, prefer: &'static str, body: Value| {
        let app = &app;
        let service = service.clone();
        async move {
            app.request_with(
                Method::POST,
                path,
                Some(&service),
                Some(body),
                &[("prefer", prefer)],
            )
            .await
        }
    };
    let product = |name: &'static str| {
        let app = &app;
        async move {
            let (_, b) = app
                .get(&format!("/rest/v1/products?name=eq.{name}"), None)
                .await;
            b[0].clone()
        }
    };

    // Merge on the primary key: Pen (id 1) is updated, Eraser is created; the
    // stock not sent keeps its value.
    let reply = post(
        "/rest/v1/products",
        "resolution=merge-duplicates,return=representation",
        json!([
            { "id": 1, "name": "Pen", "price": 3.00 },
            { "id": 99, "name": "Eraser", "price": 1.00 },
        ]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(
        reply.headers["preference-applied"],
        "resolution=merge-duplicates"
    );
    assert_eq!(names(&reply.body), ["Pen", "Eraser"]);
    let pen = product("Pen").await;
    assert_eq!(
        (pen["price"].as_f64(), pen["stock"].as_i64()),
        (Some(3.0), Some(100))
    );

    // Ignore: the existing row stays as it was and nothing comes back.
    let reply = post(
        "/rest/v1/products",
        "resolution=ignore-duplicates,return=representation",
        json!({ "id": 1, "name": "Pen", "price": 9.99 }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert_eq!(reply.body, json!([]));
    assert_eq!(product("Pen").await["price"].as_f64(), Some(3.0));

    // on_conflict on a unique column.
    app.admin_client
        .batch_execute("CREATE UNIQUE INDEX products_name_key ON public.products (name)")
        .await
        .unwrap();
    let reply = post(
        "/rest/v1/products?on_conflict=name",
        "resolution=merge-duplicates",
        json!({ "name": "Notebook", "price": 20.00 }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(product("Notebook").await["price"].as_f64(), Some(20.0));

    // Mistakes are 400, not 500.
    for (path, prefer, body) in [
        // no unique constraint on stock
        (
            "/rest/v1/products?on_conflict=stock",
            "resolution=merge-duplicates",
            json!({ "name": "A", "price": 1, "stock": 0 }),
        ),
        // on_conflict without a resolution
        (
            "/rest/v1/products?on_conflict=name",
            "return=minimal",
            json!({ "name": "A", "price": 1 }),
        ),
        // the same key twice in one batch
        (
            "/rest/v1/products",
            "resolution=merge-duplicates",
            json!([{ "id": 2, "name": "A", "price": 1 }, { "id": 2, "name": "B", "price": 1 }]),
        ),
    ] {
        let reply = post(path, prefer, body).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{path} {prefer}: {}",
            reply.body
        );
    }
    let (status, _) = app.get("/rest/v1/products?on_conflict=name", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// An upsert cannot take over someone else's row: on a conflict, Postgres
/// checks the UPDATE policy against the existing row, which belongs to B.
#[tokio::test]
async fn upsert_respects_rls() {
    let app = TestApp::spawn().await;
    let a = user_token(app.user_a);
    let b = user_token(app.user_b);
    // `todos.id` is GENERATED ALWAYS, so it cannot be sent; resolve on a
    // unique title instead.
    app.admin_client
        .batch_execute("CREATE UNIQUE INDEX todos_title_key ON public.todos (title)")
        .await
        .unwrap();
    let upsert = |token: String, body: Value| {
        let app = &app;
        async move {
            app.request_with(
                Method::POST,
                "/rest/v1/todos?on_conflict=title",
                Some(&token),
                Some(body),
                &[(
                    "prefer",
                    "resolution=merge-duplicates,return=representation",
                )],
            )
            .await
        }
    };

    let reply = upsert(a.clone(), json!({ "title": "task of B", "done": true })).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{}", reply.body);
    let (_, theirs) = app.get("/rest/v1/todos", Some(&b)).await;
    assert_eq!(theirs[0]["done"], false, "B's row is untouched");

    // On their own rows, the upsert works as usual.
    let reply = upsert(a.clone(), json!({ "title": "task of A", "done": true })).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.body[0]["done"], true);
    let (_, mine) = app.get("/rest/v1/todos", Some(&a)).await;
    assert_eq!(mine.as_array().unwrap().len(), 1, "updated, not duplicated");
}

/// Waits until the catalog listener has picked up a table created by a test.
async fn wait_for_table(app: &TestApp, table: &str, token: Option<&str>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.get(&format!("/rest/v1/{table}?limit=0"), token).await.0 != StatusCode::OK {
        assert!(Instant::now() < deadline, "catalog did not pick up {table}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn generated_arrays_allow_null_elements_and_introspect_enum_elements() {
    let app = TestApp::spawn().await;
    app.admin_client.batch_execute(
        "CREATE TABLE public.nullable_elements (tags text[] NOT NULL, moods public.priority[] NOT NULL);
         INSERT INTO public.nullable_elements VALUES (ARRAY['valid', NULL], ARRAY['low'::public.priority, NULL]);
         GRANT SELECT ON public.nullable_elements TO anon;"
    ).await.unwrap();
    wait_for_table(&app, "nullable_elements", None).await;
    let (_, rows) = app.get("/rest/v1/nullable_elements", None).await;
    assert_eq!(rows[0]["tags"], json!(["valid", null]));
    assert_eq!(rows[0]["moods"], json!(["low", null]));
    let catalog = app.catalog.get();
    let column = catalog
        .table("nullable_elements")
        .unwrap()
        .column("moods")
        .unwrap();
    assert_eq!(column.enum_values, ["low", "medium", "high"]);
    let types = nelcota_api::typescript::generate(&catalog);
    assert!(types.contains("tags: (string | null)[];"), "{types}");
    assert!(
        types.contains("moods: (\"low\" | \"medium\" | \"high\" | null)[];"),
        "{types}"
    );
}

/// Sorts an embedded array so assertions do not depend on json_agg's order.
fn sorted_by(mut rows: Value, key: &str) -> Value {
    rows.as_array_mut()
        .unwrap()
        .sort_by_key(|r| r[key].to_string());
    rows
}

#[tokio::test]
async fn select_embeds_related_rows_in_both_directions() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.customers (id bigint PRIMARY KEY, name text NOT NULL);
             CREATE TABLE public.orders (
                 id bigint PRIMARY KEY,
                 customer_id bigint REFERENCES public.customers (id),
                 total numeric(10,2) NOT NULL);
             CREATE TABLE public.items (
                 id bigint PRIMARY KEY,
                 order_id bigint NOT NULL REFERENCES public.orders (id),
                 product text NOT NULL,
                 qty int NOT NULL);
             INSERT INTO public.customers VALUES (1, 'Ana'), (2, 'Bia');
             INSERT INTO public.orders VALUES (10, 1, 30.00), (11, 2, 5.00), (12, NULL, 1.00);
             INSERT INTO public.items VALUES (100, 10, 'Pen', 2), (101, 10, 'Ruler', 1), (102, 11, 'Notebook', 1);
             GRANT SELECT ON public.customers, public.orders, public.items TO anon;
             GRANT ALL ON public.customers, public.orders, public.items TO service_role;",
        )
        .await
        .unwrap();
    wait_for_table(&app, "items", None).await;

    let (status, body) = app
        .get(
            "/rest/v1/orders?select=id,total,customers(name),items(product,qty)&order=id",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body[0]["customers"], json!({ "name": "Ana" }));
    assert_eq!(
        sorted_by(body[0]["items"].clone(), "product"),
        json!([{ "product": "Pen", "qty": 2 }, { "product": "Ruler", "qty": 1 }])
    );
    assert_eq!(body[1]["customers"], json!({ "name": "Bia" }));
    // No customer: null; no items: an empty array.
    assert_eq!(
        (&body[2]["customers"], &body[2]["items"]),
        (&Value::Null, &json!([]))
    );

    // The other direction, an alias and `*`.
    let (_, body) = app
        .get(
            "/rest/v1/customers?select=name,purchases:orders(*)&order=name",
            None,
        )
        .await;
    assert_eq!(body[0]["name"], "Ana");
    assert_eq!(body[0]["purchases"][0]["id"], 10);
    assert_eq!(body[0]["purchases"][0]["total"], 30.0);

    // Filters (including or=) still apply to the parent rows.
    let (_, body) = app
        .get(
            "/rest/v1/orders?select=id,customers(name)&or=(id.eq.10,id.eq.12)&order=id",
            None,
        )
        .await;
    assert_eq!(
        body,
        json!([{ "id": 10, "customers": { "name": "Ana" } }, { "id": 12, "customers": null }])
    );

    // The representation of a write can embed too.
    let service = token(json!({ "role": "service_role" }));
    let reply = app
        .request_with(
            Method::POST,
            "/rest/v1/orders?select=id,customers(name)",
            Some(&service),
            Some(json!({ "id": 13, "customer_id": 2, "total": 2.0 })),
            &[REPR],
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(
        reply.body,
        json!([{ "id": 13, "customers": { "name": "Bia" } }])
    );

    for bad in [
        "name,items(id)",
        "name,orders(id,nope(id))",
        "name,nope(id)",
    ] {
        let (status, body) = app
            .get(&format!("/rest/v1/customers?select={bad}"), None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
    }
}

#[tokio::test]
async fn embeds_nest_and_take_their_own_filters_order_and_paging() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.customers (id bigint PRIMARY KEY, name text NOT NULL);
             CREATE TABLE public.orders (
                 id bigint PRIMARY KEY,
                 customer_id bigint REFERENCES public.customers (id),
                 total numeric(10,2) NOT NULL);
             CREATE TABLE public.items (
                 id bigint PRIMARY KEY,
                 order_id bigint NOT NULL REFERENCES public.orders (id),
                 product text NOT NULL,
                 qty int NOT NULL);
             INSERT INTO public.customers VALUES (1, 'Ana'), (2, 'Bia');
             INSERT INTO public.orders VALUES (10, 1, 30.00), (11, 1, 5.00), (12, 1, 80.00), (13, 2, 1.00);
             INSERT INTO public.items VALUES (100, 10, 'Pen', 2), (101, 10, 'Ruler', 1),
                                             (102, 12, 'Bag', 1), (103, 13, 'Clip', 9);
             GRANT SELECT ON public.customers, public.orders, public.items TO anon;
             GRANT ALL ON public.customers, public.orders, public.items TO service_role;",
        )
        .await
        .unwrap();
    wait_for_table(&app, "items", None).await;

    // Two levels deep: customer → orders → items, and back up to the customer.
    let (status, body) = app
        .get(
            "/rest/v1/customers?select=name,orders(id,items(product),customers(name))&id=eq.2",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!([{ "name": "Bia", "orders": [
            { "id": 13, "items": [{ "product": "Clip" }], "customers": { "name": "Bia" } }
        ] }])
    );

    // Filters, order and limit on the embed narrow the embedded rows only:
    // Bia keeps her row with an empty array.
    let (status, body) = app
        .get(
            "/rest/v1/customers?select=name,orders(id,total)&orders.total=gte.5&orders.order=total.desc&orders.limit=2&order=id",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!([
            { "name": "Ana", "orders": [
                { "id": 12, "total": serde_json::from_str::<Value>("80.00").unwrap() },
                { "id": 10, "total": serde_json::from_str::<Value>("30.00").unwrap() }
            ] },
            { "name": "Bia", "orders": [] },
        ])
    );

    // A nested embed addressed by its path, with a logic tree and offset.
    let (status, body) = app
        .get(
            "/rest/v1/customers?select=name,orders(id,items(product))&id=eq.1&orders.id=eq.10&orders.items.or=(qty.eq.1,qty.gt.5)&orders.items.order=product",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!([{ "name": "Ana", "orders": [{ "id": 10, "items": [{ "product": "Ruler" }] }] }])
    );

    // A write's representation honours the embed's parameters too.
    let service = token(json!({ "role": "service_role" }));
    let reply = app
        .request_with(
            Method::PATCH,
            "/rest/v1/orders?id=eq.10&select=id,items(product)&items.qty=gt.1",
            Some(&service),
            Some(json!({ "total": 31.0 })),
            &[REPR],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        reply.body,
        json!([{ "id": 10, "items": [{ "product": "Pen" }] }])
    );

    for bad in [
        "select=id,customers(name)&customers.limit=1", // a single row has no paging
        "select=id,items(id)&items.nope=eq.1",
        "items.qty=eq.1", // not embedded
    ] {
        let (status, body) = app.get(&format!("/rest/v1/orders?{bad}"), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
    }
}

#[tokio::test]
async fn nested_embeds_follow_each_tables_rls() {
    let app = TestApp::spawn().await;
    let a = user_token(app.user_a);
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.comments (
                 id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                 todo_id bigint NOT NULL REFERENCES public.todos (id),
                 user_id uuid NOT NULL,
                 body text NOT NULL);
             CREATE TABLE public.reactions (
                 id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                 comment_id bigint NOT NULL REFERENCES public.comments (id),
                 user_id uuid NOT NULL,
                 emoji text NOT NULL);
             ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
             ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;
             CREATE POLICY comments_read ON public.comments
                 FOR SELECT TO authenticated USING (true);
             CREATE POLICY reactions_owner ON public.reactions
                 FOR SELECT TO authenticated USING (user_id = auth.uid());
             GRANT SELECT ON public.comments, public.reactions TO authenticated;",
        )
        .await
        .unwrap();
    app.admin_client
        .execute(
            "WITH c AS (
                 INSERT INTO public.comments (todo_id, user_id, body)
                 SELECT id, $1, 'nice' FROM public.todos WHERE title = 'task of A'
                 RETURNING id)
             INSERT INTO public.reactions (comment_id, user_id, emoji)
             SELECT c.id, r.user_id, r.emoji
               FROM c, (VALUES ($1::uuid, 'up'), ($2::uuid, 'down')) AS r(user_id, emoji)",
            &[&app.user_a, &app.user_b],
        )
        .await
        .unwrap();
    wait_for_table(&app, "reactions", Some(&a)).await;

    // Two levels down, the reactions table's policy still hides B's reaction.
    let (status, body) = app
        .get(
            "/rest/v1/todos?select=title,comments(body,reactions(emoji))",
            Some(&a),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!([{ "title": "task of A", "comments": [{ "body": "nice", "reactions": [{ "emoji": "up" }] }] }])
    );
}

/// Embedded rows go through the related table's own policies, in both
/// directions: an embed never shows what a direct read would hide.
#[tokio::test]
async fn embedded_rows_follow_the_related_tables_rls() {
    let app = TestApp::spawn().await;
    let a = user_token(app.user_a);
    let b = user_token(app.user_b);
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.comments (
                 id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                 todo_id bigint NOT NULL REFERENCES public.todos (id),
                 user_id uuid NOT NULL,
                 body text NOT NULL);
             ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
             CREATE POLICY comments_owner ON public.comments
                 FOR SELECT TO authenticated USING (user_id = auth.uid());
             GRANT SELECT ON public.comments TO authenticated;",
        )
        .await
        .unwrap();
    app.admin_client
        .execute(
            "INSERT INTO public.comments (todo_id, user_id, body)
             SELECT t.id, c.user_id, c.body
               FROM (VALUES ($1::uuid, 'task of A', 'mine'),
                            ($2::uuid, 'task of A', 'from B'),
                            ($2::uuid, 'task of B', 'B on B')) AS c(user_id, title, body)
               JOIN public.todos t ON t.title = c.title",
            &[&app.user_a, &app.user_b],
        )
        .await
        .unwrap();
    wait_for_table(&app, "comments", Some(&a)).await;

    // A sees their todo, but only their own comment on it.
    let (_, body) = app
        .get("/rest/v1/todos?select=title,comments(body)", Some(&a))
        .await;
    assert_eq!(
        body,
        json!([{ "title": "task of A", "comments": [{ "body": "mine" }] }])
    );

    // B sees both of their comments, but not A's todo behind one of them.
    let (_, body) = app
        .get(
            "/rest/v1/comments?select=body,todos(title)&order=id",
            Some(&b),
        )
        .await;
    assert_eq!(
        body,
        json!([
            { "body": "from B", "todos": null },
            { "body": "B on B", "todos": { "title": "task of B" } },
        ])
    );
}

#[tokio::test]
async fn patch_and_delete_refuse_order_limit_and_offset() {
    let app = TestApp::spawn().await;
    let s = service_token();
    for query in ["order=id", "limit=1", "offset=1"] {
        let path = format!("/rest/v1/products?stock=gt.0&{query}");
        let reply = app
            .request(Method::PATCH, &path, Some(&s), Some(json!({ "stock": 1 })))
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(reply.body["code"], "invalid_query", "{query}");
        let reply = app.request(Method::DELETE, &path, Some(&s), None).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{query}");
    }
    // Nothing was changed.
    let (_, body) = app.get("/rest/v1/products?stock=eq.1", None).await;
    assert_eq!(body, json!([]));
}

#[tokio::test]
async fn patch_and_delete_report_the_rows_changed_with_count_exact() {
    let app = TestApp::spawn().await;
    let s = service_token();
    let count = ("prefer", "count=exact");
    let reply = app
        .request_with(
            Method::PATCH,
            "/rest/v1/products?stock=gt.0",
            Some(&s),
            Some(json!({ "stock": 7 })),
            &[count],
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(reply.headers[header::CONTENT_RANGE], "*/3");
    assert_eq!(reply.headers["preference-applied"], "count=exact");

    let reply = app
        .request_with(
            Method::DELETE,
            "/rest/v1/products?stock=eq.7",
            Some(&s),
            None,
            &[("prefer", "count=exact, return=representation")],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body.as_array().unwrap().len(), 3);
    assert_eq!(reply.headers[header::CONTENT_RANGE], "*/3");

    // Matching nothing is a count too; without the preference, no header.
    let reply = app
        .request_with(
            Method::DELETE,
            "/rest/v1/products?id=eq.999",
            Some(&s),
            None,
            &[count],
        )
        .await;
    assert_eq!(reply.headers[header::CONTENT_RANGE], "*/0");
    let reply = app
        .request(
            Method::DELETE,
            "/rest/v1/products?id=eq.999",
            Some(&s),
            None,
        )
        .await;
    assert!(!reply.headers.contains_key(header::CONTENT_RANGE));
}

#[tokio::test]
async fn cors_exposes_what_a_browser_client_reads() {
    let app = TestApp::spawn().await;
    let reply = app
        .request_with(
            Method::GET,
            "/rest/v1/products?select=id",
            None,
            None,
            &[
                ("origin", "https://app.example.com"),
                ("prefer", "count=exact"),
            ],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let exposed = reply.headers["access-control-expose-headers"]
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    for name in [
        "content-range",
        "etag",
        "last-modified",
        "retry-after",
        "preference-applied",
        "x-request-id",
    ] {
        assert!(exposed.contains(name), "{name} not exposed: {exposed}");
    }
}

#[tokio::test]
async fn cors_preflight_is_cached_for_two_hours() {
    let app = TestApp::spawn().await;
    let reply = app
        .request_with(
            Method::OPTIONS,
            "/rest/v1/products",
            None,
            None,
            &[
                ("origin", "https://app.example.com"),
                ("access-control-request-method", "PATCH"),
                ("access-control-request-headers", "authorization, prefer"),
            ],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.headers["access-control-max-age"], "7200");
}

#[tokio::test]
async fn every_response_carries_a_request_id() {
    let app = TestApp::spawn().await;
    // A new id per request when the caller sends none...
    let first = app
        .request(Method::GET, "/rest/v1/products?select=id", None, None)
        .await;
    let second = app.request(Method::GET, "/nope", None, None).await;
    let id = |reply: &Reply| reply.headers["x-request-id"].to_str().unwrap().to_owned();
    assert_eq!(id(&first).len(), 36, "a UUID");
    assert_ne!(id(&first), id(&second));
    // ...and the caller's own (a proxy in front) is kept.
    let reply = app
        .request_with(
            Method::GET,
            "/rest/v1/products?select=id",
            None,
            None,
            &[("x-request-id", "from-the-proxy")],
        )
        .await;
    assert_eq!(id(&reply), "from-the-proxy");
}

#[tokio::test]
async fn insert_and_upsert_report_only_affected_rows_with_count_exact() {
    let app = TestApp::spawn().await;
    let service = service_token();
    for (preference, expected) in [
        ("count=exact,resolution=merge-duplicates", "*/1"),
        ("count=exact,resolution=ignore-duplicates", "*/0"),
        (
            "count=exact,resolution=merge-duplicates,return=representation",
            "*/1",
        ),
    ] {
        let reply = app
            .request_with(
                Method::POST,
                "/rest/v1/products",
                Some(&service),
                Some(json!({"id": 500, "name": "Counted", "price": 1, "stock": 2})),
                &[("prefer", preference)],
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        assert_eq!(reply.headers[header::CONTENT_RANGE], expected);
        assert!(
            reply
                .headers
                .get_all("preference-applied")
                .iter()
                .any(|value| value == "count=exact")
        );
    }
    let a = user_token(app.user_a);
    let hidden = app
        .request_with(
            Method::PATCH,
            "/rest/v1/todos?title=eq.task%20of%20B",
            Some(&a),
            Some(json!({"done": true})),
            &[("prefer", "count=exact")],
        )
        .await;
    assert_eq!(hidden.status, StatusCode::NO_CONTENT);
    assert_eq!(hidden.headers[header::CONTENT_RANGE], "*/0");
}

#[tokio::test]
async fn exact_count_ignores_paging_but_respects_filters_and_row_policies() {
    let app = TestApp::spawn().await;
    let token = user_token(app.user_a);
    for (query, expected) in [
        ("id=gte.0&limit=0", "*/1"),
        ("id=gte.0&offset=100", "*/1"),
        ("id=lt.0&limit=1", "*/0"),
    ] {
        let reply = app
            .request_with(
                Method::GET,
                &format!("/rest/v1/todos?{query}"),
                Some(&token),
                None,
                &[("prefer", "count=exact")],
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        assert_eq!(reply.body, json!([]));
        assert_eq!(reply.headers[header::CONTENT_RANGE], expected);
    }
}
