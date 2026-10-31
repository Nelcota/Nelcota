//! Bounded async scheduling, with its own pool and cooperative shutdown.
use crate::{Error, destination::Policy, models::Job, queue, transport::Transport};
use deadpool_postgres::Pool;
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::watch,
    task::{JoinHandle, JoinSet},
};

const CONCURRENCY: usize = 4;

pub struct Worker {
    pool: Pool,
    transport: Transport,
}
impl Worker {
    pub fn new(pool: Pool, policy: Policy) -> Result<Self, reqwest::Error> {
        Ok(Self {
            pool,
            transport: Transport::new(policy)?,
        })
    }

    /// Useful for controlled drains and integration tests. A batch is bounded
    /// to the same concurrency as production; leases remain durable on failure.
    pub async fn run_once(&self) -> Result<usize, Error> {
        let jobs = queue::claim(&self.pool, CONCURRENCY).await?;
        let count = jobs.len();
        let mut tasks = JoinSet::new();
        for job in jobs {
            self.dispatch(&mut tasks, job);
        }
        while tasks.join_next().await.is_some() {}
        Ok(count)
    }

    pub fn spawn(self) -> WorkerHandle {
        let (stop, mut signal) = watch::channel(false);
        let worker = Arc::new(self);
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut prune = tokio::time::interval(Duration::from_secs(60));
            prune.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = signal.changed() => break,
                    _ = tasks.join_next(), if !tasks.is_empty() => {
                        // Refill completed slots immediately. Keep timed polls
                        // for an empty queue, and coalesce ready completions so
                        // a fast batch does not cause one claim per result.
                        while tasks.try_join_next().is_some() {}
                        tick.reset_immediately();
                    },
                    _ = tick.tick(), if tasks.len()<CONCURRENCY => {
                        match queue::claim(&worker.pool,CONCURRENCY-tasks.len()).await {
                            Ok(jobs) => for job in jobs { worker.dispatch(&mut tasks,job); },
                            Err(_) => {
                                tracing::warn!("webhook queue unavailable; will retry");
                                // Back off without holding a connection or spinning logs.
                                tokio::select! { _ = signal.changed() => break, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
                            }
                        }
                    },
                    _ = prune.tick() => {
                        match queue::prune(&worker.pool).await {
                            // Behind: run again soon, leaving the worker free meanwhile.
                            Ok(false) => prune.reset_after(Duration::from_secs(1)),
                            Ok(true) => {}
                            Err(_) => tracing::warn!("webhook retention cleanup unavailable"),
                        }
                    },
                }
            }
            // Stop claiming, finish what was already dispatched. A crash still
            // leaves leases which another worker recovers after 120 seconds.
            while tasks.join_next().await.is_some() {}
        });
        WorkerHandle { stop, task }
    }

    fn dispatch(&self, tasks: &mut JoinSet<()>, job: Job) {
        let transport = self.transport.clone();
        let pool = self.pool.clone();
        tasks.spawn(async move {
            let outcome = transport.send(&job).await;
            let status = outcome.status;
            if queue::finish(&pool, &job, outcome).await.is_err() {
                tracing::warn!(
                    delivery_id = job.id,
                    "webhook result could not be saved; lease will recover"
                );
                return;
            }
            tracing::debug!(
                delivery_id = job.id,
                attempt = job.attempt,
                status,
                "webhook attempt finished"
            );
        });
    }
}

pub struct WorkerHandle {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl WorkerHandle {
    pub async fn shutdown(self) {
        self.shutdown_with_timeout(Duration::from_secs(30)).await;
    }

    async fn shutdown_with_timeout(mut self, timeout: Duration) {
        let _ = self.stop.send(true);
        if tokio::time::timeout(timeout, &mut self.task).await.is_err() {
            self.task.abort();
            // Abort requests cancellation; join so the worker task is dropped
            // before the caller tears down its runtime or database pool.
            let _ = (&mut self.task).await;
        }
    }
}
impl Drop for WorkerHandle {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn shutdown_waits_for_cancelled_task_resources_to_drop() {
        let dropped = Arc::new(AtomicBool::new(false));
        let resources = dropped.clone();
        let (ready, started) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _resources = Dropped(resources);
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        let (stop, _signal) = watch::channel(false);
        WorkerHandle { stop, task }
            .shutdown_with_timeout(Duration::ZERO)
            .await;
        assert!(dropped.load(Ordering::SeqCst));
    }
}
