//! Bucket administration; object transfer belongs to BucketFiles.
use super::models::validate_limit;
use super::{Bucket, BucketFiles, BucketSettings, BucketUpdate};
use crate::{Client, Error, Result, encoding, http::Spec};
use reqwest::Method;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct StorageClient {
    pub(crate) client: Client,
}
impl StorageClient {
    pub fn from(&self, bucket: &str) -> Result<BucketFiles> {
        encoding::bucket(bucket)?;
        Ok(BucketFiles {
            client: self.client.clone(),
            bucket: bucket.into(),
        })
    }
    pub async fn list_buckets(&self) -> Result<Vec<Bucket>> {
        self.client
            .json::<Vec<Bucket>>(Spec::new(Method::GET, "/storage/v1/bucket"))
            .await
            .map(|r| r.data)
    }
    pub async fn get_bucket(&self, id: &str) -> Result<Bucket> {
        encoding::bucket(id)?;
        self.client
            .json::<Bucket>(Spec::new(Method::GET, format!("/storage/v1/bucket/{id}")))
            .await
            .map(|r| r.data)
    }
    pub async fn create_bucket(&self, id: &str, settings: BucketSettings) -> Result<Bucket> {
        encoding::bucket(id)?;
        settings.validate()?;
        let mut value = serde_json::to_value(settings).map_err(|e| Error::Usage(e.to_string()))?;
        value["id"] = Value::String(id.into());
        self.client
            .json::<Bucket>(Spec::new(Method::POST, "/storage/v1/bucket").json(value))
            .await
            .map(|r| r.data)
    }
    /// Replaces every setting of the bucket; see [`BucketUpdate`].
    pub async fn update_bucket(&self, id: &str, settings: BucketUpdate) -> Result<Bucket> {
        encoding::bucket(id)?;
        validate_limit(settings.file_size_limit)?;
        self.client
            .json::<Bucket>(
                Spec::new(Method::PUT, format!("/storage/v1/bucket/{id}"))
                    .json(serde_json::to_value(settings).map_err(|e| Error::Usage(e.to_string()))?),
            )
            .await
            .map(|r| r.data)
    }
    pub async fn delete_bucket(&self, id: &str) -> Result<()> {
        encoding::bucket(id)?;
        self.client
            .bytes(Spec::new(
                Method::DELETE,
                format!("/storage/v1/bucket/{id}"),
            ))
            .await
            .map(|_| ())
    }
}
