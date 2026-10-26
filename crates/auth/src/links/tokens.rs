//! Storage of link tokens in `auth.one_time_tokens`.
use deadpool_postgres::Transaction;
use nelcota_core::ApiError;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::LinkKind;
use crate::{db::db_error, sessions::new_opaque_token};

/// Minimum interval between two links of the same kind to one account: the
/// request endpoints are public and must not be usable to flood an inbox.
const COOLDOWN_SECONDS: f64 = 60.0;

/// Stores a new link for the account and returns its token, or `None` while
/// the previous link of that kind is in its cooldown. Asking again voids the
/// earlier links of the kind: only the latest one works.
pub(crate) async fn issue(
    tx: &Transaction<'_>,
    user_id: Uuid,
    kind: LinkKind,
) -> Result<Option<String>, ApiError> {
    // Serializes the empty-token case too. There is no token row to lock on
    // the first request; every issuer instead locks the owning account.
    let eligible = tx
        .query_opt(
            "SELECT 1 FROM auth.users
             WHERE id = $1 AND (email_confirmed_at IS NULL OR NOT $2)
             FOR UPDATE",
            &[&user_id, &kind.only_unconfirmed()],
        )
        .await
        .map_err(db_error)?;
    if eligible.is_none() {
        return Ok(None);
    }
    let recent: bool = tx
        .query_one(
            "SELECT EXISTS (
                SELECT 1 FROM auth.one_time_tokens
                WHERE user_id = $1 AND kind = $2
                  AND created_at > now() - make_interval(secs => $3))",
            &[&user_id, &kind.as_str(), &COOLDOWN_SECONDS],
        )
        .await
        .map_err(db_error)?
        .get(0);
    if recent {
        return Ok(None);
    }
    tx.execute(
        "DELETE FROM auth.one_time_tokens WHERE user_id = $1 AND kind = $2",
        &[&user_id, &kind.as_str()],
    )
    .await
    .map_err(db_error)?;
    let (token, hash) = new_opaque_token();
    tx.execute(
        "INSERT INTO auth.one_time_tokens (user_id, kind, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4))",
        &[&user_id, &kind.as_str(), &hash, &kind.ttl_minutes()],
    )
    .await
    .map_err(db_error)?;
    Ok(Some(token))
}

/// SHA-256 of a token sent by a client; `None` when it cannot be one of ours.
pub(crate) fn hash(token: &str) -> Option<Vec<u8>> {
    (!token.is_empty() && token.len() <= 128).then(|| Sha256::digest(token.as_bytes()).to_vec())
}

/// Whether the link is still usable, without consuming it.
pub(crate) async fn is_valid(
    tx: &Transaction<'_>,
    kind: LinkKind,
    hash: &[u8],
) -> Result<bool, ApiError> {
    Ok(tx
        .query_opt(
            "SELECT 1 FROM auth.one_time_tokens
             WHERE token_hash = $1 AND kind = $2
               AND used_at IS NULL AND expires_at > now()",
            &[&hash, &kind.as_str()],
        )
        .await
        .map_err(db_error)?
        .is_some())
}

/// Marks the link as used and returns its account. Atomic: of two concurrent
/// submissions of the same link, only one gets the account.
pub(crate) async fn consume(
    tx: &Transaction<'_>,
    kind: LinkKind,
    hash: &[u8],
) -> Result<Option<Uuid>, ApiError> {
    // Match issuance/password-login lock order: account before link/session.
    // The UPDATE below rechecks validity after waiting for this account lock.
    let account = tx
        .query_opt(
            "SELECT u.id FROM auth.users u
         JOIN auth.one_time_tokens t ON t.user_id = u.id
         WHERE t.token_hash = $1 AND t.kind = $2
           AND t.used_at IS NULL AND t.expires_at > now()
         FOR UPDATE OF u",
            &[&hash, &kind.as_str()],
        )
        .await
        .map_err(db_error)?;
    if account.is_none() {
        return Ok(None);
    }
    Ok(tx
        .query_opt(
            "UPDATE auth.one_time_tokens SET used_at = now()
             WHERE token_hash = $1 AND kind = $2
               AND used_at IS NULL AND expires_at > now()
             RETURNING user_id",
            &[&hash, &kind.as_str()],
        )
        .await
        .map_err(db_error)?
        .map(|row| row.get(0)))
}

#[cfg(test)]
mod tests {
    use super::hash;

    #[test]
    fn malformed_tokens_have_no_hash() {
        assert!(hash("").is_none());
        assert!(hash(&"x".repeat(129)).is_none());
        assert_eq!(hash("abc").map(|h| h.len()), Some(32));
    }
}
