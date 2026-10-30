//! Optional refresh task ownership; dropping the handle stops its timer.
use super::AuthClient;
use crate::{Client, Error, RequestOptions, Result};
use std::{sync::Arc, time::Duration};
use tokio::sync::broadcast;

/// Upper bound for the pause while a session keeps looking due right after
/// a successful refresh (a very short token lifetime, a misbehaving server).
const MAX_DUE_BACKOFF: Duration = Duration::from_secs(60);

impl AuthClient {
    /// Opt-in background refresh. Keep the handle: dropping it stops the timer.
    ///
    /// # Panics
    ///
    /// Outside a Tokio runtime. [`try_start_auto_refresh`](Self::try_start_auto_refresh)
    /// returns an error instead.
    #[must_use = "dropping the AutoRefresh handle stops background refresh"]
    pub fn start_auto_refresh(&self) -> AutoRefresh {
        self.try_start_auto_refresh()
            .expect("start_auto_refresh must be called inside a Tokio runtime")
    }

    /// Opt-in background refresh on the current Tokio runtime. Keep the
    /// handle: dropping it stops the timer.
    #[must_use = "dropping the AutoRefresh handle stops background refresh"]
    pub fn try_start_auto_refresh(&self) -> Result<AutoRefresh> {
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| Error::Usage("auto refresh requires a Tokio runtime".into()))?;
        let weak = Arc::downgrade(&self.client.inner);
        let mut events = self.subscribe();
        let handle = runtime.spawn(async move {
            // The server takes an uncertain rotation's old token back only within 10 s,
            // so the first retry after a failure must land inside that window.
            let mut failures = 0u32;
            // Consecutive wake-ups that found the session due already.
            let mut due = 0u32;
            loop {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let auth = Client::shared_session(inner).auth();
                let manager = auth.manager();
                let delay = match manager.loaded(&RequestOptions::default()).await {
                    Ok(snapshot) => snapshot
                        .current
                        .map(|current| manager.due_in(&current))
                        .unwrap_or(Duration::from_secs(30)),
                    Err(_) => Duration::from_secs(10),
                };
                drop(auth);
                // A session that stays due does not spin once a second.
                let floor = Duration::from_secs(1 << due.min(6)).min(MAX_DUE_BACKOFF);
                due = match delay <= floor {
                    true => due.saturating_add(1),
                    false => 0,
                };
                tokio::select! {
                    _ = tokio::time::sleep(delay.max(floor)) => {
                        let Some(inner) = weak.upgrade() else { return };
                        if Client::shared_session(inner).auth().get_session().await.is_err() {
                            failures += 1;
                            tokio::time::sleep(Duration::from_secs(if failures == 1 { 2 } else { 10 })).await;
                        } else {
                            failures = 0;
                        }
                    }
                    result = events.recv() => {
                        if matches!(result, Err(broadcast::error::RecvError::Closed)) {
                            return;
                        }
                    }
                }
            }
        });
        Ok(AutoRefresh(handle))
    }
}

/// The background refresh task. Dropping it, or calling [`stop`](Self::stop),
/// stops the timer.
#[must_use = "dropping the AutoRefresh handle stops background refresh"]
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
