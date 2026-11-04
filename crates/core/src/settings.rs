//! Allowlisted routine project settings. Never serialize a raw `Config` to
//! expose settings: its `Secret` values intentionally support private storage.
use crate::Config;
use serde_json::Value;
use std::collections::BTreeMap;

/// Immutable startup projection. Only catalog values are serialized, never the
/// private configuration. The local controller checks schema and exact keys.
#[derive(Clone, serde::Serialize)]
pub struct Snapshot {
    schema: u32,
    values: BTreeMap<&'static str, Value>,
}
impl Snapshot {
    pub fn new(config: &Config) -> Self {
        Self {
            schema: 1,
            values: CATALOG
                .iter()
                .map(|d| (d.key, d.effective_value(config)))
                .collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Boolean,
    Integer,
    Origins,
    Text,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Authentication,
    Email,
    Api,
    Storage,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Project,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    HostOperator,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Restart {
    Application,
}

/// Metadata for non-secret project values managed by the host operator. All
/// currently require an app restart; root trust and credentials are not knobs.
pub struct Definition {
    pub key: &'static str,
    pub group: Group,
    pub scope: Scope,
    pub authority: Authority,
    pub sensitive: bool,
    pub restart: Restart,
    pub kind: Kind,
    pub nullable: bool,
    pub minimum: u64,
    pub maximum: u64,
    pub dependencies: &'static [&'static str],
    read: fn(&Config) -> Value,
    effective_read: fn(&Config) -> Value,
    write: fn(&mut Config, Value) -> Result<(), SettingsError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    #[error("unknown_project_setting")]
    Unknown,
    #[error("invalid_project_setting")]
    Value,
    #[error("invalid_project_settings_combination")]
    Combination,
    #[error("invalid_project_configuration")]
    Candidate,
}

macro_rules! value {
    (text, $v:ident) => {
        $v.as_str().ok_or(SettingsError::Value)?.to_owned()
    };
    (encoded, $v:ident) => {
        match $v.is_null() {
            true => None,
            false => Some(crate::email::encode(
                $v.as_str().ok_or(SettingsError::Value)?,
            )),
        }
    };
    (origins, $v:ident) => {
        Some(
            $v.as_array()
                .ok_or(SettingsError::Value)?
                .iter()
                .map(|v| v.as_str().ok_or(SettingsError::Value))
                .collect::<Result<Vec<_>, _>>()?
                .join(","),
        )
    };
    (boolean, $v:ident) => {
        $v.as_bool().ok_or(SettingsError::Value)?
    };
    (integer, $v:ident) => {
        $v.as_u64()
            .ok_or(SettingsError::Value)?
            .try_into()
            .map_err(|_| SettingsError::Value)?
    };
    (optional, $v:ident) => {
        match $v.is_null() {
            true => None,
            false => Some(value!(integer, $v)),
        }
    };
}
macro_rules! kind {
    (text) => {
        Kind::Text
    };
    (encoded) => {
        Kind::Text
    };
    (origins) => {
        Kind::Origins
    };
    (boolean) => {
        Kind::Boolean
    };
    (integer) => {
        Kind::Integer
    };
    (optional) => {
        Kind::Integer
    };
}
macro_rules! nullable {
    (text) => {
        false
    };
    (encoded) => {
        true
    };
    (origins) => {
        true
    };
    (boolean) => {
        false
    };
    (integer) => {
        false
    };
    (optional) => {
        true
    };
}
macro_rules! read {
    (encoded, $c:ident, $field:ident) => {
        serde_json::json!(crate::email::decode($c.$field.as_deref()).ok().flatten())
    };
    (origins, $c:ident, $field:ident) => {
        match $c.cors_origins() {
            Ok(value) => serde_json::json!(value),
            Err(_) => Value::Null,
        }
    };
    ($kind:ident, $c:ident, $field:ident) => {
        serde_json::json!($c.$field)
    };
}
macro_rules! catalog {
    ($($field:ident: $kind:ident, $group:ident, $min:expr, $max:expr, [$($dependency:literal),*];)*) => {
        pub static CATALOG: &[Definition] = &[$(Definition {
            key: stringify!($field), group: Group::$group, kind: kind!($kind),
            scope: Scope::Project, authority: Authority::HostOperator,
            sensitive: false, restart: Restart::Application,
            nullable: nullable!($kind),
            minimum: $min, maximum: $max, dependencies: &[$($dependency),*],
            read: |c| read!($kind, c, $field),
            effective_read: |c| effective!($field, $kind, c),
            write: |c, v| { c.$field = value!($kind, v); Ok(()) },
        }),*];
    };
}

macro_rules! effective {
    ($field:ident, encoded, $c:ident) => {
        serde_json::json!(
            crate::email::Settings::from_config($c)
                .ok()
                .and_then(|s| s.catalog_value(stringify!($field)))
        )
    };
    (api_concurrency_per_caller, $kind:ident, $c:ident) => {
        serde_json::json!($c.api_concurrency_limit())
    };
    (max_rows, $kind:ident, $c:ident) => {
        serde_json::json!($c.max_rows.unwrap_or(crate::config::DEFAULT_MAX_ROWS))
    };
    ($field:ident, $kind:ident, $c:ident) => {
        read!($kind, $c, $field)
    };
}

// Bounds below constrain panel operations, not the compatibility contract of
// hand-managed Config. Defaults come from Config::default, never a second list.
// Integer maxima fit JSON's exact range. Large resource changes still need an
// operator's review; these bounds are not a host memory capacity guarantee.
catalog! {
    signup_enabled: boolean, Authentication, 0, 1, [];
    jwt_expiry_secs: integer, Authentication, 60, 86_400, [];
    refresh_token_ttl_days: integer, Authentication, 1, 3_650, [];
    auth_rate_limit_per_minute: integer, Authentication, 1, 1_000_000, [];
    email_language: text, Email, 2, 5, [];
    email_recovery_subject_base64: encoded, Email, 1, crate::email::MAX_SUBJECT_BYTES as u64, ["email_language"];
    email_recovery_text_base64: encoded, Email, 1, crate::email::MAX_TEXT_BYTES as u64, ["email_language"];
    email_signup_subject_base64: encoded, Email, 1, crate::email::MAX_SUBJECT_BYTES as u64, ["email_language"];
    email_signup_text_base64: encoded, Email, 1, crate::email::MAX_TEXT_BYTES as u64, ["email_language"];
    email_magiclink_subject_base64: encoded, Email, 1, crate::email::MAX_SUBJECT_BYTES as u64, ["email_language"];
    email_magiclink_text_base64: encoded, Email, 1, crate::email::MAX_TEXT_BYTES as u64, ["email_language"];
    email_recovery_ttl_minutes: integer, Email, crate::email::Kind::Recovery.bounds().0 as u64, crate::email::Kind::Recovery.bounds().1 as u64, [];
    email_signup_ttl_minutes: integer, Email, crate::email::Kind::Signup.bounds().0 as u64, crate::email::Kind::Signup.bounds().1 as u64, [];
    email_magiclink_ttl_minutes: integer, Email, crate::email::Kind::MagicLink.bounds().0 as u64, crate::email::Kind::MagicLink.bounds().1 as u64, [];
    api_rate_limit_per_minute: integer, Api, 0, 10_000_000, [];
    cors_allow_origins: origins, Api, 0, 32, [];
    max_rows: optional, Api, 1, 1_000_000, [];
    max_body_bytes: integer, Api, 1, 64 * 1024 * 1024, [];
    api_concurrency_per_caller: optional, Api, 0, 256, ["db_pool_size"];
    db_pool_size: integer, Api, 1, 256, ["api_concurrency_per_caller"];
    request_timeout_secs: integer, Api, 1, 86_401, ["statement_timeout_secs"];
    statement_timeout_secs: integer, Api, 0, 86_400, ["request_timeout_secs"];
    storage_max_file_size: integer, Storage, 1, 5 * 1024_u64.pow(4), [];
    storage_max_total_size: optional, Storage, 0, 9_007_199_254_740_991, [];
    storage_min_free_bytes: integer, Storage, 0, 9_007_199_254_740_991, [];
    storage_upload_timeout_secs: integer, Storage, 1, 86_400, [];
    storage_uploads_per_caller: integer, Storage, 0, 32, [];
}

impl Definition {
    pub fn value(&self, config: &Config) -> Value {
        (self.read)(config)
    }

    pub fn default_value(&self) -> Value {
        self.value(&Config::default())
    }

    /// Includes derived defaults actually consumed by runtime adapters, such as
    /// half-pool concurrency. This can differ from the saved optional value.
    pub fn effective_value(&self, config: &Config) -> Value {
        (self.effective_read)(config)
    }

    pub fn environment_key(&self) -> String {
        format!("NELCOTA_{}", self.key.to_ascii_uppercase())
    }

    pub fn validate(&self, value: &Value) -> Result<(), SettingsError> {
        if value.is_null() && self.nullable {
            return Ok(());
        }
        let valid = match self.kind {
            Kind::Boolean => value.is_boolean(),
            Kind::Text => value
                .as_str()
                .is_some_and(|v| (self.minimum..=self.maximum).contains(&(v.len() as u64))),
            Kind::Integer => value
                .as_u64()
                .is_some_and(|v| (self.minimum..=self.maximum).contains(&v)),
            Kind::Origins => value.as_array().is_some_and(|values| {
                if values.len() > self.maximum as usize {
                    return false;
                }
                let origins = values.iter().map(Value::as_str).collect::<Option<Vec<_>>>();
                origins.is_some_and(|origins| {
                    let config = Config {
                        cors_allow_origins: Some(origins.join(",")),
                        ..Config::default()
                    };
                    // An empty member would otherwise disappear in an empty list.
                    origins
                        .iter()
                        .all(|v| !v.is_empty() && v.trim() == *v && !v.contains(','))
                        && config.cors_origins().is_ok()
                })
            }),
        };
        match valid {
            true => Ok(()),
            false => Err(SettingsError::Value),
        }
    }
}

/// Apply a typed, non-empty partial batch to a complete private candidate, then
/// validate it jointly. Caller owns source revision, persistence and restart.
/// The original candidate is not mutated on failure.
pub fn candidate(
    current: &Config,
    changes: &BTreeMap<String, Value>,
) -> Result<Config, SettingsError> {
    if changes.is_empty() || changes.len() > CATALOG.len() {
        return Err(SettingsError::Value);
    }
    let mut next = current.clone();
    for (key, value) in changes {
        let definition = CATALOG
            .iter()
            .find(|d| d.key == key)
            .ok_or(SettingsError::Unknown)?;
        definition.validate(value)?;
        let value = match value.is_null() {
            true => definition.default_value(),
            false => value.clone(),
        };
        if value.is_null() && definition.kind == Kind::Origins {
            next.cors_allow_origins = None;
            continue;
        }
        (definition.write)(&mut next, value)?;
    }
    if next.statement_timeout_secs > 0 && next.request_timeout_secs <= next.statement_timeout_secs {
        return Err(SettingsError::Combination);
    }
    if (changes.contains_key("api_concurrency_per_caller") || changes.contains_key("db_pool_size"))
        && next
            .api_concurrency_per_caller
            .is_some_and(|v| v > next.db_pool_size)
    {
        return Err(SettingsError::Combination);
    }
    next.validate().map_err(|_| SettingsError::Candidate)?;
    next.oauth().map_err(|_| SettingsError::Candidate)?;
    Ok(next)
}

#[cfg(test)]
mod tests;
