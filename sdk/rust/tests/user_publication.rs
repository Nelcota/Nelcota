use axum::{
    Json, Router,
    extract::State,
    routing::{get, post, put},
};
use nelcota_client::{
    Client,
    auth::{Session, User, UserUpdate},
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Default)]
struct Gate {
    entered: Notify,
    release: Notify,
}

fn session(refresh: &str, label: &str) -> Session {
    serde_json::from_value(json!({
        "access_token":"same-access", "refresh_token":refresh, "token_type":"bearer",
        "expires_at":4_000_000_000_u64, "expires_in":900,
        "user":{"id":"fixture-user", "email":"user@example.test", "email_confirmed_at":null,
            "created_at":"2026-10-19", "last_sign_in_at":null, "user_metadata":{"label":label}}
    }))
    .unwrap()
}

async fn delayed_read(change: &str) {
    let gate = Arc::new(Gate::default());
    let reply: User = session(
        "r0",
        match change {
            "replace" => "intermediate",
            _ => "old",
        },
    )
    .user;
    let router = Router::new()
        .route(
            "/auth/v1/user",
            get(move |State(gate): State<Arc<Gate>>| {
                let reply = reply.clone();
                async move {
                    gate.entered.notify_one();
                    gate.release.notified().await;
                    Json(reply)
                }
            })
            .merge(put(|| async { Json(session("r0", "new").user) })),
        )
        .route(
            "/auth/v1/token",
            post(|| async { Json(session("r1", "new")) }),
        )
        .with_state(gate.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::builder(format!("http://{}", listener.local_addr().unwrap()))
        .build()
        .unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    client
        .auth()
        .set_session(session("r0", "old"))
        .await
        .unwrap();
    let reading = {
        let auth = client.auth();
        tokio::spawn(async move { auth.get_user().await })
    };
    gate.entered.notified().await;
    match change {
        "refresh" => {
            client.auth().refresh_session().await.unwrap();
        }
        "update" => {
            client
                .auth()
                .update_user(UserUpdate {
                    data: Some(json!({"label":"new"})),
                    ..Default::default()
                })
                .await
                .unwrap();
        }
        _ => {
            client
                .auth()
                .set_session(session("r0", "new"))
                .await
                .unwrap();
            client
                .auth()
                .set_session(session("r0", "old"))
                .await
                .unwrap();
        }
    }
    gate.release.notify_one();
    reading.await.unwrap().unwrap();
    let current = client.auth().get_session().await.unwrap().unwrap();
    server.abort();
    let expected = match change {
        "replace" => "old",
        _ => "new",
    };
    assert_eq!(current.user.user_metadata["label"], expected);
    if change == "refresh" {
        assert_eq!(current.refresh_token, "r1");
    }
}

#[tokio::test]
async fn late_user_read_preserves_a_newer_profile_update() {
    delayed_read("update").await;
}

#[tokio::test]
async fn late_user_read_preserves_refresh_with_the_same_access_token() {
    delayed_read("refresh").await;
}

#[tokio::test]
async fn late_user_read_preserves_an_identical_session_replacement() {
    delayed_read("replace").await;
}
