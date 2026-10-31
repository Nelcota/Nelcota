//! Session lifecycle and token rotation, independent of HTTP handlers.
use crate::{
    AuthState,
    db::{USER_JSON, begin_auth, db_error},
    error::{invalid_grant, validation},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use deadpool_postgres::Transaction;
use jsonwebtoken::get_current_timestamp;
use nelcota_core::{ApiError, Role};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use uuid::Uuid;
/// Opaque token (refresh, recovery link): 32 random bytes. Only the SHA-256
/// goes to the database.
pub(crate) fn new_opaque_token() -> (String, Vec<u8>) {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness source unavailable");
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = Sha256::digest(token.as_bytes()).to_vec();
    (token, hash)
}

struct SessionUser {
    id: Uuid,
    email: String,
    json: Value,
}

/// Creates a session + first refresh token, records the login and returns the response.
pub(crate) async fn start_session(
    state: &AuthState,
    tx: &Transaction<'_>,
    user_id: Uuid,
    ip: Option<IpAddr>,
    user_agent: Option<&str>,
) -> Result<Value, ApiError> {
    let session_id: Uuid = tx
        .query_one(
            "INSERT INTO auth.sessions (user_id, ip, user_agent) VALUES ($1, $2, $3) RETURNING id",
            &[&user_id, &ip, &user_agent],
        )
        .await
        .map_err(db_error)?
        .get(0);
    let row = tx
        .query_one(
            &format!(
                "UPDATE auth.users u SET last_sign_in_at = now() WHERE u.id = $1
                 RETURNING u.id, u.email, {USER_JSON}"
            ),
            &[&user_id],
        )
        .await
        .map_err(db_error)?;
    let user = SessionUser {
        id: row.get(0),
        email: row.get(1),
        json: row.get(2),
    };
    issue_tokens(state, tx, session_id, &user).await
}

/// Issues an access JWT + a new refresh token in the session.
async fn issue_tokens(
    state: &AuthState,
    tx: &Transaction<'_>,
    session_id: Uuid,
    user: &SessionUser,
) -> Result<Value, ApiError> {
    let now = get_current_timestamp();
    if state.settings.access_ttl_secs == 0
        || !nelcota_core::config::refresh_lifetime_is_representable(
            now,
            state.settings.refresh_ttl_days,
        )
    {
        return Err(ApiError::internal());
    }
    let expires_at = now
        .checked_add(state.settings.access_ttl_secs)
        .ok_or_else(ApiError::internal)?;
    let ttl_days =
        i32::try_from(state.settings.refresh_ttl_days).map_err(|_| ApiError::internal())?;
    let (refresh_token, hash) = new_opaque_token();
    tx.execute(
        "INSERT INTO auth.refresh_tokens (session_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))",
        &[&session_id, &hash, &ttl_days],
    )
    .await
    .map_err(db_error)?;

    let claims = json!({
        "iss": state.settings.issuer,
        "aud": "authenticated",
        "sub": user.id,
        "role": "authenticated",
        "email": user.email,
        "session_id": session_id,
        "iat": now,
        "exp": expires_at,
    });
    let access_token = state.keys.sign(&claims).map_err(|err| {
        tracing::error!(error = %err, "failed to sign JWT");
        ApiError::internal()
    })?;

    Ok(json!({
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": state.settings.access_ttl_secs,
        "expires_at": expires_at,
        "refresh_token": refresh_token,
        "user": user.json,
    }))
}

fn required_refresh_token(token: Option<String>) -> Result<String, ApiError> {
    let token = token
        .filter(|token| !token.is_empty())
        .ok_or_else(|| validation("refresh_token is required"))?;
    if token.len() > 128 {
        return Err(invalid_grant("invalid refresh token"));
    }
    Ok(token)
}

pub(crate) async fn refresh(state: &AuthState, token: Option<String>) -> Result<Value, ApiError> {
    let token = required_refresh_token(token)?;
    let hash = Sha256::digest(token.as_bytes()).to_vec();

    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    // Own the parent before any token row. A retry retires its successors,
    // so locking two different tokens before their shared session can deadlock.
    // Use a separate statement: after waiting, the token/state read below gets
    // a fresh READ COMMITTED snapshot, including intervening revocation.
    // Reuse each connection's prepared plan: the extra ownership statement
    // must not add a prepare round trip on every rotation.
    let parent = tx
        .prepare_cached(
            "SELECT s.id FROM auth.sessions s
             JOIN auth.refresh_tokens rt ON rt.session_id = s.id
             WHERE rt.token_hash = $1 FOR UPDATE OF s",
        )
        .await
        .map_err(db_error)?;
    if tx
        .query_opt(&parent, &[&hash])
        .await
        .map_err(db_error)?
        .is_none()
    {
        return Err(invalid_grant("invalid refresh token"));
    }
    // The session is already locked; per-token reads/mutations cannot form
    // a cycle with another rotation or a parent-first revocation.
    let current = tx
        .prepare_cached(&format!(
            "SELECT rt.id, rt.revoked, rt.expires_at <= now(), s.id, s.revoked_at IS NOT NULL,
                        u.id, u.email, {USER_JSON}
                 FROM auth.refresh_tokens rt
                 JOIN auth.sessions s ON s.id = rt.session_id
                 JOIN auth.users u ON u.id = s.user_id
                 WHERE rt.token_hash = $1
                 FOR UPDATE OF rt, s"
        ))
        .await
        .map_err(db_error)?;
    let row = tx.query_opt(&current, &[&hash]).await.map_err(db_error)?;
    let row = match row {
        Some(row) => row,
        _ => {
            return Err(invalid_grant("invalid refresh token"));
        }
    };
    let (token_id, revoked, expired, session_id, session_revoked): (i64, bool, bool, Uuid, bool) =
        (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4));

    if session_revoked {
        return Err(invalid_grant("session ended"));
    }
    let user = SessionUser {
        id: row.get(5),
        email: row.get(6),
        json: row.get(7),
    };
    if revoked && !expired && is_retry(&tx, session_id, token_id).await? {
        // The client lost the answer to its rotation (network drop) and is
        // retrying with the token it still has. Hand out a fresh pair in the
        // same session and retire whatever the lost answer carried, so only the
        // newest token stays valid. Two holders racing with one token (tabs
        // that do not coordinate) both get an answer, but presenting the
        // retired one later is reuse and ends the session; the SDKs
        // coordinate their tabs so only one of them rotates.
        tx.execute(
            "UPDATE auth.refresh_tokens SET revoked = true
             WHERE session_id = $1 AND id > $2 AND NOT revoked",
            &[&session_id, &token_id],
        )
        .await
        .map_err(db_error)?;
        let session = issue_tokens(state, &tx, session_id, &user).await?;
        tx.commit().await.map_err(db_error)?;
        tracing::info!(session_id = %session_id, "refresh token retried within the grace window");
        return Ok(session);
    }
    if revoked {
        // Reuse: someone holds a copy of an already rotated token. End the whole
        // session (every token of the family stops working).
        tx.execute(
            "UPDATE auth.sessions SET revoked_at = now() WHERE id = $1",
            &[&session_id],
        )
        .await
        .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        tracing::warn!(session_id = %session_id, "refresh token reuse detected; session revoked");
        return Err(invalid_grant("refresh token reused; session ended"));
    }
    if expired {
        return Err(invalid_grant("refresh token expired"));
    }

    tx.execute(
        // Both rows are already locked. Rotate their state in one round trip;
        // the token insertion and response still share this transaction.
        "WITH retired AS (
             UPDATE auth.refresh_tokens SET revoked = true WHERE id = $1 RETURNING id
         )
         UPDATE auth.sessions SET refreshed_at = now()
         WHERE id = $2 AND EXISTS (SELECT 1 FROM retired)",
        &[&token_id, &session_id],
    )
    .await
    .map_err(db_error)?;
    let session = issue_tokens(state, &tx, session_id, &user).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(session)
}

