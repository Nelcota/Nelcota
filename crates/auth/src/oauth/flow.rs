//! Sign-ins in progress (`auth.flow_states`): from `/authorize` to the
//! provider's callback, and from there to the app's code exchange.
use deadpool_postgres::Transaction;
use nelcota_core::ApiError;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{ProviderKind, pkce};
use crate::{db::db_error, sessions::new_opaque_token};

/// Time to choose an account at the provider and come back.
const SIGN_IN_MINUTES: i32 = 10;
/// Time for the app to redeem the code it received.
const CODE_MINUTES: i32 = 5;
/// Stale rows one `/authorize` removes; the pruner takes any backlog.
const STALE_SWEEP: i64 = 100;

/// A sign-in waiting for the provider's answer.
pub(super) struct Pending {
    pub id: i64,
    pub provider: ProviderKind,
    pub provider_verifier: String,
    pub redirect_to: String,
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Records a new sign-in and returns the `state` to send to the provider.
/// A few stale rows go at the same time, so the table stays near its live
/// sign-ins between prune passes. The sweep is bounded and skips rows another
/// transaction holds: concurrent sign-ins never wait on each other's cleanup.
pub(super) async fn start(
    tx: &Transaction<'_>,
    provider: ProviderKind,
    provider_verifier: &str,
    code_challenge: &str,
    redirect_to: &str,
) -> Result<String, ApiError> {
    tx.execute(
        "DELETE FROM auth.flow_states WHERE id IN (
             SELECT id FROM auth.flow_states WHERE expires_at < now()
              LIMIT $1 FOR UPDATE SKIP LOCKED)",
        &[&STALE_SWEEP],
    )
    .await
    .map_err(db_error)?;
    let (state, state_hash) = new_opaque_token();
    tx.execute(
        "INSERT INTO auth.flow_states
             (state_hash, provider, provider_verifier, code_challenge, redirect_to, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))",
        &[
            &state_hash,
            &provider.as_str(),
            &provider_verifier,
            &code_challenge,
            &redirect_to,
            &SIGN_IN_MINUTES,
        ],
    )
    .await
    .map_err(db_error)?;
    Ok(state)
}

/// Claims the callback once, before contacting the provider. Clearing its
/// verifier also makes a cancelled/failed exchange require a new authorize.
pub(super) async fn claim(tx: &Transaction<'_>, state: &str) -> Result<Option<Pending>, ApiError> {
    if state.is_empty() || state.len() > 128 {
        return Ok(None);
    }
    let row = tx
        .query_opt(
            "WITH pending AS (
                 SELECT id, provider, provider_verifier, redirect_to FROM auth.flow_states
                  WHERE state_hash = $1 AND auth_code_hash IS NULL
                    AND provider_verifier <> '' AND expires_at > now()
                  FOR UPDATE
             )
             UPDATE auth.flow_states f SET provider_verifier = ''
               FROM pending p WHERE f.id = p.id
             RETURNING p.id, p.provider, p.provider_verifier, p.redirect_to",
            &[&hash(state)],
        )
        .await
        .map_err(db_error)?;
    Ok(row.and_then(|row| {
        Some(Pending {
            id: row.get(0),
            provider: ProviderKind::parse(row.get(1))?,
            provider_verifier: row.get(2),
            redirect_to: row.get(3),
        })
    }))
}

/// Binds the sign-in to its account and returns the code for the app, or
/// `None` when the `state` was already used (a replayed callback).
pub(super) async fn issue_code(
    tx: &Transaction<'_>,
    id: i64,
    user_id: Uuid,
) -> Result<Option<String>, ApiError> {
    let (code, code_hash) = new_opaque_token();
    let updated = tx
        .execute(
            "UPDATE auth.flow_states
                SET auth_code_hash = $2, user_id = $3,
                    provider_verifier = '', expires_at = now() + make_interval(mins => $4)
              WHERE id = $1 AND auth_code_hash IS NULL AND expires_at > now()",
            &[&id, &code_hash, &user_id, &CODE_MINUTES],
        )
        .await
        .map_err(db_error)?;
    Ok((updated == 1).then_some(code))
}

/// Ends a sign-in that failed at the provider or at linking. One that already
/// handed out its code (a concurrent duplicate callback) is left alone.
pub(super) async fn discard(tx: &Transaction<'_>, id: i64) -> Result<(), ApiError> {
    tx.execute(
        "DELETE FROM auth.flow_states WHERE id = $1 AND auth_code_hash IS NULL",
        &[&id],
    )
    .await
    .map_err(db_error)?;
    Ok(())
}

/// Redeems the app's code with the verifier behind its challenge. The row goes
/// away either way: a code is tried once.
pub(super) async fn redeem(
    tx: &Transaction<'_>,
    code: &str,
    verifier: &str,
) -> Result<Option<Uuid>, ApiError> {
    if code.is_empty() || code.len() > 128 {
        return Ok(None);
    }
    let code_hash = hash(code);
    // Match password/email-link login and inbox claims: account before code
    // and session. A claim may delete the code while this account lock waits;
    // the DELETE below rechecks its existence before starting any session.
    let account = tx
        .query_opt(
            "SELECT u.id FROM auth.users u
               JOIN auth.flow_states f ON f.user_id = u.id
              WHERE f.auth_code_hash = $1 FOR UPDATE OF u",
            &[&code_hash],
        )
        .await
        .map_err(db_error)?;
    if account.is_none() {
        return Ok(None);
    }
    let row = tx
        .query_opt(
            "DELETE FROM auth.flow_states
              WHERE auth_code_hash = $1
              RETURNING user_id, code_challenge, expires_at > now()",
            &[&code_hash],
        )
        .await
        .map_err(db_error)?;
    let row = match row {
        Some(row) => row,
        _ => {
            return Ok(None);
        }
    };
    let (user_id, challenge, live): (Option<Uuid>, String, bool) =
        (row.get(0), row.get(1), row.get(2));
    let proven = pkce::valid_verifier(verifier) && pkce::challenge(verifier) == challenge;
    Ok(user_id.filter(|_| live && proven))
}
