//! Table DDL facade: typed input, SQL planning and no database side effects.
mod alter;
mod column;
mod create;
mod spec;

pub use alter::alter;
pub use create::create;
pub use spec::{AlterAction, ColumnDef, Context, CreateTable, OnDelete, ReferenceDef};

use super::qualified;
use nelcota_api::catalog::TableKind;

/// `DROP TABLE` fails on a view, materialized view or foreign table; each
/// relation kind has its own statement.
pub fn drop(schema: &str, name: &str, kind: TableKind, cascade: bool) -> Vec<String> {
    let statement = match kind {
        TableKind::Table => "DROP TABLE",
        TableKind::View => "DROP VIEW",
        TableKind::MaterializedView => "DROP MATERIALIZED VIEW",
        TableKind::ForeignTable => "DROP FOREIGN TABLE",
    };
    let mut sql = format!("{statement} {}", qualified(schema, name));
    if cascade {
        sql.push_str(" CASCADE");
    }
    vec![sql]
}

#[cfg(test)]
mod tests;
