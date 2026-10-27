use super::{
    CONTROLLER, CONTROLLER_BIN_DIR, HTTP_SOCKET, POLICY, WORKER_SOCKET,
    policy::{Operator, Policy},
};
use anyhow::{Context, bail};
use nelcota_deployment::{atomic_write, private_dir, protocol::ControllerConfig, read_private};
use std::{fs, path::Path, process::Command};

pub fn descriptor(root: &Path) -> anyhow::Result<Option<ControllerConfig>> {
    let path = root.join("updates-controller.json");
    if !path.exists() {
        return Ok(None);
    }
    let config: ControllerConfig = serde_json::from_slice(&read_private(&path, 16384)?)?;
    validate_origin(&config.origin)?;
    if config.schema != 1
        || config.http_socket != Path::new(HTTP_SOCKET)
        || config.worker_socket != Path::new(WORKER_SOCKET)
    {
        bail!("invalid controller descriptor");
    }
    Ok(Some(config))
}
pub fn validate_origin(origin: &str) -> anyhow::Result<()> {
    let url = url::Url::parse(origin)?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != origin
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none_or(|host| {
            host.parse::<std::net::IpAddr>().is_ok()
                || host.ends_with(".localhost")
                || !host.contains('.')
        })
    {
        bail!("use a dedicated public HTTPS hostname");
    }
    Ok(())
}
/// Same syntax rules as the SMTP test that later mails this address. The value
/// is stored as typed because operator login compares it exactly.
fn validate_operator_email(email: &str) -> anyhow::Result<()> {
    if email.trim() != email || nelcota_auth::normalize_email(email).is_err() {
        bail!("invalid operator email");
    }
    Ok(())
}
fn command(program: &str, args: &[&str]) -> anyhow::Result<()> {
    if !Command::new(program).args(args).status()?.success() {
        bail!("{program} failed");
    }
    Ok(())
}
fn id(flag: &str, user: &str) -> anyhow::Result<u32> {
    let output = Command::new("id").args([flag, user]).output()?;
    if !output.status.success() {
        bail!("controller account unavailable");
    }
    Ok(String::from_utf8(output.stdout)?.trim().parse()?)
}
pub fn run(
    root: &Path,
    origin: &str,
    email: &str,
    password_file: &Path,
    verifier: &Path,
    projects: &[String],
    host_management: Option<&Path>,
) -> anyhow::Result<()> {
    validate_origin(origin)?;
    let root = root.canonicalize()?;
    super::policy::trusted_path(&root)?;
    super::policy::trusted_state(&root.join("updates"))?;
    if root
        .to_string_lossy()
        .bytes()
        .any(|c| !c.is_ascii_alphanumeric() && !b"/._-".contains(&c))
    {
        bail!("host path must not need shell or systemd escaping");
    }
    let lease = nelcota_deployment::HostLock::acquire(&root)?;
    let host = crate::host::Host::new(&root);
    let manifest = host.require()?;
    let management = match host_management {
        Some(path) => {
            super::policy::trusted_path(path)?;
            let value: super::policy::Provisioning =
                serde_json::from_slice(&read_private(path, 16384)?)?;
            super::management::validate_policy(&value)?;
            if manifest.runtime != crate::host::Runtime::Docker {
                bail!("multi-project provisioning requires Docker");
            }
            Some(value)
        }
        None => None,
    };
    if Path::new(POLICY).exists() || descriptor(&root)?.is_some() {
        bail!(
            "host already enrolled; change the root-owned policy over SSH and restart the worker"
        );
    }
    if manifest.local
        || manifest.image != "ghcr.io/nelcota/nelcota-server"
        || manifest.projects.iter().any(|p| origin == p.url())
    {
        bail!("enrollment needs an official-image host and a separate public origin");
    }
    if projects
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != projects.len()
    {
        bail!("duplicate project scope");
    }
    if projects.is_empty()
        || projects.len() > 32
        || projects.iter().any(|name| {
            !nelcota_deployment::valid_project(name) || host.select(&manifest, Some(name)).is_err()
        })
    {
        bail!("unknown deployment scope");
    }
    validate_operator_email(email)?;
    let password = String::from_utf8(read_private(password_file, 1024)?)?;
    let password = password.trim_end_matches(['\r', '\n']);
    if password.len() < 16 {
        bail!("operator password needs at least 16 characters");
    }
    let verifier = verifier.canonicalize()?;
    super::releases::trusted_verifier(&verifier)?;
    let output = Command::new(&verifier)
        .args(["attestation", "verify", "--help"])
        .output()?;
    if !output.status.success()
        || !String::from_utf8_lossy(&output.stdout).contains("--source-digest")
    {
        bail!("native GitHub CLI lacks attestation verification");
    }
    // Reject modified compose files rather than silently replace an operator's layout.
    super::policy::trusted_path(&host.shared_dir())?;
    if manifest.runtime == crate::host::Runtime::Systemd {
        for project in host.projects(&manifest) {
            if !native_unit_enrolled(&project) {
                bail!("custom native unit requires reviewed enrollment");
            }
        }
    }
    for project in host.projects(&manifest) {
        super::policy::trusted_path(&project.path(".env"))?;
    }
    if manifest.runtime == crate::host::Runtime::Docker {
        for project in host.projects(&manifest) {
            let path = project.path("docker-compose.yml");
            let text = fs::read_to_string(&path)?;
            super::policy::trusted_path(&path)?;
            if !known_project_compose(&project, &text) {
                bail!("custom compose requires manual reviewed enrollment");
            }
        }
        let text = fs::read_to_string(host.caddy_dir().join("docker-compose.yml"))?;
        super::policy::trusted_path(&host.caddy_dir().join("docker-compose.yml"))?;
        super::policy::trusted_path(&host.caddy_dir().join("config"))?;
        if text != include_str!("../../../../deploy/caddy-compose.yml") {
            bail!("custom proxy compose requires manual enrollment");
        }
    }
    if Command::new("id")
        .arg("nelcota-updates")
        .output()?
        .status
        .success()
    {
        bail!("deployment account already exists; inspect it before enrollment");
    }
    command(
        "useradd",
        &[
            "--system",
            "--user-group",
            "--no-create-home",
            "--shell",
            "/usr/sbin/nologin",
            "nelcota-updates",
        ],
    )?;
    let uid = id("-u", "nelcota-updates")?;
    let gid = id("-g", "nelcota-updates")?;
    let conf = Path::new("/etc/nelcota-updates");
    fs::create_dir_all(conf)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(conf, fs::Permissions::from_mode(0o755))?;
    }
    let bin = Path::new(CONTROLLER_BIN_DIR);
    fs::create_dir_all(bin)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(bin, fs::Permissions::from_mode(0o755))?;
    }
    crate::private_fs::copy(std::env::current_exe()?, bin.join("nelcota"))?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(bin.join("nelcota"), fs::Permissions::from_mode(0o755))?;
    crate::private_fs::copy(&verifier, bin.join("gh"))?;
    fs::set_permissions(bin.join("gh"), fs::Permissions::from_mode(0o755))?;
    let mut project_ids = std::collections::BTreeMap::new();
    for name in projects {
        let id = nelcota_deployment::token()?;
        atomic_write(
            &host.project_dir(name).join(".deployment-project-id"),
            id.as_bytes(),
        )?;
        project_ids.insert(name.clone(), id);
    }
    let policy = Policy {
        host_management: management.clone(),
        schema: 1,
        root: root.clone(),
        origin: origin.into(),
        controller_uid: uid,
        controller_gid: gid,
        verifier: bin.join("gh"),
        operators: vec![Operator {
            manage_host: management.is_some(),
            email: email.into(),
            password_hash: nelcota_auth::hash_password(password)
                .context("password hashing failed")?,
            projects: projects.to_vec(),
        }],
        project_ids,
        enable_installation: false,
        validation_report: None,
        minimum_free_bytes: 2 * 1024 * 1024 * 1024,
        timeout_seconds: 3600,
    };
    atomic_write(Path::new(POLICY), &serde_json::to_vec_pretty(&policy)?)?;
    let config = ControllerConfig {
        schema: 1,
        origin: origin.into(),
        worker_socket: WORKER_SOCKET.into(),
        http_socket: HTTP_SOCKET.into(),
    };
    atomic_write(Path::new(CONTROLLER), &serde_json::to_vec(&config)?)?;
    fs::set_permissions(CONTROLLER, fs::Permissions::from_mode(0o644))?;
    private_dir(&root.join("updates"))?;
    atomic_write(
        &root.join("updates-controller.json"),
        &serde_json::to_vec(&config)?,
    )?;
    if manifest.runtime == crate::host::Runtime::Systemd {
        let base = Path::new("/var/lib/nelcota-deployment-gates");
        fs::create_dir_all(base)?;
        super::policy::trusted_path(base)?;
        fs::set_permissions(base, fs::Permissions::from_mode(0o755))?;
    }
    for project in host.projects(&manifest) {
        let control = super::runtime::gate_path(&project)?
            .parent()
            .context("missing gate directory")?
            .to_path_buf();
        fs::create_dir_all(&control)?;
        fs::set_permissions(control, fs::Permissions::from_mode(0o755))?;
        if manifest.runtime == crate::host::Runtime::Docker {
            let path = project.path("docker-compose.yml");
            let text = fs::read_to_string(&path)?.replace(
                "    image: ${NELCOTA_IMAGE}:${NELCOTA_VERSION}",
                "    image: ${NELCOTA_APP_IMAGE:-${NELCOTA_IMAGE}:${NELCOTA_VERSION}}",
            );
            let text=match text.contains("./deployment-control:/run/nelcota-deployment:ro") {true=>text,false=>text.replace("      - ./migrations:/migrations:ro","      - ./migrations:/migrations:ro\n      - ./deployment-control:/run/nelcota-deployment:ro")};
            atomic_write(&path, text.as_bytes())?;
        }
    }
    if manifest.runtime == crate::host::Runtime::Docker {
        let path = host.caddy_dir().join("docker-compose.yml");
        let text=fs::read_to_string(&path)?.replace("      - ./config:/etc/caddy:ro","      - ./config:/etc/caddy:ro\n      - /run/nelcota-updates-http:/run/nelcota-updates-http:ro");
        atomic_write(&path, text.as_bytes())?;
    }
    fs::write(
        "/etc/systemd/system/nelcota-updates-worker.service",
        worker_unit(),
    )?;
    fs::write(
        "/etc/systemd/system/nelcota-updates-controller.service",
        controller_unit(),
    )?;
    command("systemctl", &["daemon-reload"])?;
    command(
        "systemctl",
        &[
            "enable",
            "--now",
            "nelcota-updates-worker",
            "nelcota-updates-controller",
        ],
    )?;
    crate::registry::write(&host, &manifest)?;
    crate::caddy::write(&host, &manifest)?;
    if manifest.runtime == crate::host::Runtime::Docker {
        crate::project::run(
            crate::project::compose_command(&host.caddy_dir()).args(["up", "-d", "caddy"]),
            "proxy enrollment",
        )?;
    }
    if manifest.runtime == crate::host::Runtime::Systemd {
        command("usermod", &["-a", "-G", "nelcota-updates", "caddy"])?;
        command("systemctl", &["restart", "caddy"])?;
    }
    crate::caddy::reload(&host, manifest.runtime)?;
    drop(lease);
    println!(
        "Controller enrolled at {origin}/admin/. Installation is disabled until the documented staging validation passes."
    );
    Ok(())
}
fn worker_unit() -> &'static str {
    "[Unit]\nDescription=Nelcota restricted deployment worker\nAfter=network-online.target\n[Service]\nExecStart=/usr/local/lib/nelcota-updates/nelcota updates worker\nUser=root\nGroup=nelcota-updates\nRuntimeDirectory=nelcota-updates-worker\nRuntimeDirectoryMode=0750\nUMask=0077\nKillMode=control-group\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\nProtectHome=yes\n[Install]\nWantedBy=multi-user.target\n"
}
fn controller_unit() -> &'static str {
    "[Unit]\nDescription=Nelcota unprivileged updates controller\nAfter=nelcota-updates-worker.service\nRequires=nelcota-updates-worker.service\n[Service]\nExecStart=/usr/local/lib/nelcota-updates/nelcota updates serve\nUser=nelcota-updates\nGroup=nelcota-updates\nRuntimeDirectory=nelcota-updates-http\nRuntimeDirectoryMode=0755\nUMask=0007\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nCapabilityBoundingSet=\nRestrictAddressFamilies=AF_UNIX\nReadWritePaths=/run/nelcota-updates-http\n[Install]\nWantedBy=multi-user.target\n"
}

