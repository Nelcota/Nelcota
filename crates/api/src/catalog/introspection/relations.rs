//! PostgreSQL relations query and its row mapping.
use super::super::model::{Privileges, Table, TableKind};
use std::collections::BTreeMap;
use tokio_postgres::GenericClient;

/// Objects created by extensions are left out.
const NOT_FROM_EXTENSION: &str =
    "NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')";
/// Partitions, and inheritance children without row-level security of their
/// own, are left out: they are read through their parent, and the parent's
/// row policies do not apply to a child queried directly, so exposing one
/// would bypass them. A child with RLS enabled was exposed on purpose.
const NOT_A_CHILD: &str = "NOT c.relispartition
    AND (c.relrowsecurity OR c.oid NOT IN (SELECT inhrelid FROM pg_inherits))";

pub(super) async fn load(
    client: &impl GenericClient,
    schema: &str,
) -> Result<BTreeMap<String, Table>, tokio_postgres::Error> {
    let mut tables = BTreeMap::new();

    let privilege = |role: &str, p: &str| format!("has_table_privilege('{role}', c.oid, '{p}')");
    let mut privilege_columns = Vec::new();
    for role in ["anon", "authenticated", "service_role"] {
        for p in ["SELECT", "INSERT", "UPDATE", "DELETE"] {
            privilege_columns.push(privilege(role, p));
        }
    }
    let rows = client
            .query(
                &format!(
                    "SELECT c.relname::text, c.relkind::text, c.relrowsecurity, c.relforcerowsecurity,
                            obj_description(c.oid, 'pg_class'),
                            coalesce((SELECT option_value::boolean FROM pg_options_to_table(c.reloptions)
                                      WHERE option_name = 'security_invoker'), false), {}
                     FROM pg_class c
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                       AND {NOT_FROM_EXTENSION}
                       AND {NOT_A_CHILD}",
                    privilege_columns.join(", ")
                ),
                &[&schema],
            )
            .await?;
    for row in rows {
        let name: String = row.get(0);
        let kind = match row.get::<_, String>(1).as_str() {
            "v" => TableKind::View,
            "m" => TableKind::MaterializedView,
            "f" => TableKind::ForeignTable,
            _ => TableKind::Table,
        };
        let mut privileges = [Privileges::default(); 3];
        for (i, p) in privileges.iter_mut().enumerate() {
            let base = 6 + i * 4;
            *p = Privileges {
                select: row.get(base),
                insert: row.get(base + 1),
                update: row.get(base + 2),
                delete: row.get(base + 3),
            };
        }
        tables.insert(
            name.clone(),
            Table {
                name,
                kind,
                columns: Vec::new(),
                primary_key: Vec::new(),
                foreign_keys: Vec::new(),
                rls_enabled: row.get(2),
                rls_forced: row.get(3),
                comment: row.get(4),
                security_invoker: row.get(5),
                privileges,
            },
        );
    }

    Ok(tables)
}
