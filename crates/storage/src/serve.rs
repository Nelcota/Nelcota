//! Serving a file (D79): inert headers, conditional requests and byte
//! ranges on disk, and a redirect to a presigned URL on S3.

use std::{future::Future, time::Duration};

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use nelcota_core::ApiError;
use object_store::GetRange;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use crate::{StorageState, db::Object, error::object_not_found as not_found, mime, store::Store};

/// Applied to every file: no scripts, no plugins, no forms, nothing loaded
/// from elsewhere, even if a browser were convinced to render it as a page.
const CSP: &str = "default-src 'none'; img-src 'self'; media-src 'self'; \
     style-src 'unsafe-inline'; sandbox";

/// Longest a presigned S3 URL lives.
const PRESIGNED_TTL: Duration = Duration::from_secs(300);

/// Who reached the file decides how caches may keep it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Through the caller's policies.
    Private,
    /// A public bucket.
    Public,
    /// A signed URL valid for `secs` more seconds.
    Signed { secs: u64 },
}

/// Characters kept as they are in RFC 5987 `filename*`.
const ATTR_CHAR: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'!')
    .remove(b'#')
    .remove(b'$')
    .remove(b'&')
    .remove(b'+')
    .remove(b'-')
    .remove(b'.')
    .remove(b'^')
    .remove(b'_')
    .remove(b'`')
    .remove(b'|')
    .remove(b'~');

fn disposition(name: &str, mime: &str, download: bool) -> String {
    let kind = match mime::inline(mime) && !download {
        true => "inline",
        false => "attachment",
    };
    let file = name.rsplit('/').next().unwrap_or(name);
    format!(
        "{kind}; filename*=UTF-8''{}",
        utf8_percent_encode(file, ATTR_CHAR)
    )
}

fn header_value(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// A requested byte range, already checked against the size.
#[derive(Debug, PartialEq, Eq)]
enum Ranged {
    Full,
    /// Inclusive bounds.
    Part(u64, u64),
    Unsatisfiable,
}

/// One `bytes=` range; several ranges or a malformed header serve the whole
/// file, as RFC 9110 allows.
fn parse_range(value: &str, size: u64) -> Ranged {
    let spec = match value.trim().strip_prefix("bytes=") {
        Some(spec) => spec,
        _ => {
            return Ranged::Full;
        }
    };
    if spec.contains(',') {
        return Ranged::Full;
    }
    let (start, end) = match spec.trim().split_once('-') {
        Some((start, end)) => (start, end),
        _ => {
            return Ranged::Full;
        }
    };
    let (start, end) = (start.trim(), end.trim());
    let range = match (start.parse::<u64>(), end.parse::<u64>()) {
        // bytes=-N: the last N bytes.
        _ if start.is_empty() => match end.parse::<u64>() {
            Ok(0) => return Ranged::Unsatisfiable,
            Ok(n) => (size.saturating_sub(n), size.saturating_sub(1)),
            Err(_) => return Ranged::Full,
        },
        (Ok(s), Ok(e)) if s <= e => (s, e.min(size.saturating_sub(1))),
        (Ok(s), Err(_)) if end.is_empty() => (s, size.saturating_sub(1)),
        _ => return Ranged::Full,
    };
    if size == 0 || range.0 >= size {
        return Ranged::Unsatisfiable;
    }
    Ranged::Part(range.0, range.1)
}

fn etag_matches(list: &str, etag: &str) -> bool {
    list.split(',').map(str::trim).any(|candidate| {
        candidate == "*" || candidate.trim_start_matches("W/").trim_matches('"') == etag
    })
}

/// A replacement can retire the bytes after metadata was read. Resolve the
/// current version and its authorization again, and rebuild conditional/range
/// headers together. Limit retries when another writer keeps replacing it.
pub(crate) async fn respond_current<Fut>(
    state: &StorageState,
    bucket: &str,
    name: &str,
    request: &HeaderMap,
    download: bool,
    resolve: impl Fn() -> Fut + Send + Sync,
) -> Result<Response, ApiError>
where
    Fut: Future<Output = Result<(Object, Access), ApiError>> + Send,
{
    let (mut object, mut access) = resolve().await?;
    for _ in 0..3 {
        match respond(state, bucket, name, &object, request, access, download).await {
            Err(error) if error.code() == "object_not_found" => {
                let (current, current_access) = resolve().await?;
                if current.version == object.version {
                    tracing::error!(event = "storage.bytes_missing", version = %object.version, "a row points to missing bytes");
                    return Err(error);
                }
                object = current;
                access = current_access;
            }
            result => return result,
        }
    }
    Err(ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "the file keeps changing; retry the download",
    ))
}

