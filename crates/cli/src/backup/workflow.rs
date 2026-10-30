//! Backup, retention and restore sequencing for a project.
use super::remote::{sync_files_down, sync_files_up, upload_s3};
use crate::{
    host::Host,
    lifecycle::HEALTH_TIMEOUT,
    maintenance::Maintenance,
    project::{Project, Service},
    util::{self, ok, step},
};
use anyhow::{Context, bail};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};
/// `pg_dump -Fc` as the postgres user, written to `backups/`.
pub fn backup(
    host: &Host,
    project: &Project,
    upload: bool,
    keep: Option<usize>,
) -> anyhow::Result<PathBuf> {
    let receipt = super::outcome::Outcome::begin(project, nelcota_deployment::management::now()?)?;
    let result = backup_inner(host, project, upload, keep);
    let recorded = receipt.finish(
        project,
        result.is_ok(),
        nelcota_deployment::management::now()?,
    );
    match (result, recorded) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => {
            Err(error).context("backup completed but its outcome could not be recorded")
        }
        (Err(error), Err(record)) => Err(error).context(format!(
            "backup failed; recording its outcome also failed: {record}"
        )),
    }
}
fn backup_inner(
    host: &Host,
    project: &Project,
    upload: bool,
    keep: Option<usize>,
) -> anyhow::Result<PathBuf> {
    let dir = project.path("backups");
    let name = format!(
        "nelcota-{}-{}-{}.dump",
        project.name,
        util::timestamp(),
        util::secret(6)
    );
    let path = dir.join(&name);
    step(&format!("Backup of {}: {name}", project.name));

    if let Err(error) = sweep_interrupted(&dir) {
        util::warn(&format!(
            "could not remove interrupted backup leftovers: {error:#}"
        ));
    }
    crate::backup::capture(project, &path)?;
    let size = fs::metadata(&path)?.len();
    ok(&format!("{} ({} KB)", path.display(), size / 1024));

    if upload {
        // Publish the immutable file snapshot before making its dump available.
        sync_files_up(host, project, &path)?;
        upload_s3(host, &project.name, &path, &name)?;
        crate::backup::verify_copy(host, project, &path)?;
    }
    if let Some(keep) = keep {
        prune(&dir, keep)?;
    }
    Ok(path)
}

/// Removes what an interrupted backup leaves behind: its partial dump, a file
/// snapshot whose dump never completed, and verification scratch directories
/// (they hold a copy of the project's `.env`). Every caller of [`backup`] holds
/// the host deployment lease, so none of these can belong to a running backup.
fn sweep_interrupted(dir: &Path) -> anyhow::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(name) => name,
            None => continue,
        };
        // DirEntry::file_type does not follow links: a link is removed, never its target.
        let kind = entry.file_type()?;
        let stale = name.ends_with(".dump.partial")
            || kind.is_dir() && name.starts_with(".tmp")
            || name
                .strip_suffix(".files")
                .is_some_and(|dump| dump.ends_with(".dump") && !dir.join(dump).exists());
        if !stale {
            continue;
        }
        let path = entry.path();
        match kind.is_dir() {
            true => fs::remove_dir_all(&path)?,
            false => fs::remove_file(&path)?,
        }
        ok(&format!(
            "removed interrupted backup leftover {}",
            path.display()
        ));
    }
    Ok(())
}

/// When the newest local dump of the project was written.
pub(crate) fn latest(project: &Project) -> Option<std::time::SystemTime> {
    fs::read_dir(project.path("backups"))
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "dump"))
        .filter_map(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
        .max()
}

pub(crate) fn prune(dir: &Path, keep: usize) -> anyhow::Result<()> {
    let mut dumps: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "dump"))
        .collect();
    // Random suffixes avoid same-second collisions; use file time for retention.
    dumps.sort_by_cached_key(|path| {
        (
            fs::metadata(path)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH),
            path.clone(),
        )
    });
    let excess = dumps.len().saturating_sub(keep);
    for old in dumps.into_iter().take(excess) {
        crate::backup::remove_bundle(&old)?;
        fs::remove_file(&old)?;
        ok(&format!("removed {}", old.display()));
    }
    Ok(())
}

