//! Browser-safe routine configuration contracts, independent of runtime config.
use serde::{Deserialize, Serialize};

/// Local-only runtime protocol. Never an authorization grant or a raw Config.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Runtime {
    pub schema: u32,
    pub values: std::collections::BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum Value {
    Boolean(bool),
    Integer(u64),
    Origins(
        #[cfg_attr(
            feature = "schema",
            schemars(
                length(max = 32),
                inner(length(max = 2048), pattern(crate::schema::NO_CONTROL))
            )
        )]
        Vec<String>,
    ),
    Automatic(()),
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Boolean,
    Integer,
    Origins,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Group {
    Authentication,
    Api,
    Storage,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Default,
    Environment,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Effective,
    Unavailable,
    FileOverride,
    Invalid,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    FileOverride,
    InvalidSavedConfiguration,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Setting {
    // The contract exporter restricts names/dependencies using the core catalog.
    pub key: String,
    pub group: Group,
    pub kind: Kind,
    pub nullable: bool,
    pub minimum: u64,
    pub maximum: u64,
    pub dependencies: Vec<String>,
    pub default_value: Value,
    pub saved_value: Value,
    /// Effective value implied by the saved configuration, including defaults
    /// derived from other fields. Used to distinguish drift from auto behavior.
    pub expected_value: Value,
    pub runtime_value: Value,
    pub source: Source,
    pub pending_restart: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct View {
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::DIGEST)))]
    pub revision: String,
    #[cfg_attr(feature = "schema", schemars(length(max = 32)))]
    pub settings: Vec<Setting>,
    pub runtime_status: RuntimeStatus,
    pub blocked: Option<Blocker>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Change {
    /// Effective impact, including implicit changes to derived defaults.
    pub key: String,
    pub before: Value,
    pub after: Value,
}
