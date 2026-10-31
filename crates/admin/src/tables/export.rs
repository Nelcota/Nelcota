//! Table export as CSV or JSON, streamed from Postgres: one record at a time
//! goes straight into the response, without building the whole file in
//! memory. Follows the grid's sort and filters.
//!
//! json/jsonb columns: CSV writes their JSON text, so a JSON `null` is the
//! text `null` and SQL NULL an empty field, as in the grid. JSON export keeps
//! each record as the REST API returns it (`row_to_json`, documents nested),
//! where both read as `null`.
mod connection;
pub use connection::ExportExecutor;

use std::{error::Error, future::ready};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::header,
    response::Response,
};
use futures_util::{StreamExt, stream};
use nelcota_api::query;
use serde::Deserialize;

use crate::{
    AdminState, ApiError,
    error::user_query_error,
    tables::{
        catalog::table_or_404,
        rows::{Row, RowsQuery, build_request, invalid_query, is_json, json_text, raw_text},
    },
};

type BoxError = Box<dyn Error + Send + Sync>;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Json,
}

impl Format {
    fn content_type(self) -> &'static str {
        match self {
            Format::Csv => "text/csv; charset=utf-8",
            Format::Json => "application/json",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Json => "json",
        }
    }
}

#[derive(Deserialize)]
pub struct ExportQuery {
    format: Format,
    sort: Option<String>,
    #[serde(default)]
    desc: bool,
    filters: Option<String>,
}

/// Turns each record (JSON text from `row_to_json`) into a chunk of the file.
struct Encoder {
    format: Format,
    columns: Vec<String>,
    /// json/jsonb columns in table order, written as their JSON text. A CSV
    /// record then comes with their `IS NULL` flags, in this order
    /// ([`Encoder::flags_sql_nulls`]).
    json_columns: Vec<String>,
}

impl Encoder {
    fn header(&self) -> String {
        match self.format {
            // BOM: Excel only recognises UTF-8 (accents) with it.
            Format::Csv => format!(
                "\u{feff}{}",
                csv_line(self.columns.iter().map(|c| Some(c.as_str())))
            ),
            Format::Json => "[".to_owned(),
        }
    }

    /// Whether the records carry SQL NULL flags: CSV tells a JSON `null`
    /// apart from SQL NULL; JSON export keeps the REST API's records.
    fn flags_sql_nulls(&self) -> bool {
        self.format == Format::Csv && !self.json_columns.is_empty()
    }

    fn row(&self, index: usize, json: &str) -> Result<String, BoxError> {
        match self.format {
            Format::Csv => {
                let (row, sql_nulls): (Row, Vec<bool>) = match self.flags_sql_nulls() {
                    true => serde_json::from_str(json)?,
                    false => (serde_json::from_str(json)?, Vec::new()),
                };
                let values: Vec<Option<String>> = self
                    .columns
                    .iter()
                    .map(|c| {
                        let value = row.get(c).map(AsRef::as_ref);
                        match self.json_columns.iter().position(|j| j == c) {
                            Some(n) => json_text(value, sql_nulls.get(n).copied().unwrap_or(true)),
                            None => raw_text(value, false),
                        }
                    })
                    .collect();
                Ok(csv_line(values.iter().map(Option::as_deref)))
            }
            // Postgres' text goes through untouched: numeric keeps every digit.
            Format::Json => Ok(format!(
                "{}\n  {json}",
                match index {
                    0 => "",
                    _ => ",",
                }
            )),
        }
    }

    fn footer(&self) -> &'static str {
        match self.format {
            Format::Csv => "",
            Format::Json => "\n]\n",
        }
    }
}

/// One CSV line (RFC 4180). `None` = NULL, exported as an empty field.
fn csv_line<'a>(values: impl Iterator<Item = Option<&'a str>>) -> String {
    let mut line = values
        .map(|v| v.map_or_else(String::new, csv_field))
        .collect::<Vec<_>>()
        .join(",");
    line.push_str("\r\n");
    line
}

