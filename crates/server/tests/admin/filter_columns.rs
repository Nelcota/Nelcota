//! Structured panel filters/order must not be interpreted as URL modifiers.
use crate::common::TestApp;
use crate::common::panel::{get, login, send};
use axum::http::{Method, StatusCode};
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

async fn reserved_primary_key_write(method: Method) {
    let app = TestApp::spawn().await;
    app.admin_client.batch_execute(
        "CREATE TABLE public.reserved_key(on_conflict integer PRIMARY KEY, \"eq.1\" text, note text);
         INSERT INTO public.reserved_key VALUES (1, 'first', 'original'), (2, 'second', 'original');"
    ).await.unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let cookie = login(&app).await;
    let body = if method == Method::PATCH {
        json!({"pk": {"on_conflict": "1"}, "values": {"note": "changed"}})
    } else {
        json!({"pks": [{"on_conflict": "1"}]})
    };
    let reply = send(
        &app,
        method.clone(),
        "/admin/api/tables/reserved_key/rows",
        &cookie,
        body,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(
        reply.body["count"], 1,
        "a primary-key write must target exactly the selected row"
    );
    let rows = app
        .admin_client
        .query(
            "SELECT on_conflict, note FROM public.reserved_key ORDER BY on_conflict",
            &[],
        )
        .await
        .unwrap();
    let retained = rows
        .iter()
        .map(|row| (row.get::<_, i32>(0), row.get::<_, String>(1)))
        .collect::<Vec<_>>();
    let expected = if method == Method::PATCH {
        vec![(1, "changed".to_owned()), (2, "original".to_owned())]
    } else {
        vec![(2, "original".to_owned())]
    };
    assert_eq!(retained, expected);
}

#[tokio::test]
async fn reserved_primary_key_update_cannot_change_other_rows() {
    reserved_primary_key_write(Method::PATCH).await;
}

#[tokio::test]
async fn reserved_primary_key_delete_cannot_remove_other_rows() {
    reserved_primary_key_write(Method::DELETE).await;
}

#[tokio::test]
async fn primary_key_writes_keep_all_reserved_and_punctuated_names_literal() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    for column in COLUMNS {
        let name = nelcota_api::query::ident(column);
        app.admin_client
            .batch_execute(&format!(
                "DROP TABLE IF EXISTS public.literal_key;
             CREATE TABLE public.literal_key({name} text PRIMARY KEY, note text);"
            ))
            .await
            .unwrap();
        app.admin_client
            .execute(
                "INSERT INTO public.literal_key VALUES ($1, 'first'), ($2, 'second')",
                &[&VALUE, &"other"],
            )
            .await
            .unwrap();
        app.catalog.reload(&app.pool).await.unwrap();
        let pk = json!({*column: VALUE});
        for method in [Method::PATCH, Method::DELETE] {
            let body = if method == Method::PATCH {
                json!({"pk": pk, "values": {"note": "changed"}})
            } else {
                json!({"pks": [pk]})
            };
            let reply = send(
                &app,
                method.clone(),
                "/admin/api/tables/literal_key/rows",
                &cookie,
                body,
            )
            .await;
            assert_eq!(
                reply.status,
                StatusCode::OK,
                "{column} {method}: {}",
                reply.text
            );
            assert_eq!(reply.body["count"], 1, "{column} {method}");
        }
        let remaining = app
            .admin_client
            .query("SELECT note FROM public.literal_key", &[])
            .await
            .unwrap();
        assert_eq!(remaining.len(), 1, "{column}");
        assert_eq!(remaining[0].get::<_, String>(0), "second", "{column}");
    }
}
