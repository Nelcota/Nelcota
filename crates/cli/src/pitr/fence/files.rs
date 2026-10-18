//! Descriptor-relative PITR state. Never resolve a symlink in a fence path.
use anyhow::{Context, bail};
#[cfg(unix)]
use rustix::fs::{AtFlags, FileType, Mode, OFlags, mkdirat, openat, renameat, statat, unlinkat};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    fs::File,
    path::{Path, PathBuf},
};
#[cfg(unix)]
use std::{
    io::{Read, Write},
    path::Component,
};

pub(super) struct Directory {
    pub path: PathBuf,
    file: File,
    #[cfg(unix)]
    anchor: bool,
    #[cfg(unix)]
    owner: u32,
}

fn rejected(path: &Path) -> anyhow::Error {
    anyhow::anyhow!(
        "PITR fence rejects unsafe path {}; preserve all markers and inspect before pitr recover --yes",
        path.display()
    )
}

pub(super) fn boundary(label: &str) -> anyhow::Result<()> {
    #[cfg(test)]
    super::faults::boundary(label)?;
    let _ = label;
    Ok(())
}

impl Directory {
    /// Walk every component without following links. An anchor's owner is
    /// selected from its descriptor, never from a separately followed path.
    #[cfg(unix)]
    pub fn open(path: &Path, create: bool, anchor: bool) -> anyhow::Result<Option<Self>> {
        let path = std::path::absolute(path)?;
        let mut directory = File::from(openat(
            rustix::fs::CWD,
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let mut walked = PathBuf::from("/");
        let components: Vec<_> = path
            .components()
            .filter(|v| !matches!(v, Component::RootDir | Component::CurDir))
            .collect();
        for (index, component) in components.iter().enumerate() {
            let name = match component {
                Component::Normal(name) => {
                    walked.push(name);
                    *name
                }
                Component::ParentDir => {
                    walked.pop();
                    std::ffi::OsStr::new("..")
                }
                _ => return Err(rejected(&path)),
            };
            let final_component = index + 1 == components.len();
            let owner = directory.metadata()?.uid();
            let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            let opened = openat(&directory, name, flags, Mode::empty());
            let next = match opened {
                Ok(next) => File::from(next),
                Err(rustix::io::Errno::NOENT) if final_component && create => {
                    mkdirat(&directory, name, Mode::from_raw_mode(0o755))
                        .map_err(|_| rejected(&walked))?;
                    boundary("directory created")?;
                    directory.sync_all()?;
                    boundary("directory parent synced")?;
                    let created = File::from(
                        openat(&directory, name, flags, Mode::empty())
                            .map_err(|_| rejected(&walked))?,
                    );
                    if created.metadata()?.uid() != owner {
                        return Err(rejected(&walked));
                    }
                    // mkdir honors umask; the read-only startup checks must
                    // also work under a private operator umask such as 077.
                    created.set_permissions(std::fs::Permissions::from_mode(0o755))?;
                    created.sync_all()?;
                    boundary("new directory permissions synced")?;
                    created
                }
                Err(rustix::io::Errno::NOENT) if !create => return Ok(None),
                Err(_) => return Err(rejected(&walked)),
            };
            let metadata = next.metadata()?;
            if final_component
                && (metadata.mode() & 0o022 != 0 || (!anchor && metadata.uid() != owner))
            {
                return Err(rejected(&walked));
            }
            directory = next;
        }
        let owner = directory.metadata()?.uid();
        Ok(Some(Self {
            path,
            file: directory,
            owner,
            anchor,
        }))
    }

    #[cfg(not(unix))]
    pub fn open(path: &Path, _create: bool, _anchor: bool) -> anyhow::Result<Option<Self>> {
        if !_create
            && std::fs::symlink_metadata(path)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(None);
        }
        Err(rejected(path))
    }

    pub fn required(path: &Path) -> anyhow::Result<Self> {
        Self::open(path, false, false)?
            .with_context(|| format!("PITR fence directory {} is missing", path.display()))
    }

    #[cfg(unix)]
    pub fn checked(&self, name: &str, private: bool) -> anyhow::Result<bool> {
        self.verify_identity()?;
        let path = self.path.join(name);
        if Path::new(name).components().count() != 1 {
            return Err(rejected(&path));
        }
        let metadata = match statat(&self.file, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(metadata) => metadata,
            Err(rustix::io::Errno::NOENT) => return Ok(false),
            Err(_) => return Err(rejected(&path)),
        };
        if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
            || metadata.st_uid != self.owner
            || metadata.st_nlink != 1
            || (private && metadata.st_mode & 0o077 != 0)
            || (!private && metadata.st_mode & 0o022 != 0)
        {
            return Err(rejected(&path));
        }
        Ok(true)
    }

    #[cfg(not(unix))]
    pub fn checked(&self, name: &str, _private: bool) -> anyhow::Result<bool> {
        Err(rejected(&self.path.join(name)))
    }

    #[cfg(unix)]
    fn verify_identity(&self) -> anyhow::Result<()> {
        let reopened =
            Self::open(&self.path, false, self.anchor)?.ok_or_else(|| rejected(&self.path))?;
        let before = self.file.metadata()?;
        let after = reopened.file.metadata()?;
        if before.dev() != after.dev() || before.ino() != after.ino() || before.uid() != after.uid()
        {
            return Err(rejected(&self.path));
        }
        Ok(())
    }

    #[cfg(unix)]
    pub fn read(&self, name: &str, limit: u64, private: bool) -> anyhow::Result<Vec<u8>> {
        if !self.checked(name, private)? {
            bail!(
                "PITR fence file {} is missing",
                self.path.join(name).display()
            );
        }
        let file = File::from(
            openat(
                &self.file,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| rejected(&self.path.join(name)))?,
        );
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != self.owner
            || metadata.nlink() != 1
            || metadata.len() > limit
            || (private && metadata.mode() & 0o077 != 0)
            || (!private && metadata.mode() & 0o022 != 0)
        {
            return Err(rejected(&self.path.join(name)));
        }
        let mut bytes = Vec::new();
        file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            return Err(rejected(&self.path.join(name)));
        }
        Ok(bytes)
    }