pub(super) fn native_unit_enrolled(project: &crate::project::Project) -> bool {
    let path = crate::native::unit_path(&project.name);
    if super::policy::trusted_path(&path).is_err() {
        return false;
    }
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return false,
    };
    let properties = match super::probes::output(Command::new("systemctl").args([
        "show",
        &crate::native::app_unit(&project.name),
        "--property=DropInPaths",
        "--property=NeedDaemonReload",
    ])) {
        Ok(properties) => properties,
        Err(_) => return false,
    };
    known_native_unit(project, &text, &properties)
}

fn known_native_unit(project: &crate::project::Project, text: &str, properties: &str) -> bool {
    let lines: Vec<_> = properties.lines().collect();
    text == crate::native::render_unit(&project.name, &project.path(".env"))
        && lines.len() == 2
        && lines.contains(&"DropInPaths=")
        && lines.contains(&"NeedDaemonReload=no")
}

pub(super) fn known_project_compose(project: &crate::project::Project, text: &str) -> bool {
    if !text.starts_with(&format!(
        "# Project \"{}\". Generated by `nelcota init` at ",
        project.name
    )) {
        return false;
    }
    let profile = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("# Profile: "))
        .and_then(|line| line.split_whitespace().next());
    let profile = match profile {
        Some(profile) if ["1gb", "2gb", "4gb", "8gb"].contains(&profile) => profile,
        _ => return false,
    };
    let expected = crate::scaffold::render_compose(&project.name, profile);
    let normalized = text
        .replace(
            "${NELCOTA_APP_IMAGE:-${NELCOTA_IMAGE}:${NELCOTA_VERSION}}",
            "${NELCOTA_IMAGE}:${NELCOTA_VERSION}",
        )
        .replace(
            "      - ./deployment-control:/run/nelcota-deployment:ro\n",
            "",
        );
    normalized.lines().skip(1).eq(expected.lines().skip(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enrollment_rejects_noncanonical_or_injectable_origins() {
        for origin in [
            "http://updates.example.test",
            "https://127.0.0.1",
            "https://user@updates.example.test",
            "https://updates.example.test/path",
            "https://updates.example.test:8443",
            "https://updates.example.test\nrespond hacked",
        ] {
            assert!(validate_origin(origin).is_err());
        }
        assert!(validate_origin("https://updates.example.test").is_ok());
    }
    #[test]
    fn enrollment_accepts_only_emails_the_smtp_test_can_use() {
        for email in [
            "",
            "@",
            "operator",
            "operator@",
            "@example.test",
            "operator@localhost",
            "operator@@example.test",
            "op erator@example.test",
            " operator@example.test",
            "operator@example.test\n",
            "operator@-example.test",
            "operator..x@example.test",
        ] {
            assert!(validate_operator_email(email).is_err(), "{email:?}");
        }
        for email in ["operator@example.test", "Ops.Team+alerts@Example.test"] {
            assert!(validate_operator_email(email).is_ok(), "{email}");
        }
    }
    #[test]
    fn project_layout_enrollment_rejects_extra_commands_and_storage_mounts() {
        let project = crate::project::Project::new(
            "shop",
            Path::new("/host/projects/shop"),
            crate::host::Runtime::Docker,
        );
        let original = crate::scaffold::render_compose("shop", "2gb");
        assert!(known_project_compose(&project, &original));
        let enrolled=original.replace("${NELCOTA_IMAGE}:${NELCOTA_VERSION}","${NELCOTA_APP_IMAGE:-${NELCOTA_IMAGE}:${NELCOTA_VERSION}}").replace("      - ./migrations:/migrations:ro","      - ./migrations:/migrations:ro\n      - ./deployment-control:/run/nelcota-deployment:ro");
        assert!(known_project_compose(&project, &enrolled));
        assert!(!known_project_compose(
            &project,
            &original.replace(
                "      - ./storage:/storage",
                "      - /another-project:/storage"
            )
        ));
        assert!(!known_project_compose(
            &project,
            &original.replace(
                "    env_file: .env",
                "    env_file: .env\n    command: arbitrary"
            )
        ));
    }
    #[test]
    fn native_enrollment_rejects_database_overrides_drop_ins_and_stale_loaded_units() {
        let project = crate::project::Project::new(
            "shop",
            Path::new("/host/projects/shop"),
            crate::host::Runtime::Systemd,
        );
        let unit = crate::native::render_unit(&project.name, &project.path(".env"));
        let properties = "DropInPaths=\nNeedDaemonReload=no\n";
        assert!(known_native_unit(&project, &unit, properties));
        assert!(!known_native_unit(
            &project,
            &unit.replace(
                "Restart=on-failure",
                "Environment=NELCOTA_DATABASE_URL=postgres://other-project\nRestart=on-failure"
            ),
            properties,
        ));
        for properties in [
            "DropInPaths=/etc/systemd/system/nelcota-shop.service.d/database.conf\nNeedDaemonReload=no\n",
            "DropInPaths=\nNeedDaemonReload=yes\n",
            "DropInPaths=\n",
            "NeedDaemonReload=no\nNeedDaemonReload=no\n",
        ] {
            assert!(!known_native_unit(&project, &unit, properties));
        }
    }
    #[test]
    fn service_roles_have_distinct_authority_and_keep_subprocesses_in_their_cgroup() {
        assert!(worker_unit().contains("User=root"));
        assert!(worker_unit().contains("KillMode=control-group"));
        assert!(controller_unit().contains("User=nelcota-updates"));
        assert!(controller_unit().contains("ProtectSystem=strict"));
        assert!(controller_unit().contains("CapabilityBoundingSet=\n"));
        assert!(!controller_unit().contains("docker.sock"));
    }
}
