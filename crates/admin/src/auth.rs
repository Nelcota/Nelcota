//! Panel credentials, session lifecycle and login endpoints.
use crate::{AdminState, ApiError};
use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cookie::{Cookie, SameSite};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
const COOKIE: &str = "nelcota_admin";
const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);

pub struct Credentials {
    pub email: String,
    pub password_hash: String,
}

/// In-memory panel sessions (key = SHA-256 of the cookie token).
#[derive(Default)]
pub struct Sessions {
    active: Mutex<HashMap<Vec<u8>, Instant>>,
}

impl Sessions {
    fn create(&self) -> String {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("system randomness source unavailable");
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        active.retain(|_, expires| *expires > now);
        active.insert(Sha256::digest(token.as_bytes()).to_vec(), now + SESSION_TTL);
        token
    }

    fn valid(&self, token: &str) -> bool {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        active
            .get(&Sha256::digest(token.as_bytes())[..])
            .is_some_and(|expires| *expires > Instant::now())
    }

    fn remove(&self, token: &str) {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        active.remove(&Sha256::digest(token.as_bytes())[..]);
    }
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(Result::ok)
        .find(|c| c.name() == COOKIE)
        .map(|c| c.value().to_owned())
}

/// The panel session cookie: `HttpOnly`, `SameSite=Strict`, limited to
/// `/admin`, and `Secure` behind HTTPS. An empty value with a zero max age
/// clears it.
fn session_cookie(value: String, max_age: cookie::time::Duration, secure: bool) -> String {
    Cookie::build((COOKIE, value))
        .path("/admin")
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(secure)
        .max_age(max_age)
        .build()
        .to_string()
}

pub(crate) async fn require_session(
    State(state): State<AdminState>,
    request: Request,
    next: Next,
) -> Response {
    let ok = session_token(request.headers()).is_some_and(|t| state.sessions.valid(&t));
    if !ok {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "session_expired",
            "session expired: sign in again",
        )
        .into_response();
    }
    next.run(request).await
}

#[derive(Deserialize)]
pub(crate) struct LoginRequest {
    email: String,
    password: String,
}

pub(crate) async fn login(
    State(state): State<AdminState>,
    nelcota_auth::PeerAddr(peer): nelcota_auth::PeerAddr,
    headers: HeaderMap,
    Json(form): Json<LoginRequest>,
) -> Response {
    let ip = nelcota_auth::client_ip(state.trust_proxy, &headers, peer);
    let key = format!("admin-login:{}", nelcota_auth::ip_key(ip));
    if state.limiter.check(&key).is_err() {
        return ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
            "Too many attempts. Wait a minute.",
        )
        .into_response();
    }
    // The password is always checked (even with a wrong email), so response
    // time does not reveal which of the two failed.
    let hash = state.credentials.password_hash.clone();
    let password_ok = state.passwords.verify(form.password, Some(hash)).await;
    let email_ok = form
        .email
        .trim()
        .eq_ignore_ascii_case(&state.credentials.email);
    if !(password_ok && email_ok) {
        tracing::warn!("panel login refused");
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Invalid email or password.",
        )
        .into_response();
    }
    tracing::info!("panel login");
    (
        [(header::SET_COOKIE, new_session_cookie(&state))],
        Json(json!({ "email": state.credentials.email })),
    )
        .into_response()
}

/// Creates a session and returns the matching `Set-Cookie`.
pub(crate) fn new_session_cookie(state: &AdminState) -> String {
    let ttl = i64::try_from(SESSION_TTL.as_secs()).unwrap_or(i64::MAX);
    session_cookie(
        state.sessions.create(),
        cookie::time::Duration::seconds(ttl),
        state.secure_cookies,
    )
}

/// `GET /admin/api/whoami` (public): project name, for the login screen.
pub(crate) async fn whoami(State(state): State<AdminState>) -> Json<serde_json::Value> {
    Json(json!({ "project": state.host.project, "sso": state.host.sso.is_some() }))
}

pub(crate) async fn session(State(state): State<AdminState>) -> Json<serde_json::Value> {
    Json(json!({ "email": state.credentials.email, "project": state.host.project }))
}

pub(crate) async fn logout(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token(&headers) {
        state.sessions.remove(&token);
    }
    (
        [(
            header::SET_COOKIE,
            session_cookie(
                String::new(),
                cookie::time::Duration::ZERO,
                state.secure_cookies,
            ),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(values: &[&str]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for v in values {
            map.append(header::COOKIE, HeaderValue::from_str(v).unwrap());
        }
        map
    }

    #[test]
    fn session_token_finds_the_panel_cookie() {
        let token = |values: &[&str]| session_token(&headers(values));
        assert_eq!(token(&["nelcota_admin=abc"]).as_deref(), Some("abc"));
        assert_eq!(
            token(&["theme=dark; nelcota_admin=abc;  other=1"]).as_deref(),
            Some("abc")
        );
        // Several Cookie headers (HTTP/2 splits them).
        assert_eq!(
            token(&["theme=dark", "nelcota_admin=xyz"]).as_deref(),
            Some("xyz")
        );
        // A cookie whose name only starts the same way does not count.
        assert_eq!(token(&["nelcota_admin_old=abc"]), None);
        assert_eq!(token(&["garbage; =; ;"]), None);
        assert_eq!(token(&[]), None);
    }

    #[test]
    fn session_cookie_carries_the_security_attributes() {
        let set = session_cookie("tok".into(), cookie::time::Duration::seconds(60), true);
        let parsed = Cookie::parse(set.clone()).unwrap();
        assert_eq!((parsed.name(), parsed.value()), (COOKIE, "tok"));
        assert_eq!(parsed.path(), Some("/admin"));
        assert_eq!(parsed.http_only(), Some(true));
        assert_eq!(parsed.same_site(), Some(SameSite::Strict));
        assert_eq!(parsed.secure(), Some(true));
        assert_eq!(parsed.max_age(), Some(cookie::time::Duration::seconds(60)));
        assert!(set.starts_with("nelcota_admin=tok"), "{set}");

        // Plain HTTP (local dev): no Secure, or the browser would drop it.
        let plain = session_cookie("tok".into(), cookie::time::Duration::seconds(60), false);
        assert!(!plain.contains("Secure"), "{plain}");

        let cleared = Cookie::parse(session_cookie(
            String::new(),
            cookie::time::Duration::ZERO,
            false,
        ))
        .unwrap();
        assert_eq!(cleared.value(), "");
        assert_eq!(cleared.max_age(), Some(cookie::time::Duration::ZERO));
    }
}
