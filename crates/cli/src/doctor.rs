//! `nelcota doctor`: the host's health in one place. It reuses the checks of
//! `init` and `status` and reports every problem instead of stopping at the
//! first one.

use std::time::{Duration, SystemTime};

use anyhow::bail;

use crate::{
    backup, caddy, checks,
    host::{Host, Runtime},
    machine, native,
    project::Service,
    util::{self, ok, step, warn},
};

/// The daily job runs at 03:00; more than this means it missed a run.
const BACKUP_MAX_AGE: Duration = Duration::from_secs(26 * 3600);
const DISK_FAIL_MB: u64 = 1024;
const DISK_WARN_MB: u64 = 5 * 1024;

/// Problems found so far; warnings are printed but do not fail the command.
#[derive(Default)]
struct Report {
    problems: Vec<String>,
}

impl Report {
    fn problem(&mut self, message: String) {
        warn(&message);
        self.problems.push(message);
    }

    fn check(&mut self, result: anyhow::Result<()>) {
        if let Err(err) = result {
            self.problem(format!("{err:#}"));
        }
    }
}

pub fn run(host: &Host) -> anyhow::Result<()> {
    let manifest = host.require()?;
    let projects = host.projects(&manifest);
    let mut report = Report::default();

    step("Machine");
    if manifest.runtime == Runtime::Docker {
        report.check(checks::docker());
    }
    let caddy_running = match manifest.runtime {
        Runtime::Docker => caddy::running(host),
        Runtime::Systemd => native::unit_state("caddy").as_deref() == Some("active"),
    };
    match caddy_running {
        true => {
            ok("Caddy running (holds ports 80 and 443)");
        }
        false => {
            warn("Caddy is not running (`nelcota up` starts it)");
            report.check(checks::ports());
        }
    }
    match checks::free_disk_mb(host.root()) {
        Some(mb) => disk(&mut report, mb),
        None => warn("could not measure free disk space"),
    }

    if !manifest.local {
        step("DNS");
        for entry in &manifest.projects {
            if !checks::dns(&entry.domain) {
                report.problem(format!("DNS for {} is not ready", entry.domain));
            }
        }
    }

    step("Backups");
    if cfg!(target_os = "linux") && !manifest.local {
        report.check(machine::check_backup_scheduler());
        match std::path::Path::new(machine::BACKUP_CRON).is_file() {
            true => {
                ok(&format!("daily backup job: {}", machine::BACKUP_CRON));
            }
            false => {
                report.problem(format!(
                    "no daily backup job ({} missing; run `nelcota init` as root on a new host, \
                 or add the cron line from docs/backup.md)",
                    machine::BACKUP_CRON
                ));
            }
        }
    }
    match backup::s3_configured(host) {
        true => {
            ok("remote backup: S3 configured in host.env");
        }
        false => {
            warn("remote backup not configured: dumps stay on this machine (see docs/backup.md)");
        }
    }
    for project in &projects {
        match backup::latest(project) {
            Some(time) if is_recent(time, SystemTime::now()) => {
                ok(&format!(
                    "{}: last backup {} ago",
                    project.name,
                    util::age(time)
                ));
            }
            Some(time) => report.problem(format!(
                "{}: last backup is {} old (expected daily)",
                project.name,
                util::age(time)
            )),
            None => report.problem(format!("{}: no backup yet", project.name)),
        }
    }

    step("Projects");
    for project in &projects {
        for service in [Service::Postgres, Service::App] {
            let label = match service {
                Service::Postgres => "postgres",
                Service::App => "app",
            };
            match project.health(service).as_deref() {
                Some("healthy") => ok(&format!("{} {label}: healthy", project.name)),
                state => report.problem(format!(
                    "{} {label}: {}",
                    project.name,
                    state.unwrap_or("stopped")
                )),
            }
        }
    }

    println!();
    if report.problems.is_empty() {
        ok("no problems found");
        return Ok(());
    }
    bail!(
        "{} problem(s) found:\n  - {}",
        report.problems.len(),
        report.problems.join("\n  - ")
    )
}

fn disk(report: &mut Report, mb: u64) {
    let gb = mb as f64 / 1024.0;
    if mb < DISK_FAIL_MB {
        report.problem(format!(
            "free disk: {gb:.1} GB (backups and Postgres need room)"
        ));
        return;
    }
    if mb < DISK_WARN_MB {
        warn(&format!("free disk: {gb:.1} GB (getting low)"));
        return;
    }
    ok(&format!("free disk: {gb:.1} GB"));
}

fn is_recent(time: SystemTime, now: SystemTime) -> bool {
    now.duration_since(time).unwrap_or_default() < BACKUP_MAX_AGE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backups_older_than_a_missed_daily_run_are_a_problem() {
        let now = SystemTime::now();
        assert!(is_recent(now - Duration::from_secs(25 * 3600), now));
        assert!(!is_recent(now - Duration::from_secs(27 * 3600), now));
        // A clock that went backwards does not count as stale.
        assert!(is_recent(now + Duration::from_secs(60), now));
    }

    #[test]
    fn low_disk_fails_only_below_the_hard_limit() {
        let mut report = Report::default();
        disk(&mut report, 10 * 1024);
        disk(&mut report, 2 * 1024);
        assert!(report.problems.is_empty());
        disk(&mut report, 512);
        assert_eq!(report.problems.len(), 1);
    }
}
