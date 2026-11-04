//! Real-router/database coverage for configurable auth mail and safe panel tests.
mod common;
use axum::http::{Method, StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{
    panel::{self, JSON},
    *,
};
use nelcota_auth::{Email, MailError, Mailer};
use nelcota_core::{Config, email::encode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn draft() -> Value {
    json!({"project": "shop", "kind": "recovery", "language": "pt-BR", "subject": "{{project_name}} · {{validity}}", "text": "Olá {{email}}!\n{{link}}\n{{validity}}", "ttl_minutes": 10})
}

#[tokio::test]
async fn previews_require_panel_auth_and_same_origin_but_no_smtp_or_host_grant() {
    let app = TestApp::spawn_with(Options {
        mail: false,
        ..Default::default()
    })
    .await;
    let body = draft().to_string();
    let bearer = format!("Bearer {}", service_token());
    for headers in [vec![JSON], vec![JSON, ("authorization", bearer.as_str())]] {
        assert_eq!(
            app.raw(
                Method::POST,
                "/admin/api/email/preview",
                &headers,
                body.clone()
            )
            .await
            .status,
            StatusCode::UNAUTHORIZED
        );
    }
    let cookie = panel::login(&app).await;
    let bad_origin = app
        .raw(
            Method::POST,
            "/admin/api/email/preview",
            &[
                JSON,
                ("cookie", &cookie),
                ("host", "localhost"),
                ("origin", "https://attacker.example"),
            ],
            body,
        )
        .await;
    assert_eq!(bad_origin.status, StatusCode::FORBIDDEN);
    let preview = panel::send(
        &app,
        Method::POST,
        "/admin/api/email/preview",
        &cookie,
        draft(),
    )
    .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.text);
    assert_eq!(preview.body["subject"], "Projeto exemplo · 10 minutos");
    assert!(
        preview.body["text"]
            .as_str()
            .unwrap()
            .contains("person@example.invalid")
    );
    assert!(
        preview.body["text"]
            .as_str()
            .unwrap()
            .contains("preview-not-an-authentication-token")
    );
    let failed = panel::send(
        &app,
        Method::POST,
        "/admin/api/email/test",
        &cookie,
        draft(),
    )
    .await;
    assert_eq!(failed.body["code"], "email_not_configured");
    assert!(app.outbox.sent().is_empty());
}

#[tokio::test]
async fn tests_have_a_fixed_recipient_no_tokens_and_a_shared_one_minute_budget() {
    let app = TestApp::spawn().await;
    let cookie = panel::login(&app).await;
    let mut wrong = draft();
    wrong["project"] = json!("blog");
    assert_eq!(
        panel::send(&app, Method::POST, "/admin/api/email/test", &cookie, wrong)
            .await
            .body["code"],
        "email_project_mismatch"
    );
    let mut injected = draft();
    injected["subject"] = json!("x\r\nBcc: victim@example.test");
    assert_eq!(
        panel::send(
            &app,
            Method::POST,
            "/admin/api/email/test",
            &cookie,
            injected
        )
        .await
        .body["code"],
        "email_content_invalid"
    );
    let mut recipient = draft();
    recipient["to"] = json!("victim@example.test");
    assert_eq!(
        panel::send(
            &app,
            Method::POST,
            "/admin/api/email/test",
            &cookie,
            recipient
        )
        .await
        .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert!(app.outbox.sent().is_empty());
    let reply = panel::send(
        &app,
        Method::POST,
        "/admin/api/email/test",
        &cookie,
        draft(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(reply.body["accepted"], true);
    let sent = app.outbox.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, ADMIN_EMAIL);
    assert!(sent[0].subject.starts_with("[TEST] "));
    assert!(sent[0].text.contains("example.invalid/preview"));
    let tokens: i64 = app
        .admin_client
        .query_one("SELECT count(*) FROM auth.one_time_tokens", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(tokens, 0);
    let repeated = panel::send(
        &app,
        Method::POST,
        "/admin/api/email/test",
        &cookie,
        draft(),
    )
    .await;
    assert_eq!(repeated.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(repeated.headers.contains_key("retry-after"));
    assert_eq!(app.outbox.sent().len(), 1);
}

struct FailingMailer;
impl Mailer for FailingMailer {
    fn send(
        &self,
        _: Email,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), MailError>> + Send + '_>>
    {
        Box::pin(async {
            Err(MailError(
                "private-smtp-password and provider diagnostic".into(),
            ))
        })
    }
}

#[tokio::test]
async fn smtp_failure_is_not_reported_as_success_or_exposed_to_the_browser() {
    let app = TestApp::spawn_with(Options {
        mailer: Some(Arc::new(FailingMailer)),
        ..Default::default()
    })
    .await;
    let cookie = panel::login(&app).await;
    let reply = panel::send(
        &app,
        Method::POST,
        "/admin/api/email/test",
        &cookie,
        draft(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.body["code"], "email_test_failed");
    assert!(!reply.text.contains("private"));
    assert!(!reply.text.contains("provider diagnostic"));
}

async fn assert_lifetime(app: &TestApp, kind: &str, seconds: i64) {
    let actual: i64 = app.admin_client.query_one("SELECT EXTRACT(EPOCH FROM expires_at - created_at)::bigint FROM auth.one_time_tokens WHERE kind = $1", &[&kind]).await.unwrap().get(0);
    assert_eq!(actual, seconds, "{kind}");
}

#[tokio::test]
async fn configured_content_and_actual_database_expiry_cover_all_three_single_use_flows() {
    let config = Config {
        project_name: Some("Loja".into()),
        email_language: "pt-BR".into(),
        email_signup_subject_base64: Some(encode("{{project_name}} · confirme")),
        email_signup_text_base64: Some(encode(
            "Olá {{email}}!\nD'água $HOME \\ #\n{{link}}\n{{validity}}",
        )),
        email_recovery_ttl_minutes: 10,
        email_signup_ttl_minutes: 20,
        email_magiclink_ttl_minutes: 5,
        ..Default::default()
    };
    let app = TestApp::spawn_with(Options {
        email_config: config,
        confirm_email: true,
        ..Default::default()
    })
    .await;
    let verifier = "email-configuration-0123456789-abcdefghijklmnopqrstuvwxyz";
    let signup = app.post("/auth/v1/signup", None, json!({"email": "ana@example.test", "password": "old-password-123", "code_challenge": URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())), "code_challenge_method": "S256"})).await;
    assert_eq!(signup.status, StatusCode::CREATED, "{}", signup.text);
    let sent = app.outbox.wait_for(1).await;
    assert_eq!(sent[0].subject, "Loja · confirme");
    assert!(sent[0].text.contains("D'água $HOME \\ #\n"));
    assert!(sent[0].text.contains("20 minutos"));
    assert_lifetime(&app, "signup", 1200).await;
    let token = link_token(&sent[0], CONFIRMATION_URL, "signup");
    let verify_signup = json!({"type": "signup", "token": token, "code_verifier": verifier});
    assert_eq!(
        app.post("/auth/v1/verify", None, verify_signup.clone())
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.post("/auth/v1/verify", None, verify_signup).await.body["code"],
        "invalid_grant"
    );

    assert_eq!(
        app.post(
            "/auth/v1/magiclink",
            None,
            json!({"email": "ana@example.test"})
        )
        .await
        .status,
        StatusCode::OK
    );
    let sent = app.outbox.wait_for(2).await;
    assert!(sent[1].text.contains("5 minutos"));
    assert_lifetime(&app, "magiclink", 300).await;
    let token = link_token(&sent[1], MAGIC_LINK_URL, "magiclink");
    let verify_magic = json!({"type": "magiclink", "token": token});
    assert_eq!(
        app.post("/auth/v1/verify", None, verify_magic.clone())
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.post("/auth/v1/verify", None, verify_magic).await.body["code"],
        "invalid_grant"
    );

    assert_eq!(
        app.post(
            "/auth/v1/recover",
            None,
            json!({"email": "ana@example.test"})
        )
        .await
        .status,
        StatusCode::OK
    );
    let sent = app.outbox.wait_for(3).await;
    assert!(sent[2].text.contains("10 minutos"));
    assert_lifetime(&app, "recovery", 600).await;
    let token = link_token(&sent[2], RECOVERY_URL, "recovery");
    let verify_recovery =
        json!({"type": "recovery", "token": token, "password": "new-password-456"});
    assert_eq!(
        app.post("/auth/v1/verify", None, verify_recovery.clone())
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.post("/auth/v1/verify", None, verify_recovery)
            .await
            .body["code"],
        "invalid_grant"
    );
}
