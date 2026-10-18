//! A native installation owns machine-wide PostgreSQL, Caddy and unit paths.

use anyhow::{Context, bail};
use nelcota_deployment::{HostLock, atomic_write, private_dir, read_private};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

use crate::host::{Host, Runtime};

const STATE: &str = "/var/lib/nelcota-native";
const OWNER: &str = "owner.json";
const POSTGRES_CONFIG: &str = "/etc/postgresql/17/main/conf.d/nelcota.conf";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    schema: u8,
    root: PathBuf,
}

pub(crate) struct MachineLease {
    _lease: HostLock,
    state: PathBuf,
    root: PathBuf,
}

/// Resolve aliases without creating the proposed host before ownership checks.
fn root_identity(root: &Path) -> anyhow::Result<PathBuf> {
    let root = std::path::absolute(root)?;
    match root.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = root.parent().context("host directory has no parent")?;
            let name = root
                .file_name()
                .context("host directory cannot be resolved")?;
            Ok(root_identity(parent)?.join(name))
        }
        Err(error) => Err(error).context("could not identify the native host directory"),
    }
}

fn read_owner(state: &Path) -> anyhow::Result<Option<Owner>> {
    let path = state.join(OWNER);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("could not inspect native ownership"),
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.uid() != fs::metadata(state)?.uid() || metadata.nlink() != 1 {
                    bail!("unsafe native ownership file");
                }
            }
            #[cfg(not(unix))]
            let _ = metadata;
        }
    }
    let owner: Owner = serde_json::from_slice(&read_private(&path, 16384)?)
        .context("invalid native ownership record; explicit recovery is required")?;
    if owner.schema != 1 || !owner.root.is_absolute() {
        bail!("invalid native ownership record; explicit recovery is required");
    }
    Ok(Some(owner))
}

impl MachineLease {
    fn acquire_at(
        state: &Path,
        root: &Path,
        inspect_legacy: impl FnOnce() -> anyhow::Result<()>,
    ) -> anyhow::Result<Self> {
        let root = root_identity(root)?;
        private_dir(state)?;
        let lease = HostLock::acquire(state).context("native machine lease is unavailable")?;
        match read_owner(state)? {
            Some(owner) if owner.root != root => {
                bail!(
                    "native runtime already belongs to another host directory; use Docker for multiple projects"
                );
            }
            Some(_) => {}
            None => {
                inspect_legacy()?;
                let record = serde_json::to_vec(&Owner {
                    schema: 1,
                    root: root.clone(),
                })?;
                if record.len() > 16384 {
                    bail!("native ownership record exceeds its size limit");
                }
                atomic_write(&state.join(OWNER), &record)?;
            }
        }
        Ok(Self {
            _lease: lease,
            state: state.to_path_buf(),
            root,
        })
    }

    /// Only call after every project removal step has succeeded. Keep the lock
    /// inode: unlinking it could admit two independent lock holders.
    pub(crate) fn release(self) -> anyhow::Result<()> {
        if read_owner(&self.state)?.is_none_or(|owner| owner.root != self.root) {
            bail!("native ownership changed during removal; explicit recovery is required");
        }
        fs::remove_file(self.state.join(OWNER))?;
        #[cfg(unix)]
        fs::File::open(&self.state)?.sync_all()?;
        Ok(())
    }
}

