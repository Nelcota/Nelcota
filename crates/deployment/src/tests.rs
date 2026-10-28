use super::*;
use std::fs;

fn receipts(job: &mut Job) {
    job.expected_env_sha256 = Some(token().unwrap());
    job.manifest_sha256 = Some(token().unwrap());
    job.previous_config_sha256 = Some(token().unwrap());
    job.target_binary_sha256 = Some(token().unwrap());
    job.previous_image = Some(format!("sha256:{}", token().unwrap()));
    job.migration_version = 15;
    job.backup = Some("/host/projects/app/backups/snapshot.dump".into());
    job.dump_sha256 = Some(token().unwrap());
}
fn fixture() -> (tempfile::TempDir, Journal) {
    let temp = tempfile::tempdir().unwrap();
    let journal = Journal::open(temp.path()).unwrap();
    (temp, journal)
}

#[test]
fn pre_snapshot_recovery_remains_recoverable_across_repeated_interruptions() {
    for original in [Phase::Pausing, Phase::Capturing] {
        let (_temp, journal) = fixture();
        let mut job = journal
            .begin(
                "app",
                "0.4.0",
                "0.5.0",
                "owner",
                &token().unwrap(),
                &token().unwrap(),
            )
            .unwrap();
        receipts(&mut job);
        job.backup = None;
        job.dump_sha256 = None;
        journal.advance(&mut job, Phase::Pausing, None).unwrap();
        if original == Phase::Capturing {
            journal.advance(&mut job, Phase::Capturing, None).unwrap();
        }
        for _ in 0..3 {
            journal.reconcile().unwrap();
            job = journal.list().unwrap().remove(0);
            assert_eq!(job.interrupted_phase, Some(original));
            journal.advance(&mut job, Phase::Recovering, None).unwrap();
        }
        job.restored = true;
        journal
            .advance(&mut job, Phase::FailedBeforeChange, None)
            .unwrap();
        assert!(job.public.phase.terminal());
        assert!(!job.public.committed);
    }
}

#[test]
fn unrelated_journal_files_do_not_hide_active_jobs() {
    let (temp, journal) = fixture();
    fs::write(
        temp.path().join("updates/jobs/README.txt"),
        b"operator notes",
    )
    .unwrap();
    fs::create_dir(temp.path().join("updates/jobs/archive")).unwrap();
    let job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    assert_eq!(journal.list().unwrap()[0].public.id, job.public.id);
    assert!(
        journal
            .begin(
                "other",
                "0.4.0",
                "0.5.0",
                "owner",
                &token().unwrap(),
                &token().unwrap()
            )
            .is_err()
    );
}

