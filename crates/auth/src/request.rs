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

/// Client IP. `proxy_hops` is how many trusted proxies sit in front of the
/// server, each appending the address it saw to `X-Forwarded-For`: 0 ignores
/// the header, 1 is Caddy alone, 2 is a CDN in front of Caddy. The client is
/// then the `proxy_hops`-th entry from the right, across repeated header
/// lines; anything further left was written by the client and is ignored.
/// Missing, unreadable or unparsable entries fall back to the TCP peer. With
/// two or more hops a client can force that fallback (proxies append to the
/// client's own line), which only moves it into the proxy's shared budget.
pub fn client_ip(proxy_hops: u8, headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
    let peer_ip = peer.map(|addr| addr.ip());
    if proxy_hops == 0 {
        return peer_ip;
    }
    let mut remaining = usize::from(proxy_hops);
    // Walk from the right and stop at the first unreadable line, so a line
    // that cannot be read never shifts the count onto a client-written entry.
    for line in headers.get_all("x-forwarded-for").iter().rev() {
        let text = match line.to_str() {
            Ok(text) => text,
            Err(_) => return peer_ip,
        };
        for entry in text.rsplit(',') {
            remaining -= 1;
            if remaining == 0 {
                return entry.trim().parse().ok().or(peer_ip);
            }
        }
    }
    peer_ip
}

pub(crate) fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
}

/// Rate-limit key of a client address. IPv6 is grouped by its /64, the block
/// a single subscriber usually gets, so rotating addresses inside it does not
/// buy a fresh budget. An IPv4-mapped IPv6 address counts as the IPv4 one.
pub fn ip_key(ip: Option<IpAddr>) -> String {
    match ip.map(|ip| ip.to_canonical()) {
        Some(IpAddr::V6(ip)) => {
            let [a, b, c, d, ..] = ip.segments();
            format!("{a:x}:{b:x}:{c:x}:{d:x}::/64")
        }
        Some(ip) => ip.to_string(),
        None => String::new(),
    }
}

/// Rate-limit key of the IPv6 /48 around a client address (`a:b:c::/48`),
/// the allocation a site usually gets; `None` for IPv4 and unknown clients.
/// A budget on this key stops one site from multiplying a per-/64 budget by
/// its 65,536 /64s.
pub(crate) fn ip_block_key(ip: Option<IpAddr>) -> Option<String> {
    match ip.map(|ip| ip.to_canonical()) {
        Some(IpAddr::V6(ip)) => {
            let [a, b, c, ..] = ip.segments();
            Some(format!("{a:x}:{b:x}:{c:x}::/48"))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AuthSettings;

    #[test]
    fn x_forwarded_for_only_with_trusted_proxies() {
        let mut settings = AuthSettings {
            issuer: "t".into(),
            access_ttl_secs: 1,
            refresh_ttl_days: 1,
            signup_enabled: true,
            proxy_hops: 0,
            links: Default::default(),
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
        let peer = Some("9.9.9.9:1234".parse().unwrap());
        assert_eq!(
            client_ip(settings.proxy_hops, &headers, peer),
            Some("9.9.9.9".parse().unwrap())
        );
        settings.proxy_hops = 1;
        // Only the rightmost entry is trustworthy (the client forges the rest).
        assert_eq!(
            client_ip(settings.proxy_hops, &headers, peer),
            Some("2.2.2.2".parse().unwrap())
        );
    }

    #[test]
    fn proxy_hops_skip_the_entries_added_by_trusted_proxies() {
        let peer = Some("10.0.0.2:1234".parse().unwrap());
        let mut headers = HeaderMap::new();
        // Forged by the client, then the CDN's view, then Caddy's view.
        headers.append("x-forwarded-for", "6.6.6.6, 203.0.113.7".parse().unwrap());
        headers.append("x-forwarded-for", "198.51.100.1".parse().unwrap());
        assert_eq!(
            client_ip(2, &headers, peer),
            Some("203.0.113.7".parse().unwrap())
        );
        assert_eq!(
            client_ip(1, &headers, peer),
            Some("198.51.100.1".parse().unwrap())
        );
        assert_eq!(
            client_ip(4, &headers, peer),
            Some("10.0.0.2".parse().unwrap()),
            "fewer entries than hops falls back to the peer"
        );
        let mut unreadable = HeaderMap::new();
        unreadable.append("x-forwarded-for", "6.6.6.6".parse().unwrap());
        unreadable.append(
            "x-forwarded-for",
            axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
        );
        assert_eq!(
            client_ip(2, &unreadable, peer),
            Some("10.0.0.2".parse().unwrap()),
            "an unreadable line never shifts the count onto a forged entry"
        );
    }

    #[test]
    fn repeated_forwarded_headers_use_only_the_last_address_of_the_last_line() {
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", "1.1.1.1".parse().unwrap());
        headers.append("x-forwarded-for", "2.2.2.2, 3.3.3.3".parse().unwrap());
        let peer = Some("9.9.9.9:1234".parse().unwrap());
        assert_eq!(
            client_ip(1, &headers, peer),
            Some("3.3.3.3".parse().unwrap())
        );
        headers.append("x-forwarded-for", "invalid".parse().unwrap());
        assert_eq!(
            client_ip(1, &headers, peer),
            Some("9.9.9.9".parse().unwrap())
        );
        assert_eq!(
            client_ip(0, &headers, peer),
            Some("9.9.9.9".parse().unwrap())
        );
    }

    #[test]
    fn ip_key_groups_ipv6_by_64_and_keeps_ipv4_whole() {
        let key = |ip: &str| ip_key(Some(ip.parse().unwrap()));
        assert_eq!(key("2001:db8:1:2::1"), "2001:db8:1:2::/64");
        assert_eq!(
            key("2001:db8:1:2:ffff:ffff:ffff:ffff"),
            key("2001:db8:1:2::1"),
            "one /64 shares a budget"
        );
        assert_ne!(key("2001:db8:1:3::1"), key("2001:db8:1:2::1"));
        assert_eq!(key("203.0.113.7"), "203.0.113.7");
        assert_ne!(key("203.0.113.7"), key("203.0.113.8"));
        assert_eq!(key("::ffff:203.0.113.7"), "203.0.113.7");
        assert_eq!(ip_key(None), "");
    }

    #[test]
    fn ip_block_key_groups_ipv6_by_48_only() {
        let key = |ip: &str| ip_block_key(Some(ip.parse().unwrap()));
        assert_eq!(key("2001:db8:1:2::1").as_deref(), Some("2001:db8:1::/48"));
        assert_eq!(key("2001:db8:1:ffff::9"), key("2001:db8:1:2::1"));
        assert_ne!(key("2001:db8:2:2::1"), key("2001:db8:1:2::1"));
        assert_eq!(key("203.0.113.7"), None);
        assert_eq!(key("::ffff:203.0.113.7"), None);
        assert_eq!(ip_block_key(None), None);
    }
}
