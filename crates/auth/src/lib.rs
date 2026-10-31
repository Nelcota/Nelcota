//! Authentication: JWT issuing and verification, passwords, sessions and
//! refresh tokens, and the claims extractor for axum.
//!
//! Verification sits behind the [`JwtVerifier`] trait so the token source can
//! be swapped (local keys today; an external OIDC provider later). This crate
//! only AUTHENTICATES: authorization belongs exclusively to RLS.

mod accounts;
mod bootstrap;
mod caller_limit;
mod confirmation;
mod credentials;
mod db;
mod error;
mod handlers;
mod keys;
mod links;
mod mail;
mod oauth;
mod password;
mod pkce;
mod prune;
mod rate_limit;
mod recovery;
mod request;
pub use request::{PeerAddr, client_ip, ip_key};
mod sessions;
mod state;
mod verify;

use std::sync::Arc;

use axum::{
    extract::{FromRef, FromRequestParts},
    http::{header, request::Parts},
};
pub use nelcota_core::{ApiError, Claims, InvalidClaims, Role};

pub use bootstrap::{AUTH_MIGRATION_VERSIONS, BootstrapError, bootstrap};
pub use caller_limit::{CallerLimit, CallerSlot, caller_key};
pub use credentials::{InvalidCredential, normalize_email, validate_password};
pub use handlers::router;
pub use keys::{KeyError, Keys, generate_ed25519_private_key};
pub use mail::{Email, MailDelivery, MailError, Mailer, SmtpMailer};
pub use oauth::{OAuth, Provider, ProviderEndpoints, ProviderKind};
pub use password::{Passwords, hash_password, verify_password};
pub use prune::{Pruned, prune, pruner_task, spawn_pruner};
pub use rate_limit::{RateLimiter, SESSION_RATE_LIMIT_FACTOR, retry_after_secs};
pub use state::{AuthSettings, AuthState, EmailLinks, SettingsError};

#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("invalid token: {0}")]
    Token(#[from] jsonwebtoken::errors::Error),
    #[error("unknown algorithm or key (kid)")]
    UnknownKey,
    #[error(transparent)]
    Claims(#[from] nelcota_core::InvalidClaims),
}

/// Validates a JWT (signature, expiry, claims format).
pub trait JwtVerifier: Send + Sync + 'static {
    fn verify(&self, token: &str) -> Result<Claims, VerifyError>;
}

/// Verifier shared in the axum state.
pub type SharedVerifier = Arc<dyn JwtVerifier>;

/// The token of an `Authorization: Bearer <token>` value. The scheme is
/// case-insensitive (RFC 7235 §2.1): `bearer`, as in our own `token_type`,
/// works too. `None` for another scheme or an empty token.
pub fn bearer_token(authorization: &str) -> Option<&str> {
    let (scheme, token) = authorization.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

/// Extractor of the request claims.
///
/// - no `Authorization`: an `anon` request;
/// - a valid `Authorization: Bearer <jwt>`: the token's claims;
/// - anything else (invalid or expired token, unknown role, a scheme other
///   than Bearer): 401. Never silently falls back to `anon`.
pub struct Auth(pub Claims);

impl<S> FromRequestParts<S> for Auth
where
    SharedVerifier: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let value = match parts.headers.get(header::AUTHORIZATION) {
            Some(value) => value,
            _ => {
                return Ok(Auth(Claims::anon()));
            }
        };
        let token = value
            .to_str()
            .ok()
            .and_then(bearer_token)
            .ok_or_else(ApiError::invalid_token)?;

        let verifier = SharedVerifier::from_ref(state);
        match verifier.verify(token) {
            Ok(claims) => Ok(Auth(claims)),
            Err(err) => {
                // The token itself is never logged.
                tracing::debug!(error = %err, "JWT rejected");
                Err(ApiError::invalid_token())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::bearer_token;

    #[test]
    fn bearer_scheme_is_case_insensitive() {
        for value in ["Bearer abc", "bearer abc", "BEARER abc", "bEaReR  abc "] {
            assert_eq!(bearer_token(value), Some("abc"), "{value}");
        }
        for value in ["Basic abc", "Bearer", "Bearer ", "Bearerabc", "abc"] {
            assert_eq!(bearer_token(value), None, "{value}");
        }
    }
}

#[cfg(test)]
mod g06_diagnostics {
    use super::*;
    #[test]
    fn provider_debug_hides_credentials() {
        let sensitive = generate_ed25519_private_key();
        let provider = Provider::google("client", &sensitive);
        assert!(!format!("{provider:?}").contains(&sensitive));
    }
    #[test]
    fn email_debug_hides_message_content() {
        let sensitive = generate_ed25519_private_key();
        let message = Email {
            to: "user@example.test".into(),
            subject: "Sign in".into(),
            text: sensitive.clone(),
        };
        assert!(!format!("{message:?}").contains(&sensitive));
    }
}
