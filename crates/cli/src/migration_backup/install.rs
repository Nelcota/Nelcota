//! Explicit host installation; project credentials never install or configure services.
use super::*;
#[cfg(any(target_os = "linux", test))]
use crate::host::Runtime;
use sha2::{Digest, Sha256};

pub(crate) fn socket_dir(project: &Project) -> PathBuf {
    let identity = fs::canonicalize(&project.dir).unwrap_or_else(|_| project.dir.clone());
    let digest =
        base16ct::lower::encode_string(&Sha256::digest(identity.as_os_str().as_encoded_bytes()));
    PathBuf::from(format!("/run/nelcota-migration-backup-{}", &digest[..24]))
}
#[cfg(any(target_os = "linux", test))]
pub(crate) fn mount(project: &Project) -> String {
    format!(
        "      - {}:/run/nelcota-migration-backup:ro\n",
        socket_dir(project).display()
    )
}
#[cfg(any(target_os = "linux", test))]
fn argument(value: &Path) -> anyhow::Result<String> {
    let value = value.to_str().context("service paths must be UTF-8")?;
    if value.contains(['\n', '\r', '\0']) {
        bail!("invalid service path");
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    ))
}
fn service(project: &Project) -> String {
    format!(
        "{}.service",
        socket_dir(project)
            .file_name()
            .expect("runtime directory")
            .to_string_lossy()
    )
}
#[cfg(any(target_os = "linux", test))]
fn unit(host: &Host, project: &Project, binary: &Path) -> anyhow::Result<String> {
    let directory = socket_dir(project);
    Ok(format!(
        "[Unit]\nDescription=Nelcota project migration backup agent\nAfter=network-online.target\n[Service]\nExecStart={} -C {} -p {} migration-backup serve --socket {}\nUser=root\nGroup=root\nRuntimeDirectory={}\nRuntimeDirectoryMode=0755\nRuntimeDirectoryPreserve=yes\nUMask=0077\nKillMode=control-group\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\nProtectSystem=strict\nReadWritePaths={}\nProtectHome=yes\nPrivateTmp=yes\n[Install]\nWantedBy=multi-user.target\n",
        argument(binary)?,
        argument(host.root())?,
        project.name,
        argument(&directory.join("agent.sock"))?,
        directory.file_name().unwrap().to_string_lossy(),
        // ReadWritePaths expands specifiers, but not ExecStart's environment variables.
        argument(host.root())?.replace("$$", "$")
    ))
}
#[cfg(target_os = "linux")]
pub(super) fn enable(host: &Host, project: &Project) -> anyhow::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::process::Command;
    let uid = Command::new("id").arg("-u").output()?;
    if !uid.status.success() || uid.stdout != b"0\n" {
        bail!("install the migration backup agent as root on its host");
    }
    let binary = Path::new("/usr/local/lib/nelcota-migration-backup/nelcota");
    // Privileged service inputs must not traverse writable/symlinked ancestors.
    for path in [
        host.root().to_path_buf(),
        project.path(".env"),
        std::env::current_exe()?,
        PathBuf::from("/usr/local/lib"),
        PathBuf::from("/etc/systemd/system"),
    ] {
        for ancestor in path.ancestors() {
            let meta = fs::symlink_metadata(ancestor)?;
            if meta.uid() != 0 || meta.mode() & 0o022 != 0 || meta.file_type().is_symlink() {
                bail!("backup installation requires root-owned paths without writable ancestors");
            }
        }
    }
    let _lease = crate::host::acquire_mutation_lease(host.root())?;
    project
        .in_app(&["migration-backup", "check-support"])
        .context("upgrade the project server before enabling automatic migration backups")?;
    let directory = binary.parent().unwrap();
    if fs::symlink_metadata(directory)
        .is_ok_and(|meta| !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0)
    {
        bail!("unsafe migration backup binary directory");
    }
    crate::private_fs::dir(directory)?;
    read_private(&project.path(".env"), 65536)?;
    let compose = match project.runtime {
        Runtime::Docker => {
            let metadata = fs::symlink_metadata(project.path("docker-compose.yml"))?;
            if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 || !metadata.is_file() {
                bail!("unsafe project Compose file");
            }
            let text = fs::read_to_string(project.path("docker-compose.yml"))?;
            if !crate::scaffold::known_compose(project, &text) {
                bail!("custom Compose requires an explicitly reviewed backup socket mount");
            }
            Some(text)
        }
        Runtime::Systemd => None,
    };
    let directory = socket_dir(project);
    let name = service(project);
    let unit_path = Path::new("/etc/systemd/system").join(&name);
    if fs::symlink_metadata(&unit_path)
        .is_ok_and(|meta| !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o022 != 0)
        || unit_path.exists()
            && !fs::read_to_string(&unit_path)?
                .starts_with("[Unit]\nDescription=Nelcota project migration backup agent\n")
    {
        bail!("migration backup service name is already owned");
    }
    let temporary = binary.with_extension("new");
    crate::private_fs::copy(std::env::current_exe()?, &temporary)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))?;
    fs::rename(temporary, binary)?;
    fs::File::open(binary.parent().unwrap())?.sync_all()?;
    // These values carry only the fixed project's backup capability. No root
    // credentials, host paths or command parameters are exported to its app.
    let token = project
        .env()
        .get("NELCOTA_MIGRATION_BACKUP_TOKEN")?
        .filter(|token| valid_token(token))
        .unwrap_or(nelcota_deployment::token()?);
    project
        .env()
        .set("NELCOTA_MIGRATION_BACKUP_TOKEN", &token)?;
    let app_socket = match project.runtime {
        Runtime::Docker => PathBuf::from("/run/nelcota-migration-backup/agent.sock"),
        Runtime::Systemd => directory.join("agent.sock"),
    };
    project.env().set(
        "NELCOTA_MIGRATION_BACKUP_SOCKET",
        app_socket.to_str().context("invalid socket")?,
    )?;
    if let Some(text) = compose {
        let mount = mount(project);
        if !text.contains(&mount) {
            atomic_write(
                &project.path("docker-compose.yml"),
                text.replace(
                    "    volumes:\n      - ./migrations",
                    &format!("    volumes:\n{mount}      - ./migrations"),
                )
                .as_bytes(),
            )?;
        }
    }
    atomic_write(&unit_path, unit(host, project, binary)?.as_bytes())?;
    crate::native::systemctl(&["daemon-reload".into()])?;
    crate::native::systemctl(&["enable".into(), "--now".into(), name.clone()])?;
    // An existing process needs to reload a changed binary/configuration too.
    crate::native::systemctl(&["restart".into(), name])?;
    let ready = std::time::Instant::now() + Duration::from_secs(5);
    while !directory.join("agent.sock").exists() && std::time::Instant::now() < ready {
        std::thread::sleep(Duration::from_millis(50));
    }
    if !directory.join("agent.sock").exists() {
        bail!("backup agent is not ready; inspect its journal before restarting the app");
    }
    project.recreate(crate::project::Service::App)?;
    crate::util::ok(
        "automatic migration backups enabled; set NELCOTA_PRODUCTION=true to require this capability on production writes",
    );
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub(super) fn enable(_host: &Host, _project: &Project) -> anyhow::Result<()> {
    bail!("automatic backup service installation requires a Linux host");
}

