//! Async Nelcota client. Authorization remains with PostgreSQL GRANTs and RLS.
//!
//! ```no_run
//! # async fn example() -> nelcota_client::Result<()> {
//! use nelcota_client::Client;
//! let client = Client::builder("https://api.example.com").build()?;
//! let rows = client.from("products").select("id,name")
//!     .limit(20).execute::<Vec<serde_json::Value>>().await?;
//! println!("{} rows", rows.data.len());
//! # Ok(()) }
//! ```

#![doc = include_str!("../README.md")]

pub mod auth;
mod encoding;
mod error;
mod http;
mod json;
pub mod rest;
pub mod storage;

pub use encoding::escape_like;
pub use error::{DbErrorInfo, Error, Result};
pub use http::RequestOptions;
pub use tokio_util::sync::CancellationToken;

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use url::Url;

/// Response data and HTTP metadata. Headers include Content-Range and Preference-Applied.
#[derive(Debug)]
pub struct Response<T> {
    pub data: T,
    pub status: u16,
    pub count: Option<u64>,
    pub headers: HeaderMap,
}

/// An omitted write field differs from an explicit JSON null.
/// Generated Insert/Update types use `Field<Option<T>>` for nullable columns.
///
/// A struct field of this type needs
/// `#[serde(default, skip_serializing_if = "nelcota_client::Field::is_omitted")]`
/// (generated models always have it). Without it, serializing `Field::Omit`
/// fails instead of silently writing NULL.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Field<T> {
    #[default]
    Omit,
    Value(T),
}
impl<T> Field<T> {
    pub fn is_omitted(&self) -> bool {
        matches!(self, Self::Omit)
    }
}
impl<T> From<T> for Field<T> {
    fn from(value: T) -> Self {
        Self::Value(value)
    }
}
impl<T: Serialize> Serialize for Field<T> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Omit => Err(serde::ser::Error::custom(
                "Field::Omit cannot be serialized: annotate the field with                  #[serde(default, skip_serializing_if = \"nelcota_client::Field::is_omitted\")]",
            )),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}
impl<'de, T: serde::Deserialize<'de>> serde::Deserialize<'de> for Field<T> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self::Value)
    }
}

#[derive(Clone)]
enum TokenMode {
    Session,
    Fixed(Option<String>),
    /// An explicit token that cannot be sent as a header; every request fails.
    Invalid,
}
impl TokenMode {
    fn fixed(token: String) -> Self {
        match valid_token(&token) {
            Ok(()) => Self::Fixed(Some(token)),
            Err(_) => Self::Invalid,
        }
    }
}

/// A future boxed for recursion through the transport (token refresh sends HTTP).
pub(crate) type BoxFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send + 'a>>;

fn valid_token(token: &str) -> Result<()> {
    HeaderValue::from_str(&format!("Bearer {token}"))
        .map(|_| ())
        .map_err(|_| invalid_token())
}
pub(crate) fn invalid_token() -> Error {
    Error::Usage("invalid access token header".into())
}

pub(crate) struct Inner {
    base: Url,
    http: reqwest::Client,
    timeout: Duration,
    retries: usize,
    headers: HeaderMap,
    auth: auth::Manager,
}

/// Clones share transport and session lifecycle. `with_access_token` scopes a caller's token.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
    token: TokenMode,
    options: RequestOptions,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.inner.base)
            .finish_non_exhaustive()
    }
}

impl Client {
    pub fn builder(url: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            url: url.into(),
            token: TokenMode::Session,
            timeout: Duration::from_secs(30),
            retries: 2,
            http: None,
            store: None,
            margin: Duration::from_secs(60),
            headers: Vec::new(),
        }
    }

    pub fn from(&self, table: &str) -> rest::Query {
        rest::Query::table(self.clone(), table)
    }

    pub fn rpc(&self, function: &str, args: &impl Serialize) -> rest::Query {
        rest::Query::rpc(self.clone(), function, args)
    }

    pub fn auth(&self) -> auth::AuthClient {
        auth::AuthClient {
            client: self.clone(),
        }
    }
    pub fn storage(&self) -> storage::StorageClient {
        storage::StorageClient {
            client: self.clone(),
        }
    }

    /// Use an explicit token for REST/storage without changing the shared login session.
    /// Automatic session refresh is disabled for this scoped client. A token
    /// that cannot be sent as a header is detected here; every request of the
    /// scoped client then fails with the same `Error::Usage` as
    /// [`ClientBuilder::build`]. Use [`try_with_access_token`](Self::try_with_access_token)
    /// to get that error immediately.
    pub fn with_access_token(&self, token: impl Into<String>) -> Self {
        Self {
            token: TokenMode::fixed(token.into()),
            ..self.clone()
        }
    }

    /// Like [`with_access_token`](Self::with_access_token), refusing an invalid token now.
    pub fn try_with_access_token(&self, token: impl Into<String>) -> Result<Self> {
        let token = token.into();
        valid_token(&token)?;
        Ok(self.with_access_token(token))
    }

    /// A session-mode clone with default options, for tasks the client owns.
    pub(crate) fn shared_session(inner: Arc<Inner>) -> Self {
        Self {
            inner,
            token: TokenMode::Session,
            options: RequestOptions::default(),
        }
    }

    /// Explicitly anonymous REST/storage requests, independent of the shared session.
    pub fn anonymous(&self) -> Self {
        Self {
            token: TokenMode::Fixed(None),
            ..self.clone()
        }
    }

    /// Scope timeout/cancellation options to this clone, including auth operations.
    pub fn with_options(&self, options: RequestOptions) -> Self {
        Self {
            options,
            ..self.clone()
        }
    }

    pub fn base_url(&self) -> &Url {
        &self.inner.base
    }

    pub(crate) fn url(&self, path: &str) -> Result<Url> {
        Url::parse(&format!(
            "{}{path}",
            self.inner.base.as_str().trim_end_matches('/')
        ))
        .map_err(|_| Error::Usage("invalid request URL".into()))
    }
}

