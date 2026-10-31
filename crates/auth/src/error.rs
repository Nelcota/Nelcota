//! Authentication error vocabulary shared by the workflows.
use crate::InvalidCredential;
use axum::http::StatusCode;
use nelcota_core::ApiError;
pub(crate) fn invalid_grant(message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant", message)
}

pub(crate) fn validation(message: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
        message,
    )
}

pub(crate) fn unsupported_type(message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "unsupported_type", message)
}

/// An email rejected by the `credentials` rules: 422 `invalid_email`.
pub(crate) fn invalid_email(err: InvalidCredential) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_email", err.0)
}

/// A password rejected by the `credentials` rules: 422 `weak_password`.
pub(crate) fn weak_password(err: InvalidCredential) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "weak_password", err.0)
}

/// A PKCE challenge other than S256's 43-character form: 400
/// `invalid_code_challenge`.
pub(crate) fn invalid_code_challenge() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_code_challenge",
        "code_challenge must be an S256 PKCE challenge (code_challenge_method=S256)",
    )
}
