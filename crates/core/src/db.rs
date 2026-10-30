//! Postgres access.
//!
//! - [`bootstrap`]: applies the internal migrations and sets the
//!   `authenticator` role password (admin connection, used only at startup).
//! - [`api_pool`]: the API pool, always connected as `authenticator`.
//! - [`begin_request`]: opens a request transaction already carrying the JWT
//!   role and claims. It is the only way to run SQL on behalf of a user.
//! - [`RequestConnection`]: holds a pooled connection for one request and
//!   cancels its statement when the request is dropped midway.

use std::time::Duration;

use deadpool_postgres::{
    Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime, Transaction,
};
use tokio_postgres::{CancelToken, NoTls};

use crate::Claims;

mod bootstrap;
pub use bootstrap::{
    AUTH_MIGRATION_VERSIONS, BootstrapError, MIGRATIONS_TABLE, bootstrap, bootstrap_migrations,
};

/// Connection config as `authenticator` (same host/database as the admin URL).
pub fn authenticator_config(
    admin: &tokio_postgres::Config,
    authenticator_password: &str,
) -> tokio_postgres::Config {
    let mut config = admin.clone();
    config
        .user("authenticator")
        .password(authenticator_password)
        .application_name("nelcota");
    config
}

/// API pool: same host/database as the admin URL, but as `authenticator`.
pub fn api_pool(
    admin: &tokio_postgres::Config,
    authenticator_password: &str,
    max_size: usize,
) -> Pool {
    let config = authenticator_config(admin, authenticator_password);
    // Cancellation can land after BEGIN was sent but before its transaction
    // guard exists. Drain pending work and roll back before lending it again.
    let manager = Manager::from_config(
        config,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Custom("ROLLBACK".into()),
        },
    );
    Pool::builder(manager)
        .max_size(max_size)
        .runtime(Runtime::Tokio1)
        .wait_timeout(Some(Duration::from_secs(5)))
        .create_timeout(Some(Duration::from_secs(5)))
        .recycle_timeout(Some(Duration::from_secs(5)))
        .build()
        .expect("runtime is set, build cannot fail")
}

/// How long a dropped request may take to deliver its cancel request.
const CANCEL_TIMEOUT: Duration = Duration::from_secs(2);
/// How long the cancelled statement and the `ROLLBACK` after it may take
/// before the connection is discarded instead of returned to the pool.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// A pooled API connection held for one request.
///
/// When the request future is dropped before [`finish`](Self::finish) (the
/// client disconnected, the request timeout fired), a statement may still be
/// running in Postgres, which does not notice on its own and would keep the
/// connection busy until `statement_timeout`. Dropping this guard then sends
/// Postgres a cancel request and, on a background task, waits for the
/// cancelled statement and a `ROLLBACK` to finish before the connection goes
/// back to the pool. A connection whose cleanup fails or takes too long is
/// discarded, so no request ever receives one that is still mid-statement.
pub struct RequestConnection {
    client: Option<Object>,
    cancel: CancelToken,
    finished: bool,
}

impl RequestConnection {
    pub fn new(client: Object) -> Self {
        let cancel = client.cancel_token();
        RequestConnection {
            client: Some(client),
            cancel,
            finished: false,
        }
    }

    pub fn client(&mut self) -> &mut Object {
        self.client
            .as_mut()
            .expect("the connection is held until the guard is dropped")
    }

    /// Every statement of the request has answered (committed or failed):
    /// dropping the guard returns the connection to the pool as usual.
    pub fn finish(&mut self) {
        self.finished = true;
    }
}

impl Drop for RequestConnection {
    fn drop(&mut self) {
        let client = match self.client.take() {
            Some(client) => client,
            None => return,
        };
        if self.finished {
            return;
        }
        let runtime = match tokio::runtime::Handle::try_current() {
            Ok(runtime) => runtime,
            Err(_) => {
                // Nothing can drain it here: never lend it out again.
                let _ = Object::take(client);
                return;
            }
        };
        let cancel = self.cancel.clone();
        runtime.spawn(async move {
            let _ = tokio::time::timeout(CANCEL_TIMEOUT, cancel.cancel_query(NoTls)).await;
            // Requests on one connection answer in order: this returns once the
            // cancelled statement has ended and the transaction is gone.
            let drained =
                tokio::time::timeout(DRAIN_TIMEOUT, client.batch_execute("ROLLBACK")).await;
            if !matches!(drained, Ok(Ok(()))) {
                tracing::warn!(
                    event = "database.cancel_cleanup_failed",
                    "discarding an API connection whose cancelled statement did not drain"
                );
                let _ = Object::take(client);
            }
        });
    }
}

/// Admin pool (schema owner role), used only by the panel. Small and with its
/// own `statement_timeout`.
pub fn admin_pool(admin: &tokio_postgres::Config, max_size: usize) -> Pool {
    let mut config = admin.clone();
    config
        .application_name("nelcota-admin")
        .options("-c statement_timeout=30s");
    let manager = Manager::from_config(
        config,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Custom("ROLLBACK".into()),
        },
    );
    Pool::builder(manager)
        .max_size(max_size)
        .runtime(Runtime::Tokio1)
        .wait_timeout(Some(Duration::from_secs(5)))
        .create_timeout(Some(Duration::from_secs(5)))
        .recycle_timeout(Some(Duration::from_secs(5)))
        .build()
        .expect("runtime is set, build cannot fail")
}

/// Opens the request transaction and assumes the JWT role/claims.
///
/// Equivalent to `SET LOCAL ROLE <role>` + `set_config('request.jwt.claims', ..., true)`,
/// in a single round trip and with both values as parameters. If the
/// transaction is not committed (error, panic, early return), dropping it
/// rolls back and nothing leaks into the connection's next use.
pub async fn begin_request<'a>(
    client: &'a mut Object,
    claims: &Claims,
) -> Result<Transaction<'a>, tokio_postgres::Error> {
    let tx = client.transaction().await?;
    let statement = tx
        .prepare_cached(
            "SELECT set_config('role', $1, true), set_config('request.jwt.claims', $2, true), set_config('nelcota.response_bytes', '0', true)",
        )
        .await?;
    tx.execute(&statement, &[&claims.role().as_str(), &claims.as_json()])
        .await?;
    Ok(tx)
}
