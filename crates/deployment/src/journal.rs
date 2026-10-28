use crate::{atomic_write, private_dir, read_private, token, valid_digest, valid_project};
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Preparing,
    Pausing,
    Capturing,
    BackupVerified,
    Activating,
    Validating,
    Committing,
    Succeeded,
    Recovering,
    ResumingPrevious,
    Recovered,
    FailedBeforeChange,
    NeedsOperator,
}
impl Phase {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Recovered | Self::FailedBeforeChange
        )
    }
    fn allows(self, next: Self) -> bool {
        use Phase::*;
        matches!(
            (self, next),
            (Preparing, Pausing)
                | (Preparing, FailedBeforeChange)
                | (Pausing, Capturing)
                | (Capturing, BackupVerified)
                | (BackupVerified, Activating)
                | (Activating, Validating)
                | (Validating, Committing)
                | (Committing, Succeeded)
                | (Recovering, ResumingPrevious)
                | (ResumingPrevious, Recovered)
                | (NeedsOperator, ResumingPrevious)
                | (NeedsOperator, Committing)
        ) || (matches!(self, NeedsOperator | Recovering) && next == FailedBeforeChange)
            || (!self.terminal() && next == NeedsOperator)
            || (!self.terminal() && next == Recovering && self != Committing)
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct PublicJob {
    #[cfg_attr(feature = "schema", schemars(pattern(crate::schema::DIGEST)))]
    pub id: String,
    #[cfg_attr(feature = "schema", schemars(length(max = crate::schema::TEXT_MAX)))]
    pub project: String,
    #[cfg_attr(feature = "schema", schemars(length(max = crate::schema::TEXT_MAX)))]
    pub current: String,
    #[cfg_attr(feature = "schema", schemars(length(max = crate::schema::TEXT_MAX)))]
    pub target: String,
    pub phase: Phase,
    #[cfg_attr(feature = "schema", schemars(range(min = 1)))]
    pub sequence: u64,
    pub updated_at: u64,
    pub committed: bool,
    #[cfg_attr(feature = "schema", schemars(length(max = crate::schema::TEXT_MAX)))]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Job {
    pub schema: u32,
    pub public: PublicJob,
    pub actor: String,
    pub request_key: String,
    pub fingerprint: String,
    pub backup: Option<String>,
    pub dump_sha256: Option<String>,
    pub interrupted_phase: Option<Phase>,
    pub migration_version: u32,
    pub previous_config_sha256: Option<String>,
    pub target_binary_sha256: Option<String>,
    pub previous_image: Option<String>,
    pub target_image: Option<String>,
    pub previous_binary: Option<String>,
    pub expected_env_sha256: Option<String>,
    pub manifest_sha256: Option<String>,
    pub files_manifest_sha256: Option<String>,
    pub restored: bool,
    /// Explicit SSH operator decision to discard writes accepted after commit.
    #[serde(default, skip_serializing_if = "no_restore_requested")]
    pub restore_requested: bool,
}

fn no_restore_requested(requested: &bool) -> bool {
    !requested
}
pub struct HostLock {
    _file: File,
}
impl HostLock {
    pub fn acquire(root: &Path) -> anyhow::Result<Self> {
        let path = root.join(".deployment.lock");
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            bail!("unsafe deployment lock");
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path)?;
        file.try_lock()
            .map_err(|_| anyhow::anyhow!("deployment_busy"))?;
        Ok(Self { _file: file })
    }
}
pub struct Journal {
    root: PathBuf,
}
impl Journal {
    pub fn open(host: &Path) -> anyhow::Result<Self> {
        let root = host.join("updates/jobs");
        private_dir(&root)?;
        Ok(Self { root })
    }
    pub fn directory(&self, id: &str) -> anyhow::Result<PathBuf> {
        if !valid_digest(id) {
            bail!("invalid job id");
        }
        Ok(self.root.join(id))
    }
    pub fn list(&self) -> anyhow::Result<Vec<Job>> {
        let mut jobs = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if !valid_digest(&id) {
                continue;
            }
            if jobs.len() >= 256 {
                bail!("deployment_history_full");
            }
            let path = self.directory(&id)?;
            if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                bail!("unsafe job directory");
            }
            let job: Job = serde_json::from_slice(&read_private(&path.join("job.json"), 16384)?)?;
            if job.schema != 1 || job.public.id != id || !valid_project(&job.public.project) {
                bail!("invalid deployment journal");
            }
            validate_job(&job)?;
            jobs.push(job);
        }
        jobs.sort_by_key(|job| {
            (
                job.public.phase.terminal(),
                std::cmp::Reverse(job.public.updated_at),
                std::cmp::Reverse(job.public.sequence),
            )
        });
        Ok(jobs)
    }
    pub fn save(&self, job: &Job) -> anyhow::Result<()> {
        validate_job(job)?;
        let dir = self.directory(&job.public.id)?;
        private_dir(&dir)?;
        let path = dir.join("job.json");
        // Callers hold the host lease. Compare the authoritative receipt too:
        // rename may have succeeded even when the caller observed an fsync error.
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let previous: Job = serde_json::from_slice(&read_private(&path, 16384)?)?;
                validate_job(&previous)?;
                if previous.public.id != job.public.id
                    || previous.public.project != job.public.project
                    || previous.public.current != job.public.current
                    || previous.public.target != job.public.target
                    || previous.actor != job.actor
                    || previous.request_key != job.request_key
                    || previous.fingerprint != job.fingerprint
                    || previous.public.sequence > job.public.sequence
                    || (previous.public.sequence == job.public.sequence
                        && previous.public != job.public)
                    || (previous.public.committed && !job.public.committed)
                    || (previous.restored && !job.restored)
                    || (previous.restore_requested && !job.restore_requested)
                    || (previous.public.phase.terminal()
                        && previous.public.phase != job.public.phase)
                {
                    bail!("stale deployment receipt");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        atomic_write(&path, &serde_json::to_vec(job)?)
    }
    pub fn begin(
        &self,
        project: &str,
        current: &str,
        target: &str,
        actor: &str,
        key: &str,
        fingerprint: &str,
    ) -> anyhow::Result<Job> {
        if !valid_project(project) || !valid_digest(key) || !valid_digest(fingerprint) {
            bail!("invalid deployment request");
        }
        let jobs = self.list()?;
        if let Some(job) = jobs.iter().find(|job| job.request_key == key) {
            if job.fingerprint != fingerprint
                || job.actor != actor
                || job.public.project != project
                || job.public.target != target
            {
                bail!("idempotency_conflict");
            }
            return Ok(job.clone());
        }
        if jobs.len() >= 255 {
            bail!("deployment_history_full");
        }
        if jobs.iter().any(|job| !job.public.phase.terminal()) {
            bail!("deployment_busy");
        }
        let job = Job {
            schema: 1,
            public: PublicJob {
                id: token()?,
                project: project.into(),
                current: current.into(),
                target: target.into(),
                phase: Phase::Preparing,
                sequence: 1,
                updated_at: now()?,
                committed: false,
                error: None,
            },
            actor: actor.into(),
            request_key: key.into(),
            fingerprint: fingerprint.into(),
            interrupted_phase: None,
            migration_version: 0,
            previous_config_sha256: None,
            target_binary_sha256: None,
            backup: None,
            dump_sha256: None,
            previous_image: None,
            target_image: None,
            previous_binary: None,
            expected_env_sha256: None,
            manifest_sha256: None,
            files_manifest_sha256: None,
            restored: false,
            restore_requested: false,
        };
        self.save(&job)?;
        Ok(job)
    }
    pub fn advance(&self, job: &mut Job, phase: Phase, error: Option<&str>) -> anyhow::Result<()> {
        if !job.public.phase.allows(phase)
            || (job.public.committed && phase == Phase::Recovering && !job.restore_requested)
            || (phase == Phase::Committing
                && job.public.phase == Phase::NeedsOperator
                && !job.public.committed)
        {
            bail!("invalid deployment transition");
        }
        if phase == Phase::FailedBeforeChange
            && job.public.phase != Phase::Preparing
            && (job.public.committed
                || (job.interrupted_phase != Some(Phase::Preparing)
                    && !(job.backup.is_none() && job.dump_sha256.is_none() && job.restored)))
        {
            bail!("unsafe preparation failure");
        }
        if phase == Phase::ResumingPrevious && !job.restored {
            bail!("previous state was not restored");
        }
        let mut next = job.clone();
        if phase == Phase::Recovering && job.public.phase != Phase::NeedsOperator {
            next.interrupted_phase = Some(job.public.phase);
        }
        if phase == Phase::NeedsOperator
            && job.public.phase != Phase::NeedsOperator
            && !(job.public.phase == Phase::Recovering && job.interrupted_phase.is_some())
        {
            next.interrupted_phase = Some(job.public.phase);
        }
        next.public.phase = phase;
        next.public.sequence = job
            .public
            .sequence
            .checked_add(1)
            .context("deployment sequence overflow")?;
        next.public.updated_at = now()?;
        next.public.error = error.map(str::to_owned);
        if matches!(phase, Phase::Committing | Phase::ResumingPrevious) {
            next.public.committed = true;
        }
        self.save(&next)?;
        *job = next;
        Ok(())
    }
    pub fn reconcile(&self) -> anyhow::Result<()> {
        for mut job in self.list()? {
            if !job.public.phase.terminal() && job.public.phase != Phase::NeedsOperator {
                self.advance(&mut job, Phase::NeedsOperator, Some("worker_interrupted"))?;
            }
        }
        Ok(())
    }
}
fn now() -> anyhow::Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

