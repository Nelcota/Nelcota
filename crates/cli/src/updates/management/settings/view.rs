//! Explicit non-secret projection of current configuration and installed cron.
use super::*;
use crate::backup;
pub(crate) fn view(policy: &Policy, name: &str) -> anyhow::Result<ConfigurationView> {
    let p = control_project(policy, name)?;
    let host = Host::new(&policy.root);
    let env = p.env();
    let mut fields = BTreeMap::new();
    for key in [
        "NELCOTA_SMTP_FROM",
        "NELCOTA_PASSWORD_RECOVERY_URL",
        "NELCOTA_EMAIL_CONFIRMATION_URL",
        "NELCOTA_MAGIC_LINK_URL",
        "NELCOTA_OAUTH_GOOGLE_CLIENT_ID",
        "NELCOTA_OAUTH_GITHUB_CLIENT_ID",
        "NELCOTA_OAUTH_REDIRECT_URLS",
    ] {
        if let Some(value) = env.get(key)? {
            fields.insert(key.into(), value);
        }
    }
    for key in [
        "NELCOTA_BACKUP_S3_ENDPOINT",
        "NELCOTA_BACKUP_S3_BUCKET",
        "NELCOTA_BACKUP_S3_REGION",
    ] {
        if let Some(value) = host.secrets().get(key)? {
            // Never project embedded credentials or signed query parameters from
            // a legacy endpoint into an ostensibly non-secret form field.
            if key == "NELCOTA_BACKUP_S3_ENDPOINT" {
                let safe = url::Url::parse(&value).is_ok_and(|u| {
                    u.scheme() == "https"
                        && u.username().is_empty()
                        && u.password().is_none()
                        && u.query().is_none()
                        && u.fragment().is_none()
                        && u.path() == "/"
                });
                if !safe {
                    continue;
                }
            }
            fields.insert(key.into(), value);
        }
    }
    if let Ok(bytes) = read_private(Path::new(crate::machine::BACKUP_CRON), 16384)
        && let Ok(cron) = String::from_utf8(bytes)
        && let Some((hour, minute, keep)) = schedule_values(&cron)
    {
        fields.insert("BACKUP_HOUR".into(), hour.to_string());
        fields.insert("BACKUP_MINUTE".into(), minute.to_string());
        fields.insert("BACKUP_KEEP".into(), keep.to_string());
    }
    Ok(ConfigurationView {
        project: name.into(),
        fields,
        smtp_configured: env.get("NELCOTA_SMTP_URL")?.is_some(),
        google_configured: env.get("NELCOTA_OAUTH_GOOGLE_CLIENT_SECRET")?.is_some(),
        github_configured: env.get("NELCOTA_OAUTH_GITHUB_CLIENT_SECRET")?.is_some(),
        backup_configured: backup::valid_destination(&host),
        shared_login: host.require()?.panel_login == crate::host::PanelLogin::Shared,
    })
}

pub(super) fn schedule_values(text: &str) -> Option<(u8, u8, u16)> {
    let lines = text
        .lines()
        .filter(|line| line.contains(" backup --all --keep "))
        .collect::<Vec<_>>();
    if lines.len() != 1 {
        return None;
    }
    let parts = lines[0].split_whitespace().collect::<Vec<_>>();
    if parts.len() < 11 || parts[2..6] != ["*", "*", "*", "root"] {
        return None;
    }
    let minute = parts[0].parse::<u8>().ok()?;
    let hour = parts[1].parse::<u8>().ok()?;
    let keep = parts
        .get(parts.iter().position(|p| *p == "--keep")? + 1)?
        .parse::<u16>()
        .ok()?;
    (hour < 24 && minute < 60 && (1..=365).contains(&keep)).then_some((hour, minute, keep))
}
