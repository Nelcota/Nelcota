//! Panel tables integration scenarios.
use crate::common::panel::{get, login, send};
use crate::common::*;
use axum::http::{Method, StatusCode, header};
use serde_json::{Value, json};

#[tokio::test]
async fn edit_tables_from_the_panel_with_exact_values() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;

    let data = get(&app, "/admin/api/tables/products", &cookie).await.body;
    assert_eq!(data["table"]["primary_key"], json!(["id"]));
    assert_eq!(data["table"]["editable"], true);
    let price = data["table"]["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "price")
        .unwrap()
        .clone();
    assert_eq!(price["full_type"], "numeric(10,2)");
    assert!(
        data["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "Notebook")
    );
    // numeric arrives as exact text (never through f64).
    assert!(
        data["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["price"] == "15.00")
    );
    assert_eq!(data["total"], 4);

    // Sort by column (validated against the catalog).
    let sorted = get(
        &app,
        "/admin/api/tables/products?sort=price&desc=true",
        &cookie,
    )
    .await
    .body;
    assert_eq!(sorted["rows"][0]["name"], "Backpack");
    let bad = get(&app, "/admin/api/tables/products?sort=price;drop", &cookie).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);

    // Insert: HTML-looking text is stored as text (escaping is Svelte's job,
    // which never uses {@html}); an omitted field uses the DEFAULT.
    let xss = "<script>alert(1)</script>";
    let reply = send(
        &app,
        Method::POST,
        "/admin/api/tables/products/rows",
        &cookie,
        json!({ "values": { "name": xss, "price": "9.90" } }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let row = app
        .admin_client
        .query_one(
            "SELECT id, stock, price::text FROM public.products WHERE name = $1",
            &[&xss],
        )
        .await
        .unwrap();
    let id: i32 = row.get(0);
    assert_eq!(row.get::<_, i32>(1), 0, "an omitted field uses the DEFAULT");
    assert_eq!(row.get::<_, String>(2), "9.90");

    let reply = send(
        &app,
        Method::PATCH,
        "/admin/api/tables/products/rows",
        &cookie,
        json!({ "pk": { "id": id.to_string() }, "values": { "name": "Pencil case", "stock": "5" } }),
    )
    .await;
    assert_eq!(reply.body["count"], 1, "{}", reply.text);

    // A database error comes back as a 400 with its message (and no code:
    // the panel shows Postgres' text as-is).
    let reply = send(
        &app,
        Method::PATCH,
        "/admin/api/tables/products/rows",
        &cookie,
        json!({ "pk": { "id": id.to_string() }, "values": { "price": "-1" } }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(reply.body["error"].as_str().unwrap().contains("check"));
    assert!(reply.body.get("code").is_none(), "{}", reply.text);

    // An unknown or generated column is refused.
    for values in [
        json!({ "\"; drop table products; --": "1" }),
        json!({ "slug": "x" }),
    ] {
        let reply = send(
            &app,
            Method::POST,
            "/admin/api/tables/products/rows",
            &cookie,
            json!({ "values": values }),
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }
    let reply = send(
        &app,
        Method::POST,
        "/admin/api/tables/products/rows",
        &cookie,
        json!({ "values": { "slug": "x" } }),
    )
    .await;
    assert_eq!(reply.body["code"], "unknown_or_generated_column");
    assert_eq!(reply.body["params"], json!({ "column": "slug" }));

    // Delete several rows in one transaction.
    let reply = send(
        &app,
        Method::DELETE,
        "/admin/api/tables/products/rows",
        &cookie,
        json!({ "pks": [{ "id": id.to_string() }, { "id": "3" }] }),
    )
    .await;
    assert_eq!(reply.body["count"], 2, "{}", reply.text);
    let count: i64 = app
        .admin_client
        .query_one("SELECT count(*) FROM public.products", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 3);

    let reply = get(&app, "/admin/api/tables/missing", &cookie).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.body["code"], "table_not_found");
    assert_eq!(reply.body["params"], json!({ "table": "missing" }));
}

#[tokio::test]
async fn json_null_and_sql_null_stay_apart_in_the_table_editor() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.docs (id int PRIMARY KEY, body jsonb, raw json);
             INSERT INTO public.docs VALUES
                 (1, 'null', 'null'), (2, NULL, NULL), (3, '\"42\"', '{\"a\": 1}');",
        )
        .await
        .unwrap();
    app.catalog.reload(&app.pool).await.unwrap();
    let cookie = login(&app).await;

    let data = get(&app, "/admin/api/tables/docs", &cookie).await.body;
    let rows = data["rows"].as_array().unwrap();
    assert_eq!(rows[0], json!({ "id": "1", "body": "null", "raw": "null" }));
    assert_eq!(rows[1], json!({ "id": "2", "body": null, "raw": null }));
    assert_eq!(
        rows[2],
        json!({ "id": "3", "body": "\"42\"", "raw": "{\"a\": 1}" })
    );

    // Saving the text `null` writes a JSON null; a null value writes SQL NULL.
    let reply = send(
        &app,
        Method::PATCH,
        "/admin/api/tables/docs/rows",
        &cookie,
        json!({ "pk": { "id": "1" }, "values": { "body": null, "raw": "null" } }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let reply = send(
        &app,
        Method::PATCH,
        "/admin/api/tables/docs/rows",
        &cookie,
        json!({ "pk": { "id": "2" }, "values": { "body": "null" } }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let reply = send(
        &app,
        Method::POST,
        "/admin/api/tables/docs/rows",
        &cookie,
        json!({ "values": { "id": "4", "body": "null", "raw": null } }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);

    let stored: Vec<(i32, Option<String>, Option<String>)> = app
        .admin_client
        .query(
            "SELECT id, body::text, raw::text FROM public.docs ORDER BY id",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    let null = || Some("null".to_owned());
    assert_eq!(
        stored,
        [
            (1, None, null()),
            (2, null(), None),
            (3, Some("\"42\"".into()), Some("{\"a\": 1}".into())),
            (4, null(), None),
        ]
    );
}

/// Percent-encoding to put JSON in the query string.
fn enc(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn names(data: &Value) -> Vec<String> {
    data["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn grid_filters_validated_by_the_catalog() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let table = |filters: Value| {
        format!(
            "/admin/api/tables/products?sort=id&filters={}",
            enc(&filters.to_string())
        )
    };

    let expensive = get(
        &app,
        &table(json!([{ "column": "price", "op": "gte", "value": "10" }])),
        &cookie,
    )
    .await;
    assert_eq!(expensive.status, StatusCode::OK, "{}", expensive.text);
    assert_eq!(names(&expensive.body), ["Notebook", "Backpack"]);
    // The total follows the filter (and is exact).
    assert_eq!(expensive.body["total"], 2);
    assert_eq!(expensive.body["total_exact"], true);

    let contains = get(
        &app,
        &table(json!([{ "column": "name", "op": "ilike", "value": "*N*" }])),
        &cookie,
    )
    .await
    .body;
    assert_eq!(names(&contains), ["Pen", "Notebook"]);

    let negated = get(
        &app,
        &table(json!([
            { "column": "stock", "op": "eq", "value": "0", "not": true },
            { "column": "price", "op": "lt", "value": "10" },
        ])),
        &cookie,
    )
    .await
    .body;
    assert_eq!(names(&negated), ["Pen", "Ruler, 30cm"]);

    // A value of the wrong type: 400 with Postgres' message, not a 500.
    let wrong_type = get(
        &app,
        &table(json!([{ "column": "price", "op": "eq", "value": "abc" }])),
        &cookie,
    )
    .await;
    assert_eq!(
        wrong_type.status,
        StatusCode::BAD_REQUEST,
        "{}",
        wrong_type.text
    );
    assert!(wrong_type.text.contains("numeric"), "{}", wrong_type.text);

    // A column outside the catalog and an operator outside the list: refused before the database.
    for filters in [
        json!([{ "column": "missing", "op": "eq", "value": "1" }]),
        json!([{ "column": "id", "op": "in", "value": "(1,2)" }]),
    ] {
        let reply = get(&app, &table(filters), &cookie).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text);
    }
    let garbage = get(&app, "/admin/api/tables/products?filters=not-json", &cookie).await;
    assert_eq!(garbage.status, StatusCode::BAD_REQUEST);
    assert_eq!(garbage.body["code"], "invalid_filters");
}

#[tokio::test]
async fn export_a_table_as_csv_and_json() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;

    let csv = get(
        &app,
        "/admin/api/tables/products/export?format=csv&sort=id",
        &cookie,
    )
    .await;
    assert_eq!(csv.status, StatusCode::OK, "{}", csv.text);
    assert_eq!(csv.headers[header::CONTENT_TYPE], "text/csv; charset=utf-8");
    assert_eq!(
        csv.headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"products.csv\""
    );
    let lines: Vec<&str> = csv.text.split("\r\n").collect();
    assert_eq!(lines[0], "\u{feff}id,name,price,stock,created_at,slug");
    assert!(lines[1].starts_with("1,Pen,2.50,100,"), "{}", lines[1]);
    // A comma inside the value: quoted field.
    assert!(
        lines[4].starts_with("4,\"Ruler, 30cm\",4.00,"),
        "{}",
        lines[4]
    );
    assert_eq!(lines.len(), 6, "header + 4 rows + empty end");

    // Export follows the grid's filters.
    let filters = enc(&json!([{ "column": "stock", "op": "eq", "value": "0" }]).to_string());
    let filtered = get(
        &app,
        &format!("/admin/api/tables/products/export?format=json&filters={filters}"),
        &cookie,
    )
    .await;
    assert_eq!(filtered.headers[header::CONTENT_TYPE], "application/json");
    let rows: Value = serde_json::from_str(&filtered.text).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["name"], "Backpack");
    // numeric goes out with Postgres' text.
    assert!(filtered.text.contains("120.00"), "{}", filtered.text);

    let error = get(
        &app,
        &format!(
            "/admin/api/tables/products/export?format=csv&filters={}",
            enc(&json!([{ "column": "id", "op": "eq", "value": "x" }]).to_string())
        ),
        &cookie,
    )
    .await;
    assert_eq!(error.status, StatusCode::BAD_REQUEST, "{}", error.text);
    let format = get(
        &app,
        "/admin/api/tables/products/export?format=xls",
        &cookie,
    )
    .await;
    assert_eq!(format.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn columns_point_to_their_foreign_key() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    app.admin_client
        .batch_execute(
            "CREATE TABLE public.reviews (
                 id int PRIMARY KEY,
                 product_id int REFERENCES public.products (id),
                 rating int
             );
             GRANT SELECT ON public.reviews TO service_role;",
        )
        .await
        .unwrap();

    // The catalog reloads by itself after the DDL.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let data = loop {
        let reply = get(&app, "/admin/api/tables/reviews", &cookie).await;
        if reply.status == StatusCode::OK {
            break reply.body;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the new table did not show up"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    let column = |name: &str| {
        data["table"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(
        column("product_id")["references"],
        json!({ "table": "products", "column": "id" })
    );
    assert_eq!(column("rating")["references"], Value::Null);
}

#[tokio::test]
async fn table_structure_read_from_the_postgres_catalog() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;

    let reply = get(&app, "/admin/api/tables/products/structure", &cookie).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let data = reply.body;
    assert_eq!(data["primary_key"], json!(["id"]));
    assert_eq!(data["rls_enabled"], false);
    assert_eq!(data["comment"], "Product catalog");
    let column = |name: &str| {
        data["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(column("id")["identity"], "by default");
    assert_eq!(column("id")["primary_key"], true);
    assert_eq!(column("name")["data_type"], "character varying(80)");
    assert_eq!(column("name")["nullable"], false);
    assert_eq!(column("stock")["default"], "0");
    assert_eq!(column("created_at")["default"], "now()");
    assert_eq!(column("slug")["generated"], true);
    assert_eq!(
        data["grants"],
        json!([
            { "role": "anon", "privileges": ["select"] },
            { "role": "authenticated", "privileges": ["select"] },
            { "role": "service_role", "privileges": ["select", "insert", "update", "delete"] },
        ])
    );

    app.admin_client
        .batch_execute(
            "CREATE TABLE public.items (
                 id int PRIMARY KEY,
                 product_id int REFERENCES public.products (id) ON DELETE CASCADE,
                 code text CONSTRAINT items_code_key UNIQUE
             );",
        )
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let items = loop {
        let reply = get(&app, "/admin/api/tables/items/structure", &cookie).await;
        if reply.status == StatusCode::OK {
            break reply.body;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the new table did not show up"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    let columns = items["columns"].as_array().unwrap();
    assert_eq!(
        columns[1]["references"],
        json!({ "table": "products", "column": "id", "on_delete": "cascade", "constraint": "items_product_id_fkey" })
    );
    assert_eq!(columns[2]["unique"], "items_code_key");

    let missing = get(&app, "/admin/api/tables/missing/structure", &cookie).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
}

fn columns_of(structure: &Value) -> Vec<String> {
    structure["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn create_alter_and_drop_tables_from_the_panel() {
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let notes = json!({
        "name": "notes",
        "comment": "The team's notes",
        "columns": [
            { "name": "id", "data_type": "bigint", "primary_key": true, "identity": true },
            { "name": "body", "data_type": "text", "nullable": false },
            { "name": "product_id", "data_type": "integer",
              "references": { "table": "products", "column": "id", "on_delete": "cascade" } },
            { "name": "created_at", "data_type": "timestamptz", "nullable": false, "default": "now()" },
        ],
        "grants": [{ "role": "anon", "privileges": ["select"] }],
    });

    // Preview: returns the SQL and creates nothing.
    let preview = send(
        &app,
        Method::POST,
        "/admin/api/tables",
        &cookie,
        json!({ "table": notes, "preview": true }),
    )
    .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.text);
    assert!(
        preview.body["sql"][0]
            .as_str()
            .unwrap()
            .starts_with("CREATE TABLE \"public\".\"notes\"")
    );
    assert_eq!(
        get(&app, "/admin/api/tables/notes", &cookie).await.status,
        StatusCode::NOT_FOUND
    );

    let created = send(
        &app,
        Method::POST,
        "/admin/api/tables",
        &cookie,
        json!({ "table": notes }),
    )
    .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text);
    // The catalog already reloaded: the table is in the panel and the REST API, no waiting.
    let structure = get(&app, "/admin/api/tables/notes/structure", &cookie)
        .await
        .body;
    assert_eq!(structure["rls_enabled"], true);
    assert_eq!(
        structure["grants"][0],
        json!({ "role": "anon", "privileges": ["select"] })
    );
    let rest = app
        .raw(Method::GET, "/rest/v1/notes", &[], String::new())
        .await;
    assert_eq!(rest.status, StatusCode::OK, "{}", rest.text);
    assert_eq!(
        rest.body,
        json!([]),
        "RLS on and no policies: anon sees nothing"
    );

    // Several changes in one transaction.
    let altered = send(&app, Method::PATCH, "/admin/api/tables/notes", &cookie, json!({ "actions": [
        { "action": "add_column", "column": { "name": "votes", "data_type": "integer", "default": "0", "nullable": false } },
        { "action": "rename_column", "from": "body", "to": "content" },
        { "action": "set_type", "column": "content", "data_type": "varchar(500)" },
        { "action": "set_unique", "column": "content", "unique": true },
        { "action": "set_grants", "grant": { "role": "authenticated", "privileges": ["select", "insert"] } },
    ] })).await;
    assert_eq!(altered.status, StatusCode::OK, "{}", altered.text);
    let structure = get(&app, "/admin/api/tables/notes/structure", &cookie)
        .await
        .body;
    assert_eq!(
        columns_of(&structure),
        ["id", "content", "product_id", "created_at", "votes"]
    );
    let content = &structure["columns"][1];
    assert_eq!(content["data_type"], "character varying(500)");
    assert!(content["unique"].is_string());
    assert_eq!(
        structure["grants"][1]["privileges"],
        json!(["select", "insert"])
    );

    // Atomicity: the second action fails (impossible cast) and the first one is not kept.
    let failed = send(
        &app,
        Method::PATCH,
        "/admin/api/tables/notes",
        &cookie,
        json!({ "actions": [
        { "action": "add_column", "column": { "name": "draft", "data_type": "boolean" } },
        { "action": "set_type", "column": "created_at", "data_type": "integer" },
    ] }),
    )
    .await;
    assert_eq!(failed.status, StatusCode::BAD_REQUEST, "{}", failed.text);
    let structure = get(&app, "/admin/api/tables/notes/structure", &cookie)
        .await
        .body;
    assert!(!columns_of(&structure).contains(&"draft".to_owned()));

    // An expression with a second statement: the extended protocol refuses it.
    let injection = send(
        &app,
        Method::PATCH,
        "/admin/api/tables/notes",
        &cookie,
        json!({ "actions": [
        { "action": "add_column", "column": { "name": "x", "data_type": "text",
          "default": "'a'); DROP TABLE public.products; --" } },
    ] }),
    )
    .await;
    assert_eq!(
        injection.status,
        StatusCode::BAD_REQUEST,
        "{}",
        injection.text
    );
    assert_eq!(
        get(&app, "/admin/api/tables/products", &cookie)
            .await
            .status,
        StatusCode::OK
    );

    // Validation before the database.
    let bad_type = send(
        &app,
        Method::POST,
        "/admin/api/tables",
        &cookie,
        json!({ "table": {
        "name": "t", "columns": [{ "name": "a", "data_type": "money" }] } }),
    )
    .await;
    assert_eq!(bad_type.status, StatusCode::BAD_REQUEST);
    assert!(bad_type.text.contains("unknown type"), "{}", bad_type.text);
    assert_eq!(bad_type.body["code"], "unknown_type");
    assert_eq!(bad_type.body["params"], json!({ "type": "money" }));

    // products is referenced by notes: without CASCADE Postgres refuses.
    let blocked = app
        .raw(
            Method::DELETE,
            "/admin/api/tables/products",
            &[("cookie", cookie.as_str())],
            String::new(),
        )
        .await;
    assert_eq!(blocked.status, StatusCode::BAD_REQUEST, "{}", blocked.text);
    let dropped = app
        .raw(
            Method::DELETE,
            "/admin/api/tables/notes",
            &[("cookie", cookie.as_str())],
            String::new(),
        )
        .await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.text);
    assert_eq!(
        get(&app, "/admin/api/tables/notes", &cookie).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.raw(Method::GET, "/rest/v1/notes", &[], String::new())
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    let types = get(&app, "/admin/api/types", &cookie).await.body;
    assert!(
        types["base"]
            .as_array()
            .unwrap()
            .contains(&json!("timestamptz"))
    );
    assert_eq!(types["enums"], json!(["priority"]));
}
