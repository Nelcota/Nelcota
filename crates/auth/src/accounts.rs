//! Signup, password authentication and account lookup.
use crate::{
    AuthState, confirmation,
    credentials::{normalize_email, password_exceeds_limit, validate_password},
    db::{USER_JSON, begin_auth, db_error},
    error::{invalid_email, invalid_grant, validation, weak_password},
    links::{self, LinkKind},
    rate_limit::{limit, retry_after_secs},
    sessions::{session_of, start_session},
};
use axum::http::StatusCode;
use deadpool_postgres::Transaction;
use nelcota_core::ApiError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::IpAddr;
use tokio_postgres::error::SqlState;
use uuid::Uuid;

/// Claim an unconfirmed account through independently verified inbox ownership.
/// The caller holds the account's row lock. Credentials established before that
/// proof may belong to someone else; only the newly created session is retained.
pub(crate) async fn confirm_inbox_owner(
    tx: &Transaction<'_>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let confirmed = tx
        .execute(
            "UPDATE auth.users
                SET encrypted_password = NULL, email_confirmed_at = now(), updated_at = now()
              WHERE id = $1 AND email_confirmed_at IS NULL",
            &[&user_id],
        )
        .await
        .map_err(db_error)?;
    if confirmed == 0 {
        return Ok(());
    }
    retire_unconfirmed_access(tx, user_id).await
}

/// Retires access established before inbox ownership was proved. The caller
/// holds the account row lock and has just confirmed the account.
pub(crate) async fn retire_unconfirmed_access(
    tx: &Transaction<'_>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    tx.execute(
        "UPDATE auth.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        &[&user_id],
    )
    .await
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM auth.one_time_tokens WHERE user_id = $1",
        &[&user_id],
    )
    .await
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM auth.identities WHERE user_id = $1",
        &[&user_id],
    )
    .await
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM auth.flow_states WHERE user_id = $1",
        &[&user_id],
    )
    .await
    .map_err(db_error)?;
    tracing::warn!(user_id = %user_id, "unconfirmed account claimed by its verified inbox owner");
    Ok(())
}
#[derive(Deserialize)]
pub(crate) struct Signup {
    email: String,
    password: String,
    #[serde(default)]
    data: Option<Value>,
}

/// `POST /auth/v1/signup` `{email, password, data?}` → 201 + session, or 201 +
/// `{user}` when the email must be confirmed first.
pub(crate) async fn signup(
    state: &AuthState,
    body: Signup,
    ip: Option<IpAddr>,
    user_agent: Option<&str>,
) -> Result<Value, ApiError> {
    if !state.settings.signup_enabled {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "signup_disabled",
            "signup is disabled",
        ));
    }

    let email = normalize_email(&body.email).map_err(invalid_email)?;
    validate_password(&body.password).map_err(weak_password)?;
    let metadata = match body.data {
        None => json!({}),
        Some(data @ Value::Object(_)) => data,
        Some(_) => return Err(validation("data must be a JSON object")),
    };
    let mail_slot = confirmation::required(state)
        .then(|| state.mail_delivery.reserve())
        .transpose()?;

    let hash = state
        .passwords
        .hash(body.password)
        .await
        .ok_or_else(ApiError::internal)?;

    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    let inserted = tx
        .query_one(
            "INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data)
             VALUES ($1, $2, $3) RETURNING id",
            &[&email, &hash, &metadata],
        )
        .await;
    let user_id: Uuid = match inserted {
        Ok(row) => row.get(0),
        Err(err) if err.code() == Some(&SqlState::UNIQUE_VIOLATION) => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "user_already_exists",
                "a user with this email already exists",
            ));
        }
        Err(err) => return Err(db_error(err)),
    };
    let mail_slot = match mail_slot {
        Some(mail_slot) => mail_slot,
        _ => {
            let session = start_session(state, &tx, user_id, ip, user_agent).await?;
            tx.commit().await.map_err(db_error)?;
            return Ok(session);
        }
    };
    let (pending, token) = confirmation::pending_signup(&tx, user_id).await?;
    tx.commit().await.map_err(db_error)?;
    if let Some(token) = token {
        links::deliver(state, LinkKind::Signup, &email, &token, mail_slot);
    }
    Ok(pending)
}

