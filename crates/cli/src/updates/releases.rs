//! Official release discovery. Bytes and signed provenance are both required.
use anyhow::{Context, bail};
use nelcota_deployment::{Release, atomic_write, digest_file, private_dir};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const REPO: &str = "Nelcota/Nelcota";
const WORKFLOW: &str = "Nelcota/Nelcota/.github/workflows/release.yml";

fn client() -> anyhow::Result<reqwest::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Ok(reqwest::Client::builder()
        .user_agent("Nelcota deployment/1")
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or("");
            if attempt.previous().len() < 4
                && attempt.url().scheme() == "https"
                && [
                    "github.com",
                    "api.github.com",
                    "release-assets.githubusercontent.com",
                    "objects.githubusercontent.com",
                ]
                .contains(&host)
            {
                return attempt.follow();
            }
            attempt.error("unapproved release redirect")
        }))
        .build()?)
}
/// Slowest sustained transfer a download is given time for. The client's 60s
/// total suits metadata; a full server binary needs a budget that grows with
/// its declared size (stalls are still cut by the client's read timeout).
const MIN_DOWNLOAD_BYTES_PER_SECOND: u64 = 64 * 1024;
fn download_budget(maximum: u64) -> Duration {
    Duration::from_secs(60).max(Duration::from_secs(maximum / MIN_DOWNLOAD_BYTES_PER_SECOND))
}
async fn download(url: &str, path: &Path, maximum: u64) -> anyhow::Result<()> {
    let mut response = client()?
        .get(url)
        .timeout(download_budget(maximum))
        .send()
        .await?
        .error_for_status()?;
    if response.content_length().is_some_and(|len| len > maximum) {
        bail!("release download too large");
    }
    let parent = path.parent().context("missing release directory")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut total = 0u64;
    while let Some(bytes) = response.chunk().await? {
        total = total
            .checked_add(bytes.len() as u64)
            .context("release length overflow")?;
        if total > maximum {
            bail!("release download too large");
        }
        temporary.write_all(&bytes)?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
pub async fn latest(root: &Path, verifier: &Path) -> anyhow::Result<Release> {
    let mut response = client()?
        .get("https://api.github.com/repos/Nelcota/Nelcota/releases/latest")
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            bail!("release metadata too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    if value["draft"] != false || value["prerelease"] != false {
        bail!("release is not stable");
    }
    let tag = value["tag_name"].as_str().context("missing release tag")?;
    let version = tag.strip_prefix('v').context("invalid release tag")?;
    let parsed = semver::Version::parse(version)?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() || tag != format!("v{parsed}") {
        bail!("invalid stable release tag");
    }
    let dir = root.join("updates/releases").join(version);
    private_dir(&dir)?;
    let path = dir.join("update-manifest.json");
    let candidate = dir.join("update-manifest.download");
    download(
        &format!("https://github.com/{REPO}/releases/download/{tag}/update-manifest.json"),
        &candidate,
        65536,
    )
    .await?;
    let bundle = dir.join("update-manifest.json.attestation.jsonl");
    download(&format!("https://github.com/{REPO}/releases/download/{tag}/update-manifest.json.attestation.jsonl"),&bundle,8*1024*1024).await?;
    let release: Release = serde_json::from_slice(&fs::read(&candidate)?)?;
    if release.version != version {
        bail!("release version mismatch");
    }
    release.validate(env!("CARGO_PKG_VERSION"), &release.minimum_app)?;
    let verifier = verifier.to_path_buf();
    let candidate_path = candidate.clone();
    let source = release.source_sha.clone();
    let source_ref = format!("refs/tags/v{}", release.version);
    let verify_dir = dir.clone();
    tokio::task::spawn_blocking(move || {
        verify(
            &verifier,
            candidate_path.to_str().context("invalid manifest path")?,
            &source,
            &source_ref,
            &bundle,
            &verify_dir,
        )
    })
    .await??;
    if path.exists() && fs::read(&path)? != fs::read(&candidate)? {
        bail!("published release changed");
    }
    atomic_write(&path, &fs::read(&candidate)?)?;
    fs::remove_file(candidate)?;
    Ok(release)
}
pub async fn binary(root: &Path, verifier: &Path, release: &Release) -> anyhow::Result<PathBuf> {
    let architecture = std::env::consts::ARCH;
    let artifact = release.artifact(architecture)?;
    let dir = root.join("updates/releases").join(&release.version);
    private_dir(&dir)?;
    let path = dir.join(&artifact.filename);
    if !path.exists() {
        download(
            &format!(
                "https://github.com/{REPO}/releases/download/v{}/{}",
                release.version, artifact.filename
            ),
            &path,
            artifact.bytes,
        )
        .await?;
    }
    if fs::metadata(&path)?.len() != artifact.bytes
        || digest_file(&path, artifact.bytes)? != artifact.sha256
    {
        bail!("release checksum mismatch");
    }
    let bundle = dir.join(format!("{}.attestation.jsonl", artifact.filename));
    download(
        &format!(
            "https://github.com/{REPO}/releases/download/v{}/{}.attestation.jsonl",
            release.version, artifact.filename
        ),
        &bundle,
        8 * 1024 * 1024,
    )
    .await?;
    let image_bundle = dir.join("nelcota-image.attestation.jsonl");
    download(
        &format!(
            "https://github.com/{REPO}/releases/download/v{}/nelcota-image.attestation.jsonl",
            release.version
        ),
        &image_bundle,
        8 * 1024 * 1024,
    )
    .await?;
    verify(
        verifier,
        path.to_str().context("invalid binary path")?,
        &release.source_sha,
        &format!("refs/tags/v{}", release.version),
        &bundle,
        &dir,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    let output = Command::new(&path).arg("--version").output()?;
    if !output.status.success()
        || String::from_utf8_lossy(&output.stdout).trim() != format!("nelcota {}", release.version)
    {
        bail!("binary version mismatch");
    }
    Ok(path)
}
pub fn trusted_verifier(verifier: &Path) -> anyhow::Result<()> {
    super::policy::trusted_path(verifier)?;
    let metadata = fs::symlink_metadata(verifier)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            bail!("untrusted provenance verifier");
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("invalid provenance verifier");
    }
    Ok(())
}
pub fn verify(
    verifier: &Path,
    artifact: &str,
    source: &str,
    source_ref: &str,
    bundle: &Path,
    dir: &Path,
) -> anyhow::Result<()> {
    if source.len() != 40 || !source.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("invalid source digest");
    }
    trusted_verifier(verifier)?;
    let log = dir.join("provenance.private.log");
    let file = crate::private_fs::file(&log)?;
    let mut child = Command::new(verifier)
        .args([
            "attestation",
            "verify",
            artifact,
            "--repo",
            REPO,
            "--signer-workflow",
            WORKFLOW,
            "--source-digest",
            source,
            "--source-ref",
            source_ref,
            "--bundle",
            bundle.to_str().context("invalid provenance bundle path")?,
            "--deny-self-hosted-runners",
            "--format",
            "json",
        ])
        .env("GH_CONFIG_DIR", dir.join("gh-config"))
        .env("XDG_STATE_HOME", dir.join("gh-state"))
        .env("XDG_CACHE_HOME", dir.join("gh-cache"))
        .stdin(Stdio::null())
        .stdout(file.try_clone()?)
        .stderr(file)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                bail!("provenance verification failed");
            }
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("provenance verification timed out");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_budget_grows_with_the_declared_size() {
        assert_eq!(download_budget(65536), Duration::from_secs(60));
        assert_eq!(download_budget(8 * 1024 * 1024), Duration::from_secs(128));
        assert_eq!(download_budget(64 * 1024 * 1024), Duration::from_secs(1024));
    }
}
