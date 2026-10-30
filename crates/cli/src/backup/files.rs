//! A privileged backup must not follow links planted by an application user.
use super::object_path;
use anyhow::{Context, bail};
#[cfg(unix)]
use rustix::fs::{self, AtFlags, Gid, Mode, OFlags, Uid};
#[cfg(unix)]
use std::io::Read;
use std::{fs::File, path::Path};
#[cfg(unix)]
fn directory(path: &Path) -> anyhow::Result<File> {
    Ok(File::from(fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?))
}
#[cfg(unix)]
fn bucket(root: &File, name: &str, create: bool) -> anyhow::Result<File> {
    if create {
        match fs::mkdirat(root, name, Mode::from_raw_mode(0o700)) {
            Ok(()) => {}
            Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(File::from(fs::openat(
        root,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?))
}
pub(super) fn read(root: &Path, key: &str) -> anyhow::Result<File> {
    let path = object_path(root, key)?;
    #[cfg(unix)]
    {
        let (name, version) = key.split_once('/').context("invalid file key")?;
        let root = directory(root)?;
        let parent = bucket(&root, name, false)?;
        let file = File::from(fs::openat(
            &parent,
            version,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )?);
        if !file.metadata()?.is_file() {
            bail!("backup object is not a regular file");
        }
        let _ = path;
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            bail!("symlink in backup object");
        }
        Ok(File::open(path)?)
    }
}
pub(super) fn restore(
    root: &Path,
    key: &str,
    mut source: File,
    expected: u64,
) -> anyhow::Result<()> {
    let destination = object_path(root, key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let root = directory(root)?;
        let metadata = root.metadata()?;
        let (name, version) = key.split_once('/').context("invalid file key")?;
        let parent = bucket(&root, name, true)?;
        let uid = Uid::from_raw(metadata.uid());
        let gid = Gid::from_raw(metadata.gid());
        fs::fchown(&parent, Some(uid), Some(gid))?;
        let temporary = format!(".nelcota-restore-{}", nelcota_deployment::token()?);
        let mut target = File::from(fs::openat(
            &parent,
            &temporary,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )?);
        let result = (|| {
            let bytes = std::io::copy(
                &mut (&mut source).take(expected.checked_add(1).context("invalid object size")?),
                &mut target,
            )?;
            if bytes != expected {
                bail!("snapshot object size changed");
            }
            fs::fchown(&target, Some(uid), Some(gid))?;
            target.sync_all()?;
            fs::renameat(&parent, &temporary, &parent, version)?;
            parent.sync_all()?;
            root.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::unlinkat(&parent, &temporary, AtFlags::empty());
        }
        let _ = destination;
        result
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(destination.parent().context("invalid object directory")?)?;
        crate::private_fs::copy_reader(&mut source, &destination, expected)?;
        Ok(())
    }
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn read_and_restore_cannot_escape_through_bucket_or_object_links() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("live");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let key = format!("bucket/{id}");
        std::fs::write(outside.join(&id), b"protected").unwrap();
        symlink(&outside, root.join("bucket")).unwrap();
        assert!(read(&root, &key).is_err());
        let source = temp.path().join("source");
        std::fs::write(&source, b"replacement").unwrap();
        assert!(restore(&root, &key, File::open(&source).unwrap(), 11).is_err());
        assert_eq!(std::fs::read(outside.join(&id)).unwrap(), b"protected");
        std::fs::remove_file(root.join("bucket")).unwrap();
        std::fs::create_dir(root.join("bucket")).unwrap();
        symlink(outside.join(&id), root.join("bucket").join(&id)).unwrap();
        assert!(read(&root, &key).is_err());
        restore(&root, &key, File::open(&source).unwrap(), 11).unwrap();
        assert_eq!(std::fs::read(outside.join(&id)).unwrap(), b"protected");
        assert_eq!(
            std::fs::read(root.join("bucket").join(&id)).unwrap(),
            b"replacement"
        );
    }
}
