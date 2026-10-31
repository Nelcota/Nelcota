//! DDL generation from typed specifications sent by the panel.
//!
//! It only builds text: it never touches the database (`apply` runs it). So
//! every rule is testable on its own and the preview ("view SQL") shows
//! exactly what will run.
//!
//! Identifiers are always quoted and types are checked against a list.
//! Expressions (`DEFAULT`, `USING`, `WITH CHECK`) are SQL by nature and pass
//! as they are: the admin already owns the database (they have the SQL
//! editor), and `apply` runs each statement through the extended protocol,
//! which refuses more than one statement at a time. Rules Postgres already
//! enforces (the referenced table exists, the cast is possible) are left to
//! it: its message comes back as a 400.

pub mod policy;
pub mod table;

use nelcota_api::query::ident;
use serde::Deserialize;
use serde_json::{Value, json};

/// Specification validation error. Becomes a 400 with a code and params the
/// panel translates (no `Display` on purpose: it must not fall into
/// `ApiError`'s generic conversion to 500).
#[derive(Debug, PartialEq)]
pub struct DdlError {
    pub code: &'static str,
    pub message: String,
    pub params: Value,
}

pub type Result<T> = std::result::Result<T, DdlError>;

impl From<DdlError> for crate::ApiError {
    fn from(err: DdlError) -> Self {
        let error = crate::ApiError::bad_request(err.code, err.message);
        if err.params.is_null() {
            return error;
        }
        error.params(err.params)
    }
}

fn error(code: &'static str, message: impl Into<String>, params: Value) -> DdlError {
    DdlError {
        code,
        message: message.into(),
        params,
    }
}

fn invalid<T>(code: &'static str, message: impl Into<String>, params: Value) -> Result<T> {
    Err(error(code, message, params))
}

/// Postgres identifier limit (NAMEDATALEN - 1), in bytes.
const MAX_IDENT_BYTES: usize = 63;

/// Table, column or policy name: Postgres accepts almost anything quoted,
/// but would silently cut whatever goes past 63 bytes.
pub fn validate_name(kind: &str, name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return invalid(
            "name_empty",
            format!("{kind}: empty name"),
            json!({ "kind": kind }),
        );
    }
    if name != name.trim() {
        return invalid(
            "name_surrounding_spaces",
            format!("{kind} '{name}': no leading or trailing spaces"),
            json!({ "kind": kind, "name": name }),
        );
    }
    if name.len() > MAX_IDENT_BYTES {
        return invalid(
            "name_too_long",
            format!("{kind} '{name}': at most {MAX_IDENT_BYTES} bytes"),
            json!({ "kind": kind, "name": name, "max": MAX_IDENT_BYTES }),
        );
    }
    if name.contains('\0') {
        return invalid(
            "name_invalid_character",
            format!("{kind}: invalid character"),
            json!({ "kind": kind }),
        );
    }
    Ok(())
}

/// `"schema"."name"`
pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", ident(schema), ident(name))
}

/// Text literal (`standard_conforming_strings` is the default since 9.1).
///
/// A carriage return is written as an `E'\r'` escape, never as a raw byte:
/// migration files have CRLF normalized to LF before they are checksummed
/// and run, which would otherwise change a comment such as `"a\r\nb"`.
pub fn literal(text: &str) -> String {
    if !text.contains('\r') {
        return format!("'{}'", text.replace('\'', "''"));
    }
    let escaped = text
        .replace('\\', r"\\")
        .replace('\'', "''")
        .replace('\r', r"\r");
    format!("E'{escaped}'")
}

/// Required (non-empty) SQL expression, in parentheses.
fn expression(kind: &str, sql: &str) -> Result<String> {
    let sql = sql.trim();
    if sql.is_empty() {
        return invalid(
            "expression_empty",
            format!("{kind}: empty expression"),
            json!({ "kind": kind }),
        );
    }
    Ok(format!("({sql})"))
}

