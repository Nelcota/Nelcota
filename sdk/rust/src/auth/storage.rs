//! Caller-owned persistence adapters; coordination remains with the auth client.
use super::Session;
use crate::{Error, Result};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub type StorageFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// Persist a session in a cookie, keychain or another caller-owned store.
/// Share a Client by cloning it. Independent clients/processes using the same store
/// must coordinate rotation externally; the storage interface alone is not a lock.
/// A `load` that returns [`Error::SessionInvalid`], or a session that fails
/// validation, counts as signed out: the client emits `SignedOut` and asks the
/// store to remove it. Any other `load` error is returned to the caller and the
/// stored session is kept, so a transient failure can be retried.
pub trait SessionStorage: Send + Sync {
    fn load(&self) -> StorageFuture<'_, Option<Session>>;
    fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()>;
}

/// Keeps the session as JSON in one file, for CLIs and desktop apps. Writes go
/// to a temporary file that replaces the old one, so a crash never leaves half
/// a session. On Unix the file is created readable by its owner only (0600)
/// and missing parent directories are created private (0700). On Windows the
/// file inherits the ACL of its directory: choose a directory only the user can
/// read, such as one under the user's profile.
/// The refresh token in it is a credential: keep the file out of backups
/// and shared folders. Like any store, it is not a lock between processes.
/// Dropping a pending save removes its owned temporary file on ordinary writable
/// filesystems. Once rename completes, cancellation does not undo publication.
/// Unix saves/removals also sync the containing directory; Windows uses atomic
/// replacement without a directory-sync guarantee. Filesystem calls run off the
/// async worker threads.
#[derive(Clone, Debug)]
pub struct FileStorage {
    path: PathBuf,
}
impl FileStorage {
    /// Missing parent directories are created on the first save.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    fn parent(&self) -> Option<&Path> {
        self.path.parent().filter(|p| !p.as_os_str().is_empty())
    }
    async fn write(&self, session: &Session) -> Result<()> {
        let bytes =
            serde_json::to_vec(session).map_err(|e| Error::SessionStorage(e.to_string()))?;
        if let Some(parent) = self.parent() {
            let parent = parent.to_owned();
            blocking(move || {
                let mut builder = std::fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(parent)
            })
            .await?;
        }
        let mut suffix = [0u8; 8];
        getrandom::fill(&mut suffix).map_err(|e| Error::SessionStorage(e.to_string()))?;
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{}.tmp", u64::from_le_bytes(suffix)));
        // The guard exists before the file: a save dropped while the file is
        // being created still removes it (see PendingFile).
        let pending = PendingFile::new(self.path.with_file_name(name));
        let file = pending.create().await?;
        let mut file = tokio::fs::File::from_std(file);
        tokio::io::AsyncWriteExt::write_all(&mut file, &bytes)
            .await
            .map_err(failed)?;
        file.sync_all().await.map_err(failed)?;
        drop(file);
        pending.persist(&self.path).await?;
        self.sync_parent().await
    }
    async fn sync_parent(&self) -> Result<()> {
        // Directory fsync is supported on Unix. Windows retains atomic rename;
        // its platform APIs do not offer the same directory-sync operation.
        #[cfg(unix)]
        {
            let parent = self.parent().unwrap_or_else(|| Path::new("."));
            tokio::fs::File::open(parent)
                .await
                .map_err(failed)?
                .sync_all()
                .await
                .map_err(failed)?;
        }
        Ok(())
    }
}
impl SessionStorage for FileStorage {
    fn load(&self) -> StorageFuture<'_, Option<Session>> {
        Box::pin(async {
            match tokio::fs::read(&self.path).await {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map(Some)
                    .map_err(|e| Error::SessionInvalid(format!("unreadable session file: {e}"))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(failed(e)),
            }
        })
    }
    fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            match session {
                Some(session) => self.write(session).await,
                None => match tokio::fs::remove_file(&self.path).await {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(failed(e)),
                    Err(_) => Ok(()),
                    Ok(()) => self.sync_parent().await,
                },
            }
        })
    }
}

fn failed(error: std::io::Error) -> Error {
    Error::SessionStorage(error.to_string())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| Error::SessionStorage(e.to_string()))?
        .map_err(failed)
}

#[derive(Default)]
pub struct MemoryStorage(std::sync::Mutex<Option<Session>>);
impl SessionStorage for MemoryStorage {
    fn load(&self) -> StorageFuture<'_, Option<Session>> {
        Box::pin(async {
            self.0
                .lock()
                .map(|s| s.clone())
                .map_err(|_| Error::SessionStorage("poisoned memory store".into()))
        })
    }
    fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            *self
                .0
                .lock()
                .map_err(|_| Error::SessionStorage("poisoned memory store".into()))? =
                session.cloned();
            Ok(())
        })
    }
}

/// Owns only the file created by this save, including when its future is dropped.
///
/// Creation and rename run on the blocking pool and may finish after the save
/// was dropped. `abandoned` orders the two sides: the drop sets it before
/// removing the path, and creation checks it after creating the file, so
/// whichever runs last removes the file.
struct PendingFile {
    path: PathBuf,
    owned: bool,
    abandoned: Arc<AtomicBool>,
}
impl PendingFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            owned: true,
            abandoned: Arc::new(AtomicBool::new(false)),
        }
    }
    async fn create(&self) -> Result<std::fs::File> {
        let path = self.path.clone();
        let abandoned = self.abandoned.clone();
        blocking(move || {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&path)?;
            if abandoned.load(Ordering::SeqCst) {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(std::io::Error::other("session save was cancelled"));
            }
            Ok(file)
        })
        .await
    }
    async fn persist(mut self, target: &Path) -> Result<()> {
        let (from, to) = (self.path.clone(), target.to_owned());
        blocking(move || std::fs::rename(from, to)).await?;
        // Disarm before any later await: the old name no longer belongs to us.
        // A save dropped while renaming removes a name that is either still
        // ours (the rename then fails) or already gone.
        self.owned = false;
        Ok(())
    }
}
impl Drop for PendingFile {
    fn drop(&mut self) {
        // Best effort on cancellation; a successful rename already removed it.
        // Never scan for or remove another writer's temporary files.
        if self.owned {
            self.abandoned.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
