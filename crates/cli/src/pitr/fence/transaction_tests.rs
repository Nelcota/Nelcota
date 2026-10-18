//! Recovery release must be atomic and must reject replaced path components.
use super::*;
use serde_json::json;
use std::os::unix::fs::symlink;

const ORIGINAL: &[u8] = b"# exact original compose bytes\n";

fn fixture() -> (tempfile::TempDir, Project) {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("projects/shop");
    fs::create_dir_all(&dir).unwrap();
    let project = Project::new("shop", &dir, Runtime::Docker);
    let fence = Fence::new(&project).unwrap();
    directory(&fence.state).unwrap();
    let guarded =
        docker::render_fixture(&fence, json!({"services":{"app":{},"postgres":{}}})).unwrap();
    for (name, bytes) in [
        (ACTIVE, fence.receipt.as_slice()),
        (RECEIPT, fence.receipt.as_slice()),
        ("compose.original.yml", ORIGINAL),
        ("compose.guarded.json", guarded.as_slice()),
    ] {
        atomic_write(&fence.state.join(name), bytes).unwrap();
    }
    use sha2::{Digest, Sha256};
    for (name, bytes) in [
        ("compose.original.sha256", ORIGINAL),
        ("compose.guarded.sha256", guarded.as_slice()),
    ] {
        let digest: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        atomic_write(&fence.state.join(name), digest.as_bytes()).unwrap();
    }
    atomic_write(&project.path("docker-compose.yml"), &guarded).unwrap();
    (root, project)
}

fn assert_invariant(project: &Project) {
    let marked = [ACTIVE, RECEIPT]
        .iter()
        .any(|name| project.path(STATE).join(name).exists());
    let original = fs::read(project.path("docker-compose.yml")).unwrap() == ORIGINAL;
    assert_ne!(
        marked, original,
        "must be fully fenced or fully recovered: markers={marked}, original_compose={original}"
    );
}

#[test]
fn docker_release_fault_boundaries_never_restore_unguarded_compose_with_markers() {
    faults::reset(None);
    let (_root, project) = fixture();
    faults::reset(None);
    Fence::new(&project).unwrap().clear_verified().unwrap();
    let count = faults::labels().len();
    assert!(count >= 2);
    for index in 0..count {
        faults::reset(None);
        let (_root, project) = fixture();
        faults::reset(Some(index));
        let result = Fence::new(&project).unwrap().clear_verified();
        let labels = faults::labels();
        faults::reset(None);
        assert!(
            result.is_err(),
            "missing injected error at {index}: {labels:?}"
        );
        assert_invariant(&project);
        // A retry must complete even when the previous commit already happened
        // but its final directory fsync returned an injected error.
        Fence::new(&project).unwrap().clear_verified().unwrap();
        assert_invariant(&project);
        assert_eq!(
            fs::read(project.path("docker-compose.yml")).unwrap(),
            ORIGINAL
        );
    }
}

#[test]
fn symlinked_fence_directory_cannot_release_markers() {
    faults::reset(None);
    let (_root, project) = fixture();
    let fence = Fence::new(&project).unwrap();
    let saved = project.path("retained-fence");
    fs::rename(&fence.state, &saved).unwrap();
    symlink(&saved, &fence.state).unwrap();
    assert!(
        fence.clear_verified().is_err(),
        "symlinked state was accepted"
    );
    assert!(saved.join(ACTIVE).is_file() && saved.join(RECEIPT).is_file());
}

#[test]
fn symlinked_parent_cannot_release_markers() {
    faults::reset(None);
    let (root, project) = fixture();
    let fence = Fence::new(&project).unwrap();
    let parent = root.path().join("projects");
    let saved = root.path().join("retained-projects");
    fs::rename(&parent, &saved).unwrap();
    symlink(&saved, &parent).unwrap();
    assert!(
        fence.clear_verified().is_err(),
        "symlinked parent was accepted"
    );
    assert!(saved.join("shop/pitr-fence/active.json").is_file());
}

