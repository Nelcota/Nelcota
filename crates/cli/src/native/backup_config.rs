//! Fail closed when native backup configuration cannot be removed safely.

use std::{fs, io, path::Path};

use anyhow::{Context, bail};

fn validate_at(path: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => bail!("unsafe native backup configuration; expected a file or removable symlink"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("could not inspect native backup configuration"),
    }
}

fn remove_at(path: &Path) -> anyhow::Result<()> {
    validate_at(path)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("could not remove native backup configuration"),
    }
}

pub(crate) fn check() -> anyhow::Result<()> {
    validate_at(Path::new(super::PGBACKREST_CONF))
}

pub(crate) fn remove() -> anyhow::Result<()> {
    remove_at(Path::new(super::PGBACKREST_CONF))
}

pub(super) fn remove_after(
    path: &Path,
    teardown: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    validate_at(path)?;
    teardown()?;
    remove_at(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_configuration_blocks_teardown_without_removing_anything() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("config");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("retained"), b"owned fixture").unwrap();
        let error = remove_after(&path, || panic!("must reject before teardown")).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsafe native backup configuration")
        );
        assert_eq!(fs::read(path.join("retained")).unwrap(), b"owned fixture");
    }

    #[test]
    fn missing_configuration_and_regular_files_remain_compatible() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("config");
        remove_after(&path, || Ok(())).unwrap();
        fs::write(&path, b"owned fixture").unwrap();
        remove_after(&path, || {
            assert_eq!(fs::read(&path)?, b"owned fixture");
            Ok(())
        })
        .unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn failed_teardown_keeps_configuration_and_late_cleanup_errors_are_not_ignored() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("config");
        fs::write(&path, b"owned fixture").unwrap();
        assert!(remove_after(&path, || bail!("fixture teardown failed")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"owned fixture");
        let error = remove_after(&path, || {
            fs::remove_file(&path)?;
            fs::create_dir(&path)?;
            Ok(())
        })
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsafe native backup configuration")
        );
        assert!(path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn configuration_symlinks_are_unlinked_without_following_the_target() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("retained");
        fs::write(&target, b"owned target").unwrap();
        let path = temporary.path().join("config");
        symlink(&target, &path).unwrap();
        remove_after(&path, || Ok(())).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"owned target");
        assert!(fs::symlink_metadata(&path).is_err());
        symlink(temporary.path().join("absent"), &path).unwrap();
        remove_at(&path).unwrap();
        assert!(fs::symlink_metadata(&path).is_err());
    }
}
