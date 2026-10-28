//! Plan ordered alterations while retaining one working schema owner.
use super::{
    AlterAction, ColumnDef, Context,
    column::{column_sql, comment_on_column, references_sql},
};
use crate::ddl::{
    DataType, Result, error, expression, grant, invalid, literal, qualified, validate_name,
};
use crate::tables::structure::{ColumnInfo, Structure};
use nelcota_api::query::ident;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Column just added to the working copy (constraint names do not exist yet:
/// Postgres only creates them when it runs).
fn added_column(col: &ColumnDef, unique: Option<String>) -> ColumnInfo {
    ColumnInfo {
        name: col.name.clone(),
        data_type: col.data_type.clone(),
        nullable: col.nullable && !col.identity,
        default: col.default.clone(),
        identity: col.identity.then_some("always"),
        generated: false,
        primary_key: false,
        unique,
        references: None,
        comment: col.comment.clone(),
    }
}

// Explicit, bounded names let later actions drop a constraint created in the
// same batch, including after a table/column rename.
fn unique_name(table: &str, column: &str, sequence: usize) -> String {
    let digest = Sha256::digest(format!("{table}\0{column}\0{sequence}"));
    let suffix: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("nelcota_unique_{suffix}")
}

fn column_exists<'a>(
    current: &'a Structure,
    name: &str,
) -> Result<&'a crate::tables::structure::ColumnInfo> {
    current.column(name).ok_or_else(|| {
        error(
            "column_not_found",
            format!("column '{name}' does not exist"),
            json!({ "column": name }),
        )
    })
}