fn csv_field(value: &str) -> String {
    if spreadsheet_formula(value) {
        // A quoted tab prefix makes this a text cell in Excel. CSV quoting
        // alone does not stop formulas. JSON export preserves the original.
        return format!("\"\t{}\"", value.replace('"', "\"\""));
    }
    if value.contains([',', '"', '\n', '\r'])
        || value.starts_with(char::is_whitespace)
        || value.ends_with(char::is_whitespace)
    {
        return format!("\"{}\"", value.replace('"', "\"\""));
    }
    value.to_owned()
}

fn spreadsheet_formula(value: &str) -> bool {
    // Preserve negative numeric literals without parsing through f64 (numeric
    // may have more digits than it can represent). No expression is allowed.
    if value.starts_with('-')
        && serde_json::from_str::<&serde_json::value::RawValue>(value)
            .is_ok_and(|raw| raw.get() == value)
    {
        return false;
    }
    let significant =
        value.trim_start_matches(|c: char| c.is_whitespace() || c.is_control() || c == '\u{feff}');
    value.starts_with(['\t', '\r', '\n'])
        || significant.starts_with(['=', '+', '-', '@', '＝', '＋', '－', '＠'])
}

/// Safe file name for `Content-Disposition`.
fn file_name(table: &str, format: Format) -> String {
    let base: String = table
        .chars()
        .map(
            |c| match c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                true => c,
                false => '_',
            },
        )
        .collect();
    let base = match base.trim_matches('_').is_empty() {
        true => "table".to_owned(),
        false => base,
    };
    format!("{base}.{}", format.extension())
}

