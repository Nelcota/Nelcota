//! Panel assets integration scenarios.
use crate::common::*;
use axum::http::{Method, StatusCode, header};

#[tokio::test]
async fn embedded_spa_with_security_headers() {
    let app = TestApp::spawn().await;

    let index = app.raw(Method::GET, "/admin/", &[], String::new()).await;
    assert_eq!(index.status, StatusCode::OK);
    assert!(index.text.contains("<div id=\"app\">"));
    let csp = index.headers[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap();
    assert!(csp.contains("script-src 'self';"), "{csp}");
    assert!(
        !csp.contains("script-src 'self' 'unsafe"),
        "scripts never inline"
    );
    assert_eq!(index.headers[header::X_FRAME_OPTIONS], "DENY");
    // Regression: with `no-referrer` the browser sends `Origin: null` on POSTs.
    assert_eq!(index.headers[header::REFERRER_POLICY], "same-origin");
    assert!(
        !index.text.contains("<script>"),
        "no inline script in index.html"
    );

    // Client routes return the same index.html.
    let deep = app
        .raw(Method::GET, "/admin/tables/anything", &[], String::new())
        .await;
    assert_eq!(deep.status, StatusCode::OK);
    assert_eq!(deep.text, index.text);

    let reference = app
        .raw(
            Method::GET,
            "/admin/assets/reference.html",
            &[],
            String::new(),
        )
        .await;
    assert_eq!(reference.status, StatusCode::OK);
    assert_eq!(reference.headers[header::X_FRAME_OPTIONS], "SAMEORIGIN");
    assert_eq!(reference.headers[header::CACHE_CONTROL], "no-cache");
    let policy = reference.headers[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap();
    assert!(policy.contains("frame-ancestors 'self'"));
    assert!(policy.contains("script-src 'self';"));
    assert!(!reference.text.contains("<script>"));
    assert!(reference.text.contains("/admin/assets/reference-"));

    // The referenced bundle exists, with an immutable cache.
    let script = index
        .text
        .split("src=\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .expect("index.html references the bundle");
    assert!(script.starts_with("/admin/assets/index-"), "{script}");
    let js = app.raw(Method::GET, script, &[], String::new()).await;
    assert_eq!(js.status, StatusCode::OK);
    assert!(
        js.headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );
    assert!(
        js.headers[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable")
    );

    // The theme is set by a blocking script file before the first paint.
    let theme = index
        .text
        .split("src=\"")
        .filter_map(|s| s.split('"').next())
        .find(|src| src.starts_with("/admin/assets/theme-init-"))
        .expect("index.html loads the theme script");
    let js = app.raw(Method::GET, theme, &[], String::new()).await;
    assert_eq!(js.status, StatusCode::OK);
    assert!(js.text.contains("mode-watcher-mode"));
    assert!(
        js.headers[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable")
    );

    let reply = app
        .raw(
            Method::GET,
            "/admin/assets/../Cargo.toml",
            &[],
            String::new(),
        )
        .await;
    assert_ne!(reply.status, StatusCode::OK);
    let reply = app
        .raw(Method::GET, "/admin/api/missing", &[], String::new())
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.body["code"], "route_not_found");
}
