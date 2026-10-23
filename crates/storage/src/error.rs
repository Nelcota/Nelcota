//! Storage failure vocabulary shared by operations and HTTP adapters.
use axum::http::StatusCode;
use nelcota_core::{ApiError, Claims};
use tokio_postgres::error::SqlState;
pub(crate) fn bucket_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "bucket_not_found",
        "bucket not found",
    )
}

pub(crate) fn storage_full(message: &str) -> ApiError {
    ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "storage_full", message)
}

pub(crate) fn too_large(limit: u64) -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "file_too_large",
        format!("the file exceeds the limit of {limit} bytes"),
    )
}

/// Read only typed IO metadata from a bounded cause chain, never its text.
pub(crate) fn diagnostic_io_kind(
    error: &(dyn std::error::Error + 'static),
) -> Option<std::io::ErrorKind> {
    std::iter::successors(Some(error), |source| source.source())
        .take(8)
        .find_map(|source| {
            source
                .downcast_ref::<std::io::Error>()
                .map(std::io::Error::kind)
        })
}

pub(crate) fn store_failed(err: impl std::error::Error + 'static) -> ApiError {
    tracing::error!(event = "storage.backend_failed", error_type = std::any::type_name_of_val(&err), io_kind = ?diagnostic_io_kind(&err), "storage backend failed");
    ApiError::internal()
}

/// Maps a database error of a write: an existing name is its own case.
pub(crate) fn write_error(err: tokio_postgres::Error, claims: &Claims) -> ApiError {
    if err.code() == Some(&SqlState::UNIQUE_VIOLATION) {
        return ApiError::new(
            StatusCode::CONFLICT,
            "object_exists",
            "a file with this name already exists; use PUT to replace it",
        );
    }
    ApiError::from_db(err, claims.role())
}

pub(crate) fn object_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "object_not_found", "file not found")
}
