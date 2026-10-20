//! Sending email (the single-use links of `links`).
//!
//! It sits behind the [`Mailer`] trait: SMTP in production ([`SmtpMailer`]);
//! in tests, a mailer that only keeps the messages. Nelcota runs no mail server
//! of its own: it uses whatever SMTP the project configures (Postmark, SES,
//! Resend, Gmail, the hosting provider's...).

use std::{sync::Arc, time::Duration};

use axum::http::StatusCode;
use nelcota_core::ApiError;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

use futures_util::future::BoxFuture;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, header::ContentType},
};

/// Plain-text message: links work in any client and there is no HTML to
/// escape.
#[derive(Clone)]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub text: String,
}

impl std::fmt::Debug for Email {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Message bodies can contain one-time credentials. Keep diagnostics
        // useful without formatting their contents or recipient information.
        f.debug_struct("Email").finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct MailError(pub String);

pub trait Mailer: Send + Sync + 'static {
    fn send(&self, email: Email) -> BoxFuture<'_, Result<(), MailError>>;
}

/// Admission and lifetime budget shared by every auth email flow.
/// Reserve before issuing a token; overload must not consume its cooldown.
pub struct MailDelivery {
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl Default for MailDelivery {
    fn default() -> Self {
        Self::new(16, Duration::from_secs(30))
    }
}

impl MailDelivery {
    pub fn new(max_in_flight: usize, timeout: Duration) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(max_in_flight.max(1))),
            timeout,
        }
    }

    pub(crate) fn reserve(&self) -> Result<MailSlot, ApiError> {
        let permit = self.slots.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "mail_busy",
                "all email delivery slots are busy; retry later",
            )
        })?;
        Ok(MailSlot {
            _permit: permit,
            timeout: self.timeout,
        })
    }
}

pub(crate) struct MailSlot {
    _permit: OwnedSemaphorePermit,
    timeout: Duration,
}

impl MailSlot {
    pub(crate) fn send(self, mailer: Arc<dyn Mailer>, message: Email, kind: &'static str) {
        tokio::spawn(async move {
            let slot = self;
            match tokio::time::timeout(slot.timeout, mailer.send(message)).await {
                Ok(Ok(())) => {}
                Ok(Err(err)) => tracing::error!(error = %err, kind, "failed to send a link email"),
                Err(_) => tracing::error!(kind, "link email delivery timed out"),
            }
            drop(slot);
        });
    }
}

/// SMTP configured by URL, in lettre's format:
/// `smtps://user:password@smtp.example.com:465` (implicit TLS) or
/// `smtp://user:password@smtp.example.com:587?tls=required` (STARTTLS).
pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpMailer {
    pub fn new(url: &str, from: &str) -> Result<Self, MailError> {
        let url = encrypted_smtp_url(url)?;
        let from = from
            .parse::<Mailbox>()
            .map_err(|e| MailError(format!("invalid NELCOTA_SMTP_FROM: {e}")))?;
        // lettre's error message does not include the URL (which holds the password).
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url.as_str())
            .map_err(|e| MailError(format!("invalid NELCOTA_SMTP_URL: {e}")))?
            .timeout(Some(Duration::from_secs(15)))
            .build();
        Ok(SmtpMailer { transport, from })
    }
}

/// Apply one policy before lettre can choose a cleartext/opportunistic mode.
/// Parse the same decoded query pairs as lettre, rejecting ambiguous settings.
fn encrypted_smtp_url(value: &str) -> Result<Url, MailError> {
    let invalid = || {
        MailError(
            "invalid NELCOTA_SMTP_URL: use smtps://... or smtp://...?tls=required; \
             only one tls=required query option is supported, without a fragment"
                .into(),
        )
    };
    let url = Url::parse(value).map_err(|_| invalid())?;
    if url.fragment().is_some() {
        return Err(invalid());
    }
    let mut required = false;
    for (name, value) in url.query_pairs() {
        if name != "tls" || value != "required" || required {
            return Err(invalid());
        }
        required = true;
    }
    match (url.scheme(), required) {
        ("smtps", _) | ("smtp", true) => Ok(url),
        _ => Err(invalid()),
    }
}

