//! A completed workflow, not a dump mtime, is evidence of a successful backup.
use super::*;
use nelcota_deployment::{atomic_write, read_private, valid_digest};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ResultKind {
    Running,
    Succeeded,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Outcome {
    schema: u8,
    pub identity: Option<String>,
    attempt: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub last_success_at: Option<u64>,
    pub result: ResultKind,
}
pub(crate) fn prepare_directory(project: &Project) -> anyhow::Result<()> {
    let owner = fs::symlink_metadata(&project.dir)?;
    if !owner.is_dir() || owner.file_type().is_symlink() {
        bail!("unsafe backup project directory");
    }
    let dir = project.path("backups");
    match fs::symlink_metadata(&dir) {
        Ok(meta) => {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                bail!("unsafe backup outcome directory");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.uid() != owner.uid() || meta.mode() & 0o022 != 0 {
                    bail!("foreign backup outcome directory");
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    crate::private_fs::dir(&dir)?;
    Ok(())
}
fn path(project: &Project) -> PathBuf {
    project.path("backups/.last-outcome.json")
}
fn identity(project: &Project) -> anyhow::Result<Option<String>> {
    let file = project.path(".deployment-project-id");
    match fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
        Ok(_) => {
            let value = String::from_utf8(read_private(&file, 64)?)?;
            if !valid_digest(&value) {
                bail!("invalid backup project identity");
            }
            Ok(Some(value))
        }
    }
}
pub(crate) fn read(project: &Project) -> anyhow::Result<Option<Outcome>> {
    let file = path(project);
    match fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if fs::symlink_metadata(&file)?.uid() != fs::symlink_metadata(&project.dir)?.uid() {
            bail!("foreign backup outcome");
        }
    }
    let value: Outcome = serde_json::from_slice(&read_private(&file, 4096)?)?;
    if value.schema != 1 || !valid_digest(&value.attempt) {
        bail!("invalid backup outcome");
    }
    if value.identity != identity(project)? {
        return Ok(None);
    }
    Ok(Some(value))
}
impl Outcome {
    pub(crate) fn begin(project: &Project, now: u64) -> anyhow::Result<Self> {
        prepare_directory(project)?;
        let previous = read(project)?;
        let state = Self {
            schema: 1,
            identity: identity(project)?,
            attempt: nelcota_deployment::token()?,
            started_at: now,
            finished_at: None,
            last_success_at: previous.and_then(|v| v.last_success_at),
            result: ResultKind::Running,
        };
        state.save(project)?;
        Ok(state)
    }
    fn save(&self, project: &Project) -> anyhow::Result<()> {
        atomic_write(&path(project), &serde_json::to_vec(self)?)
    }
    pub(crate) fn finish(
        mut self,
        project: &Project,
        succeeded: bool,
        now: u64,
    ) -> anyhow::Result<()> {
        if read(project)?.is_none_or(|v| v.attempt != self.attempt) {
            bail!("backup outcome changed");
        }
        self.finished_at = Some(now);
        self.result = match succeeded {
            true => ResultKind::Succeeded,
            false => ResultKind::Failed,
        };
        if succeeded {
            self.last_success_at = Some(now);
        }
        self.save(project)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn project(root: &Path) -> Project {
        let p = Project::new("base", root, crate::host::Runtime::Docker);
        crate::private_fs::dir(&p.path("backups")).unwrap();
        p
    }
    #[test]
    fn partial_files_and_failed_workflows_never_advance_success_and_interruption_is_visible() {
        let temp = tempfile::tempdir().unwrap();
        let p = project(temp.path());
        fs::write(p.path("backups/partial.dump"), "partial").unwrap();
        assert!(read(&p).unwrap().is_none());
        Outcome::begin(&p, 10)
            .unwrap()
            .finish(&p, true, 11)
            .unwrap();
        Outcome::begin(&p, 12)
            .unwrap()
            .finish(&p, false, 13)
            .unwrap();
        let value = read(&p).unwrap().unwrap();
        assert_eq!(value.last_success_at, Some(11));
        assert_eq!(value.result, ResultKind::Failed);
        let interrupted = Outcome::begin(&p, 14).unwrap();
        assert_eq!(read(&p).unwrap().unwrap().result, ResultKind::Running);
        Outcome::begin(&p, 15)
            .unwrap()
            .finish(&p, true, 16)
            .unwrap();
        assert!(interrupted.finish(&p, true, 17).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a_symlinked_receipt_or_changed_project_is_rejected_without_touching_target() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let p = project(temp.path());
        let foreign = p.path("foreign");
        fs::write(&foreign, "keep").unwrap();
        symlink(&foreign, path(&p)).unwrap();
        assert!(Outcome::begin(&p, 1).is_err());
        assert_eq!(fs::read_to_string(&foreign).unwrap(), "keep");
        fs::remove_file(path(&p)).unwrap();
        Outcome::begin(&p, 1).unwrap().finish(&p, true, 2).unwrap();
        crate::private_fs::write(&p.path(".deployment-project-id"), "a".repeat(64)).unwrap();
        assert!(read(&p).unwrap().is_none());
        Outcome::begin(&p, 3).unwrap().finish(&p, true, 4).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_backup_directory_is_rejected_before_chmod_or_write() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        fs::set_permissions(foreign.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let p = Project::new("base", temp.path(), crate::host::Runtime::Docker);
        symlink(foreign.path(), p.path("backups")).unwrap();
        assert!(Outcome::begin(&p, 1).is_err());
        assert_eq!(
            fs::metadata(foreign.path()).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(fs::read_dir(foreign.path()).unwrap().count(), 0);
    }
}
