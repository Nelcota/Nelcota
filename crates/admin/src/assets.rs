//! Embedded panel files and their cache policy.
use axum::{
    body::Body,
    extract::Path,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
/// Frontend build (`bun run build` in `crates/admin/ui`).
#[derive(RustEmbed)]
#[folder = "ui/dist/"]
struct Ui;

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}

fn ui_file(path: &str) -> Response {
    let file = match Ui::get(path) {
        Some(file) => file,
        _ => {
            return StatusCode::NOT_FOUND.into_response();
        }
    };
    (
        [(header::CONTENT_TYPE, content_type(path))],
        Body::from(file.data.into_owned()),
    )
        .into_response()
}

/// Hashed assets are immutable; the reference's HTML always revalidates.
pub(crate) async fn asset(Path(file): Path<String>) -> Response {
    let mut response = ui_file(&format!("assets/{file}"));
    if response.status().is_success() {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            match file.ends_with(".html") {
                true => HeaderValue::from_static("no-cache"),
                false => HeaderValue::from_static("public, max-age=31536000, immutable"),
            },
        );
    }
    response
}

/// Every panel route returns the SPA's `index.html` (client-side routing).
/// The page itself holds no data: everything comes from the authenticated API.
pub(crate) async fn spa() -> Response {
    let mut response = ui_file("index.html");
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// The same bundle has a separate entry mode without project session handoff.
pub(crate) async fn controller_spa() -> Response {
    let file = match Ui::get("index.html") {
        Some(file) => file,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let html = String::from_utf8_lossy(&file.data).replacen(
        "<head>",
        "<head><meta name=\"nelcota-updates-controller\" content=\"1\">",
        1,
    );
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        html,
    )
        .into_response()
}