/// How long after a rotation the rotated token still counts as a retry.
const REUSE_GRACE_SECS: f64 = 10.0;

/// Whether presenting the revoked token `token_id` is a retry of the latest
/// rotation rather than a stolen copy: it must be the token that rotation
/// consumed (its first successor was created by the session's latest
/// rotation, which sets `refreshed_at` in the same transaction) and that
/// rotation must be under [`REUSE_GRACE_SECS`] old. Retries do not move
/// `refreshed_at`, so they cannot stretch the window; once the newer token is
/// rotated in turn, the old one is plain reuse again.
async fn is_retry(tx: &Transaction<'_>, session_id: Uuid, token_id: i64) -> Result<bool, ApiError> {
    let row = tx
        .query_opt(
            "SELECT s.refreshed_at = next.created_at
                    AND next.created_at > now() - make_interval(secs => $3)
             FROM auth.refresh_tokens next
             JOIN auth.sessions s ON s.id = next.session_id
             WHERE next.session_id = $1 AND next.id > $2
             ORDER BY next.id
             LIMIT 1",
            &[&session_id, &token_id, &REUSE_GRACE_SECS],
        )
        .await
        .map_err(db_error)?;
    Ok(row
        .and_then(|r| r.get::<_, Option<bool>>(0))
        .unwrap_or(false))
}

