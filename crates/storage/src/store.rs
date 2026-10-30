//! Where the bytes live (D77): a local directory or an S3-compatible bucket,
//! both behind `object_store`. Keys are `<bucket>/<version>` (D78); object
//! names never reach the store.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, atomic::AtomicBool, atomic::AtomicU64},
    time::Duration,
};

use futures_util::stream::BoxStream;
use nelcota_core::{Config, config::StorageBackend};
use object_store::{
    GetOptions, GetRange, GetResult, ObjectMeta, ObjectStore, ObjectStoreExt, PutPayload,
    WriteMultipart,
    aws::{AmazonS3, AmazonS3Builder},
    local::LocalFileSystem,
    path::Path as Key,
    signer::{Method, SignedUrlOptions, Signer, Url},
};
use uuid::Uuid;

/// Part size of an upload: S3 refuses parts under 5 MiB (except the last);
/// on disk a part is a write, so smaller ones keep memory low.
const S3_PART: usize = 8 * 1024 * 1024;
const DISK_PART: usize = 1024 * 1024;
/// Parts of one upload in flight at once.
pub const PARTS_IN_FLIGHT: usize = 2;

pub struct Store {
    inner: Arc<dyn ObjectStore>,
    backend: Backend,
    /// Includes pending creation and canceled uploads awaiting abort.
    multipart_slots: Arc<tokio::sync::Semaphore>,
    pub(crate) gc_owner: OnceLock<String>,
    pub(crate) ownership_ready: tokio::sync::OnceCell<()>,
    pub(crate) shared: AtomicBool,
    pub(crate) collection_grace_secs: AtomicU64,
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn disk_root_is_private_for_new_and_existing_uploads() {
        let temp = tempfile::tempdir().unwrap();
        for existing in [false, true] {
            let root = temp.path().join(match existing {
                true => "existing",
                false => "nested/new",
            });
            if existing {
                fs::create_dir_all(root.join("bucket")).unwrap();
                fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
                fs::write(root.join("bucket/old"), b"old private bytes").unwrap();
            }
            let store = Store::disk(root.clone()).unwrap();
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let key = Store::key("bucket", Uuid::now_v7());
            store
                .put(&key, bytes::Bytes::from_static(b"private"))
                .await
                .unwrap();
            let multipart_key = Store::key("bucket", Uuid::now_v7());
            let mut writer = store.writer(&multipart_key).await.unwrap();
            writer.write(b"private multipart");
            writer.finish().await.unwrap();
            assert_eq!(
                store.get(&key, None).await.unwrap().bytes().await.unwrap(),
                "private"
            );
            assert_eq!(
                store
                    .get(&multipart_key, None)
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap(),
                "private multipart"
            );
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            if existing {
                assert_eq!(
                    fs::read(root.join("bucket/old")).unwrap(),
                    b"old private bytes"
                );
            }
        }
    }
}

