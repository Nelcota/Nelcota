//! File metadata reads, listing and deletion under the caller's policies.
use crate::{
    StorageState, db,
    error::{bucket_not_found, object_not_found},
    path,
    store::Store,
};
use nelcota_core::{ApiError, Claims, db::begin_request};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
const MAX_LIST: i64 = 1000;

#[derive(Deserialize, Serialize)]
pub struct ListedObject {
    pub id: Uuid,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub etag: String,
    pub owner: Option<Uuid>,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Deserialize, Serialize)]
pub struct ObjectListing {
    pub folders: Vec<String>,
    pub objects: Vec<ListedObject>,
}
impl StorageState {
    /// A file under `claims`' policies (the panel passes `service_role`).
    pub async fn object(
        &self,
        claims: &Claims,
        bucket: &str,
        name: &str,
    ) -> Result<db::Object, ApiError> {
        let bucket = path::bucket(bucket)?;
        let name = path::object(name)?;
        let object = {
            let mut client = self.pool.get().await.map_err(ApiError::from_pool)?;
            let tx = begin_request(&mut client, claims)
                .await
                .map_err(|e| ApiError::from_db(e, claims.role()))?;
            let sql = format!(
                "SELECT {} FROM storage.objects WHERE bucket_id = $1 AND name = $2",
                db::OBJECT_COLUMNS
            );
            let row = tx
                .query_opt(&sql, &[&bucket, &name])
                .await
                .map_err(|e| ApiError::from_db(e, claims.role()))?;
            row.as_ref().map(db::Object::from_row)
        }
        .ok_or_else(object_not_found)?;
        Ok(object)
    }
}

impl StorageState {
    /// Deletes a file under `claims`' policies: the row, then the bytes.
    pub async fn delete(&self, claims: &Claims, bucket: &str, name: &str) -> Result<(), ApiError> {
        let bucket = path::bucket(bucket)?;
        let name = path::object(name)?;
        let db_err = |e| ApiError::from_db(e, claims.role());
        let version: Uuid = {
            let mut client = self.pool.get().await.map_err(ApiError::from_pool)?;
            let tx = begin_request(&mut client, claims).await.map_err(db_err)?;
            let row = tx
            .query_opt(
                "DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2 RETURNING version",
                &[&bucket, &name],
            )
            .await
            .map_err(db_err)?
            .ok_or_else(object_not_found)?;
            tx.commit().await.map_err(db_err)?;
            row.get(0)
        };
        self.store
            .delete_quietly(&Store::key(bucket, version))
            .await;
        Ok(())
    }
}

impl StorageState {
    /// Folders and files right under `prefix`, under `claims`' policies.
    pub async fn list(
        &self,
        claims: &Claims,
        bucket: &str,
        prefix: &str,
        limit: Option<i64>,
        offset: i64,
    ) -> Result<ObjectListing, ApiError> {
        let bucket = path::bucket(bucket)?;
        let prefix = path::prefix(prefix)?;
        let limit = limit.unwrap_or(100).clamp(1, MAX_LIST);
        let offset = offset.max(0);
        // UTF-8 plus NUL segment separators matches the generated directory key.
        // Advancing its final NUL to 1 skips precisely this prefix's subtree.
        let key: Vec<u8> = prefix
            .bytes()
            .map(|byte| match byte {
                b'/' => 0,
                _ => byte,
            })
            .collect();
        let upper = match key.is_empty() {
            true => None,
            false => {
                let mut upper = key.clone();
                if let Some(last) = upper.last_mut() {
                    *last = 1;
                }
                Some(upper)
            }
        };
        let db_err = |e| ApiError::from_db(e, claims.role());
        let mut client = self.pool.get().await.map_err(ApiError::from_pool)?;
        let tx = begin_request(&mut client, claims).await.map_err(db_err)?;
        // Keep the ordered page seek even before ANALYZE: missing parent
        // statistics can make a bitmap scan collect every file, then sort it.
        // This setting is local to the listing transaction.
        tx.batch_execute("SET LOCAL enable_bitmapscan = off")
            .await
            .map_err(db_err)?;
        let row = tx
            .query_one(
                include_str!("list.sql"),
                &[&bucket, &prefix, &key, &upper, &limit, &offset],
            )
            .await
            .map_err(db_err)?;
        let text: String = row.get(0);
        serde_json::from_str(&text).map_err(|error| {
            tracing::error!(
                event = "storage.invalid_listing",
                error_type = std::any::type_name_of_val(&error),
                "invalid object listing"
            );
            ApiError::internal()
        })
    }
}

impl StorageState {
    pub(crate) async fn public_object(
        &self,
        bucket: &str,
        name: &str,
    ) -> Result<db::Object, ApiError> {
        let bucket = path::bucket(bucket)?;
        let name = path::object(name)?;
        match db::bucket(&self.pool, bucket).await? {
            Some(settings) if settings.public => {}
            _ => return Err(bucket_not_found()),
        }
        db::object(&self.pool, bucket, &name)
            .await?
            .ok_or_else(object_not_found)
    }
}
