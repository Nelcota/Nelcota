//! Starting, stopping and observing projects and the host proxy.
use crate::{
    caddy,
    host::{Host, Manifest, Runtime},
    project::{Project, Service},
    util::{self, ok, step, warn},
};
use anyhow::bail;
use std::time::Duration;
pub(crate) const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);

/// Starts the projects (each one until its healthcheck passes) and Caddy.
pub fn up(host: &Host, manifest: &Manifest, projects: &[Project]) -> anyhow::Result<()> {
    for project in projects {
        crate::pitr::fence::require_clear(project)?;
    }
    if manifest.runtime == Runtime::Docker {
        caddy::ensure_network()?;
    }
    caddy::write(host, manifest)?;
    for project in projects {
        step(&format!("Starting {}", project.name));
        project.up()?;
        project.wait_healthy(Service::App, HEALTH_TIMEOUT)?;
        crate::maintenance::recover(project)?;
        ok(&format!("{} healthy", project.name));
    }
    caddy::write(host, manifest)?;
    caddy::up(host, manifest.runtime)?;
    let entries: Vec<_> = manifest
        .projects
        .iter()
        .filter(|e| projects.iter().any(|p| p.name == e.name))
        .collect();
    if !manifest.local {
        check_public_https(host, manifest.runtime, &entries)?;
    }
    println!();
    for entry in entries {
        println!("  {:<16} {}/health", entry.name, entry.url());
    }
    Ok(())
}

const HTTPS_TIMEOUT: Duration = Duration::from_secs(60);
const HTTPS_INTERVAL: Duration = Duration::from_secs(3);

/// The apps are healthy behind Caddy; check that the public URL answers too
/// (DNS, firewall and certificate issuance). Best effort: skipped without
/// curl and on local hosts, whose internal certificate curl does not trust.
fn check_public_https(
    host: &Host,
    runtime: Runtime,
    entries: &[&crate::host::ProjectEntry],
) -> anyhow::Result<()> {
    if std::process::Command::new("curl")
        .arg("--version")
        .output()
        .is_err()
    {
        warn("curl not found: skipping the public HTTPS check");
        return Ok(());
    }
    step("Checking public HTTPS (certificate issuance can take a minute)");
    let deadline = std::time::Instant::now() + HTTPS_TIMEOUT;
    let mut failed = Vec::new();
    for entry in entries {
        let url = format!("{}/health", entry.url());
        let answered = poll(
            || https_ok(&url),
            || std::time::Instant::now() < deadline,
            HTTPS_INTERVAL,
        );
        match answered {
            true => {
                ok(&format!("{url} answers"));
            }
            false => {
                warn(&format!("{url} did not answer"));
                failed.push(entry.domain.as_str());
            }
        }
    }
    if failed.is_empty() {
        return Ok(());
    }
    let caddy_logs = match runtime {
        Runtime::Docker => format!(
            "docker compose -f {} logs caddy",
            host.caddy_dir().join("docker-compose.yml").display()
        ),
        Runtime::Systemd => "journalctl -u caddy -n 100".to_owned(),
    };
    println!();
    println!("  The projects are running, but HTTPS is not reachable yet. Check:");
    println!(
        "    - DNS: an A/AAAA record for {} pointing at this machine",
        failed.join(", ")
    );
    println!("    - firewall / cloud security group: ports 80 and 443 open");
    println!("    - Caddy's certificate errors: {caddy_logs}");
    println!("  Then run `nelcota up` again (`nelcota doctor` checks all of this).");
    bail!("public HTTPS check failed for: {}", failed.join(", "));
}

fn https_ok(url: &str) -> bool {
    std::process::Command::new("curl")
        .args(["-fsS", "--max-time", "5", "-o", "-", url])
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Calls `probe` until it succeeds or `more` says time is up.
fn poll(
    mut probe: impl FnMut() -> bool,
    mut more: impl FnMut() -> bool,
    interval: Duration,
) -> bool {
    loop {
        if probe() {
            return true;
        }
        if !more() {
            return false;
        }
        std::thread::sleep(interval);
    }
}

pub fn down(project: &Project, volumes: bool) -> anyhow::Result<()> {
    project.down(volumes)
}

/// `down --volumes` deletes databases and files: ask first, and refuse
/// without a terminal unless `--yes` was given.
pub fn confirm_volume_deletion(projects: &[Project], all: bool, yes: bool) -> anyhow::Result<()> {
    let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
    let what = match all {
        true => {
            format!("{} and Caddy's certificates", names.join(", "))
        }
        false => names.join(", "),
    };
    warn(&format!("--volumes: the data of {what} will be DELETED"));
    if yes {
        return Ok(());
    }
    if !util::interactive() {
        bail!("refusing to delete volumes without a terminal; pass --yes to confirm");
    }
    if !util::confirm(&format!(
        "Delete the databases and files of {what}? This cannot be undone."
    )) {
        bail!("down cancelled (use --yes to skip the question)");
    }
    Ok(())
}

pub fn status(host: &Host, manifest: &Manifest, projects: &[Project]) -> anyhow::Result<()> {
    println!(
        "{:<16} {:<32} {:<10} {:<10} {:<12} VERSION",
        "PROJECT", "DOMAIN", "APP", "POSTGRES", "LAST BACKUP"
    );
    for project in projects {
        let domain = manifest
            .projects
            .iter()
            .find(|e| e.name == project.name)
            .map_or("", |e| e.domain.as_str());
        let health = |service| project.health(service).unwrap_or_else(|| "stopped".into());
        let backup = crate::backup::latest(project)
            .map_or_else(|| "never".to_owned(), |t| format!("{} ago", util::age(t)));
        let version = project.env().get("NELCOTA_VERSION")?.unwrap_or_default();
        println!(
            "{:<16} {:<32} {:<10} {:<10} {:<12} {}",
            project.name,
            domain,
            health(Service::App),
            health(Service::Postgres),
            backup,
            version
        );
    }
    if let Some(mb) = crate::checks::free_disk_mb(host.root()) {
        println!();
        println!("Free disk: {:.1} GB", mb as f64 / 1024.0);
    }
    Ok(())
}

pub fn logs(project: &Project, follow: bool, service: Option<Service>) -> anyhow::Result<()> {
    project.logs(follow, service)
}

/// Recreates the apps that already exist (to apply `.env` changes).
pub fn recreate_apps(projects: &[Project]) -> anyhow::Result<()> {
    for project in projects.iter().filter(|p| p.has_app()) {
        step(&format!("Restarting the {} app", project.name));
        project.recreate(Service::App)?;
        project.wait_healthy(Service::App, HEALTH_TIMEOUT)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_stops_on_success_or_when_time_is_up() {
        let mut calls = 0;
        assert!(poll(
            || {
                calls += 1;
                calls == 3
            },
            || true,
            Duration::ZERO
        ));
        assert_eq!(calls, 3);

        let mut checks = 0;
        assert!(!poll(
            || false,
            || {
                checks += 1;
                checks < 4
            },
            Duration::ZERO
        ));
        assert_eq!(checks, 4);
    }
}
