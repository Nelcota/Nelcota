//! Dedicated SQL execution, result budgets and cancellation.
use crate::contracts::{SqlError, SqlResponse, SqlResult};
use futures_util::{StreamExt, pin_mut};
use nelcota_core::Claims;
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::{NoTls, SimpleQueryMessage};

const MAX_ROWS: usize = 1000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULTS: usize = 32;
// The dedicated connection has a thirty-second statement timeout. Retain
// admission through its cleanup, including five seconds for a lost transport.
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(35);

/// Shared by every request. Dedicated connections never contaminate a pool.
pub struct SqlExecutor {
    slots: Arc<Semaphore>,
}
impl Default for SqlExecutor {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
        }
    }
}
struct Results {
    results: Vec<SqlResult>,
    results_truncated: bool,
    current: SqlResult,
    bytes: usize,
}
impl Results {
    fn new() -> Self {
        Self {
            results: Vec::new(),
            results_truncated: false,
            current: SqlResult::default(),
            bytes: 0,
        }
    }
    fn message(&mut self, message: SimpleQueryMessage) {
        let retain = self.results.len() < MAX_RESULTS;
        match message {
            SimpleQueryMessage::RowDescription(columns) if retain => {
                self.current.columns = columns.iter().map(|c| c.name().to_owned()).collect();
                self.bytes += self.current.columns.iter().map(|c| c.len()).sum::<usize>();
            }
            SimpleQueryMessage::Row(row) if retain => {
                let bytes = (0..row.len())
                    .map(|i| row.get(i).map_or(4, |v| v.len() + 8))
                    .sum::<usize>();
                match self.current.rows.len() < MAX_ROWS
                    && self.bytes.saturating_add(bytes) <= MAX_BYTES
                {
                    true => {
                        self.bytes += bytes;
                        self.current.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map(str::to_owned))
                                .collect(),
                        );
                    }
                    false => {
                        self.current.truncated = true;
                    }
                }
            }
            SimpleQueryMessage::CommandComplete(count) => match retain {
                true => {
                    self.current.count = count;
                    self.results.push(std::mem::take(&mut self.current));
                }
                false => {
                    self.results_truncated = true;
                }
            },
            _ => {}
        }
    }
}
/// Dropping the HTTP future also closes its dedicated database connection.
struct Driver {
    task: Option<tokio::task::JoinHandle<Result<(), tokio_postgres::Error>>>,
    cancel: tokio_postgres::CancelToken,
    runtime: tokio::runtime::Handle,
    slot: Option<OwnedSemaphorePermit>,
    completed: bool,
}
impl Drop for Driver {
    fn drop(&mut self) {
        let mut task = match self.task.take() {
            Some(task) => task,
            None => return,
        };
        if self.completed {
            task.abort();
            return;
        }
        let cancel = self.cancel.clone();
        let slot = self.slot.take();
        self.runtime.spawn(async move {
            let _slot = slot;
            let deadline = tokio::time::Instant::now() + CLEANUP_TIMEOUT;
            // A successful cancel write does not acknowledge that PostgreSQL
            // stopped the query. Keep the driver alive to drain its response.
            let _ = tokio::time::timeout(Duration::from_secs(2), cancel.cancel_query(NoTls)).await;
            let confirmed = match tokio::time::timeout_at(deadline, &mut task).await {
                Ok(Ok(Ok(()))) => true,
                Ok(_) => false,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    false
                }
            };
            if !confirmed {
                // A disconnected transport cannot establish that server work
                // ended. Preserve the bounded statement-timeout grace before
                // admitting replacement work; no query or credential is logged.
                tracing::warn!("SQL cancellation cleanup was not confirmed");
                tokio::time::sleep_until(deadline).await;
            }
        });
    }
}

/// All execution slots are occupied. HTTP adapters choose how to report it.
#[derive(Debug)]
pub struct SqlBusy;

impl SqlExecutor {
    pub async fn execute(
        &self,
        config: &tokio_postgres::Config,
        sql: &str,
        claims: Option<&Claims>,
    ) -> Result<SqlResponse, SqlBusy> {
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| SqlBusy)?;
        let role = claims.map_or("owner", |claims| claims.role().as_str());
        tracing::info!(bytes = sql.len(), role, "panel SQL editor run");
        let mut config = config.clone();
        config
            .application_name("nelcota-admin-sql")
            .connect_timeout(Duration::from_secs(5))
            .options("-c statement_timeout=30s");
        let (client, connection) =
            match tokio::time::timeout(Duration::from_secs(5), config.connect(NoTls)).await {
                Ok(Ok(connection)) => connection,
                Ok(Err(err)) => return Ok(query_error(err)),
                Err(_) => {
                    return Ok(SqlResponse::Failure {
                        error: SqlError {
                            message: "database connection timed out".to_owned(),
                            code: None,
                            detail: None,
                            hint: None,
                            position: None,
                        },
                    });
                }
            };
        let mut driver = Driver {
            task: Some(tokio::spawn(connection)),
            cancel: client.cancel_token(),
            runtime: tokio::runtime::Handle::current(),
            slot: Some(slot),
            completed: false,
        };
        // The connection is this run's alone, so session settings are enough:
        // the same role and claims the API sets for a request (D94).
        if let Some(claims) = claims
            && let Err(err) = client
                .execute(
                    "SELECT set_config('role', $1, false), set_config('request.jwt.claims', $2, false)",
                    &[&claims.role().as_str(), &claims.as_json()],
                )
                .await
        {
            driver.completed = true;
            return Ok(query_error(err));
        }
        let stream = match client.simple_query_raw(sql).await {
            Ok(stream) => stream,
            Err(err) => {
                driver.completed = true;
                return Ok(query_error(err));
            }
        };
        pin_mut!(stream);
        let mut results = Results::new();
        // Drain even after the display budget is spent: batches must still run
        // every statement and retain their transaction semantics.
        while let Some(message) = stream.next().await {
            match message {
                Ok(message) => results.message(message),
                Err(err) => {
                    driver.completed = true;
                    return Ok(query_error(err));
                }
            }
        }
        driver.completed = true;
        Ok(SqlResponse::Success {
            results: results.results,
            results_truncated: results.results_truncated,
        })
    }
}

fn query_error(err: tokio_postgres::Error) -> SqlResponse {
    let error = match err.as_db_error() {
        Some(db) => SqlError {
            message: db.message().to_owned(),
            code: Some(db.code().code().to_owned()),
            detail: db.detail().map(str::to_owned),
            hint: db.hint().map(str::to_owned),
            position: match db.position() {
                Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            },
        },
        None => SqlError {
            message: err.to_string(),
            code: None,
            detail: None,
            hint: None,
            position: None,
        },
    };
    SqlResponse::Failure { error }
}
