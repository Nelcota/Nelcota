//! Panel error representation and HTTP adaptation.
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
/// Panel API error: `{"error": "<English text>", "code": "...", "params": {...}}`.
///
/// `code` and `params` let the panel show the error in the user's language
/// (crates/admin/ui/src/lib/i18n/messages/<language>/errors.ts); `error` stays the
/// English text for other API consumers. Errors that come straight from
/// Postgres carry no code, so the panel shows their text as-is.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    code: Option<&'static str>,
    params: Option<serde_json::Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            code: Some(code),
            params: None,
        }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    /// Values for the placeholders of the translated message.
    pub fn params(mut self, params: serde_json::Value) -> Self {
        self.params = Some(params);
        self
    }

    /// Error without a code, shown verbatim (e.g. a Postgres message).
    pub fn raw(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            code: None,
            params: None,
        }
    }
}

/// Any other error (database, JSON) becomes a 500 with its message: the admin
/// owns the database and needs the text to act on it. A database that cannot
/// be reached (pool timeout, refused or dropped connection) is a 503
/// `unavailable` instead: its driver text says nothing the panel can act on.
impl<E: std::fmt::Display + 'static> From<E> for ApiError {
    fn from(err: E) -> Self {
        if is_unavailable(&err) {
            tracing::warn!(error = %err, "database unavailable");
            return ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "database unavailable",
            );
        }
        ApiError::raw(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
    }
}

/// Pool errors, and driver errors about the connection itself (closed, or an
/// I/O failure). Other driver errors without a SQLSTATE (a row count or type
/// conversion mismatch) are bugs worth showing as they are.
fn is_unavailable(err: &dyn std::any::Any) -> bool {
    use std::error::Error;
    if err.is::<deadpool_postgres::PoolError>() {
        return true;
    }
    err.downcast_ref::<tokio_postgres::Error>()
        .is_some_and(|err| {
            err.as_db_error().is_none()
                && (err.is_closed()
                    || err
                        .source()
                        .is_some_and(|source| source.is::<std::io::Error>()))
        })
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.message });
        if let Some(code) = self.code {
            body["code"] = json!(code);
        }
        if let Some(params) = self.params {
            body["params"] = params;
        }
        (self.status, Json(body)).into_response()
    }
}

pub(crate) async fn api_not_found() -> ApiError {
    ApiError::not_found("route_not_found", "route not found")
}

/// Error of a query built from what the admin typed (filter value of the
/// wrong type, constraint violation…): 400 with Postgres' text, no code.
pub(crate) fn user_query_error(err: tokio_postgres::Error) -> ApiError {
    ApiError::raw(
        axum::http::StatusCode::BAD_REQUEST,
        err.as_db_error()
            .map_or_else(|| err.to_string(), |db| db.message().to_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_failures_are_unavailable() {
        let err = ApiError::from(deadpool_postgres::PoolError::Timeout(
            deadpool_postgres::TimeoutType::Wait,
        ));
        assert_eq!(err.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.code, Some("unavailable"));
    }

    #[test]
    fn other_errors_keep_their_text() {
        let json = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        let err = ApiError::from(json);
        assert_eq!(err.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(err.code, None);
        assert!(!err.message.is_empty());
    }
}
