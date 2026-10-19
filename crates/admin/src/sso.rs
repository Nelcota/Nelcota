//! Single sign-on between the panels of projects on the same host.
//!
//! Cookies do not cross domains (`api.shop.com` → `api.blog.com`), so the
//! session is passed through a *handoff*: the source panel, with the admin
//! already signed in, issues a short-lived token for the target project; the
//! target validates it and creates its own session.
//!
//! - Token: HS256 JWT with the host's shared secret (`NELCOTA_ADMIN_SSO_SECRET`),
//!   `aud` = target project, 60 s validity and a single-use `jti`.
//! - It travels in the URL fragment (`#sso=`), which reaches neither server
//!   logs nor the `Referer`; the SPA reads it and sends it by POST.
//! - Without a configured secret ("per-project login" mode), there is no handoff.

use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use deadpool_postgres::Pool;
use jsonwebtoken::{
    Algorithm, DecodingKey, EncodingKey, Header, Validation, get_current_timestamp,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{AdminState, ApiError, projects};

const TOKEN_TTL_SECS: u64 = 60;
const ISSUER: &str = "nelcota-admin";
const HANDOFF_LEEWAY_SECS: u64 = 5;
const REPLAY_RETENTION_SECS: u64 = 86_400;
const REPLAY_CLEANUP_BATCH: i64 = 5_000;

#[derive(Serialize, Deserialize)]
struct HandoffClaims {
    iss: String,
    sub: String,
    aud: String,
    iat: u64,
    exp: u64,
    jti: String,
}

/// Handoff keys. Redemption receipts belong to the shared project database.
pub struct Sso {
    encoding: EncodingKey,
    decoding: DecodingKey,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RedeemError {
    Invalid,
    Replayed,
    Unavailable,
}

impl Sso {
    pub fn new(secret: &[u8]) -> Self {
        Sso {
            encoding: EncodingKey::from_secret(secret),
            decoding: DecodingKey::from_secret(secret),
        }
    }

    /// Token for the admin `email` to enter the project `audience`.
    pub fn issue(
        &self,
        email: &str,
        audience: &str,
    ) -> Result<String, jsonwebtoken::errors::Error> {
        let mut jti = [0u8; 16];
        getrandom::fill(&mut jti).expect("system randomness source unavailable");
        let now = get_current_timestamp();
        let claims = HandoffClaims {
            iss: ISSUER.into(),
            sub: email.into(),
            aud: audience.into(),
            iat: now,
            exp: now + TOKEN_TTL_SECS,
            jti: URL_SAFE_NO_PAD.encode(jti),
        };
        jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
    }

    /// Validates and durably consumes a handoff for this project/admin.
    /// A database error rejects redemption; there is no process-local fallback.
    pub async fn redeem(
        &self,
        pool: &Pool,
        token: &str,
        project: &str,
        email: &str,
    ) -> Result<(), RedeemError> {
        let claims = self.validate(token, project, email)?;
        let digest = Sha256::digest(claims.jti.as_bytes()).to_vec();
        let through = claims
            .exp
            .checked_add(HANDOFF_LEEWAY_SECS)
            .ok_or(RedeemError::Invalid)? as f64;
        // Use the validator's clock, not a potentially skewed database clock.
        // Keep a conservative day beyond validation expiry, with bounded work.
        let cutoff = get_current_timestamp().saturating_sub(REPLAY_RETENTION_SECS) as f64;
        let mut client = pool.get().await.map_err(|_| RedeemError::Unavailable)?;
        let tx = client
            .transaction()
            .await
            .map_err(|_| RedeemError::Unavailable)?;
        let inserted = tx.execute(
            "INSERT INTO nelcota.admin_sso_replays (digest, expires_at) VALUES ($1, to_timestamp($2))
             ON CONFLICT (digest) DO NOTHING", &[&digest, &through],
        ).await.map_err(|_| RedeemError::Unavailable)?;
        if inserted != 1 {
            return Err(RedeemError::Replayed);
        }
        tx.execute(
            "DELETE FROM nelcota.admin_sso_replays WHERE digest IN (
                SELECT digest FROM nelcota.admin_sso_replays WHERE expires_at < to_timestamp($1)
                ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)",
            &[&cutoff, &REPLAY_CLEANUP_BATCH],
        )
        .await
        .map_err(|_| RedeemError::Unavailable)?;
        tx.commit().await.map_err(|_| RedeemError::Unavailable)?;
        Ok(())
    }

    fn validate(
        &self,
        token: &str,
        project: &str,
        email: &str,
    ) -> Result<HandoffClaims, RedeemError> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&[project]);
        validation.set_issuer(&[ISSUER]);
        validation.leeway = HANDOFF_LEEWAY_SECS;
        let data = jsonwebtoken::decode::<HandoffClaims>(token, &self.decoding, &validation)
            .map_err(|_| RedeemError::Invalid)?;
        if !data.claims.sub.eq_ignore_ascii_case(email) {
            return Err(RedeemError::Invalid);
        }
        Ok(data.claims)
    }
}

