//! Runtime effects use the same maintenance and paired-backup owners as the CLI.
use super::{policy::Policy, probes, releases};
use crate::{
    backup,
    host::{Host, Runtime},
    maintenance::Maintenance,
    native,
    project::{Project, Service},
};
use anyhow::{Context, bail};
use nelcota_deployment::{HostLock, Job, Journal, Phase, Release, atomic_write, digest_file};
use std::{fs, path::Path, process::Command, time::Duration};

pub fn blockers(policy: &Policy, project: &Project) -> Vec<String> {
    let mut reasons = Vec::new();
    match project.env().read() {
        Ok(entries) => {
            let mut names = std::collections::HashSet::new();
            if entries.iter().any(|(name, _)| {
                !names.insert(name)
                    || name == "NELCOTA_CONFIG"
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            }) {
                reasons.push("configuration_layout_not_enrolled".into());
            }
        }
        Err(_) => reasons.push("configuration_layout_not_enrolled".into()),
    }

    if !policy.installation_validated() {
        reasons.push("installation_not_validated".into());
    }
    if project.runtime == Runtime::Docker
        && project.env().get("NELCOTA_IMAGE").ok().flatten().as_deref()
            != Some("ghcr.io/nelcota/nelcota-server")
    {
        reasons.push("custom_image_not_enrolled".into());
    }
    let db_host = match project.runtime {
        Runtime::Docker => "postgres",
        Runtime::Systemd => "127.0.0.1",
    };
    if project
        .env()
        .get("NELCOTA_DATABASE_URL")
        .ok()
        .flatten()
        .and_then(|value| url::Url::parse(&value).ok())
        .is_none_or(|url| {
            !matches!(url.scheme(), "postgres" | "postgresql")
                || url.host_str() != Some(db_host)
                || url.port() != Some(5432)
                || url.path() != "/postgres"
                || url.username() != "postgres"
        })
    {
        reasons.push("database_layout_not_enrolled".into());
    }
    if project.stores_files_on_disk().unwrap_or(false) {
        let expected = match project.runtime {
            Runtime::Docker => "/storage".into(),
            Runtime::Systemd => project.storage_dir().to_string_lossy().into_owned(),
        };
        if project
            .env()
            .get("NELCOTA_STORAGE_DIR")
            .ok()
            .flatten()
            .as_deref()
            != Some(expected.as_str())
        {
            reasons.push("storage_layout_not_enrolled".into());
        }
    }
    let host = Host::new(&policy.root);
    if host
        .secrets()
        .get("NELCOTA_BACKUP_S3_ENDPOINT")
        .ok()
        .flatten()
        .is_none_or(|endpoint| {
            url::Url::parse(&endpoint).is_err() || !endpoint.starts_with("https://")
        })
    {
        reasons.push("secure_offsite_endpoint_required".into());
    }
    if !backup::s3_configured(&Host::new(&policy.root)) {
        reasons.push("offsite_backup_required".into());
    }
    if project
        .env()
        .get("NELCOTA_STORAGE_BACKEND")
        .ok()
        .flatten()
        .as_deref()
        == Some("s3")
    {
        reasons.push("s3_restore_not_validated".into());
    }
    if crate::pitr::enabled(project) {
        reasons.push("pitr_restore_not_validated".into());
    }
    if project.runtime == Runtime::Docker
        && fs::read_to_string(project.path("docker-compose.yml"))
            .ok()
            .is_none_or(|text| {
                !super::enroll::known_project_compose(project, &text)
                    || !text.contains("${NELCOTA_APP_IMAGE:-${NELCOTA_IMAGE}:${NELCOTA_VERSION}}")
                    || !text.contains("./deployment-control:/run/nelcota-deployment:ro")
            })
    {
        reasons.push("compose_enrollment_required".into());
    }
    if project.runtime == Runtime::Systemd && !super::enroll::native_unit_enrolled(project) {
        reasons.push("configuration_layout_not_enrolled".into());
    }
    if !reasons.is_empty() {
        return reasons;
    }
    if health(project).as_deref() != Some("healthy") {
        reasons.push("current_app_unhealthy".into());
    }
    let required = estimated_required(policy, project);
    if required
        .ok()
        .is_none_or(|required| free_bytes(&policy.root).is_none_or(|free| free < required))
    {
        reasons.push("insufficient_disk".into());
    }

    reasons
}
fn free_bytes(root: &Path) -> Option<u64> {
    let output = probes::output(Command::new("df").args(["-P", "-B1"]).arg(root)).ok()?;
    output
        .lines()
        .nth(1)?
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()
}
fn estimated_required(policy: &Policy, project: &Project) -> anyhow::Result<u64> {
    let database = probes::database_bytes(project)?;
    let files = match project.stores_files_on_disk()? {
        true => probes::output(
            Command::new("du")
                .args(["-s", "-B1"])
                .arg(project.storage_dir()),
        )?
        .split_whitespace()
        .next()
        .context("missing file size")?
        .parse::<u64>()?,
        false => 0,
    };
    database
        .checked_add(files)
        .and_then(|bytes| bytes.checked_mul(3))
        .and_then(|bytes| bytes.checked_add(policy.minimum_free_bytes))
        .context("deployment size overflow")
}
fn health(project: &Project) -> Option<String> {
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

fn project(policy: &Policy, name: &str) -> anyhow::Result<(Host, Project)> {
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    if manifest.image != "ghcr.io/nelcota/nelcota-server" {
        bail!("custom images are not enrolled");
    }
    let project = host.select(&manifest, Some(name))?;
    Ok((host, project))
}
pub fn execute(policy: &Policy, id: &str, recover: bool) -> anyhow::Result<()> {
    execute_inner(policy, id, recover, false)
}

pub fn recover(policy: &Policy, id: &str, restore_snapshot: bool) -> anyhow::Result<()> {
    execute_inner(policy, id, true, restore_snapshot)
}

fn execute_inner(
    policy: &Policy,
    id: &str,
    recover: bool,
    restore_snapshot: bool,
) -> anyhow::Result<()> {
    let _lease = HostLock::acquire(&policy.root)?;
    nelcota_deployment::management::ensure_idle(&policy.root)?;
    let journal = Journal::open(&policy.root)?;
    let mut job = journal
        .list()?
        .into_iter()
        .find(|job| job.public.id == id)
        .context("unknown job")?;
    let (host, project) = project(policy, &job.public.project)?;
    if restore_snapshot {
        if job.public.phase != Phase::NeedsOperator
            || !job.public.committed
            || job.restored
            || job.backup.is_none()
            || job.dump_sha256.is_none()
        {
            bail!("snapshot restore requires an interrupted committed job with a verified backup");
        }
        job.restore_requested = true;
        journal.advance(
            &mut job,
            Phase::NeedsOperator,
            Some("operator_snapshot_restore_requested"),
        )?;
    }
    if recover {
        let result = recovery(policy, &host, &project, &journal, &mut job);
        if result.is_err() {
            record_recovery_failure(&journal, &mut job)?;
        }
        return result;
    }
    if job.public.phase != Phase::Preparing {
        bail!("job already started");
    }
    let result = deploy(policy, &host, &project, &journal, &mut job);
    if result.is_err() {
        // A rename can succeed before directory fsync reports an error. Read
        // the authoritative receipt before deciding whether data can roll back.
        job = journal
            .list()?
            .into_iter()
            .find(|entry| entry.public.id == id)
            .context("deployment receipt lost; keep maintenance closed")?;
        match job.public.phase {
            Phase::Preparing => journal.advance(
                &mut job,
                Phase::FailedBeforeChange,
                Some("preparation_failed"),
            )?,
            phase if phase.terminal() => {}
            _ => {
                let _ = Maintenance::hold(&host, &project);
                journal.advance(&mut job, Phase::NeedsOperator, Some("deployment_failed"))?;
                if !job.public.committed
                    && recovery(policy, &host, &project, &journal, &mut job).is_err()
                {
                    record_recovery_failure(&journal, &mut job)?;
                }
            }
        }
    }
    result
}
fn record_recovery_failure(journal: &Journal, job: &mut Job) -> anyhow::Result<()> {
    *job = journal
        .list()?
        .into_iter()
        .find(|entry| entry.public.id == job.public.id)
        .context("recovery receipt lost; keep maintenance closed")?;
    if !job.public.phase.terminal() {
        journal.advance(job, Phase::NeedsOperator, Some("recovery_failed"))?;
    }
    Ok(())
}
fn deploy(
    policy: &Policy,
    host: &Host,
    project: &Project,
    journal: &Journal,
    job: &mut Job,
) -> anyhow::Result<()> {
    if !blockers(policy, project).is_empty() {
        bail!("deployment preflight blocked");
    }
    let dir = journal.directory(&job.public.id)?;
    validate_current(project, &job.public.current)?;
    let manifest_path = policy
        .root
        .join("updates/releases")
        .join(&job.public.target)
        .join("update-manifest.json");
    if digest_file(&manifest_path, 65536)?
        != job
            .manifest_sha256
            .as_deref()
            .context("missing release plan identity")?
        || digest_file(&project.path(".env"), 65536)?
            != job
                .expected_env_sha256
                .as_deref()
                .context("missing configuration plan identity")?
    {
        bail!("deployment plan changed");
    }
    let release: Release =
        serde_json::from_slice(&nelcota_deployment::read_private(&manifest_path, 65536)?)?;
    release.validate(env!("CARGO_PKG_VERSION"), &job.public.current)?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let candidate = rt.block_on(releases::binary(&policy.root, &policy.verifier, &release))?;
    let target = format!(
        "ghcr.io/nelcota/nelcota-server@sha256:{}",
        release.artifact(std::env::consts::ARCH)?.image_digest
    );
    job.target_image = Some(target.clone());
    job.target_binary_sha256 = Some(release.artifact(std::env::consts::ARCH)?.sha256.clone());
    job.migration_version = release.migration_version;
    if project.runtime == Runtime::Docker {
        let output = project
            .compose_command()
            .args(["ps", "-q", "app"])
            .output()?;
        let container = String::from_utf8(output.stdout)?.trim().to_owned();
        if container.is_empty() || !container.bytes().all(|c| c.is_ascii_hexdigit()) {
            bail!("invalid current container");
        }
        let output = Command::new("docker")
            .args(["inspect", "--format", "{{.Image}}", &container])
            .output()?;
        let image = String::from_utf8(output.stdout)?.trim().to_owned();
        if !image
            .strip_prefix("sha256:")
            .is_some_and(nelcota_deployment::valid_digest)
        {
            bail!("invalid current image identity");
        }
        job.previous_image = Some(image);
        if !Command::new("docker")
            .args(["pull", &target])
            .status()?
            .success()
        {
            bail!("target image unavailable");
        }
        releases::verify(
            &policy.verifier,
            &format!("oci://{target}"),
            &release.source_sha,
            &format!("refs/tags/v{}", release.version),
            &candidate
                .parent()
                .context("release directory missing")?
                .join("nelcota-image.attestation.jsonl"),
            &dir,
        )?;
    }
    if project.runtime == Runtime::Systemd {
        let previous = dir.join("previous-binary");
        crate::private_fs::copy(native::deployed_binary(), &previous)?;
        job.previous_binary = Some(digest_file(&previous, 256 * 1024 * 1024)?);
    }
    crate::private_fs::copy(project.path(".env"), dir.join("previous.env"))?;
    job.previous_config_sha256 = Some(digest_file(&dir.join("previous.env"), 65536)?);
    journal.save(job)?;
    journal.advance(job, Phase::Pausing, None)?;
    let gate = Maintenance::enter(host, project)?;
    project.stop(&[Service::App])?;
    probes::quiescent(project)?;
    journal.advance(job, Phase::Capturing, None)?;
    let dump = backup::run(host, project, true, None)?;
    if project.stores_files_on_disk()? {
        backup::validate(&dump)?;
        job.files_manifest_sha256 = Some(digest_file(
            &backup::bundle_path(&dump)?.join("manifest.json"),
            16 * 1024 * 1024,
        )?);
    }
    let log = crate::private_fs::file(&dir.join("backup-validation.private.log"))?;
    if !project
        .as_postgres(&["pg_restore", "--list"])
        .stdin(fs::File::open(&dump)?)
        .stdout(log.try_clone()?)
        .stderr(log)
        .status()?
        .success()
    {
        bail!("backup archive validation failed");
    }
    backup::verify_remote(host, project, &dump, &dir)?;
    fs::File::open(&dump)?.sync_all()?;
    fs::File::open(project.path("backups"))?.sync_all()?;
    job.dump_sha256 = Some(digest_file(&dump, u64::MAX - 1)?);
    job.backup = Some(dump.to_str().context("invalid backup path")?.into());
    journal.advance(job, Phase::BackupVerified, None)?;
    let control = gate_path(project)?
        .parent()
        .context("missing gate directory")?
        .to_path_buf();
    fs::create_dir_all(&control)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&control, fs::Permissions::from_mode(0o755))?;
    }
    write_gate(
        &control.join("gate"),
        format!("VALIDATING {}\n", job.public.id).as_bytes(),
    )?;
    journal.advance(job, Phase::Activating, None)?;
    project.env().set("NELCOTA_VERSION", &job.public.target)?;
    project.env().set("NELCOTA_DEPLOYMENT_VALIDATION", "true")?;
    project.env().set("NELCOTA_DEPLOYMENT_ID", &job.public.id)?;
    let gate_path = match project.runtime {
        Runtime::Docker => "/run/nelcota-deployment/gate".into(),
        Runtime::Systemd => control.join("gate").to_string_lossy().into_owned(),
    };
    project.env().set("NELCOTA_DEPLOYMENT_GATE", &gate_path)?;
    if project.runtime == Runtime::Docker {
        project.env().set("NELCOTA_APP_IMAGE", &target)?;
    }
    if project.runtime == Runtime::Systemd {
        deploy_binary(&candidate)?;
    }
    project.recreate(Service::App)?;
    journal.advance(job, Phase::Validating, None)?;
    project.wait_healthy(Service::App, Duration::from_secs(120))?;
    validate_identity(project, job)?;
    journal.advance(job, Phase::Committing, None)?;
    write_gate(
        &control.join("gate"),
        format!("COMMITTED {}\n", job.public.id).as_bytes(),
    )?;
    wait_ready(project)?;
    gate.finish()?;
    journal.advance(job, Phase::Succeeded, None)
}
fn validate_identity(project: &Project, job: &Job) -> anyhow::Result<()> {
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
fn recovery(
    _policy: &Policy,
    host: &Host,
    project: &Project,
    journal: &Journal,
    job: &mut Job,
) -> anyhow::Result<()> {
    if job.public.phase.terminal() {
        return Ok(());
    }
    if !job.public.committed
        && (job.public.phase == Phase::Preparing || job.interrupted_phase == Some(Phase::Preparing))
    {
        return journal.advance(
            job,
            Phase::FailedBeforeChange,
            Some("preparation_interrupted"),
        );
    }
    let gate = Maintenance::hold(host, project)?;
    if job.public.committed && (job.restored || !job.restore_requested) {
        if job.restored {
            let dir = journal.directory(&job.public.id)?;
            restore_previous_artifacts(project, job, &dir)?;
            resume_previous_gate(project)?;
            project.recreate(Service::App)?;
            project.wait_healthy(Service::App, Duration::from_secs(120))?;
            validate_previous(project, job, &dir)?;
            if job.public.phase != Phase::ResumingPrevious {
                journal.advance(job, Phase::ResumingPrevious, None)?;
            }
            wait_ready(project)?;
            gate.finish()?;
            return journal.advance(job, Phase::Recovered, None);
        }
        project.recreate(Service::App)?;
        project.wait_healthy(Service::App, Duration::from_secs(120))?;
        validate_identity(project, job)?;
        if job.public.phase != Phase::Committing {
            journal.advance(job, Phase::Committing, None)?;
        }
        write_gate(
            &gate_path(project)?,
            format!("COMMITTED {}\n", job.public.id).as_bytes(),
        )?;
        wait_ready(project)?;
        gate.finish()?;
        return journal.advance(job, Phase::Succeeded, None);
    }
    if job.backup.is_none()
        && matches!(
            job.interrupted_phase,
            Some(Phase::BackupVerified | Phase::Activating | Phase::Validating)
        )
    {
        bail!("missing deployment snapshot");
    }
    if job.public.phase != Phase::Recovering {
        journal.advance(job, Phase::Recovering, None)?;
    }
    let dir = journal.directory(&job.public.id)?;
    project.stop(&[Service::App])?;
    if let Some(dump) = &job.backup {
        let dump = Path::new(dump);
        if dump.parent() != Some(project.path("backups").as_path())
            || digest_file(dump, u64::MAX - 1)?
                != job
                    .dump_sha256
                    .as_deref()
                    .context("missing backup identity")?
        {
            bail!("backup verification failed");
        }
        if project.stores_files_on_disk()? {
            if digest_file(
                &backup::bundle_path(dump)?.join("manifest.json"),
                16 * 1024 * 1024,
            )? != job
                .files_manifest_sha256
                .as_deref()
                .context("missing file snapshot identity")?
            {
                bail!("snapshot manifest changed");
            }
            let manifest = backup::validate(dump)?;
            backup::restore_files(project, dump, &manifest)?;
        }
        backup::restore_dump(project, dump)?;
    }
    restore_previous_artifacts(project, job, &dir)?;
    job.restored = true;
    if job.backup.is_none() {
        // No activation was possible without a durable snapshot. Retrying this
        // path may restart the old app, but never restores database/file bytes.
        resume_previous_gate(project)?;
        project.recreate(Service::App)?;
        project.wait_healthy(Service::App, Duration::from_secs(120))?;
        validate_previous(project, job, &dir)?;
        wait_ready(project)?;
        gate.finish()?;
        return journal.advance(
            job,
            Phase::FailedBeforeChange,
            Some("deployment_failed_before_change"),
        );
    }
    journal.advance(job, Phase::ResumingPrevious, None)?;
    resume_previous_gate(project)?;
    project.recreate(Service::App)?;
    project.wait_healthy(Service::App, Duration::from_secs(120))?;
    validate_previous(project, job, &dir)?;
    wait_ready(project)?;
    gate.finish()?;
    journal.advance(job, Phase::Recovered, None)
}
fn restore_previous_artifacts(project: &Project, job: &Job, dir: &Path) -> anyhow::Result<()> {
    if digest_file(&dir.join("previous.env"), 65536)?
        != job
            .previous_config_sha256
            .as_deref()
            .context("missing previous config identity")?
    {
        bail!("previous configuration corrupt");
    }
    crate::private_fs::copy(dir.join("previous.env"), project.path(".env"))?;
    if let Some(image) = &job.previous_image {
        project.env().set("NELCOTA_APP_IMAGE", image)?;
    }
    if let Some(digest) = &job.previous_binary {
        let path = dir.join("previous-binary");
        if digest_file(&path, 256 * 1024 * 1024)? != *digest {
            bail!("previous binary corrupt");
        }
        deploy_binary(&path)?;
    }
    Ok(())
}
fn deploy_binary(source: &Path) -> anyhow::Result<()> {
    let path = native::deployed_binary();
    crate::private_fs::copy(source, &path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        fs::File::open(&path)?.sync_all()?;
    }
    Ok(())
}
fn write_gate(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    atomic_write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
        fs::File::open(path)?.sync_all()?;
    }
    Ok(())
}

fn validate_previous(project: &Project, job: &Job, dir: &Path) -> anyhow::Result<()> {
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
fn validate_binary_identity(
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

fn validate_running_binary(installed: &Path, running: &Path, digest: &str) -> anyhow::Result<()> {
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

fn resume_previous_gate(project: &Project) -> anyhow::Result<()> {
    let id = project.env().get("NELCOTA_DEPLOYMENT_ID")?;
    let contents = match id {
        Some(id) if nelcota_deployment::valid_digest(&id) => format!("COMMITTED {id}\n"),
        _ => "ROLLED_BACK\n".into(),
    };
    write_gate(&gate_path(project)?, contents.as_bytes())
}

fn validate_current(project: &Project, version: &str) -> anyhow::Result<()> {
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

pub(super) fn gate_path(project: &Project) -> anyhow::Result<std::path::PathBuf> {
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

fn wait_ready(project: &Project) -> anyhow::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