fn inspect_legacy(host: &Host, units: &Path, postgres_config: &Path) -> anyhow::Result<()> {
    let expected = match host.exists() {
        true => {
            let manifest = host.manifest()?;
            if manifest.runtime != Runtime::Systemd || manifest.projects.len() > 1 {
                bail!("existing native installation cannot be claimed by this host");
            }
            manifest.projects.first().map(|project| {
                (
                    format!("nelcota-{}.service", project.name),
                    host.project_dir(&project.name).join(".env"),
                    format!("# nelcota project \"{}\".", project.name),
                )
            })
        }
        false => None,
    };
    let mut count = 0;
    for (index, entry) in fs::read_dir(units)?.enumerate() {
        if index >= 4096 {
            bail!("native unit inventory is too large; explicit review is required");
        }
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("nelcota-") || !name.ends_with(".service") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_file() || metadata.len() > 65536 {
            bail!("unsafe native unit inventory");
        }
        let mut unit = String::new();
        fs::File::open(entry.path())?
            .take(65537)
            .read_to_string(&mut unit)?;
        if unit.len() > 65536 {
            bail!("native unit exceeded its size limit");
        }
        let helper = match name.as_ref() {
            "nelcota-updates-worker.service" => {
                Some("[Unit]\nDescription=Nelcota restricted deployment worker\n")
            }
            "nelcota-updates-controller.service" => {
                Some("[Unit]\nDescription=Nelcota unprivileged updates controller\n")
            }
            _ => None,
        };
        if helper.is_some_and(|header| unit.starts_with(header)) {
            continue;
        }
        let (expected_name, environment, header) = expected
            .as_ref()
            .context("another native installation already exists; use its host directory")?;
        if name.as_ref() != expected_name {
            bail!("existing native unit does not belong to this host");
        }
        let environments: Vec<_> = unit
            .lines()
            .filter_map(|line| line.strip_prefix("EnvironmentFile="))
            .collect();
        if !unit.starts_with(header)
            || environments.len() != 1
            || !Path::new(environments[0]).is_absolute()
            || Path::new(environments[0]).canonicalize()? != environment.canonicalize()?
        {
            bail!("existing native unit ownership is ambiguous; explicit recovery is required");
        }
        count += 1;
    }
    if count == 0 && postgres_config.try_exists()? {
        bail!("unclaimed native PostgreSQL configuration exists; explicit recovery is required");
    }
    Ok(())
}