pub(crate) fn session_of(claims: &nelcota_core::Claims) -> Result<(Uuid, Uuid), ApiError> {
    let user_id = claims
        .sub()
        .filter(|_| claims.role() == Role::Authenticated)
        .ok_or_else(ApiError::invalid_token)?;
    let session_id = claims
        .claim("session_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(ApiError::invalid_token)?;
    Ok((user_id, session_id))
}

/// `POST /auth/v1/logout` (Bearer): ends the token's session. The access JWT
/// stays valid until it expires (stateless); refresh tokens die immediately.
pub(crate) async fn logout(
    state: &AuthState,
    claims: &nelcota_core::Claims,
) -> Result<(), ApiError> {
    let (user_id, session_id) = session_of(claims)?;
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    tx.execute(
        "UPDATE auth.sessions SET revoked_at = now()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        &[&session_id, &user_id],
    )
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
mod refresh_validation_tests {
    use super::required_refresh_token;
    use axum::http::StatusCode;

    #[test]
    fn absent_and_empty_tokens_remain_required_field_errors() {
        for token in [None, Some(String::new())] {
            let error = required_refresh_token(token).unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(error.code(), "validation_failed");
        }
    }

    #[test]
    fn oversized_present_tokens_are_invalid_grants() {
        for token in ["a".repeat(129), "a".repeat(1024), "é".repeat(65)] {
            let error = required_refresh_token(Some(token)).unwrap_err();
            assert_eq!(error.status(), StatusCode::BAD_REQUEST);
            assert_eq!(error.code(), "invalid_grant");
        }
    }

    #[test]
    fn bounded_tokens_continue_to_database_validation() {
        for token in ["a".to_owned(), "a".repeat(128)] {
            assert_eq!(required_refresh_token(Some(token.clone())).unwrap(), token);
        }
    }
}

#[cfg(test)]
mod refresh_http_tests {
    use crate::{AuthSettings, AuthState, EmailLinks, Keys, Passwords};
    use std::{net::SocketAddr, sync::Arc, time::Duration};

    #[tokio::test]
    async fn required_and_oversized_refresh_errors_are_distinct_over_http() {
        let mut database = tokio_postgres::Config::new();
        database.host("127.0.0.1").port(9).user("unused");
        let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
            database,
            tokio_postgres::NoTls,
        ))
        .max_size(1)
        .build()
        .unwrap();
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).unwrap();
        let keys = Arc::new(Keys::new(None, Some(&secret)).unwrap());
        let state = AuthState::new(
            pool,
            keys,
            Arc::new(Passwords::new(1)),
            AuthSettings {
                issuer: "local-boundary-test".into(),
                access_ttl_secs: 900,
                refresh_ttl_days: 7,
                signup_enabled: false,
                proxy_hops: 0,
                links: EmailLinks::default(),
            },
            60,
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                crate::router(state).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        for (body, status, code) in [
            (serde_json::json!({}), 422, "validation_failed"),
            (
                serde_json::json!({"refresh_token":""}),
                422,
                "validation_failed",
            ),
            (
                serde_json::json!({"refresh_token":"a".repeat(129)}),
                400,
                "invalid_grant",
            ),
            (
                serde_json::json!({"refresh_token":"é".repeat(65)}),
                400,
                "invalid_grant",
            ),
        ] {
            let response = http
                .post(format!(
                    "http://{address}/auth/v1/token?grant_type=refresh_token"
                ))
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&response.text().await.unwrap()).unwrap()
                    ["code"],
                code
            );
        }
        stop.send(()).unwrap();
        server.await.unwrap();
    }
}
