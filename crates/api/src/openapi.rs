//! OpenAPI 3.0 document generated from the catalog, filtered by the request
//! role's privileges (each role only sees what it can use).

use nelcota_core::Role;
use serde_json::{Map, Value, json};

use crate::catalog::{Catalog, Column, Table, TableKind};

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

fn table_schema(table: &Table) -> Value {
    let properties: Map<String, Value> = table
        .columns
        .iter()
        .map(|c| (c.name.clone(), column_schema(c)))
        .collect();
    let required: Vec<&str> = table
        .columns
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
        let privileges = table.privileges_for(role);
        if !(privileges.select || privileges.insert || privileges.update || privileges.delete) {
            continue;
        }
        schemas.insert(table.name.clone(), table_schema(table));

        let filters: Vec<Value> = table
            .columns
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
                        "oneOf": [reference(&table.name), array_of(&table.name)] } } } },
                    "responses": {
                        "201": json_response("Created (body only with return=representation)", array_of(&table.name)),
                    },
                }),
            );
        }
        if privileges.update && writable {
            let mut parameters = vec![prefer.clone()];
            parameters.extend(filters.iter().cloned());
            item.insert(
                "patch".into(),
                json!({
                    "tags": [table.name], "parameters": parameters,
                    "requestBody": { "required": true, "content": { "application/json": { "schema": reference(&table.name) } } },
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
    use crate::catalog::Privileges;

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
