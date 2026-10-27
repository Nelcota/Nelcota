//! Routine actions reuse the host journal, lease, gates and explicit recovery.
use super::settings::{Prepared, Target};
use super::*;

fn target_path(policy: &Policy, target: &Target) -> anyhow::Result<std::path::PathBuf> {
    let path = match target {
        Target::Host => policy.root.join("host.env"),
        Target::Schedule => Path::new(crate::machine::BACKUP_CRON).to_path_buf(),
        Target::Project { name, identity } => {
            let p = control_project(policy, name)?;
            if read_private(&p.path(".deployment-project-id"), 64)? != identity.as_bytes() {
                bail!("configuration_project_changed");
            }
            p.path(".env")
        }
    };
    trusted_path(&path)?;
    Ok(path)
}
fn apply_files(
    policy: &Policy,
    prepared: &Prepared,
    rollback: bool,
    effects: &impl Effects,
) -> anyhow::Result<()> {
    // Validate ALL targets before changing the first one. A manual edit is never
    // overwritten during either recovery or rollback.
    let mut files = Vec::new();
    for edit in &prepared.edits {
        let path = target_path(policy, &edit.target)?;
        let current = read_private(&path, 65536)?;
        if current != edit.before.as_bytes() && current != edit.after.as_bytes() {
            bail!("configuration_changed_outside_operation");
        }
        files.push((
            path,
            match rollback {
                true => &edit.before,
                false => &edit.after,
            },
        ));
    }
    for (path, value) in files {
        atomic_write(&path, value.as_bytes())?;
        effects.configuration_checkpoint()?;
    }
    Ok(())
}
pub(crate) fn verify_prepared(policy: &Policy, prepared: &Prepared) -> anyhow::Result<()> {
    for edit in &prepared.edits {
        let path = target_path(policy, &edit.target)?;
        if read_private(&path, 65536)? != edit.before.as_bytes() {
            bail!("configuration_changed_after_review");
        }
    }
    for name in &prepared.restarts {
        let project = control_project(policy, name)?;
        crate::pitr::fence::require_clear(&project)?;
        if project.path(crate::maintenance::MARKER).exists() {
            bail!("maintenance_requires_recovery");
        }
    }
    Ok(())
}
fn configuration(
    policy: &Policy,
    journal: &HostJournal,
    task: &mut Task,
    effects: &impl Effects,
) -> anyhow::Result<()> {
    let dir = journal.directory(&task.public.id)?;
    let file = dir.join("configuration.private.json");
    trusted_path(&file)?;
    if Some(digest_file(&file, 4 * 1024 * 1024)?) != task.input_sha {
        bail!("configuration_receipt_changed");
    }
    let prepared: Prepared = serde_json::from_slice(&read_private(&file, 4 * 1024 * 1024)?)?;
    if !matches!(&task.public.operation, Operation::Configure { section, revision, .. } if section == &prepared.section && revision == &prepared.revision)
        || prepared.edits.is_empty()
        || prepared.edits.len() > 34
        || prepared.restarts.len() > 32
    {
        bail!("invalid_configuration_receipt");
    }
    settings::approve_services(policy, &prepared)?;
    for edit in &prepared.edits {
        let _path = target_path(policy, &edit.target)?;
    }
    let host = Host::new(&policy.root);
    let projects = prepared
        .restarts
        .iter()
        .map(|name| control_project(policy, name))
        .collect::<anyhow::Result<Vec<_>>>()?;
    for p in &projects {
        crate::pitr::fence::require_clear(p)?;
        if !task.public.changed {
            live::check_sync(p)?;
        }
    }
    let decision = dir.join("configuration-decision");
    let rollback = match decision.exists() {
        true => {
            trusted_path(&decision)?;
            if read_private(&decision, 32)? != b"rollback" {
                bail!("invalid_configuration_decision");
            }
            true
        }
        false => false,
    };
    // A persisted rollback decision wins over the interrupted phase, including
    // a cut while restoring files after verification had already begun.
    if task.public.stage == Stage::Verifying && !rollback {
        for edit in &prepared.edits {
            if read_private(&target_path(policy, &edit.target)?, 65536)? != edit.after.as_bytes() {
                bail!("configuration_changed_outside_operation");
            }
        }
        for p in &projects {
            p.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
        }
        for p in &projects {
            if p.path(crate::maintenance::MARKER).exists() {
                effects.resume(&host, p)?;
            }
        }
        return effects.finish(journal, task);
    }
    changed(journal, task, Stage::Applying)?;
    for p in &projects {
        effects.pause(&host, p)?;
        effects.configuration_checkpoint()?;
    }
    let apply = (|| -> anyhow::Result<()> {
        if rollback {
            bail!("configuration_rollback_pending");
        }
        apply_files(policy, &prepared, false, effects)?;
        if !projects.is_empty() {
            journal.advance(task, Stage::Starting, None)?;
        }
        for p in &projects {
            effects.restart(p)?;
            effects.configuration_checkpoint()?;
        }
        journal.advance(task, Stage::Verifying, None)?;
        for p in &projects {
            p.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
        }
        for p in &projects {
            effects.resume(&host, p)?;
            effects.configuration_checkpoint()?;
        }
        Ok(())
    })();
    if let Err(error) = apply {
        // Persist the recovery decision BEFORE restoring any config. No database
        // snapshot is ever replayed by a configuration rollback.
        atomic_write(&decision, b"rollback")?;
        for p in &projects {
            effects.pause(&host, p)?;
        }
        apply_files(policy, &prepared, true, effects)?;
        for p in &projects {
            effects.restart(p)?;
            p.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
        }
        for p in &projects {
            if p.path(crate::maintenance::MARKER).exists() {
                effects.resume(&host, p)?;
            }
        }
        journal.advance(task, Stage::RolledBack, Some("configuration_rolled_back"))?;
        // Recovering a recorded rollback succeeded. The original failed change
        // still returns its error; both paths expose the durable RolledBack result.
        return match rollback {
            true => Ok(()),
            false => Err(error),
        };
    }
    effects.configuration_checkpoint()?;
    effects.finish(journal, task)
}
pub(super) fn execute(
    policy: &Policy,
    journal: &HostJournal,
    task: &mut Task,
    effects: &impl Effects,
) -> anyhow::Result<()> {
    if matches!(task.public.operation, Operation::Configure { .. }) {
        return configuration(policy, journal, task, effects);
    }
    let host = Host::new(&policy.root);
    let target = control_project(policy, task.public.operation.project())?;
    require_identity(&target, task)?;
    crate::pitr::fence::require_clear(&target)?;
    match task.public.operation {
        Operation::Restart { .. } => {
            if !task.public.changed {
                live::check_sync(&target)?;
            }
            if task.public.stage == Stage::Verifying {
                target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
                if target.path(crate::maintenance::MARKER).exists() {
                    effects.resume(&host, &target)?;
                }
                return effects.finish(journal, task);
            }
            changed(journal, task, Stage::Starting)?;
            effects.pause(&host, &target)?;
            effects.restart(&target)?;
            journal.advance(task, Stage::Verifying, None)?;
            target.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)?;
            effects.resume(&host, &target)?;
        }
        Operation::BackupOffsite { .. } => {
            let endpoint = host
                .secrets()
                .get("NELCOTA_BACKUP_S3_ENDPOINT")?
                .context("offsite_not_configured")?;
            settings::approved_service(policy, &endpoint)?;
            if !endpoint.starts_with("https://") {
                bail!("offsite_https_required");
            }
            if task.public.backup.is_none() {
                journal.advance(task, Stage::BackingUp, None)?;
                let dump = backup::run(&host, &target, false, None)?;
                backup::validate(&dump)?;
                task.public.backup = Some(
                    dump.file_name()
                        .context("backup filename")?
                        .to_string_lossy()
                        .into_owned(),
                );
                journal.advance(task, Stage::BackingUp, None)?;
            }
            let dump = approved_backup(
                policy,
                &target.name,
                task.public
                    .backup
                    .as_deref()
                    .context("backup receipt missing")?,
            )?;
            let source = journal.directory(&task.public.id)?.join("offsite-source");
            let fingerprint = offsite_fingerprint(&dump)?;
            match source.exists() {
                true => {
                    trusted_path(&source)?;
                    if read_private(&source, 256)? != fingerprint.as_bytes() {
                        bail!("offsite_backup_changed");
                    }
                }
                false if !task.public.changed => atomic_write(&source, fingerprint.as_bytes())?,
                false => bail!("offsite_backup_identity_missing"),
            }
            changed(journal, task, Stage::Applying)?;
            backup::publish_remote(&host, &target, &dump)?;
            journal.advance(task, Stage::Verifying, None)?;
            backup::verify_copy(&host, &target, &dump).context("offsite_verification_failed")?;
        }
        Operation::TestBackup { .. } => {
            let endpoint = host
                .secrets()
                .get("NELCOTA_BACKUP_S3_ENDPOINT")?
                .context("offsite_not_configured")?;
            settings::approved_service(policy, &endpoint)?;
            if !endpoint.starts_with("https://") {
                bail!("offsite_https_required");
            }
            // Tests change no configuration: a definite failure (refused
            // credentials, an unreachable host) ends `failed` and never blocks
            // the change that fixes it. An interrupted test still waits for
            // recovery.
            journal.advance(task, Stage::Applying, None)?;
            backup::test_remote(&host, &journal.directory(&task.public.id)?, &task.public.id)
                .context("backup_test_failed")?;
            journal.advance(task, Stage::Verifying, None)?;
        }
        Operation::TestAlerts { .. } => {
            journal.advance(task, Stage::Applying, None)?;
            super::super::alerts::test(policy)?;
            journal.advance(task, Stage::Verifying, None)?;
        }
        Operation::TestSmtp { .. } => {
            use nelcota_auth::Mailer;
            let url = target
                .env()
                .get("NELCOTA_SMTP_URL")?
                .context("smtp_not_configured")?;
            let from = target
                .env()
                .get("NELCOTA_SMTP_FROM")?
                .context("smtp_not_configured")?;
            settings::approved_service(policy, &url)?;
            let mailer =
                nelcota_auth::SmtpMailer::new(&url, &from).context("invalid_smtp_configuration")?;
            let to = nelcota_auth::normalize_email(&task.actor)
                .map_err(|error| anyhow::anyhow!(error.0))
                .context("invalid_operator_email")?;
            journal.advance(task, Stage::Applying, None)?;
            tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(async {
                tokio::time::timeout(Duration::from_secs(20), mailer.send(nelcota_auth::Email { to, subject: "Nelcota SMTP configuration test".into(), text: "The configured SMTP server accepted this operator-requested test message. This does not certify inbox delivery.".into() })).await.context("smtp_test_timeout")?.context("smtp_test_failed")
            })?;
            journal.advance(task, Stage::Verifying, None)?;
        }
        _ => bail!("invalid routine action"),
    }
    effects.finish(journal, task)
}

fn offsite_fingerprint(dump: &Path) -> anyhow::Result<String> {
    Ok(format!(
        "{}:{}",
        digest_file(dump, u64::MAX - 1)?,
        backup_identity(dump)?
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offsite_recovery_identity_covers_dump_bytes_as_well_as_the_file_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let dump = temp.path().join("fixture.dump");
        let bundle = backup::bundle_path(&dump).unwrap();
        fs::create_dir(&bundle).unwrap();
        fs::write(bundle.join("manifest.json"), b"original manifest").unwrap();
        fs::write(&dump, b"first dump").unwrap();
        let original = offsite_fingerprint(&dump).unwrap();
        fs::write(&dump, b"second dump").unwrap();
        assert_ne!(offsite_fingerprint(&dump).unwrap(), original);
        fs::write(&dump, b"first dump").unwrap();
        fs::write(bundle.join("manifest.json"), b"changed manifest").unwrap();
        assert_ne!(offsite_fingerprint(&dump).unwrap(), original);
    }
}
