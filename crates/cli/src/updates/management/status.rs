//! Bounded host inventory and redacted operator log views.
use super::effects::approved_backup;
use super::effects::output;
use super::policy::control_project;
use super::policy::free_bytes;
use crate::host::Host;
use crate::project::Project;
use crate::updates::policy::Policy;
use anyhow::bail;
use nelcota_deployment::Journal;
use nelcota_deployment::management::HostJournal;
use nelcota_deployment::read_private;
use std::fs;
use std::process::Command;

pub(in crate::updates) async fn status(
    policy: &Policy,
) -> anyhow::Result<nelcota_deployment::management::Status> {
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    if manifest.projects.len() > 32 {
        bail!("host inventory too large");
    }
    let mut command = Command::new("docker");
    command.args([
        "ps",
        "-a",
        "--format",
        "{{json .}}",
        "--filter",
        "label=com.docker.compose.project",
    ]);
    let rows = output(command).await.unwrap_or_default();
    let states: Vec<serde_json::Value> = rows
        .lines()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();
    let mut projects = Vec::new();
    for entry in manifest.projects {
        let health = |service: &str| {
            states
                .iter()
                .find(|row| {
                    let labels = row["Labels"].as_str().unwrap_or("");
                    labels
                        .split(',')
                        .any(|s| s == format!("com.docker.compose.project=nelcota-{}", entry.name))
                        && labels
                            .split(',')
                            .any(|s| s == format!("com.docker.compose.service={service}"))
                })
                .map(|row| {
                    let status = row["Status"].as_str().unwrap_or("");
                    if status.contains("(unhealthy)") {
                        return "unhealthy".to_owned();
                    }
                    if status.contains("(healthy)") {
                        return "healthy".to_owned();
                    }
                    row["State"].as_str().unwrap_or("unknown").to_owned()
                })
                .unwrap_or_else(|| "unknown".into())
        };
        let project = Project::new(
            &entry.name,
            &host.project_dir(&entry.name),
            manifest.runtime,
        );
        // Inventory must remain available after a partial removal or provisioning.
        // Mutation adapters still require the enrolled identity and trusted layout.
        let version = read_private(&project.path(".env"), 65536)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|text| {
                crate::envfile::parse(&text)
                    .into_iter()
                    .find(|(key, _)| key == "NELCOTA_VERSION")
                    .map(|(_, value)| value)
            })
            .unwrap_or_default();
        let mut backups = Vec::new();
        if let Ok(entries) = fs::read_dir(project.path("backups")) {
            for entry in entries.take(512) {
                let file = entry?.file_name().to_string_lossy().into_owned();
                if approved_backup(policy, &project.name, &file).is_ok() {
                    backups.push(file);
                }
            }
        }
        backups.sort();
        backups.reverse();
        backups.truncate(32);
        projects.push(nelcota_deployment::management::Project {
            name: entry.name.clone(),
            domain: entry.domain,
            version,
            app: health("app"),
            database: health("postgres"),
            backups,
        });
    }
    Ok(nelcota_deployment::management::Status {
        receipt: None,
        enabled: policy.host_management.is_some(),
        busy: Journal::open(&policy.root)?
            .list()?
            .iter()
            .any(|job| !job.public.phase.terminal()),
        projects,
        jobs: HostJournal::open(&policy.root)?
            .list()?
            .into_iter()
            .map(|t| t.public)
            .take(32)
            .collect(),
        max_projects: policy
            .host_management
            .as_ref()
            .map_or(0, |p| p.max_projects),
        ram_mb: crate::checks::total_ram_mb().unwrap_or(0),
        free_bytes: free_bytes(&policy.root),
    })
}
pub(in crate::updates) async fn logs(
    policy: &Policy,
    name: &str,
    service: nelcota_deployment::management::LogService,
) -> anyhow::Result<Vec<nelcota_deployment::management::LogEntry>> {
    let project = control_project(policy, name)?;
    let mut command = project.compose_command();
    command.args([
        "logs",
        "--no-color",
        "--no-log-prefix",
        "--tail",
        "100",
        match service {
            nelcota_deployment::management::LogService::App => "app",
            nelcota_deployment::management::LogService::Database => "postgres",
        },
    ]);
    let text = output(command).await?;
    Ok(log_metadata(&text))
}
pub(super) fn log_metadata(text: &str) -> Vec<nelcota_deployment::management::LogEntry> {
    text.lines()
        .take(100)
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| value.is_object())
        .map(|value| {
            let bounded = |key: &str| {
                value[key]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(160)
                    .collect()
            };
            // Free-form application/SQL messages may contain user data or credentials.
            // Only structured metadata crosses into the browser.
            nelcota_deployment::management::LogEntry {
                timestamp: bounded("timestamp"),
                level: bounded("level"),
                target: bounded("target"),
                message: "event_metadata_only".into(),
            }
        })
        .collect()
}