#[derive(Deserialize)]
pub struct HandoffRequest {
    project: String,
}

/// `POST /admin/api/sso/handoff {project}` (needs a session): URL of the
/// target project's panel with the token already in the fragment.
pub async fn handoff(
    State(state): State<AdminState>,
    Json(body): Json<HandoffRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let sso = state.host.sso.as_ref().ok_or_else(|| {
        ApiError::bad_request(
            "sso_disabled",
            "single sign-on is off: sign in to each project's panel",
        )
    })?;
    let target = projects::find(&state.host, &body.project).ok_or_else(|| {
        ApiError::not_found(
            "project_not_found",
            format!("project '{}' does not exist on this host", body.project),
        )
        .params(json!({ "project": body.project }))
    })?;
    let token = sso.issue(&state.credentials.email, &target.name)?;
    Ok(Json(json!({
        "url": format!("{}/admin/#sso={token}", target.url.trim_end_matches('/')),
    })))
}

#[derive(Deserialize)]
pub struct RedeemRequest {
    token: String,
}

/// `POST /admin/api/sso {token}` (public): trades the token for a session.
pub async fn redeem(State(state): State<AdminState>, Json(body): Json<RedeemRequest>) -> Response {
    let sso = match state.host.sso.as_ref() {
        Some(sso) => sso,
        _ => {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                "sso_disabled",
                "single sign-on is off",
            )
            .into_response();
        }
    };
    match sso
        .redeem(
            &state.db,
            &body.token,
            &state.host.project,
            &state.credentials.email,
        )
        .await
    {
        Ok(()) => {
            tracing::info!("panel login through an SSO handoff");
            (
                [(header::SET_COOKIE, crate::new_session_cookie(&state))],
                Json(json!({ "email": state.credentials.email })),
            )
                .into_response()
        }
        Err(err) => {
            tracing::warn!(?err, "SSO handoff refused");
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "sso_link_invalid",
                "invalid or expired access link: sign in again",
            )
            .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"shared-test-secret-with-32-bytes-or-more";

    #[test]
    fn token_validation_is_bound_to_the_target_and_admin() {
        let sso = Sso::new(SECRET);
        let token = sso.issue("admin@x.com", "blog").unwrap();
        assert_eq!(
            sso.validate(&token, "shop", "admin@x.com").map(|_| ()),
            Err(RedeemError::Invalid)
        );
        assert_eq!(
            sso.validate(&token, "blog", "other@x.com").map(|_| ()),
            Err(RedeemError::Invalid)
        );
        assert!(sso.validate(&token, "blog", "ADMIN@x.com").is_ok());
    }

    #[test]
    fn other_secret_and_expired_token_are_refused() {
        let token = Sso::new(SECRET).issue("admin@x.com", "blog").unwrap();
        let other = Sso::new(b"some-other-secret-with-32-bytes-too!!");
        assert_eq!(
            other.validate(&token, "blog", "admin@x.com").map(|_| ()),
            Err(RedeemError::Invalid)
        );

        let now = get_current_timestamp();
        let expired = jsonwebtoken::encode(
            &Header::new(Algorithm::HS256),
            &HandoffClaims {
                iss: ISSUER.into(),
                sub: "admin@x.com".into(),
                aud: "blog".into(),
                iat: now - 600,
                exp: now - 300,
                jti: "x".into(),
            },
            &EncodingKey::from_secret(SECRET),
        )
        .unwrap();
        assert_eq!(
            Sso::new(SECRET)
                .validate(&expired, "blog", "admin@x.com")
                .map(|_| ()),
            Err(RedeemError::Invalid)
        );
    }
}