#[test]
fn post_commit_snapshot_restore_requires_a_durable_operator_decision() {
    let (_temp, journal) = fixture();
    let mut job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    receipts(&mut job);
    for phase in [
        Phase::Pausing,
        Phase::Capturing,
        Phase::BackupVerified,
        Phase::Activating,
        Phase::Validating,
        Phase::Committing,
        Phase::NeedsOperator,
    ] {
        journal.advance(&mut job, phase, None).unwrap();
    }
    assert!(journal.advance(&mut job, Phase::Recovering, None).is_err());
    job.restore_requested = true;
    journal
        .advance(
            &mut job,
            Phase::NeedsOperator,
            Some("operator_snapshot_restore_requested"),
        )
        .unwrap();
    let mut stale = job.clone();
    journal.advance(&mut job, Phase::Recovering, None).unwrap();
    journal.reconcile().unwrap();
    job = journal.list().unwrap().remove(0);
    assert!(job.restore_requested && job.public.committed);
    journal.advance(&mut job, Phase::Recovering, None).unwrap();
    job.restored = true;
    journal
        .advance(&mut job, Phase::ResumingPrevious, None)
        .unwrap();
    journal.advance(&mut job, Phase::Recovered, None).unwrap();
    stale.restore_requested = false;
    assert!(journal.save(&stale).is_err());
}
#[test]
fn lock_is_owned_until_drop_and_shared_by_callers() {
    let temp = tempfile::tempdir().unwrap();
    let lock = HostLock::acquire(temp.path()).unwrap();
    assert!(HostLock::acquire(temp.path()).is_err());
    drop(lock);
    assert!(HostLock::acquire(temp.path()).is_ok());
}
#[test]
fn retry_is_idempotent_and_other_jobs_cannot_start() {
    let (_temp, journal) = fixture();
    let key = token().unwrap();
    let fingerprint = token().unwrap();
    let job = journal
        .begin("app", "0.4.0", "0.5.0", "owner", &key, &fingerprint)
        .unwrap();
    let retry = journal
        .begin("app", "0.4.0", "0.5.0", "owner", &key, &fingerprint)
        .unwrap();
    assert_eq!(job.public.id, retry.public.id);
    assert!(
        journal
            .begin("app", "0.4.0", "0.6.0", "owner", &key, &fingerprint)
            .is_err()
    );
    assert!(
        journal
            .begin(
                "other",
                "0.4.0",
                "0.5.0",
                "owner",
                &token().unwrap(),
                &fingerprint
            )
            .is_err()
    );
}
#[test]
fn committed_crash_cannot_restore_an_old_snapshot() {
    let (temp, journal) = fixture();
    let mut job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    receipts(&mut job);
    for phase in [
        Phase::Pausing,
        Phase::Capturing,
        Phase::BackupVerified,
        Phase::Activating,
        Phase::Validating,
        Phase::Committing,
    ] {
        journal.advance(&mut job, phase, None).unwrap();
    }
    drop(journal);
    let journal = Journal::open(temp.path()).unwrap();
    journal.reconcile().unwrap();
    let mut job = journal.list().unwrap().remove(0);
    assert!(job.public.committed);
    assert_eq!(job.public.phase, Phase::NeedsOperator);
    assert!(journal.advance(&mut job, Phase::Recovering, None).is_err());
}
#[test]
fn every_incomplete_stage_stays_closed_after_restart() {
    let stages = [
        Phase::Preparing,
        Phase::Pausing,
        Phase::Capturing,
        Phase::BackupVerified,
        Phase::Activating,
        Phase::Validating,
    ];
    for stage in stages {
        let (temp, journal) = fixture();
        let mut job = journal
            .begin(
                "app",
                "0.4.0",
                "0.5.0",
                "owner",
                &token().unwrap(),
                &token().unwrap(),
            )
            .unwrap();
        receipts(&mut job);
        for next in [
            Phase::Pausing,
            Phase::Capturing,
            Phase::BackupVerified,
            Phase::Activating,
            Phase::Validating,
        ] {
            if job.public.phase == stage {
                break;
            }
            journal.advance(&mut job, next, None).unwrap();
        }
        drop(journal);
        let journal = Journal::open(temp.path()).unwrap();
        journal.reconcile().unwrap();
        assert_eq!(
            journal.list().unwrap()[0].public.phase,
            Phase::NeedsOperator
        );
    }
}
#[test]
fn corruption_never_becomes_a_guessed_success() {
    let (_temp, journal) = fixture();
    let job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    atomic_write(
        &journal.directory(&job.public.id).unwrap().join("job.json"),
        b"{}",
    )
    .unwrap();
    assert!(journal.reconcile().is_err());
}
#[test]
fn files_are_private_and_symlinks_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state");
    atomic_write(&path, b"private").unwrap();
    assert_eq!(read_private(&path, 32).unwrap(), b"private");
    assert!(read_private(&path, 2).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = temp.path().join("link");
        symlink(&path, &link).unwrap();
        assert!(atomic_write(&link, b"changed").is_err());
        assert!(read_private(&link, 32).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"private");
    }
}
#[test]
fn release_contract_rejects_downgrade_partial_and_untrusted_shapes() {
    let mut release = Release {
        schema: 1,
        ci_run_id: 1,
        version: "0.5.0".into(),
        source_sha: "a".repeat(40),
        minimum_controller: "0.4.0".into(),
        protocol: 1,
        minimum_app: "0.4.0".into(),
        validation_mode: true,
        migration_version: 15,
        artifacts: ["x86_64", "aarch64"]
            .into_iter()
            .map(|arch| Artifact {
                architecture: arch.into(),
                filename: format!("nelcota-{arch}-unknown-linux-musl"),
                bytes: 100,
                sha256: token().unwrap(),
                image_digest: token().unwrap(),
            })
            .collect(),
    };
    assert!(release.validate("0.4.0", "0.4.0").is_ok());
    assert!(release.validate("0.3.0", "0.4.0").is_err());
    assert!(release.validate("0.4.0", "0.6.0").is_err());
    release.artifacts[0].filename = "../../bin/sh".into();
    assert!(release.validate("0.4.0", "0.4.0").is_err());
}

