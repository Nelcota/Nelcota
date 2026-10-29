//! Project identity and readiness checks before reopening traffic.
use super::artifacts::write_gate;
use crate::host::Runtime;
use crate::native;
use crate::project::Project;
use crate::updates::probes;
use anyhow::Context;
use anyhow::bail;
use nelcota_deployment::Job;
use nelcota_deployment::digest_file;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub(super) fn health(project: &Project) -> Option<String> {
    match project.runtime {
        Runtime::Docker => {
            let id = probes::output(project.compose_command().args(["ps", "-q", "app"])).ok()?;
            let id = id.trim();
            if id.is_empty() || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            Some(
                probes::output(Command::new("docker").args([
                    "inspect",
                    "--format",
                    "{{.State.Health.Status}}",
                    id,
                ]))
                .ok()?
                .trim()
                .into(),
            )
        }
        Runtime::Systemd => {
            if probes::output(
                Command::new("systemctl").args(["is-active", &native::app_unit(&project.name)]),
            )
            .ok()?
            .trim()
                != "active"
            {
                return None;
            }
            if crate::util::healthcheck(native::APP_LISTEN) {
                return Some("healthy".into());
            }
            None
        }
    }
}

pub(super) fn validate_identity(project: &Project, job: &Job) -> anyhow::Result<()> {
    validate_binary_identity(
        project,
        job.target_image.as_deref(),
        job.target_binary_sha256.as_deref(),
    )?;
    if project.runtime == Runtime::Docker {
        let output = project
            .compose_command()
            .args(["exec", "-T", "app", "/usr/local/bin/nelcota", "--version"])
            .output()?;
        if !output.status.success()
            || String::from_utf8_lossy(&output.stdout).trim()
                != format!("nelcota {}", job.public.target)
        {
            bail!("candidate identity mismatch");
        }
    }
    if project.runtime == Runtime::Systemd {
        let output = Command::new(native::deployed_binary())
            .arg("--version")
            .output()?;
        if !output.status.success()
            || String::from_utf8_lossy(&output.stdout).trim()
                != format!("nelcota {}", job.public.target)
        {
            bail!("candidate identity mismatch");
        }
    }
    let output = project
        .as_postgres(&[
            "psql",
            "-X",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "SELECT coalesce(max(version),0) FROM nelcota.schema_migrations",
        ])
        .output()?;
    if !output.status.success()
        || String::from_utf8_lossy(&output.stdout).trim() != job.migration_version.to_string()
    {
        bail!("migration validation failed");
    }
    Ok(())
}
pub(super) fn validate_previous(project: &Project, job: &Job, dir: &Path) -> anyhow::Result<()> {
    let expected = job
        .previous_config_sha256
        .as_deref()
        .context("missing config identity")?;
    if digest_file(&dir.join("previous.env"), 65536)? != expected {
        bail!("previous configuration corrupt");
    }
    if job.previous_image.is_none() && digest_file(&project.path(".env"), 65536)? != expected {
        bail!("restored configuration mismatch");
    }
    if let Some(image) = &job.previous_image
        && project.env().get("NELCOTA_APP_IMAGE")?.as_deref() != Some(image.as_str())
    {
        bail!("restored configuration mismatch");
    }
    validate_binary_identity(
        project,
        job.previous_image.as_deref(),
        job.previous_binary.as_deref(),
    )?;
    Ok(())
}
pub(super) fn validate_binary_identity(
    project: &Project,
    image: Option<&str>,
    binary: Option<&str>,
) -> anyhow::Result<()> {
    match project.runtime {
        Runtime::Systemd => {
            let unit = native::app_unit(&project.name);
            let pid = probes::output(Command::new("systemctl").args([
                "show",
                "--property=MainPID",
                "--value",
                &unit,
            ]))?
            .trim()
            .parse::<u32>()?;
            if pid == 0 {
                bail!("native application is not running");
            }
            validate_running_binary(
                &native::deployed_binary(),
                Path::new(&format!("/proc/{pid}/exe")),
                binary.context("missing binary identity")?,
            )?;
        }
        Runtime::Docker => {
            let target = image.context("missing image identity")?;
            let output = Command::new("docker")
                .args(["image", "inspect", "--format", "{{.Id}}", target])
                .output()?;
            if !output.status.success() {
                bail!("image identity unavailable");
            }
            let expected = String::from_utf8(output.stdout)?;
            let output = project
                .compose_command()
                .args(["ps", "-q", "app"])
                .output()?;
            if !output.status.success() {
                bail!("container identity unavailable");
            }
            let container = String::from_utf8(output.stdout)?;
            let container = container.trim();
            if container.is_empty() || !container.bytes().all(|c| c.is_ascii_hexdigit()) {
                bail!("invalid container identity");
            }
            let output = Command::new("docker")
                .args(["inspect", "--format", "{{.Image}}", container])
                .output()?;
            if !output.status.success()
                || String::from_utf8(output.stdout)?.trim() != expected.trim()
            {
                bail!("running container mismatch");
            }
        }
    }
    Ok(())
}

