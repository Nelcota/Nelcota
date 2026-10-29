//! Table listing, row reads and writes through the validated query compiler.
use super::catalog::{estimates, kind, policy_counts, rls_json, row_count, table_or_404};
use crate::{AdminState, ApiError, error::user_query_error, sql::RunAs};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use futures_util::future::try_join;
use nelcota_api::{
    Catalog,
    catalog::{Table, TableKind},
    query,
};
use serde::Deserialize;
use serde_json::{Map, Value, json, value::RawValue};
use std::collections::HashMap;
use tokio_postgres::Client;

type ApiResult<T = Value> = Result<Json<T>, ApiError>;
pub(super) type Row = HashMap<String, Box<RawValue>>;
const MAX_PAGE_SIZE: i64 = 500;

/// Text of a JSON value coming from Postgres, without going through `f64`
/// (numeric keeps every digit). `None` = NULL.
pub(crate) fn raw_text(value: Option<&RawValue>) -> Option<String> {
    let raw = value?.get();
    if raw == "null" {
        return None;
    }
    if raw.starts_with('"') {
        return serde_json::from_str::<String>(raw).ok();
    }
    Some(raw.to_owned())
}

pub async fn tables(
    State(state): State<AdminState>,
) -> ApiResult<crate::contracts::TablesResponse> {
    let catalog = state.catalog.get();
    let client = state.db.get().await?;
    let policies = policy_counts(&client, &catalog.schema).await?;
    let list: Vec<Value> = catalog
        .tables
        .values()
        .map(|t| {
            json!({
                "name": t.name,
                "kind": kind(t),
                "has_pk": !t.primary_key.is_empty(),
                "rls": rls_json(t, policies.get(&t.name).copied().unwrap_or(0)),
            })
        })
        .collect();
    crate::contracts::response::<crate::contracts::TablesResponse>(
        json!({ "schema": catalog.schema, "tables": list }),
    )
}

/// Filter operators the panel accepts (a subset of the REST API's).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FilterOp {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Like,
    Ilike,
    Is,
}

impl FilterOp {
    fn as_str(self) -> &'static str {
        match self {
            FilterOp::Eq => "eq",
            FilterOp::Neq => "neq",
            FilterOp::Gt => "gt",
            FilterOp::Gte => "gte",
            FilterOp::Lt => "lt",
            FilterOp::Lte => "lte",
            FilterOp::Like => "like",
            FilterOp::Ilike => "ilike",
            FilterOp::Is => "is",
        }
    }
}

/// A grid filter: `column operator value`, optionally negated.
#[derive(Debug, Deserialize)]
pub(crate) struct FilterSpec {
    column: String,
    op: FilterOp,
    value: String,
    #[serde(default)]
    not: bool,
}

impl FilterSpec {
    /// Pair in the REST API format (`column=not.op.value`), then validated by
    /// the same parser against the catalog.
    fn to_pair(&self) -> (String, String) {
        let not = match self.not {
            true => "not.",
            false => "",
        };
        (
            self.column.clone(),
            format!("{not}{}.{}", self.op.as_str(), self.value),
        )
    }
}

/// Sort and filters shared by listing and export.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct RowsQuery {
    pub sort: Option<String>,
    #[serde(default)]
    pub desc: bool,
    /// JSON array of [`FilterSpec`] (in the query string, since it is a GET).
    pub filters: Option<String>,
}