#[test]
fn parent_segments_remain_supported_but_never_hide_a_symlink() {
    faults::reset(None);
    let (root, project) = fixture();
    let anchor = root.path().join("projects/anchor");
    fs::create_dir(&anchor).unwrap();
    let spelling = anchor.join("../shop");
    let alias = Project::new("shop", &spelling, Runtime::Docker);
    assert!(Fence::new(&alias).unwrap().owned(ACTIVE).unwrap());
    fs::remove_dir(&anchor).unwrap();
    symlink(&project.dir, &anchor).unwrap();
    assert!(Fence::new(&alias).is_err());
    assert!(project.path("pitr-fence/active.json").is_file());
}

#[test]
fn guard_copy_rejects_a_writable_source_without_installing_anything() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let library_path = root.path().join("library");
    fs::create_dir(&library_path).unwrap();
    let source = library_path.join("nelcota");
    fs::write(&source, b"untrusted writable executable").unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o777)).unwrap();
    let library = Directory::required(&library_path).unwrap();
    assert!(library.install_guard("nelcota", "pitr-check").is_err());
    assert!(!library_path.join("pitr-check").exists());
}

#[test]
fn docker_recovery_is_retryable_after_every_injected_boundary() {
    const FLAG: &str = "NELCOTA_RECOVERY_MATRIX";
    const TEST: &str = "pitr::fence::transaction_tests::docker_recovery_is_retryable_after_every_injected_boundary";
    if let Some(directory) = std::env::var_os(FLAG) {
        let project = Project::new("shop", Path::new(&directory), Runtime::Docker);
        let index = std::env::var("NELCOTA_RECOVERY_BOUNDARY")
            .unwrap()
            .parse::<isize>()
            .unwrap();
        faults::reset(usize::try_from(index).ok());
        let result = recover(&project, true);
        let labels = faults::labels();
        faults::reset(None);
        if index >= 0 {
            assert!(result.is_err(), "boundary {index} was not injected");
        }
        if index < 0 {
            result.unwrap();
        }
        assert_invariant(&project);
        recover(&project, true).unwrap();
        assert_invariant(&project);
        assert_eq!(
            fs::read(project.path("docker-compose.yml")).unwrap(),
            ORIGINAL
        );
        println!("RECOVERY_BOUNDARIES={}", labels.len());
        return;
    }
    let run = |index: isize| {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        faults::reset(None);
        let (_root, project) = fixture();
        let bin = project.path("bin");
        fs::create_dir(&bin).unwrap();
        let adapter = bin.join("docker");
        fs::write(&adapter, super::super::restore::tests::ADAPTER).unwrap();
        fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(FLAG, &project.dir)
            .env("NELCOTA_RECOVERY_BOUNDARY", index.to_string())
            .env("NELCOTA_PITR_ERROR_TEST_FIXTURE", &project.dir)
            .env("PITR_FIXTURE_MODE", "uncertain")
            .env("PATH", &bin)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "boundary {index}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let baseline = run(-1);
    let count: usize = baseline
        .lines()
        .find_map(|line| line.strip_prefix("RECOVERY_BOUNDARIES="))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        count >= 20,
        "must exercise backend verification and durable release"
    );
    for index in 0..count {
        run(index as isize);
    }
    println!(
        "Docker recovery: {count} injected boundaries, invariant and explicit recover retry passed"
    );
}

