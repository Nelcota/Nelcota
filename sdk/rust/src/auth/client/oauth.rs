//! Native OAuth/PKCE adapters; session publication stays with AuthClient.
use super::AuthClient;
use crate::auth::{AuthEventKind, OAuthProvider, PkceFlow, Session};
use crate::{Error, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::json;
use sha2::{Digest, Sha256};
use url::Url;

impl AuthClient {
    /// Return the authorization URL and verifier. The application opens the browser
    /// and keeps this flow until its callback; the SDK does not navigate or bind a port.
    pub fn begin_oauth(&self, provider: OAuthProvider, redirect_to: &str) -> Result<PkceFlow> {
        let redirect = Url::parse(redirect_to)
            .map_err(|_| Error::Usage("redirect_to must be an absolute URL".into()))?;
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| Error::Usage("secure random generator unavailable".into()))?;
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = self.client.url("/auth/v1/authorize")?;
        url.query_pairs_mut().extend_pairs([
            ("provider", provider.as_str()),
            ("redirect_to", redirect.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ]);
        Ok(PkceFlow { url, verifier })
    }
    pub async fn exchange_code(&self, code: &str, verifier: &str) -> Result<Session> {
        if code.trim().is_empty() {
            return Err(Error::Usage("OAuth code is required".into()));
        }
        if !(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        {
            return Err(Error::Usage("invalid PKCE verifier".into()));
        }
        let manager = &self.client.inner.auth;
        let mut state = self.lock_state().await?;
        let session = self
            .token("pkce", json!({"auth_code":code, "code_verifier":verifier}))
            .await?;
        manager
            .save(&mut state, Some(session.clone()), AuthEventKind::SignedIn)
            .await?;
        Ok(session)
    }
    /// Remove OAuth callback credentials from a URL before handing it to application logs/history.
    pub async fn handle_redirect(&self, url: &mut Url, flow: PkceFlow) -> Result<Option<Session>> {
        let code = url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned());
        let error = url
            .query_pairs()
            .find(|(k, _)| k == "error")
            .map(|(_, v)| v.into_owned());
        let pairs: Vec<_> = url
            .query_pairs()
            .filter(|(k, _)| k != "code" && k != "error")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        if !pairs.is_empty() {
            url.query_pairs_mut().extend_pairs(pairs);
        }
        if let Some(code) = error {
            return Err(Error::Http {
                status: 400,
                code,
                message: "OAuth sign-in failed".into(),
                retry_after: None,
                db: None,
            });
        }
        match code {
            Some(code) => self.exchange_code(&code, &flow.verifier).await.map(Some),
            None => Ok(None),
        }
    }
}
