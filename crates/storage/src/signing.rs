//! Signed-file grants: authorization, token issuing and grant verification.
use crate::{
    StorageState, db,
    error::{object_not_found, store_failed},
    path,
};
use axum::http::StatusCode;
use nelcota_core::{ApiError, Claims, db::begin_request};
use serde_json::json;
use uuid::Uuid;
/// Longest a signed URL may live: a week.
const MAX_SIGNED_SECS: u64 = 7 * 86_400;
const SIGNED_TYP: &str = "nelcota-storage-url";
pub(crate) async fn token(
    state: &StorageState,
    claims: &Claims,
    bucket: &str,
    name: &str,
    expires_in: u64,
) -> Result<String, ApiError> {
    let bucket = path::bucket(bucket)?;
    let name = path::object(name)?;
    if !(1..=MAX_SIGNED_SECS).contains(&expires_in) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_expiry",
            format!("expires_in between 1 and {MAX_SIGNED_SECS} seconds"),
        ));
    }
    // The grant covers the bytes the signer could read, not whatever a later
    // upload, replacement or re-creation puts under the same name.
    let version: Uuid = {
        let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
        let tx = begin_request(&mut client, claims)
            .await
            .map_err(|e| ApiError::from_db(e, claims.role()))?;
        tx.query_opt(
            "SELECT version FROM storage.objects WHERE bucket_id = $1 AND name = $2",
            &[&bucket, &name],
        )
        .await
        .map_err(|e| ApiError::from_db(e, claims.role()))?
        .ok_or_else(object_not_found)?
        .get(0)
    };
    let now = jsonwebtoken_now();
    let token = state
        .keys
        .sign(&json!({
            "typ": SIGNED_TYP,
            "bucket": bucket,
            "name": name,
            "version": version.to_string(),
            "iat": now,
            "exp": now + expires_in,
        }))
        .map_err(store_failed)?;
    Ok(token)
}

fn jsonwebtoken_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn signed_version(payload: &serde_json::Value) -> Option<Uuid> {
    Uuid::parse_str(payload["version"].as_str()?).ok()
}

fn remaining_secs(payload: &serde_json::Value, now: u64) -> Option<u64> {
    payload["exp"]
        .as_u64()?
        .checked_sub(now)
        .filter(|&secs| secs > 0)
}

pub(crate) async fn resolve(
    state: &StorageState,
    bucket: &str,
    name: &str,
    token: Option<&str>,
) -> Result<(db::Object, u64), ApiError> {
    let bucket = path::bucket(bucket)?;
    let name = path::object(name)?;
    let invalid = || {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_signature",
            "invalid or expired signed URL",
        )
    };
    let payload = token
        .and_then(|t| state.keys.verify_payload(t).ok())
        .ok_or_else(invalid)?;
    let matches = payload["typ"] == SIGNED_TYP
        && payload["bucket"] == bucket
        && payload["name"].as_str() == Some(name.as_str());
    if !matches {
        return Err(invalid());
    }
    // Grants issued before they named a version cannot say which bytes they cover.
    let version = signed_version(&payload).ok_or_else(invalid)?;
    // File grants have explicit deadlines; API JWT clock leeway does not apply.
    remaining_secs(&payload, jsonwebtoken_now()).ok_or_else(invalid)?;
    // Another version under the same name is another file: the signed one is gone.
    let object = db::object(&state.pool, bucket, &name)
        .await?
        .filter(|object| object.version == version)
        .ok_or_else(object_not_found)?;
    // A slow catalog lookup must not hand S3 an already expired grant.
    let secs = remaining_secs(&payload, jsonwebtoken_now()).ok_or_else(invalid)?;
    Ok((object, secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_deadlines_have_no_clock_leeway() {
        let payload = json!({ "exp": 100 });
        assert_eq!(remaining_secs(&payload, 99), Some(1));
        assert_eq!(remaining_secs(&payload, 100), None);
        assert_eq!(remaining_secs(&payload, 101), None);
        assert_eq!(remaining_secs(&payload, 129), None);
        for malformed in [json!({}), json!({ "exp": -1 }), json!({ "exp": "100" })] {
            assert_eq!(remaining_secs(&malformed, 99), None);
        }
    }

    #[test]
    fn grants_name_the_signed_version() {
        let version = Uuid::now_v7();
        let payload = json!({ "version": version.to_string() });
        assert_eq!(signed_version(&payload), Some(version));
        for malformed in [
            json!({}),
            json!({ "version": null }),
            json!({ "version": "not-a-uuid" }),
            json!({ "version": 7 }),
        ] {
            assert_eq!(signed_version(&malformed), None);
        }
    }
}
