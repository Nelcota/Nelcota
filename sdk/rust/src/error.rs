use std::time::Duration;

/// SDK failures. Server error codes are preserved verbatim.
#[derive(Clone, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("{message} ({code}, HTTP {status})")]
    Http {
        status: u16,
        code: String,
        message: String,
        retry_after: Option<Duration>,
        /// What Postgres reported, when the server sends it (boxed to keep `Error` small).
        db: Option<Box<DbErrorInfo>>,
    },
    #[error("invalid SDK input: {0}")]
    Usage(String),
    /// A transport failure. The message includes the transport's cause
    /// chain (without request URLs); the variant keeps no source object so
    /// `Error` stays `Clone` for shared session refresh results.
    #[error("network request failed: {0}")]
    Network(String),
    #[error("request timed out")]
    Timeout,
    #[error("request cancelled")]
    Cancelled,
    #[error("invalid response (HTTP {status}): {message}")]
    InvalidResponse { status: u16, message: String },
    #[error("expected {expected} row(s), got {actual}")]
    Cardinality {
        expected: &'static str,
        actual: usize,
    },
    #[error("not signed in")]
    SessionMissing,
    #[error("session storage failed: {0}")]
    SessionStorage(String),
}

/// The optional Postgres fields of an error response (`db_error`). Older
/// servers send none of them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct DbErrorInfo {
    /// SQLSTATE, for example `23505` for a unique violation.
    pub sqlstate: Option<String>,
    /// Postgres DETAIL, for example `Key (slug)=(a) already exists.`.
    pub details: Option<String>,
    /// Postgres HINT.
    pub hint: Option<String>,
    /// Name of the violated constraint.
    pub constraint: Option<String>,
}

impl DbErrorInfo {
    pub(crate) fn from_body(body: &serde_json::Value) -> Option<Box<Self>> {
        let field = |key: &str| body[key].as_str().map(str::to_owned);
        let info = Self {
            sqlstate: field("sqlstate"),
            details: field("details"),
            hint: field("hint"),
            constraint: field("constraint"),
        };
        (info != Self::default()).then(|| Box::new(info))
    }
}

/// The code of an error response without a JSON body (a HEAD request, a proxy page).
pub(crate) fn code_for_status(status: u16) -> String {
    match status {
        401 => "unauthorized".into(),
        403 => "forbidden".into(),
        404 => "not_found".into(),
        429 => "rate_limited".into(),
        503 => "unavailable".into(),
        _ => format!("http_{status}"),
    }
}

impl Error {
    pub fn code(&self) -> &str {
        match self {
            Self::Http { code, .. } => code,
            Self::Usage(_) => "invalid_input",
            Self::Network(_) => "network_error",
            Self::Timeout => "timeout",
            Self::Cancelled => "aborted",
            Self::InvalidResponse { .. } => "invalid_response",
            Self::Cardinality { .. } => "not_single",
            Self::SessionMissing => "session_missing",
            Self::SessionStorage(_) => "session_storage_error",
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } | Self::InvalidResponse { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Http { retry_after, .. } => *retry_after,
            _ => None,
        }
    }

    /// The Postgres fields of a server error, when it sent any.
    pub fn db_info(&self) -> Option<&DbErrorInfo> {
        match self {
            Self::Http { db, .. } => db.as_deref(),
            _ => None,
        }
    }

    /// Postgres SQLSTATE (`23505`), when the server sent it.
    pub fn sqlstate(&self) -> Option<&str> {
        self.db_info()?.sqlstate.as_deref()
    }

    /// Postgres DETAIL, when the server sent it.
    pub fn details(&self) -> Option<&str> {
        self.db_info()?.details.as_deref()
    }

    /// Postgres HINT, when the server sent it.
    pub fn hint(&self) -> Option<&str> {
        self.db_info()?.hint.as_deref()
    }

    /// Name of the violated constraint, when the server sent it.
    pub fn constraint(&self) -> Option<&str> {
        self.db_info()?.constraint.as_deref()
    }

    /// 404, or a `*_not_found` code (table, bucket, file, user).
    pub fn is_not_found(&self) -> bool {
        self.status() == Some(404)
            || matches!(
                self.code(),
                "not_found" | "bucket_not_found" | "object_not_found" | "user_not_found"
            )
    }

    /// 409 (a unique or foreign key violation, an existing file or bucket)
    /// or an account that already exists.
    pub fn is_conflict(&self) -> bool {
        self.status() == Some(409)
            || matches!(
                self.code(),
                "user_already_exists" | "object_exists" | "bucket_exists"
            )
    }

    /// A unique violation (SQLSTATE `23505`), when the server reports SQLSTATE.
    pub fn is_unique_violation(&self) -> bool {
        self.sqlstate() == Some("23505")
    }

    /// 429: wait for [`Error::retry_after`] before trying again.
    pub fn is_rate_limited(&self) -> bool {
        self.status() == Some(429) || self.code() == "rate_limited"
    }

    /// 401: no valid token, or a visitor (`anon`) without the GRANT.
    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(401)
    }

    /// 403: signed in, but the role lacks the GRANT or a policy refused it.
    pub fn is_forbidden(&self) -> bool {
        self.status() == Some(403)
    }

    /// Worth retrying later: network failures, timeouts, 429 and 503.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Network(_) | Self::Timeout) || matches!(self.status(), Some(429 | 503))
    }

    pub(crate) fn network(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            return Self::Timeout;
        }
        // URLs may contain signed storage tokens. Never include them in errors.
        let error = error.without_url();
        let mut message = error.to_string();
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            let cause_text = cause.to_string();
            if !message.ends_with(&cause_text) {
                message.push_str(": ");
                message.push_str(&cause_text);
            }
            source = cause.source();
        }
        Self::Network(message)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn http(status: u16, code: &str, db: Option<Box<DbErrorInfo>>) -> Error {
        Error::Http {
            status,
            code: code.into(),
            message: "m".into(),
            retry_after: None,
            db,
        }
    }

    #[test]
    fn reads_optional_postgres_fields() {
        let body = json!({"code":"db_error","message":"m","sqlstate":"23505","details":"Key (slug)=(a) already exists.","constraint":"notes_slug_key"});
        let error = http(409, "db_error", DbErrorInfo::from_body(&body));
        assert_eq!(error.sqlstate(), Some("23505"));
        assert_eq!(error.details(), Some("Key (slug)=(a) already exists."));
        assert_eq!(error.hint(), None);
        assert_eq!(error.constraint(), Some("notes_slug_key"));
        assert!(error.is_conflict() && error.is_unique_violation());
        assert!(DbErrorInfo::from_body(&json!({"code":"db_error","message":"m"})).is_none());
        assert_eq!(Error::Timeout.sqlstate(), None);
    }

    #[test]
    fn classifies_by_status_and_code() {
        assert!(http(404, "db_error", None).is_not_found());
        assert!(http(400, "user_not_found", None).is_not_found());
        assert!(http(400, "user_already_exists", None).is_conflict());
        assert!(!http(400, "db_error", None).is_conflict());
        assert!(http(429, "rate_limited", None).is_rate_limited());
        assert!(http(429, "rate_limited", None).is_retryable());
        assert!(http(503, "unavailable", None).is_retryable());
        assert!(Error::Timeout.is_retryable() && !Error::Cancelled.is_retryable());
        assert!(http(401, "invalid_token", None).is_unauthorized());
        assert!(http(403, "db_error", None).is_forbidden());
        assert_eq!(code_for_status(403), "forbidden");
        assert_eq!(code_for_status(502), "http_502");
    }
}
