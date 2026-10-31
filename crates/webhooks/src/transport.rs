//! Acknowledgement is the response status. Receiver bodies and URLs never reach
//! logs/history. Redirects are terminal; bounded retries handle transient errors.
use crate::{
    destination::{self, Policy},
    models::{Job, Outcome},
    signing,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Response bytes read so a keep-alive connection can return to the pool.
const DRAIN_BYTES: usize = 64 * 1024;
/// Time allowed for that read; a slow receiver's connection is closed instead.
const DRAIN_TIME: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(crate) struct Transport {
    http: reqwest::Client,
    policy: Policy,
}
impl Transport {
    pub(crate) fn new(policy: Policy) -> Result<Self, reqwest::Error> {
        Ok(Self {
            http: policy.client()?,
            policy,
        })
    }

    pub(crate) async fn send(&self, job: &Job) -> Outcome {
        let started = Instant::now();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let event_id = job.event_id.to_string();
        let url = match self.policy.validate(&job.url) {
            Ok(url) => url,
            _ => {
                return outcome(None, Some("invalid_destination"), false, None, started);
            }
        };
        let request = self
            .http
            .post(url)
            .header("content-type", "application/json")
            .header("x-nelcota-event-id", &event_id)
            .header("x-nelcota-delivery-id", job.id.to_string())
            .header("x-nelcota-timestamp", timestamp.to_string())
            .header(
                "x-nelcota-signature",
                signing::signature(
                    job.secret.expose(),
                    &event_id,
                    timestamp,
                    job.payload.as_bytes(),
                ),
            )
            .body(job.payload.clone())
            .send();
        match tokio::time::timeout(Duration::from_secs(12), request).await {
            Ok(Ok(response)) => {
                let status = response.status().as_u16();
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                let success = (200..300).contains(&status);
                let result = outcome(
                    Some(i32::from(status)),
                    match success {
                        true => None,
                        false => Some("http_error"),
                    },
                    retryable(status),
                    retry_after,
                    started,
                );
                drain(response).await;
                result
            }
            Ok(Err(error)) if destination::dns_busy(&error) => Outcome {
                // Local DNS capacity ran out before any request left this host.
                deferred: true,
                ..outcome(None, Some("dns_busy"), true, None, started)
            },
            Ok(Err(error)) => {
                // Sanitized categories only: reqwest errors can contain the URL.
                let code = match error.is_timeout() {
                    true => "timeout",
                    false => "network_error",
                };
                outcome(None, Some(code), true, None, started)
            }
            Err(_) => outcome(None, Some("timeout"), true, None, started),
        }
    }
}

/// Reads a small body to its end and discards it: an unread body keeps its
/// connection out of the pool, so every delivery would open a new one.
async fn drain(mut response: reqwest::Response) {
    let mut left = DRAIN_BYTES;
    let read = async {
        while let Ok(Some(chunk)) = response.chunk().await {
            match left.checked_sub(chunk.len()) {
                Some(rest) => left = rest,
                None => return,
            }
        }
    };
    let _ = tokio::time::timeout(DRAIN_TIME, read).await;
}

fn retryable(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500..=599)
}
fn outcome(
    status: Option<i32>,
    error: Option<&'static str>,
    retryable: bool,
    retry_after: Option<u64>,
    started: Instant,
) -> Outcome {
    Outcome {
        status,
        error,
        retryable,
        retry_after,
        duration_ms: started.elapsed().as_millis().min(i64::MAX as u128) as i64,
        deferred: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::destination::SafeResolver;
    use nelcota_core::config::Secret;

    #[tokio::test]
    async fn exhausted_local_dns_defers_without_using_an_attempt() {
        let policy = Policy {
            allow_loopback: true,
        };
        let resolver = SafeResolver::new(policy, 0);
        let transport = Transport {
            http: policy.client_with(resolver).unwrap(),
            policy,
        };
        let job = Job {
            id: 1,
            event_id: uuid::Uuid::nil(),
            attempt: 1,
            lease: uuid::Uuid::nil(),
            url: "http://localhost:9/hook".into(),
            payload: "{}".into(),
            secret: Secret::new("test-signing-key"),
        };
        let outcome = transport.send(&job).await;
        assert!(outcome.deferred);
        assert_eq!(outcome.error, Some("dns_busy"));
        assert_eq!(outcome.status, None);
    }

    #[test]
    fn only_transient_http_failures_retry() {
        for code in [408, 425, 429, 500, 502, 503, 504] {
            assert!(super::retryable(code));
        }
        for code in [200, 204, 301, 302, 307, 400, 401, 403, 404, 410, 422] {
            assert!(!super::retryable(code));
        }
    }
}
