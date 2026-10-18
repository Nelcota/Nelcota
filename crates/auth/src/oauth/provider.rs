//! A configured provider: where to send the person, how to redeem the code it
//! returns and how to read the account behind it.
use std::time::Duration;

use oauth2::{
    AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet,
    EndpointSet, HttpRequest, HttpResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl,
    Scope, TokenResponse, TokenUrl, basic::BasicClient,
};
use serde_json::Value;

use super::{github, google};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    Google,
    GitHub,
}

impl ProviderKind {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "google" => Some(ProviderKind::Google),
            "github" => Some(ProviderKind::GitHub),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Google => "google",
            ProviderKind::GitHub => "github",
        }
    }
}

/// The provider's URLs. The defaults are the real ones; tests point them at a
/// local fake.
#[derive(Clone, Debug)]
pub struct ProviderEndpoints {
    pub authorize: String,
    pub token: String,
    /// The account's profile, read with the access token.
    pub profile: String,
    /// The account's email list, for providers that keep it apart (GitHub).
    pub emails: Option<String>,
}

#[derive(Clone)]
pub struct Provider {
    pub(crate) kind: ProviderKind,
    client_id: String,
    client_secret: String,
    endpoints: ProviderEndpoints,
}

impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Provider")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

/// The account at the provider, as far as sign-in needs it.
#[derive(Debug)]
pub(crate) struct ProviderIdentity {
    /// The provider's stable account id (`sub` in OIDC).
    pub subject: String,
    pub email: Option<String>,
    /// Whether the provider vouches that the person owns `email`.
    pub email_verified: bool,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    /// The profile as received.
    pub data: Value,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct ProviderError(pub String);

impl From<reqwest::Error> for ProviderError {
    fn from(error: reqwest::Error) -> Self {
        // reqwest's message carries the URL, never the request body (secret, code).
        ProviderError(error.to_string())
    }
}

impl Provider {
    pub fn google(client_id: impl Into<String>, client_secret: impl Into<String>) -> Self {
        Self::new(
            ProviderKind::Google,
            client_id,
            client_secret,
            google::endpoints(),
        )
    }

    pub fn github(client_id: impl Into<String>, client_secret: impl Into<String>) -> Self {
        Self::new(
            ProviderKind::GitHub,
            client_id,
            client_secret,
            github::endpoints(),
        )
    }

    fn new(
        kind: ProviderKind,
        client_id: impl Into<String>,
        client_secret: impl Into<String>,
        endpoints: ProviderEndpoints,
    ) -> Self {
        Provider {
            kind,
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            endpoints,
        }
    }

    pub fn kind(&self) -> ProviderKind {
        self.kind
    }

    /// Same provider, other URLs (tests).
    pub fn with_endpoints(self, endpoints: ProviderEndpoints) -> Self {
        Provider { endpoints, ..self }
    }

    fn scopes(&self) -> &'static str {
        match self.kind {
            ProviderKind::Google => google::SCOPES,
            ProviderKind::GitHub => github::SCOPES,
        }
    }

    fn oauth_client(
        &self,
        callback: &str,
    ) -> Result<
        BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>,
        ProviderError,
    > {
        let url_error = |_| ProviderError("invalid provider URL".into());
        Ok(BasicClient::new(ClientId::new(self.client_id.clone()))
            .set_client_secret(ClientSecret::new(self.client_secret.clone()))
            .set_auth_type(AuthType::RequestBody)
            .set_auth_uri(AuthUrl::new(self.endpoints.authorize.clone()).map_err(url_error)?)
            .set_token_uri(TokenUrl::new(self.endpoints.token.clone()).map_err(url_error)?)
            .set_redirect_uri(RedirectUrl::new(callback.into()).map_err(url_error)?))
    }

    /// The provider's consent page; oauth2 owns encoding, scopes and PKCE.
    pub(crate) fn authorize_url(
        &self,
        callback: &str,
        state: &str,
        verifier: &str,
    ) -> Result<String, ProviderError> {
        let client = self.oauth_client(callback)?;
        let challenge =
            PkceCodeChallenge::from_code_verifier_sha256(&PkceCodeVerifier::new(verifier.into()));
        let (url, _) = client
            .authorize_url(|| CsrfToken::new(state.into()))
            .add_scopes(
                self.scopes()
                    .split_whitespace()
                    .map(|scope| Scope::new(scope.into())),
            )
            .set_pkce_challenge(challenge)
            .url();
        Ok(url.into())
    }

