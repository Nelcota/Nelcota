//! One owner for HTTP/session transitions, refresh coordination and timer cleanup.
mod auto_refresh;
mod oauth;
pub use auto_refresh::AutoRefresh;

use super::manager::{Current, Guard, Manager, RefreshResult, Rotation, outcome};
use super::{
    AuthEvent, AuthEventKind, EmailLink, EmailLinkType, Session, SignUp, User, UserUpdate,
};
use crate::{BoxFuture, Client, Error, RequestOptions, Result, TokenMode, http::Spec};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/// Sign-out renews only an expired token, allowing this much clock skew.
const SIGN_OUT_SKEW: Duration = Duration::from_secs(5);
/// Requests wait this long after a transient refresh failure without
/// Retry-After before starting another rotation (matching the TypeScript SDK).
const QUICK_RETRY: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
pub struct AuthClient {
    pub(crate) client: Client,
}

impl AuthClient {
    pub fn subscribe(&self) -> broadcast::Receiver<AuthEvent> {
        self.manager().subscribe()
    }

    fn manager(&self) -> &Manager {
        &self.client.inner.auth
    }
    fn options(&self) -> &RequestOptions {
        &self.client.options
    }

    /// Current session, refreshed when it is within the refresh margin. Reading
    /// a fresh session never waits for sign-in, rotation or persistence.
    /// After a transient refresh failure a still-valid session is returned
    /// without another rotation until Retry-After (or two seconds) has passed.
    /// Explicit tokens do not change this session.
    pub async fn get_session(&self) -> Result<Option<Session>> {
        crate::http::cancel(self.options(), async {
            let manager = self.manager();
            let snapshot = manager.loaded(self.options()).await?;
            match &snapshot.current {
                None => Ok(None),
                Some(current) if manager.is_fresh(current) => Ok(Some(current.session.clone())),
                Some(current) if snapshot.backing_off() && !current.remaining().is_zero() => {
                    Ok(Some(current.session.clone()))
                }
                Some(_) => self.refresh_since(snapshot.revision).await.map(Some),
            }
        })
        .await
    }