/// Builds the validated request (columns and operators checked against the
/// catalog). `page` = `Some((page, size))` to paginate.
pub(crate) fn build_request(
    table: &Table,
    params: &RowsQuery,
    page: Option<(i64, i64)>,
) -> Result<query::Request, ApiError> {
    let filters: Vec<FilterSpec> = match params.filters.as_deref() {
        None | Some("") => Vec::new(),
        Some(json) => serde_json::from_str(json).map_err(|e| {
            ApiError::bad_request("invalid_filters", format!("invalid filters: {e}"))
                .params(json!({ "detail": e.to_string() }))
        })?,
    };
    // Structured filters name literal columns, including REST modifier names.
    // Never round-trip those names through the URL parameter grammar.
    let filters = filters
        .iter()
        .map(|filter| {
            let (name, value) = filter.to_pair();
            query::column_filter(table, &name, &value).map_err(invalid_query)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut pairs = Vec::new();
    if let Some((page, size)) = page {
        let offset = page
            .checked_mul(size)
            .ok_or_else(|| ApiError::bad_request("invalid_page", "page is too large"))?;
        // One extra row tells whether there is a next page.
        pairs.push(("limit".into(), (size + 1).to_string()));
        pairs.push(("offset".into(), offset.to_string()));
    }
    // Sort: one literal requested column, or each literal primary-key column.
    let order = match &params.sort {
        Some(col) => vec![query::column_order(table, col, params.desc).map_err(invalid_query)?],
        None => table
            .primary_key
            .iter()
            .map(|col| query::column_order(table, col, false).map_err(invalid_query))
            .collect::<Result<Vec<_>, _>>()?,
    };
    let mut request = query::parse_request(&pairs, table).map_err(invalid_query)?;
    request.filters = filters;
    request.order = order;
    Ok(request)
}

/// The REST API parser refused the request (unknown column, bad operator…).
pub(crate) fn invalid_query(err: impl std::fmt::Display) -> ApiError {
    let detail = err.to_string();
    ApiError::bad_request("invalid_query", format!("invalid query: {detail}"))
        .params(json!({ "detail": detail }))
}

/// Count with a time cap: an unindexed filter on a big table must not freeze
/// the grid. `None` when it runs past the limit.
async fn bounded_count(client: &mut Client, sql: &query::Sql) -> Option<i64> {
    let tx = client.transaction().await.ok()?;
    tx.batch_execute("SET LOCAL statement_timeout = '3s'")
        .await
        .ok()?;
    let count = tx
        .query_one(sql.text.as_str(), &sql.param_refs())
        .await
        .ok()?
        .get(0);
    tx.commit().await.ok()?;
    Some(count)
}

/// Single-column foreign key to another exposed table: the grid uses it to
/// jump to the referenced row.
fn references(catalog: &Catalog, table: &Table, column: &str) -> Value {
    table
        .foreign_keys
        .iter()
        .find(|fk| {
            fk.columns.len() == 1
                && fk.columns[0] == column
                && fk.foreign_schema == catalog.schema
                && catalog.tables.contains_key(&fk.foreign_table)
        })
        .map_or(
            Value::Null,
            |fk| json!({ "table": fk.foreign_table, "column": fk.foreign_columns[0] }),
        )
}

// `RowsQuery` fields repeated instead of `#[serde(flatten)]`: with flatten,
// serde_urlencoded hands everything over as text and `page`/`desc` stop converting.
#[derive(Deserialize)]
pub struct TableQuery {
    #[serde(default)]
    page: i64,
    size: Option<i64>,
    sort: Option<String>,
    #[serde(default)]
    desc: bool,
    filters: Option<String>,
    /// View as `anon` or as `authenticated` (with `user`): rows come back
    /// as the API would return them to that caller, read-only.
    #[serde(rename = "as")]
    view_as: Option<String>,
    user: Option<String>,
}

impl TableQuery {
    fn run_as(&self) -> Result<RunAs, ApiError> {
        match (self.view_as.as_deref(), &self.user) {
            (None | Some("owner"), _) => Ok(RunAs::Owner),
            (Some("anon"), _) => Ok(RunAs::Anon),
            (Some("authenticated"), Some(user)) => Ok(RunAs::Authenticated {
                user_id: user.clone(),
            }),
            _ => Err(ApiError::bad_request(
                "invalid_view_as",
                "view as owner, anon, or authenticated with a user",
            )),
        }
    }
}

/// Rows and their count as `claims` would get them through the API (role,
/// grants and RLS), in a transaction that is rolled back.
async fn read_as(
    client: &mut deadpool_postgres::Object,
    claims: &nelcota_core::Claims,
    sql: &query::Sql,
    count: &query::Sql,
) -> Result<(String, Option<i64>), ApiError> {
    let tx = nelcota_core::db::begin_request(client, claims).await?;
    tx.batch_execute("SET LOCAL statement_timeout = '5s'")
        .await?;
    let rows: String = tx
        .query_one(sql.text.as_str(), &sql.param_refs())
        .await
        .map_err(|err| view_error(err, claims))?
        .get(0);
    let total = tx
        .query_one(count.text.as_str(), &count.param_refs())
        .await
        .ok()
        .map(|row| row.get(0));
    // Restore the owner role before this same connection reads metadata.
    // A failed count may have aborted the transaction; rollback handles both.
    tx.rollback().await?;
    Ok((rows, total))
}

/// A refusal while viewing as someone is the answer, not a failure: it says
/// that role has no access (no GRANT) to the table.
fn view_error(err: tokio_postgres::Error, claims: &nelcota_core::Claims) -> ApiError {
    let denied = err
        .as_db_error()
        .is_some_and(|db| *db.code() == tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE);
    if denied {
        let role = claims.role().as_str();
        return ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "view_denied",
            format!("{role} has no access to this table (no GRANT)"),
        )
        .params(json!({ "role": role }));
    }
    user_query_error(err)
}

pub async fn table(
    State(state): State<AdminState>,
    Path(name): Path<String>,
    Query(params): Query<TableQuery>,
) -> ApiResult<crate::contracts::TableData> {
    let table = table_or_404(&state, &name)?;
    let catalog = state.catalog.get();
    let run_as = params.run_as()?;
    let page = params.page.max(0);
    let size = params.size.unwrap_or(50).clamp(1, MAX_PAGE_SIZE);
    let rows_query = RowsQuery {
        sort: params.sort,
        desc: params.desc,
        filters: params.filters,
    };
    let request = build_request(&table, &rows_query, Some((page, size)))?;
    let viewer = run_as.claims(&state.db).await?;
    let filtered = !request.filters.is_empty();
    let sql = query::select(&catalog.schema, &table, &request, None);

    let mut client = state.db.get().await?;
    let (json_rows, (estimates, policies), viewed_total) = match &viewer {
        Some(claims) => {
            let count = query::count(&catalog.schema, &table, &request);
            let (rows, total) = read_as(&mut client, claims, &sql, &count).await?;
            let meta = try_join(
                estimates(&client, &catalog.schema),
                policy_counts(&client, &catalog.schema),
            )
            .await?;
            (rows, meta, Some(total))
        }
        None => {
            // Rows, estimates and policies pipelined on the same connection.
            let (row, meta) = try_join(
                async {
                    client
                        .query_one(sql.text.as_str(), &sql.param_refs())
                        .await
                        .map_err(user_query_error)
                },
                try_join(
                    estimates(&client, &catalog.schema),
                    policy_counts(&client, &catalog.schema),
                ),
            )
            .await?;
            (row.get::<_, String>(0), meta, None)
        }
    };

    let raw_rows: Vec<Row> = serde_json::from_str(&json_rows)?;
    let has_next = raw_rows.len() as i64 > size;
    let rows: Vec<Value> = raw_rows
        .iter()
        .take(size as usize)
        .map(|r| {
            let map: Map<String, Value> = table
                .columns
                .iter()
                .map(|c| {
                    let text = raw_text(r.get(&c.name).map(AsRef::as_ref));
                    (c.name.clone(), text.map_or(Value::Null, Value::String))
                })
                .collect();
            Value::Object(map)
        })
        .collect();

    let estimate = estimates.get(&table.name).copied().unwrap_or(-1);
    let (total, exact) = match viewed_total {
        Some(total) => (total, total.is_some()),
        _ => match filtered {
            true => {
                let count = query::count(&catalog.schema, &table, &request);
                let total = bounded_count(&mut client, &count).await;
                (total, total.is_some())
            }
            false => row_count(&mut client, &catalog.schema, &table, estimate).await,
        },
    };
    let columns: Vec<Value> = table
        .columns
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "type": c.type_name,
                "full_type": c.full_type,
                "category": c.category.to_string(),
                "nullable": c.nullable,
                "has_default": c.has_default,
                "generated": c.generated,
                "enum_values": c.enum_values,
                "is_pk": table.primary_key.contains(&c.name),
                "comment": c.comment,
                "references": references(&catalog, &table, &c.name),
            })
        })
        .collect();

    crate::contracts::response::<crate::contracts::TableData>(json!({
        "table": {
            "name": table.name,
            "kind": kind(&table),
            "comment": table.comment,
            "primary_key": table.primary_key,
            // Viewing as someone is read-only: edits always run as the owner.
            "editable": viewer.is_none() && !table.primary_key.is_empty() && table.kind != TableKind::MaterializedView,
            "insertable": viewer.is_none() && table.kind != TableKind::MaterializedView,
            "exposed_without_rls": table.exposed_without_rls(),
            "rls": rls_json(&table, policies.get(&table.name).copied().unwrap_or(0)),
            "columns": columns,
        },
        "rows": rows,
        "page": page,
        "size": size,
        "has_next": has_next,
        "total": total,
        "total_exact": exact,
    }))
}

