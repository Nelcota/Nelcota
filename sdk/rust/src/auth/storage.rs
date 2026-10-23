//! Caller-owned persistence adapters; coordination remains with the auth client.
use super::Session;
use crate::{Error, Result};
use std::{future::Future, pin::Pin};

pub type StorageFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// Persist a session in a cookie, keychain or another caller-owned store.
/// Share a Client by cloning it. Independent clients/processes using the same store
/// must coordinate rotation externally; the storage interface alone is not a lock.
pub trait SessionStorage: Send + Sync {
    fn load(&self) -> StorageFuture<'_, Option<Session>>;
    fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()>;
}

/// Keeps the session as JSON in one file, for CLIs and desktop apps. Writes go
/// to a temporary file that replaces the old one, so a crash never leaves half
/// a session; on Unix the file is created readable by its owner only (0600).
/// The refresh token in it is a credential: keep the file out of backups
/// and shared folders. Like any store, it is not a lock between processes.
/// Dropping a pending save removes its owned temporary file on ordinary writable
/// filesystems. Once rename completes, cancellation does not undo publication.
/// Unix saves/removals also sync the containing directory; Windows uses atomic
/// replacement without a directory-sync guarantee.
#[derive(Clone, Debug)]
pub struct FileStorage {
    path: std::path::PathBuf,
}
impl FileStorage {
    /// Missing parent directories are created on the first save.
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
    async fn write(&self, session: &Session) -> Result<()> {
        let failed = |e: std::io::Error| Error::SessionStorage(e.to_string());
        let bytes =
            serde_json::to_vec(session).map_err(|e| Error::SessionStorage(e.to_string()))?;
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(parent).await.map_err(failed)?;
        }
        let mut suffix = [0u8; 8];
        getrandom::fill(&mut suffix).map_err(|e| Error::SessionStorage(e.to_string()))?;
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{}.tmp", u64::from_le_bytes(suffix)));
        let temporary = self.path.with_file_name(name);
        // Create synchronously: cancelling async open could create a file after
        // its cleanup guard had already run. Only metadata operations are sync.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&temporary).map_err(failed)?;
        let pending = PendingFile {
            path: temporary,
            owned: true,
        };
        let mut file = tokio::fs::File::from_std(file);
        tokio::io::AsyncWriteExt::write_all(&mut file, &bytes)
            .await
            .map_err(failed)?;
        file.sync_all().await.map_err(failed)?;
        drop(file);
        // Do not leave a detached rename able to promote after cancellation.
        pending.persist(&self.path).map_err(failed)?;
        self.sync_parent().await
    }
    async fn sync_parent(&self) -> Result<()> {
        // Directory fsync is supported on Unix. Windows retains atomic rename;
        // its platform APIs do not offer the same directory-sync operation.
        #[cfg(unix)]
        {
            let parent = self
                .path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| std::path::Path::new("."));
            tokio::fs::File::open(parent)
                .await
                .map_err(|e| Error::SessionStorage(e.to_string()))?
                .sync_all()
                .await
                .map_err(|e| Error::SessionStorage(e.to_string()))?;
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
                    .map_err(|e| Error::SessionStorage(format!("unreadable session file: {e}"))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(Error::SessionStorage(e.to_string())),
            }
        })
    }
    fn save<'a>(&'a self, session: Option<&'a Session>) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            match session {
                Some(session) => self.write(session).await,
                None => match std::fs::remove_file(&self.path) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        Err(Error::SessionStorage(e.to_string()))
                    }
                    Err(_) => Ok(()),
                    Ok(()) => self.sync_parent().await,
                },
            }
        })
    }
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
struct PendingFile {
    path: std::path::PathBuf,
    owned: bool,
}
impl PendingFile {
    fn persist(mut self, target: &std::path::Path) -> std::io::Result<()> {
        std::fs::rename(&self.path, target)?;
        // Disarm before any later await: the old name no longer belongs to us.
        self.owned = false;
        Ok(())
    }
}
impl Drop for PendingFile {
    fn drop(&mut self) {
        // Best effort on cancellation; a successful rename already removed it.
        // Never scan for or remove another writer's temporary files.
        if self.owned {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
