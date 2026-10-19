//! Column SQL rendering shared by create and alter planning.
use super::{ColumnDef, Context, OnDelete, ReferenceDef};
use crate::ddl::{DataType, Result, expression, invalid, literal, qualified, validate_name};
use nelcota_api::query::ident;
use serde_json::json;

impl OnDelete {
    fn as_sql(self) -> &'static str {
        match self {
            OnDelete::NoAction => "NO ACTION",
            OnDelete::Restrict => "RESTRICT",
            OnDelete::Cascade => "CASCADE",
            OnDelete::SetNull => "SET NULL",
            OnDelete::SetDefault => "SET DEFAULT",
        }
    }
}

pub(super) fn references_sql(schema: &str, def: &ReferenceDef) -> Result<String> {
    validate_name("referenced table", &def.table)?;
    validate_name("referenced column", &def.column)?;
    Ok(format!(
        "REFERENCES {} ({}) ON DELETE {}",
        qualified(schema, &def.table),
        ident(&def.column),
        def.on_delete.as_sql()
    ))
}

/// The column definition inside `CREATE TABLE`/`ADD COLUMN`.
/// `inline_pk`: the PK is this column alone (otherwise it is a table constraint).
pub(super) fn column_sql(ctx: &Context, col: &ColumnDef, inline_pk: bool) -> Result<String> {
    validate_name("column", &col.name)?;
    let data_type = DataType::parse(&col.data_type, ctx.enums)?;
    let mut sql = format!("{} {}", ident(&col.name), data_type.to_sql(ctx.schema));
    if col.identity {
        if !data_type.is_integer() {
            return invalid(
                "identity_requires_integer",
                format!(
                    "column '{}': identity only on smallint, integer or bigint",
                    col.name
                ),
                json!({ "column": col.name }),
            );
        }
        if col.default.is_some() {
            return invalid(
                "identity_with_default",
                format!("column '{}': identity does not take a DEFAULT", col.name),
                json!({ "column": col.name }),
            );
        }
        sql.push_str(" GENERATED ALWAYS AS IDENTITY");
    }
    match inline_pk {
        true => {
            sql.push_str(" PRIMARY KEY");
        }
        false => {
            if !col.nullable || col.identity || col.primary_key {
                sql.push_str(" NOT NULL");
            }
        }
    }
    if let Some(default) = &col.default {
        sql.push_str(&format!(" DEFAULT {}", expression("DEFAULT", default)?));
    }
    if col.unique && !inline_pk {
        sql.push_str(" UNIQUE");
    }
    if let Some(reference) = &col.references {
        sql.push(' ');
        sql.push_str(&references_sql(ctx.schema, reference)?);
    }
    Ok(sql)
}

pub(super) fn comment_on_column(table: &str, column: &str, comment: Option<&str>) -> String {
    format!(
        "COMMENT ON COLUMN {table}.{} IS {}",
        ident(column),
        comment
            .filter(|c| !c.trim().is_empty())
            .map_or("NULL".to_owned(), literal)
    )
}
