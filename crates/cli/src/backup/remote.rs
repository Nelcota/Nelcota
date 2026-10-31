//! S3-compatible transport for immutable backup pairs.
use crate::{
    host::Host,
    project::Project,
    util::{ok, step},
};
use anyhow::{Context, bail};
use std::{fs, path::Path, process::Command};
/// The host's backup bucket (credentials from `host.env`).
struct BackupS3 {
    endpoint: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    region: String,
    native: bool,
}

impl BackupS3 {
    fn from_host(host: &Host) -> anyhow::Result<Self> {
        let secrets = host.secrets();
        let get = |key: &str| -> anyhow::Result<String> {
            secrets
                .get(key)?
                .with_context(|| format!("{key} is not set in host.env (see docs/backup.md)"))
        };
        let endpoint = get("NELCOTA_BACKUP_S3_ENDPOINT")?;
        let parsed =
            url::Url::parse(&endpoint).map_err(|_| anyhow::anyhow!("invalid backup endpoint"))?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
            || parsed.query().is_some()
        {
            bail!("offsite backups require an HTTPS endpoint without URL credentials");
        }
        Ok(BackupS3 {
            native: host.require()?.runtime == crate::host::Runtime::Systemd,
            endpoint,
            bucket: get("NELCOTA_BACKUP_S3_BUCKET")?,
            access_key: get("NELCOTA_BACKUP_S3_ACCESS_KEY")?,
            secret_key: get("NELCOTA_BACKUP_S3_SECRET_KEY")?,
            region: secrets
                .get("NELCOTA_BACKUP_S3_REGION")?
                .unwrap_or_else(|| "us-east-1".into()),
        })
    }