pub(crate) async fn password_grant(
    state: &AuthState,
    email: Option<String>,
    password: Option<String>,
    ip: Option<IpAddr>,
    user_agent: Option<&str>,
) -> Result<Value, ApiError> {
    let (email, password) = match (email, password) {
        (Some(email), Some(password)) => (email, password),
        _ => {
            return Err(validation("email and password are required"));
        }
    };
    let email = match normalize_email(&email) {
        Ok(email) => email,
        _ => {
            return Err(invalid_grant("invalid email or password"));
        }
    };
    if password_exceeds_limit(&password) {
        return Err(invalid_grant("invalid email or password"));
    }
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    let found: Option<(Uuid, Option<String>)> = tx
        .query_opt(
            "SELECT id, encrypted_password
             FROM auth.users WHERE email = $1",
            &[&email],
        )
        .await
        .map_err(db_error)?
        .map(|r| (r.get(0), r.get(1)));
    // The handler already charged the per-IP `token:` budget. Existing
    // accounts also have an account-wide budget (made-up emails cannot fill
    // its store). Over it, only networks where the account has an open session
    // get through, after a growing delay: distributed guessing is capped, and
    // an attack slows the owner down without locking them out of the networks
    // they use. Signup already reveals whether an account exists (409).
    let over_budget = match &found {
        Some((user_id, _)) => state
            .limiter
            .login_budget(&email)
            .map(|wait| (*user_id, wait)),
        None => None,
    };
    let mut delay = std::time::Duration::ZERO;
    if let Some((user_id, wait)) = over_budget {
        if !known_network(&tx, user_id, ip).await? {
            return Err(ApiError::rate_limited(retry_after_secs(wait)));
        }
        delay = state.limiter.login_delay(&email);
    }
    tx.commit().await.map_err(db_error)?;
    // Neither the throttle delay nor argon2 holds the connection.
    drop(client);
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }

    let (user_id, phc) = match found {
        Some((id, phc)) => (Some(id), phc),
        None => (None, None),
    };
    if !state.passwords.verify(password, phc.clone()).await {
        return Err(invalid_grant("invalid email or password"));
    }
    let user_id = user_id.expect("verify only succeeds for an existing user");
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    // Password resets update this same row before revoking sessions. Keep its
    // lock until the new session commits, but never while running argon2.
    let current = tx
        .query_opt(
            "SELECT encrypted_password, email_confirmed_at IS NOT NULL
             FROM auth.users WHERE id = $1 FOR UPDATE",
            &[&user_id],
        )
        .await
        .map_err(db_error)?
        .ok_or_else(|| invalid_grant("invalid email or password"))?;
    if current.get::<_, Option<String>>(0) != phc {
        return Err(invalid_grant("invalid email or password"));
    }
    confirmation::ensure_confirmed(state, current.get(1))?;
    let session = start_session(state, &tx, user_id, ip, user_agent).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(session)
}

/// How long a session keeps its network known for the account budget.
const KNOWN_NETWORK_DAYS: i32 = 30;

/// Whether the account has an open session, used (created or refreshed) in
/// the last 30 days, that was opened from the network of `ip`: the same IPv4
/// /24 (also when stored IPv4-mapped by a dual-stack listener), so rotating
/// carrier and residential addresses still match, or the same IPv6 /64.
/// Revoked sessions do not count, so a network stops being known after a
/// password change or sign-out there. Prune removes sessions whose refresh
/// tokens expired, so the window is also bounded by the refresh lifetime.
async fn known_network(
    tx: &Transaction<'_>,
    user_id: Uuid,
    ip: Option<IpAddr>,
) -> Result<bool, ApiError> {
    let networks = match ip.map(|ip| ip.to_canonical()) {
        None => return Ok(false),
        Some(IpAddr::V4(ip)) => {
            let [a, b, c, _] = ip.octets();
            vec![
                format!("{a}.{b}.{c}.0/24"),
                format!("::ffff:{a}.{b}.{c}.0/120"),
            ]
        }
        Some(ip) => vec![crate::request::ip_key(Some(ip))],
    };
    let row = tx
        .query_one(
            "SELECT EXISTS (
                 SELECT 1 FROM auth.sessions s
                 WHERE s.user_id = $1 AND s.revoked_at IS NULL
                   AND s.ip <<= ANY ($2::text[]::inet[])
                   AND coalesce(s.refreshed_at, s.created_at)
                       > now() - make_interval(days => $3)
             )",
            &[&user_id, &networks, &KNOWN_NETWORK_DAYS],
        )
        .await
        .map_err(db_error)?;
    Ok(row.get(0))
}

/// `GET /auth/v1/user` (Bearer): data of the token's user.
pub(crate) async fn user(
    state: &AuthState,
    claims: &nelcota_core::Claims,
) -> Result<Value, ApiError> {
    let (user_id, _) = session_of(claims)?;
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    let row = tx
        .query_opt(
            &format!("SELECT {USER_JSON} FROM auth.users u WHERE u.id = $1"),
            &[&user_id],
        )
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let row = row.ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "user_not_found",
            "the user no longer exists",
        )
    })?;
    Ok(row.get(0))
}

#[derive(Deserialize)]
pub(crate) struct UserUpdate {
    password: Option<String>,
    current_password: Option<String>,
    data: Option<Value>,
}

