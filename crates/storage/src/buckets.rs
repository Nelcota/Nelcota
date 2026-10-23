//! Bucket operations shared by the storage API and the panel. PostgreSQL
//! privileges and policies decide what the caller can read or change.
mod http;
pub(crate) use http::{create, list, one, remove, update};

use crate::{StorageState, path};
use nelcota_core::{ApiError, Claims, db::begin_request};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio_postgres::{error::SqlState, types::ToSql};

const COLUMNS: &str = "id, public, file_size_limit, allowed_mime_types, created_at, updated_at";

#[derive(Debug, Deserialize, Serialize)]
pub struct Bucket {
    pub id: String,
    pub public: bool,
    pub file_size_limit: Option<i64>,
    pub allowed_mime_types: Option<Vec<String>>,
    pub created_at: String,
    pub updated_at: String,
}

/// A PUT replaces all settings; omitted fields take their defaults.
#[derive(Default, Deserialize)]
pub struct BucketSettings {
    #[serde(default)]
    pub public: bool,
    pub file_size_limit: Option<i64>,
    pub allowed_mime_types: Option<Vec<String>>,
}

/// Operations report facts; each HTTP adapter chooses its error vocabulary.
#[derive(Debug)]
pub enum BucketError {
    InvalidSizeLimit,
    InvalidMimeType(String),
    Exists,
    NotFound,
    NotEmpty { count: Option<i64> },
    Request(ApiError),
}

impl From<ApiError> for BucketError {
    fn from(error: ApiError) -> Self {
        Self::Request(error)
    }
}

impl BucketSettings {
    fn validate(&self) -> Result<(), BucketError> {
        if self.file_size_limit.is_some_and(|limit| limit <= 0) {
            return Err(BucketError::InvalidSizeLimit);
        }
        if let Some(entry) = self
            .allowed_mime_types
            .iter()
            .flatten()
            .find(|entry| !mime_entry_ok(entry))
        {
            return Err(BucketError::InvalidMimeType(entry.clone()));
        }
        Ok(())
    }

    fn mime_types(&self) -> Option<Vec<String>> {
        self.allowed_mime_types.as_ref().map(|list| {
            list.iter()
                .map(|entry| entry.to_ascii_lowercase())
                .collect()
        })
    }
}

pub fn mime_entry_ok(entry: &str) -> bool {
    let token = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&c))
    };
    let mut parts = entry.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(kind), Some(value), None) => token(kind) && (value == "*" || token(value)),
        _ => false,
    }
}

fn db_error(error: tokio_postgres::Error, claims: &Claims) -> BucketError {
    match error.code() {
        Some(&SqlState::UNIQUE_VIOLATION) => BucketError::Exists,
        Some(&SqlState::FOREIGN_KEY_VIOLATION) => BucketError::NotEmpty { count: None },
        _ => BucketError::Request(ApiError::from_db(error, claims.role())),
    }
}

/// Owns the transaction and decodes PostgreSQL's JSON before returning data.
async fn query_as<T: DeserializeOwned>(
    state: &StorageState,
    claims: &Claims,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Option<T>, BucketError> {
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_request(&mut client, claims)
        .await
        .map_err(|error| db_error(error, claims))?;
    let row = tx
        .query_opt(sql, params)
        .await
        .map_err(|error| db_error(error, claims))?;
    let result = row
        .map(|row| {
            serde_json::from_str(row.get::<_, &str>(0)).map_err(|error| {
                tracing::error!(
                    event = "storage.invalid_bucket",
                    error_type = std::any::type_name_of_val(&error),
                    "invalid bucket record"
                );
                BucketError::Request(ApiError::internal())
            })
        })
        .transpose()?;
    tx.commit().await.map_err(|error| db_error(error, claims))?;
    Ok(result)
}

impl StorageState {
    /// Buckets visible under the caller's policies, ordered by id.
    pub async fn buckets(&self, claims: &Claims) -> Result<Vec<Bucket>, BucketError> {
        let sql = format!(
            "SELECT coalesce(json_agg(b ORDER BY b.id), '[]')::text
               FROM (SELECT {COLUMNS} FROM storage.buckets) b"
        );
        Ok(query_as(self, claims, &sql, &[]).await?.unwrap_or_default())
    }

    /// A missing or policy-hidden bucket reports `NotFound`.
    pub async fn bucket(&self, claims: &Claims, id: &str) -> Result<Bucket, BucketError> {
        let id = path::bucket(id)?;
        let sql = format!(
            "SELECT row_to_json(b)::text FROM (SELECT {COLUMNS} FROM storage.buckets WHERE id = $1) b"
        );
        query_as(self, claims, &sql, &[&id])
            .await?
            .ok_or(BucketError::NotFound)
    }

    /// Validates settings and creates a bucket as the caller.
    pub async fn create_bucket(
        &self,
        claims: &Claims,
        id: &str,
        settings: BucketSettings,
    ) -> Result<Bucket, BucketError> {
        let id = path::bucket(id)?;
        settings.validate()?;
        let sql = format!(
            "WITH b AS (
                INSERT INTO storage.buckets (id, public, file_size_limit, allowed_mime_types)
                VALUES ($1, $2, $3, $4) RETURNING {COLUMNS})
             SELECT row_to_json(b)::text FROM b"
        );
        query_as(
            self,
            claims,
            &sql,
            &[
                &id,
                &settings.public,
                &settings.file_size_limit,
                &settings.mime_types(),
            ],
        )
        .await?
        .ok_or_else(|| ApiError::internal().into())
    }

    /// Replaces all settings; MIME entries are stored in lowercase.
    pub async fn update_bucket(
        &self,
        claims: &Claims,
        id: &str,
        settings: BucketSettings,
    ) -> Result<Bucket, BucketError> {
        let id = path::bucket(id)?;
        settings.validate()?;
        let sql = format!(
            "WITH b AS (
                UPDATE storage.buckets
                   SET public = $2, file_size_limit = $3, allowed_mime_types = $4, updated_at = now()
                 WHERE id = $1 RETURNING {COLUMNS})
             SELECT row_to_json(b)::text FROM b"
        );
        query_as(
            self,
            claims,
            &sql,
            &[
                &id,
                &settings.public,
                &settings.file_size_limit,
                &settings.mime_types(),
            ],
        )
        .await?
        .ok_or(BucketError::NotFound)
    }

    /// Deletes an empty bucket; a foreign key preserves buckets with files.
    pub async fn delete_bucket(&self, claims: &Claims, id: &str) -> Result<(), BucketError> {
        let id = path::bucket(id)?;
        let result = query_as::<String>(
            self,
            claims,
            "DELETE FROM storage.buckets WHERE id = $1 RETURNING to_json(id)::text",
            &[&id],
        )
        .await;
        match result {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(BucketError::NotFound),
            Err(BucketError::NotEmpty { .. }) => {
                // The FK is authoritative, including concurrent uploads. Read
                // usage only after the failed transaction has rolled back.
                let count = query_as::<i64>(
                    self,
                    claims,
                    "SELECT to_json(count(*))::text FROM storage.objects WHERE bucket_id = $1",
                    &[&id],
                )
                .await
                .ok()
                .flatten();
                Err(BucketError::NotEmpty { count })
            }
            Err(error) => Err(error),
        }
    }
}
