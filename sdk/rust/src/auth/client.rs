//! One owner for HTTP/session transitions, refresh coordination and timer cleanup.
mod auto_refresh;
mod oauth;
pub use auto_refresh::AutoRefresh;

use super::manager::State;
use super::{
    AuthEvent, AuthEventKind, EmailLink, EmailLinkType, Session, SignUp, StorageFuture, User,
    UserUpdate,
};
use crate::{Client, Error, Result, TokenMode, http::Spec};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tokio::sync::{broadcast, watch};

#[derive(Clone, Debug)]
pub struct AuthClient {
    pub(crate) client: Client,
}

impl AuthClient {
    pub fn subscribe(&self) -> broadcast::Receiver<AuthEvent> {
        self.client.inner.auth.events.subscribe()
    }

    /// Cancellation may withdraw a queued request, before HTTP or session publication.
    async fn lock_state(&self) -> Result<tokio::sync::MutexGuard<'_, State>> {
        crate::http::cancel(&self.client.options, async {
            Ok(self.client.inner.auth.gate.lock().await)
        })
        .await
    }

    /// Current session, refreshed on demand. Explicit tokens do not change this session.
    pub async fn get_session(&self) -> Result<Option<Session>> {
        crate::http::cancel(&self.client.options, async {
            let manager = &self.client.inner.auth;
            let observed = manager.epoch.load(Ordering::Acquire);
            let mut state = manager.gate.lock().await;
            manager.load(&mut state).await?;
            match &state.session {
                None => Ok(None),
                Some(session) if session.expires_in_now() > manager.margin_for(session) => {
                    Ok(Some(session.clone()))
                }
                _ => {
                    drop(state);
                    self.refresh_since(observed).await.map(Some)
                }
            }
        })
        .await
    }

    pub(crate) fn access_token(&self) -> StorageFuture<'_, Option<String>> {
        Box::pin(async move {
            match self.get_session().await {
                Ok(session) => Ok(session.map(|s| s.access_token)),
                Err(error) => {
                    // A transient refresh failure still sends the previous identity, never anon.
                    let state = self.client.inner.auth.gate.lock().await;
                    if error.code() != "invalid_grant"
                        && let Some(session) = &state.session
                    {
                        return Ok(Some(session.access_token.clone()));
                    }
                    Err(error)
                }
            }
        })
    }

    pub async fn refresh_session(&self) -> Result<Session> {
        self.refresh_since(self.client.inner.auth.epoch.load(Ordering::Acquire))
            .await
    }

    async fn refresh_since(&self, observed: u64) -> Result<Session> {
        if self
            .client
            .options
            .cancellation
            .as_ref()
            .is_some_and(|t| t.is_cancelled())
        {
            return Err(Error::Cancelled);
        }
        // Keep one detached rotation, rather than one task waiting for the
        // lifecycle lock per caller. Cancelling waiters must not retain them.
        let mut receiver = {
            let manager = &self.client.inner.auth;
            let mut running = manager.refreshing.lock().unwrap_or_else(|e| e.into_inner());
            match running.as_ref().filter(|r| r.has_changed().is_ok()) {
                Some(receiver) => receiver.clone(),
                None => {
                    let (sender, receiver) = watch::channel(None);
                    *running = Some(receiver.clone());
                    let mut auth = self.clone();
                    // Once started, rotation continues when its waiters cancel.
                    auth.client.options.cancellation = None;
                    tokio::spawn(async move {
                        let result = auth.rotate_since(observed).await;
                        let manager = &auth.client.inner.auth;
                        let mut running =
                            manager.refreshing.lock().unwrap_or_else(|e| e.into_inner());
                        sender.send_replace(Some(result));
                        *running = None;
                    });
                    receiver
                }
            }
        };
        let wait = async move {
            loop {
                let result = receiver.borrow_and_update().clone();
                if let Some(result) = result {
                    return result;
                }
                if receiver.changed().await.is_err() {
                    return receiver
                        .borrow()
                        .clone()
                        .unwrap_or_else(|| Err(Error::Network("refresh task failed".into())));
                }
            }
        };
        if let Some(token) = &self.client.options.cancellation {
            return tokio::select! { biased; _ = token.cancelled() => Err(Error::Cancelled), result = wait => result };
        }
        wait.await
    }

    async fn rotate_since(&self, observed: u64) -> Result<Session> {
        let manager = &self.client.inner.auth;
        let mut state = manager.gate.lock().await;
        manager.load(&mut state).await?;
        if manager.epoch.load(Ordering::Acquire) != observed {
            if let Some(result) = &state.last_refresh {
                return result.clone();
            }
            return state.session.clone().ok_or(Error::SessionMissing);
        }
        let current = state.session.as_ref().ok_or(Error::SessionMissing)?;
        let result = self
            .token(
                "refresh_token",
                json!({"refresh_token": current.refresh_token}),
            )
            .await;
        let result = match result {
            Ok(session) => manager
                .save(&mut state, Some(session.clone()), AuthEventKind::Refreshed)
                .await
                .map(|()| session),
            Err(error) => {
                if error.code() == "invalid_grant" {
                    let _ = manager
                        .save(&mut state, None, AuthEventKind::SignedOut)
                        .await;
                }
                Err(error)
            }
        };
        manager.epoch.fetch_add(1, Ordering::Release);
        state.last_refresh = Some(result.clone());
        result
    }

    pub async fn set_session(&self, session: Session) -> Result<()> {
        session.validate()?;
        let manager = &self.client.inner.auth;
        let mut state = manager.gate.lock().await;
        manager
            .save(&mut state, Some(session), AuthEventKind::SignedIn)
            .await
    }

    async fn token(&self, grant: &str, body: Value) -> Result<Session> {
        let mut spec = Spec::new(Method::POST, "/auth/v1/token")
            .json(body)
            .unauthenticated();
        spec.params.push(("grant_type".into(), grant.into()));
        let response = self.client.json::<Session>(spec).await?;
        response.data.validate()?;
        Ok(response.data)
    }

    pub async fn sign_up(
        &self,
        email: &str,
        password: &str,
        metadata: Option<Value>,
    ) -> Result<SignUp> {
        let mut body = json!({"email": address(email)?, "password": password});
        if let Some(data) = metadata {
            if !data.is_object() {
                return Err(Error::Usage("signup metadata must be an object".into()));
            }
            body["data"] = data;
        }
        let manager = &self.client.inner.auth;
        let mut state = self.lock_state().await?;
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
            manager
                .save(&mut state, Some(session.clone()), AuthEventKind::SignedIn)
                .await?;
            return Ok(SignUp {
                user: session.user.clone(),
                session: Some(session),
            });
        }
        Ok(SignUp {
            user: decode(response.data["user"].clone(), response.status)?,
            session: None,
        })
    }

    pub async fn sign_in_with_password(&self, email: &str, password: &str) -> Result<Session> {
        let body = json!({"email": address(email)?, "password": password});
        let manager = &self.client.inner.auth;
        let mut state = self.lock_state().await?;
        let session = self.token("password", body).await?;
        manager
            .save(&mut state, Some(session.clone()), AuthEventKind::SignedIn)
            .await?;
        Ok(session)
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
        let manager = &self.client.inner.auth;
        match &self.client.token {
            TokenMode::Fixed(Some(token)) => {
                Ok((token.clone(), manager.epoch.load(Ordering::Acquire)))
            }
            TokenMode::Fixed(None) => Err(Error::SessionMissing),
            TokenMode::Session => {
                self.get_session().await?.ok_or(Error::SessionMissing)?;
                // Capture the token and publication epoch from one locked state.
                let state = self.lock_state().await?;
                let token = state
                    .session
                    .as_ref()
                    .ok_or(Error::SessionMissing)?
                    .access_token
                    .clone();
                Ok((token, manager.epoch.load(Ordering::Acquire)))
            }
        }
    }

    /// Store a fresher user in the session the request was made with, unless
    /// the session rotated or changed meanwhile.
    async fn remember_user(&self, token: &str, revision: u64, user: &User) -> Result<()> {
        let manager = &self.client.inner.auth;
        let mut state = manager.gate.lock().await;
        if manager.epoch.load(Ordering::Acquire) != revision {
            return Ok(());
        }
        if let Some(session) = state
            .session
            .as_ref()
            .filter(|s| s.access_token == token && s.user != *user)
        {
            let mut session = session.clone();
            session.user = user.clone();
            manager
                .save(&mut state, Some(session), AuthEventKind::UserUpdated)
                .await?;
        }
        Ok(())
    }

    /// Serialize against refresh and clear locally even when server revocation fails.
    pub async fn sign_out(&self) -> Result<()> {
        let manager = &self.client.inner.auth;
        let mut state = manager.gate.lock().await;
        manager.load(&mut state).await?;
        let result = match &state.session {
            Some(session) => self
                .client
                .bytes(Spec::new(Method::POST, "/auth/v1/logout").token(&session.access_token))
                .await
                .map(|_| ()),
            None => Ok(()),
        };
        let cleared = manager
            .save(&mut state, None, AuthEventKind::SignedOut)
            .await;
        result.and(cleared)
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
    pub async fn reset_password(&self, token: &str, password: &str) -> Result<Session> {
        self.verify(json!({"type":"recovery", "token": token, "password": password}))
            .await
    }
    async fn verify(&self, body: Value) -> Result<Session> {
        let manager = &self.client.inner.auth;
        let mut state = self.lock_state().await?;
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
        manager
            .save(&mut state, Some(session.clone()), AuthEventKind::SignedIn)
            .await?;
        Ok(session)
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
