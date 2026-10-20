//! Exercise rejected installation prerequisites through the real CLI, without
//! touching host packages, services, firewall rules or global cron files.
#![cfg(target_os = "linux")]

use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

struct Installation {
    root: PathBuf,
    tools: PathBuf,
}

impl Installation {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nelcota-install-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let tools = root.join("tools");
        fs::create_dir(&tools).unwrap();
        let fixture = Self { root, tools };
        fixture.tool("id", "printf '%s\\n' \"$FIXTURE_UID\"");
        fixture.tool(
            "systemctl",
            "case $1 in
              is-active) test \"$FIXTURE_CRON_ACTIVE\" = 1 ;;
              is-enabled) printf '%s\\n' \"$FIXTURE_CRON_ENABLED\"; test \"$FIXTURE_CRON_ENABLED\" = enabled ;;
              *) exit 1 ;;
            esac",
        );
        fixture.tool("ufw", "test \"$FIXTURE_UFW\" = 1");
        fixture
    }

    fn tool(&self, name: &str, body: &str) {
        let path = self.tools.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn base_command(&self) -> Command {
        let mut paths = vec![self.tools.clone()];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        let mut command = Command::new(env!("CARGO_BIN_EXE_nelcota"));
        command
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("FIXTURE_UID", "0")
            .env("FIXTURE_CRON_ACTIVE", "1")
            .env("FIXTURE_CRON_ENABLED", "enabled")
            .env("FIXTURE_UFW", "1")
            .env("FIXTURE_COMMAND_LOG", self.root.join("commands.log"))
            .arg("-C")
            .arg(self.root.join("host"));
        command
    }

    fn command(&self) -> Command {
        let mut command = self.base_command();
        command.args(["init", "--project", "shop", "--yes", "--skip-checks"]);
        command
    }

    fn write_manifest(&self) -> PathBuf {
        let host = self.root.join("host");
        fs::create_dir(&host).unwrap();
        fs::write(
            host.join("nelcota-host.json"),
            r#"{"version":1,"panel_login":"shared","local":false,"runtime":"docker","image":"fixture","projects":[]}"#,
        )
        .unwrap();
        host
    }

    fn rejects_before_writing(&self, mut command: Command, message: &str) {
        let output = command.output().unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(message), "{error}");
        assert!(
            !self.root.join("host").exists(),
            "rejected installation wrote host state"
        );
    }
}

#[test]
fn non_root_init_is_rejected_before_creating_credentials_even_with_skip_checks() {
    let fixture = Installation::new();
    let mut command = fixture.command();
    command.env("FIXTURE_UID", "1000").arg("--local");
    fixture.rejects_before_writing(command, "root");
}

#[test]
fn missing_backup_scheduler_is_rejected_before_host_creation() {
    let fixture = Installation::new();
    fixture.tool("systemctl", "exit 127");
    let mut command = fixture.command();
    command.arg("api.example.com");
    fixture.rejects_before_writing(command, "cron");
}

#[test]
fn inactive_backup_scheduler_is_rejected_before_host_creation() {
    let fixture = Installation::new();
    let mut command = fixture.command();
    command
        .env("FIXTURE_CRON_ACTIVE", "0")
        .arg("api.example.com");
    fixture.rejects_before_writing(command, "cron");
}

#[test]
fn disabled_backup_scheduler_is_rejected_before_host_creation() {
    let fixture = Installation::new();
    let mut command = fixture.command();
    command
        .env("FIXTURE_CRON_ENABLED", "disabled")
        .arg("api.example.com");
    fixture.rejects_before_writing(command, "cron");
}

#[test]
fn requested_firewall_requires_ufw_before_host_creation() {
    let fixture = Installation::new();
    let mut command = fixture.command();
    command
        .env("FIXTURE_UFW", "0")
        .args(["api.example.com", "--firewall"]);
    fixture.rejects_before_writing(command, "ufw");
}

#[test]
fn local_init_does_not_silently_ignore_requested_firewall() {
    let fixture = Installation::new();
    let mut command = fixture.command();
    command.args(["--local", "--firewall"]);
    fixture.rejects_before_writing(command, "--firewall");
}

#[test]
fn failed_firewall_rule_aborts_before_host_credentials_are_written() {
    for rule in [
        "allow OpenSSH",
        "allow 80/tcp",
        "allow 443",
        "--force enable",
    ] {
        let fixture = Installation::new();
        fixture.tool(
            "ufw",
            "printf '%s\\n' \"$*\" >> \"$FIXTURE_COMMAND_LOG\"
             if test \"$*\" = \"$FIXTURE_RULE_FAIL\"; then exit 42; fi",
        );
        let mut command = fixture.command();
        command
            .env("FIXTURE_RULE_FAIL", rule)
            .args(["api.example.com", "--firewall"]);
        let output = command.output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(&format!("ufw {rule} failed")));
        let host = fixture.root.join("host");
        for name in ["host.env", "nelcota-host.json", "projects"] {
            assert!(!host.join(name).exists(), "failed firewall wrote {name}");
        }
        let log = fs::read_to_string(fixture.root.join("commands.log")).unwrap();
        assert_eq!(
            log.lines().last(),
            Some(rule),
            "rules continued after failure"
        );
    }
}

#[test]
fn existing_host_does_not_silently_ignore_requested_firewall() {
    let fixture = Installation::new();
    let host = fixture.write_manifest();
    let original = fs::read(host.join("nelcota-host.json")).unwrap();
    let mut command = fixture.command();
    command.args(["api.example.com", "--firewall"]);
    let output = command.output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--firewall only applies"));
    assert_eq!(fs::read(host.join("nelcota-host.json")).unwrap(), original);
    assert_eq!(fs::read_dir(host).unwrap().count(), 1);
}

#[test]
fn doctor_reports_an_inactive_scheduler() {
    let fixture = Installation::new();
    fixture.write_manifest();
    fixture.tool("docker", "printf 'fixture\\n'");
    let output = fixture
        .base_command()
        .env("FIXTURE_CRON_ACTIVE", "0")
        .arg("doctor")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("daily backups require an active cron")
    );
}

impl Drop for Installation {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            eprintln!("could not remove installation fixture: {error}");
        }
    }
}
