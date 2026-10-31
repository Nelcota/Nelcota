//! Signing in by opening a signup confirmation or a magic link.
use std::net::IpAddr;

use nelcota_core::ApiError;
use serde_json::Value;

use super::{LinkKind, tokens};
use crate::{
    AuthState,
    accounts::{confirm_inbox_owner, retire_unconfirmed_access},
    db::{begin_auth, db_error},
    error::invalid_grant,
    pkce,
    sessions::start_session,
};

fn expired_link() -> ApiError {
    invalid_grant("invalid or expired link")
}

/// Consumes the link, marks the email as confirmed and starts a session.
///
/// Opening a link proves only that someone reads the inbox. A signup
/// confirmation keeps the password chosen at signup only when `code_verifier`
/// proves that the client confirming is the one that signed up (the PKCE
/// challenge sent with the signup); otherwise anyone could have registered the
/// address with a password of their own, and the inbox owner claims the account
/// without it, as with a magic link.
pub(crate) async fn sign_in(
    state: &AuthState,
    kind: LinkKind,
    token: &str,
    code_verifier: Option<&str>,
    ip: Option<IpAddr>,
    user_agent: Option<&str>,
) -> Result<Value, ApiError> {
    debug_assert_ne!(kind, LinkKind::Recovery, "recovery also sets a password");
    let hash = tokens::hash(token).ok_or_else(expired_link)?;

    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    let user_id = tokens::consume(&tx, kind, &hash)
        .await?
        .ok_or_else(expired_link)?;
    let challenge = tokens::code_challenge(&tx, &hash).await?;
    let signed_up_here = kind == LinkKind::Signup
        && matches!(
            (code_verifier, challenge.as_deref()),
            (Some(verifier), Some(challenge)) if pkce::proves(verifier, challenge)
        );
    match signed_up_here {
        true => {
            // The client that chose the password opened its own link.
            let confirmed = tx
                .execute(
                    "UPDATE auth.users SET email_confirmed_at = now(), updated_at = now()
                     WHERE id = $1 AND email_confirmed_at IS NULL",
                    &[&user_id],
                )
                .await
                .map_err(db_error)?;
            if confirmed > 0 {
                retire_unconfirmed_access(&tx, user_id).await?;
            }
        }
        false => {
            // The inbox owner must not inherit a password chosen by whoever
            // registered the address.
            confirm_inbox_owner(&tx, user_id).await?;
        }
    }
    let session = start_session(state, &tx, user_id, ip, user_agent).await?;
    tx.commit().await.map_err(db_error)?;
    tracing::info!(
        user_id = %user_id,
        kind = kind.as_str(),
        password_kept = signed_up_here,
        "signed in through an email link"
    );
    Ok(session)
}
