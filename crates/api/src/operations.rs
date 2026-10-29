//! CRUD/RPC execution under the caller's role and row-level policies.
use crate::{
    Catalog,
    query::{self, QueryError, Resolution, Sql},
};
use axum::http::StatusCode;
use deadpool_postgres::{Pool, Transaction};
use nelcota_core::{ApiError, Claims, db};
use serde_json::{Map, Value};

pub(crate) struct ReadResult {
    pub body: String,
    pub rows: i64,
    pub offset: i64,
    pub total: Option<i64>,
}
pub(crate) struct WriteResult {
    pub body: Option<String>,
    pub rows: u64,
    pub resolution: Option<Resolution>,
}
/// A PATCH/DELETE: the representation (if asked for) and the rows changed.
pub(crate) struct ChangeResult {
    pub body: Option<String>,
    pub rows: u64,
}
#[derive(Default)]
pub(crate) struct WriteOptions {
    pub representation: bool,
    pub resolution: Option<Resolution>,
}

fn bad_query(err: QueryError) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_query", err.to_string())
}

fn not_found(kind: &str, name: &str) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("{kind} '{name}' does not exist in the exposed schema"),
    )
}

/// RPC arguments: an empty body means no arguments (`{}`).
fn parse_body(bytes: &[u8]) -> Result<Value, ApiError> {
    if bytes.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    parse_json(bytes)
}

/// Rows of a POST/PATCH: an empty body is a mistake (a lost body, a client
/// that forgot to serialize), not a row of defaults; send `{}` for that.
fn parse_rows(bytes: &[u8]) -> Result<Value, ApiError> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "the request body is empty; send a JSON object or array",
        ));
    }
    parse_json(bytes)
}

fn parse_json(bytes: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(bytes).map_err(|e| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            format!("invalid JSON: {e}"),
        )
    })
}

async fn fetch_json(
    tx: &Transaction<'_>,
    sql: &Sql,
) -> Result<(String, i64), tokio_postgres::Error> {
    let statement = tx.prepare(&sql.text).await?;
    let row = tx.query_one(&statement, &sql.param_refs()).await?;
    Ok((row.get(0), row.get(1)))
}

async fn execute(tx: &Transaction<'_>, sql: &Sql) -> Result<u64, tokio_postgres::Error> {
    let statement = tx.prepare(&sql.text).await?;
    tx.execute(&statement, &sql.param_refs()).await
}

/// Runs the body in a transaction with the request role/claims.
macro_rules! in_request_tx {
    ($pool:expr, $claims:expr, |$tx:ident| $body:block) => {{
        let role = $claims.role();
        let db_err = |e| ApiError::from_db(e, role);
        let mut client = $pool.get().await.map_err(ApiError::from_pool)?;
        let $tx = db::begin_request(&mut client, &$claims)
            .await
            .map_err(db_err)?;
        let result = async { $body }.await.map_err(db_err)?;
        $tx.commit().await.map_err(db_err)?;
        result
    }};
}

/// `on_conflict` only means something to an upsert (POST).
fn reject_on_conflict(request: &query::Request) -> Result<(), ApiError> {
    if request.on_conflict.is_some() {
        return Err(bad_query(QueryError::Invalid(
            "on_conflict only applies to POST with Prefer: resolution=...".into(),
        )));
    }
    Ok(())
}

/// PATCH/DELETE require at least one filter: prevents deleting/changing the
/// whole table by mistake (for that, use an explicit filter such as
/// `id=not.is.null`).
fn require_filters(request: &query::Request) -> Result<(), ApiError> {
    if request.filters.is_empty() {
        return Err(bad_query(QueryError::Invalid(
            "provide at least one filter (e.g. ?id=eq.1)".into(),
        )));
    }
    Ok(())
}

/// PATCH/DELETE act on every row the filters match: `order`, `limit` and
/// `offset` would be silently ignored, which reads as "change only the first
/// N rows" and changes them all. Refuse them instead.
fn reject_paging(request: &query::Request) -> Result<(), ApiError> {
    let ignored = [
        ("order", !request.order.is_empty()),
        ("limit", request.limit.is_some()),
        ("offset", request.offset.is_some()),
    ];
    if let Some((name, _)) = ignored.iter().find(|(_, set)| *set) {
        return Err(bad_query(QueryError::Invalid(format!(
            "{name} does not apply to PATCH or DELETE, which change every matching row; narrow the filters instead"
        ))));
    }
    Ok(())
}

pub(crate) async fn read(
    pool: &Pool,
    claims: &Claims,
    catalog: &Catalog,
    name: &str,
    pairs: &[(String, String)],
    max_rows: Option<i64>,
    count_exact: bool,
) -> Result<ReadResult, ApiError> {
    let table = catalog
        .table(name)
        .ok_or_else(|| not_found("table", name))?;
    let request = query::parse_request_with_relations(pairs, table, catalog).map_err(bad_query)?;
    reject_on_conflict(&request)?;
    let sql = if count_exact {
        query::select_counted(&catalog.schema, table, &request, max_rows)
    } else {
        query::select(&catalog.schema, table, &request, max_rows)
    };
    let (body, rows, total) = in_request_tx!(pool, claims, |tx| {
        let statement = tx.prepare(&sql.text).await?;
        let row = tx.query_one(&statement, &sql.param_refs()).await?;
        Ok::<_, tokio_postgres::Error>((
            row.get(0),
            row.get(1),
            count_exact.then(|| row.get::<_, i64>(2)),
        ))
    });
    Ok(ReadResult {
        body,
        rows,
        total,
        offset: request.offset.unwrap_or(0),
    })
}

