//! Deployment layout, backup policy and disk-space admission.
use super::validation::health;
use crate::backup;
use crate::host::Host;
use crate::host::Runtime;
use crate::project::Project;
use crate::updates::policy::Policy;
use crate::updates::probes;
use anyhow::Context;
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn blockers(policy: &Policy, project: &Project) -> Vec<String> {
    let mut reasons = Vec::new();
    match project.env().read() {
        Ok(entries) => {
            let mut names = std::collections::HashSet::new();
            if entries.iter().any(|(name, _)| {
                !names.insert(name)
                    || name == "NELCOTA_CONFIG"
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            }) {
                reasons.push("configuration_layout_not_enrolled".into());
            }
        }
        Err(_) => reasons.push("configuration_layout_not_enrolled".into()),
    }

    if !policy.installation_validated() {
        reasons.push("installation_not_validated".into());
    }
    if project.runtime == Runtime::Docker
        && project.env().get("NELCOTA_IMAGE").ok().flatten().as_deref()
            != Some("ghcr.io/nelcota/nelcota-server")
    {
        reasons.push("custom_image_not_enrolled".into());
    }
    let db_host = match project.runtime {
        Runtime::Docker => "postgres",
        Runtime::Systemd => "127.0.0.1",
    };
    if project
        .env()
        .get("NELCOTA_DATABASE_URL")
        .ok()
        .flatten()
        .and_then(|value| url::Url::parse(&value).ok())
        .is_none_or(|url| {
            !matches!(url.scheme(), "postgres" | "postgresql")
                || url.host_str() != Some(db_host)
                || url.port() != Some(5432)
                || url.path() != "/postgres"
                || url.username() != "postgres"
        })
    {
        reasons.push("database_layout_not_enrolled".into());
    }
    if project.stores_files_on_disk().unwrap_or(false) {
        let expected = match project.runtime {
            Runtime::Docker => "/storage".into(),
            Runtime::Systemd => project.storage_dir().to_string_lossy().into_owned(),
        };
        if project
            .env()
            .get("NELCOTA_STORAGE_DIR")
            .ok()
            .flatten()
            .as_deref()
            != Some(expected.as_str())
        {
            reasons.push("storage_layout_not_enrolled".into());
        }
    }
    let host = Host::new(&policy.root);
    if host
        .secrets()
        .get("NELCOTA_BACKUP_S3_ENDPOINT")
        .ok()
        .flatten()
        .is_none_or(|endpoint| {
            url::Url::parse(&endpoint).is_err() || !endpoint.starts_with("https://")
        })
    {
        reasons.push("secure_offsite_endpoint_required".into());
    }
    if !backup::s3_configured(&Host::new(&policy.root)) {
        reasons.push("offsite_backup_required".into());
    }
    if project
        .env()
        .get("NELCOTA_STORAGE_BACKEND")
        .ok()
        .flatten()
        .as_deref()
        == Some("s3")
    {
        reasons.push("s3_restore_not_validated".into());
    }
    if crate::pitr::enabled(project) {
        reasons.push("pitr_restore_not_validated".into());
    }
    if project.runtime == Runtime::Docker
        && fs::read_to_string(project.path("docker-compose.yml"))
            .ok()
            .is_none_or(|text| {
                !crate::updates::enroll::known_project_compose(project, &text)
                    || !text.contains("${NELCOTA_APP_IMAGE:-${NELCOTA_IMAGE}:${NELCOTA_VERSION}}")
                    || !text.contains("./deployment-control:/run/nelcota-deployment:ro")
            })
    {
        reasons.push("compose_enrollment_required".into());
    }
    if project.runtime == Runtime::Systemd && !crate::updates::enroll::native_unit_enrolled(project)
    {
        reasons.push("configuration_layout_not_enrolled".into());
    }
    if !reasons.is_empty() {
        return reasons;
    }
    if health(project).as_deref() != Some("healthy") {
        reasons.push("current_app_unhealthy".into());
    }
    let required = estimated_required(policy, project);
    if required
        .ok()
        .is_none_or(|required| free_bytes(&policy.root).is_none_or(|free| free < required))
    {
        reasons.push("insufficient_disk".into());
    }

    reasons
}
pub(super) fn free_bytes(root: &Path) -> Option<u64> {
    let output = probes::output(Command::new("df").args(["-P", "-B1"]).arg(root)).ok()?;
    output
        .lines()
        .nth(1)?
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()
}
pub(super) fn estimated_required(policy: &Policy, project: &Project) -> anyhow::Result<u64> {
    let database = probes::database_bytes(project)?;
    let files = match project.stores_files_on_disk()? {
        true => probes::output(
            Command::new("du")
                .args(["-s", "-B1"])
                .arg(project.storage_dir()),
        )?
        .split_whitespace()
        .next()
        .context("missing file size")?
        .parse::<u64>()?,
        false => 0,
    };
    database
        .checked_add(files)
        .and_then(|bytes| bytes.checked_mul(3))
        .and_then(|bytes| bytes.checked_add(policy.minimum_free_bytes))
        .context("deployment size overflow")
}
