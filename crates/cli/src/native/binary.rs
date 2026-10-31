//! Binary deployment and rollback through atomic file replacement.
use anyhow::{Context, bail};
use std::{
    fs,
    path::{Path, PathBuf},
};
const LIB_DIR: &str = "/usr/local/lib/nelcota";

/// The binary the unit runs, and the one kept for a rollback.
pub fn deployed_binary() -> PathBuf {
    PathBuf::from(format!("{LIB_DIR}/nelcota"))
}

fn previous_binary() -> PathBuf {
    PathBuf::from(format!("{LIB_DIR}/nelcota.previous"))
}

/// Copies this binary to where the unit runs it. The one there before is
/// kept as `nelcota.previous`.
pub fn deploy_binary() -> anyhow::Result<()> {
    fs::create_dir_all(LIB_DIR)?;
    let target = deployed_binary();
    if target.is_file() {
        install(&target, &previous_binary())?;
    }
    // Copy then rename: the running binary cannot be overwritten in place.
    install(&std::env::current_exe()?, &target)
}

/// Puts back the binary from before the last [`deploy_binary`].
pub fn rollback_binary() -> anyhow::Result<()> {
    let previous = previous_binary();
    if !previous.is_file() {
        bail!("no previous binary at {}", previous.display());
    }
    fs::rename(previous, deployed_binary())?;
    sync_directory(Path::new(LIB_DIR))
}

/// A crash or power loss leaves either the old or the complete new binary:
/// the executable copy is flushed before its rename, and the rename before
/// returning.
fn install(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let directory = destination
        .parent()
        .context("binary path has no directory")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".nelcota-")
        .tempfile_in(directory)?;
    std::io::copy(&mut fs::File::open(source)?, temporary.as_file_mut())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o755))?;
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist(destination)
        .map_err(|error| error.error)?;
    sync_directory(directory)
}

fn sync_directory(directory: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    let _ = directory;
    Ok(())
}