pub async fn export(
    State(state): State<AdminState>,
    Path(name): Path<String>,
    Query(params): Query<ExportQuery>,
) -> Result<Response, ApiError> {
    let table = table_or_404(&state, &name)?;
    let schema = state.catalog.get().schema.clone();
    let rows_query = RowsQuery {
        sort: params.sort,
        desc: params.desc,
        filters: params.filters,
    };
    let request = build_request(&table, &rows_query, None)?;
    let encoder = Encoder {
        format: params.format,
        columns: table.columns.iter().map(|c| c.name.clone()).collect(),
        json_columns: table
            .columns
            .iter()
            .filter(|c| is_json(c))
            .map(|c| c.name.clone())
            .collect(),
    };
    let options = query::ReadOptions {
        null_flags: match encoder.flags_sql_nulls() {
            true => encoder.json_columns.clone(),
            false => Vec::new(),
        },
    };
    let sql =
        query::select_rows_with(&schema, &table, &request, &options).map_err(invalid_query)?;

    // Filter errors show up here, before the first byte: they become a 400.
    let (client, connection) = state.exports.connect(&state.db_config).await?;
    let rows = client
        .query_raw(sql.text.as_str(), sql.param_refs())
        .await
        .map_err(user_query_error)?;
    // The supervisor retains the client through the response lifetime. This
    // request handle must not keep it alive after cancellation or expiry.
    drop(client);

    let header = encoder.header();
    let footer = encoder.footer();
    let table_name = table.name.clone();
    let body = connection.rows(rows).enumerate().map(move |(index, row)| {
        let json: String = row?.try_get(0)?;
        encoder.row(index, &json)
    });
    let stream = stream::once(ready(Ok::<_, BoxError>(header)))
        .chain(body)
        // The dedicated connection lives with this stream, under its own budget.
        .chain(stream::once(async move {
            connection.finish()?;
            Ok(footer.to_owned())
        }))
        .inspect(move |chunk| {
            if let Err(err) = chunk {
                tracing::warn!(table = %table_name, error = %err, "export interrupted");
            }
        });

    Ok(Response::builder()
        .header(header::CONTENT_TYPE, params.format.content_type())
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                file_name(&table.name, params.format)
            ),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_escapes_only_what_it_must() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("says \"hi\""), "\"says \"\"hi\"\"\"");
        assert_eq!(csv_field("new\nline"), "\"new\nline\"");
        assert_eq!(csv_field(" space"), "\" space\"");
    }

    #[test]
    fn csv_null_becomes_an_empty_field() {
        assert_eq!(
            csv_line([Some("1"), None, Some("x")].into_iter()),
            "1,,x\r\n"
        );
    }

    #[test]
    fn csv_neutralizes_formulas_and_control_prefixes() {
        for value in [
            "=1+1",
            "+1+1",
            "-1+1",
            "@SUM(1,1)",
            " =1+1",
            "\t=1+1",
            "\r=1+1",
            "\n=1+1",
            "\u{feff}=1+1",
            "\0=1+1",
            "＝1+1",
            "＋1+1",
            "－1+1",
            "＠SUM(1,1)",
            "=HYPERLINK(\"https://example.com\",\"open\")",
        ] {
            assert_eq!(
                csv_field(value),
                format!("\"\t{}\"", value.replace('"', "\"\""))
            );
        }
        for number in [
            "-1",
            "-0.50",
            "-1e-3",
            "-123456789012345678901234567890.123456789",
        ] {
            assert_eq!(csv_field(number), number, "negative numeric stays numeric");
        }
    }

    #[test]
    fn csv_protects_headers_and_json_keeps_original_values() {
        let encoder = Encoder {
            format: Format::Csv,
            columns: vec!["=header".into()],
            json_columns: Vec::new(),
        };
        assert_eq!(encoder.header(), "\u{feff}\"\t=header\"\r\n");
        assert_eq!(
            encoder.row(0, r#"{"=header":"=1+1"}"#).unwrap(),
            "\"\t=1+1\"\r\n"
        );
        let encoder = Encoder {
            format: Format::Json,
            columns: vec![],
            json_columns: Vec::new(),
        };
        assert_eq!(
            encoder.row(0, r#"{"value":"=1+1"}"#).unwrap(),
            "\n  {\"value\":\"=1+1\"}"
        );
    }

    #[test]
    fn csv_lines_follow_the_column_order() {
        let encoder = Encoder {
            format: Format::Csv,
            columns: vec!["id".into(), "name".into(), "extra".into()],
            json_columns: Vec::new(),
        };
        let line = encoder
            .row(0, r#"{"name":"Ana, the first","id":1,"extra":null}"#)
            .unwrap();
        assert_eq!(line, "1,\"Ana, the first\",\r\n");
    }

    #[test]
    fn csv_keeps_json_column_text() {
        let encoder = Encoder {
            format: Format::Csv,
            columns: vec!["label".into(), "extra".into()],
            json_columns: vec!["extra".to_owned()],
        };
        let line = encoder
            .row(0, r#"[{"label":"42","extra":"42"},[false]]"#)
            .unwrap();
        assert_eq!(line, "42,\"\"\"42\"\"\"\r\n");
    }

    #[test]
    fn csv_tells_a_json_null_apart_from_sql_null() {
        let encoder = Encoder {
            format: Format::Csv,
            columns: vec!["id".into(), "body".into(), "raw".into(), "note".into()],
            json_columns: vec!["body".into(), "raw".into()],
        };
        assert!(encoder.flags_sql_nulls());
        let line = encoder
            .row(
                0,
                r#"[{"id":1,"body":null,"raw":null,"note":null},[false,true]]"#,
            )
            .unwrap();
        assert_eq!(line, "1,null,,\r\n");
    }

    #[test]
    fn json_export_keeps_the_rest_records() {
        let encoder = Encoder {
            format: Format::Json,
            columns: vec!["id".into(), "body".into()],
            json_columns: vec!["body".into()],
        };
        assert!(!encoder.flags_sql_nulls());
        assert_eq!(
            encoder.row(0, r#"{"id":1,"body":{"a":null}}"#).unwrap(),
            "\n  {\"id\":1,\"body\":{\"a\":null}}"
        );
    }

    #[test]
    fn json_separates_records_with_commas() {
        let encoder = Encoder {
            format: Format::Json,
            columns: vec![],
            json_columns: Vec::new(),
        };
        let body = [
            encoder.header(),
            encoder.row(0, r#"{"id":1}"#).unwrap(),
            encoder.row(1, r#"{"id":2.50}"#).unwrap(),
            encoder.footer().to_owned(),
        ]
        .concat();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 2);
        assert!(body.contains("2.50"), "numeric preserved: {body}");
    }

    #[test]
    fn file_name_without_dangerous_characters() {
        assert_eq!(file_name("orders", Format::Csv), "orders.csv");
        assert_eq!(file_name("a\"b;c", Format::Json), "a_b_c.json");
        assert_eq!(file_name("über", Format::Csv), "_ber.csv");
        assert_eq!(file_name("üö", Format::Csv), "table.csv");
    }
}
