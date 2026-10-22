//! Read-only, bounded sampling. A broken observer is distinct from a healthy service.
use super::*;
use crate::backup::outcome::ResultKind;
use nelcota_deployment::alerts::{Kind, Observation as O, Sample, Severity};
use std::{net::IpAddr, process::Command};
pub(super) struct Target {
    pub project: String,
    pub identity: String,
    pub domain: String,
    pub backup_success: Option<u64>,
    pub backup_failed: O,
    pub offsite_at: Option<u64>,
    pub needs_offsite: bool,
    pub observer_failed: bool,
}
pub(super) fn target(
    policy: &Policy,
    name: &str,
    domain: &str,
    now: u64,
) -> anyhow::Result<Target> {
    let p = management::control_project(policy, name)?;
    let identity = String::from_utf8(read_private(&p.path(".deployment-project-id"), 64)?)?;
    let mut observer_failed = false;
    let (backup_success, mut backup_failed) = match crate::backup::outcome::read(&p) {
        Ok(Some(value)) => (
            value.last_success_at,
            match value.result {
                ResultKind::Failed | ResultKind::Running => O::Bad,
                ResultKind::Succeeded => O::Good,
            },
        ),
        Ok(None) => (None, O::Good),
        Err(_) => {
            observer_failed = true;
            (None, O::Unknown)
        }
    };
    let jobs = nelcota_deployment::management::HostJournal::open(&policy.root)?.list()?;
    let latest = jobs
        .into_iter()
        .filter(|t| {
            t.identity == identity
                && matches!(
                    t.public.operation,
                    Operation::Backup { .. } | Operation::BackupOffsite { .. }
                )
        })
        .max_by_key(|t| (t.public.updated_at, t.public.sequence));
    if let Some(job) = latest
        && matches!(job.public.stage, Stage::Failed | Stage::NeedsAttention)
        && backup_success.is_none_or(|at| at <= job.public.updated_at)
    {
        backup_failed = O::Bad;
    }
    if backup_success.is_some_and(|at| at > now) {
        observer_failed = true;
    }
    Ok(Target {
        project: name.into(),
        identity,
        domain: domain.into(),
        backup_success,
        backup_failed,
        offsite_at: crate::backup::latest_verified(&Host::new(&policy.root), &p),
        needs_offsite: crate::backup::s3_configured(&Host::new(&policy.root)),
        observer_failed,
    })
}
fn sample(t: &Target, kind: Kind, observation: O, severity: Severity) -> Sample {
    Sample {
        key: format!("{}.{}", t.identity, kind.code()),
        project: Some(t.project.clone()),
        kind,
        observation,
        severity,
    }
}
pub(super) fn disk(
    policy: &Policy,
    settings: &nelcota_deployment::alerts::Settings,
    recovering: bool,
) -> Sample {
    let observation = rustix::fs::statvfs(&policy.root)
        .ok()
        .and_then(|s| {
            Some((
                s.f_bavail.checked_mul(s.f_frsize)?,
                s.f_blocks.checked_mul(s.f_frsize)?,
            ))
        })
        .filter(|(_, total)| *total > 0)
        .map(|(free, total)| {
            let minimum = policy
                .minimum_free_bytes
                .max(u64::from(settings.disk_gib) * 1024 * 1024 * 1024);
            let (bytes, percent) = match recovering {
                true => (
                    minimum.saturating_add(minimum / 5),
                    u64::from(settings.disk_percent) + 5,
                ),
                false => (minimum, u64::from(settings.disk_percent)),
            };
            match free < bytes || (u128::from(free) * 100) < u128::from(total) * u128::from(percent)
            {
                true => O::Bad,
                false => O::Good,
            }
        })
        .unwrap_or(O::Unknown);
    Sample {
        key: "host.disk".into(),
        project: None,
        kind: Kind::Disk,
        severity: Severity::Critical,
        observation,
    }
}
async fn certificate(der: &[u8], days: u8) -> O {
    let file = match tempfile::NamedTempFile::new() {
        Ok(f) => f,
        Err(_) => return O::Unknown,
    };
    if std::fs::write(file.path(), der).is_err() {
        return O::Unknown;
    }
    let mut command = Command::new("openssl");
    command
        .args(["x509", "-inform", "DER", "-noout", "-in"])
        .arg(file.path())
        .arg("-checkend")
        .arg((u64::from(days) * 86400).to_string())
        .env("LC_ALL", "C");
    // OpenSSL intentionally exits 1 for an expiring, successfully parsed cert.
    // Append no shell logic: capture that status with the bounded probe adapter.
    let mut child = tokio::process::Command::from(command);
    child
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped());
    use tokio::io::AsyncReadExt;
    let result = async {
        let mut child = child.spawn()?;
        let mut text = String::new();
        child
            .stdout
            .take()
            .context("certificate output")?
            .take(4097)
            .read_to_string(&mut text)
            .await?;
        ensure!(text.len() <= 4096, "certificate output limit");
        let status = child.wait().await?;
        Ok::<_, anyhow::Error>(match (status.code(), text.trim()) {
            (Some(0), "Certificate will not expire") => O::Good,
            (Some(1), "Certificate will expire") => O::Bad,
            _ => O::Unknown,
        })
    };
    match tokio::time::timeout(Duration::from_secs(5), result).await {
        Ok(Ok(v)) => v,
        _ => O::Unknown,
    }
}
async fn https(policy: &Policy, t: &Target, days: u8) -> (O, O, bool) {
    let p = match &policy.host_management {
        Some(p) => p,
        None => return (O::Unknown, O::Unknown, true),
    };
    let expected = p
        .addresses
        .iter()
        .filter_map(|a| a.parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    let lookup = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host((t.domain.as_str(), 443)),
    )
    .await;
    let ips = match lookup {
        Ok(Ok(ips)) => ips.collect::<Vec<_>>(),
        _ => return (O::Bad, O::Unknown, false),
    };
    if ips.is_empty() || !ips.iter().all(|a| expected.contains(&a.ip())) {
        return (O::Bad, O::Unknown, false);
    }
    let addresses = expected
        .into_iter()
        .map(|ip| std::net::SocketAddr::new(ip, 443))
        .collect::<Vec<_>>();
    let operation = async {
        delivery::tls()?;
        let client = reqwest::Client::builder()
            .https_only(true)
            .tls_info(true)
            .timeout(Duration::from_secs(4))
            .connect_timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&t.domain, &addresses)
            .pool_max_idle_per_host(0)
            .build()?;
        let mut response = client
            .get(format!("https://{}/health", t.domain))
            .send()
            .await?;
        let der = response
            .extensions()
            .get::<reqwest::tls::TlsInfo>()
            .and_then(|tls| tls.peer_certificate())
            .map(<[u8]>::to_vec);
        let successful = response.status().is_success();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len().saturating_add(chunk.len()) <= 4096,
                "health response limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        let healthy = successful
            && serde_json::from_slice::<serde_json::Value>(&bytes)
                .is_ok_and(|v| v["status"] == "ok");
        Ok::<_, anyhow::Error>((healthy, der))
    };
    let (healthy, der) = match tokio::time::timeout(Duration::from_secs(5), operation).await {
        Ok(Ok(v)) => v,
        _ => return (O::Bad, O::Unknown, false),
    };
    let cert = match der {
        Some(der) if der.len() <= 65536 => certificate(&der, days).await,
        _ => O::Unknown,
    };
    (
        match healthy {
            true => O::Good,
            false => O::Bad,
        },
        cert,
        cert == O::Unknown,
    )
}

