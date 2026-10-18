//! Exercise the actual restore sequence with process-local command adapters.
use crate::{host::Runtime, project::Project};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

const FIXTURE: &str = "NELCOTA_PITR_ERROR_TEST_FIXTURE";
const TEST: &str = "pitr::restore::tests::failed_restore_keeps_database_and_app_stopped";

#[test]
fn failed_restore_keeps_database_and_app_stopped() {
    if let Some(directory) = std::env::var_os(FIXTURE) {
        let project = Project::new("restore-error", Path::new(&directory), Runtime::Docker);
        let error = super::restore(&project, None, true).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("data directory may have changed"));
        assert!(message.contains("Postgres and the app remain stopped"));
        assert!(message.contains("pgbackrest restore failed"));
        return;
    }

    let directory = tempfile::tempdir().unwrap();
    let bin = directory.path().join("bin");
    fs::create_dir(&bin).unwrap();
    fs::write(directory.path().join("pgbackrest.env"), "# test fixture\n").unwrap();
    fs::write(
        directory.path().join("docker-compose.yml"),
        "# test fixture\n",
    )
    .unwrap();
    let adapter = bin.join("docker");
    fs::write(
        &adapter,
        r#"#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$NELCOTA_PITR_ERROR_TEST_FIXTURE/commands.log"
case " $* " in
  *" stop app postgres ") exit 0 ;;
  *" --entrypoint pgbackrest postgres --stanza=main --delta restore ")
    printf '%s\n' 'adapter reached data directory' > "$NELCOTA_PITR_ERROR_TEST_FIXTURE/adapter-marker"
    exit 72 ;;
  *" up -d postgres app ")
    printf '%s\n' 'unsafe restart' > "$NELCOTA_PITR_ERROR_TEST_FIXTURE/reopened"
    exit 0 ;;
  *) exit 74 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();

    // Re-exec only this test. PATH is changed solely in the child, so parallel
    // tests cannot accidentally use the fixture's Docker adapter.
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env(FIXTURE, directory.path())
        .env("PATH", &bin)
        .output()
        .unwrap();
    assert!(directory.path().join("adapter-marker").is_file());
    assert!(
        !directory.path().join("reopened").exists(),
        "failed potentially modifying restore automatically restarted the project"
    );
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let commands = fs::read_to_string(directory.path().join("commands.log")).unwrap();
    let commands: Vec<_> = commands.lines().collect();
    assert_eq!(
        commands.len(),
        2,
        "unexpected recovery command: {commands:?}"
    );
    assert!(commands[0].ends_with(" stop app postgres"));
    assert!(commands[1].ends_with(" --stanza=main --delta restore"));
}