/// Restores a dump: closes the maintenance gate, stops the app, takes a
/// safety backup of the current state, recreates the objects in a single
/// transaction and starts the app again (the gate reopens once it is healthy).
/// With `files`, verifies the matching immutable snapshot before any change.
pub fn restore(
    host: &Host,
    project: &Project,
    file: &Path,
    files: bool,
    yes: bool,
) -> anyhow::Result<()> {
    if !file.is_file() {
        bail!("file not found: {}", file.display());
    }
    if !yes
        && !(util::interactive()
            && util::confirm(&format!(
                "This REPLACES the {} database with the contents of {}. Continue?",
                project.name,
                file.display()
            )))
    {
        bail!("restore cancelled (use --yes to skip the question)");
    }
    let manifest = match files {
        true => {
            if !crate::backup::bundle_path(file)?
                .join("manifest.json")
                .is_file()
            {
                sync_files_down(host, project, file)?;
            }
            Some(crate::backup::validate(file)?)
        }
        false => None,
    };
    // Public traffic gets a 503 until the restored app is healthy, and the
    // current state is kept first so a wrong dump can be undone.
    let gate = Maintenance::hold(host, project)?;
    step(&format!("Stopping the {} app", project.name));
    project.stop(&[Service::App])?;
    let safety = match backup(host, project, false, None) {
        Ok(safety) => safety,
        Err(error) => {
            project.start(&[Service::App])?;
            project.wait_healthy(Service::App, HEALTH_TIMEOUT)?;
            gate.finish()?;
            return Err(error).context("safety backup failed; nothing was restored");
        }
    };
    println!("Safety backup of the current state: {}", safety.display());
    step(&format!("Restoring {}", file.display()));
    // Prepare immutable bytes first. A copy failure cannot leave restored
    // metadata pointing to missing files; extra versions are harmless on rollback.
    let result = match manifest.as_ref() {
        Some(manifest) => crate::backup::restore_files(project, file, manifest)
            .and_then(|()| restore_dump(project, file)),
        _ => restore_dump(project, file),
    };
    step("Starting the app");
    let healthy = project
        .start(&[Service::App])
        .and_then(|()| project.wait_healthy(Service::App, HEALTH_TIMEOUT));
    if let Err(error) = healthy {
        // Keep the gate closed: the project stays unreachable rather than
        // serving a half-working state.
        return Err(error).context(format!(
            "the app is not healthy after the restore; {} stays in maintenance. \
             To go back: nelcota -p {} restore {} --yes",
            project.name,
            project.name,
            safety.display()
        ));
    }
    gate.finish()?;
    result.with_context(|| {
        format!(
            "restore failed; the previous data is still in place (safety backup: {})",
            safety.display()
        )
    })?;
    ok("restore finished and app healthy");
    Ok(())
}

pub(crate) fn restore_dump(project: &Project, file: &Path) -> anyhow::Result<()> {
    let input = fs::File::open(file)?;
    let status = project
        .as_postgres(&[
            "pg_restore",
            "-d",
            "postgres",
            "--clean",
            "--if-exists",
            "--single-transaction",
            "--exit-on-error",
        ])
        .stdin(Stdio::from(input))
        .status()
        .context("could not run pg_restore")?;
    if !status.success() {
        bail!("pg_restore failed ({status}); the database was not changed (single transaction)");
    }
    ok("data restored");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_backup_leftovers_are_removed_and_complete_backups_kept() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        fs::write(dir.join("a.dump"), b"dump").unwrap();
        fs::create_dir(dir.join("a.dump.files")).unwrap();
        fs::write(dir.join("a.dump.files/manifest.json"), b"{}").unwrap();
        fs::write(dir.join("b.dump.partial"), b"partial").unwrap();
        fs::create_dir(dir.join("b.dump.files")).unwrap();
        fs::write(dir.join("b.dump.files/manifest.json"), b"{}").unwrap();
        fs::create_dir_all(dir.join(".tmpAbC123/c.dump")).unwrap();
        fs::write(dir.join(".tmpAbC123/c.dump/previous.env"), b"SECRET=1").unwrap();
        fs::write(dir.join(".tmpReceipt"), b"receipt").unwrap();
        fs::write(dir.join("notes.files"), b"unrelated").unwrap();
        sweep_interrupted(dir).unwrap();
        let mut left: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [".tmpReceipt", "a.dump", "a.dump.files", "notes.files"]
        );
        assert!(dir.join("a.dump.files/manifest.json").is_file());
        sweep_interrupted(&dir.join("missing")).unwrap();
    }
}
