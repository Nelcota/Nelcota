//! Host policy validation and admission checks before privileged mutations.
use super::effects::approved_backup;
use super::effects::output;
use super::policy::{control_project, free_bytes, validate_policy};
use super::{live, settings};
use crate::backup;
use crate::host::Host;
use crate::host::Runtime;
use crate::updates::policy::Policy;
use anyhow::Context;
use nelcota_deployment::Journal;
use nelcota_deployment::management::HostJournal;
use nelcota_deployment::management::Operation;
use std::process::Command;
use std::time::Duration;

pub(in crate::updates) async fn blockers(
    policy: &Policy,
    op: &Operation,
) -> anyhow::Result<Vec<String>> {
    op.validate()?;
    let p = policy
        .host_management
        .as_ref()
        .context("host management disabled")?;
    validate_policy(p)?;
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    let mut blocked = Vec::new();
    if HostJournal::open(&policy.root)?.list()?.len() >= 255 {
        blocked.push("history_full".into());
    }
    if manifest.runtime != Runtime::Docker {
        blocked.push("docker_required".into());
    }
    if free_bytes(&policy.root) < policy.minimum_free_bytes {
        blocked.push("insufficient_disk".into());
    }
    if Journal::open(&policy.root)?
        .list()?
        .iter()
        .any(|j| !j.public.phase.terminal())
        || HostJournal::open(&policy.root)?
            .list()?
            .iter()
            .any(|j| !j.public.stage.terminal())
    {
        blocked.push("host_busy".into());
    }
    match op {
        Operation::Create {
            project,
            domain,
            profile,
        } => {
            if let Some(reason) = docker_namespace_blocker(project).await {
                blocked.push(reason.into());
            }
            if manifest.projects.len() >= p.max_projects {
                blocked.push("project_limit".into());
            }
            if host.project_dir(project).exists()
                || manifest.projects.iter().any(|v| v.name == *project)
            {
                blocked.push("project_exists".into());
            }
            if url::Url::parse(&policy.origin)?
                .host_str()
                .is_some_and(|controller| controller == domain)
                || manifest.projects.iter().any(|v| v.domain == *domain)
            {
                blocked.push("domain_exists".into());
            }
            if !p
                .domain_suffixes
                .iter()
                .any(|suffix| domain == suffix || domain.ends_with(&format!(".{suffix}")))
                || domain.parse::<std::net::IpAddr>().is_ok()
            {
                blocked.push("domain_forbidden".into());
            }
            if manifest.panel_login != crate::host::PanelLogin::Shared {
                blocked.push("shared_panel_required".into());
            }
            let ram = crate::checks::total_ram_mb().unwrap_or(0);
            let requested: u64 = match profile.as_str() {
                "1gb" => 1024,
                "2gb" => 2048,
                "4gb" => 4096,
                "8gb" => 8192,
                _ => 0,
            };
            if ram == 0 || requested > ram / (manifest.projects.len() as u64 + 1) {
                blocked.push("insufficient_memory".into());
            }
            let lookup = tokio::time::timeout(
                Duration::from_secs(3),
                tokio::net::lookup_host((domain.as_str(), 443)),
            )
            .await;
            let expected: Vec<_> = p
                .addresses
                .iter()
                .filter_map(|s| s.parse::<std::net::IpAddr>().ok())
                .collect();
            match lookup {
                Ok(Ok(addresses)) => {
                    let ips: Vec<_> = addresses.map(|s| s.ip()).collect();
                    if ips.is_empty() || ips.iter().any(|ip| !expected.contains(ip)) {
                        blocked.push("dns_mismatch".into());
                    }
                }
                _ => blocked.push("dns_unavailable".into()),
            }
        }
        _ => {
            if let Ok(project) = control_project(policy, op.project())
                && matches!(
                    op,
                    Operation::Restart { .. }
                        | Operation::Configure { .. }
                        | Operation::BackupOffsite { .. }
                        | Operation::TestBackup { .. }
                        | Operation::TestAlerts { .. }
                        | Operation::TestSmtp { .. }
                )
            {
                if matches!(op, Operation::Restart { .. } | Operation::Configure { .. })
                    && !live::check(&project).await.unwrap_or(false)
                {
                    blocked.push("running_configuration_changed".into());
                }
                if project.path(crate::maintenance::MARKER).exists() {
                    blocked.push("maintenance_requires_recovery".into());
                }
                if crate::pitr::fence::require_clear(&project).is_err() {
                    blocked.push("restore_fenced".into());
                }
            }
            if control_project(policy, op.project()).is_err() {
                blocked.push("project_layout_changed".into());
            }
            if matches!(
                op,
                Operation::BackupOffsite { .. } | Operation::Backup { .. }
            ) && let Ok(project) = control_project(policy, op.project())
            {
                let mut command = project.as_postgres(&["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-c", "SELECT pg_database_size(current_database())::text || ',' || coalesce((SELECT sum(size) FROM storage.objects),0)::text"]);
                command.env("PGOPTIONS", "-c statement_timeout=4000");
                let required = output(command).await.ok().and_then(|s| {
                    let (db, files) = s.trim().split_once(',')?;
                    db.parse::<u64>()
                        .ok()?
                        .checked_add(files.parse::<u64>().ok()?)?
                        .checked_mul(3)?
                        .checked_add(policy.minimum_free_bytes)
                });
                match required {
                    Some(bytes) if free_bytes(&policy.root) >= bytes => {}
                    _ => blocked.push("insufficient_backup_reserve".into()),
                }
            }
            if matches!(
                op,
                Operation::BackupOffsite { .. } | Operation::TestBackup { .. }
            ) {
                let endpoint = host.secrets().get("NELCOTA_BACKUP_S3_ENDPOINT")?;
                match endpoint {
                    Some(endpoint)
                        if endpoint.starts_with("https://") && backup::valid_destination(&host) =>
                    {
                        if settings::approved_service(policy, &endpoint).is_err() {
                            blocked.push("service_not_approved".into());
                        }
                    }
                    _ => blocked.push("offsite_not_configured".into()),
                }
            }
            if matches!(op, Operation::TestAlerts { .. })
                && !crate::updates::alerts::configured(policy)?
            {
                blocked.push("alerts_not_configured".into());
            }
            if let Operation::TestSmtp { .. } = op
                && let Ok(project) = control_project(policy, op.project())
            {
                match project.env().get("NELCOTA_SMTP_URL")? {
                    Some(url) => {
                        if settings::approved_service(policy, &url).is_err() {
                            blocked.push("service_not_approved".into());
                        }
                    }
                    None => blocked.push("smtp_not_configured".into()),
                }
            }
            if let Operation::Restore { backup, .. } = op
                && approved_backup(policy, op.project(), backup).is_err()
            {
                blocked.push("backup_unavailable".into());
            }
        }
    }
    Ok(blocked)
}
pub(super) async fn docker_namespace_blocker(project: &str) -> Option<&'static str> {
    let mut containers = Command::new("docker");
    containers.args([
        "ps",
        "-a",
        "--filter",
        &format!("label=com.docker.compose.project=nelcota-{project}"),
        "--format",
        "{{.ID}}",
    ]);
    let mut volumes = Command::new("docker");
    volumes.args([
        "volume",
        "ls",
        "--filter",
        &format!("name=^nelcota-{project}_pgdata$"),
        "--format",
        "{{.Name}}",
    ]);
    let mut networks = Command::new("docker");
    networks.args([
        "network",
        "ls",
        "--filter",
        &format!("name=^nelcota-{project}_(internal|egress)$"),
        "--format",
        "{{.Name}}",
    ]);
    match tokio::try_join!(output(containers), output(volumes), output(networks)) {
        Ok((containers, volumes, networks))
            if [containers.as_str(), volumes.as_str(), networks.as_str()]
                .iter()
                .any(|text| !text.trim().is_empty()) =>
        {
            Some("docker_namespace_exists")
        }
        Ok(_) => None,
        Err(_) => Some("docker_unavailable"),
    }
}
