//! Integration tests of the JWT → role → RLS flow, against a real Postgres 17
//! (testcontainers). No database mocks: RLS is what is under test.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use jsonwebtoken::get_current_timestamp;
use nelcota_core::{Claims, db};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

fn titles(body: &Value) -> Vec<&str> {
    body.as_array()
        .expect("the response should be an array")
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn user_only_reads_their_own_data() {
    let app = TestApp::spawn().await;

    let (status, body) = app
        .get("/rest/v1/todos", Some(&user_token(app.user_a)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(titles(&body), ["task of A"]);

    let (status, body) = app
        .get("/rest/v1/todos", Some(&user_token(app.user_b)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(titles(&body), ["task of B"]);

    // A user without rows gets an empty list, not an error.
    let (status, body) = app
        .get("/rest/v1/todos", Some(&user_token(Uuid::new_v4())))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([]));
}

#[tokio::test]
async fn anon_cannot_access_a_protected_table() {
    let app = TestApp::spawn().await;
    let (status, body) = app.get("/rest/v1/todos", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "db_error");

    // Even with an explicit anon token.
    let (status, _) = app
        .get("/rest/v1/todos", Some(&token(json!({ "role": "anon" }))))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn service_role_bypasses_rls() {
    let app = TestApp::spawn().await;
    let (status, body) = app
        .get(
            "/rest/v1/todos?order=id",
            Some(&token(json!({ "role": "service_role" }))),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(titles(&body), ["task of A", "task of B"]);
}

#[tokio::test]
async fn invalid_role_in_jwt_is_rejected() {
    let app = TestApp::spawn().await;
    let sub = app.user_a;
    for claims in [
        json!({ "role": "postgres", "sub": sub }),
        json!({ "role": "authenticator", "sub": sub }),
        json!({ "role": "pg_read_all_data", "sub": sub }),
        json!({ "sub": sub }),
        // authenticated requires a uuid `sub`.
        json!({ "role": "authenticated" }),
        json!({ "role": "authenticated", "sub": "not-a-uuid" }),
    ] {
        let (status, body) = app
            .get("/rest/v1/todos", Some(&token(claims.clone())))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "claims {claims}");
        assert_eq!(body["code"], "invalid_token");
    }
}

#[tokio::test]
async fn expired_or_badly_signed_jwt_returns_401() {
    let app = TestApp::spawn().await;
    let sub = app.user_a;

    let expired = token(json!({
        "role": "authenticated",
        "sub": sub,
        "exp": get_current_timestamp() - 3600,
    }));
    let wrong_signature = token_with_secret(
        json!({ "role": "authenticated", "sub": sub }),
        "some-other-secret-with-32-characters!!",
    );
    // Tampered payload: swaps the `sub` while keeping the original signature.
    let tampered = {
        let original = user_token(app.user_b);
        let parts: Vec<&str> = original.split('.').collect();
        let forged = user_token(app.user_a);
        let payload_a = forged.split('.').nth(1).unwrap();
        format!("{}.{}.{}", parts[0], payload_a, parts[2])
    };
    // `alg: none` (header {"alg":"none","typ":"JWT"}).
    let alg_none = format!(
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.{}.",
        user_token(sub).split('.').nth(1).unwrap()
    );

    for (case, token) in [
        ("expired", expired.as_str()),
        ("wrong signature", &wrong_signature),
        ("tampered payload", &tampered),
        ("alg none", &alg_none),
        ("garbage", "this.is.not-a-jwt"),
    ] {
        let (status, body) = app.get("/rest/v1/todos", Some(token)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{case}");
        assert_eq!(body["code"], "invalid_token", "{case}");
    }

    // A scheme other than Bearer is rejected too (it does not become anon).
    let response = app
        .router
        .clone()
        .oneshot(
            Request::get("/rest/v1/todos")
                .header(header::AUTHORIZATION, "Basic dXNlcjpwYXNzd29yZA==")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().contains_key(header::WWW_AUTHENTICATE));
}

/// With a single pooled connection, one request's role/claims cannot leak into
/// the next.
#[tokio::test]
async fn role_and_claims_do_not_leak_between_pooled_requests() {
    let app = TestApp::spawn_with(Options {
        pool_size: 1,
        ..Options::default()
    })
    .await;
    let service = token(json!({ "role": "service_role" }));

    let (status, body) = app.get("/rest/v1/todos", Some(&service)).await;
    assert_eq!((status, titles(&body).len()), (StatusCode::OK, 2));

    let (status, _) = app.get("/rest/v1/todos", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = app
        .get("/rest/v1/todos", Some(&user_token(app.user_a)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(titles(&body), ["task of A"]);

    let (status, body) = app
        .get("/rest/v1/todos", Some(&user_token(app.user_b)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(titles(&body), ["task of B"]);

    // Outside a request transaction, the connection is plain `authenticator` again.
    let client = app.pool.get().await.unwrap();
    let row = client
        .query_one(
            "SELECT current_user::text, coalesce(current_setting('request.jwt.claims', true), '')",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "authenticator");
    assert_eq!(row.get::<_, String>(1), "");
}

/// An aborted transaction (error mid-request) leaves nothing behind either.
#[tokio::test]
async fn failed_transaction_rolls_back_the_role() {
    let app = TestApp::spawn_with(Options {
        pool_size: 1,
        ..Options::default()
    })
    .await;
    let claims = Claims::from_payload(json!({ "role": "service_role" })).unwrap();
    {
        let mut client = app.pool.get().await.unwrap();
        let tx = db::begin_request(&mut client, &claims).await.unwrap();
        assert!(tx.execute("SELECT 1/0", &[]).await.is_err());
        // dropped without commit
    }
    let client = app.pool.get().await.unwrap();
    let user: String = client
        .query_one("SELECT current_user::text", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(user, "authenticator");
}

/// Policies also apply to writes: A cannot insert a row on behalf of B, and
/// `auth.uid()`/`auth.role()` reflect the JWT inside the transaction.
#[tokio::test]
async fn rls_blocks_writes_on_behalf_of_another_user() {
    let app = TestApp::spawn().await;
    let claims =
        Claims::from_payload(json!({ "role": "authenticated", "sub": app.user_a })).unwrap();

    let mut client = app.pool.get().await.unwrap();
    let tx = db::begin_request(&mut client, &claims).await.unwrap();
    let row = tx
        .query_one("SELECT auth.uid(), auth.role(), current_user::text", &[])
        .await
        .unwrap();
    assert_eq!(row.get::<_, Uuid>(0), app.user_a);
    assert_eq!(row.get::<_, String>(1), "authenticated");
    assert_eq!(row.get::<_, String>(2), "authenticated");

    let err = tx
        .execute(
            "INSERT INTO public.todos (user_id, title) VALUES ($1, 'intrusion')",
            &[&app.user_b],
        )
        .await
        .unwrap_err();
    assert_eq!(
        err.code(),
        Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
}

#[tokio::test]
async fn health_answers_ok() {
    let app = TestApp::spawn().await;
    let (status, body) = app.get("/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn bootstrap_is_idempotent() {
    let app = TestApp::spawn().await;
    let client = app.pool.get().await.unwrap();
    // `authenticator` cannot read the migrations control table.
    assert!(
        client
            .query("SELECT * FROM nelcota.schema_migrations", &[])
            .await
            .is_err()
    );
    drop(client);

    db::bootstrap(&app.admin, authenticator_password(), 10)
        .await
        .unwrap();
    db::bootstrap(&app.admin, authenticator_password(), 10)
        .await
        .unwrap();

    let (status, _) = app.get("/health", None).await;
    assert_eq!(status, StatusCode::OK);

    // New authenticator connections inherit the statement_timeout.
    let (client, connection) = db::authenticator_config(&app.admin, authenticator_password())
        .connect(tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let timeout: String = client
        .query_one("SHOW statement_timeout", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(timeout, "10s");
}
