//! Shared lifecycle state, persistence and publication receipts.
use super::{AuthEvent, AuthEventKind, Session, SessionStorage};
use crate::Result;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, broadcast, watch};

#[derive(Default)]
pub(super) struct State {
    pub(super) loaded: bool,
    pub(super) session: Option<Session>,
    pub(super) last_refresh: Option<Result<Session>>,
}
pub(super) type RefreshReceiver = watch::Receiver<Option<Result<Session>>>;
pub(crate) struct Manager {
    pub(super) gate: Mutex<State>,
    pub(super) refreshing: std::sync::Mutex<Option<RefreshReceiver>>,
    pub(super) epoch: AtomicU64,
    pub(super) storage: Arc<dyn SessionStorage>,
    pub(super) margin: Duration,
    pub(super) events: broadcast::Sender<AuthEvent>,
}
impl Manager {
    pub(crate) fn new(storage: Arc<dyn SessionStorage>, margin: Duration) -> Self {
        Self {
            gate: Mutex::new(State::default()),
            refreshing: std::sync::Mutex::new(None),
            epoch: AtomicU64::new(0),
            storage,
            margin,
            events: broadcast::channel(32).0,
        }
    }
    pub(super) fn margin_for(&self, session: &Session) -> Duration {
        self.margin.min(Duration::from_secs(session.expires_in) / 2)
    }
    pub(super) async fn load(&self, state: &mut State) -> Result<()> {
        if state.loaded {
            return Ok(());
        }
        let session = self.storage.load().await?;
        if let Some(session) = &session {
            session.validate()?;
        }
        state.session = session;
        state.loaded = true;
        Ok(())
    }
    pub(super) async fn save(
        &self,
        state: &mut State,
        session: Option<Session>,
        event: AuthEventKind,
    ) -> Result<()> {
        // Keep a rotated token even if external persistence fails. Never reuse its predecessor.
        state.session = session;
        state.loaded = true;
        state.last_refresh = None;
        self.epoch.fetch_add(1, Ordering::Release);
        let result = self.storage.save(state.session.as_ref()).await;
        let _ = self.events.send(AuthEvent {
            kind: event,
            session: state.session.clone(),
        });
        result
    }
}
