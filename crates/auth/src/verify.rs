//! `POST /auth/v1/verify`: opening an email link, routed by its `type`.
use nelcota_core::ApiError;
use serde::Deserialize;
use serde_json::Value;
use std::net::IpAddr;

use crate::{
    AuthState,
    error::unsupported_type,
    links::{self, LinkKind},
    recovery,
};

#[derive(Deserialize)]
pub(crate) struct VerifyBody {
    #[serde(rename = "type")]
    kind: String,
    token: String,
    /// The new password; only `recovery` takes one.
    #[serde(default)]
    password: Option<String>,
    /// The PKCE verifier of the signup's `code_challenge`; only `signup`
    /// reads it, to keep the password chosen at signup.
    #[serde(default)]
    code_verifier: Option<String>,
}

pub(crate) async fn verify(
    state: &AuthState,
    body: VerifyBody,
    ip: Option<IpAddr>,
    user_agent: Option<&str>,
) -> Result<Value, ApiError> {
    match LinkKind::parse(&body.kind) {
        Some(LinkKind::Recovery) => {
            recovery::complete(state, &body.token, body.password, ip, user_agent).await
        }
        Some(kind) => {
            links::sign_in(
                state,
                kind,
                &body.token,
                body.code_verifier.as_deref(),
                ip,
                user_agent,
            )
            .await
        }
        None => Err(unsupported_type(
            "type must be recovery, signup or magiclink",
        )),
    }
}
