//! Validate and plan CREATE TABLE statements without executing them.
use super::{
    ColumnDef, Context, CreateTable,
    column::{column_sql, comment_on_column},
};
use crate::ddl::{Result, grant, invalid, literal, qualified, validate_name};
use nelcota_api::query::ident;
use serde_json::{Value, json};

pub fn create(ctx: &Context, spec: &CreateTable) -> Result<Vec<String>> {
    validate_name("table", &spec.name)?;
    if spec.columns.is_empty() {
        return invalid(
            "table_needs_columns",
            "the table needs at least one column",
            Value::Null,
        );
    }
    for (i, col) in spec.columns.iter().enumerate() {
        if spec.columns[..i].iter().any(|c| c.name == col.name) {
            return invalid(
                "duplicate_column",
                format!("column '{}' repeated", col.name),
                json!({ "column": col.name }),
            );
        }
    }
    let table = qualified(ctx.schema, &spec.name);
    let pk: Vec<&ColumnDef> = spec.columns.iter().filter(|c| c.primary_key).collect();
    let mut parts = spec
        .columns
        .iter()
        .map(|c| column_sql(ctx, c, c.primary_key && pk.len() == 1))
        .collect::<Result<Vec<_>>>()?;
    if pk.len() > 1 {
        let cols: Vec<String> = pk.iter().map(|c| ident(&c.name)).collect();
        parts.push(format!("PRIMARY KEY ({})", cols.join(", ")));
    }

    let mut statements = vec![format!(
        "CREATE TABLE {table} (\n  {}\n)",
        parts.join(",\n  ")
    )];
    if spec.rls {
        statements.push(format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"));
    }
    if let Some(comment) = spec.comment.as_deref().filter(|c| !c.trim().is_empty()) {
        statements.push(format!("COMMENT ON TABLE {table} IS {}", literal(comment)));
    }
    for col in &spec.columns {
        if let Some(comment) = col.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            statements.push(comment_on_column(&table, &col.name, Some(comment)));
        }
    }
    statements.extend(spec.grants.iter().filter_map(|g| grant(&table, g)));
    Ok(statements)
}
