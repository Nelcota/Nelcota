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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub email_enabled: bool,
    pub webhook_enabled: bool,
    pub heartbeat_enabled: bool,
    pub smtp_project: String,
    pub recipient: String,
    pub disk_percent: u8,
    pub disk_gib: u16,
    pub certificate_days: u8,
    pub backup_hours: u16,
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
            (5..=50).contains(&self.disk_percent)
                && (1..=1024).contains(&self.disk_gib)
                && (1..=60).contains(&self.certificate_days)
                && (1..=168).contains(&self.backup_hours)
                && (1..=168).contains(&self.reminder_hours),
            "invalid_alert_limits"
        );
        if self.enabled && !self.email_enabled && !self.webhook_enabled {
            bail!("alert_channel_required");
        }
        if (!self.smtp_project.is_empty() && !valid_project(&self.smtp_project))
            || self.recipient.len() > 254
            || self.recipient.chars().any(char::is_control)
            || (self.email_enabled && (self.smtp_project.is_empty() || self.recipient.is_empty()))
        {
            bail!("invalid_alert_email");
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Email,
    Webhook,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warning,
    Critical,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChannelView {
    pub channel: Channel,
    pub last_success_at: Option<u64>,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncidentView {
    pub key: String,
    pub project: Option<String>,
    pub kind: Kind,
    pub severity: Severity,
    pub active: bool,
    pub since: u64,
    pub changed_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Status {
    pub settings: Settings,
    pub recipients: Vec<String>,
    pub projects: Vec<String>,
    pub webhook_configured: bool,
    pub heartbeat_configured: bool,
    pub webhook_host: Option<String>,
    pub heartbeat_host: Option<String>,
    pub last_scan_at: Option<u64>,
    pub heartbeat_accepted_at: Option<u64>,
    pub heartbeat_error: Option<String>,
    pub monitor_error: Option<String>,
    pub maintenance: bool,
    pub incidents: Vec<IncidentView>,
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
