//! Host management receipts and browser-safe contracts; runtime effects live in CLI.
use crate::{Journal, atomic_write, private_dir, read_private, valid_digest, valid_project};
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Create {
        project: String,
        domain: String,
        profile: String,
    },
    Backup {
        project: String,
    },
    Restore {
        project: String,
        backup: String,
    },
    Remove {
        project: String,
    },
    Restart {
        project: String,
    },
    BackupOffsite {
        project: String,
    },
    TestSmtp {
        project: String,
    },
    TestBackup {
        project: String,
    },
    Configure {
        project: String,
        section: crate::operations::Section,
        revision: String,
    },
}
impl Operation {
    pub fn project(&self) -> &str {
        match self {
            Self::Create { project, .. }
            | Self::Backup { project }
            | Self::Restore { project, .. }
            | Self::Remove { project }
            | Self::Restart { project }
            | Self::BackupOffsite { project }
            | Self::TestSmtp { project }
            | Self::TestBackup { project }
            | Self::Configure { project, .. } => project,
        }
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        if let Self::Configure { revision, .. } = self
            && !valid_digest(revision)
        {
            bail!("invalid configuration review");
        }
        if !valid_project(self.project())
            || self.project().starts_with('-')
            || self.project().ends_with('-')
        {
            bail!("invalid project");
        }
        if let Self::Create {
            domain, profile, ..
        } = self
            && (domain.parse::<std::net::IpAddr>().is_ok()
                || domain.len() > 253
                || !domain.contains('.')
                || domain.split('.').any(|part| {
                    part.is_empty()
                        || part.len() > 63
                        || part.starts_with('-')
                        || part.ends_with('-')
                        || !part
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
                || !["1gb", "2gb", "4gb", "8gb"].contains(&profile.as_str()))
        {
            bail!("invalid creation request");
        }
        if let Self::Restore { backup, .. } = self
            && !valid_backup(backup)
        {
            bail!("invalid backup selection");
        }
        Ok(())
    }
    pub fn destructive(&self) -> bool {
        matches!(self, Self::Remove { .. } | Self::Restore { .. })
    }
    pub fn requires_backup(&self) -> bool {
        matches!(
            self,
            Self::Backup { .. }
                | Self::BackupOffsite { .. }
                | Self::Restore { .. }
                | Self::Remove { .. }
        )
    }
    pub fn confirmation(&self) -> String {
        format!(
            "{} {}",
            match self {
                Self::Create { .. } => "CREATE",
                Self::Backup { .. } => "BACKUP",
                Self::Restore { .. } => "RESTORE",
                Self::Remove { .. } => "REMOVE",
                Self::Restart { .. } => "RESTART",
                Self::BackupOffsite { .. } => "BACKUP_OFFSITE",
                Self::TestSmtp { .. } => "TEST_SMTP",
                Self::TestBackup { .. } => "TEST_BACKUP",
                Self::Configure { .. } => "CONFIGURE",
            },
            self.project()
        )
    }
}
pub fn valid_backup(value: &str) -> bool {
    value.len() <= 200
        && value.ends_with(".dump")
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Accepted,
    Validating,
    Provisioning,
    Starting,
    BackingUp,
    Applying,
    Verifying,
    Completed,
    RolledBack,
    Failed,
    NeedsAttention,
}
impl Stage {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::RolledBack)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    #[serde(default)]
    pub affected_projects: Vec<String>,
    pub confirmation: String,
    pub id: String,
    pub operation: Operation,
    pub expires_at: u64,
    pub version: String,
    pub image_digest: String,
    pub blockers: Vec<String>,
    pub ram_mb: u64,
    pub free_bytes: u64,
    pub project_count: usize,
    pub destructive: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicJob {
    #[serde(default)]
    pub affected_projects: Vec<String>,
    pub last_stage: Option<Stage>,
    pub request_key: String,
    pub id: String,
    pub operation: Operation,
    pub stage: Stage,
    pub sequence: u64,
    pub updated_at: u64,
    pub changed: bool,
    pub backup: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub schema: u32,
    pub public: PublicJob,
    pub actor: String,
    pub key: String,
    pub plan: String,
    pub manifest_sha: String,
    pub env_sha: Option<String>,
    pub identity: String,
    pub backup_sha: Option<String>,
    pub version: String,
    pub image_digest: String,
    pub interrupted: Option<Stage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_env_sha: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub name: String,
    pub domain: String,
    pub version: String,
    pub app: String,
    pub database: String,
    pub backups: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub receipt: Option<PublicJob>,
    pub enabled: bool,
    #[serde(default)]
    pub busy: bool,
    pub projects: Vec<Project>,
    pub jobs: Vec<PublicJob>,
    pub max_projects: usize,
    pub ram_mb: u64,
    pub free_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub target: String,
    pub message: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogService {
    App,
    Database,
}
pub fn now() -> anyhow::Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

pub struct HostJournal {
    root: PathBuf,
}
impl HostJournal {
    pub fn open(host: &Path) -> anyhow::Result<Self> {
        let root = host.join("updates/host-jobs");
        private_dir(&root)?;
        Ok(Self { root })
    }
    pub fn directory(&self, id: &str) -> anyhow::Result<PathBuf> {
        if !valid_digest(id) {
            bail!("invalid host job");
        }
        Ok(self.root.join(id))
    }
    pub fn list(&self) -> anyhow::Result<Vec<Task>> {
        let mut tasks = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            if tasks.len() >= 256 {
                bail!("host history full");
            }
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().into_owned();
            let dir = self.directory(&id)?;
            if fs::symlink_metadata(&dir)?.file_type().is_symlink() {
                bail!("unsafe host receipt");
            }
            let task: Task = serde_json::from_slice(&read_private(&dir.join("task.json"), 16384)?)?;
            Self::validate(&task)?;
            if task.public.id != id {
                bail!("host receipt identity mismatch");
            }
            tasks.push(task);
        }
        tasks.sort_by_key(|task| {
            (
                task.public.stage.terminal(),
                std::cmp::Reverse(task.public.updated_at),
                std::cmp::Reverse(task.public.sequence),
            )
        });
        Ok(tasks)
    }
    fn validate(task: &Task) -> anyhow::Result<()> {
        task.public.operation.validate()?;
        if task.schema != 1
            || !valid_digest(&task.image_digest)
            || semver::Version::parse(&task.version).is_err()
            || (task.public.stage == Stage::Failed && task.public.changed)
            || (task.public.stage == Stage::NeedsAttention && task.interrupted.is_none())
            || (task.public.stage == Stage::Completed
                && task.public.operation.requires_backup()
                && task.public.backup.is_none())
            || (task.public.stage == Stage::RolledBack
                && (!task.public.changed
                    || !matches!(task.public.operation, Operation::Configure { .. })))
            || task.public.affected_projects.len() > 32
            || task
                .public
                .affected_projects
                .iter()
                .any(|p| !valid_project(p))
            || task
                .public
                .affected_projects
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != task.public.affected_projects.len()
            || task.public.request_key != task.key
            || !valid_digest(&task.public.id)
            || !valid_digest(&task.key)
            || !valid_digest(&task.plan)
            || !valid_digest(&task.identity)
            || !valid_digest(&task.manifest_sha)
            || task.public.sequence == 0
            || task.actor.is_empty()
            || task.actor.len() > 254
            || task.env_sha.as_ref().is_some_and(|s| !valid_digest(s))
            || task.backup_sha.as_ref().is_some_and(|s| !valid_digest(s))
            || task.input_sha.as_ref().is_some_and(|s| !valid_digest(s))
            || task.host_env_sha.as_ref().is_some_and(|s| !valid_digest(s))
            || (matches!(task.public.operation, Operation::Configure { .. })
                && task.input_sha.is_none())
            || task
                .public
                .backup
                .as_ref()
                .is_some_and(|s| !valid_backup(s))
            || task.public.error.as_ref().is_some_and(|s| s.len() > 128)
        {
            bail!("invalid host receipt");
        }
        Ok(())
    }
    pub fn save(&self, task: &Task) -> anyhow::Result<()> {
        Self::validate(task)?;
        let dir = self.directory(&task.public.id)?;
        private_dir(&dir)?;
        let path = dir.join("task.json");
        if path.exists() {
            let old: Task = serde_json::from_slice(&read_private(&path, 16384)?)?;
            Self::validate(&old)?;
            if old.public.affected_projects != task.public.affected_projects
                || old.public.operation != task.public.operation
                || old.key != task.key
                || old.actor != task.actor
                || old.plan != task.plan
                || old.identity != task.identity
                || old.manifest_sha != task.manifest_sha
                || old.env_sha != task.env_sha
                || old.backup_sha != task.backup_sha
                || old.input_sha != task.input_sha
                || old.host_env_sha != task.host_env_sha
                || old.version != task.version
                || old.image_digest != task.image_digest
                || old.public.sequence >= task.public.sequence
                || (old.public.changed && !task.public.changed)
                || old.public.stage.terminal()
            {
                bail!("stale host receipt");
            }
        }
        atomic_write(&path, &serde_json::to_vec(task)?)
    }
    pub fn begin(&self, task: Task, host: &Path) -> anyhow::Result<Task> {
        let tasks = self.list()?;
        if let Some(old) = tasks.iter().find(|t| t.key == task.key) {
            if old.actor != task.actor || old.plan != task.plan {
                bail!("idempotency conflict");
            }
            return Ok(old.clone());
        }
        if tasks.len() >= 255
            || tasks.iter().any(|t| !t.public.stage.terminal())
            || Journal::open(host)?
                .list()?
                .iter()
                .any(|j| !j.public.phase.terminal())
        {
            bail!("host operation busy");
        }
        self.save(&task)?;
        Ok(task)
    }
    pub fn advance(
        &self,
        task: &mut Task,
        stage: Stage,
        error: Option<&str>,
    ) -> anyhow::Result<()> {
        if task.public.stage.terminal() {
            bail!("host operation is terminal");
        }
        if stage == Stage::Failed && task.public.changed {
            bail!("uncertain effects need operator attention");
        }
        if stage == Stage::NeedsAttention
            && task.public.stage != Stage::NeedsAttention
            && !(task.public.stage == Stage::Accepted && task.interrupted.is_some())
        {
            task.interrupted = Some(task.public.stage);
        }
        if stage == Stage::NeedsAttention {
            task.public.last_stage = task.interrupted;
        }
        task.public.stage = stage;
        task.public.error = error.map(str::to_owned);
        task.public.sequence = task
            .public
            .sequence
            .checked_add(1)
            .context("receipt sequence overflow")?;
        task.public.updated_at = now()?;
        self.save(task)
    }
    pub fn reconcile(&self) -> anyhow::Result<()> {
        for mut task in self
            .list()?
            .into_iter()
            .filter(|t| !t.public.stage.terminal() && t.public.stage != Stage::NeedsAttention)
        {
            self.advance(&mut task, Stage::NeedsAttention, Some("worker_interrupted"))?;
        }
        Ok(())
    }
}
pub fn ensure_idle(host: &Path) -> anyhow::Result<()> {
    if HostJournal::open(host)?
        .list()?
        .iter()
        .any(|t| !t.public.stage.terminal())
    {
        bail!("host management needs recovery");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> Task {
        let key = crate::token().unwrap();
        Task {
            schema: 1,
            public: PublicJob {
                affected_projects: vec!["shop".into()],
                last_stage: None,
                id: crate::token().unwrap(),
                request_key: key.clone(),
                operation: Operation::Backup {
                    project: "shop".into(),
                },
                stage: Stage::Accepted,
                sequence: 1,
                updated_at: now().unwrap(),
                changed: false,
                backup: None,
                error: None,
            },
            actor: "operator@example.test".into(),
            key,
            plan: crate::token().unwrap(),
            manifest_sha: crate::token().unwrap(),
            env_sha: Some(crate::token().unwrap()),
            identity: crate::token().unwrap(),
            backup_sha: None,
            version: "0.4.0".into(),
            image_digest: crate::token().unwrap(),
            interrupted: None,
            input_sha: None,
            host_env_sha: None,
        }
    }
    #[test]
    fn the_affected_project_scope_cannot_be_rewritten_during_recovery() {
        let root = tempfile::tempdir().unwrap();
        let journal = HostJournal::open(root.path()).unwrap();
        let mut original = journal.begin(task(), root.path()).unwrap();
        original.public.sequence += 1;
        original.public.affected_projects = vec!["foreign".into()];
        assert!(journal.save(&original).is_err());
    }
    #[test]
    fn duplicates_do_not_repeat_effects_and_journals_exclude_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let journal = HostJournal::open(dir.path()).unwrap();
        let first = journal.begin(task(), dir.path()).unwrap();
        let duplicate = journal.begin(first.clone(), dir.path()).unwrap();
        assert_eq!(duplicate.public.id, first.public.id);
        assert!(journal.begin(task(), dir.path()).is_err());
        let other = tempfile::tempdir().unwrap();
        Journal::open(other.path())
            .unwrap()
            .begin(
                "shop",
                "0.4.0",
                "0.5.0",
                "operator@example.test",
                &crate::token().unwrap(),
                &crate::token().unwrap(),
            )
            .unwrap();
        assert!(
            HostJournal::open(other.path())
                .unwrap()
                .begin(task(), other.path())
                .is_err()
        );
    }
    #[test]
    fn interrupted_changes_fail_closed_and_terminal_receipts_cannot_regress() {
        let dir = tempfile::tempdir().unwrap();
        let journal = HostJournal::open(dir.path()).unwrap();
        let mut first = journal.begin(task(), dir.path()).unwrap();
        first.public.changed = true;
        journal.advance(&mut first, Stage::BackingUp, None).unwrap();
        assert!(journal.advance(&mut first, Stage::Failed, None).is_err());
        journal.reconcile().unwrap();
        let mut first = journal.list().unwrap().remove(0);
        assert_eq!(first.public.stage, Stage::NeedsAttention);
        assert_eq!(first.interrupted, Some(Stage::BackingUp));
        first.public.backup = Some("nelcota-shop-check.dump".into());
        journal.advance(&mut first, Stage::Verifying, None).unwrap();
        journal.advance(&mut first, Stage::Completed, None).unwrap();
        assert!(journal.advance(&mut first, Stage::Applying, None).is_err());
    }
    #[test]
    fn modified_approval_cannot_overwrite_an_existing_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let journal = HostJournal::open(dir.path()).unwrap();
        let mut first = journal.begin(task(), dir.path()).unwrap();
        first.public.sequence += 1;
        first.public.operation = Operation::Remove {
            project: "shop".into(),
        };
        assert!(journal.save(&first).is_err());
        assert!(matches!(
            journal.list().unwrap()[0].public.operation,
            Operation::Backup { .. }
        ));
    }
    #[test]
    fn the_approved_backup_digest_cannot_change_during_progress() {
        let dir = tempfile::tempdir().unwrap();
        let journal = HostJournal::open(dir.path()).unwrap();
        let mut original = task();
        original.public.operation = Operation::Restore {
            project: "shop".into(),
            backup: "nelcota-shop-approved.dump".into(),
        };
        original.backup_sha = Some(crate::token().unwrap());
        let mut changed = journal.begin(original.clone(), dir.path()).unwrap();
        changed.public.sequence += 1;
        changed.backup_sha = Some(crate::token().unwrap());
        assert!(journal.save(&changed).is_err());
        assert_eq!(journal.list().unwrap()[0].backup_sha, original.backup_sha);
    }
    #[test]
    fn repeated_interruption_and_failed_launch_preserve_the_restore_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let journal = HostJournal::open(dir.path()).unwrap();
        let mut t = journal.begin(task(), dir.path()).unwrap();
        t.public.changed = true;
        journal.advance(&mut t, Stage::Verifying, None).unwrap();
        journal
            .advance(&mut t, Stage::NeedsAttention, Some("first"))
            .unwrap();
        journal
            .advance(&mut t, Stage::NeedsAttention, Some("repeated"))
            .unwrap();
        assert_eq!(t.interrupted, Some(Stage::Verifying));
        journal.advance(&mut t, Stage::Accepted, None).unwrap();
        journal
            .advance(&mut t, Stage::NeedsAttention, Some("launch_failed"))
            .unwrap();
        assert_eq!(t.interrupted, Some(Stage::Verifying));
    }
    #[test]
    fn reject_paths_and_injected_domains() {
        for name in ["../x.dump", "/x.dump", "--x.dump", "x\\y.dump"] {
            assert!(!valid_backup(name));
        }
        for domain in [
            "x.test\nadmin",
            "https://x.test",
            "x.test:443",
            "*.test",
            "127.0.0.1",
        ] {
            let op = Operation::Create {
                project: "shop".into(),
                domain: domain.into(),
                profile: "1gb".into(),
            };
            assert!(op.validate().is_err());
        }
    }
}
