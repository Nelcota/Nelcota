//! HTTP routes and response adaptation for authentication.
use crate::{
    Auth, AuthState, accounts,
    error::unsupported_type,
    links::{self, LinkKind},
    oauth,
    rate_limit::{limit, limit_sessions},
    request::{PeerAddr, client_ip, ip_key, user_agent},
    sessions,
    verify::{self, VerifyBody},
};
use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use nelcota_core::{
    ApiError,
    extract::{Json, Query},
};
use serde::Deserialize;
use serde_json::Value;
pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/auth/v1/signup", post(signup))
        .route("/auth/v1/token", post(token))
        .route("/auth/v1/logout", post(logout))
        .route("/auth/v1/user", get(user).put(update_user))
        .route("/auth/v1/recover", post(recover))
        .route("/auth/v1/magiclink", post(magic_link))
        .route("/auth/v1/resend", post(resend))
        .route("/auth/v1/verify", post(verify))
        .route("/auth/v1/authorize", get(authorize))
        .route("/auth/v1/callback", get(callback))
        .route_layer(middleware::from_fn(no_store))
        .route("/auth/v1/.well-known/jwks.json", get(jwks))
        .with_state(state)
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

async fn signup(
    State(state): State<AuthState>,
    PeerAddr(peer): PeerAddr,
    headers: HeaderMap,
    Json(body): Json<accounts::Signup>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let ip = client_ip(state.settings.proxy_hops, &headers, peer);
    if state.settings.signup_enabled {
        limit(&state, &format!("signup:{}", ip_key(ip)))?;
    }
    let session = accounts::signup(&state, body, ip, user_agent(&headers)).await?;
    Ok((StatusCode::CREATED, Json(session)))
}
async fn logout(
    State(state): State<AuthState>,
    Auth(claims): Auth,
) -> Result<StatusCode, ApiError> {
    sessions::logout(&state, &claims).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn user(State(state): State<AuthState>, Auth(claims): Auth) -> Result<Json<Value>, ApiError> {
    Ok(Json(accounts::user(&state, &claims).await?))
}
async fn update_user(
    State(state): State<AuthState>,
    Auth(claims): Auth,
    Json(body): Json<accounts::UserUpdate>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(accounts::update_user(&state, &claims, body).await?))
}
#[derive(Deserialize)]
struct GrantQuery {
    grant_type: String,
}

#[derive(Deserialize)]
struct TokenBody {
    email: Option<String>,
    password: Option<String>,
    refresh_token: Option<String>,
    auth_code: Option<String>,
    code_verifier: Option<String>,
}

/// `POST /auth/v1/token?grant_type=password|refresh_token|pkce`.
async fn token(
    State(state): State<AuthState>,
    PeerAddr(peer): PeerAddr,
    headers: HeaderMap,
    Query(query): Query<GrantQuery>,
    Json(body): Json<TokenBody>,
) -> Result<Json<Value>, ApiError> {
    let ip = client_ip(state.settings.proxy_hops, &headers, peer);
    // Password guessing gets the tight per-IP budget. Refreshes and code
    // redemptions only work with a secret already in hand, and every open tab
    // refreshes on its own, so they draw from a separate, larger budget.
    match query.grant_type.as_str() {
        "password" => limit(&state, &format!("token:{}", ip_key(ip)))?,
        _ => limit_sessions(&state, &format!("refresh:{}", ip_key(ip)))?,
    }

    let session = match query.grant_type.as_str() {
        "password" => {
            accounts::password_grant(&state, body.email, body.password, ip, user_agent(&headers))
                .await?
        }
        "refresh_token" => sessions::refresh(&state, body.refresh_token).await?,
        "pkce" => {
            oauth::redeem(
                &state,
                body.auth_code,
                body.code_verifier,
                ip,
                user_agent(&headers),
            )
            .await?
        }
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "unsupported_grant_type",
                "grant_type must be password, refresh_token or pkce",
            ));
        }
    };
    Ok(Json(session))
}

/// `GET /auth/v1/.well-known/jwks.json`: public keys to validate our JWTs.
async fn jwks(State(state): State<AuthState>) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "public, max-age=300"),
        ],
        state.keys.jwks_json().to_owned(),
    )
}