/// Retire only this project's installed helper before project deletion.
pub(crate) fn remove(project: &Project) -> anyhow::Result<()> {
    if project
        .env()
        .get("NELCOTA_MIGRATION_BACKUP_TOKEN")?
        .is_none()
    {
        return Ok(());
    }
    let name = service(project);
    let path = Path::new("/etc/systemd/system").join(&name);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_file() => bail!("unsafe migration backup service"),
        Ok(_) => {}
    }
    if !fs::read_to_string(&path)?
        .starts_with("[Unit]\nDescription=Nelcota project migration backup agent\n")
    {
        bail!("migration backup service name is already owned");
    }
    crate::native::systemctl(&["disable".into(), "--now".into(), name])?;
    fs::remove_file(&path)?;
    // Preserve this directory across daemon restarts so an app's read-only
    // directory mount sees the replacement socket. Retire it only on removal.
    let directory = socket_dir(project);
    if let Ok(metadata) = fs::symlink_metadata(&directory) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("unsafe migration backup runtime directory");
        }
        fs::remove_dir_all(directory)?;
    }
    crate::native::systemctl(&["daemon-reload".into()])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_binds_a_project_and_never_places_a_token_in_the_unit() {
        let host = Host::new(Path::new("/opt/host with spaces"));
        let project = Project::new("shop", &host.project_dir("shop"), Runtime::Docker);
        let text = unit(&host, &project, Path::new("/usr/local/bin/nelcota")).unwrap();
        assert!(text.contains("-C \"/opt/host with spaces\" -p shop migration-backup serve"));
        assert!(text.contains("KillMode=control-group"));
        assert!(
            text.contains("RuntimeDirectoryPreserve=yes"),
            "socket directory mounts must survive agent restarts"
        );
        assert!(!text.contains("TOKEN"));
        assert_ne!(
            socket_dir(&project),
            socket_dir(&Project::new(
                "shop",
                Path::new("/opt/other/projects/shop"),
                Runtime::Docker
            ))
        );
        let rendered = crate::scaffold::render_compose("shop", "1gb");
        let mounted = rendered.replace(
            "    volumes:\n      - ./migrations",
            &format!("    volumes:\n{}      - ./migrations", mount(&project)),
        );
        assert!(crate::scaffold::known_compose(&project, &mounted));
        assert!(!crate::scaffold::known_compose(
            &project,
            &mounted.replace(":ro", ":rw")
        ));
    }
}