/// Converts form values (text or null) to JSON: json/jsonb are parsed as
/// JSON; everything else goes as text and Postgres casts it to the column type.
fn to_values(table: &Table, values: Map<String, Value>) -> Result<Map<String, Value>, ApiError> {
    let mut out = Map::new();
    for (key, value) in values {
        let col = match table.column(&key).filter(|c| !c.generated) {
            Some(col) => col,
            _ => {
                return Err(ApiError::bad_request(
                    "unknown_or_generated_column",
                    format!("unknown or generated column: {key}"),
                )
                .params(json!({ "column": key })));
            }
        };
        let json = match value {
            Value::Null => Value::Null,
            Value::String(s) if matches!(col.type_name.as_str(), "json" | "jsonb") => {
                serde_json::from_str(&s).map_err(|e| {
                    ApiError::bad_request(
                        "invalid_json_value",
                        format!("{}: invalid JSON ({e})", col.name),
                    )
                    .params(json!({ "column": col.name, "detail": e.to_string() }))
                })?
            }
            Value::String(s) => Value::String(s),
            other => Value::String(other.to_string()),
        };
        out.insert(col.name.clone(), json);
    }
    Ok(out)
}

/// `column=eq.value` pairs of the primary key.
fn pk_filters(table: &Table, pk: &Map<String, Value>) -> Result<Vec<query::Condition>, ApiError> {
    if table.primary_key.is_empty() {
        return Err(ApiError::bad_request(
            "no_primary_key",
            "table without a primary key: editing from the panel is unavailable (use the SQL editor)",
        ));
    }
    table
        .primary_key
        .iter()
        .map(|col| {
            let value = match pk.get(col) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => {
                    return Err(ApiError::bad_request(
                        "missing_key_value",
                        format!("missing value for key '{col}'"),
                    )
                    .params(json!({ "column": col })));
                }
                Some(other) => other.to_string(),
            };
            // Primary-key names are literal catalog columns, never REST modifiers.
            query::column_filter(table, col, &format!("eq.{value}")).map_err(invalid_query)
        })
        .collect()
}