/// Runs a write; returns the representation (if asked for) and how many
/// rows it wrote.
async fn write(
    pool: &Pool,
    claims: &Claims,
    sql: Sql,
    representation: bool,
) -> Result<ChangeResult, ApiError> {
    if representation {
        let (body, rows) = in_request_tx!(pool, claims, |tx| { fetch_json(&tx, &sql).await });
        return Ok(ChangeResult {
            body: Some(body),
            rows: u64::try_from(rows).unwrap_or_default(),
        });
    }
    let rows = in_request_tx!(pool, claims, |tx| { execute(&tx, &sql).await });
    Ok(ChangeResult { body: None, rows })
}

pub(crate) async fn create(
    pool: &Pool,
    claims: &Claims,
    catalog: &Catalog,
    name: &str,
    pairs: &[(String, String)],
    bytes: &[u8],
    options: WriteOptions,
) -> Result<WriteResult, ApiError> {
    let table = catalog
        .table(name)
        .ok_or_else(|| not_found("table", name))?;
    let request = query::parse_request_with_relations(pairs, table, catalog).map_err(bad_query)?;
    if !request.filters.is_empty() {
        return Err(bad_query(QueryError::Invalid(
            "POST does not accept filters".into(),
        )));
    }
    let ignored = [
        ("order", !request.order.is_empty()),
        ("limit", request.limit.is_some()),
        ("offset", request.offset.is_some()),
    ];
    if let Some((name, _)) = ignored.iter().find(|(_, set)| *set) {
        return Err(bad_query(QueryError::Invalid(format!(
            "POST does not accept {name}"
        ))));
    }
    let upsert = match (options.resolution, &request.on_conflict) {
        (Some(resolution), on_conflict) => {
            Some(query::Upsert::new(table, on_conflict.as_deref(), resolution).map_err(bad_query)?)
        }
        (None, Some(_)) => {
            return Err(bad_query(QueryError::Invalid(
                "on_conflict needs Prefer: resolution=merge-duplicates or ignore-duplicates".into(),
            )));
        }
        (None, None) => None,
    };
    let sql = query::insert(
        &catalog.schema,
        table,
        parse_rows(bytes)?,
        options.representation.then_some(&request.select),
        upsert.as_ref(),
    )
    .map_err(bad_query)?;
    let result = write(pool, claims, sql, options.representation).await?;
    Ok(WriteResult {
        body: result.body,
        rows: result.rows,
        resolution: options.resolution,
    })
}

pub(crate) async fn update(
    pool: &Pool,
    claims: &Claims,
    catalog: &Catalog,
    name: &str,
    pairs: &[(String, String)],
    bytes: &[u8],
    representation: bool,
) -> Result<ChangeResult, ApiError> {
    let table = catalog
        .table(name)
        .ok_or_else(|| not_found("table", name))?;
    let request = query::parse_request_with_relations(pairs, table, catalog).map_err(bad_query)?;
    require_filters(&request)?;
    reject_on_conflict(&request)?;
    reject_paging(&request)?;
    let sql = query::update(
        &catalog.schema,
        table,
        parse_rows(bytes)?,
        &request.filters,
        representation.then_some(&request.select),
    )
    .map_err(bad_query)?;
    write(pool, claims, sql, representation).await
}

pub(crate) async fn remove(
    pool: &Pool,
    claims: &Claims,
    catalog: &Catalog,
    name: &str,
    pairs: &[(String, String)],
    representation: bool,
) -> Result<ChangeResult, ApiError> {
    let table = catalog
        .table(name)
        .ok_or_else(|| not_found("table", name))?;
    let request = query::parse_request_with_relations(pairs, table, catalog).map_err(bad_query)?;
    require_filters(&request)?;
    reject_on_conflict(&request)?;
    reject_paging(&request)?;
    let sql = query::delete(
        &catalog.schema,
        table,
        &request.filters,
        representation.then_some(&request.select),
    );
    write(pool, claims, sql, representation).await
}

pub(crate) async fn rpc(
    pool: &Pool,
    claims: &Claims,
    catalog: &Catalog,
    name: &str,
    bytes: &[u8],
    max_rows: Option<i64>,
) -> Result<Option<String>, ApiError> {
    let candidates = catalog
        .functions
        .get(name)
        .ok_or_else(|| not_found("function", name))?;
    let args = match parse_body(bytes)? {
        Value::Object(args) => args,
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_body",
                "the arguments must be a JSON object",
            ));
        }
    };
    let function = query::resolve_function(candidates, &args).map_err(bad_query)?;
    let sql = query::rpc(&catalog.schema, function, args, max_rows);
    if function.returns_void {
        in_request_tx!(pool, claims, |tx| { execute(&tx, &sql).await });
        return Ok(None);
    }
    let body = in_request_tx!(pool, claims, |tx| {
        let statement = tx.prepare(&sql.text).await?;
        let row = tx.query_one(&statement, &sql.param_refs()).await?;
        Ok::<_, tokio_postgres::Error>(row.get::<_, Option<String>>(0))
    });
    Ok(Some(body.unwrap_or_else(|| "null".into())))
}
