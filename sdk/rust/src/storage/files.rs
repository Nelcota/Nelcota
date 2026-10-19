//! Files of one bucket: URL validation, streaming and transfer response ownership.
use super::{ListOptions, Listing, OpenOptions, StoredObject, UploadOptions, guess_content_type};
use crate::{Client, Error, Result, encoding, http::Spec};
use bytes::Bytes;
use reqwest::{
    Method,
    header::{CONTENT_TYPE, HeaderValue, IF_NONE_MATCH, RANGE},
};
use serde_json::{Value, json};
use std::time::Duration;
use url::Url;

#[derive(Clone, Debug)]
pub struct BucketFiles {
    pub(super) client: Client,
    pub(super) bucket: String,
}
impl BucketFiles {
    fn path(&self, kind: &str, name: &str) -> Result<String> {
        Ok(format!(
            "/storage/v1/object/{kind}{}/{}",
            self.bucket,
            encoding::object(name)?
        ))
    }
    pub async fn upload(
        &self,
        name: &str,
        body: impl Into<reqwest::Body>,
        options: UploadOptions,
    ) -> Result<StoredObject> {
        let mut spec = Spec::new(
            match options.upsert {
                true => Method::PUT,
                false => Method::POST,
            },
            self.path("", name)?,
        );
        let content_type = options
            .content_type
            .as_deref()
            .or_else(|| guess_content_type(name))
            .unwrap_or("application/octet-stream");
        let header = HeaderValue::from_str(content_type)
            .map_err(|_| Error::Usage("invalid content type header".into()))?;
        let media = content_type.split(';').next().unwrap_or_default();
        let valid = media.split_once('/').is_some_and(|(kind, subtype)| {
            [kind, subtype].iter().all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            })
        });
        if !valid {
            return Err(Error::Usage("content type requires type/subtype".into()));
        }
        spec.headers.insert(CONTENT_TYPE, header);
        spec.body = Some(body.into());
        spec.timeout = Some(Duration::ZERO);
        self.client.json::<StoredObject>(spec).await.map(|r| r.data)
    }
    /// Stream a Tokio reader (for example a File), without buffering the upload.
    pub async fn upload_reader<R>(
        &self,
        name: &str,
        reader: R,
        options: UploadOptions,
    ) -> Result<StoredObject>
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
    {
        self.upload(
            name,
            reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(reader)),
            options,
        )
        .await
    }
    fn open_spec(&self, name: &str, options: OpenOptions) -> Result<Spec> {
        let mut spec = Spec::new(Method::GET, self.path("", name)?);
        spec.timeout = Some(Duration::ZERO);
        if let Some((start, end)) = options.range {
            if end.is_some_and(|end| end < start) {
                return Err(Error::Usage("range end must be >= start".into()));
            }
            let range = format!(
                "bytes={start}-{}",
                end.map(|v| v.to_string()).unwrap_or_default()
            );
            spec.headers.insert(
                RANGE,
                HeaderValue::from_str(&range).map_err(|_| Error::Usage("invalid range".into()))?,
            );
        }
        if let Some(etag) = options.if_none_match {
            spec.headers.insert(
                IF_NONE_MATCH,
                HeaderValue::from_str(&etag).map_err(|_| Error::Usage("invalid ETag".into()))?,
            );
        }
        if options.download {
            spec.params.push(("download".into(), String::new()));
        }
        Ok(spec)
    }
    /// Raw streaming response: handle 206/304 and body failures after return yourself.
    /// Cross-origin S3 redirects are followed without forwarding the bearer token.
    pub async fn open(&self, name: &str, options: OpenOptions) -> Result<reqwest::Response> {
        self.client.raw(self.open_spec(name, options)?).await
    }
    /// Buffer the complete file. Use open for large files or conditional downloads.
    pub async fn download(&self, name: &str) -> Result<Bytes> {
        self.client
            .bytes(self.open_spec(name, OpenOptions::default())?)
            .await
            .map(|r| r.data)
    }
    pub async fn remove(&self, name: &str) -> Result<()> {
        self.client
            .bytes(Spec::new(Method::DELETE, self.path("", name)?))
            .await
            .map(|_| ())
    }
    pub async fn list(&self, options: ListOptions) -> Result<Listing> {
        if !(1..=1000).contains(&options.limit) {
            return Err(Error::Usage("listing limit must be 1–1000".into()));
        }
        let body = json!({"prefix": encoding::prefix(&options.prefix)?, "limit":options.limit, "offset":options.offset});
        self.client
            .json::<Listing>(
                Spec::new(
                    Method::POST,
                    format!("/storage/v1/object/list/{}", self.bucket),
                )
                .json(body),
            )
            .await
            .map(|r| r.data)
    }
    pub async fn create_signed_url(&self, name: &str, expires_in: u64) -> Result<Url> {
        if !(1..=604_800).contains(&expires_in) {
            return Err(Error::Usage(
                "signed URL duration must be 1–604800 seconds".into(),
            ));
        }
        let response = self
            .client
            .json::<Value>(
                Spec::new(Method::POST, self.path("sign/", name)?)
                    .json(json!({"expires_in":expires_in})),
            )
            .await?;
        let relative = response.data["signed_url"]
            .as_str()
            .filter(|url| url.starts_with("/storage/v1/object/sign/"))
            .ok_or_else(|| Error::InvalidResponse {
                status: response.status,
                message: "unexpected signed URL".into(),
            })?;
        self.client.url(relative)
    }
    /// Construct a public URL locally. The bucket must allow public reads.
    pub fn public_url(&self, name: &str) -> Result<Url> {
        self.client.url(&self.path("public/", name)?)
    }
}