/// Creates a native Tokio client with rustls/ring and Mozilla roots.
pub struct ClientBuilder {
    url: String,
    token: TokenMode,
    timeout: Duration,
    retries: usize,
    http: Option<reqwest::Client>,
    store: Option<Arc<dyn auth::SessionStorage>>,
    margin: Duration,
    headers: Vec<(String, String)>,
}

impl ClientBuilder {
    /// A header sent with every request (`x-request-source`, a tracing ID...).
    /// Repeating a name keeps the last value. `build` refuses invalid names or
    /// values and `Authorization`, which belongs to `access_token` and sessions.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
    /// An explicit token for every request; `build` refuses one that cannot
    /// be sent as a header.
    pub fn access_token(mut self, token: impl Into<String>) -> Self {
        self.token = TokenMode::fixed(token.into());
        self
    }
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
    pub fn retries(mut self, retries: usize) -> Self {
        self.retries = retries;
        self
    }
    /// Custom transports must disable their own retries for auth and mutations.
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http = Some(client);
        self
    }
    pub fn session_storage(mut self, store: Arc<dyn auth::SessionStorage>) -> Self {
        self.store = Some(store);
        self
    }
    /// Refresh this far before expiry, capped at half the session token lifetime.
    pub fn refresh_margin(mut self, margin: Duration) -> Self {
        self.margin = margin;
        self
    }

    pub fn build(self) -> Result<Client> {
        if self.retries > 10 {
            return Err(Error::Usage("retries must be 0–10".into()));
        }
        let mut base = Url::parse(&self.url)
            .map_err(|_| Error::Usage("base URL must be absolute HTTP(S)".into()))?;
        if !["http", "https"].contains(&base.scheme())
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(Error::Usage(
                "base URL must be HTTP(S) without credentials, query or fragment".into(),
            ));
        }
        if let TokenMode::Invalid = self.token {
            return Err(invalid_token());
        }
        let mut headers = HeaderMap::new();
        for (name, value) in &self.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| Error::Usage(format!("invalid header name {name:?}")))?;
            if name == AUTHORIZATION {
                return Err(Error::Usage(
                    "set the Authorization header with access_token or a session".into(),
                ));
            }
            let value = HeaderValue::from_str(value)
                .map_err(|_| Error::Usage(format!("invalid value for header {name}")))?;
            headers.insert(name, value);
        }
        base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
        let http = match self.http {
            Some(client) => client,
            None => {
                // An explicit TLS provider makes the published SDK work without server startup.
                let roots = rustls::RootCertStore::from_iter(
                    webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
                );
                let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .map_err(|e| Error::Usage(e.to_string()))?
                .with_root_certificates(roots)
                .with_no_client_auth();
                reqwest::Client::builder()
                    .use_preconfigured_tls(tls)
                    .retry(reqwest::retry::never())
                    .redirect(reqwest::redirect::Policy::limited(5))
                    .connect_timeout(Duration::from_secs(10))
                    .user_agent(concat!("nelcota-client/", env!("CARGO_PKG_VERSION")))
                    .build()
                    .map_err(Error::network)?
            }
        };
        Ok(Client {
            inner: Arc::new(Inner {
                base,
                http,
                timeout: self.timeout,
                retries: self.retries,
                headers,
                auth: auth::Manager::new(
                    self.store
                        .unwrap_or_else(|| Arc::new(auth::MemoryStorage::default())),
                    self.margin,
                ),
            }),
            token: self.token,
            options: RequestOptions::default(),
        })
    }
}
