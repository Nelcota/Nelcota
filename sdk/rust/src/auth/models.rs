//! Account/session values and lifecycle notifications, without persistence or HTTP.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct User {
    pub id: String,
    pub email: String,
    pub email_confirmed_at: Option<String>,
    pub user_metadata: BTreeMap<String, Value>,
    pub created_at: String,
    pub last_sign_in_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub expires_at: u64,
    pub refresh_token: String,
    pub user: User,
}
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("user", &self.user)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}
impl Session {
    pub fn expires_in_now(&self) -> Duration {
        Duration::from_secs(self.expires_at.saturating_sub(now()))
    }
    pub(super) fn validate(&self) -> Result<()> {
        if self.access_token.is_empty()
            || self.refresh_token.is_empty()
            || self.token_type != "bearer"
            || self.user.id.is_empty()
        {
            return Err(Error::InvalidResponse {
                status: 200,
                message: "invalid session".into(),
            });
        }
        Ok(())
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthEventKind {
    SignedIn,
    SignedOut,
    Refreshed,
    UserUpdated,
}
#[derive(Clone, Debug)]
pub struct AuthEvent {
    pub kind: AuthEventKind,
    pub session: Option<Session>,
}

/// Changes for [`AuthClient::update_user`](super::AuthClient::update_user); `None` leaves a field as it is.
#[derive(Clone, Default)]
pub struct UserUpdate {
    /// New password (same rules as sign-up).
    pub password: Option<String>,
    /// Required with `password` when the account already has one.
    pub current_password: Option<String>,
    /// Merged into `user_metadata` one level deep; a key set to `null` is
    /// removed. Must be a JSON object.
    pub data: Option<Value>,
}
impl std::fmt::Debug for UserUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserUpdate")
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("data", &self.data)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct SignUp {
    pub user: User,
    pub session: Option<Session>,
}
