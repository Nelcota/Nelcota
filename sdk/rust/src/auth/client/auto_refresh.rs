//! Optional refresh task ownership; dropping the handle stops its timer.
use super::AuthClient;
use crate::{Client, TokenMode};
use std::{sync::Arc, time::Duration};
use tokio::sync::broadcast;

impl AuthClient {
    /// Opt-in background refresh. Drop/stop the handle to stop the timer.
    pub fn start_auto_refresh(&self) -> AutoRefresh {
        let weak = Arc::downgrade(&self.client.inner);
        let mut events = self.subscribe();
        let handle = tokio::spawn(async move {
            // The server takes an uncertain rotation's old token back only within 10 s,
            // so the first retry after a failure must land inside that window.
            let mut failures = 0u32;
            loop {
                let inner = match weak.upgrade() {
                    Some(inner) => inner,
                    _ => {
                        return;
                    }
                };
                let client = Client {
                    inner,
                    token: TokenMode::Session,
                    options: Default::default(),
                };
                let manager = &client.inner.auth;
                let mut state = manager.gate.lock().await;
                if manager.load(&mut state).await.is_err() {
                    drop(state);
                    drop(client);
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    continue;
                }
                let session = state.session.clone();
                drop(state);
                let delay = session
                    .map(|s| s.expires_in_now().saturating_sub(manager.margin_for(&s)))
                    .unwrap_or(Duration::from_secs(30));
                drop(client);
                tokio::select! {
                    _ = tokio::time::sleep(delay.max(Duration::from_secs(1))) => {
                        let inner = match weak.upgrade() { Some(inner) => inner, None => return };
                        let client = Client { inner, token: TokenMode::Session, options: Default::default() };
                        if client.auth().get_session().await.is_err() {
                            failures += 1;
                            tokio::time::sleep(Duration::from_secs(if failures == 1 { 2 } else { 10 })).await;
                        } else {
                            failures = 0;
                        }
                    }
                    result = events.recv() => { if matches!(result, Err(broadcast::error::RecvError::Closed)) { return; } }
                }
            }
        });
        AutoRefresh(handle)
    }
}

pub struct AutoRefresh(tokio::task::JoinHandle<()>);
impl AutoRefresh {
    pub fn stop(self) {
        self.0.abort();
    }
}
impl Drop for AutoRefresh {
    fn drop(&mut self) {
        self.0.abort();
    }
}
