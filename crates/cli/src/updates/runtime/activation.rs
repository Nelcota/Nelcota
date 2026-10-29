//! Ordered deployment activation with a verified paired backup.
use super::artifacts::deploy_binary;
use super::artifacts::write_gate;
use super::preflight::blockers;
use super::validation::gate_path;
use super::validation::validate_current;
use super::validation::validate_identity;
use super::validation::wait_ready;
use crate::backup;
use crate::host::Host;
use crate::host::Runtime;
use crate::maintenance::Maintenance;
use crate::native;
use crate::project::Project;
use crate::project::Service;
use crate::updates::policy::Policy;
use crate::updates::probes;
use crate::updates::releases;
use anyhow::Context;
use anyhow::bail;
use nelcota_deployment::Job;
use nelcota_deployment::Journal;
use nelcota_deployment::Phase;
use nelcota_deployment::Release;
use nelcota_deployment::digest_file;
use std::fs;
use std::process::Command;
use std::time::Duration;

pub(super) fn deploy(
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
