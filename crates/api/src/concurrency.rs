//! Per-caller admission for REST requests. One caller (a signed-in user, or
//! one client network for requests without a user) runs at most a fixed
//! number of requests at a time, so it can never hold every pooled
//! connection, however expensive its queries are. `service_role` is exempt.
//! The limit itself ([`crate::CallerLimit`]) is shared with storage uploads.
use crate::ApiSettings;
use axum::{
    extract::{ConnectInfo, FromRef, FromRequestParts},
    http::request::Parts,
};
use nelcota_auth::{Auth, CallerSlot, SharedVerifier, caller_key};
use nelcota_core::{ApiError, Claims};
use std::{net::SocketAddr, sync::Arc};

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
        let ip = nelcota_auth::client_ip(settings.proxy_hops, &parts.headers, peer);
        let key = caller_key(&claims, ip);
        let slot = settings.callers.clone().admit(key).await?;
        Ok(Admitted {
            claims,
            _slot: slot,
        })
    }
}
