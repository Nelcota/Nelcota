//! Translation of the URL (PostgREST style) into parameterized SQL.
//!
//! Security rules, checked by the injection tests:
//! - identifiers (table, column, function) only reach SQL if they exist in the
//!   catalog, and always double-quoted ([`ident`]);
//! - types used in casts come from the catalog (`format_type`), never the URL;
//! - every user-supplied value is a parameter (`$n`), never SQL text.
//!
//! Values arrive as text and Postgres converts them to the column type
//! (`$1::text::integer`): type validation is its job, as with a literal.

use std::error::Error;

use bytes::BytesMut;
use serde_json::{Map, Value};
use tokio_postgres::types::{IsNull, ToSql, Type, to_sql_checked};

use crate::catalog::{Catalog, Column, ForeignKey, Function, Table};

#[derive(Debug, thiserror::Error)]
pub enum QueryError {
    #[error("{0}")]
    Invalid(String),
}

fn invalid(message: impl Into<String>) -> QueryError {
    QueryError::Invalid(message.into())
}

/// Quoted identifier, with inner quotes doubled (libpq's rules).
pub fn ident(name: &str) -> String {
    postgres_protocol::escape::escape_identifier(name)
}

// ------------------------------------------------------------------ parameters

#[derive(Debug)]
pub enum Param {
    Text(String),
    Int(i64),
    Json(Value),
}

impl ToSql for Param {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        match self {
            Param::Text(v) => v.to_sql_checked(ty, out),
            Param::Int(v) => v.to_sql_checked(ty, out),
            Param::Json(v) => v.to_sql_checked(ty, out),
        }
    }

    fn accepts(_: &Type) -> bool {
        // The real check happens in the inner value's `to_sql_checked`.
        true
    }

    to_sql_checked!();
}

/// SQL under construction + its parameters.
#[derive(Debug)]
pub struct Sql {
    pub text: String,
    pub params: Vec<Param>,
    embed_limit: Option<i64>,
    checked_json: bool,
}

pub const DEFAULT_MAX_ROWS: i64 = 1000;
pub const MAX_JSON_BYTES: i64 = 8 * 1024 * 1024;
pub const MAX_BATCH_ROWS: usize = 1000;
const MAX_INSERT_GROUPS: usize = 128;
const MAX_SELECT_ITEMS: usize = 128;

impl Default for Sql {
    fn default() -> Self {
        Self {
            text: String::new(),
            params: Vec::new(),
            embed_limit: Some(DEFAULT_MAX_ROWS),
            checked_json: true,
        }
    }
}

impl Sql {
    fn json(&self, expression: &str) -> String {
        self.checked(&format!("to_json({expression})"))
    }
    /// `json` (already a JSON expression), size-checked when the statement
    /// checks its output.
    fn checked(&self, json: &str) -> String {
        if self.checked_json {
            return format!("extensions.nelcota_check_json({json}, {MAX_JSON_BYTES})");
        }
        json.to_owned()
    }
    fn param(&mut self, param: Param) -> String {
        self.params.push(param);
        format!("${}", self.params.len())
    }

    pub fn param_refs(&self) -> Vec<&(dyn ToSql + Sync)> {
        self.params
            .iter()
            .map(|p| p as &(dyn ToSql + Sync))
            .collect()
    }
}

// ------------------------------------------------------------------ request

/// What `select=` asks for: `*` and/or columns, plus embedded relations.
#[derive(Clone, Debug, PartialEq)]
pub struct Select {
    pub star: bool,
    pub columns: Vec<String>,
    pub embeds: Vec<Embed>,
}

impl Select {
    /// No `select=`: every column, no relations.
    pub fn all() -> Self {
        Select {
            star: true,
            columns: Vec::new(),
            embeds: Vec::new(),
        }
    }
}

/// `(related column, this table's column)` pairs of a foreign key, ANDed.
pub type JoinPairs = Vec<(String, String)>;

