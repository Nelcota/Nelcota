//! OpenAPI 3.0 document generated from the catalog, filtered by the request
//! role's privileges (each role only sees what it can use): tables and
//! columns it holds a table or column GRANT on, and the functions it may run.

use nelcota_core::Role;
use serde_json::{Map, Value, json};

use crate::catalog::{Catalog, Column, Privileges, Table, TableKind};

/// JSON Schema of a Postgres type, by its formatted name.
pub fn json_schema(type_name: &str, enum_values: &[String]) -> Value {
    if let Some(element) = type_name.strip_suffix("[]") {
        let mut items = json_schema(element, enum_values);
        items["nullable"] = json!(true);
        return json!({ "type": "array", "items": items });
    }
    if !enum_values.is_empty() {
        return json!({ "type": "string", "enum": enum_values });
    }
    match type_name {
        "smallint" | "integer" | "bigint" | "oid" => json!({ "type": "integer" }),
        "real" | "double precision" | "numeric" => json!({ "type": "number" }),
        "boolean" => json!({ "type": "boolean" }),
        "json" | "jsonb" => json!({}),
        "uuid" => json!({ "type": "string", "format": "uuid" }),
        "date" => json!({ "type": "string", "format": "date" }),
        "timestamp with time zone" | "timestamp without time zone" => {
            json!({ "type": "string", "format": "date-time" })
        }
        _ => json!({ "type": "string" }),
    }
}

fn column_schema(column: &Column) -> Value {
    let mut schema = json_schema(&column.type_name, &column.enum_values);
    if let Value::Object(map) = &mut schema {
        let mut description = format!("Postgres type: {}", column.full_type);
        if let Some(comment) = &column.comment {
            description = format!("{comment}\n\n{description}");
        }
        map.insert("description".into(), Value::String(description));
        if column.nullable {
            map.insert("nullable".into(), Value::Bool(true));
        }
    }
    schema
}

/// The row of `table` as `columns` (those the role can use) describe it.
fn table_schema(table: &Table, columns: &[&Column]) -> Value {
    let properties: Map<String, Value> = columns
        .iter()
        .map(|c| (c.name.clone(), column_schema(c)))
        .collect();
    let required: Vec<&str> = columns
        .iter()
        .filter(|c| !c.nullable && !c.has_default)
        .map(|c| c.name.as_str())
        .collect();
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    if let Some(comment) = &table.comment {
        schema["description"] = json!(comment);
    }
    schema
}

/// The schema of a request body that writes `columns`: the row schema when the
/// role may write exactly the columns it reads, else an inline schema of only
/// the writable ones, so names and comments of unreadable columns stay out of
/// the response schema and those of unwritable columns out of the body.
fn body_schema(table: &Table, readable: &[&Column], writable: &[&Column], partial: bool) -> Value {
    let same = readable.len() == writable.len()
        && readable.iter().zip(writable).all(|(a, b)| a.name == b.name);
    if same {
        return reference(&table.name);
    }
    let mut schema = table_schema(table, writable);
    if partial && let Value::Object(map) = &mut schema {
        map.remove("required");
    }
    schema
}

fn reference(name: &str) -> Value {
    json!({ "$ref": format!("#/components/schemas/{name}") })
}

fn array_of(name: &str) -> Value {
    json!({ "type": "array", "items": reference(name) })
}

fn json_response(description: &str, schema: Value) -> Value {
    json!({ "description": description, "content": { "application/json": { "schema": schema } } })
}

