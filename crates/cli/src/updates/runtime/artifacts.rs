//! Durable configuration, native binary and traffic-gate publication.
use crate::native;
use crate::project::Project;
use anyhow::Context;
use anyhow::bail;
use nelcota_deployment::Job;
use nelcota_deployment::atomic_write;
use nelcota_deployment::digest_file;
use std::fs;
use std::path::Path;

pub(super) fn restore_previous_artifacts(
    project: &Project,
    job: &Job,
    dir: &Path,
) -> anyhow::Result<()> {
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
pub(super) fn deploy_binary(source: &Path) -> anyhow::Result<()> {
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
pub(super) fn write_gate(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    atomic_write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
        fs::File::open(path)?.sync_all()?;
    }
    Ok(())
}
