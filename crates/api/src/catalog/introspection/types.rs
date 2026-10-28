//! Named types used in function signatures, including types without table columns.
use super::super::model::{NamedType, TypeField};
use std::collections::BTreeMap;
use tokio_postgres::GenericClient;

pub(super) async fn load(
    client: &impl GenericClient,
    schema: &str,
) -> Result<BTreeMap<String, NamedType>, tokio_postgres::Error> {
    let rows = client.query(
        "SELECT format_type(t.oid, NULL), t.typname::text,
                ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder),
                coalesce((SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type_name', format_type(a.atttypid, NULL), 'nullable', NOT a.attnotnull) ORDER BY a.attnum)
                    FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb),
                CASE WHEN c.relkind IN ('r', 'p', 'v', 'm', 'f') THEN c.relname::text END
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         LEFT JOIN pg_class c ON c.oid = t.typrelid
         WHERE n.nspname = $1 AND t.typtype IN ('e', 'c') ORDER BY t.typname", &[&schema]).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            // The JSON is constructed from these exact field names by PostgreSQL.
            let fields: Vec<TypeField> =
                serde_json::from_value(row.get(3)).expect("catalog type fields");
            (
                row.get(0),
                NamedType {
                    name: row.get(1),
                    enum_values: row.get(2),
                    fields,
                    relation: row.get(4),
                },
            )
        })
        .collect())
}
