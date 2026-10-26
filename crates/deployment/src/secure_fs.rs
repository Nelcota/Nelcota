use anyhow::{Context, bail};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

pub fn token() -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("randomness unavailable"))?;
    Ok(base16ct::lower::encode_string(&bytes))
}

pub fn private_dir(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            bail!("unsafe deployment directory");
        }
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(unix)]
    {
        for parent in path.ancestors().filter(|path| !path.as_os_str().is_empty()) {
            File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent = path.parent().context("missing deployment directory")?;
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        bail!("symlink in deployment state");
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn read_private(path: &Path, maximum: u64) -> anyhow::Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > maximum {
        bail!("invalid deployment file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.mode() & 0o077 != 0 {
            bail!("deployment file is not private");
        }
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        bail!("deployment file too large");
    }
    Ok(bytes)
}

pub fn digest_file(path: &Path, maximum: u64) -> anyhow::Result<String> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > maximum {
        bail!("invalid deployment artifact");
    }
    let mut reader = File::open(path)?.take(maximum.saturating_add(1));
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut bytes)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .context("artifact length overflow")?;
        if total > maximum {
            bail!("deployment artifact too large");
        }
        digest.update(&bytes[..read]);
    }
    Ok(base16ct::lower::encode_string(&digest.finalize()))
}
