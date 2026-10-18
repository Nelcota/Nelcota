//! Password recovery by email.
//!
//! 1. `POST /auth/v1/recover {email}`: if the account exists, sends a link to
//!    the app page (`NELCOTA_PASSWORD_RECOVERY_URL#type=recovery&token=...`).
//!    The response is the same whether or not the account exists.
//! 2. `POST /auth/v1/verify {type: "recovery", token, password}`: changes the
//!    password, ends the other sessions and returns a new session.

use nelcota_core::ApiError;
use serde_json::Value;
use std::net::IpAddr;

use crate::{
    AuthState,
    accounts::confirm_inbox_owner,
    credentials::validate_password,
    db::{begin_auth, db_error},
    error::{invalid_grant, validation, weak_password},
    links::{self, LinkKind},
    sessions::start_session,
};

fn expired_link() -> ApiError {
    invalid_grant("invalid or expired recovery link")
}

/// Consumes a link and replaces the password and session atomically.
pub(crate) async fn complete(
    state: &AuthState,
    token: &str,
    password: Option<String>,
    ip: Option<IpAddr>,
    agent: Option<&str>,
) -> Result<Value, ApiError> {
    let hash = links::hash(token).ok_or_else(expired_link)?;
    let password = password.ok_or_else(|| validation("password is required"))?;
    validate_password(&password).map_err(weak_password)?;

    // Check the link before argon2 (expensive): an invalid link costs no CPU.
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    {
        let tx = begin_auth(&mut client).await?;
        let valid = links::is_valid(&tx, LinkKind::Recovery, &hash).await?;
        tx.commit().await.map_err(db_error)?;
        if !valid {
            return Err(expired_link());
        }
    }
    drop(client);

    let phc = state
        .passwords
        .hash(password)
        .await
        .ok_or_else(ApiError::internal)?;

    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    // Atomic consumption: two submissions of the same link do not change the
    // password twice.
    let user_id = links::consume(&tx, LinkKind::Recovery, &hash)
        .await?
        .ok_or_else(expired_link)?;
    // First inbox proof retires credentials set before verification. Consume
    // holds the account lock; claim before assigning the owner's new password.
    confirm_inbox_owner(&tx, user_id).await?;
    tx.execute(
        "UPDATE auth.users
            SET encrypted_password = $2, updated_at = now(),
                email_confirmed_at = coalesce(email_confirmed_at, now())
          WHERE id = $1",
        &[&user_id, &phc],
    )
    .await
    .map_err(db_error)?;
    crate::db::retire_pending_credentials(&tx, user_id).await?;
    // Whoever signed in with the old password loses access (refresh tokens die
    // immediately; access JWTs already issued stay valid until they expire).
    tx.execute(
        "UPDATE auth.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        &[&user_id],
    )
    .await
    .map_err(db_error)?;
    let session = start_session(state, &tx, user_id, ip, agent).await?;
    tx.commit().await.map_err(db_error)?;
    tracing::info!(user_id = %user_id, "password reset through the recovery link");
    Ok(session)
}
