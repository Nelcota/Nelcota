//! Which account a provider sign-in opens (`auth.identities`).
//!
//! 1. A provider account already linked opens its user.
//! 2. Otherwise the provider's email decides:
//!    - an existing account is linked only when the provider verified the
//!      email. If that account was never confirmed, whoever signed up with
//!      the address may not own it: the verified owner takes it over, and the
//!      password and sessions set before go away;
//!    - no account: a new one, confirmed when the provider verified the email
//!      (and when signup is open).
use deadpool_postgres::Transaction;
use nelcota_core::ApiError;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::{ProviderIdentity, ProviderKind};
use crate::{accounts::confirm_inbox_owner, credentials::normalize_email, db::db_error};

/// Why a sign-in cannot open an account; the code goes back to the app.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The provider gave no usable email for a new account.
    EmailRequired,
    /// The email belongs to an account and the provider did not verify it.
    EmailConflict,
    SignupDisabled,
}

impl Refusal {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Refusal::EmailRequired => "email_required",
            Refusal::EmailConflict => "email_conflict",
            Refusal::SignupDisabled => "signup_disabled",
        }
    }
}

pub(super) async fn resolve(
    tx: &Transaction<'_>,
    provider: ProviderKind,
    identity: &ProviderIdentity,
    signup_enabled: bool,
) -> Result<Result<Uuid, Refusal>, ApiError> {
    let email = identity
        .email
        .as_deref()
        .and_then(|email| normalize_email(email).ok());

    // Account before identity/code: an inbox claim removes the credentials
    // established before verification. Recheck the identity after this lock,
    // since it may have been removed while this sign-in waited.
    let linked_account: Option<Uuid> = tx
        .query_opt(
            "SELECT u.id FROM auth.users u
               JOIN auth.identities i ON i.user_id = u.id
              WHERE i.provider = $1 AND i.provider_id = $2
              FOR UPDATE OF u",
            &[&provider.as_str(), &identity.subject],
        )
        .await
        .map_err(db_error)?
        .map(|row| row.get(0));
    let linked = match linked_account {
        Some(user_id) => tx
            .query_opt(
                "UPDATE auth.identities
                SET email = $3, identity_data = $4, updated_at = now(), last_sign_in_at = now()
              WHERE provider = $1 AND provider_id = $2 AND user_id = $5
              RETURNING user_id",
                &[
                    &provider.as_str(),
                    &identity.subject,
                    &email,
                    &identity.data,
                    &user_id,
                ],
            )
            .await
            .map_err(db_error)?
            .map(|row| row.get::<_, Uuid>(0)),
        _ => None,
    };
    if let Some(user_id) = linked {
        if let (true, Some(email)) = (identity.email_verified, email.as_deref()) {
            tx.execute(
                "UPDATE auth.users
                    SET email_confirmed_at = COALESCE(email_confirmed_at, now()),
                        updated_at = now()
                  WHERE id = $1 AND email = $2 AND email_confirmed_at IS NULL",
                &[&user_id, &email],
            )
            .await
            .map_err(db_error)?;
        }
        return Ok(Ok(user_id));
    }

    let email = match email {
        Some(email) => email,
        _ => {
            return Ok(Err(Refusal::EmailRequired));
        }
    };
    let existing: Option<(Uuid, bool)> = tx
        .query_opt(
            "SELECT id, email_confirmed_at IS NOT NULL FROM auth.users
              WHERE email = $1 FOR UPDATE",
            &[&email],
        )
        .await
        .map_err(db_error)?
        .map(|row| (row.get(0), row.get(1)));
    let user_id = match existing {
        Some(_) if !identity.email_verified => return Ok(Err(Refusal::EmailConflict)),
        Some((user_id, true)) => user_id,
        Some((user_id, false)) => {
            confirm_inbox_owner(tx, user_id).await?;
            user_id
        }
        None if !signup_enabled => return Ok(Err(Refusal::SignupDisabled)),
        None => create_user(tx, &email, identity).await?,
    };
    tx.execute(
        "INSERT INTO auth.identities
             (user_id, provider, provider_id, email, identity_data, last_sign_in_at)
         VALUES ($1, $2, $3, $4, $5, now())",
        &[
            &user_id,
            &provider.as_str(),
            &identity.subject,
            &email,
            &identity.data,
        ],
    )
    .await
    .map_err(db_error)?;
    tracing::info!(user_id = %user_id, provider = provider.as_str(), "provider identity linked");
    Ok(Ok(user_id))
}

async fn create_user(
    tx: &Transaction<'_>,
    email: &str,
    identity: &ProviderIdentity,
) -> Result<Uuid, ApiError> {
    Ok(tx
        .query_one(
            "INSERT INTO auth.users (email, raw_user_meta_data, email_confirmed_at)
             VALUES ($1, $2, CASE WHEN $3 THEN now() END)
             RETURNING id",
            &[&email, &metadata(identity), &identity.email_verified],
        )
        .await
        .map_err(db_error)?
        .get(0))
}

/// `user_metadata` of an account born at a provider: its name and picture.
fn metadata(identity: &ProviderIdentity) -> Value {
    let mut map = Map::new();
    if let Some(name) = &identity.name {
        map.insert("name".into(), json!(name));
    }
    if let Some(avatar) = &identity.avatar_url {
        map.insert("avatar_url".into(), json!(avatar));
    }
    Value::Object(map)
}
