//! Exercise the actual restore/recovery sequence in isolated child processes.
use crate::{
    host::Runtime,
    project::{Project, Service},
};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

const FIXTURE: &str = "NELCOTA_PITR_ERROR_TEST_FIXTURE";
const TEST: &str =
    "pitr::restore::tests::restore_fence_survives_process_exit_and_requires_verified_recovery";

#[test]
fn restore_fence_survives_process_exit_and_requires_verified_recovery() {
    if let Some(directory) = std::env::var_os(FIXTURE) {
        let project = Project::new("restore-error", Path::new(&directory), Runtime::Docker);
        let mode = std::env::var("PITR_FIXTURE_MODE").unwrap();
        let result = super::restore(&project, None, true);
        if mode == "fence-unwritable" {
            assert!(result.is_err());
            assert!(!project.path("adapter-marker").exists());
            return;
        }
        if mode == "success" {
            result.unwrap();
            assert!(!project.path("pitr-fence/active.json").exists());
            assert!(!project.path("pitr-fence/recovery.json").exists());
            assert_eq!(
                fs::read(project.path("docker-compose.yml")).unwrap(),
                b"# original fixture\n"
            );
            project.up().unwrap();
            return;
        }
        let message = format!("{:#}", result.unwrap_err());
        assert!(
            project.path("pitr-fence/active.json").is_file(),
            "{message}"
        );
        if mode == "uncertain" {
            assert!(message.contains("data directory may have changed"));
            assert!(message.contains("Postgres and the app remain stopped"));
            assert!(message.contains("pgbackrest restore failed"));
        }
        for result in [
            project.up(),
            project.start(&[Service::App]),
            project.start(&[Service::Postgres]),
            project.recreate(Service::App),
            project.recreate(Service::Postgres),
        ] {
            let error = result.unwrap_err().to_string();
            assert!(error.contains("active.json") && error.contains("pitr recover --yes"));
        }
        // Invalid/unclean control cannot be acknowledged away, even with --yes.
        if mode == "verify-fails" || mode == "amcheck-fails" {
            assert!(crate::pitr::recover(&project, true).is_err());
            assert!(project.path("pitr-fence/active.json").is_file());
            return;
        }
        if mode == "wal-fails" {
            assert!(message.contains("could not finish the recovery"));
            return;
        }
        return;
    }
    for mode in [
        "uncertain",
        "success",
        "wal-fails",
        "verify-fails",
        "amcheck-fails",
        "fence-unwritable",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("bin");
        fs::create_dir(&bin).unwrap();
        fs::write(directory.path().join("pgbackrest.env"), "# test fixture\n").unwrap();
        fs::write(
            directory.path().join("docker-compose.yml"),
            "# original fixture\n",
        )
        .unwrap();
        let adapter = bin.join("docker");
        fs::write(&adapter, ADAPTER).unwrap();
        fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
        if mode == "fence-unwritable" {
            fs::write(directory.path().join("pitr-fence"), b"not a directory").unwrap();
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(FIXTURE, directory.path())
            .env("PITR_FIXTURE_MODE", mode)
            .env("PATH", &bin)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mode {mode}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if mode == "fence-unwritable" {
            continue;
        }
        assert!(directory.path().join("adapter-marker").is_file());
        let commands = fs::read_to_string(directory.path().join("commands.log")).unwrap();
        let commands: Vec<_> = commands.lines().collect();
        let removal = commands
            .iter()
            .position(|c| c.ends_with("rm --stop --force app postgres"))
            .unwrap();
        let restore = commands
            .iter()
            .position(|c| c.ends_with("--stanza=main --delta restore"))
            .unwrap();
        assert!(
            removal < restore,
            "old unguarded containers must be gone before any data change"
        );
        if mode == "success" {
            assert!(
                commands
                    .iter()
                    .any(|c| c.contains("--detach --rm --no-deps --name nelcota-pitr-recovery-"))
            );
            continue;
        }
        assert!(
            directory.path().join("pitr-fence/active.json").is_file(),
            "fence must survive the child process"
        );
        assert!(
            !commands.iter().any(|c| c.contains("up -d")),
            "failed restore reopened ordinary services: {commands:?}"
        );
        if mode == "uncertain" {
            // A second process explicitly verifies the directory and clears the
            // durable fence. No state from the failing CLI process is retained.
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "pitr::restore::tests::explicit_recovery_reopens_verified_directory",
                    "--nocapture",
                ])
                .env(FIXTURE, directory.path())
                .env("PITR_FIXTURE_MODE", mode)
                .env("PATH", &bin)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(!directory.path().join("pitr-fence/active.json").exists());
        }
    }
}