    /// Runs `aws s3 <args>` in the `amazon/aws-cli` image with `dir` mounted
    /// at `/data` (as `user`, when given).
    fn run(
        &self,
        dir: &Path,
        read_only: bool,
        user: Option<&str>,
        args: &[&str],
    ) -> anyhow::Result<()> {
        let dir = fs::canonicalize(dir)?.display().to_string();
        if self.native {
            let args: Vec<_> = args
                .iter()
                .map(|value| match value.strip_prefix("/data") {
                    Some(path) => format!("{dir}{path}"),
                    None => (*value).to_owned(),
                })
                .collect();
            let status = Command::new("aws")
                .arg("s3")
                .args(args)
                .args(["--endpoint-url", &self.endpoint])
                .env("AWS_ACCESS_KEY_ID", &self.access_key)
                .env("AWS_SECRET_ACCESS_KEY", &self.secret_key)
                .env("AWS_DEFAULT_REGION", &self.region)
                .status()
                .context("native backup requires AWS CLI v2")?;
            if !status.success() {
                bail!("native offsite backup transport failed");
            }
            return Ok(());
        }
        // Windows marks canonical paths as verbatim (`\\?\C:\...`), which
        // `docker -v` reads as extra colons.
        let dir = dir.strip_prefix(r"\\?\").unwrap_or(&dir);
        let mut command = Command::new("docker");
        command.args(["run", "--rm", "-v"]).arg(format!(
            "{dir}:/data{}",
            match read_only {
                true => ":ro",
                false => "",
            }
        ));
        if let Some(user) = user {
            command.args(["--user", user]);
        }
        let status = command
            .args([
                "-e",
                "AWS_ACCESS_KEY_ID",
                "-e",
                "AWS_SECRET_ACCESS_KEY",
                "-e",
                "AWS_DEFAULT_REGION",
            ])
            .env("AWS_ACCESS_KEY_ID", &self.access_key)
            .env("AWS_SECRET_ACCESS_KEY", &self.secret_key)
            .env("AWS_DEFAULT_REGION", &self.region)
            .args([
                "--entrypoint",
                "/bin/sh",
                "amazon/aws-cli",
                "-c",
                "umask 077; exec aws \"$@\"",
                "--",
                "s3",
            ])
            .args(args)
            .args(["--endpoint-url", &self.endpoint])
            .status()
            .context("could not run aws-cli")?;
        if !status.success() {
            bail!("aws s3 {} failed ({status})", args.first().unwrap_or(&""));
        }
        Ok(())
    }

    fn files_url(&self, project: &str, dump: &Path) -> anyhow::Result<String> {
        let name = dump
            .file_name()
            .and_then(|n| n.to_str())
            .context("invalid dump filename")?;
        Ok(format!("s3://{}/{project}/{name}.files/", self.bucket))
    }
}

/// Has the host a backup bucket in `host.env`? Any of the S3 keys counts, so
/// an incomplete configuration fails loudly on upload instead of being skipped
/// (the local dump is written first either way).
pub(crate) fn s3_configured(host: &Host) -> bool {
    const KEYS: [&str; 4] = [
        "NELCOTA_BACKUP_S3_ENDPOINT",
        "NELCOTA_BACKUP_S3_BUCKET",
        "NELCOTA_BACKUP_S3_ACCESS_KEY",
        "NELCOTA_BACKUP_S3_SECRET_KEY",
    ];
    let secrets = host.secrets();
    KEYS.iter()
        .any(|key| secrets.get(key).ok().flatten().is_some())
}

/// A complete syntactically valid destination, distinct from the fail-loud
/// any-key detection used by the legacy CLI upload switch.
#[cfg(target_os = "linux")]
pub(crate) fn valid_destination(host: &Host) -> bool {
    BackupS3::from_host(host).is_ok()
}

/// Uploads to S3-compatible storage (credentials from `host.env`), under `<bucket>/<project>/`.
pub(super) fn upload_s3(host: &Host, project: &str, path: &Path, name: &str) -> anyhow::Result<()> {
    let s3 = BackupS3::from_host(host)?;
    let dir = path.parent().unwrap_or(Path::new("."));
    step(&format!("Uploading to s3://{}/{project}/{name}", s3.bucket));
    s3.run(
        dir,
        true,
        None,
        &[
            "cp",
            &format!("/data/{name}"),
            &format!("s3://{}/{project}/{name}", s3.bucket),
        ],
    )?;
    ok("uploaded");
    Ok(())
}

/// Each dump has its own immutable snapshot; later deletions cannot alter it.
pub(super) fn sync_files_up(host: &Host, project: &Project, dump: &Path) -> anyhow::Result<()> {
    let dir = crate::backup::bundle_path(dump)?;
    if !dir.is_dir() {
        return Ok(());
    }
    let s3 = BackupS3::from_host(host)?;
    let url = s3.files_url(&project.name, dump)?;
    step(&format!("Uploading file snapshot to {url}"));
    s3.run(
        &dir,
        true,
        None,
        &["sync", "/data", &url, "--only-show-errors"],
    )?;
    ok("files synced");
    Ok(())
}

/// Fetch the matching snapshot into the backup directory, never the live store.
pub(super) fn sync_files_down(host: &Host, project: &Project, dump: &Path) -> anyhow::Result<()> {
    let dir = crate::backup::bundle_path(dump)?;
    crate::private_fs::dir(&dir)?;
    let s3 = BackupS3::from_host(host)?;
    let url = s3.files_url(&project.name, dump)?;
    step(&format!("Fetching file snapshot from {url}"));
    s3.run(
        &dir,
        false,
        None,
        &["sync", &url, "/data", "--only-show-errors"],
    )?;
    crate::private_fs::seal_tree(&dir)?;
    ok("files restored");
    Ok(())
}

/// Read back the exact offsite pair before a deployment may touch the database.
pub(crate) fn verify_remote(
    host: &Host,
    project: &Project,
    dump: &Path,
    scratch: &Path,
) -> anyhow::Result<()> {
    let s3 = BackupS3::from_host(host)?;
    let name = dump
        .file_name()
        .and_then(|name| name.to_str())
        .context("invalid dump filename")?;
    let temporary = tempfile::tempdir_in(scratch)?;
    s3.run(
        temporary.path(),
        false,
        None,
        &[
            "cp",
            &format!("s3://{}/{}/{name}", s3.bucket, project.name),
            &format!("/data/{name}"),
            "--only-show-errors",
        ],
    )?;
    let fetched = temporary.path().join(name);
    if nelcota_deployment::digest_file(&fetched, u64::MAX - 1)?
        != nelcota_deployment::digest_file(dump, u64::MAX - 1)?
    {
        bail!("offsite dump checksum mismatch");
    }
    if project.stores_files_on_disk()? {
        let bundle = crate::backup::bundle_path(&fetched)?;
        crate::private_fs::dir(&bundle)?;
        s3.run(
            &bundle,
            false,
            None,
            &[
                "sync",
                &s3.files_url(&project.name, dump)?,
                "/data",
                "--only-show-errors",
            ],
        )?;
        crate::private_fs::seal_tree(&bundle)?;
        if nelcota_deployment::digest_file(&bundle.join("manifest.json"), 16 * 1024 * 1024)?
            != nelcota_deployment::digest_file(
                &crate::backup::bundle_path(dump)?.join("manifest.json"),
                16 * 1024 * 1024,
            )?
        {
            bail!("offsite file manifest mismatch");
        }
        crate::backup::validate(&fetched)?;
    }
    // Recovery configuration contains keys; require server-side encryption.
    let config = scratch.join("previous.env");
    let url = format!(
        "s3://{}/{}/deployments/{}/previous.env",
        s3.bucket,
        project.name,
        scratch
            .file_name()
            .and_then(|name| name.to_str())
            .context("invalid job directory")?
    );
    s3.run(
        scratch,
        true,
        None,
        &[
            "cp",
            "/data/previous.env",
            &url,
            "--sse",
            "AES256",
            "--only-show-errors",
        ],
    )?;
    s3.run(
        temporary.path(),
        false,
        None,
        &["cp", &url, "/data/previous.env", "--only-show-errors"],
    )?;
    if nelcota_deployment::digest_file(&config, 65536)?
        != nelcota_deployment::digest_file(&temporary.path().join("previous.env"), 65536)?
    {
        bail!("offsite configuration checksum mismatch");
    }
    Ok(())
}

/// Publish one already-validated immutable pair; safe to retry the same bytes.
#[cfg(target_os = "linux")]
pub(crate) fn publish_remote(host: &Host, project: &Project, dump: &Path) -> anyhow::Result<()> {
    crate::backup::validate(dump)?;
    sync_files_up(host, project, dump)?;
    upload_s3(
        host,
        &project.name,
        dump,
        dump.file_name()
            .and_then(|s| s.to_str())
            .context("backup name")?,
    )
}

/// A unique, encrypted write/read/delete probe never changes an existing backup.
#[cfg(target_os = "linux")]
pub(crate) fn test_remote(host: &Host, scratch: &Path, id: &str) -> anyhow::Result<()> {
    if !nelcota_deployment::valid_digest(id) {
        bail!("invalid backup probe");
    }
    let s3 = BackupS3::from_host(host)?;
    let local = tempfile::tempdir_in(scratch)?;
    crate::private_fs::write(&local.path().join("probe"), id.as_bytes())?;
    let key = format!("s3://{}/.nelcota-probes/{id}", s3.bucket);
    s3.run(
        local.path(),
        true,
        None,
        &[
            "cp",
            "/data/probe",
            &key,
            "--sse",
            "AES256",
            "--only-show-errors",
        ],
    )?;
    let result = (|| -> anyhow::Result<()> {
        s3.run(
            local.path(),
            false,
            None,
            &["cp", &key, "/data/readback", "--only-show-errors"],
        )?;
        if fs::read(local.path().join("readback"))? != id.as_bytes() {
            bail!("backup probe readback mismatch");
        }
        Ok(())
    })();
    let cleanup = s3.run(
        local.path(),
        true,
        None,
        &["rm", &key, "--only-show-errors"],
    );
    result?;
    cleanup
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bucket_added_to_host_env_turns_uploads_on() {
        let root = tempfile::tempdir().unwrap();
        let host = Host::new(root.path());
        assert!(!s3_configured(&host), "no host.env");
        fs::write(
            host.secrets().path(),
            "# host secrets\nNELCOTA_ADMIN_EMAIL=a@b.c\n",
        )
        .unwrap();
        assert!(!s3_configured(&host));
        host.secrets()
            .set("NELCOTA_BACKUP_S3_BUCKET", "backups")
            .unwrap();
        assert!(s3_configured(&host));
    }
}