    #[cfg(not(unix))]
    pub fn read(&self, name: &str, _limit: u64, _private: bool) -> anyhow::Result<Vec<u8>> {
        Err(rejected(&self.path.join(name)))
    }

    #[cfg(unix)]
    pub fn write(&self, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
        self.write_inner(name, bytes, true)
    }

    #[cfg(unix)]
    pub fn write_config(&self, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
        self.write_inner(name, bytes, false)
    }

    /// Retain a dedicated guard across ordinary app binary upgrades/rollback.
    /// Stream the already verified installed artifact, keeping CLI memory bounded.
    #[cfg(unix)]
    pub fn install_guard(&self, source: &str, target: &str) -> anyhow::Result<()> {
        self.checked(source, false)?;
        self.checked(target, true)?;
        let source_file = File::from(
            openat(
                &self.file,
                source,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| rejected(&self.path.join(source)))?,
        );
        let metadata = source_file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != self.owner
            || metadata.nlink() != 1
            || metadata.len() > 256 * 1024 * 1024
            || metadata.mode() & 0o022 != 0
        {
            return Err(rejected(&self.path.join(source)));
        }
        let temporary = format!(".pitr-{}", crate::util::secret(24));
        let mut output = File::from(openat(
            &self.file,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o700),
        )?);
        let cleanup = Temporary {
            parent: self.file.try_clone()?,
            name: temporary.clone(),
            inode: output.metadata()?.ino(),
        };
        if output.metadata()?.uid() != self.owner {
            return Err(rejected(&self.path.join(&temporary)));
        }
        let copied = std::io::copy(&mut source_file.take(256 * 1024 * 1024 + 1), &mut output)?;
        if copied != metadata.len() {
            return Err(rejected(&self.path.join(source)));
        }
        output.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        boundary("guard executable copied")?;
        output.sync_all()?;
        boundary("guard executable synced")?;
        self.checked(target, true)?;
        renameat(&self.file, temporary.as_str(), &self.file, target)?;
        drop(cleanup);
        boundary("guard executable installed")?;
        self.sync()
    }

    #[cfg(not(unix))]
    pub fn install_guard(&self, _source: &str, target: &str) -> anyhow::Result<()> {
        Err(rejected(&self.path.join(target)))
    }

    #[cfg(unix)]
    fn write_inner(&self, name: &str, bytes: &[u8], private: bool) -> anyhow::Result<()> {
        self.checked(name, private)?;
        let temporary = format!(".pitr-{}", crate::util::secret(24));
        let mut file = File::from(openat(
            &self.file,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )?);
        let cleanup = Temporary {
            parent: self.file.try_clone()?,
            name: temporary.clone(),
            inode: file.metadata()?.ino(),
        };
        if file.metadata()?.uid() != self.owner {
            return Err(rejected(&self.path.join(&temporary)));
        }
        file.write_all(bytes)?;
        boundary("temporary file written")?;
        file.sync_all()?;
        boundary("temporary file synced")?;
        self.checked(name, private)?;
        renameat(&self.file, temporary.as_str(), &self.file, name)?;
        drop(cleanup);
        boundary("private file replaced")?;
        self.sync()
    }

    #[cfg(not(unix))]
    pub fn write_config(&self, name: &str, _bytes: &[u8]) -> anyhow::Result<()> {
        Err(rejected(&self.path.join(name)))
    }

    #[cfg(not(unix))]
    pub fn write(&self, name: &str, _bytes: &[u8]) -> anyhow::Result<()> {
        Err(rejected(&self.path.join(name)))
    }

    #[cfg(unix)]
    pub fn remove(&self, name: &str) -> anyhow::Result<()> {
        if self.checked(name, true)? {
            unlinkat(&self.file, name, AtFlags::empty())?;
            boundary("marker unlinked")?;
        }
        self.sync()
    }

    #[cfg(not(unix))]
    pub fn remove(&self, name: &str) -> anyhow::Result<()> {
        Err(rejected(&self.path.join(name)))
    }

    #[cfg(unix)]
    pub fn move_to(&self, name: &str, target: &Self, destination: &str) -> anyhow::Result<()> {
        if !self.checked(name, true)? {
            return Err(rejected(&self.path.join(name)));
        }
        target.checked(destination, false)?;
        // ONE rename removes the last marker AND restores original Compose.
        // No fallible operation can expose original Compose with a marker.
        boundary("before atomic Docker release")?;
        renameat(&self.file, name, &target.file, destination)?;
        boundary("after atomic Docker release")?;
        target.sync()?;
        self.sync()
    }

    #[cfg(not(unix))]
    pub fn move_to(&self, name: &str, target: &Self, destination: &str) -> anyhow::Result<()> {
        let _ = (target, destination);
        Err(rejected(&self.path.join(name)))
    }

    pub fn sync(&self) -> anyhow::Result<()> {
        self.file.sync_all()?;
        boundary("directory synced")
    }

    pub fn make_readable(&self) -> anyhow::Result<()> {
        #[cfg(unix)]
        {
            self.verify_identity()?;
            self.file
                .set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
        self.sync()
    }

    pub fn validate_state_files(&self) -> anyhow::Result<()> {
        // Preflight every known state file before any recovery side effect.
        for name in [
            super::ACTIVE,
            super::RECEIPT,
            "release.verified.json",
            "compose.original.yml",
            "compose.original.sha256",
            "compose.guarded.json",
            "compose.guarded.sha256",
            "check-start",
        ] {
            self.checked(name, true)?;
        }
        Ok(())
    }
}

#[cfg(unix)]
struct Temporary {
    parent: File,
    name: String,
    inode: u64,
}
#[cfg(unix)]
impl Drop for Temporary {
    fn drop(&mut self) {
        // Only retire our own still-regular temporary inode. Never touch a
        // replacement link or a startup marker during error/Drop cleanup.
        if statat(&self.parent, self.name.as_str(), AtFlags::SYMLINK_NOFOLLOW).is_ok_and(|m| {
            m.st_ino == self.inode && FileType::from_raw_mode(m.st_mode) == FileType::RegularFile
        }) {
            let _ = unlinkat(&self.parent, self.name.as_str(), AtFlags::empty());
        }
    }
}
