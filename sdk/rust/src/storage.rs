//! File transfers and buckets. Uploads send raw bytes, not multipart forms.
mod client;
mod content_type;
mod files;
mod models;

pub use client::StorageClient;
pub use content_type::guess_content_type;
pub use files::BucketFiles;
pub use models::{
    Bucket, BucketSettings, BucketUpdate, ListOptions, ListedObject, Listing, OpenOptions,
    StoredObject, UploadOptions,
};
