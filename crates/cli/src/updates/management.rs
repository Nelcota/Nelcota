//! Privileged effects behind explicit host-operator policy and durable receipts.
use super::policy::{Policy, Provisioning, trusted_path};
use crate::{
    backup, caddy,
    host::{Host, ProjectEntry, Runtime},
    project::{Project, Service},
    registry, scaffold,
};
use anyhow::{Context, bail};
use nelcota_deployment::{
    HostLock, Journal, atomic_write, digest_file,
    management::{HostJournal, Operation, Stage, Task},
    read_private,
};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

mod diagnostics;
mod live;
mod routine;
pub(super) mod settings;
pub(super) use diagnostics::diagnostics;
pub(super) use routine::verify_prepared;

pub(super) fn validate_policy(p: &Provisioning) -> anyhow::Result<()> {
    let version = semver::Version::parse(&p.version)?;
    if !version.pre.is_empty()
        || !version.build.is_empty()
        || !nelcota_deployment::valid_digest(&p.image_digest)
        || p.source_sha.len() != 40
        || !p
            .source_sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || p.max_projects == 0
        || p.max_projects > 32
        || p.domain_suffixes.is_empty()
        || p.domain_suffixes.len() > 16
        || p.domain_suffixes
            .iter()
            .any(|s| !crate::naming::is_valid_domain(s) || s != &s.to_ascii_lowercase())
        || p.service_hosts.len() > 32
        || p.service_hosts
            .iter()
            .any(|s| !crate::naming::is_valid_domain(s) || s != &s.to_ascii_lowercase())
        || p.addresses.is_empty()
        || p.addresses.len() > 8
        || p.addresses.iter().any(|s| {
            s.parse::<std::net::IpAddr>()
                .map_or(true, |ip| !public_ip(ip))
        })
    {
        bail!("invalid host management policy");
    }
    Ok(())
}
/// Sanity check for the operator's own VPS addresses in the root-owned
/// provisioning policy. These are expected DNS answers for managed domains, not
/// user-supplied egress destinations, so this stays looser than the SSRF guard
/// `nelcota_core::net::is_public_address` (CGNAT and documentation addresses
/// keep loading, so installed policies don't break). It still refuses reserved
/// IPv4 and IPv6 forms that embed an IPv4 address, because health checks and
/// probes connect to these addresses.
fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && ip.octets()[0] != 0
                && ip.octets()[0] < IPV4_RESERVED_FIRST_OCTET
        }
        std::net::IpAddr::V6(ip) => {
            ip.to_ipv4_mapped().is_none()
                && !embeds_ipv4(ip.segments())
                && !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
        }
    }
}
/// 240.0.0.0/4 is reserved and never routed.
const IPV4_RESERVED_FIRST_OCTET: u8 = 240;
/// NAT64 64:ff9b::/96 and the local-use 64:ff9b:1::/48.
const NAT64_FIRST_SEGMENT: u16 = 0x0064;
const NAT64_SECOND_SEGMENT: u16 = 0xff9b;
const NAT64_LOCAL_SECOND_SEGMENT: u16 = 0xff9b;
const NAT64_LOCAL_THIRD_SEGMENT: u16 = 0x0001;
/// 6to4 2002::/16 and Teredo 2001::/32.
const SIX_TO_FOUR_FIRST_SEGMENT: u16 = 0x2002;
const TEREDO_FIRST_SEGMENT: u16 = 0x2001;
const TEREDO_SECOND_SEGMENT: u16 = 0x0000;
/// IPv6 forms that carry an IPv4 address a router may translate to.
fn embeds_ipv4(segments: [u16; 8]) -> bool {
    let [first, second, third, ..] = segments;
    // IPv4-compatible ::/96 (::1 and :: are covered by the loopback/unspecified checks).
    let compatible = segments[..6].iter().all(|segment| *segment == 0);
    let nat64 = first == NAT64_FIRST_SEGMENT
        && second == NAT64_SECOND_SEGMENT
        && segments[2..6].iter().all(|segment| *segment == 0);
    let nat64_local = first == NAT64_FIRST_SEGMENT
        && second == NAT64_LOCAL_SECOND_SEGMENT
        && third == NAT64_LOCAL_THIRD_SEGMENT;
    let six_to_four = first == SIX_TO_FOUR_FIRST_SEGMENT;
    let teredo = first == TEREDO_FIRST_SEGMENT && second == TEREDO_SECOND_SEGMENT;
    compatible || nat64 || nat64_local || six_to_four || teredo
}
pub(super) fn free_bytes(root: &Path) -> u64 {
    rustix::fs::statvfs(root)
        .ok()
        .and_then(|s| s.f_bavail.checked_mul(s.f_frsize))
        .unwrap_or(0)
}
pub(super) fn control_project(policy: &Policy, name: &str) -> anyhow::Result<Project> {
    if !nelcota_deployment::valid_project(name) || !policy.project_enrolled(name) {
        bail!("project identity changed");
    }
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    let project = host.select(&manifest, Some(name))?;
    trusted_path(&project.path(".env"))?;
    read_private(&project.path(".env"), 65536)?;
    trusted_path(&project.path("docker-compose.yml"))?;
    let text = fs::read_to_string(project.path("docker-compose.yml"))?;
    if project.runtime != Runtime::Docker || !super::enroll::known_project_compose(&project, &text)
    {
        bail!("custom project layout is not managed");
    }
    if project.env().get("NELCOTA_STORAGE_BACKEND")?.as_deref() != Some("disk")
        || project.path("pgbackrest.env").exists()
    {
        bail!("S3 storage and PITR need their separate recovery workflow");
    }
    Ok(project)
}
pub(super) async fn blockers(policy: &Policy, op: &Operation) -> anyhow::Result<Vec<String>> {
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
            if matches!(op, Operation::TestAlerts { .. }) && !super::alerts::configured(policy)? {
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
async fn docker_namespace_blocker(project: &str) -> Option<&'static str> {
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
pub(super) fn approved_backup(
    policy: &Policy,
    name: &str,
    file: &str,
) -> anyhow::Result<std::path::PathBuf> {
    if !nelcota_deployment::management::valid_backup(file)
        || !file.starts_with(&format!("nelcota-{name}-"))
    {
        bail!("invalid backup selection");
    }
    let path = policy
        .root
        .join("projects")
        .join(name)
        .join("backups")
        .join(file);
    trusted_path(&path)?;
    trusted_path(&backup::bundle_path(&path)?.join("manifest.json"))?;
    Ok(path)
}
pub(super) fn backup_identity(path: &Path) -> anyhow::Result<String> {
    digest_file(
        &backup::bundle_path(path)?.join("manifest.json"),
        16 * 1024 * 1024,
    )
}

pub(super) async fn output(mut command: Command) -> anyhow::Result<String> {
    use std::os::unix::process::CommandExt;
    use tokio::io::AsyncReadExt;
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .process_group(0);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .context("command output unavailable")?
        .take(65537);
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        stdout.read_to_end(&mut bytes).await?;
        if bytes.len() > 65536 {
            bail!("command output too large");
        }
        if !child.wait().await?.success() {
            bail!("runtime unavailable");
        }
        Ok::<_, anyhow::Error>(String::from_utf8(bytes)?)
    })
    .await;
    if !matches!(result, Ok(Ok(_))) {
        if let Some(pid) = child.id() {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .status();
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result.context("runtime timed out")?
}
pub(super) async fn status(
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
pub(super) async fn logs(
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
fn log_metadata(text: &str) -> Vec<nelcota_deployment::management::LogEntry> {
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
pub fn execute(policy: &Policy, id: &str, recover: bool) -> anyhow::Result<()> {
    execute_with(policy, id, recover, &Native)
}
fn execute_with(
    policy: &Policy,
    id: &str,
    recover: bool,
    effects: &impl Effects,
) -> anyhow::Result<()> {
    let _lease = HostLock::acquire(&policy.root)?;
    if Journal::open(&policy.root)?
        .list()?
        .iter()
        .any(|j| !j.public.phase.terminal())
    {
        bail!("update needs recovery first");
    }
    let journal = HostJournal::open(&policy.root)?;
    let mut task = journal
        .list()?
        .into_iter()
        .find(|t| t.public.id == id)
        .context("host job missing")?;
    if task.public.stage.terminal() {
        return Ok(());
    }
    if recover {
        if !matches!(task.public.stage, Stage::NeedsAttention | Stage::Accepted) {
            bail!("recovery not required");
        }
        let next = task.interrupted.unwrap_or(Stage::Validating);
        journal.advance(&mut task, next, None)?;
    }
    if !recover && task.public.stage != Stage::Accepted {
        bail!("host job already started");
    }
    if !policy
        .operators
        .iter()
        .any(|o| o.email == task.actor && o.manage_host)
    {
        bail!("host authority revoked");
    }
    let result = apply_with(policy, &journal, &mut task, effects);
    if result.is_err() {
        task = journal
            .list()?
            .into_iter()
            .find(|t| t.public.id == id)
            .context("host receipt lost")?;
        if !task.public.stage.terminal() {
            let stage = match task.public.changed {
                true => Stage::NeedsAttention,
                false => Stage::Failed,
            };
            let code = result
                .as_ref()
                .err()
                .map(settings::error_code)
                .unwrap_or("operation_failed");
            journal.advance(&mut task, stage, Some(code))?;
        }
    }
    result
}
fn changed(journal: &HostJournal, task: &mut Task, stage: Stage) -> anyhow::Result<()> {
    task.public.changed = true;
    journal.advance(task, stage, None)
}
trait Effects {
    fn configuration_checkpoint(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn restart(&self, project: &Project) -> anyhow::Result<()> {
        project.recreate(Service::App)
    }
    fn prepare(&self, _: &Project) -> anyhow::Result<()> {
        Ok(())
    }
    fn finish(&self, journal: &HostJournal, task: &mut Task) -> anyhow::Result<()> {
        journal.advance(task, Stage::Completed, None)
    }
    fn preflight(&self, policy: &Policy, op: &Operation) -> anyhow::Result<Vec<String>>;
    fn verify_image(&self, policy: &Policy, dir: &Path) -> anyhow::Result<()>;
    fn image(&self, p: &Provisioning) -> String {
        format!("ghcr.io/nelcota/nelcota-server@sha256:{}", p.image_digest)
    }
    fn publish(&self, host: &Host) -> anyhow::Result<()>;
    fn verify_https(&self, policy: &Policy, project: &Project) -> anyhow::Result<()>;
    fn pause(&self, host: &Host, project: &Project) -> anyhow::Result<()> {
        atomic_write(&project.path(crate::maintenance::MARKER), b"")?;
        self.publish(host)
    }
    fn resume(&self, host: &Host, project: &Project) -> anyhow::Result<()> {
        fs::remove_file(project.path(crate::maintenance::MARKER))?;
        fs::File::open(&project.dir)?.sync_all()?;
        if let Err(error) = self.publish(host) {
            atomic_write(&project.path(crate::maintenance::MARKER), b"")?;
            let _ = caddy::write(host, &host.require()?);
            return Err(error);
        }
        Ok(())
    }
}
struct Native;
impl Effects for Native {
    fn preflight(&self, p: &Policy, op: &Operation) -> anyhow::Result<Vec<String>> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(blockers(p, op))
    }
    fn verify_image(&self, p: &Policy, dir: &Path) -> anyhow::Result<()> {
        verify_image(p, dir)
    }
    fn publish(&self, host: &Host) -> anyhow::Result<()> {
        let manifest = host.require()?;
        registry::write(host, &manifest)?;
        caddy::write(host, &manifest)?;
        caddy::reload(host, manifest.runtime)
    }
    fn verify_https(&self, p: &Policy, target: &Project) -> anyhow::Result<()> {
        verify_https(p, target)
    }
}
fn apply_with(
    policy: &Policy,
    journal: &HostJournal,
    task: &mut Task,
    effects: &impl Effects,
) -> anyhow::Result<()> {
    let p = policy
        .host_management
        .as_ref()
        .context("host management disabled")?;
    validate_policy(p)?;
    let host = Host::new(&policy.root);
    let op = task.public.operation.clone();
    let name = op.project();
    let dir = journal.directory(&task.public.id)?;
    if task.public.stage == Stage::Accepted {
        journal.advance(task, Stage::Validating, None)?;
    }
    if !task.public.changed {
        if digest_file(&policy.root.join(crate::host::MANIFEST), 1024 * 1024)? != task.manifest_sha
        {
            bail!("host changed after approval");
        }
        if let Some(expected) = &task.env_sha {
            let project = control_project(policy, name)?;
            if digest_file(&project.path(".env"), 65536)? != *expected {
                bail!("project changed after approval");
            }
        }
    }
    if !matches!(
        op,
        Operation::Create { .. }
            | Operation::Backup { .. }
            | Operation::Restore { .. }
            | Operation::Remove { .. }
    ) {
        if let Some(expected) = &task.host_env_sha
            && digest_file(host.secrets().path(), 65536)? != *expected
            && !task.public.changed
        {
            bail!("host configuration changed after approval");
        }
        return routine::execute(policy, journal, task, effects);
    }
    match op.clone() {
        Operation::Create {
            project,
            domain,
            profile,
        } => {
            if task.version != p.version || task.image_digest != p.image_digest {
                bail!("creation image approval changed");
            }
            if !task.public.changed {
                let blocked = effects.preflight(policy, &op)?;
                if blocked
                    .iter()
                    .any(|b| !matches!(b.as_str(), "host_busy" | "history_full"))
                {
                    bail!("creation preflight changed");
                }
                effects.verify_image(policy, &dir)?;
                changed(journal, task, Stage::Provisioning)?;
            }
            if task.public.stage == Stage::Verifying {
                let target = control_project(policy, &project)?;
                require_identity(&target, task)?;
                target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
                effects.verify_https(policy, &target)?;
                return effects.finish(journal, task);
            }
            let entry = ProjectEntry {
                name: project.clone(),
                domain,
            };
            let mut manifest = host.require()?;
            let target = host.project(&manifest, &entry);
            if !target.dir.exists() {
                nelcota_deployment::private_dir(&target.dir)?;
                atomic_write(&target.path(".host-job-id"), task.public.id.as_bytes())?;
            }
            if read_private(&target.path(".host-job-id"), 64)? != task.public.id.as_bytes() {
                bail!("creation directory ownership changed");
            }
            if !target.path(".env").exists() {
                scaffold::create(
                    &host,
                    &scaffold::NewProject {
                        entry: &entry,
                        runtime: Runtime::Docker,
                        profile: &profile,
                        image: &manifest.image,
                        version: &task.version,
                    },
                )?;
            }
            if !target.path("docker-compose.yml").exists() {
                bail!("partial scaffold needs SSH inspection");
            }
            target.env().set("NELCOTA_APP_IMAGE", &effects.image(p))?;
            let compose = fs::read_to_string(target.path("docker-compose.yml"))?.replace(
                "image: ${NELCOTA_IMAGE}:${NELCOTA_VERSION}",
                "image: ${NELCOTA_APP_IMAGE:-${NELCOTA_IMAGE}:${NELCOTA_VERSION}}",
            );
            atomic_write(&target.path("docker-compose.yml"), compose.as_bytes())?;
            atomic_write(
                &target.path(".deployment-project-id"),
                task.identity.as_bytes(),
            )?;
            crate::panel_login::apply(&host, &manifest, &target)?;
            journal.advance(task, Stage::Starting, None)?;
            caddy::ensure_network()?;
            effects.prepare(&target)?;
            target.up()?;
            target.wait_healthy(Service::Postgres, crate::lifecycle::HEALTH_TIMEOUT)?;
            target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
            changed(journal, task, Stage::Applying)?;
            if !manifest.projects.iter().any(|e| e.name == project) {
                manifest.projects.push(entry);
                host.save(&manifest)?;
            }
            policy.record_identity(&project, &task.identity, false)?;
            effects.publish(&host)?;
            journal.advance(task, Stage::Verifying, None)?;
            effects.verify_https(policy, &target)?;
        }
        Operation::Backup { .. } => {
            let target = control_project(policy, name)?;
            require_identity(&target, task)?;
            if task.public.stage == Stage::Verifying {
                let file = task
                    .public
                    .backup
                    .as_ref()
                    .context("backup receipt missing")?;
                backup::validate(&approved_backup(policy, name, file)?)?;
                return effects.finish(journal, task);
            }
            journal.advance(task, Stage::BackingUp, None)?;
            let dump = backup::run(&host, &target, false, None)?;
            backup::validate(&dump)?;
            task.public.backup = Some(
                dump.file_name()
                    .context("backup name missing")?
                    .to_string_lossy()
                    .into_owned(),
            );
            journal.advance(task, Stage::Verifying, None)?;
        }
        Operation::Restore { backup: file, .. } => {
            let target = control_project(policy, name)?;
            require_identity(&target, task)?;
            if task.public.stage == Stage::Verifying {
                target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
                if target.path(crate::maintenance::MARKER).exists() {
                    effects.resume(&host, &target)?;
                }
                return effects.finish(journal, task);
            }
            let source = approved_backup(policy, name, &file)?;
            if task.backup_sha.as_ref() != Some(&backup_identity(&source)?) {
                bail!("approved backup changed");
            }
            let bundle = backup::validate(&source)?;
            changed(journal, task, Stage::BackingUp)?;
            effects.pause(&host, &target)?;
            if task.public.stage != Stage::Verifying {
                changed(journal, task, Stage::BackingUp)?;
                target.stop(&[Service::App])?;
                if task.public.backup.is_none() {
                    let safety = backup::run(&host, &target, false, None)?;
                    task.public.backup = Some(
                        safety
                            .file_name()
                            .context("safety backup name")?
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
                let safety = task
                    .public
                    .backup
                    .as_ref()
                    .context("safety backup missing")?;
                backup::validate(&approved_backup(policy, name, safety)?)?;
                journal.advance(task, Stage::Applying, None)?;
                backup::restore_files(&target, &source, &bundle)?;
                backup::restore_dump(&target, &source)?;
                target.start(&[Service::App])?;
                target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
                journal.advance(task, Stage::Verifying, None)?;
            }
            effects.resume(&host, &target)?;
        }
        Operation::Remove { .. } => {
            let mut manifest = host.require()?;
            let target = Project::new(name, &host.project_dir(name), Runtime::Docker);
            if target.dir.exists() {
                if read_private(&target.path(".deployment-project-id"), 64)?
                    != task.identity.as_bytes()
                {
                    bail!("removal project identity changed");
                }
                if task.public.backup.is_none() {
                    control_project(policy, name)?;
                    changed(journal, task, Stage::BackingUp)?;
                    effects.pause(&host, &target)?;
                    target.stop(&[Service::App])?;
                    let dump = backup::run(&host, &target, false, None)?;
                    backup::validate(&dump)?;
                    nelcota_deployment::private_dir(&host.archive_dir())?;
                    let file = dump
                        .file_name()
                        .context("archive filename")?
                        .to_string_lossy()
                        .into_owned();
                    let archived = host.archive_dir().join(&file);
                    backup::archive(&dump, &archived)?;
                    backup::validate(&archived)?;
                    task.public.backup = Some(file);
                    changed(journal, task, Stage::Applying)?;
                }
                backup::validate(
                    &host.archive_dir().join(
                        task.public
                            .backup
                            .as_ref()
                            .context("final backup missing")?,
                    ),
                )?;
                target.down(true)?;
                // Keep configuration and diagnostics privately with the final paired backup.
                let retired = host
                    .archive_dir()
                    .join(format!("project-{}-{}", name, task.public.id));
                if retired.exists() {
                    bail!("retired directory conflict");
                }
                fs::rename(&target.dir, &retired)?;
                fs::File::open(host.project_dir(name).parent().context("project parent")?)?
                    .sync_all()?;
                fs::File::open(host.archive_dir())?.sync_all()?;
            }
            if task.public.backup.is_none() {
                bail!("no verified final backup; removal blocked");
            }
            backup::validate(
                &host.archive_dir().join(
                    task.public
                        .backup
                        .as_ref()
                        .context("final backup missing")?,
                ),
            )?;
            policy.record_identity(name, &task.identity, true)?;
            manifest.projects.retain(|p| p.name != name);
            host.save(&manifest)?;
            effects.publish(&host)?;
            journal.advance(task, Stage::Verifying, None)?;
        }
        _ => bail!("invalid management action"),
    }
    effects.finish(journal, task)
}
fn require_identity(project: &Project, task: &Task) -> anyhow::Result<()> {
    if read_private(&project.path(".deployment-project-id"), 64)? != task.identity.as_bytes() {
        bail!("approved project identity changed");
    }
    Ok(())
}
fn verify_image(policy: &Policy, dir: &Path) -> anyhow::Result<()> {
    let p = policy
        .host_management
        .as_ref()
        .context("management disabled")?;
    super::releases::trusted_verifier(&policy.verifier)?;
    let output = crate::private_fs::file(&dir.join("provenance.private.log"))?;
    let status = Command::new(&policy.verifier)
        .args([
            "attestation",
            "verify",
            &format!(
                "oci://ghcr.io/nelcota/nelcota-server@sha256:{}",
                p.image_digest
            ),
            "--repo",
            "Nelcota/Nelcota",
            "--signer-workflow",
            "Nelcota/Nelcota/.github/workflows/release.yml",
            "--source-digest",
            &p.source_sha,
            "--source-ref",
            &format!("refs/tags/v{}", p.version),
            "--deny-self-hosted-runners",
        ])
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output)
        .status()?;
    if !status.success() {
        bail!("creation image provenance failed");
    }
    Ok(())
}
fn verify_https(policy: &Policy, project: &Project) -> anyhow::Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let p = policy
        .host_management
        .as_ref()
        .context("management disabled")?;
    let manifest = Host::new(&policy.root).require()?;
    let domain = &manifest
        .projects
        .iter()
        .find(|p| p.name == project.name)
        .context("project missing")?
        .domain;
    let addresses: Vec<_> = p
        .addresses
        .iter()
        .map(|s| Ok(std::net::SocketAddr::new(s.parse()?, 443)))
        .collect::<anyhow::Result<_>>()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(domain, &addresses)
        .build()?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            for _ in 0..12 {
                if client
                    .get(format!("https://{domain}/health"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            bail!("public HTTPS is not healthy; inspect DNS, TLS and firewall")
        })
}
#[cfg(test)]
pub(super) mod tests;
