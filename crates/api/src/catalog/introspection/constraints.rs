//! PostgreSQL constraints query and its row mapping.
use super::super::model::{ForeignKey, Table};
use std::collections::BTreeMap;
use tokio_postgres::GenericClient;

pub(super) async fn load(
    client: &impl GenericClient,
    schema: &str,
    tables: &mut BTreeMap<String, Table>,
) -> Result<(), tokio_postgres::Error> {
    let rows = client
            .query(
                "SELECT c.relname::text, con.contype::text, con.conname::text,
                        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                              ORDER BY k.ord),
                        fn.nspname::text, fc.relname::text,
                        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                              ORDER BY k.ord)
                 FROM pg_constraint con
                 JOIN pg_class c ON c.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_class fc ON fc.oid = con.confrelid
                 LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                 WHERE n.nspname = $1 AND con.contype IN ('p', 'f')
                 ORDER BY c.relname, con.conname",
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
        let columns: Vec<String> = row.get(3);
        match row.get::<_, String>(1) == "p" {
            true => {
                table.primary_key = columns;
            }
            false => {
                table.foreign_keys.push(ForeignKey {
                    name: row.get(2),
                    columns,
                    foreign_schema: row.get(4),
                    foreign_table: row.get(5),
                    foreign_columns: row.get(6),
                });
            }
        }
    }

    Ok(())
}
