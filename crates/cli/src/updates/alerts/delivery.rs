//! One bounded digest per channel. Destinations and raw errors never enter receipts.
use super::*;
use nelcota_auth::Mailer;
use nelcota_deployment::alerts::{Batch, Channel};
use std::net::{IpAddr, SocketAddr};
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                && ip.octets()[0] != 0
                && ip.octets()[0] < 224
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped().is_none()
                && !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
        }
    }
}
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
pub(super) async fn post(
    policy: &Policy,
    url: &str,
    payload: Option<&Batch>,
    test: bool,
) -> anyhow::Result<()> {
    let target = config::endpoint(policy, url)?;
    let host = target.host_str().context("invalid_alert_endpoint")?;
    let addresses = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host((host, target.port_or_known_default().unwrap_or(443))),
    )
    .await??
    .collect::<Vec<SocketAddr>>();
    ensure!(
        !addresses.is_empty() && addresses.len() <= 32 && addresses.iter().all(|a| public(a.ip())),
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
        .resolve_to_addrs(host, &addresses)
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
    #[test]
    fn shared_address_space_is_not_a_public_alert_destination() {
        for ip in ["100.64.0.0", "100.100.100.200", "100.127.255.255"] {
            assert!(!public(ip.parse().unwrap()), "shared route accepted: {ip}");
        }
        for ip in ["100.63.255.255", "100.128.0.0"] {
            assert!(
                public(ip.parse().unwrap()),
                "public neighbor rejected: {ip}"
            );
        }
    }
    #[test]
    fn destinations_do_not_accept_private_loopback_mapped_or_link_local_routes() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.0.1",
            "::1",
            "::ffff:8.8.8.8",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(!public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public(ip.parse().unwrap()), "{ip}");
        }
    }
}
