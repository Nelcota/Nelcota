//! Bounded native commands, backup identity and artifact verification.
use crate::backup;
use crate::caddy;
use crate::host::Host;
use crate::project::Project;
use crate::project::Service;
use crate::updates::policy::trusted_path;
use crate::updates::policy::{Policy, Provisioning};
use anyhow::Context;
use anyhow::bail;
use nelcota_deployment::digest_file;
use nelcota_deployment::management::Operation;
use nelcota_deployment::management::{HostJournal, Stage, Task};
use nelcota_deployment::{atomic_write, read_private};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

pub(in crate::updates) fn approved_backup(
    policy: &Policy,
    name: &str,
    file: &str,
) -> anyhow::Result<std::path::PathBuf> {
    if !nelcota_deployment::management::valid_backup(file)
        || !file.starts_with(&format!("nelcota-{name}-"))
    {
        bail!("invalid backup selection");
    }
    let path = policy
        .root
        .join("projects")
        .join(name)
        .join("backups")
        .join(file);
    trusted_path(&path)?;
    trusted_path(&backup::bundle_path(&path)?.join("manifest.json"))?;
    Ok(path)
}
pub(in crate::updates) fn backup_identity(path: &Path) -> anyhow::Result<String> {
    digest_file(
        &backup::bundle_path(path)?.join("manifest.json"),
        16 * 1024 * 1024,
    )
}

pub(in crate::updates) async fn output(mut command: Command) -> anyhow::Result<String> {
    use std::os::unix::process::CommandExt;
    use tokio::io::AsyncReadExt;
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .process_group(0);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .context("command output unavailable")?
        .take(65537);
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        stdout.read_to_end(&mut bytes).await?;
        if bytes.len() > 65536 {
            bail!("command output too large");
        }
        if !child.wait().await?.success() {
            bail!("runtime unavailable");
        }
        Ok::<_, anyhow::Error>(String::from_utf8(bytes)?)
    })
    .await;
    if !matches!(result, Ok(Ok(_))) {
        if let Some(pid) = child.id() {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .status();
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result.context("runtime timed out")?
}
pub(super) fn verify_image(policy: &Policy, dir: &Path) -> anyhow::Result<()> {
    let p = policy
        .host_management
        .as_ref()
        .context("management disabled")?;
    crate::updates::releases::trusted_verifier(&policy.verifier)?;
    let output = crate::private_fs::file(&dir.join("provenance.private.log"))?;
    let status = Command::new(&policy.verifier)
        .args([
            "attestation",
            "verify",
            &format!(
                "oci://ghcr.io/nelcota/nelcota-server@sha256:{}",
                p.image_digest
            ),
            "--repo",
            "Nelcota/Nelcota",
            "--signer-workflow",
            "Nelcota/Nelcota/.github/workflows/release.yml",
            "--source-digest",
            &p.source_sha,
            "--source-ref",
            &format!("refs/tags/v{}", p.version),
            "--deny-self-hosted-runners",
        ])
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output)
        .status()?;
    if !status.success() {
        bail!("creation image provenance failed");
    }
    Ok(())
}
pub(super) fn verify_https(policy: &Policy, project: &Project) -> anyhow::Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let p = policy
        .host_management
        .as_ref()
        .context("management disabled")?;
    let manifest = Host::new(&policy.root).require()?;
    let domain = &manifest
        .projects
        .iter()
        .find(|p| p.name == project.name)
        .context("project missing")?
        .domain;
    let addresses: Vec<_> = p
        .addresses
        .iter()
        .map(|s| Ok(std::net::SocketAddr::new(s.parse()?, 443)))
        .collect::<anyhow::Result<_>>()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(domain, &addresses)
        .build()?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            for _ in 0..12 {
                if client
                    .get(format!("https://{domain}/health"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            bail!("public HTTPS is not healthy; inspect DNS, TLS and firewall")
        })
}

pub(super) trait Effects {
    fn configuration_checkpoint(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn restart(&self, project: &Project) -> anyhow::Result<()> {
        project.recreate(Service::App)
    }
    fn prepare(&self, _: &Project) -> anyhow::Result<()> {
        Ok(())
    }
    fn finish(&self, journal: &HostJournal, task: &mut Task) -> anyhow::Result<()> {
        journal.advance(task, Stage::Completed, None)
    }
    fn preflight(&self, policy: &Policy, op: &Operation) -> anyhow::Result<Vec<String>>;
    fn verify_image(&self, policy: &Policy, dir: &Path) -> anyhow::Result<()>;
    fn image(&self, p: &Provisioning) -> String {
        format!("ghcr.io/nelcota/nelcota-server@sha256:{}", p.image_digest)
    }
    fn publish(&self, host: &Host) -> anyhow::Result<()>;
    fn verify_https(&self, policy: &Policy, project: &Project) -> anyhow::Result<()>;
    fn pause(&self, host: &Host, project: &Project) -> anyhow::Result<()> {
        atomic_write(&project.path(crate::maintenance::MARKER), b"")?;
        self.publish(host)
    }
    fn resume(&self, host: &Host, project: &Project) -> anyhow::Result<()> {
        fs::remove_file(project.path(crate::maintenance::MARKER))?;
        fs::File::open(&project.dir)?.sync_all()?;
        if let Err(error) = self.publish(host) {
            atomic_write(&project.path(crate::maintenance::MARKER), b"")?;
            let _ = caddy::write(host, &host.require()?);
            return Err(error);
        }
        Ok(())
    }
}
pub(super) fn changed(journal: &HostJournal, task: &mut Task, stage: Stage) -> anyhow::Result<()> {
    task.public.changed = true;
    journal.advance(task, stage, None)
}
pub(super) fn require_identity(project: &Project, task: &Task) -> anyhow::Result<()> {
    if read_private(&project.path(".deployment-project-id"), 64)? != task.identity.as_bytes() {
        bail!("approved project identity changed");
    }
    Ok(())
}