/// Runs a write and returns Postgres' error message as a 400.
async fn execute(state: &AdminState, sql: &query::Sql) -> Result<u64, ApiError> {
    let client = state.db.get().await?;
    client
        .execute(sql.text.as_str(), &sql.param_refs())
        .await
        .map_err(user_query_error)
}

#[derive(Deserialize)]
pub struct InsertRequest {
    values: Map<String, Value>,
}

pub async fn insert_row(
    State(state): State<AdminState>,
    Path(name): Path<String>,
    Json(body): Json<InsertRequest>,
) -> ApiResult {
    let table = table_or_404(&state, &name)?;
    let schema = state.catalog.get().schema.clone();
    let values = to_values(&table, body.values)?;
    let sql =
        query::insert(&schema, &table, Value::Object(values), None, None).map_err(invalid_query)?;
    execute(&state, &sql).await?;
    Ok(Json(json!({ "message": "row inserted" })))
}

#[derive(Deserialize)]
pub struct UpdateRequest {
    pk: Map<String, Value>,
    values: Map<String, Value>,
}

pub async fn update_row(
    State(state): State<AdminState>,
    Path(name): Path<String>,
    Json(body): Json<UpdateRequest>,
) -> ApiResult {
    let table = table_or_404(&state, &name)?;
    let schema = state.catalog.get().schema.clone();
    let filters = pk_filters(&table, &body.pk)?;
    let values = to_values(&table, body.values)?;
    let sql = query::update(&schema, &table, Value::Object(values), &filters, None)
        .map_err(invalid_query)?;
    let n = execute(&state, &sql).await?;
    Ok(Json(
        json!({ "message": format!("{n} row(s) updated"), "count": n }),
    ))
}

#[derive(Deserialize)]
pub struct DeleteRequest {
    pks: Vec<Map<String, Value>>,
}

/// Deletes several rows (the grid selection) in a single transaction.
pub async fn delete_rows(
    State(state): State<AdminState>,
    Path(name): Path<String>,
    Json(body): Json<DeleteRequest>,
) -> ApiResult {
    let table = table_or_404(&state, &name)?;
    let schema = state.catalog.get().schema.clone();
    if body.pks.is_empty() {
        return Err(ApiError::bad_request(
            "no_rows_selected",
            "no rows selected",
        ));
    }
    let statements: Vec<query::Sql> = body
        .pks
        .iter()
        .map(|pk| {
            Ok(query::delete(
                &schema,
                &table,
                &pk_filters(&table, pk)?,
                None,
            ))
        })
        .collect::<Result<_, ApiError>>()?;
    let mut client = state.db.get().await?;
    let tx = client.transaction().await?;
    let mut total = 0;
    for sql in &statements {
        total += tx
            .execute(sql.text.as_str(), &sql.param_refs())
            .await
            .map_err(user_query_error)?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({ "message": format!("{total} row(s) deleted"), "count": total }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_keep_postgres_text() {
        let raw = |s: &str| serde_json::from_str::<Box<RawValue>>(s).unwrap();
        assert_eq!(raw_text(Some(&raw("\"<b>\""))).as_deref(), Some("<b>"));
        assert_eq!(
            raw_text(Some(&raw("12345678901234567890.10"))).as_deref(),
            Some("12345678901234567890.10")
        );
        assert_eq!(raw_text(Some(&raw("null"))), None);
        assert_eq!(
            raw_text(Some(&raw("{\"a\": 1}"))).as_deref(),
            Some("{\"a\": 1}")
        );
    }
}
