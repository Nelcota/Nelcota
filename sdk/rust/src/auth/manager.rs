//! Shared lifecycle state: one mutation lock, one published snapshot.
//!
//! Readers never take the lock: they read the latest [`Snapshot`] from a watch
//! channel. Sign-in, rotation, user updates and sign-out serialize on the lock,
//! persist, then publish a new snapshot.
use super::{AuthEvent, AuthEventKind, Session, SessionStorage};
use crate::{Error, RequestOptions, Result};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, MutexGuard, broadcast, watch};

/// Proof that the caller holds the mutation lock.
pub(super) type Guard<'a> = MutexGuard<'a, ()>;
/// The outcome of one shared rotation, `None` while it runs.
pub(super) type RefreshResult = watch::Receiver<Option<Result<Session>>>;

/// Long enough never to arrive, short enough that `Instant` arithmetic cannot
/// overflow on any platform (Tokio uses the same horizon for "never").
const FAR_FUTURE: Duration = Duration::from_secs(30 * 365 * 24 * 60 * 60);

/// `Instant::now() + after`, saturating: an absurd `expires_in`, `expires_at`
/// or `Retry-After` from a server, a store or a caller must not panic.
fn deadline_after(after: Duration) -> Instant {
    Instant::now() + after.min(FAR_FUTURE)
}

/// A session with its expiry on the local monotonic clock.
#[derive(Clone)]
pub(super) struct Current {
    pub(super) session: Session,
    deadline: Instant,
}
impl Current {
    /// A session the server just issued: its lifetime starts now, whatever
    /// the server's and this machine's wall clocks say.
    pub(super) fn received(mut session: Session) -> Self {
        // Persist a local-clock expiry so a restored copy keeps this
        // reading rather than the server's clock.
        session.expires_at = super::models::now().saturating_add(session.expires_in);
        Self {
            deadline: deadline_after(Duration::from_secs(session.expires_in)),
            session,
        }
    }
    /// A stored or caller-provided session: only its absolute expiry is known.
    pub(super) fn restored(session: Session) -> Self {
        Self {
            deadline: deadline_after(session.expires_in_now()),
            session,
        }
    }
    /// The same tokens and expiry with a fresher user profile.
    pub(super) fn with_user(mut self, user: super::User) -> Self {
        self.session.user = user;
        self
    }
    pub(super) fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

/// One rotation, keyed by the snapshot revision it started from. Callers that
/// observed that revision share its result, even after it has finished.
#[derive(Clone)]
pub(super) struct Refresh {
    pub(super) from: u64,
    pub(super) result: RefreshResult,
}

#[derive(Clone, Default)]
pub(super) struct Snapshot {
    pub(super) loaded: bool,
    pub(super) current: Option<Current>,
    /// Moves on every publication and every finished rotation.
    pub(super) revision: u64,
    pub(super) refresh: Option<Refresh>,
    /// After a transient rotation failure, a still-valid token is used
    /// without starting another rotation until this instant.
    retry_at: Option<Instant>,
}
impl Snapshot {
    /// A failed rotation's backoff has not elapsed yet.
    pub(super) fn backing_off(&self) -> bool {
        !self.retry_in().is_zero()
    }
    /// What is left of a failed rotation's backoff (zero when none is running).
    pub(super) fn retry_in(&self) -> Duration {
        self.retry_at.map_or(Duration::ZERO, |at| {
            at.saturating_duration_since(Instant::now())
        })
    }
}

/// What a caller asking for a rotation should do.
pub(super) enum Rotation {
    /// Wait for this rotation's result.
    Join(RefreshResult),
    /// A new rotation from this revision: the caller spawns it, then waits.
    Start(watch::Sender<Option<Result<Session>>>, RefreshResult),
    /// The session changed since it was observed; re-read the snapshot.
    Stale,
}

pub(crate) struct Manager {
    lock: Mutex<()>,
    state: watch::Sender<Snapshot>,
    storage: Arc<dyn SessionStorage>,
    margin: Duration,
    events: broadcast::Sender<AuthEvent>,
}
impl Manager {
    pub(crate) fn new(storage: Arc<dyn SessionStorage>, margin: Duration) -> Self {
        Self {
            lock: Mutex::new(()),
            state: watch::channel(Snapshot::default()).0,
            storage,
            margin,
            events: broadcast::channel(32).0,
        }
    }
    pub(super) fn subscribe(&self) -> broadcast::Receiver<AuthEvent> {
        self.events.subscribe()
    }
    pub(super) fn snapshot(&self) -> Snapshot {
        self.state.borrow().clone()
    }
    /// The configured margin, capped at half the token lifetime.
    pub(super) fn margin_for(&self, session: &Session) -> Duration {
        self.margin.min(Duration::from_secs(session.expires_in) / 2)
    }
    /// Valid beyond the refresh margin.
    pub(super) fn is_fresh(&self, current: &Current) -> bool {
        current.remaining() > self.margin_for(&current.session)
    }
    /// Time until the session becomes due for rotation.
    pub(super) fn due_in(&self, current: &Current) -> Duration {
        current
            .remaining()
            .saturating_sub(self.margin_for(&current.session))
    }