pub fn document(catalog: &Catalog, role: Role) -> Value {
    let prefer = json!({
        "name": "Prefer", "in": "header", "schema": { "type": "string" },
        "description": "return=representation | return=minimal; count=exact; on POST, resolution=merge-duplicates | resolution=ignore-duplicates (upsert)",
    });
    let mut paths = Map::new();
    let mut schemas = Map::new();

    for table in catalog.tables.values() {
        // A column GRANT alone also makes the table usable (`select=col`).
        let columns: Vec<&Column> = table
            .columns
            .iter()
            .filter(|c| c.privileges_for(role).any())
            .collect();
        let mut privileges = table.privileges_for(role);
        for column in &columns {
            privileges = privileges.union(column.privileges_for(role));
        }
        if !privileges.any() {
            continue;
        }
        // Rows (responses) show only readable columns; request bodies only
        // the columns the role may insert or update.
        let with = |privilege: fn(Privileges) -> bool| -> Vec<&Column> {
            columns
                .iter()
                .copied()
                .filter(|c| privilege(c.privileges_for(role)))
                .collect()
        };
        let readable = with(|p| p.select);
        schemas.insert(table.name.clone(), table_schema(table, &readable));

        // Filtering on a column reads it.
        let filters: Vec<Value> = readable
            .iter()
            .map(|c| {
                json!({
                    "name": c.name, "in": "query", "required": false,
                    "schema": { "type": "string" },
                    "description": "Filter: eq, neq, gt, gte, lt, lte, like, ilike, in, is (e.g. eq.value, in.(a,b), not.is.null)",
                })
            })
            .chain(["or", "and"].map(|logic| {
                json!({
                    "name": logic, "in": "query", "required": false,
                    "schema": { "type": "string" },
                    "description": format!(
                        "Group of filters joined with {}: ({logic}=(col.op.value,...)); nests with and(...)/or(...), negate with not.{logic}",
                        logic.to_uppercase()
                    ),
                })
            }))
            .collect();
        let mut item = Map::new();
        if privileges.select {
            let mut parameters = vec![
                json!({ "name": "select", "in": "query", "schema": { "type": "string" }, "description": "Columns: `col1,col2` or `*`; embed related rows through foreign keys: `customers(name)`, `items(*)`, `alias:table!fk_column(...)`, nested: `orders(id,items(*))`; filter, order and page embedded rows with `items.qty=gt.1`, `items.order=qty.desc`, `items.limit=5`" }),
                json!({ "name": "order", "in": "query", "schema": { "type": "string" }, "description": "col.asc|desc[.nullsfirst|nullslast],..." }),
                json!({ "name": "limit", "in": "query", "schema": { "type": "integer", "minimum": 0 } }),
                json!({ "name": "offset", "in": "query", "schema": { "type": "integer", "minimum": 0 } }),
                prefer.clone(),
            ];
            parameters.extend(filters.iter().cloned());
            item.insert(
                "get".into(),
                json!({
                    "tags": [table.name], "parameters": parameters,
                    "responses": { "200": json_response("Visible rows (RLS)", array_of(&table.name)) },
                }),
            );
        }
        let writable = table.kind != TableKind::MaterializedView;
        if privileges.insert && writable {
            let body = body_schema(table, &readable, &with(|p| p.insert), false);
            item.insert(
                "post".into(),
                json!({
                    "tags": [table.name],
                    "parameters": [prefer, {
                        "name": "on_conflict", "in": "query", "required": false,
                        "schema": { "type": "string" },
                        "description": "Upsert key: col1,col2 (a unique constraint); defaults to the primary key. Needs Prefer: resolution=...",
                    }],
                    "requestBody": { "required": true, "content": { "application/json": { "schema": {
                        "oneOf": [body.clone(), json!({ "type": "array", "items": body })] } } } },
                    "responses": {
                        "201": json_response("Created (body only with return=representation)", array_of(&table.name)),
                    },
                }),
            );
        }
        if privileges.update && writable {
            let mut parameters = vec![prefer.clone()];
            parameters.extend(filters.iter().cloned());
            let body = body_schema(table, &readable, &with(|p| p.update), true);
            item.insert(
                "patch".into(),
                json!({
                    "tags": [table.name], "parameters": parameters,
                    "requestBody": { "required": true, "content": { "application/json": { "schema": body } } },
                    "responses": {
                        "200": json_response("Updated (return=representation)", array_of(&table.name)),
                        "204": { "description": "Updated" },
                    },
                }),
            );
        }
        if privileges.delete && writable {
            let mut parameters = vec![prefer.clone()];
            parameters.extend(filters.iter().cloned());
            item.insert(
                "delete".into(),
                json!({
                    "tags": [table.name], "parameters": parameters,
                    "responses": {
                        "200": json_response("Deleted (return=representation)", array_of(&table.name)),
                        "204": { "description": "Deleted" },
                    },
                }),
            );
        }
        paths.insert(format!("/{}", table.name), Value::Object(item));
    }

    for functions in catalog.functions.values() {
        for function in functions.iter().filter(|f| f.executable_by(role)) {
            let properties: Map<String, Value> = function
                .args
                .iter()
                .map(|a| (a.name.clone(), json_schema(&a.type_name, &[])))
                .collect();
            let required: Vec<&str> = function
                .args
                .iter()
                .filter(|a| !a.has_default)
                .map(|a| a.name.as_str())
                .collect();
            let returns = match function.returns_set {
                true => {
                    json!({ "type": "array", "items": json_schema(&function.return_type, &[]) })
                }
                false => json_schema(&function.return_type, &[]),
            };
            paths.insert(
                format!("/rpc/{}", function.name),
                json!({ "post": {
                    "tags": ["rpc"],
                    "description": function.comment,
                    "requestBody": { "content": { "application/json": { "schema": {
                        "type": "object", "properties": properties, "required": required } } } },
                    "responses": { "200": json_response("Result", returns) },
                } }),
            );
        }
    }

    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "Nelcota REST API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "API generated from the Postgres schema. Authorization: RLS. Requests without a token use `anon`. For a signed-in user or your backend, send `Authorization: Bearer <jwt>`.",
        },
        "servers": [{ "url": "/rest/v1" }],
        "paths": paths,
        "components": {
            "schemas": schemas,
            "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" } },
        },
        "security": match role { Role::Anon => json!([{}, { "bearer": [] }]), _ => json!([{ "bearer": [] }]) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_items_keep_enum_values_and_allow_null() {
        assert_eq!(
            json_schema("text[]", &[]),
            json!({"type":"array","items":{"type":"string","nullable":true}})
        );
        assert_eq!(
            json_schema("public.mood[]", &["happy".into()]),
            json!({"type":"array","items":{"type":"string","enum":["happy"],"nullable":true}})
        );
    }

    fn catalog() -> Catalog {
        let table = |name: &str, privileges| Table {
            name: name.into(),
            kind: TableKind::Table,
            columns: vec![],
            primary_key: vec![],
            foreign_keys: vec![],
            rls_enabled: true,
            rls_forced: false,
            security_invoker: false,
            comment: None,
            privileges,
        };
        let read = Privileges {
            select: true,
            ..Privileges::default()
        };
        Catalog {
            schema: "public".into(),
            tables: [
                ("public_notes".into(), table("public_notes", [read; 3])),
                (
                    "private_notes".into(),
                    table("private_notes", [Privileges::default(), read, read]),
                ),
            ]
            .into(),
            functions: Default::default(),
            named_types: Default::default(),
        }
    }

    #[test]
    fn documents_list_only_the_columns_a_role_can_use() {
        let read = Privileges {
            select: true,
            ..Privileges::default()
        };
        let none = Privileges::default();
        let column = |name: &str, privileges| Column {
            name: name.into(),
            type_name: "text".into(),
            full_type: "text".into(),
            category: 'S',
            element_type: None,
            enum_values: vec![],
            nullable: false,
            has_default: false,
            generated: false,
            comment: Some(format!("about {name}")),
            privileges,
        };
        let mut catalog = catalog();
        catalog.tables.insert(
            "staff".into(),
            Table {
                name: "staff".into(),
                kind: TableKind::Table,
                // Column GRANTs only: no table privilege for anyone.
                columns: vec![
                    column("name", [read; 3]),
                    column("salary", [none, none, read]),
                ],
                primary_key: vec![],
                foreign_keys: vec![],
                rls_enabled: true,
                rls_forced: false,
                security_invoker: false,
                comment: None,
                privileges: [none; 3],
            },
        );
        let doc = document(&catalog, Role::Anon);
        let staff = &doc["components"]["schemas"]["staff"];
        assert!(staff["properties"].get("name").is_some(), "{staff}");
        assert!(staff["properties"].get("salary").is_none(), "{staff}");
        assert_eq!(staff["required"], json!(["name"]));
        assert!(!doc.to_string().contains("about salary"));
        let path = &doc["paths"]["/staff"];
        assert!(path.get("post").is_none() && path.get("delete").is_none());
        let names: Vec<&str> = path["get"]["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["name"].as_str())
            .collect();
        assert!(names.contains(&"name"), "{names:?}");
        assert!(!names.contains(&"salary"), "{names:?}");
        let doc = document(&catalog, Role::ServiceRole);
        let staff = &doc["components"]["schemas"]["staff"];
        assert!(staff["properties"].get("salary").is_some(), "{staff}");
    }

    #[test]
    fn write_only_columns_appear_only_in_their_request_bodies() {
        let all = Privileges {
            select: true,
            insert: true,
            update: true,
            delete: true,
        };
        let only = |insert, update| Privileges {
            insert,
            update,
            ..Privileges::default()
        };
        let column = |name: &str, privileges: Privileges| Column {
            name: name.into(),
            type_name: "text".into(),
            full_type: "text".into(),
            category: 'S',
            element_type: None,
            enum_values: vec![],
            nullable: false,
            has_default: false,
            generated: false,
            comment: Some(format!("about {name}")),
            privileges: [privileges; 3],
        };
        let table = |name: &str, columns| Table {
            name: name.into(),
            kind: TableKind::Table,
            columns,
            primary_key: vec![],
            foreign_keys: vec![],
            rls_enabled: true,
            rls_forced: false,
            security_invoker: false,
            comment: None,
            privileges: [Privileges::default(); 3],
        };
        let mut catalog = catalog();
        catalog.tables.insert(
            "votes".into(),
            table(
                "votes",
                vec![
                    column("id", all),
                    column("ballot", only(true, false)),
                    column("note", only(false, true)),
                ],
            ),
        );
        catalog.tables.insert(
            "polls".into(),
            table("polls", vec![column("id", all), column("title", all)]),
        );
        let doc = document(&catalog, Role::Authenticated);
        let row = &doc["components"]["schemas"]["votes"];
        assert_eq!(row["properties"].as_object().unwrap().len(), 1, "{row}");
        assert!(row["properties"].get("id").is_some(), "{row}");
        let path = &doc["paths"]["/votes"];
        let content =
            |verb: &str| path[verb]["requestBody"]["content"]["application/json"]["schema"].clone();
        let insert = content("post")["oneOf"][0].clone();
        let mut names: Vec<&String> = insert["properties"].as_object().unwrap().keys().collect();
        names.sort();
        assert_eq!(names, ["ballot", "id"], "{insert}");
        assert_eq!(insert["required"], json!(["id", "ballot"]));
        assert_eq!(content("post")["oneOf"][1]["items"], insert);
        let update = content("patch");
        let mut names: Vec<&String> = update["properties"].as_object().unwrap().keys().collect();
        names.sort();
        assert_eq!(names, ["id", "note"], "{update}");
        // A partial update requires no column.
        assert!(update.get("required").is_none(), "{update}");
        let response = &path["get"]["responses"]["200"]["content"]["application/json"]["schema"];
        assert_eq!(response, &array_of("votes"));
        let parameters = path["get"]["parameters"].to_string();
        assert!(!parameters.contains("ballot") && !parameters.contains("\"note\""));
        // Full privileges keep the shared row reference.
        let path = &doc["paths"]["/polls"];
        let body = &path["post"]["requestBody"]["content"]["application/json"]["schema"];
        assert_eq!(
            body,
            &json!({ "oneOf": [reference("polls"), array_of("polls")] })
        );
        let body = &path["patch"]["requestBody"]["content"]["application/json"]["schema"];
        assert_eq!(body, &reference("polls"));
    }

    #[test]
    fn anonymous_document_allows_tokenless_calls_without_exposing_private_tables() {
        let doc = document(&catalog(), Role::Anon);
        assert_eq!(doc["security"], json!([{}, { "bearer": [] }]));
        assert!(doc["paths"].get("/public_notes").is_some());
        assert!(doc["paths"].get("/private_notes").is_none());
        assert!(doc["components"]["schemas"].get("private_notes").is_none());
    }

    #[test]
    fn authenticated_and_service_documents_require_their_bearer_token() {
        for role in [Role::Authenticated, Role::ServiceRole] {
            let doc = document(&catalog(), role);
            assert_eq!(doc["security"], json!([{ "bearer": [] }]));
            assert!(doc["paths"].get("/private_notes").is_some());
        }
    }

    #[test]
    fn generated_markdown_preserves_jwt_placeholders_and_select_wildcards() {
        let doc = document(&catalog(), Role::Anon);
        assert!(
            doc["info"]["description"]
                .as_str()
                .unwrap()
                .contains("`Authorization: Bearer <jwt>`")
        );
        let select = &doc["paths"]["/public_notes"]["get"]["parameters"][0];
        let description = select["description"].as_str().unwrap();
        assert!(description.contains("`*`"));
        assert!(description.contains("`items(*)`"));
        assert!(description.contains("`orders(id,items(*))`"));
    }
}