    /// The token for a session-mode request. A due but still valid token is
    /// sent while it rotates in the background; only an expired one waits.
    pub(crate) fn access_token(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let manager = self.manager();
            let snapshot = manager.loaded(self.options()).await?;
            let Some(current) = &snapshot.current else {
                return Ok(None);
            };
            if manager.is_fresh(current) {
                return Ok(Some(current.session.access_token.clone()));
            }
            if !current.remaining().is_zero() {
                // The rotation is detached and shared; this request need not wait.
                // After a transient failure it waits for Retry-After or a short backoff.
                if !snapshot.backing_off() {
                    drop(self.rotation(snapshot.revision));
                }
                return Ok(Some(current.session.access_token.clone()));
            }
            match self.refresh_since(snapshot.revision).await {
                Ok(session) => Ok(Some(session.access_token)),
                Err(error) => {
                    // Fall back only to an identity that is still valid (one
                    // published meanwhile); never send an expired token.
                    if error.code() != "invalid_grant"
                        && let Some(current) = manager.snapshot().current
                        && !current.remaining().is_zero()
                    {
                        return Ok(Some(current.session.access_token));
                    }
                    Err(error)
                }
            }
        })
    }

    pub async fn refresh_session(&self) -> Result<Session> {
        self.refresh_since(self.manager().snapshot().revision).await
    }

    /// Join the rotation that started from `observed`, or start it. Rotations
    /// are detached: cancelling waiters neither stops them nor leaves a task each.
    fn rotation(&self, observed: u64) -> Option<RefreshResult> {
        match self.manager().rotation(observed) {
            Rotation::Join(result) => Some(result),
            Rotation::Stale => None,
            Rotation::Start(sender, result) => {
                let mut auth = self.clone();
                // Shared by every waiter: the client's timeout applies, not the first caller's.
                auth.client.options = RequestOptions::default();
                let mut task = RotationTask {
                    auth,
                    sender: Some(sender),
                };
                tokio::spawn(async move {
                    let outcome = task.auth.rotate_from(observed).await;
                    if let Some(sender) = task.sender.take() {
                        sender.send_replace(Some(outcome));
                    }
                });
                Some(result)
            }
        }
    }

    async fn refresh_since(&self, mut observed: u64) -> Result<Session> {
        if self
            .options()
            .cancellation
            .as_ref()
            .is_some_and(|t| t.is_cancelled())
        {
            return Err(Error::Cancelled);
        }
        let manager = self.manager();
        let result = loop {
            if let Some(result) = self.rotation(observed) {
                break result;
            }
            // The session changed after it was observed.
            let snapshot = manager.snapshot();
            match &snapshot.current {
                None => return Err(Error::SessionMissing),
                Some(current) if manager.is_fresh(current) => {
                    return Ok(current.session.clone());
                }
                Some(_) => observed = snapshot.revision,
            }
        };
        crate::http::cancel(self.options(), outcome(result)).await
    }

    async fn rotate_from(&self, from: u64) -> Result<Session> {
        let manager = self.manager();
        let guard = manager.lock_detached().await;
        if let Err(error) = manager.load(&guard).await {
            manager.finish_rotation(&guard);
            return Err(error);
        }
        let snapshot = manager.snapshot();
        let Some(current) = snapshot.current else {
            manager.finish_rotation(&guard);
            return Err(Error::SessionMissing);
        };
        // Another publication won the lock first. A user update moves the
        // revision without rotating, so a due session still rotates.
        if snapshot.revision != from && manager.is_fresh(&current) {
            manager.finish_rotation(&guard);
            return Ok(current.session);
        }
        let body = json!({"refresh_token": current.session.refresh_token});
        match self.token("refresh_token", body).await {
            Ok(current) => {
                let session = current.session.clone();
                manager
                    .publish(&guard, Some(current), AuthEventKind::Refreshed)
                    .await
                    .map(|()| session)
            }
            Err(error) => {
                if error.code() == "invalid_grant" {
                    let _ = manager
                        .publish(&guard, None, AuthEventKind::SignedOut)
                        .await;
                } else {
                    let backoff = error.retry_after().unwrap_or(QUICK_RETRY);
                    manager.postpone_rotation(&guard, backoff);
                }
                Err(error)
            }
        }
    }

    /// Adopt a session from elsewhere (a cookie, another process). Its expiry
    /// is read from `expires_at` against this machine's clock.
    pub async fn set_session(&self, session: Session) -> Result<()> {
        session.validate()?;
        let manager = self.manager();
        let guard = manager.lock(self.options()).await?;
        manager
            .publish(
                &guard,
                Some(Current::restored(session)),
                AuthEventKind::SignedIn,
            )
            .await
    }

    async fn token(&self, grant: &str, body: Value) -> Result<Current> {
        let mut spec = Spec::new(Method::POST, "/auth/v1/token")
            .json(body)
            .unauthenticated();
        spec.params.push(("grant_type".into(), grant.into()));
        let response = self.client.json::<Session>(spec).await?;
        response.data.validate()?;
        Ok(Current::received(response.data))
    }

    /// Publish a session the server just issued and return it.
    async fn signed_in(&self, guard: &Guard<'_>, current: Current) -> Result<Session> {
        let session = current.session.clone();
        self.manager()
            .publish(guard, Some(current), AuthEventKind::SignedIn)
            .await?;
        Ok(session)
    }

    /// Create an account. While the email awaits confirmation the result has
    /// no session and carries [`SignUp::verifier`]: keep it with the person's
    /// pending sign-up and pass it to [`verify_signup_link`](Self::verify_signup_link)
    /// to keep the password chosen here. Confirming without it (or with a
    /// resent link) still signs in, but clears that password.
    pub async fn sign_up(
        &self,
        email: &str,
        password: &str,
        metadata: Option<Value>,
    ) -> Result<SignUp> {
        let (verifier, challenge) = oauth::pkce_pair()?;
        let mut body = json!({
            "email": address(email)?,
            "password": password,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        });
        if let Some(data) = metadata {
            if !data.is_object() {
                return Err(Error::Usage("signup metadata must be an object".into()));
            }
            body["data"] = data;
        }
        let guard = self.manager().lock(self.options()).await?;
        let response = self
            .client
            .json::<Value>(
                Spec::new(Method::POST, "/auth/v1/signup")
                    .json(body)
                    .unauthenticated(),
            )
            .await?;
        if response.data.get("access_token").is_some() {
            let session: Session = decode(response.data, response.status)?;
            session.validate()?;
            let session = self.signed_in(&guard, Current::received(session)).await?;
            return Ok(SignUp {
                user: session.user.clone(),
                session: Some(session),
                verifier: None,
            });
        }
        Ok(SignUp {
            user: decode(response.data["user"].clone(), response.status)?,
            session: None,
            verifier: Some(verifier),
        })
    }

    pub async fn sign_in_with_password(&self, email: &str, password: &str) -> Result<Session> {
        let body = json!({"email": address(email)?, "password": password});
        let guard = self.manager().lock(self.options()).await?;
        let current = self.token("password", body).await?;
        self.signed_in(&guard, current).await
    }

    /// Read the server's current user. Scoped clients use their explicit caller token.
    pub async fn get_user(&self) -> Result<User> {
        let (token, revision) = self.caller_token().await?;
        let user = self
            .client
            .json::<User>(Spec::new(Method::GET, "/auth/v1/user").token(&token))
            .await?
            .data;
        self.remember_user(&token, revision, &user).await?;
        Ok(user)
    }

    /// Change the signed-in user's password and/or `user_metadata`. A password
    /// change ends the user's other sessions; this one keeps working.
    pub async fn update_user(&self, update: UserUpdate) -> Result<User> {
        if update.password.is_none() && update.data.is_none() {
            return Err(Error::Usage("update_user needs password or data".into()));
        }
        if update.data.as_ref().is_some_and(|data| !data.is_object()) {
            return Err(Error::Usage("user data must be a JSON object".into()));
        }
        let mut body = serde_json::Map::new();
        if let Some(password) = update.password {
            body.insert("password".into(), password.into());
        }
        if let Some(current) = update.current_password {
            body.insert("current_password".into(), current.into());
        }
        if let Some(data) = update.data {
            body.insert("data".into(), data);
        }
        let (token, revision) = self.caller_token().await?;
        let user = self
            .client
            .json::<User>(
                Spec::new(Method::PUT, "/auth/v1/user")
                    .json(Value::Object(body))
                    .token(&token),
            )
            .await?
            .data;
        self.remember_user(&token, revision, &user).await?;
        Ok(user)
    }

    async fn caller_token(&self) -> Result<(String, u64)> {
        let manager = self.manager();
        match &self.client.token {
            TokenMode::Fixed(Some(token)) => Ok((token.clone(), manager.snapshot().revision)),
            TokenMode::Fixed(None) => Err(Error::SessionMissing),
            TokenMode::Invalid => Err(crate::invalid_token()),
            TokenMode::Session => {
                self.get_session().await?.ok_or(Error::SessionMissing)?;
                // The token and its revision come from one snapshot.
                let snapshot = manager.snapshot();
                let current = snapshot.current.ok_or(Error::SessionMissing)?;
                Ok((current.session.access_token, snapshot.revision))
            }
        }
    }

    /// Store a fresher user in the session the request was made with, unless
    /// the session rotated or changed meanwhile.
    async fn remember_user(&self, token: &str, revision: u64, user: &User) -> Result<()> {
        let manager = self.manager();
        let guard = manager.lock(self.options()).await?;
        let snapshot = manager.snapshot();
        if snapshot.revision != revision {
            return Ok(());
        }
        if let Some(current) = snapshot
            .current
            .filter(|c| c.session.access_token == token && c.session.user != *user)
        {
            manager
                .publish(
                    &guard,
                    Some(current.with_user(user.clone())),
                    AuthEventKind::UserUpdated,
                )
                .await?;
        }
        Ok(())
    }

    /// Serialize against refresh and clear locally even when server revocation
    /// fails or the stored session cannot be loaded. A session that could not
    /// be loaded is not revoked: the load error is returned after clearing.
    pub async fn sign_out(&self) -> Result<()> {
        let manager = self.manager();
        let guard = manager.lock_detached().await;
        let loaded = manager.load(&guard).await;
        let current = manager.snapshot().current;
        let result = async {
            let Some(current) = current else {
                return Ok(());
            };
            let left = current.remaining();
            let token = match left <= SIGN_OUT_SKEW {
                // Already under the lifecycle lock: do not recursively refresh.
                // The replacement only revokes itself; it is never published.
                true => match self
                    .token(
                        "refresh_token",
                        json!({"refresh_token": current.session.refresh_token}),
                    )
                    .await
                {
                    Ok(renewed) => renewed.session.access_token,
                    Err(error) if left.is_zero() => return Err(error),
                    Err(_) => current.session.access_token,
                },
                false => current.session.access_token,
            };
            self.client
                .bytes(Spec::new(Method::POST, "/auth/v1/logout").token(&token))
                .await
                .map(|_| ())
        }
        .await;
        let cleared = manager
            .publish(&guard, None, AuthEventKind::SignedOut)
            .await;
        loaded.and(result).and(cleared)
    }

    pub async fn request_password_reset(&self, email: &str) -> Result<()> {
        self.email("recover", json!({"email": address(email)?}))
            .await
    }
    pub async fn send_magic_link(&self, email: &str) -> Result<()> {
        self.email("magiclink", json!({"email": address(email)?}))
            .await
    }
    pub async fn resend_confirmation(&self, email: &str) -> Result<()> {
        self.email("resend", json!({"email": address(email)?, "type":"signup"}))
            .await
    }
    async fn email(&self, endpoint: &str, body: Value) -> Result<()> {
        self.client
            .bytes(
                Spec::new(Method::POST, format!("/auth/v1/{endpoint}"))
                    .json(body)
                    .unauthenticated(),
            )
            .await
            .map(|_| ())
    }
    pub async fn verify_email_link(&self, link: &EmailLink) -> Result<Session> {
        if link.kind == EmailLinkType::Recovery {
            return Err(Error::Usage("recovery links require reset_password".into()));
        }
        self.verify(json!({"type": link.kind.as_str(), "token": link.token}))
            .await
    }
    /// Confirm a sign-up with the [`SignUp::verifier`] its `sign_up` returned,
    /// keeping the password chosen at sign-up. Keep the verifier until this
    /// succeeds: a failed attempt (network, timeout) can be retried with it.
    pub async fn verify_signup_link(&self, link: &EmailLink, verifier: &str) -> Result<Session> {
        if link.kind != EmailLinkType::Signup {
            return Err(Error::Usage("verify_signup_link takes signup links".into()));
        }
        oauth::check_verifier(verifier)?;
        self.verify(json!({"type": "signup", "token": link.token, "code_verifier": verifier}))
            .await
    }
    pub async fn reset_password(&self, token: &str, password: &str) -> Result<Session> {
        self.verify(json!({"type":"recovery", "token": token, "password": password}))
            .await
    }
    async fn verify(&self, body: Value) -> Result<Session> {
        let guard = self.manager().lock(self.options()).await?;
        let session = self
            .client
            .json::<Session>(
                Spec::new(Method::POST, "/auth/v1/verify")
                    .json(body)
                    .unauthenticated(),
            )
            .await?
            .data;
        session.validate()?;
        self.signed_in(&guard, Current::received(session)).await
    }
}

/// A spawned rotation. If it ends without reporting (a panic, a runtime
/// shutting down), dropping it fails its waiters and lets the next caller
/// start over instead of joining a rotation that will never finish.
struct RotationTask {
    auth: AuthClient,
    sender: Option<watch::Sender<Option<Result<Session>>>>,
}
impl Drop for RotationTask {
    fn drop(&mut self) {
        if let Some(sender) = self.sender.take() {
            self.auth.manager().abandon_rotation();
            sender.send_replace(Some(Err(Error::Network("refresh task failed".into()))));
        }
    }
}

fn address(email: &str) -> Result<&str> {
    let email = email.trim();
    if email.is_empty() {
        return Err(Error::Usage("email is required".into()));
    }
    Ok(email)
}
fn decode<T: serde::de::DeserializeOwned>(value: Value, status: u16) -> Result<T> {
    serde_json::from_value(value).map_err(|e| Error::InvalidResponse {
        status,
        message: e.to_string(),
    })
}