    /// Cancellation may withdraw a queued caller before it changes anything.
    pub(super) async fn lock(&self, options: &RequestOptions) -> Result<Guard<'_>> {
        crate::http::cancel(options, async { Ok(self.lock.lock().await) }).await
    }
    pub(super) async fn lock_detached(&self) -> Guard<'_> {
        self.lock.lock().await
    }

    /// The published snapshot, loading the stored session the first time.
    pub(super) async fn loaded(&self, options: &RequestOptions) -> Result<Snapshot> {
        let snapshot = self.snapshot();
        if snapshot.loaded {
            return Ok(snapshot);
        }
        let guard = self.lock(options).await?;
        self.load(&guard).await?;
        Ok(self.snapshot())
    }

    /// An invalid stored session counts as signed out: it is announced,
    /// removed on a best-effort basis, and never retried. Any other storage
    /// error is returned and leaves the store untouched; the next caller
    /// loads again.
    pub(super) async fn load(&self, _guard: &Guard<'_>) -> Result<()> {
        if self.state.borrow().loaded {
            return Ok(());
        }
        let loaded = match self.storage.load().await {
            Ok(Some(session)) => session.validate().map(|()| Some(session)),
            Ok(None) => Ok(None),
            Err(error @ Error::SessionInvalid(_)) => Err(error),
            // A sharing violation or permission error says nothing about the
            // stored session: keep it for the next attempt.
            Err(error) => return Err(error),
        };
        let current = match loaded {
            Ok(session) => session.map(Current::restored),
            Err(_) => {
                let _ = self.storage.save(None).await;
                let _ = self.events.send(AuthEvent {
                    kind: AuthEventKind::SignedOut,
                    session: None,
                });
                None
            }
        };
        // Loading does not move the revision: nothing was observed before it.
        self.state.send_modify(|state| {
            state.loaded = true;
            state.current = current;
        });
        Ok(())
    }

    /// Publish then persist. A rotated token is kept even when external
    /// persistence fails: its predecessor is never reused.
    pub(super) async fn publish(
        &self,
        _guard: &Guard<'_>,
        current: Option<Current>,
        event: AuthEventKind,
    ) -> Result<()> {
        let session = current.as_ref().map(|c| c.session.clone());
        self.state.send_modify(|state| {
            state.loaded = true;
            state.current = current;
            state.revision += 1;
            state.retry_at = None;
        });
        let result = self.storage.save(session.as_ref()).await;
        let _ = self.events.send(AuthEvent {
            kind: event,
            session,
        });
        result
    }

    /// Mark a rotation finished without publishing a session (failure, or
    /// nothing to rotate), so later callers start their own.
    pub(super) fn finish_rotation(&self, _guard: &Guard<'_>) {
        self.state.send_modify(|state| state.revision += 1);
    }

    /// Finish a rotation that failed transiently: requests keep a still-valid
    /// token and do not start another rotation for `backoff`.
    pub(super) fn postpone_rotation(&self, _guard: &Guard<'_>, backoff: Duration) {
        self.state.send_modify(|state| {
            state.revision += 1;
            state.retry_at = Some(deadline_after(backoff));
        });
    }

    /// Finish a rotation whose task ended without reporting (a panic, a runtime
    /// shutting down). It cannot wait for the lock; moving the revision only
    /// makes later callers start their own rotation.
    pub(super) fn abandon_rotation(&self) {
        self.state.send_modify(|state| state.revision += 1);
    }

    /// Decide atomically whether `observed` joins, starts or missed a rotation.
    pub(super) fn rotation(&self, observed: u64) -> Rotation {
        let mut decision = Rotation::Stale;
        self.state.send_if_modified(|state| {
            if let Some(refresh) = state.refresh.as_ref().filter(|r| r.from == observed) {
                decision = Rotation::Join(refresh.result.clone());
                return false;
            }
            if state.revision != observed {
                return false;
            }
            let (sender, result) = watch::channel(None);
            state.refresh = Some(Refresh {
                from: observed,
                result: result.clone(),
            });
            decision = Rotation::Start(sender, result);
            // Readers do not wait on rotation bookkeeping.
            false
        });
        decision
    }
}

/// Wait for a shared rotation's result; a vanished rotation is an error.
pub(super) async fn outcome(mut result: RefreshResult) -> Result<Session> {
    loop {
        if let Some(outcome) = result.borrow_and_update().clone() {
            return outcome;
        }
        if result.changed().await.is_err() {
            return result
                .borrow()
                .clone()
                .unwrap_or_else(|| Err(Error::Network("refresh task failed".into())));
        }
    }
}
