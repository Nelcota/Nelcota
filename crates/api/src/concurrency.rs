//! Per-caller admission for REST requests. One caller (a signed-in user, or
//! one client network for requests without a user) runs at most a fixed
//! number of requests at a time, so it can never hold every pooled
//! connection, however expensive its queries are. `service_role` is exempt.
use crate::ApiSettings;
use axum::{
    extract::{ConnectInfo, FromRef, FromRequestParts},
    http::{StatusCode, request::Parts},
};
use nelcota_auth::{Auth, SharedVerifier};
use nelcota_core::{ApiError, Claims, Role};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// How long a request may wait for one of its caller's slots before a 429.
/// Short bursts (a page loading several queries at once) queue instead of
/// failing; a caller that keeps every slot busy is refused.
const QUEUE_WAIT: Duration = Duration::from_secs(1);

/// Concurrent REST requests per caller.
#[derive(Debug, Default)]
pub struct CallerLimit {
    /// Requests one caller may run at once; 0 admits everything.
    per_caller: usize,
    /// Only callers with a request running or waiting have an entry.
    callers: Mutex<HashMap<String, Caller>>,
}

#[derive(Debug)]
struct Caller {
    /// Requests holding or waiting for a slot; the entry goes away at zero.
    requests: usize,
    slots: Arc<Semaphore>,
}

/// One admitted request. Dropping it frees the caller's slot.
#[derive(Debug)]
pub struct CallerSlot {
    limit: Arc<CallerLimit>,
    key: String,
    permit: Option<OwnedSemaphorePermit>,
}

impl CallerLimit {
    /// `per_caller` concurrent requests per caller; 0 disables the limit.
    pub fn new(per_caller: usize) -> Self {
        CallerLimit {
            per_caller: per_caller.min(Semaphore::MAX_PERMITS),
            callers: Mutex::default(),
        }
    }

    pub fn per_caller(&self) -> usize {
        self.per_caller
    }

    /// Callers with a request running or waiting.
    pub fn tracked_callers(&self) -> usize {
        self.callers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    /// Waits briefly for a slot of `key`'s caller; `None` (no key, or no
    /// limit) is admitted without a slot. A caller whose slots stay busy gets
    /// `429 rate_limited` with `Retry-After: 1`.
    pub async fn admit(
        self: Arc<Self>,
        key: Option<String>,
    ) -> Result<Option<CallerSlot>, ApiError> {
        let key = match key {
            Some(key) if self.per_caller > 0 => key,
            _ => return Ok(None),
        };
        let slots = {
            let mut callers = self.callers.lock().unwrap_or_else(PoisonError::into_inner);
            let caller = callers.entry(key.clone()).or_insert_with(|| Caller {
                requests: 0,
                slots: Arc::new(Semaphore::new(self.per_caller)),
            });
            caller.requests += 1;
            caller.slots.clone()
        };
        // From here on, dropping the slot (also when this future is dropped
        // while waiting) undoes the count above.
        let mut slot = CallerSlot {
            limit: self,
            key,
            permit: None,
        };
        match tokio::time::timeout(QUEUE_WAIT, slots.acquire_owned()).await {
            Ok(Ok(permit)) => {
                slot.permit = Some(permit);
                Ok(Some(slot))
            }
            _ => Err(busy()),
        }
    }
}

fn busy() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "too many concurrent requests from this caller; wait and try again",
    )
    .retry_after(1)
}

impl Drop for CallerSlot {
    fn drop(&mut self) {
        self.permit = None;
        let mut callers = self
            .limit
            .callers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let idle = match callers.get_mut(&self.key) {
            Some(caller) => {
                caller.requests = caller.requests.saturating_sub(1);
                caller.requests == 0
            }
            None => false,
        };
        if idle {
            callers.remove(&self.key);
        }
    }
}

/// The request's claims, admitted under its caller's limit: extracting it
/// authenticates the request and then waits for a slot, which stays taken
/// for as long as this value lives (the whole handler).
pub(crate) struct Admitted {
    pub claims: Claims,
    _slot: Option<CallerSlot>,
}

