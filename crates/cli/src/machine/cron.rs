//! Verify the scheduler, rather than treating a cron file as an active backup.
use anyhow::bail;
use std::process::Command;

pub(super) fn check() -> anyhow::Result<()> {
    check_with(|program, args| {
        let output = Command::new(program).args(args).output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    })
}

fn check_with(probe: impl Fn(&str, &[&str]) -> Option<String>) -> anyhow::Result<()> {
    for service in ["cron.service", "crond.service"] {
        if probe("systemctl", &["is-active", "--quiet", service]).is_some()
            && probe("systemctl", &["is-enabled", service])
                .is_some_and(|state| state.trim() == "enabled")
        {
            return Ok(());
        }
    }
    bail!(
        "daily backups require an active cron scheduler enabled at boot \
         (systemd cron.service/crond.service with /etc/cron.d support). \
         On Debian/Ubuntu: apt-get install cron && systemctl enable --now cron.service. \
         See docs/backup.md"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_active_persistently_enabled_systemd_cron_is_accepted() {
        for service in ["cron.service", "crond.service"] {
            assert!(
                check_with(|program, args| {
                    if program != "systemctl" || args.last() != Some(&service) {
                        return None;
                    }
                    Some(match args[0] {
                        "is-active" => String::new(),
                        "is-enabled" => "enabled\n".into(),
                        _ => return None,
                    })
                })
                .is_ok()
            );
        }
        for active in [false, true] {
            for enabled in ["disabled", "enabled-runtime", "static", "indirect", ""] {
                assert!(
                    check_with(|program, args| {
                        if program != "systemctl" {
                            return None;
                        }
                        match args[0] {
                            "is-active" if active => Some(String::new()),
                            "is-enabled" => Some(enabled.into()),
                            _ => None,
                        }
                    })
                    .is_err()
                );
            }
        }
        assert!(check_with(|_, _| None).is_err());
    }
}
