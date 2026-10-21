//! Machine setup when the host is created (Linux, as root): a backup cron for
//! every project, the firewall and automatic updates.

use std::{fs, process::Command};

use anyhow::{Context, bail};

use crate::{
    host::Host,
    util::{ok, step, warn},
};

mod cron;

fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "0")
}

/// Operational requirements are not bypassed by `init --skip-checks`.
/// Check them before any host lease, credentials or project files are written.
pub(crate) fn preflight(local: bool, firewall: bool) -> anyhow::Result<()> {
    if cfg!(unix) && !is_root() {
        bail!(
            "nelcota init needs root to provision host storage and system services; \
             run init as root (for example: sudo nelcota -C <host> init ...). \
             Local application development with nelcota dev does not require root"
        );
    }
    if firewall && (!cfg!(target_os = "linux") || local) {
        bail!("--firewall requires a new, non-local Linux host; configure other hosts manually");
    }
    if cfg!(target_os = "linux") && !local {
        check_backup_scheduler()?;
    }
    if firewall {
        require_ufw()?;
    }
    Ok(())
}

pub(crate) fn check_backup_scheduler() -> anyhow::Result<()> {
    cron::check()
}

pub fn setup(host: &Host, firewall: bool) -> anyhow::Result<()> {
    if !cfg!(target_os = "linux") {
        warn("daily backups must be scheduled manually outside Linux");
        return Ok(());
    }
    // Recheck immediately before machine writes; preflight happened earlier.
    preflight(false, firewall)?;
    step("Configuring the machine");
    configure_firewall(firewall)?;
    install_backup_cron(host)?;
    if !Command::new("dpkg")
        .args(["-s", "unattended-upgrades"])
        .output()
        .is_ok_and(|o| o.status.success())
    {
        warn("recommended: apt install unattended-upgrades (automatic security updates)");
    }
    Ok(())
}

/// Where `init` installs the daily backup job.
pub const BACKUP_CRON: &str = "/etc/cron.d/nelcota-backup";

fn install_backup_cron(host: &Host) -> anyhow::Result<()> {
    install_backup_cron_at(host, std::path::Path::new(BACKUP_CRON))?;
    ok(&format!("daily backup at 03:00 ({BACKUP_CRON})"));
    Ok(())
}

fn install_backup_cron_at(host: &Host, path: &std::path::Path) -> anyhow::Result<()> {
    let root =
        fs::canonicalize(host.root()).context("could not resolve the backup host directory")?;
    let exe = std::env::current_exe().context("could not resolve the backup executable")?;
    let directory = path.parent().context("backup cron path has no directory")?;
    fs::create_dir_all(directory).context("could not create the backup cron directory")?;
    crate::private_fs::write(
        path,
        cron_file(&exe.display().to_string(), &root.display().to_string()),
    )
    .context("could not install the daily backup cron; initialization aborted")?;
    Ok(())
}

/// `backup` uploads on its own when `host.env` has a bucket, so the job keeps
/// working when S3 is configured after `init`.
fn cron_file(exe: &str, root: &str) -> String {
    schedule_file(exe, root, 3, 0, 7)
}

/// Changes only the time and local retention of the installed daily job. The
/// executable and host directory chosen by `nelcota init` are preserved, so a
/// panel change never retargets the job to the controller's private binary.
pub(crate) fn backup_schedule(
    current: &str,
    hour: u8,
    minute: u8,
    keep: u16,
) -> anyhow::Result<String> {
    const JOB: &str = " backup --all --keep ";
    if hour > 23 || minute > 59 || !(1..=365).contains(&keep) {
        bail!("invalid_backup_schedule");
    }
    let mut jobs = 0;
    let mut lines = Vec::new();
    for line in current.lines() {
        if !line.contains(JOB) {
            lines.push(line.to_owned());
            continue;
        }
        jobs += 1;
        let mut fields = line.splitn(7, ' ');
        let schedule = fields.by_ref().take(6).collect::<Vec<_>>();
        let (program, rest) = fields
            .next()
            .and_then(|command| command.rsplit_once(JOB))
            .context("invalid_backup_schedule")?;
        let suffix = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        if schedule.len() != 6
            || schedule[0].parse::<u8>().is_err()
            || schedule[1].parse::<u8>().is_err()
            || schedule[2..] != ["*", "*", "*", "root"]
            || program.is_empty()
            || suffix.len() == rest.len()
        {
            bail!("invalid_backup_schedule");
        }
        lines.push(format!(
            "{minute} {hour} * * * root {program}{JOB}{keep}{suffix}"
        ));
    }
    if jobs != 1 {
        bail!("invalid_backup_schedule");
    }
    Ok(lines.join("\n") + "\n")
}

