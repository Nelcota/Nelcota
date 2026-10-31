//! JSON `null` stored in json/jsonb columns, kept apart from SQL NULL.
//!
//! `to_json` renders both as `null`, and `json_populate_record` turns a JSON
//! `null` into SQL NULL. The table editor reads and writes through the REST
//! query compiler, so these helpers adjust its statements: reads add an
//! `IS NULL` flag per json column, writes assign `'null'` explicitly.
use crate::ApiError;
use nelcota_api::{
    catalog::{Column, Table},
    query::{self, ident},
};
use serde_json::{Map, Value};

/// Start of `query::select`: each page row becomes `to_json(_r)`.
const ROW_JSON: &str = "SELECT coalesce(json_agg(extensions.nelcota_check_json(to_json(_r)";

/// Makes each row of `query::select` `[row, [json columns IS NULL…]]`.
pub(super) fn flag_sql_nulls(
    sql: &mut query::Sql,
    json_columns: &[&Column],
) -> Result<(), ApiError> {
    if json_columns.is_empty() {
        return Ok(());
    }
    if !sql.text.starts_with(ROW_JSON) {
        return Err(ApiError::from(
            "table rows: unexpected query shape for json columns".to_owned(),
        ));
    }
    let flags = json_columns
        .iter()
        .map(|c| format!("_r.{} IS NULL", ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let flagged = format!(
        "SELECT coalesce(json_agg(extensions.nelcota_check_json(json_build_array(to_json(_r), json_build_array({flags}))"
    );
    sql.text.replace_range(..ROW_JSON.len(), &flagged);
    Ok(())
}

/// Assigns JSON `null` to `columns` in a `query::update` statement.
pub(super) fn update_json_nulls(
    sql: &mut query::Sql,
    table: &Table,
    values: &Map<String, Value>,
    columns: &[String],
) -> Result<(), ApiError> {
    // Same assignment list, in the same key order, as `query::update`.
    let assignments = |null: bool| {
        values
            .keys()
            .map(|key| {
                let name = ident(key);
                match columns.contains(key) {
                    true if null => format!("{name} = {}", json_null(table, key)),
                    _ => format!("{name} = _b.{name}"),
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    rewrite(
        sql,
        &format!(" SET {} FROM json_populate_record(", assignments(false)),
        &format!(" SET {} FROM json_populate_record(", assignments(true)),
        columns,
    )
}

/// Inserts JSON `null` into `columns` in a single-row `query::insert`.
pub(super) fn insert_json_nulls(
    sql: &mut query::Sql,
    table: &Table,
    values: &Map<String, Value>,
    columns: &[String],
) -> Result<(), ApiError> {
    // `query::insert` lists a row's columns in table order.
    let present: Vec<&Column> = table
        .columns
        .iter()
        .filter(|c| values.contains_key(&c.name))
        .collect();
    let list = |null: bool| {
        present
            .iter()
            .map(|c| match columns.contains(&c.name) {
                true if null => json_null(table, &c.name),
                _ => ident(&c.name),
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let names = list(false);
    rewrite(
        sql,
        &format!("({names}) SELECT {names} FROM json_populate_recordset("),
        &format!(
            "({names}) SELECT {} FROM json_populate_recordset(",
            list(true)
        ),
        columns,
    )
}

/// `'null'::json` or `'null'::jsonb`, the column's type.
fn json_null(table: &Table, name: &str) -> String {
    match table.column(name).map(|c| c.type_name.as_str()) {
        Some("json") => "'null'::json".to_owned(),
        _ => "'null'::jsonb".to_owned(),
    }
}

fn rewrite(sql: &mut query::Sql, from: &str, to: &str, columns: &[String]) -> Result<(), ApiError> {
    if columns.is_empty() {
        return Ok(());
    }
    if sql.text.matches(from).count() != 1 {
        return Err(ApiError::from(
            "row write: unexpected statement shape for JSON null".to_owned(),
        ));
    }
    sql.text = sql.text.replacen(from, to, 1);
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use nelcota_api::catalog::TableKind;
    use serde_json::json;

    pub(crate) fn column(name: &str, type_name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: type_name.into(),
            full_type: type_name.into(),
            category: 'U',
            element_type: None,
            enum_values: Vec::new(),
            nullable: true,
            has_default: false,
            generated: false,
            comment: None,
            privileges: Default::default(),
        }
    }

    pub(crate) fn table() -> Table {
        Table {
            name: "docs".into(),
            kind: TableKind::Table,
            columns: vec![
                column("id", "integer"),
                column("body", "jsonb"),
                column("raw", "json"),
            ],
            primary_key: vec!["id".into()],
            foreign_keys: Vec::new(),
            rls_enabled: false,
            rls_forced: false,
            security_invoker: false,
            comment: None,
            privileges: Default::default(),
        }
    }

    fn values() -> Map<String, Value> {
        json!({ "id": "1", "body": null, "raw": null })
            .as_object()
            .cloned()
            .unwrap()
    }

    #[test]
    fn page_rows_carry_the_sql_null_flags_of_json_columns() {
        let table = table();
        let request = query::parse_request(&[], &table).unwrap();
        let mut sql = query::select("public", &table, &request, None);
        let json_columns: Vec<&Column> = table.columns[1..].iter().collect();
        flag_sql_nulls(&mut sql, &json_columns).unwrap();
        assert!(
            sql.text.contains(
                "json_build_array(to_json(_r), json_build_array(_r.\"body\" IS NULL, _r.\"raw\" IS NULL))"
            ),
            "{}",
            sql.text
        );
    }

    #[test]
    fn writes_assign_json_null_only_to_the_requested_columns() {
        let table = table();
        let filters = vec![query::column_filter(&table, "id", "eq.1").unwrap()];
        let nulls = vec!["body".to_owned()];
        let mut update =
            query::update("public", &table, Value::Object(values()), &filters, None).unwrap();
        update_json_nulls(&mut update, &table, &values(), &nulls).unwrap();
        assert!(
            update.text.contains(
                "SET \"body\" = 'null'::jsonb, \"id\" = _b.\"id\", \"raw\" = _b.\"raw\" FROM"
            ),
            "{}",
            update.text
        );

        let nulls = vec!["raw".to_owned()];
        let mut insert =
            query::insert("public", &table, Value::Object(values()), None, None).unwrap();
        insert_json_nulls(&mut insert, &table, &values(), &nulls).unwrap();
        assert!(
            insert.text.contains(
                "(\"id\", \"body\", \"raw\") SELECT \"id\", \"body\", 'null'::json FROM json_populate_recordset("
            ),
            "{}",
            insert.text
        );
    }
}
