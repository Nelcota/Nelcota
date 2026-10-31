//! Sign-in through external providers (OAuth 2.0 / OpenID Connect).
//!
//! 1. The app sends the person to `GET /auth/v1/authorize?provider=..&
//!    redirect_to=..&code_challenge=..` (PKCE, S256). Nelcota records the
//!    sign-in and redirects to the provider with its own `state` and PKCE.
//! 2. The provider sends the person back to `GET /auth/v1/callback`. Nelcota
//!    redeems the provider's code server to server, decides which account it
//!    opens (`identities`) and redirects to `redirect_to?code=..`.
//! 3. The app calls `POST /auth/v1/token?grant_type=pkce {auth_code,
//!    code_verifier}` and gets a session. A code read from a URL is useless
//!    without the verifier the app kept.
//!
//! `redirect_to` must be one of the app pages the project lists (D91).
mod flow;
mod github;
mod google;
mod identities;
mod provider;
mod redirects;

use std::net::IpAddr;

use axum::http::StatusCode;
use nelcota_core::ApiError;
use serde_json::Value;
use url::Url;

use provider::ProviderIdentity;
pub use provider::{Provider, ProviderEndpoints, ProviderKind};
use redirects::RedirectAllowlist;

use crate::{
    AuthState,
    db::{begin_auth, db_error},
    error::{invalid_code_challenge, invalid_grant},
    pkce,
    sessions::{new_opaque_token, start_session},
};

/// The configured providers and the URLs around them.
pub struct OAuth {
    providers: Vec<Provider>,
    callback_url: String,
    redirects: RedirectAllowlist,
    http: reqwest::Client,
}

impl std::fmt::Debug for OAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Providers hold client secrets.
        f.debug_struct("OAuth")
            .field("callback_url", &self.callback_url)
            .finish_non_exhaustive()
    }
}

impl OAuth {
    /// `api_url` is this API's public origin (the provider's callback lives
    /// under it); `redirect_urls` the app pages a sign-in may return to.
    pub fn new<'a>(
        api_url: &str,
        redirect_urls: impl IntoIterator<Item = &'a str>,
        providers: Vec<Provider>,
    ) -> Result<Self, String> {
        Ok(OAuth {
            providers,
            callback_url: format!("{}/auth/v1/callback", api_url.trim_end_matches('/')),
            redirects: RedirectAllowlist::new(redirect_urls)?,
            http: provider::client()?,
        })
    }

    fn provider(&self, kind: ProviderKind) -> Option<&Provider> {
        self.providers.iter().find(|provider| provider.kind == kind)
    }
}

fn bad_request(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, code, message)
}

fn provider_disabled() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "provider_disabled",
        "this sign-in provider is not enabled in this project",
    )
}

/// `GET /auth/v1/authorize`: the provider's page for a new sign-in.
pub(crate) async fn authorize(
    state: &AuthState,
    provider: &str,
    redirect_to: &str,
    code_challenge: &str,
    method: Option<&str>,
) -> Result<String, ApiError> {
    let oauth = state.oauth.as_deref().ok_or_else(provider_disabled)?;
    let provider = ProviderKind::parse(provider)
        .and_then(|kind| oauth.provider(kind))
        .ok_or_else(provider_disabled)?;
    let redirect_to = oauth.redirects.allows(redirect_to).ok_or_else(|| {
        bad_request(
            "redirect_not_allowed",
            "redirect_to is not one of the project's NELCOTA_OAUTH_REDIRECT_URLS",
        )
    })?;
    if method.is_some_and(|method| method != "S256") || !pkce::valid_challenge(code_challenge) {
        return Err(invalid_code_challenge());
    }

    let (provider_verifier, _) = new_opaque_token();
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    let flow_state = flow::start(
        &tx,
        provider.kind,
        &provider_verifier,
        code_challenge,
        redirect_to.as_str(),
    )
    .await?;
    tx.commit().await.map_err(db_error)?;
    provider
        .authorize_url(&oauth.callback_url, &flow_state, &provider_verifier)
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "provider_error",
                "Could not start provider sign-in",
            )
        })
}

/// What the provider sent back to `/auth/v1/callback`.
pub(crate) struct Callback {
    pub state: String,
    pub code: Option<String>,
    pub error: Option<String>,
}