enum Backend {
    Disk { root: PathBuf },
    S3 { s3: Arc<AmazonS3> },
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("storage ownership could not be established: {0}")]
    Ownership(&'static str),
    #[error("could not identify the storage database: {0}")]
    Database(#[from] tokio_postgres::Error),
    #[error("could not create the storage directory {0}: {1}")]
    Directory(PathBuf, std::io::Error),
    #[error(transparent)]
    Store(#[from] object_store::Error),
}

impl Store {
    /// The configured store, or `None` when storage is off.
    pub fn from_config(config: &Config) -> Result<Option<Self>, StoreError> {
        match config.storage_backend {
            StorageBackend::Off => Ok(None),
            StorageBackend::Disk => {
                let root = config
                    .storage_dir
                    .clone()
                    .expect("validated: disk needs a directory");
                Self::disk(root).map(Some)
            }
            StorageBackend::S3 => {
                // reqwest's rustls runs on `ring` (D16); installing twice is harmless.
                let _ = rustls::crypto::ring::default_provider().install_default();
                let mut builder = AmazonS3Builder::new()
                    .with_bucket_name(config.storage_s3_bucket.clone().unwrap_or_default())
                    .with_region(&config.storage_s3_region)
                    .with_access_key_id(config.storage_s3_access_key_id.clone().unwrap_or_default())
                    .with_secret_access_key(
                        config
                            .storage_s3_secret_access_key
                            .as_ref()
                            .map(|s| s.expose().to_owned())
                            .unwrap_or_default(),
                    )
                    .with_virtual_hosted_style_request(config.storage_s3_virtual_hosted);
                if let Some(endpoint) = config
                    .storage_s3_endpoint
                    .as_deref()
                    .map(str::trim)
                    .filter(|e| !e.is_empty())
                {
                    builder = builder
                        .with_endpoint(endpoint)
                        .with_allow_http(endpoint.starts_with("http://"));
                }
                let s3 = Arc::new(builder.build()?);
                Ok(Some(Store {
                    inner: s3.clone(),
                    backend: Backend::S3 { s3 },
                    multipart_slots: Arc::new(tokio::sync::Semaphore::new(
                        crate::CONCURRENT_UPLOADS,
                    )),
                    gc_owner: OnceLock::new(),
                    ownership_ready: tokio::sync::OnceCell::new(),
                    shared: AtomicBool::new(false),
                    collection_grace_secs: AtomicU64::new(86_400),
                }))
            }
        }
    }

    /// A store on a local directory, created if missing.
    pub fn disk(root: PathBuf) -> Result<Self, StoreError> {
        crate::private_dir::create(&root).map_err(|e| StoreError::Directory(root.clone(), e))?;
        let fs = LocalFileSystem::new_with_prefix(&root)?.with_automatic_cleanup(true);
        Ok(Store {
            inner: Arc::new(fs),
            backend: Backend::Disk { root },
            multipart_slots: Arc::new(tokio::sync::Semaphore::new(crate::CONCURRENT_UPLOADS)),
            gc_owner: OnceLock::new(),
            ownership_ready: tokio::sync::OnceCell::new(),
            shared: AtomicBool::new(false),
            collection_grace_secs: AtomicU64::new(86_400),
        })
    }

    pub fn key(bucket: &str, version: Uuid) -> Key {
        Key::from_iter([bucket, &version.to_string()])
    }

    /// Free space left for the disk backend; `None` on S3.
    pub fn free_bytes(&self) -> Option<u64> {
        match &self.backend {
            Backend::Disk { root } => match fs4::available_space(root) {
                Ok(free) => Some(free),
                Err(err) => {
                    tracing::error!(
                        event = "storage.free_space_unavailable",
                        error_type = std::any::type_name_of_val(&err),
                        "could not read the storage disk's free space"
                    );
                    Some(0)
                }
            },
            Backend::S3 { .. } => None,
        }
    }

    pub fn is_s3(&self) -> bool {
        matches!(self.backend, Backend::S3 { .. })
    }

    pub(crate) fn disk_root(&self) -> Option<&Path> {
        match &self.backend {
            Backend::Disk { root } => Some(root),
            Backend::S3 { .. } => None,
        }
    }

    /// Starts writing a new object, in parts.
    pub async fn writer(&self, key: &Key) -> Result<WriteMultipart, StoreError> {
        let part = match self.is_s3() {
            true => S3_PART,
            false => DISK_PART,
        };
        Ok(crate::multipart::writer(
            self.inner.clone(),
            key.clone(),
            part,
            self.multipart_slots.clone(),
        )
        .await?)
    }

    /// Writes a small object in one request.
    pub async fn put(&self, key: &Key, bytes: bytes::Bytes) -> Result<(), StoreError> {
        self.inner.put(key, PutPayload::from(bytes)).await?;
        Ok(())
    }

    pub async fn get(&self, key: &Key, range: Option<GetRange>) -> Result<GetResult, StoreError> {
        let options = GetOptions {
            range,
            ..GetOptions::default()
        };
        Ok(self.inner.get_opts(key, options).await?)
    }

    /// Deletes bytes; a key that is already gone is not an error.
    pub async fn delete(&self, key: &Key) -> Result<(), StoreError> {
        match self.inner.delete(key).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Deletes bytes after a commit: a failure leaves them for the collector.
    pub async fn delete_quietly(&self, key: &Key) {
        if let Err(err) = self.delete(key).await {
            tracing::warn!(event = "storage.delete_deferred", error_type = std::any::type_name_of_val(&err), io_kind = ?crate::error::diagnostic_io_kind(&err), "could not delete stored bytes; the collector will retry");
        }
    }

    pub fn list(&self) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        use futures_util::StreamExt;
        self.inner
            .list(None)
            .filter(|item| {
                std::future::ready(
                    !item
                        .as_ref()
                        .is_ok_and(|meta| crate::ownership::is_control(&meta.location)),
                )
            })
            .boxed()
    }

    pub(crate) async fn control_read(
        &self,
        name: &str,
    ) -> Result<Option<bytes::Bytes>, StoreError> {
        self.check_control_path(name)?;
        let result = match self.inner.get(&Key::from(name)).await {
            Ok(result) => result,
            Err(object_store::Error::NotFound { .. }) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if result.meta.size > 128 {
            return Err(StoreError::Ownership("oversized ownership marker"));
        }
        let bytes = result.bytes().await?;
        if bytes.len() > 128 {
            return Err(StoreError::Ownership("oversized ownership marker"));
        }
        Ok(Some(bytes))
    }

    pub(crate) async fn control_create(
        &self,
        name: &str,
        bytes: bytes::Bytes,
    ) -> Result<(), StoreError> {
        self.check_control_path(name)?;
        let options = object_store::PutOptions {
            mode: object_store::PutMode::Create,
            ..Default::default()
        };
        // Only Unix narrows the new marker's permissions.
        #[cfg_attr(not(unix), allow(unused_variables))]
        let created = match self
            .inner
            .put_opts(&Key::from(name), bytes.into(), options)
            .await
        {
            Ok(_) => true,
            Err(object_store::Error::AlreadyExists { .. }) => false,
            Err(error) => return Err(error.into()),
        };
        if let Backend::Disk { root } = &self.backend {
            let marker = root.join(name);
            #[cfg(unix)]
            if created {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&marker, std::fs::Permissions::from_mode(0o600))
                    .map_err(|error| StoreError::Directory(marker.clone(), error))?;
            }
            self.check_control_path(name)?;
            std::fs::File::open(&marker)
                .and_then(|file| file.sync_all())
                .map_err(|error| StoreError::Directory(marker, error))?;
            #[cfg(unix)]
            std::fs::File::open(root)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| StoreError::Directory(root.clone(), error))?;
        }
        Ok(())
    }

    fn check_control_path(&self, name: &str) -> Result<(), StoreError> {
        let root = match &self.backend {
            Backend::Disk { root } => root,
            _ => return Ok(()),
        };
        let valid = |metadata: &std::fs::Metadata, directory: bool| {
            if metadata.file_type().is_symlink()
                || metadata.is_dir() != directory
                || (!directory && !metadata.is_file())
            {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let owner = match std::fs::metadata(root) {
                    Ok(owner) => owner,
                    Err(_) => return false,
                };
                if metadata.uid() != owner.uid() || metadata.mode() & 0o022 != 0 {
                    return false;
                }
            }
            true
        };
        let metadata = std::fs::symlink_metadata(root)
            .map_err(|error| StoreError::Directory(root.clone(), error))?;
        if !valid(&metadata, true) {
            return Err(StoreError::Ownership("unsafe ownership marker directory"));
        }
        match std::fs::symlink_metadata(root.join(name)) {
            Ok(metadata) if valid(&metadata, false) => Ok(()),
            Ok(_) => Err(StoreError::Ownership("unsafe ownership marker")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StoreError::Directory(root.join(name), error)),
        }
    }

    /// S3 only: a presigned GET that also fixes the response's type and
    /// disposition. S3 offers no query override for `X-Content-Type-Options`
    /// or `Content-Security-Policy`; docs/storage.md asks operators to set
    /// them on the provider or the CDN in front of it.
    pub async fn presigned_get(
        &self,
        key: &Key,
        expires_in: Duration,
        content_type: &str,
        disposition: &str,
    ) -> Result<Option<Url>, StoreError> {
        let s3 = match &self.backend {
            Backend::S3 { s3 } => s3,
            _ => {
                return Ok(None);
            }
        };
        let options = SignedUrlOptions::new().with_query([
            ("response-content-type", content_type),
            ("response-content-disposition", disposition),
        ]);
        let url = s3
            .signed_url_opts(Method::GET, key, expires_in, &options)
            .await?;
        Ok(Some(url))
    }
}