impl Mailer for SmtpMailer {
    fn send(&self, email: Email) -> BoxFuture<'_, Result<(), MailError>> {
        Box::pin(async move {
            let to = email
                .to
                .parse::<Mailbox>()
                .map_err(|e| MailError(format!("invalid recipient: {e}")))?;
            let message = Message::builder()
                .from(self.from.clone())
                .to(to)
                .subject(email.subject)
                .header(ContentType::TEXT_PLAIN)
                .body(email.text)
                .map_err(|e| MailError(e.to_string()))?;
            self.transport
                .send(message)
                .await
                .map(|_| ())
                .map_err(|e| MailError(e.to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn smtp_url(scheme: &str, suffix: &str) -> String {
        let mut url =
            url::Url::parse(&format!("{scheme}://mail.example.test:587{suffix}")).unwrap();
        url.set_username("operator").unwrap();
        url.set_password(Some(&crate::generate_ed25519_private_key()))
            .unwrap();
        url.into()
    }

    #[test]
    fn rejects_smtp_without_required_tls() {
        let accepted: Vec<_> = ["", "?tls=opportunistic", "?tls=", "?TLS=required"]
            .into_iter()
            .filter(|suffix| {
                SmtpMailer::new(&smtp_url("smtp", suffix), "sender@example.test").is_ok()
            })
            .collect();
        assert!(
            accepted.is_empty(),
            "unencrypted SMTP modes accepted: {accepted:?}"
        );
    }

    #[test]
    fn rejects_ambiguous_or_unsupported_smtp_options() {
        let mut accepted = Vec::new();
        for scheme in ["smtp", "smtps"] {
            for suffix in [
                "?tls=required&tls=opportunistic",
                "?tls=opportunistic&tls=required",
                "?tls=required&%74ls=required",
                "?tls=required&unexpected=value",
                "?tls=required#ignored",
            ] {
                if SmtpMailer::new(&smtp_url(scheme, suffix), "sender@example.test").is_ok() {
                    accepted.push((scheme, suffix));
                }
            }
        }
        assert!(
            accepted.is_empty(),
            "unsupported SMTP options accepted: {accepted:?}"
        );
    }

    #[test]
    fn encrypted_smtp_modes_remain_supported() {
        for (scheme, suffix) in [
            ("smtps", ""),
            ("smtps", "?tls=required"),
            ("smtp", "?tls=required"),
            ("smtp", "?%74ls=%72equired"),
        ] {
            assert!(SmtpMailer::new(&smtp_url(scheme, suffix), "sender@example.test").is_ok());
        }
    }

    #[test]
    fn rejected_smtp_settings_do_not_expose_the_url_or_credentials() {
        let url = smtp_url("smtp", "?tls=opportunistic");
        let error = SmtpMailer::new(&url, "sender@example.test").err().unwrap();
        assert!(error.0.contains("NELCOTA_SMTP_URL"));
        for private in [url.as_str(), "operator", "mail.example.test"] {
            assert!(!error.0.contains(private));
        }
    }

    #[tokio::test]
    async fn delivery_deadline_drops_the_mailer_future_and_returns_capacity() {
        struct NeverMailer {
            started: tokio::sync::Notify,
            dropped: Arc<std::sync::atomic::AtomicBool>,
        }
        impl Mailer for NeverMailer {
            fn send(&self, _: Email) -> BoxFuture<'_, Result<(), MailError>> {
                struct Guard(Arc<std::sync::atomic::AtomicBool>);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        self.0.store(true, std::sync::atomic::Ordering::Release);
                    }
                }
                Box::pin(async {
                    let _guard = Guard(self.dropped.clone());
                    self.started.notify_one();
                    std::future::pending().await
                })
            }
        }
        let delivery = MailDelivery::new(1, Duration::from_millis(50));
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mailer = Arc::new(NeverMailer {
            started: tokio::sync::Notify::new(),
            dropped: dropped.clone(),
        });
        delivery.reserve().unwrap().send(
            mailer.clone(),
            Email {
                to: "test@example.com".into(),
                subject: "test".into(),
                text: "test".into(),
            },
            "recovery",
        );
        mailer.started.notified().await;
        assert!(delivery.reserve().is_err());
        let permit = tokio::time::timeout(Duration::from_secs(1), delivery.slots.acquire())
            .await
            .unwrap()
            .unwrap();
        assert!(dropped.load(std::sync::atomic::Ordering::Acquire));
        drop(permit);
        assert!(delivery.reserve().is_ok());
    }

    #[test]
    fn valid_and_invalid_settings() {
        assert!(
            SmtpMailer::new(
                "smtps://u:p@smtp.example.com:465",
                "Shop <no-reply@shop.com>"
            )
            .is_ok()
        );
        assert!(
            SmtpMailer::new(
                "smtp://u:p@smtp.example.com:587?tls=required",
                "no-reply@shop.com"
            )
            .is_ok()
        );
        let err = SmtpMailer::new("http://smtp.example.com", "a@b.com")
            .err()
            .unwrap();
        assert!(err.0.contains("NELCOTA_SMTP_URL"));
        let err = SmtpMailer::new("smtps://u:secret@smtp.example.com", "not an email")
            .err()
            .unwrap();
        assert!(err.0.contains("NELCOTA_SMTP_FROM"));
        assert!(!err.0.contains("secret"));
    }
}
