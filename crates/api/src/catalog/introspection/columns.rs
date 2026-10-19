//! PostgreSQL columns query and its row mapping.
use super::super::model::{Column, Table};
use std::collections::BTreeMap;
use tokio_postgres::GenericClient;

pub(super) async fn load(
    client: &impl GenericClient,
    schema: &str,
    tables: &mut BTreeMap<String, Table>,
) -> Result<(), tokio_postgres::Error> {
    let rows = client
            .query(
                "SELECT c.relname::text, a.attname::text,
                        format_type(a.atttypid, NULL), format_type(a.atttypid, a.atttypmod),
                        t.typcategory::text,
                        CASE WHEN t.typcategory = 'A' THEN format_type(t.typelem, NULL) END,
                        ARRAY(SELECT e.enumlabel::text FROM pg_enum e
                              WHERE e.enumtypid = CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE a.atttypid END
                              ORDER BY e.enumsortorder),
                        NOT a.attnotnull,
                        a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '',
                        a.attgenerated <> '' OR a.attidentity = 'a',
                        col_description(c.oid, a.attnum)
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_type t ON t.oid = a.atttypid
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                   AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY c.relname, a.attnum",
                &[&schema],
            )
            .await?;
    for row in rows {
        let table = match tables.get_mut(&row.get::<_, String>(0)) {
            Some(table) => table,
            _ => {
                continue;
            }
        };
        table.columns.push(Column {
            name: row.get(1),
            type_name: row.get(2),
            full_type: row.get(3),
            category: row.get::<_, String>(4).chars().next().unwrap_or('X'),
            element_type: row.get(5),
            enum_values: row.get(6),
            nullable: row.get(7),
            has_default: row.get(8),
            generated: row.get(9),
            comment: row.get(10),
        });
    }

    Ok(())
}