fn validate_job(job: &Job) -> anyhow::Result<()> {
    if job.schema != 1
        || !valid_digest(&job.public.id)
        || !valid_project(&job.public.project)
        || !valid_digest(&job.request_key)
        || !valid_digest(&job.fingerprint)
        || job.public.sequence == 0
        || job.actor.is_empty()
        || job.actor.len() > 254
    {
        bail!("invalid job identity");
    }
    let current = semver::Version::parse(&job.public.current)?;
    let target = semver::Version::parse(&job.public.target)?;
    if target <= current || !target.pre.is_empty() || !target.build.is_empty() {
        bail!("invalid job version");
    }
    for digest in [
        &job.expected_env_sha256,
        &job.manifest_sha256,
        &job.previous_config_sha256,
        &job.target_binary_sha256,
        &job.previous_binary,
        &job.dump_sha256,
        &job.files_manifest_sha256,
    ]
    .into_iter()
    .flatten()
    {
        if !valid_digest(digest) {
            bail!("invalid job receipt");
        }
    }
    if job
        .previous_image
        .as_deref()
        .is_some_and(|image| !image.strip_prefix("sha256:").is_some_and(valid_digest))
        || job.target_image.as_deref().is_some_and(|image| {
            !image
                .strip_prefix("ghcr.io/nelcota/nelcota-server@sha256:")
                .is_some_and(valid_digest)
        })
    {
        bail!("invalid image receipt");
    }
    let phase = match job.public.phase {
        Phase::NeedsOperator => job.interrupted_phase.context("missing interrupted stage")?,
        phase => phase,
    };
    if matches!(
        phase,
        Phase::Pausing
            | Phase::Capturing
            | Phase::BackupVerified
            | Phase::Activating
            | Phase::Validating
            | Phase::Committing
            | Phase::Succeeded
            | Phase::ResumingPrevious
            | Phase::Recovered
    ) && (job.previous_config_sha256.is_none()
        || job.target_binary_sha256.is_none()
        || job.expected_env_sha256.is_none()
        || job.manifest_sha256.is_none()
        || job.migration_version == 0
        || (job.previous_image.is_none() && job.previous_binary.is_none()))
    {
        bail!("incomplete preparation receipt");
    }
    if matches!(
        phase,
        Phase::BackupVerified
            | Phase::Activating
            | Phase::Validating
            | Phase::Committing
            | Phase::Succeeded
    ) && (job.backup.is_none() || job.dump_sha256.is_none())
    {
        bail!("incomplete backup receipt");
    }
    if matches!(
        phase,
        Phase::Committing | Phase::Succeeded | Phase::ResumingPrevious | Phase::Recovered
    ) && !job.public.committed
    {
        bail!("missing irreversible decision");
    }
    if matches!(phase, Phase::ResumingPrevious | Phase::Recovered) && !job.restored {
        bail!("missing restored-state decision");
    }
    if job.restore_requested
        && (!job.public.committed || job.backup.is_none() || job.dump_sha256.is_none())
    {
        bail!("incomplete operator restore decision");
    }
    if job.public.committed && job.public.phase == Phase::Recovering && !job.restore_requested {
        bail!("committed recovery cannot restore old data");
    }
    Ok(())
}
