//! API HTTP error, shaped as `{"code": "...", "message": "..."}`.
//!
//! Database errors may add `sqlstate`, `details`, `hint` and `constraint`
//! (each omitted when absent), straight from Postgres, so a client can tell a
//! unique violation from a check violation without parsing the message.

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tokio_postgres::error::SqlState;

use crate::Role;

/// The code and message of an error response, attached to the response's
/// extensions so a layer (the panel's log of denied requests) can read them
/// without parsing the body.
#[derive(Debug, Clone)]
pub struct ErrorInfo {
    pub code: &'static str,
    pub message: String,
}

/// What Postgres said about a database error, besides its message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct DbFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    sqlstate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraint: Option<String>,
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    retry_after_secs: Option<u64>,
    db: Option<Box<DbFields>>,
}

/// The response body: the two fixed fields plus the optional database ones.
#[derive(Serialize)]
struct Body<'a> {
    code: &'static str,
    message: &'a str,
    #[serde(flatten)]
    db: Option<&'a DbFields>,
}

/// How a SQLSTATE is answered.
#[derive(Debug, PartialEq, Eq)]
enum Class {
    /// A client error (`db_error`) with this status.
    Client(StatusCode),
    /// Transient: the same request may succeed if retried (503 `unavailable`).
    Transient,
    /// Not the client's fault: a hidden 500.
    Internal,
}

