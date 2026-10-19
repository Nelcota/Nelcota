use crate::{Client, Error, Response, Result, TokenMode};
use bytes::Bytes;
use reqwest::{
    Method,
    header::{AUTHORIZATION, HeaderMap, HeaderValue, RETRY_AFTER},
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    future::Future,
    time::{Duration, SystemTime},
};

const MAX_ERROR_BYTES: usize = 64 * 1024;

/// Error pages are metadata; drop oversized bodies and keep the HTTP status.
async fn error_body(response: &mut reqwest::Response) -> Result<Option<Bytes>> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_ERROR_BYTES as u64)
    {
        return Ok(None);
    }
    let mut body = bytes::BytesMut::new();
    while let Some(chunk) = response.chunk().await.map_err(Error::network)? {
        if chunk.len() > MAX_ERROR_BYTES - body.len() {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body.freeze()))
}

/// A zero timeout disables the deadline. Cancellation covers retries and buffered bodies.
#[derive(Clone, Debug, Default)]
pub struct RequestOptions {
    pub timeout: Option<Duration>,
    pub cancellation: Option<crate::CancellationToken>,
}

pub(crate) enum AuthHeader {
    Default,
    None,
    Token(String),
}

pub(crate) struct Spec {
    pub method: Method,
    pub path: String,
    pub params: Vec<(String, String)>,
    pub headers: HeaderMap,
    pub json: Option<Value>,
    pub body: Option<reqwest::Body>,
    pub auth: AuthHeader,
    pub timeout: Option<Duration>,
}

impl Spec {
    pub fn new(method: Method, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            params: Vec::new(),
            headers: HeaderMap::new(),
            json: None,
            body: None,
            auth: AuthHeader::Default,
            timeout: None,
        }
    }
    pub fn json(mut self, value: Value) -> Self {
        self.json = Some(value);
        self
    }
    pub fn unauthenticated(mut self) -> Self {
        self.auth = AuthHeader::None;
        self
    }
    pub fn token(mut self, value: &str) -> Self {
        self.auth = AuthHeader::Token(value.to_owned());
        self
    }
}

pub(crate) async fn cancel<T>(
    options: &RequestOptions,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    if let Some(token) = &options.cancellation {
        return tokio::select! { biased; _ = token.cancelled() => Err(Error::Cancelled), result = future => result };
    }
    future.await
}

impl Client {
    pub(crate) async fn raw(&self, spec: Spec) -> Result<reqwest::Response> {
        self.request(spec, false)
            .await
            .map(|(response, _)| response)
    }

    pub(crate) async fn bytes(&self, spec: Spec) -> Result<Response<Bytes>> {
        let (response, data) = self.request(spec, true).await?;
        Ok(Response {
            data: data.unwrap_or_default(),
            status: response.status().as_u16(),
            count: count(response.headers()),
            headers: response.headers().clone(),
        })
    }

    pub(crate) async fn json<T: DeserializeOwned>(&self, spec: Spec) -> Result<Response<T>> {
        let response = self.bytes(spec).await?;
        let body = match response.data.is_empty() {
            true => b"null".as_slice(),
            false => response.data.as_ref(),
        };
        let data = serde_json::from_slice(body).map_err(|e| Error::InvalidResponse {
            status: response.status,
            message: e.to_string(),
        })?;
        Ok(Response {
            data,
            status: response.status,
            count: response.count,
            headers: response.headers,
        })
    }

