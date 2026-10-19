//! Storage wire models and request options, without network operations.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bucket {
    pub id: String,
    pub public: bool,
    pub file_size_limit: Option<u64>,
    pub allowed_mime_types: Option<Vec<String>>,
    pub created_at: String,
    pub updated_at: String,
}

/// Settings for a new bucket. `Default` is a private bucket without limits.
#[derive(Clone, Debug, Default, Serialize)]
pub struct BucketSettings {
    pub public: bool,
    pub file_size_limit: Option<u64>,
    pub allowed_mime_types: Option<Vec<String>>,
}
impl BucketSettings {
    pub(super) fn validate(&self) -> Result<()> {
        validate_limit(self.file_size_limit)
    }
}

/// The complete settings `update_bucket` writes. A PUT replaces every setting,
/// so this type has no `Default`: a `None` limit always clears that limit on
/// purpose. To change one setting, start from the current bucket:
///
/// ```no_run
/// # async fn example(storage: nelcota_client::storage::StorageClient) -> nelcota_client::Result<()> {
/// use nelcota_client::storage::BucketUpdate;
/// let current = storage.get_bucket("avatars").await?;
/// storage.update_bucket("avatars", BucketUpdate { public: true, ..current.into() }).await?;
/// # Ok(()) }
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BucketUpdate {
    pub public: bool,
    /// Bytes; `None` clears the limit.
    pub file_size_limit: Option<u64>,
    /// `image/png`, `image/*`...; `None` allows any type.
    pub allowed_mime_types: Option<Vec<String>>,
}
impl From<Bucket> for BucketUpdate {
    fn from(bucket: Bucket) -> Self {
        Self {
            public: bucket.public,
            file_size_limit: bucket.file_size_limit,
            allowed_mime_types: bucket.allowed_mime_types,
        }
    }
}
impl From<&Bucket> for BucketUpdate {
    fn from(bucket: &Bucket) -> Self {
        bucket.clone().into()
    }
}

pub(super) fn validate_limit(limit: Option<u64>) -> Result<()> {
    if limit == Some(0) {
        return Err(Error::Usage("file_size_limit must be positive".into()));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
pub struct StoredObject {
    pub id: String,
    pub bucket: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub etag: String,
    pub public_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ListedObject {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub etag: String,
    pub owner: Option<String>,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Listing {
    pub folders: Vec<String>,
    pub objects: Vec<ListedObject>,
}

#[derive(Clone, Debug, Default)]
pub struct UploadOptions {
    /// `None` guesses from the name's extension (see [`guess_content_type`](super::guess_content_type)),
    /// falling back to `application/octet-stream`. The server checks the type
    /// against the bytes and the bucket's allowed MIME types.
    pub content_type: Option<String>,
    /// Replace a file with the same name instead of failing with `object_exists`.
    pub upsert: bool,
}

#[derive(Clone, Debug, Default)]
pub struct OpenOptions {
    /// Inclusive byte range; None for the end means to EOF.
    pub range: Option<(u64, Option<u64>)>,
    pub if_none_match: Option<String>,
    pub download: bool,
}

#[derive(Clone, Debug)]
pub struct ListOptions {
    pub prefix: String,
    pub limit: u16,
    pub offset: u64,
}
impl Default for ListOptions {
    fn default() -> Self {
        Self {
            prefix: String::new(),
            limit: 100,
            offset: 0,
        }
    }
}
