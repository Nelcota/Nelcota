//! Origin checks and response security headers.
use crate::ApiError;
use axum::{
    extract::Request,
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
/// CSRF defence on top of `SameSite=Strict`: state-changing requests must come
/// from the same origin (browsers always send `Origin` on POST).
pub(crate) async fn same_origin(request: Request, next: Next) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        let headers = request.headers();
        let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
        if let Some(value) = headers.get(header::ORIGIN) {
            let matches = value.to_str().ok().is_some_and(|origin| {
                host.is_some_and(|host| {
                    origin == format!("https://{host}") || origin == format!("http://{host}")
                })
            });
            if !matches {
                return forbidden_origin();
            }
        }
        if let Some(value) = headers.get("sec-fetch-site")
            && !matches!(value.to_str().ok(), Some("same-origin" | "none"))
        {
            return forbidden_origin();
        }
    }
    next.run(request).await
}

fn forbidden_origin() -> Response {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "origin_not_allowed",
        "origin not allowed",
    )
    .into_response()
}

pub(crate) async fn security_headers(request: Request, next: Next) -> Response {
    // Only Scalar's static document may be framed by this same origin. The
    // panel and authenticated API keep their existing anti-framing policy.
    let reference = request.uri().path() == "/admin/assets/reference.html";
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    // Scripts only from this server. Inline styles are allowed because
    // Svelte transitions, CodeMirror and menu positioning (floating-ui)
    // inject styles at runtime.
    // A file downloaded through the panel keeps its own (sandboxed) policy.
    let policy = match reference {
        true => {
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data:; font-src 'self'; connect-src 'self'; \
         frame-ancestors 'self'; form-action 'self'; base-uri 'none'"
        }
        false => {
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data:; font-src 'self'; connect-src 'self'; \
         frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
        }
    };
    headers
        .entry(header::CONTENT_SECURITY_POLICY)
        .or_insert(HeaderValue::from_static(policy));
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static(match reference {
            true => "SAMEORIGIN",
            false => "DENY",
        }),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // `same-origin`, not `no-referrer`: with `no-referrer` the browser sends
    // `Origin: null` on POSTs and the CSRF check would reject the panel itself.
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    response
}