#[derive(Deserialize)]
struct EmailBody {
    email: String,
}

/// Emails a link of `kind`; always `200 {}`, whether or not the account exists.
async fn send_link(
    state: &AuthState,
    kind: LinkKind,
    peer: PeerAddr,
    headers: &HeaderMap,
    email: &str,
) -> Result<Json<Value>, ApiError> {
    links::ensure_enabled(state, kind)?;
    let ip = client_ip(state.settings.proxy_hops, headers, peer.0);
    limit(state, &format!("{}:{}", kind.as_str(), ip_key(ip)))?;
    links::send(state, kind, email).await?;
    Ok(Json(serde_json::json!({})))
}

async fn recover(
    State(state): State<AuthState>,
    peer: PeerAddr,
    headers: HeaderMap,
    Json(body): Json<EmailBody>,
) -> Result<Json<Value>, ApiError> {
    send_link(&state, LinkKind::Recovery, peer, &headers, &body.email).await
}

async fn magic_link(
    State(state): State<AuthState>,
    peer: PeerAddr,
    headers: HeaderMap,
    Json(body): Json<EmailBody>,
) -> Result<Json<Value>, ApiError> {
    send_link(&state, LinkKind::MagicLink, peer, &headers, &body.email).await
}

#[derive(Deserialize)]
struct ResendBody {
    #[serde(rename = "type")]
    kind: String,
    email: String,
}

/// `POST /auth/v1/resend {type: "signup", email}`: a new confirmation link.
async fn resend(
    State(state): State<AuthState>,
    peer: PeerAddr,
    headers: HeaderMap,
    Json(body): Json<ResendBody>,
) -> Result<Json<Value>, ApiError> {
    if LinkKind::parse(&body.kind) != Some(LinkKind::Signup) {
        return Err(unsupported_type("type must be signup"));
    }
    send_link(&state, LinkKind::Signup, peer, &headers, &body.email).await
}

async fn verify(
    State(state): State<AuthState>,
    PeerAddr(peer): PeerAddr,
    headers: HeaderMap,
    Json(body): Json<VerifyBody>,
) -> Result<Json<Value>, ApiError> {
    let ip = client_ip(state.settings.proxy_hops, &headers, peer);
    limit(&state, &format!("verify:{}", ip_key(ip)))?;
    Ok(Json(
        verify::verify(&state, body, ip, user_agent(&headers)).await?,
    ))
}

#[derive(Deserialize)]
struct AuthorizeQuery {
    provider: String,
    redirect_to: String,
    code_challenge: String,
    code_challenge_method: Option<String>,
}

/// `GET /auth/v1/authorize`: redirects to the provider (see `oauth`).
async fn authorize(
    State(state): State<AuthState>,
    PeerAddr(peer): PeerAddr,
    headers: HeaderMap,
    Query(query): Query<AuthorizeQuery>,
) -> Result<Redirect, ApiError> {
    let ip = client_ip(state.settings.proxy_hops, &headers, peer);
    limit(&state, &format!("authorize:{}", ip_key(ip)))?;
    let url = oauth::authorize(
        &state,
        &query.provider,
        &query.redirect_to,
        &query.code_challenge,
        query.code_challenge_method.as_deref(),
    )
    .await?;
    Ok(Redirect::to(&url))
}

#[derive(Deserialize)]
struct CallbackQuery {
    #[serde(default)]
    state: String,
    code: Option<String>,
    error: Option<String>,
}

/// `GET /auth/v1/callback`: the provider's answer, then back to the app.
async fn callback(
    State(state): State<AuthState>,
    PeerAddr(peer): PeerAddr,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Result<Redirect, ApiError> {
    let ip = client_ip(state.settings.proxy_hops, &headers, peer);
    limit(&state, &format!("callback:{}", ip_key(ip)))?;
    let url = oauth::callback(
        &state,
        oauth::Callback {
            state: query.state,
            code: query.code,
            error: query.error,
        },
    )
    .await?;
    Ok(Redirect::to(&url))
}