#[test]
fn native_release_and_adapter_fault_boundaries_are_retryable() {
    fn native_fixture() -> (tempfile::TempDir, Project) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("projects/shop");
        fs::create_dir_all(&dir).unwrap();
        (root, Project::new("shop", &dir, Runtime::Systemd))
    }
    let run = |index: Option<usize>, adapters: bool| {
        faults::reset(None);
        let (root, project) = native_fixture();
        let mut fence = Fence::new(&project).unwrap();
        fence.state = root.path().join("native-state");
        directory(&fence.state).unwrap();
        atomic_write(&fence.state.join(ACTIVE), &fence.receipt).unwrap();
        atomic_write(&fence.state.join(RECEIPT), &fence.receipt).unwrap();
        let units = root.path().join("units");
        fs::create_dir(&units).unwrap();
        let library_path = root.path().join("library");
        fs::create_dir(&library_path).unwrap();
        atomic_write(&library_path.join("nelcota"), b"owned executable fixture").unwrap();
        let library = Directory::required(&library_path).unwrap();
        faults::reset(index);
        let result = match adapters {
            true => library
                .install_guard("nelcota", "pitr-check")
                .and_then(|()| native::arm_fixture(&fence, &units)),
            false => fence.clear_verified(),
        };
        let count = faults::labels().len();
        faults::reset(None);
        if index.is_some() {
            assert!(result.is_err());
        }
        if index.is_none() {
            result.unwrap();
        }
        if adapters {
            assert!(fence.state.join(ACTIVE).is_file() && fence.state.join(RECEIPT).is_file());
            library.install_guard("nelcota", "pitr-check").unwrap();
            native::arm_fixture(&fence, &units).unwrap();
        }
        fence.clear_verified().unwrap();
        require_clear_at(&fence.state, "pitr recover --yes").unwrap();
        count
    };
    for adapters in [true, false] {
        let count = run(None, adapters);
        assert!(count >= 4);
        for index in 0..count {
            run(Some(index), adapters);
        }
        println!(
            "Native adapters={adapters}: {count} injected boundaries and explicit release retry passed"
        );
    }
}

#[test]
fn all_state_files_reject_symlinks_directories_and_hardlinks_without_changes() {
    use std::os::unix::fs::MetadataExt;
    for name in [
        ACTIVE,
        RECEIPT,
        RELEASED,
        "compose.original.yml",
        "compose.original.sha256",
        "compose.guarded.json",
        "compose.guarded.sha256",
        "check-start",
    ] {
        for kind in ["symlink", "directory", "hardlink"] {
            faults::reset(None);
            let (_root, project) = fixture();
            let fence = Fence::new(&project).unwrap();
            let path = fence.state.join(name);
            let saved = project.path("retained");
            if path.exists() {
                fs::rename(&path, &saved).unwrap();
            }
            if !saved.exists() {
                fs::write(&saved, b"retained fixture").unwrap();
            }
            match kind {
                "symlink" => symlink(&saved, &path).unwrap(),
                "directory" => fs::create_dir(&path).unwrap(),
                "hardlink" => fs::hard_link(&saved, &path).unwrap(),
                _ => unreachable!(),
            }
            let compose = fs::read(project.path("docker-compose.yml")).unwrap();
            let marker = fs::symlink_metadata(&path).unwrap();
            let error = fence.clear_verified().unwrap_err().to_string();
            assert!(
                error.contains("PITR fence") && error.contains(path.to_str().unwrap()),
                "{error}"
            );
            assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), marker.ino());
            assert_eq!(
                fs::read(project.path("docker-compose.yml")).unwrap(),
                compose
            );
            assert!(fence.state.join(ACTIVE).exists() && fence.state.join(RECEIPT).exists());
        }
    }
}

#[test]
#[ignore = "requires root and a complete UID map; run explicitly on the disposable hosted runner"]
fn foreign_owned_markers_and_directory_are_rejected_when_chown_is_available() {
    for name in [ACTIVE, RECEIPT, ""] {
        faults::reset(None);
        let (_root, project) = fixture();
        let fence = Fence::new(&project).unwrap();
        let path = match name.is_empty() {
            true => fence.state.clone(),
            false => fence.state.join(name),
        };
        std::os::unix::fs::chown(&path, Some(65534), None)
            .expect("root/complete UID map is required for the explicit ownership control");
        let compose = fs::read(project.path("docker-compose.yml")).unwrap();
        let error = fence.clear_verified().unwrap_err().to_string();
        assert!(
            error.contains("PITR fence") && error.contains(path.to_str().unwrap()),
            "{error}"
        );
        assert_eq!(
            fs::read(project.path("docker-compose.yml")).unwrap(),
            compose
        );
        assert!(fence.state.join(ACTIVE).is_file() && fence.state.join(RECEIPT).is_file());
    }
}