#[test]
fn failed_persistence_cannot_flip_the_in_memory_commit_decision() {
    let (_temp, journal) = fixture();
    let mut job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    receipts(&mut job);
    for phase in [
        Phase::Pausing,
        Phase::Capturing,
        Phase::BackupVerified,
        Phase::Activating,
        Phase::Validating,
    ] {
        journal.advance(&mut job, phase, None).unwrap();
    }
    let file = journal.directory(&job.public.id).unwrap().join("job.json");
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    assert!(journal.advance(&mut job, Phase::Committing, None).is_err());
    assert!(!job.public.committed);
    assert_eq!(job.public.phase, Phase::Validating);
}

#[test]
fn stale_error_handling_cannot_erase_either_durable_resume_decision() {
    for restored in [false, true] {
        let (_temp, journal) = fixture();
        let mut job = journal
            .begin(
                "app",
                "0.4.0",
                "0.5.0",
                "owner",
                &token().unwrap(),
                &token().unwrap(),
            )
            .unwrap();
        receipts(&mut job);
        journal.advance(&mut job, Phase::Pausing, None).unwrap();
        let phase = match restored {
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
        // A rename may persist the next receipt before fsync fails, leaving
        // the caller's in-memory job at the preceding stage.
        let mut stale = job.clone();
        job.restored = restored;
        journal.advance(&mut job, phase, None).unwrap();
        let receipt =
            fs::read(journal.directory(&job.public.id).unwrap().join("job.json")).unwrap();
        assert!(
            journal
                .advance(&mut stale, Phase::NeedsOperator, Some("recovery_failed"))
                .is_err()
        );
        // A larger sequence cannot revoke the irreversible decision either.
        stale.public.sequence = job.public.sequence + 1;
        assert!(journal.save(&stale).is_err());
        assert_eq!(
            fs::read(journal.directory(&job.public.id).unwrap().join("job.json")).unwrap(),
            receipt
        );
        assert!(journal.list().unwrap()[0].public.committed);
    }
}

#[test]
fn a_stale_writer_cannot_reopen_a_completed_job() {
    let (_temp, journal) = fixture();
    let mut job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    let mut stale = job.clone();
    journal
        .advance(&mut job, Phase::FailedBeforeChange, None)
        .unwrap();
    assert!(
        journal
            .advance(&mut stale, Phase::NeedsOperator, Some("worker_unavailable"))
            .is_err()
    );
    assert!(journal.save(&stale).is_err());
    assert_eq!(
        journal.list().unwrap()[0].public.phase,
        Phase::FailedBeforeChange
    );
}
#[test]
fn resumed_previous_version_also_forbids_a_second_snapshot_restore() {
    let (_temp, journal) = fixture();
    let mut job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    receipts(&mut job);
    journal.advance(&mut job, Phase::Pausing, None).unwrap();
    journal.advance(&mut job, Phase::Recovering, None).unwrap();
    job.restored = true;
    journal
        .advance(&mut job, Phase::ResumingPrevious, None)
        .unwrap();
    journal.reconcile().unwrap();
    let mut job = journal.list().unwrap().remove(0);
    assert!(job.public.committed);
    assert!(job.restored);
    assert!(journal.advance(&mut job, Phase::Recovering, None).is_err());
}
#[test]
fn missing_receipts_cannot_activate_or_be_reported_as_a_success() {
    let (_temp, journal) = fixture();
    let mut job = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    assert!(journal.advance(&mut job, Phase::Pausing, None).is_err());
    receipts(&mut job);
    journal.advance(&mut job, Phase::Pausing, None).unwrap();
    journal.advance(&mut job, Phase::Capturing, None).unwrap();
    job.dump_sha256 = None;
    assert!(
        journal
            .advance(&mut job, Phase::BackupVerified, None)
            .is_err()
    );
}
#[test]
fn interrupted_preparation_can_finish_without_touching_live_data() {
    let (_temp, journal) = fixture();
    journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    journal.reconcile().unwrap();
    let mut job = journal.list().unwrap().remove(0);
    journal
        .advance(&mut job, Phase::FailedBeforeChange, None)
        .unwrap();
    assert!(job.public.phase.terminal());
}

#[test]
fn concurrent_operators_can_create_only_one_host_job() {
    use std::sync::{
        Arc, Barrier,
        atomic::{AtomicUsize, Ordering},
    };
    let temporary = tempfile::tempdir().unwrap();
    Journal::open(temporary.path()).unwrap();
    let barrier = Arc::new(Barrier::new(16));
    let accepted = Arc::new(AtomicUsize::new(0));
    let mut threads = Vec::new();
    for index in 0..16 {
        let root = temporary.path().to_path_buf();
        let barrier = barrier.clone();
        let accepted = accepted.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            if let Ok(_lease) = HostLock::acquire(&root)
                && Journal::open(&root)
                    .unwrap()
                    .begin(
                        "app",
                        "0.4.0",
                        "0.5.0",
                        &format!("operator-{index}"),
                        &token().unwrap(),
                        &token().unwrap(),
                    )
                    .is_ok()
            {
                accepted.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(accepted.load(Ordering::Relaxed), 1);
    assert_eq!(
        Journal::open(temporary.path())
            .unwrap()
            .list()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn active_jobs_remain_visible_when_wall_clock_moves_backwards() {
    let (_temp, journal) = fixture();
    for index in 0..35 {
        let mut job = journal
            .begin(
                "app",
                "0.4.0",
                "0.5.0",
                "owner",
                &token().unwrap(),
                &token().unwrap(),
            )
            .unwrap();
        journal
            .advance(&mut job, Phase::FailedBeforeChange, None)
            .unwrap();
        job.public.updated_at = 1000 + index;
        job.public.sequence += 1;
        journal.save(&job).unwrap();
    }
    let mut active = journal
        .begin(
            "app",
            "0.4.0",
            "0.5.0",
            "owner",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    active.public.updated_at = 1;
    active.public.sequence += 1;
    journal.save(&active).unwrap();
    let first = journal.list().unwrap().remove(0);
    assert_eq!(first.public.id, active.public.id);
    assert!(!first.public.phase.terminal());
}

#[test]
fn interrupted_migration_backup_fences_all_host_mutations_until_recovery() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join(".migration-backup-active"),
        b"durable fence",
    )
    .unwrap();
    assert!(crate::HostLock::acquire(temp.path()).is_err());
    let recovery = crate::HostLock::acquire_migration_recovery(temp.path()).unwrap();
    assert!(crate::HostLock::acquire_migration_recovery(temp.path()).is_err());
    std::fs::remove_file(temp.path().join(".migration-backup-active")).unwrap();
    drop(recovery);
    assert!(crate::HostLock::acquire(temp.path()).is_ok());
}