impl<S> FromRequestParts<S> for Admitted
where
    SharedVerifier: FromRef<S>,
    Arc<ApiSettings>: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Auth(claims) = Auth::from_request_parts(parts, state).await?;
        let settings = Arc::<ApiSettings>::from_ref(state);
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0);
        let ip = nelcota_auth::client_ip(settings.trust_proxy, &parts.headers, peer);
        let key = caller_key(&claims, ip);
        let slot = settings.callers.clone().admit(key).await?;
        Ok(Admitted {
            claims,
            _slot: slot,
        })
    }
}

/// Who a request counts against: the user for a signed-in token, else the
/// client's network. `service_role` (a trusted backend) is not limited.
pub(crate) fn caller_key(claims: &Claims, ip: Option<IpAddr>) -> Option<String> {
    match (claims.role(), claims.sub()) {
        (Role::ServiceRole, _) => None,
        (Role::Authenticated, Some(user)) => Some(format!("user:{user}")),
        _ => Some(format!("ip:{}", network(ip))),
    }
}

/// An IPv4 address, or the /64 network of an IPv6 one: a single subscriber
/// usually holds a whole /64. IPv4-mapped IPv6 addresses count as IPv4.
fn network(ip: Option<IpAddr>) -> String {
    match ip.map(|ip| ip.to_canonical()) {
        Some(IpAddr::V4(ip)) => ip.to_string(),
        Some(IpAddr::V6(ip)) => {
            let [a, b, c, d, ..] = ip.segments();
            format!("{a:x}:{b:x}:{c:x}:{d:x}::/64")
        }
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key(n: &str) -> Option<String> {
        Some(format!("ip:{n}"))
    }

    #[tokio::test]
    async fn each_caller_has_its_own_slots_and_idle_callers_are_forgotten() {
        let limit = Arc::new(CallerLimit::new(1));
        let first = limit.clone().admit(key("a")).await.unwrap();
        assert!(first.is_some());
        let refused = limit.clone().admit(key("a")).await.unwrap_err();
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(refused.code(), "rate_limited");
        let other = limit.clone().admit(key("b")).await.unwrap();
        assert!(other.is_some());
        assert_eq!(limit.tracked_callers(), 2);
        drop(first);
        drop(other);
        assert_eq!(limit.tracked_callers(), 0);
        assert!(limit.clone().admit(key("a")).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn a_short_burst_waits_for_a_slot() {
        let limit = Arc::new(CallerLimit::new(1));
        let first = limit.clone().admit(key("a")).await.unwrap();
        let waiting = tokio::spawn(limit.clone().admit(key("a")));
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(first);
        let second = waiting.await.unwrap().unwrap();
        assert!(second.is_some());
        drop(second);
        assert_eq!(limit.tracked_callers(), 0);
    }

    #[tokio::test]
    async fn no_limit_and_no_key_admit_without_tracking() {
        let unlimited = Arc::new(CallerLimit::new(0));
        assert!(unlimited.clone().admit(key("a")).await.unwrap().is_none());
        let limit = Arc::new(CallerLimit::new(1));
        assert!(limit.clone().admit(None).await.unwrap().is_none());
        assert_eq!(limit.tracked_callers(), 0);
    }

    #[test]
    fn users_and_networks_are_keys_and_the_service_role_is_exempt() {
        let claims = |payload| Claims::from_payload(payload).unwrap();
        let user = "3f1c2b6e-0d55-4b1a-9a43-6c1f0b8e2d71";
        let signed_in = claims(json!({ "role": "authenticated", "sub": user }));
        let v4: IpAddr = "192.0.2.7".parse().unwrap();
        assert_eq!(
            caller_key(&signed_in, Some(v4)),
            Some(format!("user:{user}"))
        );
        let service = claims(json!({ "role": "service_role" }));
        assert_eq!(caller_key(&service, Some(v4)), None);
        let anon = Claims::anon();
        assert_eq!(caller_key(&anon, Some(v4)).unwrap(), "ip:192.0.2.7");
        let mapped: IpAddr = "::ffff:192.0.2.7".parse().unwrap();
        assert_eq!(caller_key(&anon, Some(mapped)).unwrap(), "ip:192.0.2.7");
        let one: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let other: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
        let elsewhere: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(
            caller_key(&anon, Some(one)).unwrap(),
            "ip:2001:db8:1:2::/64"
        );
        assert_eq!(caller_key(&anon, Some(one)), caller_key(&anon, Some(other)));
        assert_ne!(
            caller_key(&anon, Some(one)),
            caller_key(&anon, Some(elsewhere))
        );
    }
}
