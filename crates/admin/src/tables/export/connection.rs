//! Dedicated export connections with bounded admission and response lifetime.
use crate::ApiError;
use axum::http::StatusCode;
use futures_util::{Stream, task::AtomicWaker};
use std::{
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{Semaphore, oneshot};
use tokio::time::Instant;
use tokio_postgres::{Client, NoTls, Row, RowStream};

const MAX_LIFETIME: Duration = Duration::from_secs(120);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(35);
const RUNNING: u8 = 0;
const COMPLETED: u8 = 1;
const INTERRUPTED: u8 = 2;

/// Completion and cancellation choose one terminal state. The deadline check
/// also holds when the runtime has not scheduled its watchdog yet.
struct Completion {
    state: AtomicU8,
    deadline: Instant,
}

impl Completion {
    fn complete(&self) -> bool {
        if Instant::now() >= self.deadline {
            self.interrupt();
            return false;
        }
        self.state
            .compare_exchange(RUNNING, COMPLETED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn interrupt(&self) -> bool {
        let previous = self
            .state
            .compare_exchange(RUNNING, INTERRUPTED, Ordering::AcqRel, Ordering::Acquire)
            .unwrap_or_else(|state| state);
        previous != COMPLETED
    }
}

/// Shared by all panel sessions, independently of the ordinary admin pool.
pub struct ExportExecutor {
    slots: Arc<Semaphore>,
    lifetime: Duration,
}

impl Default for ExportExecutor {
    fn default() -> Self {
        Self::new(MAX_LIFETIME)
    }
}

impl ExportExecutor {
    /// Sets a shorter response budget, bounded to one millisecond through two minutes.
    pub fn new(lifetime: Duration) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
            lifetime: lifetime.clamp(Duration::from_millis(1), MAX_LIFETIME),
        }
    }

    pub(crate) async fn connect(
        &self,
        config: &tokio_postgres::Config,
    ) -> Result<(Arc<Client>, ExportConnection), ApiError> {
        let slot = self.slots.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "export_busy",
                "Table exports are busy; try again after a download finishes",
            )
        })?;
        let mut config = config.clone();
        config
            .application_name("nelcota-admin-export")
            .options("-c statement_timeout=30s");
        let (client, connection) =
            tokio::time::timeout(Duration::from_secs(5), config.connect(NoTls))
                .await
                .map_err(|_| {
                    ApiError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "unavailable",
                        "database unavailable",
                    )
                })??;
        let cancel = client.cancel_token();
        let client = Arc::new(client);
        let cleanup_client = client.clone();
        let (done, mut finished) = oneshot::channel();
        let completion = Arc::new(Completion {
            state: AtomicU8::new(RUNNING),
            deadline: Instant::now() + self.lifetime,
        });
        let stopped = completion.clone();
        let rows = Arc::new(ResponseRows::default());
        let cleanup_rows = rows.clone();
        tokio::spawn(async move {
            // Keep admission occupied through cancellation, so abandoned queries
            // cannot accumulate while new exports are accepted.
            let _slot = slot;
            tokio::pin!(connection);
            let mut connection_result = None;
            let cancel_query = tokio::select! {
                result = &mut connection => {
                    connection_result = Some(result.is_ok());
                    match result {
                        Ok(()) => response_interrupted(&mut finished, &stopped).await,
                        Err(_) => {
                            stopped.interrupt();
                            true
                        }
                    }
                }
                interrupted = response_interrupted(&mut finished, &stopped) => interrupted,
            };
            // Preserve the response lifetime boundary even when PostgreSQL has
            // already buffered every row of a small, unpolled export.
            // Close the response channel before draining PostgreSQL. An
            // unpolled RowStream otherwise backpressures the driver indefinitely.
            cleanup_rows.close();
            drop(cleanup_client);
            if !cancel_query || connection_result == Some(true) {
                return;
            }
            let deadline = Instant::now() + CLEANUP_TIMEOUT;
            // CancelRequest acknowledges only its network write. Preserve the
            // driver until PostgreSQL has drained the abandoned query.
            let _ = tokio::time::timeout(Duration::from_secs(2), cancel.cancel_query(NoTls)).await;
            let confirmed = match connection_result {
                Some(_) => false,
                None => matches!(
                    tokio::time::timeout_at(deadline, &mut connection).await,
                    Ok(Ok(()))
                ),
            };
            if !confirmed {
                tracing::warn!("Export cancellation cleanup was not confirmed");
                tokio::time::sleep_until(deadline).await;
            }
        });
        Ok((
            client,
            ExportConnection {
                done: Some(done),
                completion,
                rows,
            },
        ))
    }
}

async fn response_interrupted(
    finished: &mut oneshot::Receiver<bool>,
    completion: &Completion,
) -> bool {
    tokio::select! {
        completed = finished => completed != Ok(true),
        _ = tokio::time::sleep_until(completion.deadline) => completion.interrupt(),
    }
}

pub(crate) struct ExportConnection {
    done: Option<oneshot::Sender<bool>>,
    completion: Arc<Completion>,
    rows: Arc<ResponseRows>,
}

impl ExportConnection {
    pub fn rows(&self, rows: RowStream) -> ExportRows {
        let mut state = self.rows.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.closed {
            state.rows = Some(Box::pin(rows));
        }
        ExportRows(self.rows.clone())
    }

    pub fn finish(mut self) -> std::io::Result<()> {
        if !self.completion.complete() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "export interrupted or timed out",
            ));
        }
        if let Some(done) = self.done.take() {
            let _ = done.send(true);
        }
        Ok(())
    }
}

#[derive(Default)]
struct ResponseRows {
    state: Mutex<RowsState>,
    waker: AtomicWaker,
}

#[derive(Default)]
struct RowsState {
    closed: bool,
    rows: Option<Pin<Box<RowStream>>>,
}

impl ResponseRows {
    fn close(&self) {
        let rows = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            state.rows.take()
        };
        drop(rows);
        self.waker.wake();
    }
}

pub(crate) struct ExportRows(Arc<ResponseRows>);

impl Stream for ExportRows {
    type Item = Result<Row, tokio_postgres::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // Register before checking the state so deadline closure cannot lose
        // the wakeup of a response already waiting for its next row.
        self.0.waker.register(cx.waker());
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let rows = match state.rows.as_mut() {
            Some(rows) => rows,
            None => return Poll::Ready(None),
        };
        let result = rows.as_mut().poll_next(cx);
        if matches!(result, Poll::Ready(None)) {
            state.rows = None;
        }
        result
    }
}

impl Drop for ExportConnection {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            self.completion.interrupt();
            let _ = done.send(false);
        }
    }
}
