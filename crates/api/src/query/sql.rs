//! SQL generation from the validated request representation.
use super::parse::column;
use super::*;
use std::collections::HashMap;

pub(super) fn qualified(schema: &str, table: &Table) -> String {
    format!("{}.{}", ident(schema), ident(&table.name))
}

/// The select list over the row aliased `alias`. `path` numbers the embeds
/// so nested subqueries get distinct aliases (`_e0`, `_e0_1`...).
pub(super) fn select_list(
    sql: &mut Sql,
    schema: &str,
    select: &Select,
    alias: &str,
    path: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if select.star {
        parts.push(format!("{alias}.*"));
    }
    parts.extend(
        select
            .columns
            .iter()
            .map(|c| format!("{alias}.{}", ident(c))),
    );
    for (n, embed) in select.embeds.iter().enumerate() {
        let path = match path.is_empty() {
            true => n.to_string(),
            false => {
                format!("{path}_{n}")
            }
        };
        parts.push(embed_sql(sql, schema, embed, alias, &path));
    }
    parts.join(", ")
}

/// Correlated subquery for one embedded relation: an object (or null) for
/// many-to-one, an array for one-to-many. It runs with the request's role,
/// so the related table's RLS filters what comes back.
pub(super) fn embed_sql(
    sql: &mut Sql,
    schema: &str,
    embed: &Embed,
    parent: &str,
    path: &str,
) -> String {
    let row = format!("_e{path}");
    let json = format!("_j{path}");
    let columns = select_list(sql, schema, &embed.select, &row, path);
    let mut conditions: Vec<String> = embed
        .join
        .iter()
        .map(|(related, own)| format!("{row}.{} = {parent}.{}", ident(related), ident(own)))
        .collect();
    conditions.extend(
        embed
            .filters
            .iter()
            .map(|condition| condition_sql(sql, &row, condition)),
    );
    let mut rows = format!(
        "SELECT {columns} FROM {}.{} AS {row} WHERE {}{}",
        ident(schema),
        ident(&embed.table),
        conditions.join(" AND "),
        order_clause(&row, &embed.order),
    );
    let limit = match embed.many {
        true => match (embed.limit, sql.embed_limit) {
            (Some(l), Some(m)) => Some(l.min(m)),
            (l, m) => l.or(m),
        },
        false => embed.limit,
    };
    rows.push_str(&paging(sql, limit, embed.offset));
    let checked = sql.json(&json);
    let value = match embed.many {
        true => {
            format!("(SELECT coalesce(json_agg({checked}), '[]') FROM ({rows}) AS {json})")
        }
        false => {
            // The foreign key references a unique key: at most one row.
            format!("(SELECT {checked} FROM ({rows}) AS {json})")
        }
    };
    format!("{value} AS {}", ident(&embed.alias))
}

