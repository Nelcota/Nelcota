//! Literal env values, encrypted service grants and browser-safe error codes.
use super::*;
pub(super) fn text(value: &str, max: usize) -> anyhow::Result<()> {
    // Single-quoted Compose/systemd env values are literal. Reject unsupported
    // escapes rather than silently changing provider credentials or lines.
    if value.len() > max || value.chars().any(char::is_control) || value.contains(['\'', '\\']) {
        bail!("invalid_configuration_value");
    }
    Ok(())
}
pub(super) fn page(value: &str, optional: bool) -> anyhow::Result<()> {
    if optional && value.is_empty() {
        return Ok(());
    }
    let u = url::Url::parse(value).map_err(|_| anyhow::anyhow!("invalid_https_page"))?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || value.contains(',')
    {
        bail!("invalid_https_page");
    }
    text(value, 2048)
}
pub(super) fn secret(new: Option<String>, old: Option<String>) -> anyhow::Result<String> {
    let value = new
        .filter(|s| !s.is_empty())
        .or(old)
        .context("credential_required")?;
    text(&value, 4096)?;
    Ok(value)
}
pub(crate) fn approved_service(policy: &Policy, value: &str) -> anyhow::Result<()> {
    let u = url::Url::parse(value).map_err(|_| anyhow::anyhow!("invalid_service_url"))?;
    let name = u.host_str().context("invalid_service_url")?;
    let grant = policy.host_management.as_ref().context("host_forbidden")?;
    if name.parse::<std::net::IpAddr>().is_ok() || !grant.service_hosts.iter().any(|s| s == name) {
        bail!("service_not_approved");
    }
    Ok(())
}
pub(super) fn patch(
    before: &str,
    values: &BTreeMap<String, Option<String>>,
) -> anyhow::Result<String> {
    let mut seen = std::collections::HashSet::new();
    let mut lines = Vec::new();
    for line in before.lines() {
        let key = line.split_once('=').map(|(k, _)| k.trim());
        match key.and_then(|k| values.get_key_value(k)) {
            Some((key, value)) => {
                if seen.insert(key)
                    && let Some(value) = value
                {
                    text(value, 8192)?;
                    lines.push(format!("{key}='{value}'"));
                }
            }
            None => lines.push(line.to_owned()),
        }
    }
    for (key, value) in values {
        if !seen.contains(key)
            && let Some(value) = value
        {
            text(value, 8192)?;
            lines.push(format!("{key}='{value}'"));
        }
    }
    let result = lines.join("\n") + "\n";
    if result.len() > 65536 {
        bail!("configuration_too_large");
    }
    Ok(result)
}
pub(crate) fn bytes_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Only closed, non-sensitive codes may cross the IPC boundary.
pub(crate) fn error_code(error: &anyhow::Error) -> &'static str {
    match error.to_string().as_str() {
        "invalid_alert_limits" => "invalid_alert_limits",
        "alert_channel_required" => "alert_channel_required",
        "invalid_alert_email" | "invalid_alert_recipient" => "invalid_alert_recipient",
        "alert_email_project_changed" => "alert_email_project_changed",
        "invalid_alert_endpoint" | "invalid_alert_destination" => "invalid_alert_endpoint",
        "alert_endpoint_required" => "alert_endpoint_required",
        "invalid_alert_configuration" => "invalid_alert_configuration",
        "alerts_not_configured" => "alerts_not_configured",
        "alert_delivery_failed" => "alert_delivery_failed",
        "alert_heartbeat_failed" => "alert_heartbeat_failed",
        "service_not_approved" => "service_not_approved",
        "invalid_configuration_value" => "invalid_configuration_value",
        "invalid_https_page" => "invalid_https_page",
        "invalid_smtp_configuration" => "invalid_smtp_configuration",
        "invalid_oauth_configuration" => "invalid_oauth_configuration",
        "credential_required" => "credential_required",
        "configuration_too_large" => "configuration_too_large",
        "running_configuration_changed" | "running_configuration_unavailable" => {
            "running_configuration_changed"
        }
        "admin_password_length" => "admin_password_length",
        "invalid_backup_schedule" => "invalid_backup_schedule",
        "invalid_backup_endpoint" => "invalid_backup_endpoint",
        "invalid_backup_bucket" => "invalid_backup_bucket",
        "invalid_backup_region" => "invalid_backup_region",
        "smtp_not_configured" => "smtp_not_configured",
        "offsite_not_configured" => "offsite_not_configured",
        "smtp_test_timeout" => "smtp_test_timeout",
        "smtp_test_failed" => "smtp_test_failed",
        "backup_test_failed" => "backup_test_failed",
        "offsite_verification_failed" => "offsite_verification_failed",
        "maintenance_requires_recovery" => "maintenance_requires_recovery",
        "configuration_changed_outside_operation" => "configuration_changed_outside_operation",
        _ => "operation_failed",
    }
}
