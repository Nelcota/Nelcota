//! Preview is pure; a test uses only this project's existing SMTP and admin inbox.
use crate::{
    AdminState,
    auth::require_session,
    contracts::{EmailCapabilities, EmailPreview, EmailPreviewRequest, EmailTest},
    middleware::{same_origin, security_headers},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    middleware,
    routing::{get, post},
};
use nelcota_auth::{AuthState, Email};
use nelcota_core::{
    ApiError,
    email::{Kind, Language, Settings},
};

/// Separate assembly keeps the published AdminState constructor unchanged.
pub fn router(admin: AdminState, auth: AuthState) -> Router {
    Router::new()
        .route("/admin/api/email", get(capabilities))
        .route("/admin/api/email/preview", post(preview))
        .route("/admin/api/email/test", post(send_test))
        .route_layer(middleware::from_fn_with_state(
            admin.clone(),
            require_session,
        ))
        .layer(DefaultBodyLimit::max(8192))
        .layer(middleware::from_fn(same_origin))
        .layer(middleware::from_fn(security_headers))
        .with_state((admin, auth))
}

async fn capabilities(
    State((admin, auth)): State<(AdminState, AuthState)>,
) -> Json<EmailCapabilities> {
    Json(EmailCapabilities {
        project: admin.host.project.clone(),
        configured: auth.mailer.is_some(),
        test_recipient: admin.credentials.email.clone(),
    })
}

fn invalid() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_REQUEST,
        "email_content_invalid",
        "invalid email template, language or link lifetime",
    )
}

fn render(request: &EmailPreviewRequest) -> Result<EmailPreview, ApiError> {
    if request.project.is_empty()
        || request.project.len() > 63
        || !request
            .project
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(invalid());
    }
    let kind = Kind::parse(&request.kind).ok_or_else(invalid)?;
    let mut settings = Settings {
        language: Language::parse(&request.language).map_err(|_| invalid())?,
        project_name: "Example project".into(),
        ..Default::default()
    };
    if settings.language == Language::Portuguese {
        settings.project_name = "Projeto exemplo".into();
    }
    let template = settings.template_mut(kind);
    template.subject = request.subject.clone();
    template.text = request.text.clone();
    template.ttl_minutes = request.ttl_minutes;
    // Reserved, non-routable example domain. This value is never issued/stored.
    let link = format!(
        "https://example.invalid/preview#type={}&token=preview-not-an-authentication-token",
        kind.as_str()
    );
    let email = settings
        .render(kind, "person@example.invalid", &link)
        .map_err(|_| invalid())?;
    Ok(EmailPreview {
        subject: email.subject,
        text: email.text,
        ttl_minutes: request.ttl_minutes,
    })
}

async fn preview(Json(request): Json<EmailPreviewRequest>) -> Result<Json<EmailPreview>, ApiError> {
    Ok(Json(render(&request)?))
}

async fn send_test(
    State((admin, auth)): State<(AdminState, AuthState)>,
    Json(request): Json<EmailPreviewRequest>,
) -> Result<Json<EmailTest>, ApiError> {
    if request.project != admin.host.project {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "email_project_mismatch",
            "open the selected project's own panel to send its test email",
        ));
    }
    let email = render(&request)?;
    let mailer = auth.mailer.clone().ok_or_else(|| {
        ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "email_not_configured",
            "configure this project's SMTP before sending a test",
        )
    })?;
    auth.mail_delivery.send_test(mailer, Email {
        to: admin.credentials.email.clone(),
        subject: format!("[TEST] {}", email.subject),
        text: format!("TEST / TESTE — No authentication link was issued. Nenhum link de autenticação foi emitido.\n\n{}", email.text),
    }).await?;
    Ok(Json(EmailTest { accepted: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_uses_only_fictional_values_and_the_production_renderer() {
        let mut request = EmailPreviewRequest {
            project: "shop".into(),
            kind: "recovery".into(),
            language: "pt-BR".into(),
            subject: Some("{{project_name}} · {{validity}}".into()),
            text: Some("{{email}}\n{{link}}".into()),
            ttl_minutes: 10,
        };
        let result = render(&request).unwrap();
        assert_eq!(result.subject, "Projeto exemplo · 10 minutos");
        assert!(result.text.contains("person@example.invalid"));
        assert!(result.text.contains("preview-not-an-authentication-token"));
        request.subject = Some("x\r\nBcc: victim@example.test".into());
        assert_eq!(
            render(&request).err().unwrap().code(),
            "email_content_invalid"
        );
    }
}