/// Escapes an element of a Postgres array literal (`{"a","b"}`).
pub(super) fn array_literal(items: &[String]) -> String {
    let escaped: Vec<String> = items
        .iter()
        .map(|item| format!("\"{}\"", item.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("{{{}}}", escaped.join(","))
}

/// Filters on the row aliased `_t` (the request's own table).
pub(super) fn where_clause(sql: &mut Sql, filters: &[Condition]) -> String {
    if filters.is_empty() {
        return String::new();
    }
    let conditions: Vec<String> = filters
        .iter()
        .map(|condition| condition_sql(sql, "_t", condition))
        .collect();
    format!(" WHERE {}", conditions.join(" AND "))
}

/// A tree node on the row aliased `alias`: groups become `(a OR b)` /
/// `(a AND b)`, each wrapped so the precedence never depends on what
/// surrounds it.
pub(super) fn condition_sql(sql: &mut Sql, alias: &str, condition: &Condition) -> String {
    match condition {
        Condition::Filter(filter) => filter_sql(sql, alias, filter),
        Condition::Group { any, negate, items } => {
            let parts: Vec<String> = items
                .iter()
                .map(|item| condition_sql(sql, alias, item))
                .collect();
            let joined = format!(
                "({})",
                parts.join(match *any {
                    true => " OR ",
                    false => " AND ",
                })
            );
            match *negate {
                true => {
                    format!("NOT {joined}")
                }
                false => joined,
            }
        }
    }
}

pub(super) fn filter_sql(sql: &mut Sql, alias: &str, filter: &Filter) -> String {
    let target = format!("{alias}.{}", ident(&filter.column));
    // SQL's character/bit casts default to one element. Their unbounded
    // counterparts compare the entire input, including overlong values.
    let type_name = match filter.type_name.as_str() {
        "character" => "bpchar",
        "character[]" => "bpchar[]",
        "bit" => "bit varying",
        "bit[]" => "bit varying[]",
        name => name,
    };
    let condition = match &filter.op {
        Op::Cmp(op, value) => {
            let p = sql.param(Param::Text(value.clone()));
            format!("{target} {} {p}::text::{type_name}", op.sql())
        }
        Op::Like {
            insensitive,
            pattern,
        } => {
            let p = sql.param(Param::Text(pattern.clone()));
            let op = match *insensitive {
                true => "ILIKE",
                false => "LIKE",
            };
            format!("{target}::text {op} {p}::text")
        }
        Op::In(items) if items.is_empty() => "false".to_owned(),
        Op::In(items) if type_name.ends_with("[]") => {
            let values = items
                .iter()
                .map(|item| {
                    let p = sql.param(Param::Text(item.clone()));
                    format!("{p}::text::{type_name}")
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("{target} IN ({values})")
        }
        Op::In(items) => {
            let p = sql.param(Param::Text(array_literal(items)));
            format!("{target} = ANY({p}::text::{type_name}[])")
        }
        Op::Is(value) => {
            let value = match value {
                IsValue::Null => "NULL",
                IsValue::True => "TRUE",
                IsValue::False => "FALSE",
                IsValue::Unknown => "UNKNOWN",
            };
            format!("{target} IS {value}")
        }
    };
    if filter.negate {
        return format!("NOT ({condition})");
    }
    condition
}

pub(super) fn order_clause(alias: &str, order: &[OrderTerm]) -> String {
    if order.is_empty() {
        return String::new();
    }
    let terms: Vec<String> = order
        .iter()
        .map(|o| {
            let mut term = format!(
                "{alias}.{} {}",
                ident(&o.column),
                match o.desc {
                    true => "DESC",
                    false => "ASC",
                }
            );
            match o.nulls_first {
                Some(true) => term.push_str(" NULLS FIRST"),
                Some(false) => term.push_str(" NULLS LAST"),
                None => {}
            }
            term
        })
        .collect();
    format!(" ORDER BY {}", terms.join(", "))
}

/// `SELECT` returning `(json_text, rows)`; Postgres builds the JSON.
pub fn select(schema: &str, table: &Table, request: &Request, max_rows: Option<i64>) -> Sql {
    select_flagged(schema, table, request, max_rows, &[])
}

/// [`select`] with [`ReadOptions`]. With no option set, the statement is
/// exactly [`select`]'s.
pub fn select_with(
    schema: &str,
    table: &Table,
    request: &Request,
    max_rows: Option<i64>,
    options: &ReadOptions,
) -> Result<Sql, QueryError> {
    let flags = null_flags(table, request, options)?;
    Ok(select_flagged(schema, table, request, max_rows, &flags))
}

/// `_r.column IS NULL` for each of `options.null_flags`, which must name
/// selected columns of `table`.
fn null_flags(
    table: &Table,
    request: &Request,
    options: &ReadOptions,
) -> Result<Vec<String>, QueryError> {
    options
        .null_flags
        .iter()
        .map(|name| {
            let name = &column(table, name)?.name;
            if !request.select.star && !request.select.columns.contains(name) {
                return Err(invalid(format!("null flag for unselected column '{name}'")));
            }
            Ok(format!("_r.{} IS NULL", ident(name)))
        })
        .collect()
}

/// Each row is `to_json(_r)`, or `[to_json(_r), [flags...]]` with `flags`.
fn select_flagged(
    schema: &str,
    table: &Table,
    request: &Request,
    max_rows: Option<i64>,
    flags: &[String],
) -> Sql {
    let max_rows = Some(max_rows.unwrap_or(DEFAULT_MAX_ROWS));
    let mut sql = Sql {
        embed_limit: max_rows,
        ..Sql::default()
    };
    let rows = rows_subquery(&mut sql, schema, table, request, max_rows);
    let row = match flags.is_empty() {
        true => sql.json("_r"),
        false => sql.checked(&format!(
            "json_build_array(to_json(_r), json_build_array({}))",
            flags.join(", ")
        )),
    };
    sql.text = format!("SELECT coalesce(json_agg({row}), '[]')::text, count(*) FROM ({rows}) _r");
    sql
}

/// Page and filtered total in one statement, so concurrent writes cannot split their snapshots.
pub fn select_counted(
    schema: &str,
    table: &Table,
    request: &Request,
    max_rows: Option<i64>,
) -> Sql {
    let mut sql = select(schema, table, request, max_rows);
    let filters = where_clause(&mut sql, &request.filters);
    sql.text = format!(
        "SELECT _page.*, (SELECT count(*) FROM {} AS _t{filters}) FROM ({}) AS _page",
        qualified(schema, table),
        sql.text,
    );
    sql
}

/// One record per result row, as JSON text: for streaming reads (export)
/// without building the whole response in memory.
pub fn select_rows(schema: &str, table: &Table, request: &Request) -> Sql {
    select_rows_flagged(schema, table, request, &[])
}

/// [`select_rows`] with [`ReadOptions`]: with null flags, each record is
/// `[row, [column IS NULL, ...]]`. With no option set, the statement is
/// exactly [`select_rows`]'s.
pub fn select_rows_with(
    schema: &str,
    table: &Table,
    request: &Request,
    options: &ReadOptions,
) -> Result<Sql, QueryError> {
    let flags = null_flags(table, request, options)?;
    Ok(select_rows_flagged(schema, table, request, &flags))
}

/// Each record is `row_to_json(_r)`, or `[row_to_json(_r), [flags...]]`.
fn select_rows_flagged(schema: &str, table: &Table, request: &Request, flags: &[String]) -> Sql {
    let mut sql = Sql {
        checked_json: false,
        embed_limit: None,
        ..Sql::default()
    };
    let rows = rows_subquery(&mut sql, schema, table, request, None);
    let record = match flags.is_empty() {
        true => "row_to_json(_r)".to_owned(),
        false => format!(
            "json_build_array(row_to_json(_r), json_build_array({}))",
            flags.join(", ")
        ),
    };
    sql.text = format!("SELECT {record}::text FROM ({rows}) _r");
    sql
}

/// Columns, filters, ordering and paging of the table (alias `_t`).
pub(super) fn rows_subquery(
    sql: &mut Sql,
    schema: &str,
    table: &Table,
    request: &Request,
    max_rows: Option<i64>,
) -> String {
    let columns = select_list(sql, schema, &request.select, "_t", "");
    let filters = where_clause(sql, &request.filters);
    let order = order_clause("_t", &request.order);
    let limit = match (request.limit, max_rows) {
        (Some(l), Some(m)) => Some(l.min(m)),
        (l, m) => l.or(m),
    };
    let paging = paging(sql, limit, request.offset);
    format!(
        "SELECT {columns} FROM {} AS _t{filters}{order}{paging}",
        qualified(schema, table),
    )
}

/// ` LIMIT $n OFFSET $m`, as far as each is set.
pub(super) fn paging(sql: &mut Sql, limit: Option<i64>, offset: Option<i64>) -> String {
    let mut tail = String::new();
    if let Some(limit) = limit {
        let p = sql.param(Param::Int(limit));
        tail.push_str(&format!(" LIMIT {p}"));
    }
    if let Some(offset) = offset {
        let p = sql.param(Param::Int(offset));
        tail.push_str(&format!(" OFFSET {p}"));
    }
    tail
}

/// Total rows the filters reach (for `Prefer: count=exact`).
pub fn count(schema: &str, table: &Table, request: &Request) -> Sql {
    let mut sql = Sql::default();
    let filters = where_clause(&mut sql, &request.filters);
    sql.text = format!(
        "SELECT count(*) FROM {} AS _t{filters}",
        qualified(schema, table)
    );
    sql
}

/// Wraps a write to return the representation (`Prefer: return=representation`).
pub(super) fn with_representation(
    sql: &mut Sql,
    schema: &str,
    write: String,
    select: &Select,
) -> String {
    format!(
        "WITH _w AS ({write} RETURNING _t.*) \
         SELECT coalesce(json_agg({}), '[]')::text, count(*) FROM (SELECT {} FROM _w AS _t) _r",
        sql.json("_r"),
        select_list(sql, schema, select, "_t", ""),
    )
}

/// Columns of a JSON object body, validated (object keys are unique).
pub(super) fn body_columns(
    table: &Table,
    map: &Map<String, Value>,
) -> Result<Vec<String>, QueryError> {
    map.keys()
        .map(|key| column(table, key).map(|c| c.name.clone()))
        .collect()
}

/// Server-built values split into a JSON body and SQL literals: each
/// [`WriteValue::JsonNull`] column keeps a placeholder in the body (so it is
/// listed) and is written from its literal instead.
struct Values {
    body: Map<String, Value>,
    literals: Vec<(String, &'static str)>,
}

impl Values {
    fn new(table: &Table, values: Vec<(String, WriteValue)>) -> Result<Self, QueryError> {
        let mut body = Map::new();
        let mut literals = Vec::new();
        for (name, value) in values {
            let column = column(table, &name)?;
            if body.contains_key(&column.name) {
                return Err(invalid(format!("column '{name}' is set twice")));
            }
            let value = match value {
                WriteValue::Json(value) => value,
                WriteValue::JsonNull => {
                    literals.push((column.name.clone(), json_null(column)?));
                    Value::Null
                }
            };
            body.insert(column.name.clone(), value);
        }
        Ok(Values { body, literals })
    }
}

/// The JSON `null` literal of a json or jsonb column.
fn json_null(column: &Column) -> Result<&'static str, QueryError> {
    match column.type_name.as_str() {
        "json" => Ok("'null'::json"),
        "jsonb" => Ok("'null'::jsonb"),
        _ => Err(invalid(format!(
            "column '{}' is not json or jsonb: it cannot hold a JSON null",
            column.name
        ))),
    }
}

/// What a write assigns to `column`: its literal, or `fallback`.
fn written(column: &str, fallback: String, literals: &[(String, &'static str)]) -> String {
    match literals.iter().find(|(name, _)| name == column) {
        Some((_, literal)) => (*literal).to_owned(),
        None => fallback,
    }
}

/// Single-row `INSERT` of server-built values (see [`WriteValue`]). Without
/// a [`WriteValue::JsonNull`], the statement is exactly [`insert`]'s.
pub fn insert_values(
    schema: &str,
    table: &Table,
    values: Vec<(String, WriteValue)>,
) -> Result<Sql, QueryError> {
    let Values { body, literals } = Values::new(table, values)?;
    insert_with(schema, table, Value::Object(body), None, None, &literals)
}

/// Single-row `UPDATE` of server-built values (see [`WriteValue`]). Without
/// a [`WriteValue::JsonNull`], the statement is exactly [`update`]'s.
pub fn update_values(
    schema: &str,
    table: &Table,
    values: Vec<(String, WriteValue)>,
    filters: &[Condition],
) -> Result<Sql, QueryError> {
    let Values { body, literals } = Values::new(table, values)?;
    update_with(schema, table, Value::Object(body), filters, None, &literals)
}

/// `INSERT` from JSON: Postgres converts each field to the column type
/// (`json_populate_recordset`).
///
/// Columns missing from an object get the DEFAULT, even in batches with
/// different keys: rows are grouped by column set, and each group becomes an
/// INSERT (CTEs in the same statement, in a single transaction).
pub fn insert(
    schema: &str,
    table: &Table,
    body: Value,
    representation: Option<&Select>,
    upsert: Option<&Upsert>,
) -> Result<Sql, QueryError> {
    insert_with(schema, table, body, representation, upsert, &[])
}

/// [`insert`], writing `literals` instead of the body's fields of those
/// columns (in every row: callers pass them for a single row only).
fn insert_with(
    schema: &str,
    table: &Table,
    body: Value,
    representation: Option<&Select>,
    upsert: Option<&Upsert>,
    literals: &[(String, &'static str)],
) -> Result<Sql, QueryError> {
    let rows = match body {
        Value::Array(rows) => rows,
        object @ Value::Object(_) => vec![object],
        _ => {
            return Err(invalid(
                "the body must be a JSON object or an array of objects",
            ));
        }
    };
    if rows.is_empty() {
        return Err(invalid("nothing to insert"));
    }
    if rows.len() > MAX_BATCH_ROWS {
        return Err(invalid(format!(
            "insert accepts at most {MAX_BATCH_ROWS} rows per request"
        )));
    }
    // Resolve names once per batch. Integer positions canonicalize each set
    // without repeatedly scanning the whole catalog for every row and key.
    let positions: HashMap<&str, usize> = table
        .columns
        .iter()
        .enumerate()
        .map(|(index, column)| (column.name.as_str(), index))
        .collect();
    let mut groups: Vec<(Vec<String>, Vec<Value>)> = Vec::new();
    let mut group_index: HashMap<Vec<usize>, usize> = HashMap::new();
    for row in rows {
        let map = match &row {
            Value::Object(map) => map,
            _ => {
                return Err(invalid(
                    "the body must be a JSON object or an array of objects",
                ));
            }
        };
        let mut columns = map
            .keys()
            .map(|key| {
                positions.get(key.as_str()).copied().ok_or_else(|| {
                    invalid(format!("column '{key}' does not exist in '{}'", table.name))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        columns.sort_unstable();
        match group_index.get(&columns) {
            Some(&index) => {
                groups[index].1.push(row);
            }
            _ => {
                if groups.len() >= MAX_INSERT_GROUPS {
                    return Err(invalid(format!(
                        "insert accepts at most {MAX_INSERT_GROUPS} distinct column sets"
                    )));
                }
                let ordered = columns
                    .iter()
                    .map(|&index| table.columns[index].name.clone())
                    .collect();
                group_index.insert(columns, groups.len());
                groups.push((ordered, vec![row]));
            }
        }
    }

    let target = qualified(schema, table);
    let mut sql = Sql::default();
    let mut statements = Vec::new();
    for (columns, rows) in groups {
        if columns.is_empty() {
            // Empty objects: one all-DEFAULT row for each.
            let conflict = upsert.map(|u| u.clause(&[])).unwrap_or_default();
            for _ in rows {
                statements.push(format!(
                    "INSERT INTO {target} AS _t DEFAULT VALUES{conflict}"
                ));
            }
            continue;
        }
        let list = columns
            .iter()
            .map(|c| ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let source = columns
            .iter()
            .map(|c| written(c, ident(c), literals))
            .collect::<Vec<_>>()
            .join(", ");
        let p = sql.param(Param::Json(Value::Array(rows)));
        let conflict = upsert.map(|u| u.clause(&columns)).unwrap_or_default();
        statements.push(format!(
            "INSERT INTO {target} AS _t ({list}) SELECT {source} FROM json_populate_recordset(NULL::{target}, {p}::json){conflict}"
        ));
    }

    sql.text = match (statements.len(), representation) {
        (1, Some(select)) => with_representation(&mut sql, schema, statements.remove(0), select),
        (1, None) => statements.remove(0),
        (_, Some(select)) => {
            let ctes: Vec<String> = statements
                .iter()
                .enumerate()
                .map(|(i, s)| format!("_w{i} AS ({s} RETURNING _t.*)"))
                .collect();
            let union: Vec<String> = (0..statements.len())
                .map(|i| format!("SELECT * FROM _w{i}"))
                .collect();
            format!(
                "WITH {} SELECT coalesce(json_agg({}), '[]')::text, count(*) FROM (SELECT {} FROM ({}) AS _t) _r",
                ctes.join(", "),
                sql.json("_r"),
                select_list(&mut sql, schema, select, "_t", ""),
                union.join(" UNION ALL "),
            )
        }
        (n, None) => {
            let ctes: Vec<String> = statements
                .iter()
                .enumerate()
                .map(|(i, s)| format!("_w{i} AS ({s})"))
                .collect();
            format!("WITH {} SELECT {n}", ctes.join(", "))
        }
    };
    Ok(sql)
}

/// `UPDATE` with the JSON object's fields, only on the rows the filters (and RLS) allow.
pub fn update(
    schema: &str,
    table: &Table,
    body: Value,
    filters: &[Condition],
    representation: Option<&Select>,
) -> Result<Sql, QueryError> {
    update_with(schema, table, body, filters, representation, &[])
}

/// [`update`], assigning `literals` instead of the body's fields of those columns.
fn update_with(
    schema: &str,
    table: &Table,
    body: Value,
    filters: &[Condition],
    representation: Option<&Select>,
    literals: &[(String, &'static str)],
) -> Result<Sql, QueryError> {
    let map = match body {
        Value::Object(map) => map,
        _ => {
            return Err(invalid("the PATCH body must be a JSON object"));
        }
    };
    let columns = body_columns(table, &map)?;
    if columns.is_empty() {
        return Err(invalid("the PATCH body has no columns"));
    }
    let target = qualified(schema, table);
    let mut sql = Sql::default();
    let p = sql.param(Param::Json(Value::Object(map)));
    let assignments = columns
        .iter()
        .map(|c| {
            format!(
                "{} = {}",
                ident(c),
                written(c, format!("_b.{}", ident(c)), literals)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let filters = where_clause(&mut sql, filters);
    let write = format!(
        "UPDATE {target} AS _t SET {assignments} FROM json_populate_record(NULL::{target}, {p}::json) AS _b{filters}"
    );
    sql.text = match representation {
        Some(select) => with_representation(&mut sql, schema, write, select),
        None => write,
    };
    Ok(sql)
}

pub fn delete(
    schema: &str,
    table: &Table,
    filters: &[Condition],
    representation: Option<&Select>,
) -> Sql {
    let mut sql = Sql::default();
    let filters = where_clause(&mut sql, filters);
    let write = format!("DELETE FROM {} AS _t{filters}", qualified(schema, table));
    sql.text = match representation {
        Some(select) => with_representation(&mut sql, schema, write, select),
        None => write,
    };
    sql
}

/// Picks the overload whose arguments match the body's keys.
pub fn resolve_function<'a>(
    candidates: &'a [Function],
    args: &Map<String, Value>,
) -> Result<&'a Function, QueryError> {
    candidates
        .iter()
        .filter(|f| {
            args.keys().all(|k| f.args.iter().any(|a| &a.name == k))
                && f.args
                    .iter()
                    .all(|a| a.has_default || args.contains_key(&a.name))
        })
        .min_by_key(|f| f.args.len())
        .ok_or_else(|| invalid("the arguments match no signature of the function"))
}

/// Function call with named arguments, converted by Postgres from the JSON
/// (`json_to_record`).
pub fn rpc(
    schema: &str,
    function: &Function,
    args: Map<String, Value>,
    max_rows: Option<i64>,
) -> Sql {
    let mut sql = Sql::default();
    let used: Vec<_> = function
        .args
        .iter()
        .filter(|a| args.contains_key(&a.name))
        .collect();
    let call_args = used
        .iter()
        .map(|a| format!("{0} => _a.{0}", ident(&a.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let call = format!("{}.{}({call_args})", ident(schema), ident(&function.name));
    let source = match used.is_empty() {
        true => None,
        false => {
            let definition = used
                .iter()
                .map(|a| format!("{} {}", ident(&a.name), a.type_name))
                .collect::<Vec<_>>()
                .join(", ");
            let p = sql.param(Param::Json(Value::Object(args)));
            Some(format!("json_to_record({p}::json) AS _a({definition})"))
        }
    };
    sql.text = match (function.returns_set, function.returns_void, source) {
        (true, _, source) => {
            let from = source
                .map(|s| format!("{s}, LATERAL {call} AS _r"))
                .unwrap_or_else(|| format!("{call} AS _r"));
            let limit = sql.param(Param::Int(max_rows.unwrap_or(DEFAULT_MAX_ROWS)));
            format!(
                "SELECT coalesce(json_agg({}), '[]')::text FROM (SELECT _r AS _value FROM {from} LIMIT {limit}) _limited",
                sql.json("_value")
            )
        }
        (false, true, Some(source)) => format!("SELECT {call}::text FROM {source}"),
        (false, true, None) => format!("SELECT {call}::text"),
        (false, false, Some(source)) => format!("SELECT {}::text FROM {source}", sql.json(&call)),
        (false, false, None) => format!("SELECT {}::text", sql.json(&call)),
    };
    sql
}
