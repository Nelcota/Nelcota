//! Validated filter grammar, independent of HTTP and query execution.
use crate::{Error, Result, encoding};
use serde::Serialize;

#[derive(Clone, Copy, Debug)]
pub enum Operator {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Like,
    Ilike,
}
impl Operator {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Eq => "eq",
            Self::Neq => "neq",
            Self::Gt => "gt",
            Self::Gte => "gte",
            Self::Lt => "lt",
            Self::Lte => "lte",
            Self::Like => "like",
            Self::Ilike => "ilike",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum IsValue {
    Null,
    True,
    False,
    Unknown,
}
impl IsValue {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::True => "true",
            Self::False => "false",
            Self::Unknown => "unknown",
        }
    }
}

/// Conditions safely quote values in the server's group grammar.
#[derive(Clone, Debug)]
pub struct Condition {
    pub(super) encoded: Result<String>,
    leaves: usize,
    depth: usize,
}
impl Condition {
    pub fn compare(column: &str, op: Operator, value: impl Serialize) -> Self {
        let encoded = (|| {
            encoding::column(column)?;
            let value = scalar(value)?;
            Ok(format!(
                "{column}.{}.{}",
                op.as_str(),
                encoding::quote(&value)
            ))
        })();
        Self {
            encoded,
            leaves: 1,
            depth: 0,
        }
    }
    pub fn eq(column: &str, value: impl Serialize) -> Self {
        Self::compare(column, Operator::Eq, value)
    }
    pub fn neq(column: &str, value: impl Serialize) -> Self {
        Self::compare(column, Operator::Neq, value)
    }
    pub fn gt(column: &str, value: impl Serialize) -> Self {
        Self::compare(column, Operator::Gt, value)
    }
    pub fn gte(column: &str, value: impl Serialize) -> Self {
        Self::compare(column, Operator::Gte, value)
    }
    pub fn lt(column: &str, value: impl Serialize) -> Self {
        Self::compare(column, Operator::Lt, value)
    }
    pub fn lte(column: &str, value: impl Serialize) -> Self {
        Self::compare(column, Operator::Lte, value)
    }
    pub fn is(column: &str, value: IsValue) -> Self {
        Self {
            encoded: encoding::column(column).map(|()| format!("{column}.is.{}", value.as_str())),
            leaves: 1,
            depth: 0,
        }
    }
    pub fn in_values(column: &str, values: impl Serialize) -> Self {
        Self {
            encoded: (|| {
                encoding::column(column)?;
                Ok(format!("{column}.in.{}", in_list(values)?))
            })(),
            leaves: 1,
            depth: 0,
        }
    }
    pub fn all(conditions: impl IntoIterator<Item = Self>) -> Self {
        group("and", conditions)
    }
    pub fn any(conditions: impl IntoIterator<Item = Self>) -> Self {
        group("or", conditions)
    }
    pub fn negate(mut self) -> Self {
        self.encoded = self.encoded.and_then(|text| {
            if text.starts_with("not.or(") || text.starts_with("not.and(") {
                return Ok(text[4..].into());
            }
            if text.starts_with("or(") || text.starts_with("and(") {
                return Ok(format!("not.{text}"));
            }
            let (column, filter) = text
                .split_once('.')
                .ok_or_else(|| Error::Usage("invalid condition".into()))?;
            Ok(match filter.strip_prefix("not.") {
                Some(filter) => format!("{column}.{filter}"),
                None => format!("{column}.not.{filter}"),
            })
        });
        self
    }
}
impl std::ops::Not for Condition {
    type Output = Self;
    fn not(self) -> Self {
        self.negate()
    }
}

pub(super) fn group(kind: &str, conditions: impl IntoIterator<Item = Condition>) -> Condition {
    let items: Vec<_> = conditions.into_iter().collect();
    let leaves = items.iter().map(|c| c.leaves).sum();
    let depth = items.iter().map(|c| c.depth).max().unwrap_or(0) + 1;
    let encoded = match items.is_empty() || leaves > 100 || depth > 8 {
        true => Err(Error::Usage(
            "groups need 1–100 filters and at most 8 nested levels".into(),
        )),
        false => items
            .into_iter()
            .map(|c| c.encoded)
            .collect::<Result<Vec<_>>>()
            .map(|items| format!("{kind}({})", items.join(","))),
    };
    Condition {
        encoded,
        leaves,
        depth,
    }
}

pub(super) fn scalar(value: impl Serialize) -> Result<String> {
    let value = crate::json::to_value(&value)?;
    encoding::scalar(&value)
}
pub(super) fn in_list(values: impl Serialize) -> Result<String> {
    let value = crate::json::to_value(&values)?;
    let items = value
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::Usage("in_values needs a nonempty array".into()))?;
    let quoted = items
        .iter()
        .map(|v| encoding::scalar(v).map(|v| encoding::quote(&v)))
        .collect::<Result<Vec<_>>>()?;
    Ok(format!("({})", quoted.join(",")))
}
