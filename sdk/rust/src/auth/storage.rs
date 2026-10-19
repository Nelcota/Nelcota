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
        let result = async {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temporary).await?;
            tokio::io::AsyncWriteExt::write_all(&mut file, &bytes).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, &self.path).await
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        result.map_err(failed)
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
                None => match tokio::fs::remove_file(&self.path).await {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        Err(Error::SessionStorage(e.to_string()))
                    }
                    _ => Ok(()),
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