/// The cron template installed by `nelcota init`.
fn schedule_file(exe: &str, root: &str, hour: u8, minute: u8, keep: u16) -> String {
    format!(
        "# Daily backup of every nelcota project (generated by `nelcota init`)\n\
         PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n\
         {minute} {hour} * * * root {} -C {} backup --all --keep {keep} >> /var/log/nelcota-backup.log 2>&1\n",
        cron_quote(exe),
        cron_quote(root)
    )
}

/// Single-quoted for `sh`, with `%` escaped (cron turns it into a newline).
fn cron_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''").replace('%', r"\%"))
}

fn require_ufw() -> anyhow::Result<()> {
    if !Command::new("ufw")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
    {
        bail!(
            "--firewall requires a working ufw installation (on Debian/Ubuntu: apt-get install ufw); \
             install it before retrying, or configure the host firewall manually and omit --firewall"
        );
    }
    Ok(())
}

fn configure_firewall(enable: bool) -> anyhow::Result<()> {
    if !enable {
        warn(
            "configure the host firewall manually; before enabling it, allow your actual SSH port \
             and ports 80/443 (use --firewall only when creating a new non-local Linux host)",
        );
        return Ok(());
    }
    require_ufw()?;
    let rules: [&[&str]; 4] = [
        &["allow", "OpenSSH"],
        &["allow", "80/tcp"],
        &["allow", "443"],
        &["--force", "enable"],
    ];
    for rule in rules {
        let status = Command::new("ufw")
            .args(rule)
            .status()
            .context("could not configure ufw; inspect ufw status before retrying init")?;
        if !status.success() {
            bail!(
                "ufw {} failed; inspect ufw status before retrying init",
                rule.join(" ")
            );
        }
    }
    ok("ufw: SSH, 80 and 443 rules applied; inspect ufw status to verify the complete policy");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_quotes_paths_and_lets_backup_decide_the_upload() {
        let cron = cron_file("/usr/local/bin/nelcota", "/srv/my hosts/it's 100%");
        assert!(cron.contains(
            r"root '/usr/local/bin/nelcota' -C '/srv/my hosts/it'\''s 100\%' backup --all --keep 7 >>"
        ));
        assert!(!cron.contains("--upload"));
        assert!(cron.contains("\n0 3 * * * root "));
        assert!(
            cron.contains("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n")
        );
        assert!(cron.ends_with("2>&1\n"));
    }

    #[test]
    fn schedule_changes_keep_the_installed_command_and_refuse_unknown_jobs() {
        let installed = cron_file("/usr/local/bin/nelcota", "/srv/my hosts/it's 100%");
        let changed = backup_schedule(&installed, 23, 5, 30).unwrap();
        assert_eq!(
            changed,
            installed
                .replace("\n0 3 * * * root ", "\n5 23 * * * root ")
                .replace(" --keep 7 ", " --keep 30 ")
        );
        assert_eq!(backup_schedule(&changed, 3, 0, 7).unwrap(), installed);
        for invalid in [
            String::new(),
            "# no job\n".to_owned(),
            installed.clone() + &installed,
            installed.replace("0 3 * * * root", "@daily root"),
            installed.replace(" --keep 7 ", " --keep  "),
        ] {
            assert!(backup_schedule(&invalid, 3, 0, 7).is_err(), "{invalid}");
        }
        assert!(backup_schedule(&installed, 24, 0, 7).is_err());
        assert!(backup_schedule(&installed, 3, 60, 7).is_err());
        assert!(backup_schedule(&installed, 3, 0, 0).is_err());
        assert!(backup_schedule(&installed, 3, 0, 366).is_err());
    }

    #[test]
    fn backup_job_installation_propagates_filesystem_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let blocker = temporary.path().join("not-a-directory");
        fs::write(&blocker, "keep this file").unwrap();
        let host = Host::new(temporary.path());
        let result = install_backup_cron_at(&host, &blocker.join("nelcota-backup"));
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("backup cron directory")
        );
        assert_eq!(fs::read_to_string(blocker).unwrap(), "keep this file");
    }

    #[test]
    fn backup_job_is_installed_privately_for_the_selected_host() {
        let temporary = tempfile::tempdir().unwrap();
        let host = Host::new(temporary.path());
        let path = temporary.path().join("cron.d/nelcota-backup");
        install_backup_cron_at(&host, &path).unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains(&cron_quote(
            &fs::canonicalize(host.root()).unwrap().display().to_string()
        )));
        assert!(contents.contains(" backup --all --keep 7 "));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