pub(super) async fn project(
    policy: &Policy,
    t: Target,
    health: Option<(bool, bool)>,
    now: u64,
    recover_cert: bool,
    settings: &nelcota_deployment::alerts::Settings,
) -> Vec<Sample> {
    let (https, cert, cert_unknown) = https(
        policy,
        &t,
        settings
            .certificate_days
            .saturating_add(match recover_cert {
                true => 2,
                false => 0,
            }),
    )
    .await;
    let age = u64::from(settings.backup_hours) * 3600;
    let fresh = |time: Option<u64>| {
        time.and_then(|at| now.checked_sub(at))
            .is_some_and(|a| a <= age)
    };
    let backup_late = match fresh(t.backup_success) && (!t.needs_offsite || fresh(t.offsite_at)) {
        true => O::Good,
        false => O::Bad,
    };
    let component = |healthy: Option<bool>| match healthy {
        Some(true) => O::Good,
        Some(false) => O::Bad,
        None => O::Unknown,
    };
    let monitoring = match cert_unknown || t.observer_failed || health.is_none() {
        true => O::Bad,
        false => O::Good,
    };
    vec![
        sample(
            &t,
            Kind::Application,
            component(health.map(|v| v.0)),
            Severity::Critical,
        ),
        sample(
            &t,
            Kind::Database,
            component(health.map(|v| v.1)),
            Severity::Critical,
        ),
        sample(&t, Kind::Https, https, Severity::Critical),
        sample(&t, Kind::Certificate, cert, Severity::Warning),
        sample(&t, Kind::BackupLate, backup_late, Severity::Warning),
        sample(&t, Kind::BackupFailed, t.backup_failed, Severity::Critical),
        sample(&t, Kind::Monitoring, monitoring, Severity::Warning),
    ]
}
pub(super) async fn containers() -> Option<BTreeMap<String, (bool, bool)>> {
    let mut command = Command::new("docker");
    command.args(["ps","--format","{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.docker.compose.service\"}}\t{{.Status}}"]);
    let text = management::output(command).await.ok()?;
    let mut result = BTreeMap::new();
    for line in text.lines() {
        if let Some((name, rest)) = line.split_once('\t')
            && let Some((service, status)) = rest.split_once('\t')
            && let Some(name) = name.strip_prefix("nelcota-")
        {
            let value = result.entry(name.to_owned()).or_insert((false, false));
            let healthy = status.contains("(healthy)");
            match service {
                "app" => value.0 = healthy,
                "postgres" => value.1 = healthy,
                _ => {}
            }
        }
    }
    Some(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn certificate_horizon_checks_real_leaf_der_and_rejects_invalid_bytes() {
        for (days, expected) in [(1, O::Bad), (365, O::Good)] {
            let dir = tempfile::tempdir().unwrap();
            let cert = dir.path().join("certificate.der");
            let status = Command::new("openssl")
                .args([
                    "req",
                    "-new",
                    "-x509",
                    "-newkey",
                    "ec",
                    "-pkeyopt",
                    "ec_paramgen_curve:P-256",
                    "-nodes",
                    "-subj",
                    "/CN=disposable.example.test",
                    "-days",
                ])
                .arg(days.to_string())
                .args(["-outform", "DER", "-out"])
                .arg(&cert)
                .arg("-keyout")
                .arg(dir.path().join("key.pem"))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
            assert_eq!(
                certificate(&std::fs::read(cert).unwrap(), 14).await,
                expected
            );
        }
        assert_eq!(certificate(b"not a certificate", 14).await, O::Unknown);
    }
}
