//! Password login admission under targeted abuse: account-wide budgets that
//! keep the owner's known sources usable, and per-source hard ceilings.
mod common;
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use common::*;
use http_body_util::BodyExt;
use serde_json::json;
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

async fn login_from(app: &TestApp, email: &str, password: &str, source: &str) -> Reply {
    let response = app
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/auth/v1/token?grant_type=password")
                .header(header::CONTENT_TYPE, "application/json")
                .extension(ConnectInfo(
                    format!("{source}:1234")
                        .parse::<std::net::SocketAddr>()
                        .unwrap(),
                ))
                .body(Body::from(
                    json!({"email": email, "password": password}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        headers,
        body: serde_json::from_slice(&bytes).unwrap(),
        text: String::new(),
    }
}

async fn signup(app: &TestApp, email: &str, password: &str) {
    assert_eq!(
        app.post(
            "/auth/v1/signup",
            None,
            json!({"email": email, "password": password})
        )
        .await
        .status,
        StatusCode::CREATED
    );
}

/// An address in an IPv4 /24 that no earlier attempt in this test used.
fn fresh_network(next: &mut u32) -> String {
    *next += 1;
    format!("10.{}.{}.1", *next / 250, *next % 250)
}

/// Wrong passwords from fresh networks until the account budget is spent,
/// however much it refilled meanwhile; returns the refusal.
async fn spend_account_budget(app: &TestApp, email: &str, next: &mut u32) -> Reply {
    let wrong = Uuid::new_v4().to_string();
    for _ in 0..200 {
        let source = fresh_network(next);
        let reply = login_from(app, email, &wrong, &source).await;
        if reply.status == StatusCode::TOO_MANY_REQUESTS {
            return reply;
        }
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }
    panic!("the account budget was never spent");
}

#[tokio::test]
async fn account_budget_refuses_fresh_networks_but_admits_a_known_one() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 2,
        mail: false,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let password = Uuid::new_v4().to_string();
    signup(&app, &email, &password).await;
    // The owner signs in once from their usual network: a session on record.
    let home = "192.0.2.9";
    assert_eq!(
        login_from(&app, &email, &password, home).await.status,
        StatusCode::OK
    );
    // A session that the owner then signs out of.
    let session = login_from(&app, &email, &password, "198.51.100.9").await;
    assert_eq!(session.status, StatusCode::OK);
    let token = session.body["access_token"].as_str().unwrap().to_owned();
    assert_eq!(
        app.post("/auth/v1/logout", Some(&token), json!({}))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    // The account budget is ten times the per-IP one (20 a minute here), so
    // it takes many addresses to spend. It refills while the test runs, so it
    // is spent again right before each check.
    let mut next = 0;
    let blocked = spend_account_budget(&app, &email, &mut next).await;
    assert!(blocked.headers.contains_key(header::RETRY_AFTER));
    // A fresh network is refused even with the right password. Only a refill
    // between the two requests can let it in; then spend the budget again.
    let mut refused = false;
    for _ in 0..5 {
        let source = fresh_network(&mut next);
        let reply = login_from(&app, &email, &password, &source).await;
        if reply.status == StatusCode::TOO_MANY_REQUESTS {
            refused = true;
            break;
        }
        assert_eq!(reply.status, StatusCode::OK);
        spend_account_budget(&app, &email, &mut next).await;
    }
    assert!(refused, "fresh networks are refused over budget");
    spend_account_budget(&app, &email, &mut next).await;
    // This is a bound on the deliberately introduced throttle delay plus local
    // test work, not a production latency SLO or a hash-admission change.
    let reply = tokio::time::timeout(
        Duration::from_secs(10),
        login_from(&app, &email, &password, home),
    )
    .await
    .unwrap();
    assert_eq!(reply.status, StatusCode::OK, "the owner keeps access");
    spend_account_budget(&app, &email, &mut next).await;
    assert_eq!(
        login_from(&app, &email, &password, "192.0.2.77")
            .await
            .status,
        StatusCode::OK,
        "a rotated address in the same IPv4 /24 is known"
    );
    // A network stops being known once its session is revoked (sign-out,
    // password change), so a stolen session's network cannot keep skipping
    // the budget. A wrong password probes it without opening a session; a
    // refill between the spend and the probe only yields a 400 and a retry.
    // Each probe comes from another address in the cafe's /24, so the per-IP
    // budget is never what refuses it.
    let wrong = Uuid::new_v4().to_string();
    let mut refused = false;
    for host in 10..15 {
        spend_account_budget(&app, &email, &mut next).await;
        let source = format!("198.51.100.{host}");
        let reply = login_from(&app, &email, &wrong, &source).await;
        if reply.status == StatusCode::TOO_MANY_REQUESTS {
            refused = true;
            break;
        }
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }
    assert!(refused, "a signed-out network is no longer known");
    assert_eq!(
        app.post("/auth/v1/recover", None, json!({"email": email}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn many_addresses_inside_a_known_network_still_hit_a_ceiling() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 1,
        mail: false,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let password = Uuid::new_v4().to_string();
    signup(&app, &email, &password).await;
    assert_eq!(
        login_from(&app, &email, &password, "192.0.2.9")
            .await
            .status,
        StatusCode::OK
    );
    // Every address below is in the known 192.0.2.0/24 with a fresh per-IP
    // budget. Without a ceiling for known networks they would never be
    // refused; with it, both account budgets (10 + 10 a minute) run out.
    let wrong = Uuid::new_v4().to_string();
    for host in 20..250 {
        let source = format!("192.0.2.{host}");
        let reply = login_from(&app, &email, &wrong, &source).await;
        if reply.status == StatusCode::TOO_MANY_REQUESTS {
            assert!(reply.headers.contains_key(header::RETRY_AFTER));
            return;
        }
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }
    panic!("attempts from a known network were never refused");
}

#[tokio::test]
async fn one_address_cannot_use_up_the_account_budget() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 2,
        mail: false,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let password = Uuid::new_v4().to_string();
    signup(&app, &email, &password).await;
    let wrong = Uuid::new_v4().to_string();
    for _ in 0..2 {
        assert_eq!(
            login_from(&app, &email, &wrong, "192.0.2.50").await.status,
            StatusCode::BAD_REQUEST
        );
    }
    let blocked = login_from(&app, &email, &wrong, "192.0.2.50").await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        login_from(&app, &email, &password, "192.0.2.51")
            .await
            .status,
        StatusCode::OK,
        "the owner signs in from a new network while one address attacks"
    );
}

#[tokio::test]
async fn one_source_keeps_its_existing_hard_ceiling() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 2,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let wrong = Uuid::new_v4().to_string();
    for _ in 0..2 {
        assert_eq!(
            login_from(&app, &email, &wrong, "192.0.2.4").await.status,
            StatusCode::BAD_REQUEST
        );
    }
    let blocked = login_from(&app, &email, &wrong, "192.0.2.4").await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers.contains_key(header::RETRY_AFTER));
    assert_eq!(
        login_from(&app, &email, &wrong, "192.0.2.5").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn ipv6_addresses_in_one_64_share_a_budget() {
    let app = TestApp::spawn_with(Options {
        rate_limit_per_minute: 2,
        ..Options::default()
    })
    .await;
    let email = format!("{}@example.test", Uuid::new_v4().simple());
    let wrong = Uuid::new_v4().to_string();
    for source in ["[2001:db8:0:1::1]", "[2001:db8:0:1::2]"] {
        assert_eq!(
            login_from(&app, &email, &wrong, source).await.status,
            StatusCode::BAD_REQUEST
        );
    }
    let blocked = login_from(&app, &email, &wrong, "[2001:db8:0:1:ffff::3]").await;
    assert_eq!(
        blocked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "a new address in the same /64 has no fresh budget"
    );
    assert_eq!(
        login_from(&app, &email, &wrong, "[2001:db8:0:2::1]")
            .await
            .status,
        StatusCode::BAD_REQUEST,
        "another /64 keeps its own budget"
    );
}