/// `initial`: the current structure (validates columns and finds constraint names).
pub fn alter(ctx: &Context, initial: &Structure, actions: &[AlterAction]) -> Result<Vec<String>> {
    if actions.is_empty() {
        return invalid("no_changes", "no changes", Value::Null);
    }
    // Working copy updated after each action: once a column (or the table) is
    // renamed, the following actions use the new name.
    let mut current = initial.clone();
    let mut table = qualified(ctx.schema, &current.name);
    let mut statements = Vec::new();
    for action in actions {
        let target = table.clone();
        let alter = |clause: String| format!("ALTER TABLE {target} {clause}");
        match action {
            AlterAction::RenameTable { name } => {
                validate_name("table", name)?;
                statements.push(alter(format!("RENAME TO {}", ident(name))));
                current.name.clone_from(name);
                table = qualified(ctx.schema, name);
            }
            AlterAction::SetComment { comment } => statements.push(format!(
                "COMMENT ON TABLE {table} IS {}",
                comment
                    .as_deref()
                    .filter(|c| !c.trim().is_empty())
                    .map_or("NULL".to_owned(), literal)
            )),
            AlterAction::SetRls { enabled } => statements.push(alter(
                match *enabled {
                    true => "ENABLE ROW LEVEL SECURITY",
                    false => "DISABLE ROW LEVEL SECURITY",
                }
                .to_owned(),
            )),
            AlterAction::AddColumn { column } => {
                if column.primary_key {
                    return invalid(
                        "primary_key_on_create_only",
                        "the primary key is set when the table is created",
                        Value::Null,
                    );
                }
                if current.column(&column.name).is_some() {
                    return invalid(
                        "column_already_exists",
                        format!("column '{}' already exists", column.name),
                        json!({ "column": column.name }),
                    );
                }
                let mut definition = column.clone();
                definition.unique = false;
                statements.push(alter(format!(
                    "ADD COLUMN {}",
                    column_sql(ctx, &definition, false)?
                )));
                let unique = column
                    .unique
                    .then(|| unique_name(&table, &column.name, statements.len()));
                if let Some(name) = &unique {
                    statements.push(alter(format!(
                        "ADD CONSTRAINT {} UNIQUE ({})",
                        ident(name),
                        ident(&column.name)
                    )));
                }
                if let Some(comment) = column.comment.as_deref().filter(|c| !c.trim().is_empty()) {
                    statements.push(comment_on_column(&table, &column.name, Some(comment)));
                }
                current.columns.push(added_column(column, unique));
            }
            AlterAction::DropColumn { name } => {
                column_exists(&current, name)?;
                statements.push(alter(format!("DROP COLUMN {}", ident(name))));
                current.columns.retain(|c| c.name != *name);
            }
            AlterAction::RenameColumn { from, to } => {
                column_exists(&current, from)?;
                validate_name("column", to)?;
                if from != to && current.column(to).is_some() {
                    return invalid(
                        "column_already_exists",
                        format!("column '{to}' already exists"),
                        json!({ "column": to }),
                    );
                }
                statements.push(alter(format!(
                    "RENAME COLUMN {} TO {}",
                    ident(from),
                    ident(to)
                )));
                if let Some(info) = current.columns.iter_mut().find(|c| c.name == *from) {
                    info.name.clone_from(to);
                }
            }
            AlterAction::SetType {
                column,
                data_type,
                using,
            } => {
                column_exists(&current, column)?;
                let data_type = DataType::parse(data_type, ctx.enums)?.to_sql(ctx.schema);
                let using = match using {
                    Some(expr) => expression("USING", expr)?,
                    None => format!("{}::{data_type}", ident(column)),
                };
                statements.push(alter(format!(
                    "ALTER COLUMN {} TYPE {data_type} USING {using}",
                    ident(column)
                )));
            }
            AlterAction::SetNullable { column, nullable } => {
                column_exists(&current, column)?;
                let change = match *nullable {
                    true => "DROP NOT NULL",
                    false => "SET NOT NULL",
                };
                statements.push(alter(format!("ALTER COLUMN {} {change}", ident(column))));
            }
            AlterAction::SetDefault { column, default } => {
                let info = column_exists(&current, column)?;
                if info.identity.is_some() || info.generated {
                    return invalid(
                        "column_rejects_default",
                        format!(
                            "column '{column}' is identity/generated: it does not take a DEFAULT"
                        ),
                        json!({ "column": column }),
                    );
                }
                let change = match default {
                    Some(expr) => format!("SET DEFAULT {}", expression("DEFAULT", expr)?),
                    None => "DROP DEFAULT".to_owned(),
                };
                statements.push(alter(format!("ALTER COLUMN {} {change}", ident(column))));
            }
            AlterAction::SetUnique { column, unique } => {
                let info = column_exists(&current, column)?;
                let mut constraint = info.unique.clone();
                match (&constraint, unique) {
                    (None, true) => {
                        let name = unique_name(&table, column, statements.len());
                        statements.push(alter(format!(
                            "ADD CONSTRAINT {} UNIQUE ({})",
                            ident(&name),
                            ident(column)
                        )));
                        constraint = Some(name);
                    }
                    (Some(name), false) => {
                        statements.push(alter(format!("DROP CONSTRAINT {}", ident(name))));
                        constraint = None;
                    }
                    _ => {}
                }
                if let Some(info) = current.columns.iter_mut().find(|info| info.name == *column) {
                    info.unique = constraint;
                }
            }
            AlterAction::SetReference { column, reference } => {
                let info = column_exists(&current, column)?;
                if let Some(existing) = &info.references {
                    statements.push(alter(format!(
                        "DROP CONSTRAINT {}",
                        ident(&existing.constraint)
                    )));
                }
                if let Some(reference) = reference {
                    statements.push(alter(format!(
                        "ADD FOREIGN KEY ({}) {}",
                        ident(column),
                        references_sql(ctx.schema, reference)?
                    )));
                }
            }
            AlterAction::SetColumnComment { column, comment } => {
                column_exists(&current, column)?;
                statements.push(comment_on_column(&table, column, comment.as_deref()));
            }
            AlterAction::SetGrants { grant: def } => {
                let role = ident(def.role.as_str());
                statements.push(format!("REVOKE ALL ON TABLE {table} FROM {role}"));
                statements.extend(grant(&table, def));
            }
        }
    }
    Ok(statements)
}