/// `PUT /auth/v1/user` (Bearer) `{password?, current_password?, data?}`:
/// the signed-in user changes their password and/or metadata.
///
/// - `password` needs `current_password` when the account already has one;
///   an account without a password (magic link, provider) can set one. The
///   user's other sessions end; the calling one continues.
/// - `data` is merged into `user_metadata` one level deep; a key set to
///   `null` is removed.
pub(crate) async fn update_user(
    state: &AuthState,
    claims: &nelcota_core::Claims,
    body: UserUpdate,
) -> Result<Value, ApiError> {
    let (user_id, session_id) = session_of(claims)?;
    let data = match body.data {
        None => None,
        Some(data @ Value::Object(_)) => Some(data),
        Some(_) => return Err(validation("data must be a JSON object")),
    };
    if body.password.is_none() && data.is_none() {
        return Err(validation("provide password or data"));
    }
    let new_hash = match body.password {
        Some(password) => Some(
            change_password(
                state,
                (user_id, session_id),
                password,
                body.current_password,
            )
            .await?,
        ),
        None => None,
    };

    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    // Lock the account before its session, as password recovery does. A join
    // snapshot taken before waiting for this lock can still show a session
    // that has since logged out, so validate it in a separate locked read.
    let current = tx
        .query_opt(
            "SELECT encrypted_password FROM auth.users WHERE id = $1 FOR UPDATE",
            &[&user_id],
        )
        .await
        .map_err(db_error)?
        .ok_or_else(ApiError::invalid_token)?;
    tx.query_opt(
        "SELECT id FROM auth.sessions
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE",
        &[&session_id, &user_id],
    )
    .await
    .map_err(db_error)?
    .ok_or_else(ApiError::invalid_token)?;
    if let Some((expected, _)) = &new_hash
        && current.get::<_, Option<String>>(0) != *expected
    {
        // Changed by someone else while argon2 ran: verify again.
        return Err(invalid_grant("the password changed meanwhile; try again"));
    }
    let new_hash = new_hash.map(|(_, hash)| hash);
    let row = tx
        .query_one(
            &format!(
                "UPDATE auth.users u SET
                    encrypted_password = coalesce($2, u.encrypted_password),
                    raw_user_meta_data = CASE WHEN $3::jsonb IS NULL THEN u.raw_user_meta_data
                        ELSE (u.raw_user_meta_data || $3::jsonb)
                             - ARRAY(SELECT key FROM jsonb_each($3::jsonb) WHERE value = 'null'::jsonb)
                    END,
                    updated_at = now()
                 WHERE u.id = $1
                 RETURNING {USER_JSON}"
            ),
            &[&user_id, &new_hash, &data],
        )
        .await
        .map_err(db_error)?;
    if new_hash.is_some() {
        crate::db::retire_pending_credentials(&tx, user_id).await?;
        // Whoever signed in with the old password loses access; this
        // session continues.
        tx.execute(
            "UPDATE auth.sessions SET revoked_at = now()
             WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
            &[&user_id, &session_id],
        )
        .await
        .map_err(db_error)?;
    }
    tx.commit().await.map_err(db_error)?;
    if new_hash.is_some() {
        tracing::info!(user_id = %user_id, "password changed by the user");
    }
    Ok(row.get(0))
}

/// Checks the new password's rules and the current one, then hashes the new
/// one. Returns the PHC the account had (to detect a concurrent change) and
/// the new PHC. argon2 runs without holding a connection.
async fn change_password(
    state: &AuthState,
    (user_id, session_id): (Uuid, Uuid),
    password: String,
    current_password: Option<String>,
) -> Result<(Option<String>, String), ApiError> {
    validate_password(&password).map_err(weak_password)?;
    if current_password
        .as_deref()
        .is_some_and(password_exceeds_limit)
    {
        return Err(invalid_grant("current password is incorrect"));
    }
    // A logged-out access token stays valid until it expires; check its
    // session before argon2 so it cannot keep testing passwords.
    let phc: Option<String> = {
        let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
        let tx = begin_auth(&mut client).await?;
        let row = tx
            .query_opt(
                "SELECT u.encrypted_password FROM auth.users u
                 JOIN auth.sessions s ON s.user_id = u.id
                 WHERE u.id = $1 AND s.id = $2 AND s.revoked_at IS NULL",
                &[&user_id, &session_id],
            )
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        row.ok_or_else(ApiError::invalid_token)?.get(0)
    };
    // A stolen access token must not become a password-guessing oracle.
    limit(state, &format!("password:{user_id}"))?;
    if phc.is_some() {
        let current = current_password
            .ok_or_else(|| validation("current_password is required to change the password"))?;
        if !state.passwords.verify(current, phc.clone()).await {
            return Err(invalid_grant("current password is incorrect"));
        }
    }
    let hash = state
        .passwords
        .hash(password)
        .await
        .ok_or_else(ApiError::internal)?;
    Ok((phc, hash))
}
