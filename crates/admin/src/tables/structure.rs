//! A table's full structure, read from `pg_catalog`: the API catalog keeps
//! only what it needs to serve requests (it has, for instance, neither the
//! DEFAULT expression nor constraint names). Used by the panel's Structure tab
//! and by the DDL handlers, which validate changes against the current state.

use axum::{
    Json,
    extract::{Path, State},
};
use futures_util::future::try_join3;
use serde::Serialize;
use tokio_postgres::Client;

use serde_json::json;

use crate::{AdminState, ApiError, tables::catalog::table_or_404};

/// Roles the panel shows and lets you configure in GRANTs.
pub const API_ROLES: [&str; 3] = ["anon", "authenticated", "service_role"];

#[derive(Debug, Clone, Serialize, ts_rs::TS, schemars::JsonSchema)]
pub struct ForeignKeyRef {
    pub table: String,
    pub column: String,
    /// `no action`, `restrict`, `cascade`, `set null` or `set default`.
    pub on_delete: &'static str,
    pub constraint: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS, schemars::JsonSchema)]
pub struct ColumnInfo {
    pub name: String,
    /// Type as Postgres writes it (`character varying(80)`, `integer[]`).
    pub data_type: String,
    pub nullable: bool,
    /// DEFAULT (or generated column) expression, as in `pg_get_expr`.
    pub default: Option<String>,
    /// `always`, `by default` or `None` (not an identity column).
    #[ts(type = "'always' | 'by default' | null")]
    pub identity: Option<&'static str>,
    pub generated: bool,
    pub primary_key: bool,
    /// Name of the single-column UNIQUE constraint, if any.
    pub unique: Option<String>,
    pub references: Option<ForeignKeyRef>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS, schemars::JsonSchema)]
pub struct Grant {
    #[ts(type = "'anon' | 'authenticated' | 'service_role'")]
    pub role: &'static str,
    /// Subset of `select`, `insert`, `update`, `delete`.
    #[ts(type = "Array<'select' | 'insert' | 'update' | 'delete'>")]
    pub privileges: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS, schemars::JsonSchema)]
pub struct Structure {
    pub name: String,
    pub comment: Option<String>,
    pub rls_enabled: bool,
    pub primary_key: Vec<String>,
    pub primary_key_constraint: Option<String>,
    pub columns: Vec<ColumnInfo>,
    pub grants: Vec<Grant>,
}

impl Structure {
    pub fn column(&self, name: &str) -> Option<&ColumnInfo> {
        self.columns.iter().find(|c| c.name == name)
    }
}

pub const PRIVILEGES: [&str; 4] = ["select", "insert", "update", "delete"];

fn on_delete(code: &str) -> &'static str {
    match code {
        "r" => "restrict",
        "c" => "cascade",
        "n" => "set null",
        "d" => "set default",
        _ => "no action",
    }
}

fn identity(code: &str) -> Option<&'static str> {
    match code {
        "a" => Some("always"),
        "d" => Some("by default"),
        _ => None,
    }
}

const COLUMNS_SQL: &str = "
    SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
           pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text <> '',
           col_description(a.attrelid, a.attnum)
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum";

// Columns of each constraint in definition order (conkey/confkey).
const CONSTRAINTS_SQL: &str = "
    SELECT con.conname::text, con.contype::text,
           ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY o),
           nf.nspname::text, cf.relname::text,
           ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY o),
           con.confdeltype::text
    FROM pg_constraint con
    LEFT JOIN pg_class cf ON cf.oid = con.confrelid
    LEFT JOIN pg_namespace nf ON nf.oid = cf.relnamespace
    WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'f')
    ORDER BY con.conname";

const GRANTS_SQL: &str = "
    SELECT r.role::text, p.privilege::text
    FROM unnest($2::text[]) AS r(role)
    CROSS JOIN unnest(ARRAY['select', 'insert', 'update', 'delete']) AS p(privilege)
    WHERE has_table_privilege(r.role, $1::oid, p.privilege)";

/// Reads the structure of `schema.table`. `None` if the table does not exist.
pub async fn load(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Option<Structure>, ApiError> {
    let head = match client
        .query_opt(
            "SELECT c.oid, obj_description(c.oid, 'pg_class'), c.relrowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await?
    {
        Some(head) => head,
        _ => {
            return Ok(None);
        }
    };
    let oid: u32 = head.get(0);
    let roles: Vec<&str> = API_ROLES.to_vec();
    // Three independent queries, pipelined on the same connection.
    let (columns, constraints, grants) = try_join3(
        client.query(COLUMNS_SQL, &[&oid]),
        client.query(CONSTRAINTS_SQL, &[&oid]),
        client.query(GRANTS_SQL, &[&oid, &roles]),
    )
    .await?;

    let mut primary_key = Vec::new();
    let mut primary_key_constraint = None;
    let mut uniques: Vec<(String, String)> = Vec::new();
    let mut foreign: Vec<(String, ForeignKeyRef)> = Vec::new();
    for row in &constraints {
        let name: String = row.get(0);
        let kind: String = row.get(1);
        let cols: Vec<String> = row.get(2);
        match kind.as_str() {
            "p" => {
                primary_key = cols;
                primary_key_constraint = Some(name);
            }
            // Only single-column constraints become column attributes.
            "u" if cols.len() == 1 => uniques.push((cols[0].clone(), name)),
            "f" if cols.len() == 1 => {
                let foreign_schema: String = row.get(3);
                let foreign_cols: Vec<String> = row.get(5);
                if foreign_schema == schema {
                    foreign.push((
                        cols[0].clone(),
                        ForeignKeyRef {
                            table: row.get(4),
                            column: foreign_cols[0].clone(),
                            on_delete: on_delete(&row.get::<_, String>(6)),
                            constraint: name,
                        },
                    ));
                }
            }
            _ => {}
        }
    }

    let columns = columns
        .iter()
        .map(|row| {
            let name: String = row.get(0);
            ColumnInfo {
                data_type: row.get(1),
                nullable: row.get(2),
                default: row.get(3),
                identity: identity(&row.get::<_, String>(4)),
                generated: row.get(5),
                primary_key: primary_key.contains(&name),
                unique: uniques
                    .iter()
                    .find(|(c, _)| *c == name)
                    .map(|(_, n)| n.clone()),
                references: foreign
                    .iter()
                    .find(|(c, _)| *c == name)
                    .map(|(_, f)| f.clone()),
                comment: row.get(6),
                name,
            }
        })
        .collect();

    let grants = API_ROLES
        .iter()
        .map(|&role| Grant {
            role,
            privileges: PRIVILEGES
                .iter()
                .copied()
                .filter(|p| {
                    grants
                        .iter()
                        .any(|g| g.get::<_, String>(0) == role && g.get::<_, String>(1) == *p)
                })
                .collect(),
        })
        .collect();

    Ok(Some(Structure {
        name: table.to_owned(),
        comment: head.get(1),
        rls_enabled: head.get(2),
        primary_key,
        primary_key_constraint,
        columns,
        grants,
    }))
}

/// `GET /admin/api/tables/{name}/structure`
pub async fn structure(
    State(state): State<AdminState>,
    Path(name): Path<String>,
) -> Result<Json<Structure>, ApiError> {
    let table = table_or_404(&state, &name)?;
    let schema = state.catalog.get().schema.clone();
    let client = state.db.get().await?;
    load(&client, &schema, &table.name)
        .await?
        .map(Json)
        .ok_or_else(|| {
            ApiError::not_found("table_not_found", format!("table '{name}' does not exist"))
                .params(json!({ "table": name }))
        })
}