    /// Redeems the provider's code and reads the account behind it. The calls
    /// go server to server over TLS, so the answers come from the provider.
    pub(crate) async fn identity(
        &self,
        http: &reqwest::Client,
        callback: &str,
        code: &str,
        verifier: &str,
    ) -> Result<ProviderIdentity, ProviderError> {
        let token = self.exchange(http, callback, code, verifier).await?;
        match self.kind {
            ProviderKind::Google => google::profile(http, &self.endpoints, &token).await,
            ProviderKind::GitHub => github::profile(http, &self.endpoints, &token).await,
        }
    }

    async fn exchange(
        &self,
        http: &reqwest::Client,
        callback: &str,
        code: &str,
        verifier: &str,
    ) -> Result<String, ProviderError> {
        let client = self.oauth_client(callback)?;
        let token = client
            .exchange_code(AuthorizationCode::new(code.into()))
            .set_pkce_verifier(PkceCodeVerifier::new(verifier.into()))
            .request_async(&ProviderHttp(http))
            .await
            // A parser error can contain the provider's raw body. Never include
            // it in logs, since a malformed success response may contain tokens.
            .map_err(|_| ProviderError("provider code exchange refused".into()))?;
        if !token.token_type().as_ref().eq_ignore_ascii_case("bearer") {
            return Err(ProviderError("unsupported provider token type".into()));
        }
        Ok(token.access_token().secret().clone())
    }
}

/// GET with the access token, as JSON.
pub(super) async fn get_json<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<T, ProviderError> {
    let response = http
        .get(url)
        .bearer_auth(token)
        .header("accept", "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ProviderError(format!(
            "{url} answered {}",
            response.status()
        )));
    }
    read_json(response).await
}

/// Reads a JSON body of bounded size: a provider is trusted to answer, not to
/// answer small.
async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, ProviderError> {
    let body = read_body(response).await?;
    serde_json::from_slice(&body).map_err(|_| ProviderError("unexpected provider response".into()))
}

struct ProviderHttp<'a>(&'a reqwest::Client);

impl<'a> oauth2::AsyncHttpClient<'a> for ProviderHttp<'_> {
    type Error = ProviderError;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, ProviderError>> + Send + 'a>,
    >;

    fn call(&'a self, request: HttpRequest) -> Self::Future {
        Box::pin(protocol_request(self.0, request))
    }
}

/// Adapter for oauth2/openidconnect using our existing TLS and timeout policy.
async fn protocol_request(
    http: &reqwest::Client,
    request: HttpRequest,
) -> Result<HttpResponse, ProviderError> {
    let (parts, body) = request.into_parts();
    let response = http
        .request(parts.method, parts.uri.to_string())
        .headers(parts.headers)
        .body(body)
        .send()
        .await?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = read_body(response).await?;
    let mut result = HttpResponse::new(body);
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    Ok(result)
}

async fn read_body(mut response: reqwest::Response) -> Result<Vec<u8>, ProviderError> {
    const LIMIT: usize = 256 * 1024;
    if response
        .content_length()
        .is_some_and(|len| len > LIMIT as u64)
    {
        return Err(ProviderError("provider response too large".into()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > LIMIT {
            return Err(ProviderError("provider response too large".into()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// HTTP client for the providers: short timeout, no redirects.
pub(super) fn client() -> Result<reqwest::Client, String> {
    // reqwest's rustls runs on `ring` (D16); installing twice is harmless.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("nelcota/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("could not build the HTTP client: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_carries_pkce_and_state() {
        let provider = Provider::github("client-1", "secret");
        let verifier = "a".repeat(43);
        let url = provider
            .authorize_url("https://api.x.com/auth/v1/callback", "st", &verifier)
            .unwrap();
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(url.contains("client_id=client-1"));
        assert!(url.contains("redirect_uri=https%3A%2F%2Fapi.x.com%2Fauth%2Fv1%2Fcallback"));
        assert!(url.contains("state=st"));
        assert!(url.contains(&format!(
            "code_challenge={}&code_challenge_method=S256",
            super::super::pkce::challenge(&verifier)
        )));
        assert!(!url.contains("secret"));
    }

    #[test]
    fn kinds_round_trip() {
        for kind in [ProviderKind::Google, ProviderKind::GitHub] {
            assert_eq!(ProviderKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(ProviderKind::parse("facebook"), None);
    }
}