pub(crate) fn acquire(host: &Host) -> anyhow::Result<MachineLease> {
    let state = Path::new(STATE);
    // The production state has no environment/path override. Its parents must
    // not allow an unprivileged process to replace the machine-wide lease.
    for parent in state
        .parent()
        .context("missing native state parent")?
        .ancestors()
    {
        let metadata = fs::symlink_metadata(parent)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("unsafe native ownership directory");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
                bail!("native ownership directory must be root-owned without writable parents");
            }
        }
    }
    if let Ok(metadata) = fs::symlink_metadata(state) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != 0 || metadata.mode() & 0o077 != 0 {
                bail!("native ownership directory must be private and root-owned");
            }
        }
        #[cfg(not(unix))]
        let _ = metadata;
    }
    MachineLease::acquire_at(state, host.root(), || {
        inspect_legacy(
            host,
            Path::new("/etc/systemd/system"),
            Path::new(POSTGRES_CONFIG),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializations_share_one_machine_lease_and_keep_a_durable_owner() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().join("state");
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        let lease = MachineLease::acquire_at(&state, &first, || Ok(())).unwrap();
        assert!(!first.exists());
        let busy =
            MachineLease::acquire_at(&state, &first, || panic!("must not enter while leased"))
                .err()
                .unwrap();
        assert!(format!("{busy:#}").contains("deployment_busy"));
        assert!(
            MachineLease::acquire_at(&state, &second, || panic!("must hold the lease first"))
                .is_err()
        );
        drop(lease);
        let error =
            MachineLease::acquire_at(&state, &second, || panic!("must not inspect another owner"))
                .err()
                .unwrap();
        assert!(error.to_string().contains("another host directory"));
        assert!(!second.exists());
        let lease = MachineLease::acquire_at(&state, &first, || {
            panic!("same owner survives interruption")
        })
        .unwrap();
        lease.release().unwrap();
        assert!(state.join(".deployment.lock").is_file());
        assert!(!state.join(OWNER).exists());
        MachineLease::acquire_at(&state, &second, || Ok(())).unwrap();
    }

    #[test]
    fn legacy_rejection_cannot_publish_an_owner() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().join("state");
        assert!(
            MachineLease::acquire_at(&state, &temporary.path().join("host"), || {
                bail!("unrelated native installation")
            })
            .is_err()
        );
        assert!(!state.join(OWNER).exists());
    }

    #[test]
    fn malformed_or_replaced_ownership_never_grants_a_lease_or_release() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().join("state");
        let root = temporary.path().join("host");
        let lease = MachineLease::acquire_at(&state, &root, || Ok(())).unwrap();
        atomic_write(&state.join(OWNER), b"{}").unwrap();
        assert!(lease.release().is_err());
        assert!(state.join(OWNER).exists());
        for value in [
            b"{}".as_slice(),
            br#"{"schema":2,"root":"/unrelated"}"#,
            br#"{"schema":1,"root":"relative"}"#,
            br#"{"schema":1,"root":"/unrelated","unknown":true}"#,
        ] {
            atomic_write(&state.join(OWNER), value).unwrap();
            assert!(
                MachineLease::acquire_at(&state, &root, || panic!("invalid owner is not absent"))
                    .is_err()
            );
        }
        atomic_write(&state.join(OWNER), &vec![b'x'; 16385]).unwrap();
        assert!(
            MachineLease::acquire_at(&state, &root, || panic!("oversized owner is not absent"))
                .is_err()
        );
    }

    #[test]
    fn competing_first_claims_are_excluded_before_the_owner_is_published() {
        use std::sync::{Arc, Barrier};
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().join("state");
        let entered = Arc::new(Barrier::new(2));
        let complete = Arc::new(Barrier::new(2));
        let worker = {
            let state = state.clone();
            let root = temporary.path().join("first");
            let entered = entered.clone();
            let complete = complete.clone();
            std::thread::spawn(move || {
                MachineLease::acquire_at(&state, &root, || {
                    entered.wait();
                    complete.wait();
                    Ok(())
                })
            })
        };
        entered.wait();
        let unpublished = !state.join(OWNER).exists();
        let competitor =
            MachineLease::acquire_at(&state, &temporary.path().join("second"), || Ok(()));
        complete.wait();
        let lease = worker.join().unwrap().unwrap();
        assert!(unpublished);
        let error = competitor
            .err()
            .expect("concurrent first init must be refused");
        assert!(format!("{error:#}").contains("deployment_busy"));
        lease.release().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn aliases_match_but_ownership_and_state_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("host");
        fs::create_dir(&root).unwrap();
        let alias = temporary.path().join("alias");
        symlink(&root, &alias).unwrap();
        let state = temporary.path().join("state");
        drop(MachineLease::acquire_at(&state, &root, || Ok(())).unwrap());
        drop(
            MachineLease::acquire_at(&state, &alias, || {
                panic!("alias must identify the same owner")
            })
            .unwrap(),
        );
        let saved = temporary.path().join("saved-owner");
        fs::rename(state.join(OWNER), &saved).unwrap();
        symlink(&saved, state.join(OWNER)).unwrap();
        assert!(MachineLease::acquire_at(&state, &root, || panic!("must reject symlink")).is_err());
        assert!(saved.is_file());
        let linked_state = temporary.path().join("linked-state");
        symlink(&state, &linked_state).unwrap();
        assert!(MachineLease::acquire_at(&linked_state, &root, || Ok(())).is_err());
    }

    #[test]
    fn legacy_units_need_matching_absolute_environment_ownership() {
        use crate::host::{Manifest, PanelLogin, ProjectEntry};
        let temporary = tempfile::tempdir().unwrap();
        let host = Host::new(&temporary.path().join("host"));
        let units = temporary.path().join("units");
        fs::create_dir(&units).unwrap();
        let config = temporary.path().join("postgres.conf");
        fs::write(&config, "owned fixture").unwrap();
        assert!(inspect_legacy(&host, &units, &config).is_err());
        host.save(&Manifest {
            version: 1,
            panel_login: PanelLogin::Shared,
            base_domain: None,
            local: true,
            runtime: Runtime::Systemd,
            image: String::new(),
            projects: vec![ProjectEntry {
                name: "shop".into(),
                domain: "shop.localhost".into(),
            }],
        })
        .unwrap();
        let env = host.project_dir("shop").join(".env");
        fs::create_dir_all(env.parent().unwrap()).unwrap();
        fs::write(&env, "owned fixture").unwrap();
        let unit = units.join("nelcota-shop.service");
        fs::write(&unit, super::super::units::render_unit("shop", &env)).unwrap();
        inspect_legacy(&host, &units, &config).unwrap();
        fs::write(
            &unit,
            super::super::units::render_unit("shop", Path::new("./projects/shop/.env")),
        )
        .unwrap();
        assert!(inspect_legacy(&host, &units, &config).is_err());
        fs::write(&unit, super::super::units::render_unit("shop", &env)).unwrap();
        fs::write(units.join("nelcota-other.service"), "unrelated unit").unwrap();
        assert!(inspect_legacy(&host, &units, &config).is_err());
    }
}