/// Types the panel offers (besides the schema's enums). Canonical Postgres
/// names, in the order they appear in the form.
pub const BASE_TYPES: [&str; 18] = [
    "text",
    "varchar",
    "uuid",
    "smallint",
    "integer",
    "bigint",
    "numeric",
    "real",
    "double precision",
    "boolean",
    "date",
    "time",
    "timestamp",
    "timestamptz",
    "interval",
    "jsonb",
    "json",
    "bytea",
];

const INTEGER_TYPES: [&str; 3] = ["smallint", "integer", "bigint"];
/// Types that take a modifier: `varchar(80)`, `numeric(10,2)`, `timestamptz(3)`.
const WITH_MODIFIER: [&str; 5] = ["varchar", "numeric", "time", "timestamp", "timestamptz"];

/// Validated column type: one of [`BASE_TYPES`] or a schema enum, with an
/// optional modifier and an optional `[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataType {
    base: String,
    is_enum: bool,
    modifier: Option<String>,
    array: bool,
}

impl DataType {
    pub fn parse(text: &str, enums: &[String]) -> Result<Self> {
        let text = text.trim();
        let (rest, array) = match text.strip_suffix("[]") {
            Some(rest) => (rest.trim_end(), true),
            None => (text, false),
        };
        let (base, modifier) = match rest.split_once('(') {
            Some((base, args)) => {
                let args = args.strip_suffix(')').ok_or_else(|| {
                    error(
                        "type_unclosed_parenthesis",
                        format!("type '{text}': unclosed parenthesis"),
                        json!({ "type": text }),
                    )
                })?;
                (base.trim(), Some(args.replace(' ', "")))
            }
            None => (rest, None),
        };
        let lower = base.to_lowercase();
        let is_enum = enums.iter().any(|e| e == base);
        let base = match is_enum {
            true => base.to_owned(),
            false => match BASE_TYPES.iter().find(|t| **t == lower) {
                Some(known) => (*known).to_owned(),
                _ => {
                    return invalid(
                        "unknown_type",
                        format!("unknown type: '{base}'"),
                        json!({ "type": base }),
                    );
                }
            },
        };
        if let Some(args) = &modifier {
            let ok = WITH_MODIFIER.contains(&base.as_str())
                && !args.is_empty()
                && args.split(',').count() <= 2
                && args
                    .split(',')
                    .all(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()));
            if !ok {
                return invalid(
                    "invalid_type_modifier",
                    format!("type '{text}': invalid modifier"),
                    json!({ "type": text }),
                );
            }
        }
        Ok(DataType {
            base,
            is_enum,
            modifier,
            array,
        })
    }

    pub fn is_integer(&self) -> bool {
        !self.array && INTEGER_TYPES.contains(&self.base.as_str())
    }

    /// The type's SQL; enums are qualified with the schema.
    pub fn to_sql(&self, schema: &str) -> String {
        let mut sql = match () {
            _ if self.is_enum => qualified(schema, &self.base),
            _ if self.base == "timestamptz" && self.modifier.is_some() => {
                // timestamptz(3) is not in the grammar: it is timestamp(3) with time zone.
                "timestamp".to_owned()
            }
            _ => self.base.clone(),
        };
        if let Some(args) = &self.modifier {
            sql.push_str(&format!("({args})"));
        }
        if self.base == "timestamptz" && self.modifier.is_some() {
            sql.push_str(" with time zone");
        }
        if self.array {
            sql.push_str("[]");
        }
        sql
    }
}

/// API roles the panel lets you configure in GRANTs and policies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ts_rs::TS, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApiRole {
    Anon,
    Authenticated,
    ServiceRole,
}

impl ApiRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ApiRole::Anon => "anon",
            ApiRole::Authenticated => "authenticated",
            ApiRole::ServiceRole => "service_role",
        }
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, ts_rs::TS, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum Privilege {
    Select,
    Insert,
    Update,
    Delete,
}

