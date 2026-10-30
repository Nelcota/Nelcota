use unicode_normalization::UnicodeNormalization;

use crate::{Error, Result};

pub(crate) fn identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 63
        || value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || ".,()\":!*\\".contains(c))
    {
        return Err(Error::Usage(
            "identifier must have 1–63 bytes and no query delimiters".into(),
        ));
    }
    Ok(())
}

pub(crate) fn column(value: &str) -> Result<()> {
    for part in value.split('.') {
        identifier(part)?;
    }
    Ok(())
}

pub(crate) fn select(value: &str) -> Result<String> {
    if value.trim().is_empty()
        || value
            .chars()
            .any(|c| c.is_control() || c == '"' || c == '\\')
    {
        return Err(Error::Usage("invalid select expression".into()));
    }
    Ok(value.chars().filter(|c| !c.is_whitespace()).collect())
}

pub(crate) fn segment(value: &str) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for b in value.bytes() {
        match b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            true => {
                out.push(char::from(b));
            }
            false => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

pub(crate) fn bucket(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 63
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_".contains(&b))
        || ["public", "sign", "list"].contains(&value)
    {
        return Err(Error::Usage("invalid or reserved bucket name".into()));
    }
    Ok(())
}

pub(crate) fn object(value: &str) -> Result<String> {
    let value: String = value.nfc().collect();
    if value.is_empty() || value.len() > 1024 || value.chars().any(|c| c.is_control() || c == '\\')
    {
        return Err(Error::Usage(
            "invalid object name (maximum 1024 bytes)".into(),
        ));
    }
    value
        .split('/')
        .map(
            |part| match part.is_empty() || part == "." || part == ".." || part.len() > 255 {
                true => Err(Error::Usage(
                    "object path contains an invalid segment".into(),
                )),
                false => Ok(segment(part)),
            },
        )
        .collect::<Result<Vec<_>>>()
        .map(|parts| parts.join("/"))
}

pub(crate) fn prefix(value: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let folder = value
        .strip_suffix('/')
        .ok_or_else(|| Error::Usage("a folder prefix must end in '/'".into()))?;
    object(folder)?;
    Ok(value.nfc().collect())
}

pub(crate) fn scalar(value: &serde_json::Value) -> Result<String> {
    match value {
        serde_json::Value::String(s) => Ok(s.clone()),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        _ => Err(Error::Usage(
            "filter value must be a string, number or boolean; use is_null for null".into(),
        )),
    }
}

pub(crate) fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Escape text so a LIKE/ILIKE pattern matches it literally: `\`, `%`, `_`
/// and the URL wildcard `*` are backslash-escaped. A literal `*` (`\*`) needs
/// a server that understands that escape (see the changelog); older servers
/// turn every `*` into `%`.
pub fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_' | '*') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