    async fn request(
        &self,
        mut spec: Spec,
        buffered: bool,
    ) -> Result<(reqwest::Response, Option<Bytes>)> {
        let token = match &spec.auth {
            AuthHeader::None => None,
            AuthHeader::Token(token) => Some(token.clone()),
            AuthHeader::Default => match &self.token {
                TokenMode::Fixed(token) => token.clone(),
                TokenMode::Session => cancel(&self.options, self.auth().access_token()).await?,
            },
        };
        if let Some(token) = token {
            let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| Error::Usage("invalid access token header".into()))?;
            value.set_sensitive(true);
            spec.headers.insert(AUTHORIZATION, value);
        }
        // Per-request headers win over the client's default ones.
        let mut headers = self.inner.headers.clone();
        for (name, value) in &spec.headers {
            headers.insert(name.clone(), value.clone());
        }
        spec.headers = headers;
        let mut url = self.url(&spec.path)?;
        url.query_pairs_mut().extend_pairs(&spec.params);
        let timeout = self
            .options
            .timeout
            .or(spec.timeout)
            .unwrap_or(self.inner.timeout);
        let retryable = spec.method == Method::GET || spec.method == Method::HEAD;
        let tries = match retryable {
            true => self.inner.retries,
            false => 0,
        };
        for attempt in 0..=tries {
            let mut request = self
                .inner
                .http
                .request(spec.method.clone(), url.clone())
                .headers(spec.headers.clone());
            if let Some(json) = &spec.json {
                request = request.json(json);
            }
            if let Some(body) = spec.body.take() {
                request = request.body(body);
            }
            if !timeout.is_zero() {
                request = request.timeout(timeout);
            }
            let operation = async {
                let mut response = request.send().await.map_err(Error::network)?;
                if !response.status().is_success() && response.status().as_u16() != 304 {
                    let status = response.status().as_u16();
                    let retry_after = parse_retry_after(
                        response
                            .headers()
                            .get(RETRY_AFTER)
                            .and_then(|h| h.to_str().ok()),
                    );
                    let value: Value = error_body(&mut response)
                        .await?
                        .and_then(|body| serde_json::from_slice(&body).ok())
                        .unwrap_or(Value::Null);
                    return Err(Error::Http {
                        status,
                        code: value["code"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| crate::error::code_for_status(status)),
                        message: value["message"]
                            .as_str()
                            .unwrap_or("HTTP request failed")
                            .to_owned(),
                        retry_after,
                        db: crate::error::DbErrorInfo::from_body(&value),
                    });
                }
                let data = match buffered {
                    true => {
                        let mut bytes = bytes::BytesMut::new();
                        while let Some(chunk) = response.chunk().await.map_err(Error::network)? {
                            bytes.extend_from_slice(&chunk);
                        }
                        Some(bytes.freeze())
                    }
                    false => None,
                };
                Ok((response, data))
            };
            let result = cancel(&self.options, async {
                if timeout.is_zero() {
                    return operation.await;
                }
                tokio::time::timeout(timeout, operation)
                    .await
                    .map_err(|_| Error::Timeout)?
            })
            .await;
            let error = match result {
                Ok(value) => return Ok(value),
                Err(error) => error,
            };
            let transient =
                matches!(&error, Error::Network(_)) || matches!(error.status(), Some(429 | 503));
            let wait = error.retry_after().unwrap_or_else(|| backoff(attempt));
            if attempt == tries || !transient || wait > Duration::from_secs(30) {
                return Err(error);
            }
            cancel(&self.options, async {
                tokio::time::sleep(wait).await;
                Ok(())
            })
            .await?;
        }
        unreachable!("at least one attempt")
    }
}

fn backoff(attempt: usize) -> Duration {
    let cap = 200_u64
        .saturating_mul(2_u64.saturating_pow(attempt.min(16) as u32))
        .min(30_000);
    let mut bytes = [0; 8];
    let random = match getrandom::fill(&mut bytes).is_ok() {
        true => u64::from_le_bytes(bytes),
        false => cap / 2,
    };
    Duration::from_millis(random % (cap + 1))
}

pub(crate) fn count(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("content-range")?
        .to_str()
        .ok()?
        .split_once('/')?
        .1
        .parse()
        .ok()
}

fn parse_retry_after(value: Option<&str>) -> Option<Duration> {
    let value = value?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    httpdate::parse_http_date(value)
        .ok()
        .map(|date| date.duration_since(SystemTime::now()).unwrap_or_default())
}