impl Privilege {
    fn as_sql(self) -> &'static str {
        match self {
            Privilege::Select => "SELECT",
            Privilege::Insert => "INSERT",
            Privilege::Update => "UPDATE",
            Privilege::Delete => "DELETE",
        }
    }
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS, schemars::JsonSchema)]
pub struct GrantDef {
    pub role: ApiRole,
    pub privileges: Vec<Privilege>,
}

/// `GRANT ... TO role`, or nothing when the list is empty.
fn grant(table: &str, def: &GrantDef) -> Option<String> {
    let mut privileges = def.privileges.clone();
    privileges.sort();
    privileges.dedup();
    if privileges.is_empty() {
        return None;
    }
    let list: Vec<&str> = privileges.iter().map(|p| p.as_sql()).collect();
    Some(format!(
        "GRANT {} ON TABLE {table} TO {}",
        list.join(", "),
        ident(def.role.as_str())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enums() -> Vec<String> {
        vec!["priority".into()]
    }

    #[test]
    fn valid_and_invalid_names() {
        assert!(validate_name("table", "orders_2026").is_ok());
        assert!(validate_name("table", "description with spaces").is_ok());
        assert!(validate_name("table", "").is_err());
        assert!(validate_name("table", " orders").is_err());
        assert!(validate_name("table", &"x".repeat(64)).is_err());
        // 63 bytes, not 63 characters: "ç" takes 2.
        assert!(validate_name("table", &"ç".repeat(32)).is_err());
    }

    #[test]
    fn errors_carry_a_code_and_params_for_the_panel() {
        let err = validate_name("table", &"x".repeat(64)).unwrap_err();
        assert_eq!(err.code, "name_too_long");
        assert_eq!(err.params["max"], 63);
        let err = DataType::parse("money", &enums()).unwrap_err();
        assert_eq!(err.code, "unknown_type");
        assert_eq!(err.params, json!({ "type": "money" }));
        assert_eq!(err.message, "unknown type: 'money'");
    }

    #[test]
    fn listed_types_with_modifier_and_array() {
        let sql = |t: &str| DataType::parse(t, &enums()).unwrap().to_sql("public");
        assert_eq!(sql("text"), "text");
        assert_eq!(sql("BIGINT"), "bigint");
        assert_eq!(sql("varchar(80)"), "varchar(80)");
        assert_eq!(sql("numeric(10, 2)"), "numeric(10,2)");
        assert_eq!(sql("text[]"), "text[]");
        assert_eq!(sql("double precision"), "double precision");
        assert_eq!(sql("timestamptz(3)"), "timestamp(3) with time zone");
        assert_eq!(sql("priority"), "\"public\".\"priority\"");
        assert_eq!(sql("priority[]"), "\"public\".\"priority\"[]");
    }

    #[test]
    fn refused_types() {
        for bad in [
            "string",
            "int; drop table x",
            "text(10)",
            "numeric(a)",
            "varchar(1,2,3)",
            "varchar(",
            "numeric()",
        ] {
            assert!(
                DataType::parse(bad, &enums()).is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn literal_and_escaped_identifiers() {
        assert_eq!(literal("O'Reilly"), "'O''Reilly'");
        assert_eq!(literal("a\\b\nc"), "'a\\b\nc'");
        assert_eq!(literal("it's\r\na\\b"), "E'it''s\\r\na\\\\b'");
        assert_eq!(qualified("public", "a\"b"), "\"public\".\"a\"\"b\"");
    }

    #[test]
    fn grant_sorts_and_removes_duplicates() {
        let def = GrantDef {
            role: ApiRole::Authenticated,
            privileges: vec![Privilege::Update, Privilege::Select, Privilege::Select],
        };
        assert_eq!(
            grant("\"public\".\"t\"", &def).unwrap(),
            "GRANT SELECT, UPDATE ON TABLE \"public\".\"t\" TO \"authenticated\""
        );
        let empty = GrantDef {
            role: ApiRole::Anon,
            privileges: vec![],
        };
        assert_eq!(grant("t", &empty), None);
    }
}
