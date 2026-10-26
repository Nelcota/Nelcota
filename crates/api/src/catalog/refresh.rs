//! Atomic snapshots and serialized reconciliation after schema changes.
use super::Catalog;
use std::{
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// Shared catalog, swapped atomically on each reload.
pub struct CatalogHandle {
    state: Arc<Snapshot>,
    retry_task: Mutex<Option<tokio::task::AbortHandle>>,
}

// Workers own the snapshot state, never the handle that owns their cancellation.
struct Snapshot {
    current: RwLock<Arc<Catalog>>,
    reload_lock: tokio::sync::Mutex<()>,
    retrying: AtomicBool,
}

impl CatalogHandle {
    pub fn new(catalog: Catalog) -> Self {
        CatalogHandle {
            state: Arc::new(Snapshot {
                current: RwLock::new(Arc::new(catalog)),
                reload_lock: tokio::sync::Mutex::new(()),
                retrying: AtomicBool::new(false),
            }),
            retry_task: Mutex::new(None),
        }
    }

    pub fn get(&self) -> Arc<Catalog> {
        self.state.get()
    }

    pub fn replace(&self, catalog: Catalog) {
        self.state.replace(catalog);
    }

    pub async fn reload(&self, pool: &deadpool_postgres::Pool) -> Result<(), String> {
        let _guard = self.state.reload_lock.lock().await;
        self.state.reload_locked(pool).await
    }

    /// A committed change stays successful when introspection fails. A single
    /// worker reconciles the catalog without executing the mutation again.
    pub async fn refresh(self: &Arc<Self>, pool: &deadpool_postgres::Pool) -> bool {
        let _guard = self.state.reload_lock.lock().await;
        if self.state.reload_locked(pool).await.is_ok() {
            return true;
        }
        tracing::warn!("catalog refresh pending; scheduling reconciliation");
        if !self.state.retrying.swap(true, Ordering::AcqRel) {
            self.start_retry(pool.clone());
        }
        false
    }

    fn start_retry(&self, pool: deadpool_postgres::Pool) {
        let state = self.state.clone();
        let task = tokio::spawn(async move {
            let mut delay = Duration::from_secs(1);
            loop {
                tokio::time::sleep(delay).await;
                // Reset the worker flag under the reload lock. A concurrent
                // failed refresh must not lose its request to start a worker.
                let _guard = state.reload_lock.lock().await;
                match state.reload_locked(&pool).await {
                    Ok(()) => {
                        state.retrying.store(false, Ordering::Release);
                        break;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "catalog reconciliation failed; retrying")
                    }
                }
                delay = (delay * 2).min(Duration::from_secs(30));
            }
        });
        *self.retry_task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task.abort_handle());
    }
}

impl Snapshot {
    fn get(&self) -> Arc<Catalog> {
        self.current
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn replace(&self, catalog: Catalog) {
        *self.current.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(catalog);
    }

    async fn reload_locked(&self, pool: &deadpool_postgres::Pool) -> Result<(), String> {
        let schema = self.get().schema.clone();
        let mut client = pool.get().await.map_err(|e| e.to_string())?;
        let catalog = Catalog::load_snapshot(&mut client, &schema)
            .await
            .map_err(|e| e.to_string())?;
        tracing::info!(
            tables = catalog.tables.len(),
            functions = catalog.functions.len(),
            "catalog reloaded"
        );
        self.replace(catalog);
        Ok(())
    }
}

impl Drop for CatalogHandle {
    fn drop(&mut self) {
        if let Some(task) = self.retry_task.get_mut().unwrap_or_else(|e| e.into_inner()) {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn discarded_catalog_releases_failed_reconciliation() {
        let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
            tokio_postgres::Config::new(),
            tokio_postgres::NoTls,
        ))
        .runtime(deadpool_postgres::Runtime::Tokio1)
        .build()
        .unwrap();
        pool.close();
        let runtime = tokio::runtime::Handle::current();
        let baseline = runtime.metrics().num_alive_tasks();
        for _ in 0..32 {
            let catalog = Arc::new(CatalogHandle::new(Catalog::default()));
            let weak = Arc::downgrade(&catalog);
            assert!(!catalog.refresh(&pool).await);
            drop(catalog);
            assert!(
                weak.upgrade().is_none(),
                "retry retained a discarded catalog"
            );
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.metrics().num_alive_tasks() > baseline {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("discarded catalogs left reconciliation tasks alive");
    }

    #[tokio::test]
    async fn discarded_catalog_cancels_reconciliation_waiting_for_a_pool_slot() {
        let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
            tokio_postgres::Config::new(),
            tokio_postgres::NoTls,
        ))
        .max_size(0)
        .runtime(deadpool_postgres::Runtime::Tokio1)
        .build()
        .unwrap();
        let runtime = tokio::runtime::Handle::current();
        let baseline = runtime.metrics().num_alive_tasks();
        let catalog = Arc::new(CatalogHandle::new(Catalog::default()));
        let state = Arc::downgrade(&catalog.state);
        catalog.start_retry(pool);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while catalog.state.reload_lock.try_lock().is_ok() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "retry did not start"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(catalog);
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.metrics().num_alive_tasks() > baseline {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pool wait retained a discarded catalog's reconciliation task");
        assert!(state.upgrade().is_none());
    }
}
