//! Structured panel filters/order must not be interpreted as URL modifiers.
use crate::common::TestApp;
use crate::common::panel::{get, login};
use axum::http::StatusCode;
use serde_json::json;

const COLUMNS: &[&str] = &[
    "select",
    "order",
    "limit",
    "offset",
    "on_conflict",
    "or",
    "and",
    "not.or",
    "not.and",
    "field.with.dot",
    "field,comma",
    "quote\"name",
    "rótulo",
];
const VALUE: &str = "a, \"quoted\" \\ value (Ω)";

async fn fixture() -> TestApp {
    let app = TestApp::spawn().await;
    let columns = COLUMNS
        .iter()
        .map(|name| nelcota_api::query::ident(name))
        .collect::<Vec<_>>();
    app.admin_client
        .batch_execute(&format!(
            "CREATE TABLE public.structured_columns(id integer PRIMARY KEY, {}); \
         ALTER TABLE public.structured_columns ENABLE ROW LEVEL SECURITY; \
         GRANT SELECT ON public.structured_columns TO anon; \
         CREATE POLICY first_row ON public.structured_columns FOR SELECT TO anon USING (id = 1); \
         CREATE TABLE public.punctuated_key(\"id.key\" integer PRIMARY KEY); \
         INSERT INTO public.punctuated_key VALUES(2),(1)",
            columns
                .iter()
                .map(|name| format!("{name} text"))
                .collect::<Vec<_>>()
                .join(", "),
        ))
        .await
        .unwrap();
    let values = vec!["$1"; COLUMNS.len()].join(", ");
    for (id, value) in [(1, VALUE), (2, "z-other")] {
        app.admin_client
            .execute(
                &format!("INSERT INTO public.structured_columns VALUES ({id}, {values})"),
                &[&value],
            )
            .await
            .unwrap();
    }
    app
}

#[tokio::test]
async fn structured_filters_keep_reserved_and_punctuated_column_names_literal() {
    let app = fixture().await;
    let cookie = login(&app).await;
    let mut failures = Vec::new();
    for column in COLUMNS {
        let filters = json!([{ "column": column, "op": "eq", "value": VALUE }]).to_string();
        let params: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("filters", &filters)
            .finish();
        for suffix in ["&size=1&page=0", "&view_as=anon", "&format=json"] {
            let resource = match suffix {
                "&format=json" => "structured_columns/export",
                _ => "structured_columns",
            };
            let reply = get(
                &app,
                &format!("/admin/api/tables/{resource}?{params}{suffix}"),
                &cookie,
            )
            .await;
            if reply.status != StatusCode::OK {
                failures.push(format!("{column}{suffix}: {}", reply.status));
                continue;
            }
            let rows = match resource.ends_with("/export") {
                true => &reply.body,
                false => &reply.body["rows"],
            };
            assert_eq!(rows.as_array().unwrap().len(), 1, "{column}{suffix}");
            let id = match resource.ends_with("/export") {
                true => json!(1),
                false => json!("1"),
            };
            assert_eq!(rows[0]["id"], id, "{column}{suffix}");
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn structured_order_keeps_column_names_and_default_primary_keys_literal() {
    let app = fixture().await;
    let cookie = login(&app).await;
    let mut failures = Vec::new();
    for column in COLUMNS {
        let params = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("sort", column)
            .append_pair("desc", "true")
            .finish();
        let reply = get(
            &app,
            &format!("/admin/api/tables/structured_columns?{params}"),
            &cookie,
        )
        .await;
        if reply.status != StatusCode::OK {
            failures.push(format!("{column}: {}", reply.status));
            continue;
        }
        assert_eq!(reply.body["rows"][0]["id"], "2", "{column}");
    }
    let reply = get(&app, "/admin/api/tables/punctuated_key", &cookie).await;
    if reply.status != StatusCode::OK {
        failures.push(format!("primary key: {}", reply.status));
    }
    if reply.status == StatusCode::OK {
        assert_eq!(reply.body["rows"][0]["id.key"], "1");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
