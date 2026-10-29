//! Recovery receipts and native executable identity regressions.
use super::record_recovery_failure;
use super::validation::validate_running_binary;
use nelcota_deployment::Journal;
use nelcota_deployment::Phase;
use nelcota_deployment::digest_file;
use std::fs;
use std::process::Command;

#[test]
fn recovery_errors_preserve_the_authoritative_resume_decision() {
    for restored in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let journal = Journal::open(temporary.path()).unwrap();
        let mut job = journal
            .begin(
                "shop",
                "0.4.0",
                "0.5.0",
                "operator",
                &nelcota_deployment::token().unwrap(),
                &nelcota_deployment::token().unwrap(),
            )
            .unwrap();
        job.expected_env_sha256 = Some(nelcota_deployment::token().unwrap());
        job.manifest_sha256 = Some(nelcota_deployment::token().unwrap());
        job.previous_config_sha256 = Some(nelcota_deployment::token().unwrap());
        job.target_binary_sha256 = Some(nelcota_deployment::token().unwrap());
        job.previous_binary = Some(nelcota_deployment::token().unwrap());
        job.migration_version = 15;
        job.backup = Some("/backups/snapshot.dump".into());
        job.dump_sha256 = Some(nelcota_deployment::token().unwrap());
        journal.advance(&mut job, Phase::Pausing, None).unwrap();
        let boundary = match restored {
            true => {
                journal.advance(&mut job, Phase::Recovering, None).unwrap();
                Phase::ResumingPrevious
            }
            false => {
                for phase in [
                    Phase::Capturing,
                    Phase::BackupVerified,
                    Phase::Activating,
                    Phase::Validating,
                ] {
                    journal.advance(&mut job, phase, None).unwrap();
                }
                Phase::Committing
            }
        };
        let mut stale = job.clone();
        job.restored = restored;
        journal.advance(&mut job, boundary, None).unwrap();
        record_recovery_failure(&journal, &mut stale).unwrap();
        assert_eq!(stale.public.phase, Phase::NeedsOperator);
        assert!(stale.public.committed);
        assert_eq!(stale.restored, restored);
        assert_eq!(journal.list().unwrap()[0].public, stale.public);
        assert!(
            journal
                .advance(&mut stale, Phase::Recovering, None)
                .is_err()
        );
    }
}

#[test]
fn running_native_identity_rejects_replacement_even_with_the_same_hash() {
    use std::io::{Read, Write};
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::process::Stdio;

    struct Process(std::process::Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let installed = temporary.path().join("installed");
    fs::copy("/bin/cat", &installed).unwrap();
    let (mut readiness, child_socket) = UnixStream::pair().unwrap();
    readiness
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    readiness
        .set_write_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let input: OwnedFd = child_socket.try_clone().unwrap().into();
    let output: OwnedFd = child_socket.into();
    let process = Process(
        Command::new(&installed)
            .stdin(Stdio::from(input))
            .stdout(Stdio::from(output))
            .spawn()
            .unwrap(),
    );
    // spawn's exec notification can precede /proc's executable update.
    // Actual child I/O proves readiness without retrying the security check.
    readiness.write_all(b"ready\n").unwrap();
    let mut observed = [0; 6];
    readiness.read_exact(&mut observed).unwrap();
    assert_eq!(&observed, b"ready\n");
    let running = std::path::PathBuf::from(format!("/proc/{}/exe", process.0.id()));
    let digest = digest_file(&installed, 256 * 1024 * 1024).unwrap();
    validate_running_binary(&installed, &running, &digest).unwrap();
    assert!(
        validate_running_binary(&installed, &running, &nelcota_deployment::token().unwrap())
            .is_err()
    );

    let replacement = temporary.path().join("replacement");
    fs::copy(&installed, &replacement).unwrap();
    fs::rename(replacement, &installed).unwrap();
    assert_eq!(digest_file(&installed, 256 * 1024 * 1024).unwrap(), digest);
    let failure = validate_running_binary(&installed, &running, &digest).unwrap_err();
    assert!(failure.to_string().contains("different executable"));
}