/// Classifies a SQLSTATE. Missing privileges become 401 for `anon` (must
/// sign in) and 403 for the other roles, as in PostgREST.
fn classify(state: &SqlState, role: Role) -> Class {
    let code = state.code();
    let status = match *state {
        SqlState::INSUFFICIENT_PRIVILEGE if role == Role::Anon => StatusCode::UNAUTHORIZED,
        SqlState::INSUFFICIENT_PRIVILEGE => StatusCode::FORBIDDEN,
        SqlState::UNDEFINED_TABLE => StatusCode::NOT_FOUND,
        SqlState::UNIQUE_VIOLATION
        | SqlState::FOREIGN_KEY_VIOLATION
        | SqlState::EXCLUSION_VIOLATION => StatusCode::CONFLICT,
        SqlState::QUERY_CANCELED => StatusCode::GATEWAY_TIMEOUT,
        // Serialization failure, deadlock, lock not available, too many
        // connections, server shutting down or starting: retrying helps.
        SqlState::T_R_SERIALIZATION_FAILURE
        | SqlState::T_R_DEADLOCK_DETECTED
        | SqlState::LOCK_NOT_AVAILABLE
        | SqlState::TOO_MANY_CONNECTIONS
        | SqlState::ADMIN_SHUTDOWN
        | SqlState::CRASH_SHUTDOWN
        | SqlState::CANNOT_CONNECT_NOW => return Class::Transient,
        // Incompatible type/operator, generated column: a client error, not a
        // server one. Upserts: `on_conflict` matching no unique constraint, or
        // a batch that hits the same key twice.
        SqlState::UNDEFINED_FUNCTION
        | SqlState::UNDEFINED_COLUMN
        | SqlState::DATATYPE_MISMATCH
        | SqlState::GENERATED_ALWAYS
        | SqlState::INVALID_COLUMN_REFERENCE
        | SqlState::CARDINALITY_VIOLATION => StatusCode::BAD_REQUEST,
        // Class 22 (invalid data), 23 (integrity) and P0 (PL/pgSQL: `RAISE
        // EXCEPTION` with the default P0001 or a custom `ERRCODE` such as
        // P0002, `ASSERT` failures): 400 with the function's message.
        _ if code.starts_with("22") || code.starts_with("23") || code.starts_with("P0") => {
            StatusCode::BAD_REQUEST
        }
        _ => return Class::Internal,
    };
    Class::Client(status)
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
            retry_after_secs: None,
            db: None,
        }
    }

    /// 429 with `Retry-After`.
    pub fn rate_limited(retry_after_secs: u64) -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many attempts; wait and try again",
        )
        .retry_after(retry_after_secs)
    }

    /// Adds `Retry-After` (at least one second).
    pub fn retry_after(mut self, secs: u64) -> Self {
        self.retry_after_secs = Some(secs.max(1));
        self
    }

    /// Token missing when required, invalid, expired or with an unknown role.
    pub fn invalid_token() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "invalid_token",
            "invalid or expired JWT",
        )
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    }

    pub fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "database unavailable",
        )
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// The SQLSTATE of a database error, when the error came from Postgres.
    pub fn sqlstate(&self) -> Option<&str> {
        self.db.as_ref().and_then(|db| db.sqlstate.as_deref())
    }

    /// Maps a Postgres error: client errors keep the database's message,
    /// detail, hint and constraint; transient ones become a retryable 503;
    /// anything else is logged and hidden behind a 500.
    pub fn from_db(err: tokio_postgres::Error, role: Role) -> Self {
        Self::from_db_in(err, role, false)
    }

    /// [`from_db`](Self::from_db) for a `READ ONLY` request transaction: a
    /// view or policy that writes during a read (`25006`) is the request's
    /// fault there (400). Elsewhere a read-only database (a failover, a replica
    /// configured by mistake) stays a server error.
    pub fn from_read_db(err: tokio_postgres::Error, role: Role) -> Self {
        Self::from_db_in(err, role, true)
    }

    fn from_db_in(err: tokio_postgres::Error, role: Role, read_only: bool) -> Self {
        let db = match err.as_db_error() {
            Some(db) => db,
            _ => {
                tracing::error!(
                    event = "database.transport_failed",
                    closed = err.is_closed(),
                    "failed to communicate with Postgres"
                );
                return Self::unavailable();
            }
        };
        let code = db.code().code();
        if code == "54000" && db.message() == "NELCOTA_RESPONSE_TOO_LARGE" {
            return Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "response_too_large",
                "the JSON response exceeds the 8 MiB budget; narrow the selection or page the results",
            );
        }
        let writes_in_read = read_only && db.code() == &SqlState::READ_ONLY_SQL_TRANSACTION;
        let class = match writes_in_read {
            true => Class::Client(StatusCode::BAD_REQUEST),
            false => classify(db.code(), role),
        };
        let (status, api_code) = match class {
            Class::Client(status) => (status, "db_error"),
            Class::Transient => {
                tracing::warn!(
                    event = "database.transient_failure",
                    code,
                    "transient Postgres error"
                );
                (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
            }
            Class::Internal => {
                tracing::error!(
                    event = "database.internal_failure",
                    code,
                    "unexpected Postgres error"
                );
                return Self::internal();
            }
        };
        let mut error = Self::new(status, api_code, format!("{} ({code})", db.message()));
        error.db = Some(Box::new(DbFields {
            sqlstate: Some(code.to_owned()),
            details: db.detail().map(str::to_owned),
            hint: db.hint().map(str::to_owned),
            constraint: db.constraint().map(str::to_owned),
        }));
        if status == StatusCode::SERVICE_UNAVAILABLE {
            error = error.retry_after(1);
        }
        error
    }

    pub fn from_pool(err: deadpool_postgres::PoolError) -> Self {
        use deadpool_postgres::{PoolError, TimeoutType};
        let (kind, sqlstate) = match &err {
            PoolError::Timeout(TimeoutType::Wait) => ("wait_timeout", None),
            PoolError::Timeout(TimeoutType::Create) => ("create_timeout", None),
            PoolError::Timeout(TimeoutType::Recycle) => ("recycle_timeout", None),
            PoolError::Backend(error) => ("backend", error.code().map(|code| code.code())),
            PoolError::Closed => ("closed", None),
            PoolError::NoRuntimeSpecified => ("runtime", None),
            PoolError::PostCreateHook(_) => ("post_create_hook", None),
        };
        tracing::error!(
            event = "database.pool_acquire_failed",
            error_kind = kind,
            sqlstate,
            "could not get a connection from the pool"
        );
        Self::unavailable()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Body {
            code: self.code,
            message: &self.message,
            db: self.db.as_deref(),
        };
        let mut response = (self.status, Json(body)).into_response();
        response.extensions_mut().insert(ErrorInfo {
            code: self.code,
            message: self.message,
        });
        if self.status == StatusCode::UNAUTHORIZED {
            // RFC 6750 §3.1: `invalid_token` only when a token was presented
            // and rejected; `anon` lacking a privilege just needs to sign in.
            let challenge = match self.code == "invalid_token" {
                true => r#"Bearer error="invalid_token""#,
                false => "Bearer",
            };
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static(challenge),
            );
        }
        if let Some(secs) = self.retry_after_secs {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(error: ApiError) -> (Response, serde_json::Value) {
        let response = error.into_response();
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 16).await.unwrap();
        (
            Response::from_parts(parts, axum::body::Body::empty()),
            serde_json::from_slice(&bytes).unwrap(),
        )
    }

    #[tokio::test]
    async fn plain_errors_keep_the_two_field_shape() {
        let (_, json) = body(ApiError::new(StatusCode::BAD_REQUEST, "x", "y")).await;
        assert_eq!(json, serde_json::json!({ "code": "x", "message": "y" }));
    }

    #[tokio::test]
    async fn database_fields_appear_only_when_present() {
        let mut error = ApiError::new(StatusCode::CONFLICT, "db_error", "dup (23505)");
        error.db = Some(Box::new(DbFields {
            sqlstate: Some("23505".into()),
            details: Some("Key (id)=(1) already exists.".into()),
            hint: None,
            constraint: Some("t_pkey".into()),
        }));
        let (_, json) = body(error).await;
        assert_eq!(
            json,
            serde_json::json!({
                "code": "db_error",
                "message": "dup (23505)",
                "sqlstate": "23505",
                "details": "Key (id)=(1) already exists.",
                "constraint": "t_pkey",
            })
        );
    }

    #[tokio::test]
    async fn only_rejected_tokens_name_invalid_token_in_the_challenge() {
        let (response, _) = body(ApiError::invalid_token()).await;
        assert_eq!(
            response.headers()[header::WWW_AUTHENTICATE],
            r#"Bearer error="invalid_token""#
        );
        let anon = ApiError::new(StatusCode::UNAUTHORIZED, "db_error", "permission denied");
        let (response, _) = body(anon).await;
        assert_eq!(response.headers()[header::WWW_AUTHENTICATE], "Bearer");
    }

    #[test]
    fn sqlstates_are_classified() {
        let client = |code: &str, role| classify(&SqlState::from_code(code), role);
        assert_eq!(
            client("42501", Role::Anon),
            Class::Client(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            client("42501", Role::Authenticated),
            Class::Client(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            client("23505", Role::Anon),
            Class::Client(StatusCode::CONFLICT)
        );
        for raise in ["P0001", "P0002", "P0004"] {
            assert_eq!(
                client(raise, Role::Anon),
                Class::Client(StatusCode::BAD_REQUEST),
                "{raise}"
            );
        }
        for transient in ["40001", "40P01", "53300", "55P03", "57P01"] {
            assert_eq!(
                client(transient, Role::Anon),
                Class::Transient,
                "{transient}"
            );
        }
        assert_eq!(client("XX000", Role::Anon), Class::Internal);
        assert_eq!(client("42P07", Role::Anon), Class::Internal);
    }
}