/// A related table embedded through a foreign key (`customers(name)`), with
/// its own columns, nested embeds and, through `items.qty=gt.1`-style
/// parameters, its own filters, ordering and paging.
#[derive(Clone, Debug, PartialEq)]
pub struct Embed {
    /// Key of the embedded value in the JSON (the table name or `alias:`).
    pub alias: String,
    /// The related table.
    pub table: String,
    /// `true` when the related table points here (one-to-many, an array);
    /// `false` when this table points there (many-to-one, an object or null).
    pub many: bool,
    pub join: JoinPairs,
    pub select: Select,
    /// Narrow the embedded rows only; the parent rows stay.
    pub filters: Vec<Condition>,
    pub order: Vec<OrderTerm>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Longest identifier Postgres keeps (longer aliases would be cut silently).
const MAX_IDENTIFIER_BYTES: usize = 63;
/// Deepest embedding accepted (`a(b(c(d(*))))`): bounds the recursion and
/// the correlated subqueries a single request can stack.
const MAX_EMBED_DEPTH: usize = 4;
/// Most embedded relations one request may ask for, nested ones included.
/// Each is a correlated subquery per parent row, so this bounds how much
/// work a single read stacks onto one connection.
const MAX_EMBEDS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
enum CmpOp {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
}

impl CmpOp {
    fn sql(self) -> &'static str {
        match self {
            CmpOp::Eq => "=",
            CmpOp::Neq => "<>",
            CmpOp::Gt => ">",
            CmpOp::Gte => ">=",
            CmpOp::Lt => "<",
            CmpOp::Lte => "<=",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum IsValue {
    Null,
    True,
    False,
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
enum Op {
    Cmp(CmpOp, String),
    Like { insensitive: bool, pattern: String },
    In(Vec<String>),
    Is(IsValue),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Filter {
    column: String,
    /// The column's type, for the parameter cast.
    type_name: String,
    negate: bool,
    op: Op,
}

/// One filter, or a parenthesized group joined by OR/AND (`or=(...)`,
/// `and=(...)`, optionally negated), nested as a tree.
#[derive(Clone, Debug, PartialEq)]
pub enum Condition {
    Filter(Filter),
    Group {
        /// `true` joins the items with OR, `false` with AND.
        any: bool,
        negate: bool,
        items: Vec<Condition>,
    },
}

/// Deepest nesting accepted in `or=`/`and=`: bounds the recursion on hostile input.
const MAX_DEPTH: usize = 8;
/// Most conditions accepted in one logic tree.
const MAX_CONDITIONS: usize = 100;

#[derive(Clone, Debug, PartialEq)]
pub struct OrderTerm {
    column: String,
    desc: bool,
    nulls_first: Option<bool>,
}

/// What the query string asks for: columns, filters, ordering and paging.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub select: Select,
    /// Joined with AND, like separate query parameters.
    pub filters: Vec<Condition>,
    pub order: Vec<OrderTerm>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// `on_conflict=col1,col2`: the unique key an upsert resolves on.
    pub on_conflict: Option<Vec<String>>,
}

/// What `Prefer: resolution=...` asks a POST to do with a row whose key
/// already exists.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Resolution {
    /// `merge-duplicates`: update the existing row with the sent columns.
    Merge,
    /// `ignore-duplicates`: keep the existing row.
    Ignore,
}

/// `INSERT ... ON CONFLICT (columns)` and what to do on a conflict.
#[derive(Clone, Debug, PartialEq)]
pub struct Upsert {
    pub columns: Vec<String>,
    pub resolution: Resolution,
}

impl Upsert {
    /// Conflict target: `on_conflict` when given, else the primary key.
    pub fn new(
        table: &Table,
        on_conflict: Option<&[String]>,
        resolution: Resolution,
    ) -> Result<Self, QueryError> {
        let columns = match on_conflict {
            Some(columns) => columns.to_vec(),
            None if !table.primary_key.is_empty() => table.primary_key.clone(),
            None => {
                return Err(invalid(
                    "upsert needs a primary key or on_conflict=col1,col2",
                ));
            }
        };
        Ok(Upsert {
            columns,
            resolution,
        })
    }

    /// Merge updates only the columns the row sent, never the key itself;
    /// with nothing left to update, a merge behaves like ignore.
    fn clause(&self, columns: &[String]) -> String {
        let target = self
            .columns
            .iter()
            .map(|c| ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let updates: Vec<String> = columns
            .iter()
            .filter(|c| !self.columns.contains(c))
            .map(|c| format!("{0} = EXCLUDED.{0}", ident(c)))
            .collect();
        match self.resolution {
            Resolution::Merge if !updates.is_empty() => {
                format!(
                    " ON CONFLICT ({target}) DO UPDATE SET {}",
                    updates.join(", ")
                )
            }
            _ => format!(" ON CONFLICT ({target}) DO NOTHING"),
        }
    }
}

/// Options of [`select_with`] that the REST API never sets: they serve
/// server-side callers (the admin table editor) and change the row shape.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReadOptions {
    /// Columns reported as `IS NULL` flags: each row becomes
    /// `[row, [column IS NULL, ...]]`, in this order. `to_json` renders SQL
    /// NULL and a json/jsonb `null` alike; the flag tells them apart.
    pub null_flags: Vec<String>,
}

/// A column value of a write built by the server rather than parsed from a
/// REST body.
#[derive(Clone, Debug, PartialEq)]
pub enum WriteValue {
    /// Converted by Postgres from JSON, like a REST body field: a JSON
    /// `null` becomes SQL NULL.
    Json(Value),
    /// The JSON value `null` stored in a json/jsonb column, which is not SQL
    /// NULL and which a REST body cannot express.
    JsonNull,
}

mod parse;
mod sql;
#[cfg(test)]
use parse::*;
pub use parse::{parse_request, parse_request_with_relations};
#[cfg(test)]
use sql::*;
pub use sql::{
    count, delete, insert, insert_values, resolve_function, rpc, select, select_counted,
    select_rows, select_rows_with, select_with, update, update_values,
};

/// A structured transport's literal catalog column, not a URL modifier.
pub fn column_filter(table: &Table, name: &str, value: &str) -> Result<Condition, QueryError> {
    parse::parse_filter(table, name, value).map(Condition::Filter)
}

/// Validates an entire column name without interpreting dots/commas as syntax.
pub fn column_order(table: &Table, name: &str, desc: bool) -> Result<OrderTerm, QueryError> {
    Ok(OrderTerm {
        column: parse::column(table, name)?.name.clone(),
        desc,
        nulls_first: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{Privileges, TableKind};
    use serde_json::json;

    fn col(name: &str, type_name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: type_name.into(),
            full_type: type_name.into(),
            category: 'S',
            element_type: None,
            enum_values: vec![],
            nullable: true,
            has_default: false,
            generated: false,
            comment: None,
            privileges: Default::default(),
        }
    }

    fn table() -> Table {
        Table {
            name: "todos".into(),
            kind: TableKind::Table,
            columns: vec![
                col("id", "bigint"),
                col("title", "text"),
                col("done", "boolean"),
            ],
            primary_key: vec!["id".into()],
            foreign_keys: vec![],
            rls_enabled: true,
            rls_forced: false,
            security_invoker: false,
            comment: None,
            privileges: [Privileges::default(); 3],
        }
    }

    fn pairs(q: &[(&str, &str)]) -> Vec<(String, String)> {
        q.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn select_with_filters_order_and_paging() {
        let t = table();
        let req = parse_request(
            &pairs(&[
                ("select", "id,title"),
                ("done", "is.false"),
                ("id", "gte.10"),
                ("title", "not.ilike.*compr*"),
                ("order", "id.desc.nullslast"),
                ("limit", "5"),
                ("offset", "10"),
            ]),
            &t,
        )
        .unwrap();
        let sql = select("public", &t, &req, Some(1000));
        assert_eq!(
            sql.text,
            "SELECT coalesce(json_agg(extensions.nelcota_check_json(to_json(_r), 8388608)), '[]')::text, count(*) FROM (SELECT _t.\"id\", _t.\"title\" \
             FROM \"public\".\"todos\" AS _t WHERE _t.\"done\" IS FALSE AND _t.\"id\" >= $1::text::bigint \
             AND NOT (_t.\"title\"::text ILIKE $2::text) ORDER BY _t.\"id\" DESC NULLS LAST LIMIT $3 OFFSET $4) _r"
        );
        assert_eq!(sql.params.len(), 4);
        assert!(matches!(&sql.params[1], Param::Text(p) if p == "%compr%"));
    }

    #[test]
    fn select_rows_returns_one_json_record_per_row() {
        let t = table();
        let req = parse_request(&pairs(&[("done", "eq.true"), ("order", "id")]), &t).unwrap();
        let sql = select_rows("public", &t, &req);
        assert_eq!(
            sql.text,
            "SELECT row_to_json(_r)::text FROM (SELECT _t.* FROM \"public\".\"todos\" AS _t \
             WHERE _t.\"done\" = $1::text::boolean ORDER BY _t.\"id\" ASC) _r"
        );
        assert_eq!(sql.params.len(), 1);
    }

    #[test]
    fn max_rows_caps_the_limit() {
        let t = table();
        let req = parse_request(&pairs(&[("limit", "5000")]), &t).unwrap();
        let sql = select("public", &t, &req, Some(100));
        assert!(matches!(sql.params[0], Param::Int(100)));
    }

    #[test]
    fn bounded_batches_and_unique_projections() {
        let t = table();
        assert!(parse_request(&pairs(&[("select", "id,id")]), &t).is_err());
        let request = parse_request(&pairs(&[("select", "*,id")]), &t).unwrap();
        assert!(request.select.columns.is_empty());
        let sql = select("public", &t, &request, None);
        assert!(matches!(
            sql.params.last(),
            Some(Param::Int(DEFAULT_MAX_ROWS))
        ));
        assert!(
            insert(
                "public",
                &t,
                Value::Array(vec![serde_json::json!({}); MAX_BATCH_ROWS + 1]),
                None,
                None
            )
            .is_err()
        );
        assert!(
            insert(
                "public",
                &t,
                Value::Array(vec![serde_json::json!({}); MAX_BATCH_ROWS]),
                None,
                None
            )
            .is_ok()
        );
    }

    #[test]
    fn heterogeneous_batch_complexity_is_bounded() {
        let mut t = table();
        for n in 0..8 {
            let mut col = t.columns[0].clone();
            col.name = format!("field{n}");
            t.columns.push(col);
        }
        let rows = (0..129)
            .map(|bits| {
                let mut row = Map::new();
                for n in 0..8 {
                    if bits & (1 << n) != 0 {
                        row.insert(format!("field{n}"), Value::Null);
                    }
                }
                Value::Object(row)
            })
            .collect::<Vec<_>>();
        assert!(insert("public", &t, Value::Array(rows[..128].to_vec()), None, None).is_ok());
        assert!(
            insert("public", &t, Value::Array(rows), None, None)
                .unwrap_err()
                .to_string()
                .contains("distinct column sets")
        );
    }

    #[test]
    fn unknown_identifiers_are_rejected() {
        let t = table();
        for q in [
            ("select", "id,\"title\""),
            ("select", "id;drop table todos"),
            ("select", "todos(*)"),
            ("order", "title;drop table todos"),
            ("order", "id.sideways"),
            ("x\"; drop table todos; --", "eq.1"),
            ("title", "eq"),
            ("title", "foo.1"),
            ("limit", "-1"),
            ("limit", "1;drop"),
            ("title", "is.nothing"),
            ("title", "in.(a,\"b)"),
        ] {
            assert!(parse_request(&pairs(&[q]), &t).is_err(), "{q:?}");
        }
    }

    #[test]
    fn values_become_parameters() {
        let t = table();
        let malicious = "'; DROP TABLE todos; --";
        let req = parse_request(&pairs(&[("title", &format!("eq.{malicious}"))]), &t).unwrap();
        let sql = select("public", &t, &req, None);
        assert!(!sql.text.contains("DROP"));
        assert!(matches!(&sql.params[0], Param::Text(p) if p == malicious));
    }

    #[test]
    fn in_list_with_quotes_and_escapes() {
        assert_eq!(
            parse_in_list(r#"(1, 2,"a,b","x\"y",)"#).unwrap(),
            vec!["1", "2", "a,b", "x\"y", ""]
        );
        assert_eq!(parse_in_list("()").unwrap(), Vec::<String>::new());
        assert_eq!(
            array_literal(&["a\"b".into(), "c\\d".into()]),
            r#"{"a\"b","c\\d"}"#
        );
    }

    #[test]
    fn ident_doubles_quotes() {
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
        // Backslashes and non-ASCII pass through untouched (no E'' form for identifiers).
        assert_eq!(ident("a\\b"), "\"a\\b\"");
        assert_eq!(ident("café"), "\"café\"");
        assert_eq!(ident(""), "\"\"");
        assert_eq!(
            ident("x\"; drop table t; --"),
            "\"x\"\"; drop table t; --\""
        );
    }

    #[test]
    fn insert_rejects_unknown_columns() {
        let t = table();
        let body = serde_json::json!({"title": "x", "\"; drop table todos; --": 1});
        assert!(insert("public", &t, body, None, None).is_err());
        let sql = insert(
            "public",
            &t,
            serde_json::json!([{"title": "a"}, {"title": "b"}]),
            None,
            None,
        )
        .unwrap();
        assert!(
            sql.text
                .starts_with("INSERT INTO \"public\".\"todos\" AS _t (\"title\")")
        );
        // Different keys: one INSERT per group, so the DEFAULT applies.
        let sql = insert(
            "public",
            &t,
            serde_json::json!([{"title": "a"}, {"done": true}, {}]),
            None,
            None,
        )
        .unwrap();
        assert!(sql.text.starts_with("WITH _w0 AS (INSERT"), "{}", sql.text);
        assert!(sql.text.contains("DEFAULT VALUES"));
        assert_eq!(sql.params.len(), 2);
    }

    #[test]
    fn repeated_insert_sets_keep_catalog_order_and_first_group_order() {
        let mut t = table();
        t.columns.swap(0, 1);
        let sql = insert(
            "public",
            &t,
            serde_json::json!([
                {"id":1,"title":"a"}, {"done":true}, {"title":"b","id":2}, {}, {"done":false}
            ]),
            None,
            None,
        )
        .unwrap();
        assert!(sql.text.starts_with(
            "WITH _w0 AS (INSERT INTO \"public\".\"todos\" AS _t (\"title\", \"id\")"
        ));
        assert!(
            sql.text
                .contains("_w1 AS (INSERT INTO \"public\".\"todos\" AS _t (\"done\")")
        );
        assert!(
            sql.text.contains(
                "_w2 AS (INSERT INTO \"public\".\"todos\" AS _t DEFAULT VALUES) SELECT 3"
            )
        );
        assert!(
            matches!(&sql.params[..], [Param::Json(first), Param::Json(second)]
            if first == &serde_json::json!([{"id":1,"title":"a"},{"title":"b","id":2}])
            && second == &serde_json::json!([{"done":true},{"done":false}]))
        );
        for bad in [
            serde_json::json!([{"title":"a"},{"absent":1}]),
            serde_json::json!([{"title":"a"},false]),
        ] {
            assert!(insert("public", &t, bad, None, None).is_err());
        }
    }

    #[test]
    fn wide_catalog_batches_keep_only_the_supplied_columns() {
        let mut t = table();
        t.columns = (0..1600)
            .rev()
            .map(|n| col(&format!("c{n:04}"), "integer"))
            .collect();
        let row = (1500..1600)
            .map(|n| (format!("c{n:04}"), Value::from(n)))
            .collect::<Map<_, _>>();
        let body = Value::Array(vec![Value::Object(row); MAX_BATCH_ROWS]);
        let sql = insert("public", &t, body.clone(), None, None).unwrap();
        let columns = (1500..1600)
            .rev()
            .map(|n| ident(&format!("c{n:04}")))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(sql.text.starts_with(&format!(
            "INSERT INTO \"public\".\"todos\" AS _t ({columns}) SELECT {columns}"
        )));
        assert!(matches!(&sql.params[..], [Param::Json(rows)] if rows == &body));
    }

    // ------------------------------------------------------------- or / and

    fn where_of(q: &[(&str, &str)]) -> (String, Vec<String>) {
        let t = table();
        let req = parse_request(&pairs(q), &t).unwrap();
        let sql = count("public", &t, &req);
        let params = sql
            .params
            .iter()
            .map(|p| match p {
                Param::Text(v) => v.clone(),
                other => format!("{other:?}"),
            })
            .collect();
        let text = sql
            .text
            .split(" WHERE ")
            .nth(1)
            .unwrap_or_default()
            .to_owned();
        (text, params)
    }

    #[test]
    fn or_joins_its_items_and_ands_with_other_filters() {
        let (text, params) = where_of(&[("or", "(title.eq.a,title.eq.b)"), ("done", "is.false")]);
        assert_eq!(
            text,
            "(_t.\"title\" = $1::text::text OR _t.\"title\" = $2::text::text) AND _t.\"done\" IS FALSE"
        );
        assert_eq!(params, ["a", "b"]);
    }

    #[test]
    fn groups_nest_and_negate() {
        let (text, params) = where_of(&[("or", "(id.eq.1,and(done.is.true,title.not.like.*x*))")]);
        assert_eq!(
            text,
            "(_t.\"id\" = $1::text::bigint OR (_t.\"done\" IS TRUE AND NOT (_t.\"title\"::text LIKE $2::text)))"
        );
        assert_eq!(params, ["1", "%x%"]);

        let (text, _) = where_of(&[("not.and", "(id.gt.1,not.or(done.is.true,id.lt.0))")]);
        assert_eq!(
            text,
            "NOT (_t.\"id\" > $1::text::bigint AND NOT (_t.\"done\" IS TRUE OR _t.\"id\" < $2::text::bigint))"
        );
    }

    #[test]
    fn quoted_values_may_hold_commas_and_parentheses() {
        let (_, params) = where_of(&[(
            "or",
            r#"(title.eq."a,b",title.eq."f(x)",title.eq."say \"hi\"",title.in.("x,y",z))"#,
        )]);
        assert_eq!(params, ["a,b", "f(x)", "say \"hi\"", r#"{"x,y","z"}"#]);
    }

    #[test]
    fn logic_values_stay_parameters() {
        let malicious = "x') OR true; DROP TABLE todos; --";
        let (text, params) = where_of(&[("or", &format!("(title.eq.\"{malicious}\",id.eq.1)"))]);
        assert!(!text.contains("DROP"), "{text}");
        assert_eq!(params[0], malicious);
    }

    #[test]
    fn malformed_or_hostile_trees_are_rejected() {
        let t = table();
        let deep = format!(
            "({}id.eq.1{})",
            "or(".repeat(MAX_DEPTH),
            ")".repeat(MAX_DEPTH)
        );
        let wide = format!("({})", vec!["id.eq.1"; MAX_CONDITIONS + 1].join(","));
        for (key, value) in [
            ("or", "title.eq.a"),                // no parentheses
            ("or", "()"),                        // empty
            ("or", "(title.eq.a,)"),             // empty item
            ("or", "(title.eq.a"),               // unbalanced
            ("or", "(title.eq.\"a)"),            // unclosed quote
            ("or", "(nope.eq.1)"),               // unknown column
            ("or", "(title)"),                   // no operator
            ("or", "(title.eq.a,xor(id.eq.1))"), // not a group keyword
            ("and", "(\"x\"\"; drop table todos; --\".eq.1)"),
            ("or", deep.as_str()),
            ("or", wide.as_str()),
        ] {
            assert!(
                parse_request(&pairs(&[(key, value)]), &t).is_err(),
                "{key}={value}"
            );
        }
        // The deepest accepted tree still parses.
        let ok = format!(
            "({}id.eq.1{})",
            "or(".repeat(MAX_DEPTH - 1),
            ")".repeat(MAX_DEPTH - 1)
        );
        assert!(parse_request(&pairs(&[("or", &ok)]), &t).is_ok());
    }

    // ------------------------------------------------------------- upsert

    fn upsert_sql(body: serde_json::Value, upsert: &Upsert) -> String {
        insert("public", &table(), body, None, Some(upsert))
            .unwrap()
            .text
    }

    #[test]
    fn merge_updates_only_the_sent_columns_never_the_key() {
        let t = table();
        let merge = Upsert::new(&t, None, Resolution::Merge).unwrap();
        assert_eq!(merge.columns, ["id"]);
        let text = upsert_sql(serde_json::json!({"id": 1, "title": "a"}), &merge);
        assert!(
            text.ends_with(" ON CONFLICT (\"id\") DO UPDATE SET \"title\" = EXCLUDED.\"title\""),
            "{text}"
        );
        // Only the key sent: nothing to update, so the row is kept.
        let text = upsert_sql(serde_json::json!({"id": 1}), &merge);
        assert!(text.ends_with(" ON CONFLICT (\"id\") DO NOTHING"), "{text}");
    }

    #[test]
    fn ignore_keeps_the_existing_row_and_groups_each_get_the_clause() {
        let t = table();
        let ignore = Upsert::new(&t, None, Resolution::Ignore).unwrap();
        let text = upsert_sql(
            serde_json::json!([{"id": 1, "title": "a"}, {"id": 2, "done": true}]),
            &ignore,
        );
        assert_eq!(
            text.matches(" ON CONFLICT (\"id\") DO NOTHING").count(),
            2,
            "{text}"
        );
    }

    #[test]
    fn on_conflict_picks_the_key() {
        let t = table();
        let req = parse_request(&pairs(&[("on_conflict", "title, done")]), &t).unwrap();
        let cols = req.on_conflict.unwrap();
        assert_eq!(cols, ["title", "done"]);
        let merge = Upsert::new(&t, Some(&cols), Resolution::Merge).unwrap();
        let text = upsert_sql(
            serde_json::json!({"title": "a", "done": true, "id": 3}),
            &merge,
        );
        assert!(
            text.ends_with(
                " ON CONFLICT (\"title\", \"done\") DO UPDATE SET \"id\" = EXCLUDED.\"id\""
            ),
            "{text}"
        );
    }

    #[test]
    fn bad_upsert_requests_are_rejected() {
        let t = table();
        for value in [
            "",
            "title,",
            "nope",
            "title,title",
            "\"id\"; drop table todos",
        ] {
            assert!(
                parse_request(&pairs(&[("on_conflict", value)]), &t).is_err(),
                "{value}"
            );
        }
        let mut no_pk = table();
        no_pk.primary_key.clear();
        assert!(Upsert::new(&no_pk, None, Resolution::Merge).is_err());
        assert!(Upsert::new(&no_pk, Some(&["title".to_owned()]), Resolution::Merge).is_ok());
    }

    // ------------------------------------------------------------- embedding

    fn fk(name: &str, columns: &[&str], table: &str, foreign: &[&str]) -> ForeignKey {
        ForeignKey {
            name: name.into(),
            columns: columns.iter().map(|c| (*c).into()).collect(),
            foreign_schema: "public".into(),
            foreign_table: table.into(),
            foreign_columns: foreign.iter().map(|c| (*c).into()).collect(),
        }
    }

    fn shop() -> Catalog {
        let mut customers = table();
        customers.name = "customers".into();
        customers.columns = vec![col("id", "bigint"), col("name", "text")];
        let mut orders = table();
        orders.name = "orders".into();
        orders.columns = vec![
            col("id", "bigint"),
            col("buyer_id", "bigint"),
            col("seller_id", "bigint"),
            col("customer_id", "bigint"),
            col("total", "numeric"),
        ];
        orders.foreign_keys = vec![
            fk(
                "orders_customer_id_fkey",
                &["customer_id"],
                "customers",
                &["id"],
            ),
            fk("orders_buyer_id_fkey", &["buyer_id"], "users", &["id"]),
            fk("orders_seller_id_fkey", &["seller_id"], "users", &["id"]),
        ];
        let mut items = table();
        items.name = "items".into();
        items.columns = vec![
            col("id", "bigint"),
            col("order_id", "bigint"),
            col("qty", "integer"),
        ];
        items.foreign_keys = vec![fk("items_order_id_fkey", &["order_id"], "orders", &["id"])];
        let mut users = table();
        users.name = "users".into();
        users.columns = vec![col("id", "bigint"), col("email", "text")];
        Catalog {
            schema: "public".into(),
            tables: [customers, orders, items, users]
                .into_iter()
                .map(|t| (t.name.clone(), t))
                .collect(),
            functions: Default::default(),
            named_types: Default::default(),
        }
    }

    fn select_of(table: &str, select: &str) -> Result<(Select, String), QueryError> {
        let catalog = shop();
        let t = catalog.table(table).unwrap();
        let req = parse_request_with_relations(&pairs(&[("select", select)]), t, &catalog)?;
        let sql = super::select("public", t, &req, None);
        Ok((req.select, sql.text))
    }

    #[test]
    fn embeds_follow_foreign_keys_in_both_directions() {
        let (select, text) = select_of("orders", "id,customers(name),items(*)").unwrap();
        assert_eq!(select.columns, ["id"]);
        let customer = &select.embeds[0];
        assert_eq!(
            (customer.many, &customer.join),
            (false, &vec![("id".to_owned(), "customer_id".to_owned())])
        );
        let items = &select.embeds[1];
        assert_eq!(
            (items.many, &items.join),
            (true, &vec![("order_id".to_owned(), "id".to_owned())])
        );
        assert!(text.contains(
            "(SELECT extensions.nelcota_check_json(to_json(_j0), 8388608) FROM (SELECT _e0.\"name\" FROM \"public\".\"customers\" AS _e0 WHERE _e0.\"id\" = _t.\"customer_id\") AS _j0) AS \"customers\""
        ), "{text}");
        assert!(text.contains(
            "(SELECT coalesce(json_agg(extensions.nelcota_check_json(to_json(_j1), 8388608)), '[]') FROM (SELECT _e1.* FROM \"public\".\"items\" AS _e1 WHERE _e1.\"order_id\" = _t.\"id\" LIMIT $1) AS _j1) AS \"items\""
        ), "{text}");
    }

    #[test]
    fn several_keys_need_a_hint_and_aliases_name_the_result() {
        let err = select_of("orders", "users(email)").unwrap_err().to_string();
        assert!(err.contains("users!buyer_id or users!seller_id"), "{err}");
        let (select, _) = select_of(
            "orders",
            "buyer:users!buyer_id(email),seller:users!orders_seller_id_fkey(email)",
        )
        .unwrap();
        let picked: Vec<(&str, &str)> = select
            .embeds
            .iter()
            .map(|e| (e.alias.as_str(), e.join[0].1.as_str()))
            .collect();
        assert_eq!(picked, [("buyer", "buyer_id"), ("seller", "seller_id")]);
    }

    #[test]
    fn embed_keys_cannot_take_the_generated_sql_names() {
        let err = select_of("orders", "id,_r:customers(name)")
            .unwrap_err()
            .to_string();
        assert!(err.contains("cannot start with '_'"), "{err}");
        assert!(select_of("orders", "id,r_:customers(name)").is_ok());
    }

    #[test]
    fn a_request_embeds_a_bounded_number_of_relations() {
        fn embeds(n: usize, table: &str) -> String {
            (0..n)
                .map(|i| format!("e{i}:{table}"))
                .collect::<Vec<_>>()
                .join(",")
        }
        let flat = embeds(MAX_EMBEDS, "customers(name)");
        assert!(select_of("orders", &flat).is_ok());
        let err = select_of("orders", &format!("{flat},items(*)"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("at most 16 relations"), "{err}");
        // Nested embeds count towards the same budget.
        let nested = format!("orders(id,{})", embeds(MAX_EMBEDS - 1, "items(qty)"));
        assert!(select_of("customers", &nested).is_ok());
        let nested = format!("orders(id,{})", embeds(MAX_EMBEDS, "items(qty)"));
        assert!(select_of("customers", &nested).is_err());
    }

    #[test]
    fn bad_embeds_are_rejected() {
        let long = format!("{}:customers(name)", "a".repeat(64));
        for (table, select) in [
            ("orders", "nope(id)"),        // unknown table
            ("customers", "users(email)"), // no foreign key
            ("orders", "customers(nope)"), // unknown column
            (
                "customers",
                "orders(customers(orders(customers(orders(id)))))",
            ), // too deep
            ("orders", "customers(name"),  // unbalanced
            ("orders", "customers()"),     // empty list
            ("orders", "users!nope(email)"), // hint matches nothing
            ("orders", "total,total:customers(name)"), // alias collides with a column
            ("orders", "*,id:customers(name)"),
            ("orders", "customers(name),customers(id)"), // same key twice
            ("orders", "x:customers(n:name)"),           // column alias
            ("orders", "id,_r:customers(name)"),
            ("customers", "name,_j0:orders(id)"),
            ("orders", long.as_str()),
            ("orders", "orders(id)"), // self-reference
            ("orders", "\"customers\"; drop table x(id)"),
        ] {
            assert!(select_of(table, select).is_err(), "{table}?select={select}");
        }
    }

    fn request_of(table: &str, q: &[(&str, &str)]) -> Result<(Request, Sql), QueryError> {
        let catalog = shop();
        let t = catalog.table(table).unwrap();
        let req = parse_request_with_relations(&pairs(q), t, &catalog)?;
        let sql = super::select("public", t, &req, None);
        Ok((req, sql))
    }

    #[test]
    fn embeds_nest_with_their_own_aliases() {
        let (select, text) = select_of(
            "customers",
            "name,orders(id,items(qty),buyer:users!buyer_id(email))",
        )
        .unwrap();
        let orders = &select.embeds[0];
        assert_eq!(orders.select.columns, ["id"]);
        assert_eq!(orders.select.embeds[0].alias, "items");
        assert!(text.contains(
            "(SELECT coalesce(json_agg(extensions.nelcota_check_json(to_json(_j0_0), 8388608)), '[]') FROM (SELECT _e0_0.\"qty\" FROM \"public\".\"items\" AS _e0_0 WHERE _e0_0.\"order_id\" = _e0.\"id\" LIMIT $1) AS _j0_0) AS \"items\""
        ), "{text}");
        assert!(
            text.contains("WHERE _e0_1.\"id\" = _e0.\"buyer_id\") AS _j0_1) AS \"buyer\""),
            "{text}"
        );
        assert!(
            text.contains("WHERE _e0.\"customer_id\" = _t.\"id\""),
            "{text}"
        );
    }

    #[test]
    fn dotted_parameters_filter_order_and_page_the_embed() {
        let (req, sql) = request_of(
            "customers",
            &[
                ("orders.total", "gt.10"),
                ("select", "id,orders(id,items(*))"),
                ("orders.items.or", "(qty.eq.1,qty.gt.5)"),
                ("orders.order", "total.desc"),
                ("orders.limit", "2"),
                ("id", "eq.7"),
            ],
        )
        .unwrap();
        let orders = &req.select.embeds[0];
        assert_eq!((orders.filters.len(), orders.limit), (1, Some(2)));
        assert_eq!(orders.select.embeds[0].filters.len(), 1);
        assert_eq!(req.filters.len(), 1, "the parent keeps only its own filter");
        let text = &sql.text;
        assert!(
            text.contains("WHERE _e0.\"customer_id\" = _t.\"id\" AND _e0.\"total\" > $"),
            "{text}"
        );
        assert!(
            text.contains("::text::numeric ORDER BY _e0.\"total\" DESC LIMIT $"),
            "{text}"
        );
        assert!(
            text.contains("WHERE _e0_0.\"order_id\" = _e0.\"id\" AND (_e0_0.\"qty\" = $"),
            "{text}"
        );
        assert!(text.contains(" WHERE _t.\"id\" = $"), "{text}");
        // Values and the default limits of root and nested collection are parameters.
        assert_eq!(sql.params.len(), 7);
    }

    #[test]
    fn bad_embedded_parameters_are_rejected() {
        for q in [
            [("select", "id,orders(id)"), ("orders.nope", "eq.1")], // unknown column
            [("select", "id,orders(id)"), ("orders.select", "id")], // select belongs inside
            [("select", "id,customers(id)"), ("customers.order", "id")], // single row
            [("select", "id,customers(id)"), ("customers.limit", "1")],
            [("select", "id,orders(id)"), ("orders.limit", "-1")],
            [("select", "id,orders(id)"), ("orders.or", "(total.zz.1)")],
        ] {
            let table = match q[0].1.contains("customers") {
                true => "orders",
                false => "customers",
            };
            assert!(request_of(table, &q).is_err(), "{q:?}");
        }
        // Without the embed in select, the dotted key is not a column either.
        assert!(request_of("customers", &[("orders.total", "gt.1")]).is_err());
    }

    #[test]
    fn the_panel_parser_refuses_embeds() {
        let catalog = shop();
        let t = catalog.table("orders").unwrap();
        assert!(parse_request(&pairs(&[("select", "customers(name)")]), t).is_err());
    }

    fn docs() -> Table {
        Table {
            name: "docs".into(),
            columns: vec![
                col("id", "integer"),
                col("body", "jsonb"),
                col("raw", "json"),
                col("note", "text"),
            ],
            ..table()
        }
    }

    #[test]
    fn default_read_options_keep_the_rest_statement() {
        let t = docs();
        let req = parse_request(&pairs(&[("id", "gt.1")]), &t).unwrap();
        let plain = select("public", &t, &req, None);
        let with = select_with("public", &t, &req, None, &ReadOptions::default()).unwrap();
        assert_eq!(with.text, plain.text);
        assert_eq!(with.params.len(), plain.params.len());
    }

    #[test]
    fn null_flags_pair_each_row_with_its_sql_nulls() {
        let t = docs();
        let req = parse_request(&[], &t).unwrap();
        let options = ReadOptions {
            null_flags: vec!["body".into(), "raw".into()],
        };
        let sql = select_with("public", &t, &req, None, &options).unwrap();
        assert!(
            sql.text.starts_with(
                "SELECT coalesce(json_agg(extensions.nelcota_check_json(json_build_array(to_json(_r), \
                 json_build_array(_r.\"body\" IS NULL, _r.\"raw\" IS NULL)), 8388608)), '[]')::text, count(*) FROM ("
            ),
            "{}",
            sql.text
        );

        let unknown = ReadOptions {
            null_flags: vec!["nope".into()],
        };
        assert!(select_with("public", &t, &req, None, &unknown).is_err());
        let narrow = parse_request(&pairs(&[("select", "id")]), &t).unwrap();
        assert!(select_with("public", &t, &narrow, None, &options).is_err());
    }

    #[test]
    fn streamed_records_carry_null_flags_only_when_asked() {
        let t = docs();
        let req = parse_request(&pairs(&[("order", "id")]), &t).unwrap();
        let plain = select_rows("public", &t, &req);
        let same = select_rows_with("public", &t, &req, &ReadOptions::default()).unwrap();
        assert_eq!(same.text, plain.text);
        let options = ReadOptions {
            null_flags: vec!["raw".into()],
        };
        let flagged = select_rows_with("public", &t, &req, &options).unwrap();
        assert!(
            flagged.text.starts_with(
                "SELECT json_build_array(row_to_json(_r), json_build_array(_r.\"raw\" IS NULL))::text FROM ("
            ),
            "{}",
            flagged.text
        );
    }

    #[test]
    fn json_values_without_json_null_keep_the_rest_statements() {
        let t = docs();
        let body = json!({ "id": "1", "body": { "a": 1 }, "raw": null });
        let values = || {
            body.as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), WriteValue::Json(v.clone())))
                .collect::<Vec<_>>()
        };
        let filters = vec![column_filter(&t, "id", "eq.1").unwrap()];
        assert_eq!(
            insert_values("public", &t, values()).unwrap().text,
            insert("public", &t, body.clone(), None, None).unwrap().text
        );
        assert_eq!(
            update_values("public", &t, values(), &filters)
                .unwrap()
                .text,
            update("public", &t, body.clone(), &filters, None)
                .unwrap()
                .text
        );
    }

    #[test]
    fn json_null_writes_a_typed_literal_only_to_its_column() {
        let t = docs();
        let filters = vec![column_filter(&t, "id", "eq.1").unwrap()];
        let values = |null: &str| {
            vec![
                ("id".to_owned(), WriteValue::Json(json!("1"))),
                ("body".to_owned(), WriteValue::Json(Value::Null)),
                ("raw".to_owned(), WriteValue::Json(Value::Null)),
            ]
            .into_iter()
            .map(|(k, v)| match k == null {
                true => (k, WriteValue::JsonNull),
                false => (k, v),
            })
            .collect::<Vec<_>>()
        };
        let update = update_values("public", &t, values("body"), &filters).unwrap();
        assert!(
            update.text.contains(
                "SET \"body\" = 'null'::jsonb, \"id\" = _b.\"id\", \"raw\" = _b.\"raw\" FROM"
            ),
            "{}",
            update.text
        );
        let insert = insert_values("public", &t, values("raw")).unwrap();
        assert!(
            insert.text.contains(
                "(\"id\", \"body\", \"raw\") SELECT \"id\", \"body\", 'null'::json FROM json_populate_recordset("
            ),
            "{}",
            insert.text
        );

        let text = vec![("note".to_owned(), WriteValue::JsonNull)];
        assert!(insert_values("public", &t, text).is_err());
        let twice = vec![
            ("body".to_owned(), WriteValue::JsonNull),
            ("body".to_owned(), WriteValue::Json(Value::Null)),
        ];
        assert!(update_values("public", &t, twice, &filters).is_err());
    }
}
