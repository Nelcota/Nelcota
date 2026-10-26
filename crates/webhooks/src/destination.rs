//! Egress policy: validate literal URLs and the addresses actually connected to.
//! DNS answers are checked by reqwest's resolver, so there is no second lookup
//! between validation and connection. A pooled socket remains the checked peer.
use crate::{Error, invalid};
use nelcota_core::net::is_public_address;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::{
    io,
    net::ToSocketAddrs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;
use url::{Host, Url};

#[derive(Clone, Copy, Default)]
pub struct Policy {
    /// Explicit development opt-in; only localhost/127.0.0.1/::1, never LANs.
    pub allow_loopback: bool,
}

impl Policy {
    pub fn validate(&self, value: &str) -> Result<Url, Error> {
        let bad = || {
            invalid(
                "webhook_invalid_url",
                "Use a public HTTPS URL without credentials, query or fragment",
            )
        };
        if value.len() > 2048 || value.trim() != value || value.chars().any(char::is_control) {
            return Err(bad());
        }
        let url = Url::parse(value).map_err(|_| bad())?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(bad());
        }
        let host = url.host().ok_or_else(bad)?;
        let development = self.allow_loopback && is_loopback_host(&host);
        if url.scheme() != "https" && !(url.scheme() == "http" && development) {
            return Err(bad());
        }
        let allowed = match host {
            Host::Ipv4(ip) => is_public_address(IpAddr::V4(ip)) || development,
            Host::Ipv6(ip) => is_public_address(IpAddr::V6(ip)) || development,
            Host::Domain(name) => {
                let trimmed = name.trim_end_matches('.');
                development
                    || (trimmed.contains('.')
                        && !trimmed.ends_with(".localhost")
                        && trimmed != "localhost")
            }
        };
        if !allowed {
            return Err(bad());
        }
        Ok(url)
    }

    pub(crate) fn client(self) -> Result<reqwest::Client, reqwest::Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            // The release image has no OS certificate store.
            .tls_certs_only(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().map(|cert| {
                reqwest::Certificate::from_der(cert.as_ref()).expect("bundled root certificate")
            }))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(SafeResolver::new(self)))
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(2)
            .pool_idle_timeout(Duration::from_secs(30))
            .tls_sslkeylogfile(false)
            .user_agent("Nelcota-Webhooks/1")
            .build()
    }
}

fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.trim_end_matches('.') == "localhost",
        Host::Ipv4(ip) => *ip == Ipv4Addr::LOCALHOST,
        Host::Ipv6(ip) => *ip == Ipv6Addr::LOCALHOST,
    }
}

struct SafeResolver {
    policy: Policy,
    lookups: Arc<Semaphore>,
}
impl SafeResolver {
    fn new(policy: Policy) -> Self {
        Self {
            policy,
            lookups: Arc::new(Semaphore::new(4)),
        }
    }
}

async fn bounded_lookup<F>(slots: Arc<Semaphore>, lookup: F) -> io::Result<Vec<SocketAddr>>
where
    F: FnOnce() -> io::Result<Vec<SocketAddr>> + Send + 'static,
{
    let permit = slots
        .try_acquire_owned()
        .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "webhook DNS capacity reached"))?;
    // System DNS runs blocking work which cannot be cancelled once started.
    // Keep its slot until that work ends, even if the HTTP deadline expires.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        lookup()
    })
    .await
    .map_err(io::Error::other)?
}

impl Resolve for SafeResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_loopback =
            self.policy.allow_loopback && name.as_str().trim_end_matches('.') == "localhost";
        let slots = self.lookups.clone();
        Box::pin(async move {
            let name = name.as_str().to_owned();
            let addresses = bounded_lookup(slots, move || {
                (name.as_str(), 0).to_socket_addrs().map(Iterator::collect)
            })
            .await?;
            if addresses.is_empty()
                || addresses.iter().any(|addr| {
                    !is_public_address(addr.ip())
                        && !(allow_loopback
                            && matches!(
                                addr.ip(),
                                IpAddr::V4(Ipv4Addr::LOCALHOST) | IpAddr::V6(Ipv6Addr::LOCALHOST)
                            ))
                })
            {
                return Err(
                    std::io::Error::other("webhook destination is not a public address").into(),
                );
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_internal_and_ambiguous_urls() {
        let policy = Policy::default();
        for url in [
            "http://example.com/hook",
            "https://127.0.0.1/",
            "https://0x7f000001/",
            "https://2130706433/",
            "https://10.0.0.1/",
            "https://100.64.0.1/",
            "https://169.254.169.254/",
            "https://192.168.1.1/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[2002:7f00:1::]/",
            "https://[2001:db8::1]/",
            "https://localhost/",
            "https://service/",
            "https://foo.localhost/",
            "https://user:pass@example.com/",
            "https://example.com/?token=secret",
            "https://example.com/#secret",
            " https://example.com/",
            "file:///etc/passwd",
            "https://example.com/\n",
        ] {
            assert!(policy.validate(url).is_err(), "{url}");
        }
        for url in [
            "https://example.com/hooks/orders",
            "https://8.8.8.8/hook",
            "https://[2606:4700:4700::1111]/",
        ] {
            assert!(policy.validate(url).is_ok(), "{url}");
        }
    }
    #[test]
    fn development_never_opens_the_lan() {
        let policy = Policy {
            allow_loopback: true,
        };
        for url in [
            "http://127.0.0.1:8080/hook",
            "http://localhost:8080/hook",
            "http://[::1]:8080/hook",
        ] {
            assert!(policy.validate(url).is_ok());
        }
        for url in [
            "http://example.com/",
            "http://10.0.0.1/",
            "https://192.168.0.1/",
            "https://169.254.169.254/",
        ] {
            assert!(policy.validate(url).is_err());
        }
    }
    #[tokio::test]
    async fn resolver_checks_the_connected_addresses() {
        assert!(
            SafeResolver::new(Policy::default())
                .resolve("localhost".parse().unwrap())
                .await
                .is_err()
        );
        assert!(
            SafeResolver::new(Policy {
                allow_loopback: true
            })
            .resolve("localhost".parse().unwrap())
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn cancelled_requests_cannot_accumulate_blocking_dns_lookups() {
        let slots = Arc::new(Semaphore::new(1));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let resolving = tokio::spawn(bounded_lookup(slots.clone(), move || {
            let _ = started.send(());
            blocked.recv().unwrap();
            Ok(Vec::new())
        }));
        ready.await.unwrap();
        resolving.abort();
        let _ = resolving.await;
        let next = bounded_lookup(slots.clone(), || Ok(Vec::new())).await;
        release.send(()).unwrap();
        assert_eq!(next.unwrap_err().kind(), io::ErrorKind::WouldBlock);
        let _permit = tokio::time::timeout(Duration::from_secs(1), slots.acquire())
            .await
            .expect("finished DNS work must release its slot")
            .unwrap();
    }
}