#[test]
fn explicit_recovery_reopens_verified_directory() {
    if let Some(directory) = std::env::var_os(FIXTURE) {
        let project = Project::new("restore-error", Path::new(&directory), Runtime::Docker);
        crate::pitr::recover(&project, true).unwrap();
        project.up().unwrap();
        assert_eq!(
            fs::read(project.path("docker-compose.yml")).unwrap(),
            b"# original fixture\n"
        );
    }
}

const ADAPTER: &str = r#"#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$NELCOTA_PITR_ERROR_TEST_FIXTURE/commands.log"
case " $* " in
  *" stop app postgres "|*" rm --stop --force app postgres ") exit 0 ;;
  *" guarded-serve --check-support ") exit 0 ;;
  *" config --format json ") printf '%s\n' '{"name":"fixture","services":{"app":{"image":"app:fixed","restart":"always"},"postgres":{"image":"postgres:17","restart":"always"}}}'; exit 0 ;;
  *" --entrypoint pgbackrest postgres --stanza=main --delta restore ")
    test -f "$NELCOTA_PITR_ERROR_TEST_FIXTURE/pitr-fence/active.json"
    printf '%s\n' 'adapter reached data directory' > "$NELCOTA_PITR_ERROR_TEST_FIXTURE/adapter-marker"
    case "$PITR_FIXTURE_MODE" in success|wal-fails) exit 0 ;; *) exit 72 ;; esac ;;
  *" run --detach --rm --no-deps --name nelcota-pitr-recovery-"*) exit 0 ;;
  *" inspect --format {{.HostConfig.RestartPolicy.Name}} "*) printf '%s\n' no; exit 0 ;;
  *" inspect --format {{json .Config.Labels}} "*) printf '%s\n' 'Error: No such object: owned-recovery' >&2; exit 1 ;;
  *" SELECT pg_is_in_recovery() ")
    case "$PITR_FIXTURE_MODE" in wal-fails) exit 1 ;; *) printf '%s\n' f; exit 0 ;; esac ;;
  *" inspect --format {{.State.Running}} "*) printf '%s\n' false; exit 0 ;;
  *" stop --time 120 nelcota-pitr-recovery-"*) exit 0 ;;
  *" --entrypoint /bin/sh "*) exit 0 ;;
  *" --entrypoint env postgres LC_ALL=C pg_controldata "*)
    case "$PITR_FIXTURE_MODE" in verify-fails) printf '%s\n' 'Database cluster state: in archive recovery' ;; *) printf '%s\n' 'Database cluster state: shut down' ;; esac
    printf '%s\n' 'Data page checksum version: 1'; exit 0 ;;
  *" --entrypoint pg_checksums "*) exit 0 ;;
  *" pg_amcheck --all --install-missing=pg_catalog "*)
    case "$PITR_FIXTURE_MODE" in amcheck-fails) exit 71 ;; *) exit 0 ;; esac ;;
  *" up -d"*)
    test ! -e "$NELCOTA_PITR_ERROR_TEST_FIXTURE/pitr-fence/active.json"
    exit 0 ;;
  *" ps -q postgres "|*" ps -q app ") printf '%s\n' fixture-container; exit 0 ;;
  *" inspect --format {{.State.Health.Status}} fixture-container ") printf '%s\n' healthy; exit 0 ;;
  *" exec -T -u postgres postgres pgbackrest --stanza=main --type=full backup ") exit 0 ;;
  *) exit 74 ;;
esac
"#;
