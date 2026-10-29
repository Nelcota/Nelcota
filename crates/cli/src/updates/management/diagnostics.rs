//! Bounded, read-only checks. Probe output is reduced to known status codes.
use super::effects::output;
use super::policy::control_project;
use super::policy::free_bytes;
use crate::backup;
use crate::host::Host;
use crate::updates::policy::Policy;
use crate::updates::policy::trusted_path;
use anyhow::Context;
use nelcota_deployment::operations::{Check, CheckStatus as S, Diagnostics};
use nelcota_deployment::read_private;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

fn memory(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name != key {
            return None;
        }
        value
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()?
            .checked_mul(1024)
    })
}
fn cpu(text: &str) -> Option<(u64, u64)> {
    let mut fields = text.lines().next()?.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    // guest/guest_nice are already counted by user/nice.
    let values: Vec<u64> = fields
        .take(8)
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    if values.len() < 5 {
        return None;
    }
    let total = values.iter().try_fold(0u64, |sum, v| sum.checked_add(*v))?;
    Some((total, values[3].checked_add(values[4])?))
}
fn usage(before: Option<(u64, u64)>, after: Option<(u64, u64)>) -> Option<f64> {
    let (before, after) = (before?, after?);
    let total = after.0.checked_sub(before.0)?;
    let idle = after.1.checked_sub(before.1)?;
    if total == 0 || idle > total {
        return None;
    }
    Some(100.0 * (total - idle) as f64 / total as f64)
}
async fn cpu_sample() -> Option<f64> {
    let before = fs::read_to_string("/proc/stat").ok().and_then(|s| cpu(&s));
    tokio::time::sleep(Duration::from_millis(150)).await;
    usage(
        before,
        fs::read_to_string("/proc/stat").ok().and_then(|s| cpu(&s)),
    )
}
async fn command(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    output(command).await.ok()
}
async fn scheduler() -> bool {
    for unit in ["cron.service", "crond.service"] {
        let active_args = ["is-active", unit];
        let enabled_args = ["is-enabled", unit];
        let (active, enabled) = tokio::join!(
            command("systemctl", &active_args),
            command("systemctl", &enabled_args)
        );
        if active.is_some_and(|s| s.trim() == "active")
            && enabled.is_some_and(|s| s.trim() == "enabled")
        {
            return true;
        }
    }
    false
}
async fn network(policy: &Policy, domain: &str) -> (S, S) {
    let lookup = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host((domain, 443)),
    )
    .await;
    let addresses = match lookup {
        Ok(Ok(a)) => a.map(|a| a.ip()).collect::<Vec<_>>(),
        _ => return (S::Unavailable, S::Unavailable),
    };
    let expected = &policy.host_management.as_ref().map(|p| &p.addresses);
    if addresses.is_empty()
        || addresses.iter().any(|ip| {
            !expected.is_some_and(|e| {
                e.iter()
                    .any(|v| v.parse::<std::net::IpAddr>().ok() == Some(*ip))
            })
        })
    {
        return (S::Failed, S::Unavailable);
    }
    let mut command = Command::new("curl");
    command.args([
        "--fail",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--connect-timeout",
        "2",
        "--max-time",
        "4",
        &format!("https://{domain}/health"),
    ]);
    let https = match output(command).await {
        Ok(body) => match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(v) if v["status"] == "ok" => S::Passed,
            _ => S::Failed,
        },
        Err(_) => S::Failed,
    };
    (S::Passed, https)
}
pub(crate) async fn diagnostics(policy: &Policy, name: &str) -> anyhow::Result<Diagnostics> {
    let p = control_project(policy, name)?;
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    let domain = &manifest
        .projects
        .iter()
        .find(|p| p.name == name)
        .context("project missing")?
        .domain;
    let mut docker = Command::new("docker");
    docker.args([
        "ps",
        "--format",
        "{{json .}}",
        "--filter",
        &format!("label=com.docker.compose.project=nelcota-{name}"),
    ]);
    let (cpu_percent, scheduler_ok, containers, (dns, https)) = tokio::join!(
        cpu_sample(),
        scheduler(),
        output(docker),
        network(policy, domain)
    );
    let health = |service: &str| match &containers {
        Ok(rows) => {
            let healthy = rows
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .any(|row| {
                    row["Labels"].as_str().is_some_and(|labels| {
                        labels
                            .split(',')
                            .any(|s| s == format!("com.docker.compose.service={service}"))
                    }) && row["Status"]
                        .as_str()
                        .is_some_and(|s| s.contains("(healthy)"))
                });
            match healthy {
                true => S::Passed,
                false => S::Failed,
            }
        }
        Err(_) => S::Unavailable,
    };
    let last_backup_at = backup::latest(&p)
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let checked_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let last_offsite_backup_at = backup::latest_verified(&host, &p);
    let cron_file = Path::new(crate::machine::BACKUP_CRON);
    let checks = [
        ("application", health("app")),
        ("database", health("postgres")),
        (
            "scheduler",
            match scheduler_ok {
                true => S::Passed,
                false => S::Failed,
            },
        ),
        (
            "backup_schedule",
            match trusted_path(cron_file).is_ok() && read_private(cron_file, 16384).is_ok() {
                true => S::Passed,
                false => S::Failed,
            },
        ),
        (
            "offsite_verified",
            match last_offsite_backup_at {
                Some(at) if checked_at.saturating_sub(at) < 26 * 3600 => S::Passed,
                _ => S::Warning,
            },
        ),
        ("dns", dns),
        ("https", https),
        (
            "local_backup",
            match last_backup_at {
                Some(at) if checked_at.saturating_sub(at) < 26 * 3600 => S::Passed,
                _ => S::Warning,
            },
        ),
        (
            "offsite_configured",
            match backup::valid_destination(&host) {
                true => S::Passed,
                false => S::Warning,
            },
        ),
        (
            "update_acceptance",
            match policy.installation_validated() {
                true => S::Passed,
                false => S::Warning,
            },
        ),
        (
            "disk_reserve",
            match free_bytes(&policy.root) >= policy.minimum_free_bytes {
                true => S::Passed,
                false => S::Failed,
            },
        ),
    ]
    .into_iter()
    .map(|(name, status)| Check {
        name: name.into(),
        status,
    })
    .collect();
    let mem = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let load_one = fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0);
    Ok(Diagnostics {
        project: name.into(),
        checked_at,
        memory_total_bytes: memory(&mem, "MemTotal"),
        memory_available_bytes: memory(&mem, "MemAvailable"),
        cpu_percent,
        load_one,
        free_bytes: free_bytes(&policy.root),
        last_backup_at,
        last_offsite_backup_at,
        checks,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn samples_reject_missing_overflow_and_non_monotonic_counters() {
        assert_eq!(
            memory("MemTotal: 200 kB\nMemAvailable: 100 kB", "MemAvailable"),
            Some(102400)
        );
        assert_eq!(
            memory("MemTotal: 18446744073709551615 kB", "MemTotal"),
            None
        );
        assert_eq!(cpu("cpu 1 2 3 4 5 6 7 8 999 999"), Some((36, 9)));
        assert_eq!(cpu("cpu 1 2 nope"), None);
        assert_eq!(usage(Some((10, 5)), Some((30, 10))), Some(75.0));
        assert_eq!(usage(Some((10, 5)), Some((10, 5))), None);
        assert_eq!(usage(Some((30, 5)), Some((10, 10))), None);
        assert_eq!(usage(None, Some((10, 5))), None);
    }
}
