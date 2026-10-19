//! Table DDL facade: typed input, SQL planning and no database side effects.
mod alter;
mod column;
mod create;
mod spec;

pub use alter::alter;
pub use create::create;
pub use spec::{AlterAction, ColumnDef, Context, CreateTable, OnDelete, ReferenceDef};

use super::qualified;

pub fn drop(schema: &str, name: &str, cascade: bool) -> Vec<String> {
    let mut sql = format!("DROP TABLE {}", qualified(schema, name));
    if cascade {
        sql.push_str(" CASCADE");
    }
    vec![sql]
}

#[cfg(test)]
mod tests;
