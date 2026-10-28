//! HTTP request metadata and endpoint rate limiting.
use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{HeaderMap, header, request::Parts},
};
use std::net::{IpAddr, SocketAddr};
/// Address of the TCP connection, when available (absent in `oneshot` tests).
pub struct PeerAddr(pub Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for PeerAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(PeerAddr(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0),
        ))
    }
}

/// Client IP. Behind a proxy (`trust_proxy`), uses the rightmost entry of
/// `X-Forwarded-For`, including repeated header lines (the one OUR proxy added).
pub fn client_ip(
    trust_proxy: bool,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Option<IpAddr> {
    if trust_proxy {
        let forwarded = headers
            .get_all("x-forwarded-for")
            .iter()
            .next_back()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok());
        if forwarded.is_some() {
            return forwarded;
        }
    }
    peer.map(|addr| addr.ip())
}

pub(crate) fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
}

pub(crate) fn ip_key(ip: Option<IpAddr>) -> String {
    ip.map(|i| i.to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AuthSettings;

    #[test]
    fn x_forwarded_for_only_with_trust_proxy() {
        let mut settings = AuthSettings {
            issuer: "t".into(),
            access_ttl_secs: 1,
            refresh_ttl_days: 1,
            signup_enabled: true,
            trust_proxy: false,
            links: Default::default(),
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
        let peer = Some("9.9.9.9:1234".parse().unwrap());
        assert_eq!(
            client_ip(settings.trust_proxy, &headers, peer),
            Some("9.9.9.9".parse().unwrap())
        );
        settings.trust_proxy = true;
        // Only the rightmost entry is trustworthy (the client forges the rest).
        assert_eq!(
            client_ip(settings.trust_proxy, &headers, peer),
            Some("2.2.2.2".parse().unwrap())
        );
    }

    #[test]
    fn repeated_forwarded_headers_use_only_the_last_address_of_the_last_line() {
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", "1.1.1.1".parse().unwrap());
        headers.append("x-forwarded-for", "2.2.2.2, 3.3.3.3".parse().unwrap());
        let peer = Some("9.9.9.9:1234".parse().unwrap());
        assert_eq!(
            client_ip(true, &headers, peer),
            Some("3.3.3.3".parse().unwrap())
        );
        headers.append("x-forwarded-for", "invalid".parse().unwrap());
        assert_eq!(
            client_ip(true, &headers, peer),
            Some("9.9.9.9".parse().unwrap())
        );
        assert_eq!(
            client_ip(false, &headers, peer),
            Some("9.9.9.9".parse().unwrap())
        );
    }
}