/// The response for one already authorized version.
async fn respond(
    state: &StorageState,
    bucket: &str,
    name: &str,
    object: &Object,
    request: &HeaderMap,
    access: Access,
    download: bool,
) -> Result<Response, ApiError> {
    let content_type = mime::content_type(&object.mime_type);
    let disposition = disposition(name, &object.mime_type, download);
    let key = Store::key(bucket, object.version);

    if state.store.is_s3() {
        let ttl = match access {
            Access::Signed { secs } => PRESIGNED_TTL.min(Duration::from_secs(secs)),
            _ => PRESIGNED_TTL,
        };
        let url = state
            .store
            .presigned_get(&key, ttl, &content_type, &disposition)
            .await
            .map_err(|err| {
                tracing::error!(
                    event = "storage.presign_failed",
                    error_type = std::any::type_name_of_val(&err),
                    "could not presign a download"
                );
                ApiError::internal()
            })?
            .expect("S3 store presigns");
        let mut response = StatusCode::FOUND.into_response();
        let headers = response.headers_mut();
        headers.insert(header::LOCATION, header_value(url.as_str()));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok(response);
    }

    let etag = format!("\"{}\"", object.etag);
    let mut headers = HeaderMap::new();
    headers.insert(header::ETAG, header_value(&etag));
    headers.insert(
        header::LAST_MODIFIED,
        header_value(&httpdate::fmt_http_date(object.updated_at)),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(match access {
            Access::Public => "public, max-age=60",
            Access::Private | Access::Signed { .. } => "private, no-cache",
        }),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );

    if request
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|list| etag_matches(list, &object.etag))
    {
        return Ok((StatusCode::NOT_MODIFIED, headers).into_response());
    }

    // A range only applies while the file is the one the client has.
    let if_range_ok = request
        .get(header::IF_RANGE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v.trim() == etag);
    let ranged = match request.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        Some(range) if if_range_ok => parse_range(range, object.size),
        _ => Ranged::Full,
    };
    let (status, range) = match ranged {
        Ranged::Full => (StatusCode::OK, None),
        Ranged::Part(start, end) => {
            headers.insert(
                header::CONTENT_RANGE,
                header_value(&format!("bytes {start}-{end}/{}", object.size)),
            );
            (
                StatusCode::PARTIAL_CONTENT,
                Some(GetRange::Bounded(start..end + 1)),
            )
        }
        Ranged::Unsatisfiable => {
            headers.insert(
                header::CONTENT_RANGE,
                header_value(&format!("bytes */{}", object.size)),
            );
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response());
        }
    };

    let result = match state.store.get(&key, range).await {
        Ok(result) => result,
        Err(crate::StoreError::Store(object_store::Error::NotFound { .. })) => {
            return Err(not_found());
        }
        Err(err) => {
            tracing::error!(
                event = "storage.read_failed",
                error_type = std::any::type_name_of_val(&err),
                "could not read stored bytes"
            );
            return Err(ApiError::internal());
        }
    };
    let length = result.range.end - result.range.start;
    headers.insert(header::CONTENT_TYPE, header_value(&content_type));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(header::CONTENT_DISPOSITION, header_value(&disposition));
    let body = Body::from_stream(result.into_stream());
    Ok((status, headers, body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Ranged::Part(0, 9));
        assert_eq!(parse_range("bytes=90-", 100), Ranged::Part(90, 99));
        assert_eq!(parse_range("bytes=-10", 100), Ranged::Part(90, 99));
        assert_eq!(parse_range("bytes=-500", 100), Ranged::Part(0, 99));
        assert_eq!(parse_range("bytes=50-500", 100), Ranged::Part(50, 99));
        assert_eq!(parse_range("bytes=100-", 100), Ranged::Unsatisfiable);
        assert_eq!(parse_range("bytes=-0", 100), Ranged::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-", 0), Ranged::Unsatisfiable);
        for full in [
            "bytes=9-0",
            "bytes=0-1,5-6",
            "items=0-1",
            "bytes=a-b",
            "bytes=5",
        ] {
            assert_eq!(parse_range(full, 100), Ranged::Full, "{full}");
        }
    }

    #[test]
    fn dispositions() {
        assert_eq!(
            disposition("a/photo.png", "image/png", false),
            "inline; filename*=UTF-8''photo.png"
        );
        assert_eq!(
            disposition("a/photo.png", "image/png", true),
            "attachment; filename*=UTF-8''photo.png"
        );
        assert_eq!(
            disposition("relatório \"x\".html", "text/html", false),
            "attachment; filename*=UTF-8''relat%C3%B3rio%20%22x%22.html"
        );
    }

    #[test]
    fn etags() {
        assert!(etag_matches("\"abc\"", "abc"));
        assert!(etag_matches("W/\"abc\", \"def\"", "def"));
        assert!(etag_matches("*", "abc"));
        assert!(!etag_matches("\"abd\"", "abc"));
    }
}
