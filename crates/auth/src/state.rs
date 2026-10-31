//! Authentication dependencies and configuration.
use crate::{
    JwtVerifier, Keys, MailDelivery, Mailer, OAuth, Passwords, RateLimiter, SharedVerifier,
    links::LinkKind,
};
use axum::extract::FromRef;
use deadpool_postgres::Pool;
use std::sync::Arc;
/// Settings of the auth endpoints.
#[derive(Clone, Debug)]
pub struct AuthSettings {
    pub issuer: String,
    pub access_ttl_secs: u64,
    pub refresh_ttl_days: u32,
    pub signup_enabled: bool,
    /// Trusted proxies in front of the server that append the address they
    /// saw to `X-Forwarded-For`: 0 ignores the header (the server is reached
    /// directly), 1 is Caddy alone, 2 is a CDN in front of Caddy.
    pub proxy_hops: u8,
    pub links: EmailLinks,
}

#[derive(Debug, thiserror::Error)]
#[error("invalid auth settings: {0}")]
pub struct SettingsError(pub &'static str);

impl AuthSettings {
    /// Validate standalone hosts before accepting requests.
    pub fn validate(&self) -> Result<(), SettingsError> {
        if self.issuer.trim().is_empty() {
            return Err(SettingsError("issuer must not be empty"));
        }
        let now = jsonwebtoken::get_current_timestamp();
        if self.access_ttl_secs == 0 || now.checked_add(self.access_ttl_secs).is_none() {
            return Err(SettingsError(
                "access lifetime must be positive and representable",
            ));
        }
        if !nelcota_core::config::refresh_lifetime_is_representable(now, self.refresh_ttl_days) {
            return Err(SettingsError(
                "refresh lifetime must produce a representable PostgreSQL expiration",
            ));
        }
        for page in [
            &self.links.recovery,
            &self.links.signup_confirmation,
            &self.links.magic_link,
        ]
        .into_iter()
        .flatten()
        {
            let url =
                url::Url::parse(page).map_err(|_| SettingsError("invalid email link page"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(SettingsError(
                    "email link pages need HTTP(S), a host and no fragment or credentials",
                ));
            }
        }
        Ok(())
    }
}

/// App pages that receive the links sent by email. A flow without its page
/// is off.
#[derive(Clone, Debug, Default)]
pub struct EmailLinks {
    pub recovery: Option<String>,
    /// Also makes signup wait for the email to be confirmed.
    pub signup_confirmation: Option<String>,
    pub magic_link: Option<String>,
}

impl EmailLinks {
    pub(crate) fn url(&self, kind: LinkKind) -> Option<&str> {
        match kind {
            LinkKind::Recovery => &self.recovery,
            LinkKind::Signup => &self.signup_confirmation,
            LinkKind::MagicLink => &self.magic_link,
        }
        .as_deref()
    }
}

#[derive(Clone)]
pub struct AuthState {
    pub pool: Pool,
    pub keys: Arc<Keys>,
    pub passwords: Arc<Passwords>,
    pub limiter: Arc<RateLimiter>,
    /// Per-IP budget of token refreshes and PKCE redemptions, apart from
    /// password sign-in so a page full of tabs refreshing cannot lock its
    /// users out of logging in (and the other way round).
    pub session_limiter: Arc<RateLimiter>,
    pub settings: Arc<AuthSettings>,
    /// Email sending; without it, every email link flow is off.
    pub mailer: Option<Arc<dyn Mailer>>,
    /// Shared admission and deadline for background email delivery.
    pub mail_delivery: Arc<MailDelivery>,
    /// Sign-in through external providers; without it, `/authorize` answers
    /// `provider_disabled`.
    pub oauth: Option<Arc<OAuth>>,
}

impl AuthState {
    /// Construct a bounded standalone host. Optional mail and OAuth adapters
    /// can be assigned before passing the state to `router`.
    pub fn new(
        pool: Pool,
        keys: Arc<Keys>,
        passwords: Arc<Passwords>,
        settings: AuthSettings,
        requests_per_minute: u32,
    ) -> Result<Self, SettingsError> {
        settings.validate()?;
        if requests_per_minute == 0 {
            return Err(SettingsError("rate limit must be positive"));
        }
        Ok(Self {
            pool,
            keys,
            passwords,
            limiter: Arc::new(RateLimiter::new(requests_per_minute)),
            session_limiter: Arc::new(RateLimiter::new(
                requests_per_minute.saturating_mul(crate::SESSION_RATE_LIMIT_FACTOR),
            )),
            settings: Arc::new(settings),
            mailer: None,
            mail_delivery: Arc::default(),
            oauth: None,
        })
    }
}

impl FromRef<AuthState> for SharedVerifier {
    fn from_ref(state: &AuthState) -> Self {
        state.keys.clone() as Arc<dyn JwtVerifier>
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> AuthSettings {
        AuthSettings {
            issuer: "consumer".into(),
            access_ttl_secs: 900,
            refresh_ttl_days: 30,
            signup_enabled: true,
            proxy_hops: 0,
            links: EmailLinks::default(),
        }
    }
    #[test]
    fn standalone_settings_reject_overflow_and_unsafe_link_pages() {
        assert!(settings().validate().is_ok());
        let mut value = settings();
        value.access_ttl_secs = u64::MAX;
        assert!(value.validate().is_err());
        value = settings();
        value.refresh_ttl_days = u32::MAX;
        assert!(value.validate().is_err());
        value.refresh_ttl_days = i32::MAX as u32;
        assert!(value.validate().is_err());
        for page in [
            "javascript:alert(1)",
            "https://user:password@example.com",
            "https://example.com/#existing",
            "http:///",
            "",
        ] {
            value = settings();
            value.links.recovery = Some(page.into());
            assert!(value.validate().is_err(), "{page}");
        }
    }
}
