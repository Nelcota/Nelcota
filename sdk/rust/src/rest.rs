//! REST query builders. Building is local; only `execute` sends HTTP.
use crate::{Client, Error, Response, Result, encoding, http::Spec};
use reqwest::{Method, header::HeaderValue};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::time::Duration;

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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    encoded: Result<String>,
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

fn group(kind: &str, conditions: impl IntoIterator<Item = Condition>) -> Condition {
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

fn scalar(value: impl Serialize) -> Result<String> {
    let value = crate::json::to_value(&value)?;
    encoding::scalar(&value)
}
fn in_list(values: impl Serialize) -> Result<String> {
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

#[derive(Clone, Copy, Debug, Default)]
pub struct Order {
    pub descending: bool,
    pub nulls_first: Option<bool>,
}
impl Order {
    pub fn ascending() -> Self {
        Self::default()
    }
    pub fn descending() -> Self {
        Self {
            descending: true,
            nulls_first: None,
        }
    }
    pub fn nulls_first(mut self, first: bool) -> Self {
        self.nulls_first = Some(first);
        self
    }
}

#[derive(Clone, Debug, Default)]
pub struct UpsertOptions {
    pub on_conflict: Vec<String>,
    pub ignore_duplicates: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Cardinality {
    Many,
    One,
    Maybe,
}

/// Builders consume `self`; clone a base query to reuse it. Invalid input fails before HTTP.
#[derive(Clone, Debug)]
pub struct Query {
    client: Client,
    path: String,
    method: Method,
    params: Vec<(String, String)>,
    prefer: Vec<String>,
    body: Option<Value>,
    cardinality: Cardinality,
    error: Option<Error>,
    filters: usize,
    timeout: Option<Duration>,
    rpc: bool,
}

impl Query {
    pub(crate) fn table(client: Client, name: &str) -> Self {
        Self {
            client,
            path: format!("/rest/v1/{}", encoding::segment(name)),
            method: Method::GET,
            params: Vec::new(),
            prefer: Vec::new(),
            body: None,
            cardinality: Cardinality::Many,
            error: encoding::identifier(name).err(),
            filters: 0,
            timeout: None,
            rpc: false,
        }
    }
    pub(crate) fn rpc(client: Client, name: &str, args: &impl Serialize) -> Self {
        let mut query = Self::table(client, name);
        query.path = format!("/rest/v1/rpc/{}", encoding::segment(name));
        query.rpc = true;
        query.method = Method::POST;
        query.set_body(args, false);
        query
    }
    fn record<T>(&mut self, value: Result<T>) -> Option<T> {
        match value {
            Ok(value) => Some(value),
            Err(error) => {
                if self.error.is_none() {
                    self.error = Some(error);
                }
                None
            }
        }
    }
    fn replace(&mut self, key: String, value: String) {
        self.params.retain(|(k, _)| k != &key);
        self.params.push((key, value));
    }
    fn preference(&mut self, prefix: &str, value: &str) {
        self.prefer.retain(|p| !p.starts_with(prefix));
        self.prefer.push(value.into());
    }
    fn set_body(&mut self, value: &impl Serialize, many: bool) {
        let value = crate::json::to_value(value).and_then(|v| {
            let good = v.is_object()
                || (many
                    && v.as_array()
                        .is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_object)));
            if good {
                return Ok(v);
            }
            Err(Error::Usage(
                "body must be an object or a nonempty array of objects for insert/upsert".into(),
            ))
        });
        if let Some(value) = self.record(value) {
            self.body = Some(value);
        }
    }
    pub fn select(mut self, columns: &str) -> Self {
        if let Some(value) = self.record(encoding::select(columns)) {
            self.replace("select".into(), value);
        }
        if self.method != Method::GET && self.method != Method::HEAD {
            self.preference("return=", "return=representation");
        }
        self
    }
    pub fn insert(mut self, values: &impl Serialize) -> Self {
        self.method = Method::POST;
        self.set_body(values, true);
        self.preference("return=", "return=minimal");
        self
    }
    pub fn update(mut self, values: &impl Serialize) -> Self {
        self.method = Method::PATCH;
        self.set_body(values, false);
        self.preference("return=", "return=minimal");
        self
    }
    pub fn delete(mut self) -> Self {
        self.method = Method::DELETE;
        self.preference("return=", "return=minimal");
        self
    }
    pub fn upsert(mut self, values: &impl Serialize, options: UpsertOptions) -> Self {
        self = self.insert(values);
        for name in &options.on_conflict {
            self.record(encoding::identifier(name));
        }
        if !options.on_conflict.is_empty() {
            self.replace("on_conflict".into(), options.on_conflict.join(","));
        }
        self.preference(
            "resolution=",
            match options.ignore_duplicates {
                true => "resolution=ignore-duplicates",
                false => "resolution=merge-duplicates",
            },
        );
        self
    }
    pub fn filter(mut self, column: &str, op: Operator, value: impl Serialize) -> Self {
        self.record(encoding::column(column));
        if let Some(value) = self.record(scalar(value)) {
            self.params
                .push((column.into(), format!("{}.{value}", op.as_str())));
        }
        if !column.contains('.') {
            self.filters += 1;
        }
        self
    }
    pub fn not(mut self, column: &str, op: Operator, value: impl Serialize) -> Self {
        self.record(encoding::column(column));
        if let Some(value) = self.record(scalar(value)) {
            self.params
                .push((column.into(), format!("not.{}.{value}", op.as_str())));
        }
        if !column.contains('.') {
            self.filters += 1;
        }
        self
    }
    pub fn eq(self, column: &str, value: impl Serialize) -> Self {
        self.filter(column, Operator::Eq, value)
    }
    pub fn neq(self, column: &str, value: impl Serialize) -> Self {
        self.filter(column, Operator::Neq, value)
    }
    pub fn gt(self, column: &str, value: impl Serialize) -> Self {
        self.filter(column, Operator::Gt, value)
    }
    pub fn gte(self, column: &str, value: impl Serialize) -> Self {
        self.filter(column, Operator::Gte, value)
    }
    pub fn lt(self, column: &str, value: impl Serialize) -> Self {
        self.filter(column, Operator::Lt, value)
    }
    pub fn lte(self, column: &str, value: impl Serialize) -> Self {
        self.filter(column, Operator::Lte, value)
    }
    pub fn like(self, column: &str, value: &str) -> Self {
        self.filter(column, Operator::Like, value)
    }
    pub fn ilike(self, column: &str, value: &str) -> Self {
        self.filter(column, Operator::Ilike, value)
    }
    pub fn is(mut self, column: &str, value: IsValue) -> Self {
        self.record(encoding::column(column));
        self.params
            .push((column.into(), format!("is.{}", value.as_str())));
        if !column.contains('.') {
            self.filters += 1;
        }
        self
    }
    pub fn is_null(self, column: &str) -> Self {
        self.is(column, IsValue::Null)
    }
    pub fn not_is(mut self, column: &str, value: IsValue) -> Self {
        self.record(encoding::column(column));
        self.params
            .push((column.into(), format!("not.is.{}", value.as_str())));
        if !column.contains('.') {
            self.filters += 1;
        }
        self
    }
    pub fn in_values(mut self, column: &str, values: impl Serialize) -> Self {
        self.record(encoding::column(column));
        if let Some(list) = self.record(in_list(values)) {
            self.params.push((column.into(), format!("in.{list}")));
        }
        if !column.contains('.') {
            self.filters += 1;
        }
        self
    }
    pub fn not_in(mut self, column: &str, values: impl Serialize) -> Self {
        self.record(encoding::column(column));
        if let Some(list) = self.record(in_list(values)) {
            self.params.push((column.into(), format!("not.in.{list}")));
        }
        if !column.contains('.') {
            self.filters += 1;
        }
        self
    }
    pub fn matches(mut self, values: &impl Serialize) -> Self {
        let values = crate::json::to_value(values);
        if let Some(value) = self.record(values) {
            match value.as_object() {
                Some(values) => {
                    for (key, value) in values {
                        self = self.eq(key, value);
                    }
                }
                _ => {
                    self.record::<()>(Err(Error::Usage("matches needs an object".into())));
                }
            }
        }
        self
    }
    fn conditions(
        mut self,
        key: &str,
        reference: Option<&str>,
        items: impl IntoIterator<Item = Condition>,
    ) -> Self {
        let condition = group(key, items);
        let key = self.referenced(key, reference);
        if let Some(text) = self.record(condition.encoded)
            && let Some((_, value)) = text.split_once('(')
        {
            self.params.push((key, format!("({value}")));
        }
        if reference.is_none() {
            self.filters += 1;
        }
        self
    }
    pub fn or(self, items: impl IntoIterator<Item = Condition>) -> Self {
        self.conditions("or", None, items)
    }
    pub fn and(self, items: impl IntoIterator<Item = Condition>) -> Self {
        self.conditions("and", None, items)
    }
    pub fn or_on(self, reference: &str, items: impl IntoIterator<Item = Condition>) -> Self {
        self.conditions("or", Some(reference), items)
    }
    pub fn and_on(self, reference: &str, items: impl IntoIterator<Item = Condition>) -> Self {
        self.conditions("and", Some(reference), items)
    }
    fn referenced(&mut self, key: &str, reference: Option<&str>) -> String {
        match reference {
            Some(name) => {
                self.record(encoding::column(name));
                format!("{name}.{key}")
            }
            None => key.into(),
        }
    }
    pub fn order(self, column: &str, order: Order) -> Self {
        self.order_on(None, column, order)
    }
    pub fn order_on(mut self, reference: Option<&str>, column: &str, order: Order) -> Self {
        self.record(encoding::identifier(column));
        let key = self.referenced("order", reference);
        let mut value = format!(
            "{column}.{}",
            match order.descending {
                true => "desc",
                false => "asc",
            }
        );
        if let Some(first) = order.nulls_first {
            value.push_str(match first {
                true => ".nullsfirst",
                false => ".nullslast",
            });
        }
        match self.params.iter_mut().find(|(k, _)| k == &key) {
            Some((_, previous)) => {
                previous.push(',');
                previous.push_str(&value);
            }
            _ => {
                self.params.push((key, value));
            }
        }
        self
    }
    pub fn limit(self, limit: u64) -> Self {
        self.limit_on(None, limit)
    }
    pub fn limit_on(mut self, reference: Option<&str>, limit: u64) -> Self {
        let key = self.referenced("limit", reference);
        self.replace(key, limit.to_string());
        self
    }
    pub fn offset(mut self, offset: u64) -> Self {
        self.replace("offset".into(), offset.to_string());
        self
    }
    pub fn range(self, start: u64, end: u64) -> Self {
        self.range_on(None, start, end)
    }
    pub fn range_on(mut self, reference: Option<&str>, start: u64, end: u64) -> Self {
        let size = end
            .checked_sub(start)
            .and_then(|v| v.checked_add(1))
            .ok_or_else(|| Error::Usage("range requires start <= end without overflow".into()));
        if let Some(size) = self.record(size) {
            let offset = self.referenced("offset", reference);
            self.replace(offset, start.to_string());
            self = self.limit_on(reference, size);
        }
        self
    }
    pub fn count_exact(mut self) -> Self {
        self.preference("count=", "count=exact");
        self
    }
    pub fn head(mut self) -> Self {
        if self.method != Method::GET {
            self.record::<()>(Err(Error::Usage("head is only valid for reads".into())));
            return self;
        }
        self.method = Method::HEAD;
        self
    }
    pub fn single(mut self) -> Self {
        self.cardinality = Cardinality::One;
        self
    }
    pub fn maybe_single(mut self) -> Self {
        self.cardinality = Cardinality::Maybe;
        self
    }
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
    pub fn cancellation(mut self, token: crate::CancellationToken) -> Self {
        self.client.options.cancellation = Some(token);
        self
    }
    /// The encoded query string, without the access token.
    pub fn query_string(&self) -> Result<String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        Ok(url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(&self.params)
            .finish())
    }
    pub async fn execute<T: DeserializeOwned>(self) -> Result<Response<T>> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if self.cardinality != Cardinality::Many
            && (self.method == Method::HEAD
                || (!self.rpc
                    && self.method != Method::GET
                    && !self.prefer.iter().any(|p| p == "return=representation")))
        {
            return Err(Error::Usage(
                "single/maybe_single requires rows: select a representation and omit head".into(),
            ));
        }
        if (self.method == Method::PATCH || self.method == Method::DELETE) && self.filters == 0 {
            return Err(Error::Usage(
                "update/delete requires at least one parent filter".into(),
            ));
        }
        if !self.rpc && self.method == Method::POST && self.filters > 0 {
            return Err(Error::Usage("insert/upsert does not accept filters".into()));
        }
        let mut spec = Spec::new(self.method.clone(), self.path);
        spec.params = self.params;
        spec.json = self.body;
        spec.timeout = self.timeout;
        if self.cardinality != Cardinality::Many
            && self.method == Method::GET
            && !spec.params.iter().any(|(k, _)| k == "limit")
        {
            spec.params.push(("limit".into(), "2".into()));
        }
        if !self.prefer.is_empty() {
            spec.headers.insert(
                "prefer",
                HeaderValue::from_str(&self.prefer.join(","))
                    .map_err(|_| Error::Usage("invalid preference".into()))?,
            );
        }
        let response = self.client.json::<Value>(spec).await?;
        let data =
            match self.cardinality {
                Cardinality::Many => response.data,
                mode => {
                    let mut rows = response.data.as_array().cloned().ok_or_else(|| {
                        Error::InvalidResponse {
                        status: response.status,
                        message:
                            "single requires an array response; request representation for writes"
                                .into(),
                    }
                    })?;
                    match rows.len() {
                        1 => rows.remove(0),
                        0 if mode == Cardinality::Maybe => Value::Null,
                        actual => {
                            return Err(Error::Cardinality {
                                expected: match mode == Cardinality::One {
                                    true => "exactly one",
                                    false => "at most one",
                                },
                                actual,
                            });
                        }
                    }
                }
            };
        let data = serde_json::from_value(data).map_err(|e| Error::InvalidResponse {
            status: response.status,
            message: e.to_string(),
        })?;
        Ok(Response {
            data,
            status: response.status,
            count: response.count,
            headers: response.headers,
        })
    }
}
