//! Bounded private evidence for a successful external readback, not a restore certificate.
use super::*;
use crate::host::Host;
use nelcota_deployment::{atomic_write, digest_file, private_dir, read_private};
use std::time::{SystemTime, UNIX_EPOCH};
#[derive(Serialize, Deserialize)]
struct Receipt {
    schema: u8,
    project: String,
    dump: String,
    verified_at: u64,
    host_sha: String,
    project_sha: String,
}
pub(crate) fn verify_copy(host: &Host, project: &Project, dump: &Path) -> anyhow::Result<()> {
    let scratch = tempfile::tempdir_in(project.path("backups"))?;
    let name = dump
        .file_name()
        .and_then(|s| s.to_str())
        .context("invalid backup name")?;
    if !nelcota_deployment::management::valid_backup(name) {
        bail!("invalid backup name");
    }
    // The encrypted configuration has a deterministic key paired to this dump,
    // so recovery does not depend on a discarded temporary directory name.
    let paired = scratch.path().join(name);
    crate::private_fs::dir(&paired)?;
    crate::private_fs::copy(project.path(".env"), paired.join("previous.env"))?;
    super::verify_remote(host, project, dump, &paired)?;
    record(host, project, dump)
}
pub(crate) fn record(host: &Host, project: &Project, dump: &Path) -> anyhow::Result<()> {
    let name = dump
        .file_name()
        .and_then(|s| s.to_str())
        .context("invalid backup name")?;
    if !nelcota_deployment::valid_project(&project.name)
        || !nelcota_deployment::management::valid_backup(name)
    {
        bail!("invalid verification identity");
    }
    let dir = host.root().join("backup-verification");
    private_dir(&dir)?;
    let receipt = Receipt {
        schema: 1,
        project: project.name.clone(),
        dump: name.into(),
        verified_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        host_sha: digest_file(host.secrets().path(), 65536)?,
        project_sha: digest_file(&project.path(".env"), 65536)?,
    };
    atomic_write(
        &dir.join(format!("{}.json", project.name)),
        &serde_json::to_vec(&receipt)?,
    )
}
pub(crate) fn latest_verified(host: &Host, project: &Project) -> Option<u64> {
    if !nelcota_deployment::valid_project(&project.name) {
        return None;
    }
    let path = host
        .root()
        .join("backup-verification")
        .join(format!("{}.json", project.name));
    let receipt: Receipt = serde_json::from_slice(&read_private(&path, 4096).ok()?).ok()?;
    if receipt.schema != 1
        || receipt.project != project.name
        || !nelcota_deployment::management::valid_backup(&receipt.dump)
        || receipt.host_sha != digest_file(host.secrets().path(), 65536).ok()?
        || receipt.project_sha != digest_file(&project.path(".env"), 65536).ok()?
        || !project.path("backups").join(receipt.dump).is_file()
        || receipt.verified_at > SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs()
    {
        return None;
    }
    Some(receipt.verified_at)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_saved_destination_is_not_evidence_and_configuration_changes_invalidate_old_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let host = Host::new(temp.path());
        let project = Project::new(
            "base",
            &temp.path().join("projects/base"),
            crate::host::Runtime::Docker,
        );
        crate::private_fs::dir(&project.path("backups")).unwrap();
        crate::private_fs::write(host.secrets().path(), "NELCOTA_BACKUP_S3_BUCKET=original\n")
            .unwrap();
        crate::private_fs::write(&project.path(".env"), "IDENTITY=one\n").unwrap();
        assert_eq!(latest_verified(&host, &project), None);
        let dump = project.path("backups/nelcota-base-test.dump");
        crate::private_fs::write(&dump, "test").unwrap();
        record(&host, &project, &dump).unwrap();
        assert!(latest_verified(&host, &project).is_some());
        crate::private_fs::write(&project.path(".env"), "IDENTITY=recreated\n").unwrap();
        assert_eq!(latest_verified(&host, &project), None);
        record(&host, &project, &dump).unwrap();
        crate::private_fs::write(host.secrets().path(), "NELCOTA_BACKUP_S3_BUCKET=other\n")
            .unwrap();
        assert_eq!(latest_verified(&host, &project), None);
    }
}