/// `GET /auth/v1/callback`: where to send the person next. An unknown or
/// expired `state` is an error page: there is no trusted place to go back to.
pub(crate) async fn callback(state: &AuthState, answer: Callback) -> Result<String, ApiError> {
    let oauth = state.oauth.as_deref().ok_or_else(provider_disabled)?;
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let pending = {
        let tx = begin_auth(&mut client).await?;
        let pending = flow::claim(&tx, &answer.state).await?;
        tx.commit().await.map_err(db_error)?;
        pending
    }
    .ok_or_else(|| {
        bad_request(
            "invalid_state",
            "this sign-in is unknown or expired; start it again from the app",
        )
    })?;
    drop(client);

    let outcome = match (answer.code, answer.error) {
        (Some(code), None) => match oauth.provider(pending.provider) {
            Some(provider) => provider
                .identity(
                    &oauth.http,
                    &oauth.callback_url,
                    &code,
                    &pending.provider_verifier,
                )
                .await
                .map_err(|error| {
                    tracing::warn!(provider = pending.provider.as_str(), %error, "provider sign-in failed");
                    "provider_error"
                }),
            None => Err("provider_disabled"),
        },
        // The person declined, or the provider refused the request.
        (_, error) => Err(match error.as_deref() {
            Some("access_denied") => "access_denied",
            _ => "provider_error",
        }),
    };
    finish(state, &pending, outcome).await
}

/// Links the account and hands the app its code, or tells the app why not.
async fn finish(
    state: &AuthState,
    pending: &flow::Pending,
    identity: Result<ProviderIdentity, &'static str>,
) -> Result<String, ApiError> {
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    let result = match identity {
        Ok(identity) => {
            match identities::resolve(
                &tx,
                pending.provider,
                &identity,
                state.settings.signup_enabled,
            )
            .await
            {
                Ok(Ok(user_id)) => flow::issue_code(&tx, pending.id, user_id)
                    .await?
                    .ok_or("invalid_state"),
                Ok(Err(refusal)) => Err(refusal.code()),
                // A password signup can race provider account creation without
                // taking its advisory locks. Refuse through the app redirect;
                // constraint names and account values never become callback JSON.
                Err(error) if error.sqlstate() == Some("23505") => Err("email_conflict"),
                Err(error) => return Err(error),
            }
        }
        Err(code) => Err(code),
    };
    match &result {
        Ok(_) => tx.commit().await.map_err(db_error)?,
        Err(_) => {
            // Nothing from a refused sign-in is kept, not even half a link.
            drop(tx);
            let tx = begin_auth(&mut client).await?;
            flow::discard(&tx, pending.id).await?;
            tx.commit().await.map_err(db_error)?;
        }
    }
    Ok(back_to_app(&pending.redirect_to, result))
}

/// `redirect_to` plus `code` or `error`, keeping the page's own query.
fn back_to_app(redirect_to: &str, result: Result<String, &str>) -> String {
    let mut url = match Url::parse(redirect_to) {
        Ok(url) => url,
        _ => {
            return redirect_to.to_owned();
        }
    };
    let retained: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "code" && k != "error")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        pairs.extend_pairs(&retained);
        match result {
            Ok(code) => pairs.append_pair("code", &code),
            Err(error) => pairs.append_pair("error", error),
        };
    }
    url.into()
}

/// `POST /auth/v1/token?grant_type=pkce`: the app's code becomes a session.
pub(crate) async fn redeem(
    state: &AuthState,
    auth_code: Option<String>,
    code_verifier: Option<String>,
    ip: Option<IpAddr>,
    user_agent: Option<&str>,
) -> Result<Value, ApiError> {
    let (code, verifier) = match (auth_code, code_verifier) {
        (Some(code), Some(verifier)) => (code, verifier),
        _ => {
            return Err(crate::error::validation(
                "auth_code and code_verifier are required",
            ));
        }
    };
    let mut client = state.pool.get().await.map_err(ApiError::from_pool)?;
    let tx = begin_auth(&mut client).await?;
    let user_id = flow::redeem(&tx, &code, &verifier).await?;
    let user_id = match user_id {
        Some(user_id) => user_id,
        _ => {
            // The code is spent even when the verifier was wrong: commit that.
            tx.commit().await.map_err(db_error)?;
            return Err(invalid_grant("invalid or expired code"));
        }
    };
    let session = start_session(state, &tx, user_id, ip, user_agent).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::back_to_app;

    #[test]
    fn keeps_the_page_query_and_adds_the_outcome() {
        assert_eq!(
            back_to_app("https://app.x.com/auth?next=%2Fcart", Ok("c0de".into())),
            "https://app.x.com/auth?next=%2Fcart&code=c0de"
        );
        assert_eq!(
            back_to_app("https://app.x.com/auth", Err("email_conflict")),
            "https://app.x.com/auth?error=email_conflict"
        );
    }
}
