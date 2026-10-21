//! Typed operator inputs and browser-safe operational diagnostics.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Section {
    Smtp,
    OauthGoogle,
    OauthGithub,
    Backup,
    Schedule,
    AdminPassword,
}

// Deliberately not Debug: inputs may contain credentials. Never put these in
// public plans, receipts, browser storage, logs or error messages.
#[derive(Deserialize, Serialize)]
#[serde(tag = "section", rename_all = "snake_case", deny_unknown_fields)]
pub enum Configuration {
    Smtp {
        enabled: bool,
        url: Option<String>,
        from: String,
        recovery_url: String,
        confirmation_url: String,
        magic_link_url: String,
    },
    OauthGoogle {
        enabled: bool,
        client_id: String,
        client_secret: Option<String>,
        redirects: Vec<String>,
    },
    OauthGithub {
        enabled: bool,
        client_id: String,
        client_secret: Option<String>,
        redirects: Vec<String>,
    },
    Backup {
        enabled: bool,
        endpoint: String,
        bucket: String,
        region: String,
        access_key: Option<String>,
        secret_key: Option<String>,
    },
    Schedule {
        hour: u8,
        minute: u8,
        keep: u16,
    },
    AdminPassword {
        new_password: String,
    },
}
impl Configuration {
    pub fn section(&self) -> Section {
        match self {
            Self::Smtp { .. } => Section::Smtp,
            Self::OauthGoogle { .. } => Section::OauthGoogle,
            Self::OauthGithub { .. } => Section::OauthGithub,
            Self::Backup { .. } => Section::Backup,
            Self::Schedule { .. } => Section::Schedule,
            Self::AdminPassword { .. } => Section::AdminPassword,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct ConfigurationView {
    pub project: String,
    /// Only explicitly selected non-secret fields; never a raw environment file.
    pub fields: std::collections::BTreeMap<String, String>,
    pub smtp_configured: bool,
    pub google_configured: bool,
    pub github_configured: bool,
    pub backup_configured: bool,
    pub shared_login: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Passed,
    Warning,
    Failed,
    Unavailable,
}
#[derive(Serialize, Deserialize)]
pub struct Diagnostics {
    pub project: String,
    pub checked_at: u64,
    pub memory_total_bytes: Option<u64>,
    pub memory_available_bytes: Option<u64>,
    pub cpu_percent: Option<f64>,
    pub load_one: Option<f64>,
    pub free_bytes: u64,
    pub last_backup_at: Option<u64>,
    pub last_offsite_backup_at: Option<u64>,
    pub checks: Vec<Check>,
}
