//! Bounded operational incidents and delivery receipts; no runtime or credentials.
use crate::{valid_digest, valid_project};
use anyhow::{bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
mod engine;
pub use engine::{Batch, DeliveryState, Engine, Event, Incident, Observation, Sample};
#[cfg(test)]
mod tests;

pub const CHECK_INTERVAL: u64 = 60;
pub const MAX_INCIDENTS: usize = 258;
/// Allowed alert settings; the form, the Rust check and the schema share them.
pub const DISK_PERCENT: (u8, u8) = (5, 50);
pub const DISK_GIB: (u16, u16) = (1, 1024);
pub const CERTIFICATE_DAYS: (u8, u8) = (1, 60);
pub const BACKUP_HOURS: (u16, u16) = (1, 168);
pub const REMINDER_HOURS: (u16, u16) = (1, 168);
/// The only codes each status field may carry; the panel can explain all of them.
pub const HEARTBEAT_ERRORS: [&str; 1] = ["alert_heartbeat_failed"];
pub const MONITOR_ERRORS: [&str; 5] = [
    "alert_probe_failed",
    "alert_state_unavailable",
    "alert_configuration_invalid",
    "alert_observer_unavailable",
    "alert_policy_changed",
];
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub email_enabled: bool,
    pub webhook_enabled: bool,
    pub heartbeat_enabled: bool,
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::OPTIONAL_PROJECT)))]
    pub smtp_project: String,
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::NO_CONTROL), length(max = crate::schema::EMAIL_MAX)))]
    pub recipient: String,
    #[cfg_attr(feature = "schema", schemars(range(min = DISK_PERCENT.0, max = DISK_PERCENT.1)))]
    pub disk_percent: u8,
    #[cfg_attr(feature = "schema", schemars(range(min = DISK_GIB.0, max = DISK_GIB.1)))]
    pub disk_gib: u16,
    #[cfg_attr(feature = "schema", schemars(range(min = CERTIFICATE_DAYS.0, max = CERTIFICATE_DAYS.1)))]
    pub certificate_days: u8,
    #[cfg_attr(feature = "schema", schemars(range(min = BACKUP_HOURS.0, max = BACKUP_HOURS.1)))]
    pub backup_hours: u16,
    #[cfg_attr(feature = "schema", schemars(range(min = REMINDER_HOURS.0, max = REMINDER_HOURS.1)))]
    pub reminder_hours: u16,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            email_enabled: false,
            webhook_enabled: false,
            heartbeat_enabled: false,
            smtp_project: String::new(),
            recipient: String::new(),
            disk_percent: 15,
            disk_gib: 3,
            certificate_days: 14,
            backup_hours: 26,
            reminder_hours: 24,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            (DISK_PERCENT.0..=DISK_PERCENT.1).contains(&self.disk_percent)
                && (DISK_GIB.0..=DISK_GIB.1).contains(&self.disk_gib)
                && (CERTIFICATE_DAYS.0..=CERTIFICATE_DAYS.1).contains(&self.certificate_days)
                && (BACKUP_HOURS.0..=BACKUP_HOURS.1).contains(&self.backup_hours)
                && (REMINDER_HOURS.0..=REMINDER_HOURS.1).contains(&self.reminder_hours),
            "invalid_alert_limits"
        );
        if self.enabled && !self.email_enabled && !self.webhook_enabled {
            bail!("alert_channel_required");
        }
        if (!self.smtp_project.is_empty() && !valid_project(&self.smtp_project))
            || self.recipient.len() > crate::schema::EMAIL_MAX
            || self.recipient.chars().any(char::is_control)
            || (self.email_enabled && (self.smtp_project.is_empty() || self.recipient.is_empty()))
        {
            bail!("invalid_alert_email");
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Email,
    Webhook,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Application,
    Database,
    Https,
    Certificate,
    Disk,
    BackupLate,
    BackupFailed,
    Monitoring,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warning,
    Critical,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ChannelView {
    pub channel: Channel,
    #[cfg_attr(feature = "schema", schemars(range(max = crate::schema::TIME_MAX)))]
    pub last_success_at: Option<u64>,
    #[cfg_attr(feature = "schema", schemars(extend("enum" = ["alert_delivery_failed", null])))]
    pub last_error: Option<String>,
    #[cfg_attr(feature = "schema", schemars(range(max = crate::schema::TIME_MAX)))]
    pub next_attempt_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct IncidentView {
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::INCIDENT_KEY)))]
    pub key: String,
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::PROJECT)))]
    pub project: Option<String>,
    pub kind: Kind,
    pub severity: Severity,
    pub active: bool,
    #[cfg_attr(feature = "schema", schemars(range(max = crate::schema::TIME_MAX)))]
    pub since: u64,
    #[cfg_attr(feature = "schema", schemars(range(max = crate::schema::TIME_MAX)))]
    pub changed_at: u64,
}
#[cfg(feature = "schema")]
fn codes_or_null(schema: &mut schemars::Schema, codes: &[&str]) {
    let mut allowed: Vec<serde_json::Value> = codes.iter().map(|code| (*code).into()).collect();
    allowed.push(serde_json::Value::Null);
    schema.insert("enum".into(), allowed.into());
}
#[cfg(feature = "schema")]
fn heartbeat_error(schema: &mut schemars::Schema) {
    codes_or_null(schema, &HEARTBEAT_ERRORS);
}
#[cfg(feature = "schema")]
fn monitor_error(schema: &mut schemars::Schema) {
    codes_or_null(schema, &MONITOR_ERRORS);
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(deny_unknown_fields))]
pub struct Status {
    pub settings: Settings,
    #[cfg_attr(feature = "schema", schemars(length(max = crate::schema::MAX_RECIPIENTS), inner(pattern(crate::schema::NO_CONTROL), length(max = crate::schema::EMAIL_MAX)), extend("uniqueItems" = true)))]
    pub recipients: Vec<String>,
    #[cfg_attr(feature = "schema", schemars(length(max = crate::schema::MAX_PROJECTS), inner(pattern(crate::schema::PROJECT)), extend("uniqueItems" = true)))]
    pub projects: Vec<String>,
    pub webhook_configured: bool,
    pub heartbeat_configured: bool,
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::HOST_NAME), length(max = crate::schema::HOST_NAME_MAX)))]
    pub webhook_host: Option<String>,
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::HOST_NAME), length(max = crate::schema::HOST_NAME_MAX)))]
    pub heartbeat_host: Option<String>,
    #[cfg_attr(feature = "schema", schemars(range(max = crate::schema::TIME_MAX)))]
    pub last_scan_at: Option<u64>,
    #[cfg_attr(feature = "schema", schemars(range(max = crate::schema::TIME_MAX)))]
    pub heartbeat_accepted_at: Option<u64>,
    #[cfg_attr(feature = "schema", schemars(transform = heartbeat_error))]
    pub heartbeat_error: Option<String>,
    #[cfg_attr(feature = "schema", schemars(transform = monitor_error))]
    pub monitor_error: Option<String>,
    pub maintenance: bool,
    #[cfg_attr(feature = "schema", schemars(length(max = MAX_INCIDENTS)))]
    pub incidents: Vec<IncidentView>,
    #[cfg_attr(feature = "schema", schemars(length(max = crate::schema::MAX_CHANNELS)))]
    pub channels: Vec<ChannelView>,
}
pub(super) fn valid_key(key: &str, project: Option<&str>) -> bool {
    match project {
        Some(project) => {
            valid_project(project)
                && key.split_once('.').is_some_and(|(id, kind)| {
                    valid_digest(id)
                        && !kind.is_empty()
                        && kind.len() <= 20
                        && kind.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
                })
        }
        None => matches!(key, "host.disk" | "host.monitoring"),
    }
}

impl Kind {
    pub fn code(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Database => "database",
            Self::Https => "https",
            Self::Certificate => "certificate",
            Self::Disk => "disk",
            Self::BackupLate => "backup_late",
            Self::BackupFailed => "backup_failed",
            Self::Monitoring => "monitoring",
        }
    }
}
