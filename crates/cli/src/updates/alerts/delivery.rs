//! One bounded digest per channel. Destinations and raw errors never enter receipts.
use super::*;
use nelcota_auth::Mailer;
use nelcota_core::net::is_public_address;
use nelcota_deployment::alerts::{Batch, Channel};
use std::net::SocketAddr;
pub(super) fn tls() -> anyhow::Result<()> {
    if rustls::crypto::CryptoProvider::get_default().is_none()
        && rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        && rustls::crypto::CryptoProvider::get_default().is_none()
    {
        anyhow::bail!("alert_tls_unavailable");
    }
    Ok(())
}
/// Host to resolve, without the brackets `host_str` keeps around IPv6 literals.
fn endpoint_host(target: &url::Url) -> anyhow::Result<String> {
    Ok(match target.host().context("invalid_alert_endpoint")? {
        url::Host::Domain(domain) => domain.to_owned(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
    })
}
const MAX_ALERT_ADDRESSES: usize = 32;
fn allowed_destinations(addresses: &[SocketAddr]) -> bool {
    !addresses.is_empty()
        && addresses.len() <= MAX_ALERT_ADDRESSES
        && addresses.iter().all(|a| is_public_address(a.ip()))
}
pub(super) async fn post(
    policy: &Policy,
    url: &str,
    payload: Option<&Batch>,
    test: bool,
) -> anyhow::Result<()> {
    let target = config::endpoint(policy, url)?;
    let host = endpoint_host(&target)?;
    let addresses = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host((host.as_str(), target.port_or_known_default().unwrap_or(443))),
    )
    .await??
    .collect::<Vec<SocketAddr>>();
    ensure!(
        allowed_destinations(&addresses),
        "invalid_alert_destination"
    );
    // Retain configured HTTP proxy/CA trust. A production egress proxy is a
    // trusted DNS/routing boundary; literal/private DNS targets are still refused.
    tls()?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &addresses)
        .pool_max_idle_per_host(0)
        .build()?;
    let mut request = client.post(target);
    if let Some(batch) = payload {
        let body = serde_json::to_vec(
            &serde_json::json!({"schema":1,"source":"nelcota","test":test,"controller":policy.origin,"delivery":{"id":batch.id,"created_at":batch.created_at,"events":batch.events}}),
        )?;
        ensure!(body.len() <= 256 * 1024, "alert_payload_limit");
        request = request
            .header("content-type", "application/json")
            .header("idempotency-key", &batch.id)
            .body(body);
    }
    let response = request.send().await?;
    ensure!(response.status().is_success(), "alert_endpoint_rejected");
    // No response body is needed or read, including on hostile endpoints.
    Ok(())
}
pub(super) fn text(batch: &Batch, test: bool, origin: &str) -> String {
    if test {
        return format!(
            "Nelcota operational alert delivery test. No incident is being reported.\nController: {origin}\nDelivery: {}\nSMTP acceptance does not certify inbox delivery.",
            batch.id
        );
    }
    let mut body = format!(
        "Nelcota operational incidents\nController: {origin}\nDelivery: {}\nObserved changes (UTC Unix timestamps):\n",
        batch.id
    );
    for item in &batch.events {
        body.push_str(&format!(
            "{} | {} | {} | {:?} | changed={} | first={}\n",
            match item.active {
                true => "ALERT",
                false => "RECOVERED",
            },
            item.project.as_deref().unwrap_or("host"),
            item.kind.code(),
            item.severity,
            item.changed_at,
            item.since
        ));
    }
    body.push_str("\nOpen Server > Alerts for current state. An uncertain transport response can cause a duplicate delivery; the delivery identifier stays stable on retries.\n");
    body
}
pub(super) async fn send(
    policy: &Policy,
    cfg: &config::Config,
    channel: Channel,
    batch: &Batch,
    test: bool,
) -> bool {
    let operation = async {
        match channel {
            Channel::Email => {
                let (url, from) = cfg.smtp(policy)?;
                let mailer = nelcota_auth::SmtpMailer::new(&url, &from)
                    .map_err(|_| anyhow::anyhow!("invalid_smtp_configuration"))?;
                let subject = match test {
                    true => "Nelcota: operational alert delivery test",
                    false => "Nelcota: operational incidents and recovery",
                };
                mailer
                    .send(nelcota_auth::Email {
                        to: cfg.settings.recipient.clone(),
                        subject: subject.into(),
                        text: text(batch, test, &policy.origin),
                    })
                    .await
                    .map_err(|_| anyhow::anyhow!("alert_delivery_failed"))?;
            }
            Channel::Webhook => {
                post(
                    policy,
                    cfg.webhook.as_deref().context("alert_endpoint_required")?,
                    Some(batch),
                    test,
                )
                .await?
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    matches!(
        tokio::time::timeout(Duration::from_secs(8), operation).await,
        Ok(Ok(()))
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn socket(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 443)
    }
    #[test]
    fn destinations_must_all_be_public_and_bounded() {
        assert!(allowed_destinations(&[
            socket("1.1.1.1"),
            socket("2606:4700:4700::1111")
        ]));
        assert!(!allowed_destinations(&[]));
        // One private answer is enough to refuse the whole destination.
        assert!(!allowed_destinations(&[
            socket("1.1.1.1"),
            socket("10.0.0.1")
        ]));
        assert!(!allowed_destinations(&[socket("100.64.0.1")]));
        assert!(!allowed_destinations(&[socket("::ffff:127.0.0.1")]));
        let many = vec![socket("1.1.1.1"); MAX_ALERT_ADDRESSES + 1];
        assert!(!allowed_destinations(&many));
    }
    #[test]
    fn ipv6_literal_endpoints_resolve_without_brackets() {
        let target = url::Url::parse("https://[2606:4700:4700::1111]/hook").unwrap();
        assert_eq!(endpoint_host(&target).unwrap(), "2606:4700:4700::1111");
        let target = url::Url::parse("https://alerts.example.com/hook").unwrap();
        assert_eq!(endpoint_host(&target).unwrap(), "alerts.example.com");
    }
}
