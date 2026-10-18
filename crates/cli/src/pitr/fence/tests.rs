use super::*;
use crate::project::Service;
use serde_json::{Value, json};

fn project(root: &Path, runtime: Runtime) -> Project {
    let dir = root.join("projects/shop");
    fs::create_dir_all(&dir).unwrap();
    Project::new("shop", &dir, runtime)
}

#[test]
fn all_cli_start_paths_refuse_persisted_fence_without_running_an_adapter() {
    let root = tempfile::tempdir().unwrap();
    let project = project(root.path(), Runtime::Docker);
    let fence = Fence::new(&project).unwrap();
    directory(&fence.state).unwrap();
    atomic_write(&fence.state.join(ACTIVE), &fence.receipt).unwrap();
    // Reopen from disk rather than relying on the creating process/object.
    drop(fence);
    for result in [
        project.up(),
        project.start(&[Service::Postgres]),
        project.start(&[Service::App]),
        project.recreate(Service::Postgres),
        project.recreate(Service::App),
    ] {
        let text = result.unwrap_err().to_string();
        assert!(text.contains("active.json"), "{text}");
        assert!(text.contains("pitr recover --yes"), "{text}");
    }
    let reopened = Fence::new(&project).unwrap();
    assert!(reopened.owned(ACTIVE).unwrap());
}

#[test]
fn unfenced_directories_are_allowed_and_foreign_fences_cannot_be_released() {
    let root = tempfile::tempdir().unwrap();
    let project = project(root.path(), Runtime::Docker);
    require_clear(&project).unwrap();
    let fence = Fence::new(&project).unwrap();
    directory(&fence.state).unwrap();
    atomic_write(&fence.state.join(ACTIVE), b"foreign owner").unwrap();
    assert!(fence.owned(ACTIVE).is_err());
    assert!(fence.clear_verified().is_err());
    assert!(require_clear(&project).is_err());
    assert_eq!(
        fs::read(fence.state.join(ACTIVE)).unwrap(),
        b"foreign owner"
    );
}

#[cfg(unix)]
#[test]
fn native_boot_and_manual_systemctl_guards_fail_then_allow_verified_recovery() {
    use std::process::Command;
    let root = tempfile::tempdir().unwrap();
    let project = project(root.path(), Runtime::Systemd);
    let mut fence = Fence::new(&project).unwrap();
    fence.state = root.path().join("native-state");
    directory(&fence.state).unwrap();
    let units = root.path().join("units");
    fs::create_dir(&units).unwrap();
    native::arm_fixture(&fence, &units).unwrap();
    let guard = fence.state.join("check-start");
    assert!(
        Command::new("/bin/sh")
            .arg(&guard)
            .status()
            .unwrap()
            .success()
    );
    atomic_write(&fence.state.join(ACTIVE), &fence.receipt).unwrap();
    atomic_write(&fence.state.join(RECEIPT), &fence.receipt).unwrap();
    for unit in [
        crate::native::POSTGRES_UNIT.to_owned(),
        crate::native::app_unit("shop"),
    ] {
        let contents =
            fs::read_to_string(units.join(format!("{unit}.service.d/80-nelcota-pitr-fence.conf")))
                .unwrap();
        assert!(contents.contains(&format!("ExecStartPre=+/bin/sh {}", guard.display())));
        let output = Command::new("/bin/sh").arg(&guard).output().unwrap();
        assert_eq!(output.status.code(), Some(78));
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains(&fence.state.join(ACTIVE).display().to_string()));
        assert!(error.contains("pitr recover --yes"));
    }
    fence.clear_verified().unwrap();
    require_clear_at(&fence.state, "unused").unwrap();
    assert!(
        Command::new("/bin/sh")
            .arg(&guard)
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn docker_entrypoints_enforce_both_restart_policies_without_mutating_volumes() {
    let root = tempfile::tempdir().unwrap();
    let project = project(root.path(), Runtime::Docker);
    let fence = Fence::new(&project).unwrap();
    directory(&fence.state).unwrap();
    for policy in ["unless-stopped", "always"] {
        let config = json!({"services":{
            "postgres":{"restart":policy,"volumes":[{"type":"volume","source":"kept","target":"/var/lib/postgresql/data"}],"environment":{"POSTGRES_PASSWORD":"literal$dollar"}},
            "app":{"restart":policy,"image":"app:fixed"}},"volumes":{"kept":{"name":"owned-kept"}}});
        let rendered: Value =
            serde_json::from_slice(&docker::render_fixture(&fence, config).unwrap()).unwrap();
        assert_eq!(rendered["services"]["postgres"]["restart"], "no");
        assert_eq!(rendered["services"]["app"]["restart"], "no");
        assert_eq!(
            rendered["services"]["postgres"]["environment"]["POSTGRES_PASSWORD"],
            "literal$$dollar"
        );
        assert_eq!(
            rendered["services"]["postgres"]["volumes"][0]["source"],
            "kept"
        );
        let pg = rendered["services"]["postgres"]["entrypoint"][2]
            .as_str()
            .unwrap();
        assert!(
            pg.contains("active.json")
                && pg.contains("recovery.json")
                && pg.contains("pitr recover --yes")
        );
        assert!(pg.contains("\"$$@\""));
        assert_eq!(
            rendered["services"]["app"]["entrypoint"][1],
            "guarded-serve"
        );
        for name in ["app", "postgres"] {
            let mounts = rendered["services"][name]["volumes"].as_array().unwrap();
            assert!(
                mounts
                    .iter()
                    .any(|v| v["target"] == "/nelcota-pitr-fence" && v["read_only"] == true)
            );
        }
    }
}

#[test]
fn docker_custom_startup_is_rejected_before_an_unenforceable_fence() {
    let root = tempfile::tempdir().unwrap();
    let project = project(root.path(), Runtime::Docker);
    let fence = Fence::new(&project).unwrap();
    directory(&fence.state).unwrap();
    for config in [
        json!({"services":{"postgres":{"entrypoint":["custom"]},"app":{}}}),
        json!({"services":{"postgres":{"environment":{"PGDATA":"/other"}},"app":{}}}),
        json!({"services":{"postgres":{},"app":{"command":["custom"]}}}),
    ] {
        assert!(docker::render_fixture(&fence, config).is_err());
    }
}

#[cfg(unix)]
#[test]
fn dangling_symlink_fences_fail_closed() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let project = project(root.path(), Runtime::Docker);
    let fence = Fence::new(&project).unwrap();
    directory(&fence.state).unwrap();
    symlink("absent", fence.state.join(ACTIVE)).unwrap();
    assert!(require_clear(&project).is_err());
    assert!(fence.owned(ACTIVE).is_err());
    assert!(fence.clear_verified().is_err());
}
