//! Page arithmetic must be validated before the query reaches PostgreSQL.
use crate::common::TestApp;
use crate::common::panel::{get, login};
use axum::http::StatusCode;

#[tokio::test]
async fn users_reject_pages_whose_offset_overflows() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    for page in [i64::MAX, i64::MAX / 50 + 1, 368_934_881_474_191_033] {
        let reply = get(&app, &format!("/admin/api/users?page={page}"), &cookie).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text);
        assert_eq!(reply.body["code"], "invalid_page");
    }
}

#[tokio::test]
async fn tables_reject_pages_whose_offset_overflows() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    for page in [i64::MAX, i64::MAX / 500 + 1, 36_893_488_147_419_104] {
        let reply = get(
            &app,
            &format!("/admin/api/tables/products?page={page}&size=500"),
            &cookie,
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text);
        assert_eq!(reply.body["code"], "invalid_page");
    }
}

#[tokio::test]
async fn supported_page_boundaries_and_empty_filters_keep_working() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    for route in [
        "/admin/api/users?page=0&q=".to_owned(),
        "/admin/api/users?page=-1".to_owned(),
        format!("/admin/api/users?page={}", i64::MAX / 50),
        "/admin/api/tables/products?page=0&filters=".to_owned(),
        "/admin/api/tables/products?page=-1&size=0".to_owned(),
        format!(
            "/admin/api/tables/products?page={}&size=500",
            i64::MAX / 500
        ),
        format!("/admin/api/tables/products?page={}&size=1", i64::MAX),
    ] {
        let reply = get(&app, &route, &cookie).await;
        assert_eq!(reply.status, StatusCode::OK, "{route}: {}", reply.text);
    }
}