pub(super) fn validate_running_binary(
    installed: &Path,
    running: &Path,
    digest: &str,
) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let installed_metadata = fs::metadata(installed)?;
    let running_metadata = fs::metadata(running)?;
    if running_metadata.dev() != installed_metadata.dev()
        || running_metadata.ino() != installed_metadata.ino()
    {
        bail!("native application runs a different executable");
    }
    if digest_file(installed, 256 * 1024 * 1024)? != digest {
        bail!("installed binary mismatch");
    }
    Ok(())
}

pub(super) fn resume_previous_gate(project: &Project) -> anyhow::Result<()> {
    let id = project.env().get("NELCOTA_DEPLOYMENT_ID")?;
    let contents = match id {
        Some(id) if nelcota_deployment::valid_digest(&id) => format!("COMMITTED {id}\n"),
        _ => "ROLLED_BACK\n".into(),
    };
    write_gate(&gate_path(project)?, contents.as_bytes())
}

pub(super) fn validate_current(project: &Project, version: &str) -> anyhow::Result<()> {
    let output = match project.runtime {
        Runtime::Docker => probes::output(project.compose_command().args([
            "exec",
            "-T",
            "app",
            "/usr/local/bin/nelcota",
            "--version",
        ]))?,
        Runtime::Systemd => {
            let digest = digest_file(&native::deployed_binary(), 256 * 1024 * 1024)?;
            validate_binary_identity(project, None, Some(&digest))?;
            probes::output(Command::new(native::deployed_binary()).arg("--version"))?
        }
    };
    if output.trim() != format!("nelcota {version}") {
        bail!("running version differs from the approved plan");
    }
    Ok(())
}

pub(in crate::updates) fn gate_path(project: &Project) -> anyhow::Result<std::path::PathBuf> {
    if project.runtime == Runtime::Docker {
        return Ok(project.path("deployment-control/gate"));
    }
    let bytes = nelcota_deployment::read_private(&project.path(".deployment-project-id"), 64)?;
    let id = String::from_utf8(bytes)?;
    if !nelcota_deployment::valid_digest(&id) {
        bail!("invalid native gate identity");
    }
    Ok(Path::new("/var/lib/nelcota-deployment-gates")
        .join(id)
        .join("gate"))
}

pub(super) fn wait_ready(project: &Project) -> anyhow::Result<()> {
    let address = match project.runtime {
        Runtime::Systemd => native::APP_LISTEN.to_owned(),
        Runtime::Docker => {
            let container = probes::output(project.compose_command().args(["ps", "-q", "app"]))?;
            let container = container.trim();
            if container.is_empty() || !container.bytes().all(|c| c.is_ascii_hexdigit()) {
                bail!("invalid container identity");
            }
            let address = probes::output(Command::new("docker").args([
                "inspect",
                "--format",
                r#"{{(index .NetworkSettings.Networks "nelcota_edge").IPAddress}}"#,
                container,
            ]))?
            .trim()
            .parse::<std::net::Ipv4Addr>()?;
            format!("{address}:8000")
        }
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        if crate::util::deployment_ready(&address) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            bail!("committed application routes remain gated");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
