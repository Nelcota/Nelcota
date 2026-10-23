//! Cancellation-safe ownership of remote multipart uploads, including while
//! creation or completion is pending. Cleanup tasks retain a bounded permit.
use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use object_store::{
    MultipartUpload, ObjectStore, ObjectStoreExt, PutPayload, PutResult, WriteMultipart, path::Path,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
type UploadPart = futures_util::future::BoxFuture<'static, object_store::Result<()>>;

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const CREATE_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) async fn writer(
    store: Arc<dyn ObjectStore>,
    key: Path,
    part: usize,
    slots: Arc<Semaphore>,
) -> object_store::Result<WriteMultipart> {
    start(async move { store.put_multipart(&key).await }, part, slots).await
}

async fn start(
    create: impl std::future::Future<Output = object_store::Result<Box<dyn MultipartUpload>>>
    + Send
    + 'static,
    part: usize,
    slots: Arc<Semaphore>,
) -> object_store::Result<WriteMultipart> {
    let permit = slots
        .acquire_owned()
        .await
        .expect("multipart semaphore stays open");
    let (send, receive) = oneshot::channel();
    // Creation must settle even if the request's deadline expires: once the
    // provider returns an upload ID, the guard can abort it. A canceled receiver
    // drops the returned writer and starts cleanup instead of losing that ID.
    tokio::spawn(async move {
        let result = match tokio::time::timeout(CREATE_TIMEOUT, create).await {
            Ok(Ok(upload)) => Ok(WriteMultipart::new_with_chunk_size(
                Box::new(Guard {
                    upload: Some(upload),
                    permit: Some(permit),
                }),
                part,
            )),
            Ok(Err(error)) => Err(error),
            Err(error) => Err(failure(error)),
        };
        let _ = send.send(result);
    });
    receive.await.map_err(failure)?
}

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> object_store::Error {
    object_store::Error::Generic {
        store: "multipart",
        source: Box::new(error),
    }
}

#[derive(Debug)]
struct Guard {
    upload: Option<Box<dyn MultipartUpload>>,
    permit: Option<OwnedSemaphorePermit>,
}

#[async_trait]
impl MultipartUpload for Guard {
    fn put_part(&mut self, data: PutPayload) -> UploadPart {
        self.upload.as_mut().expect("active upload").put_part(data)
    }
    async fn complete(&mut self) -> object_store::Result<PutResult> {
        let result = self
            .upload
            .as_mut()
            .expect("active upload")
            .complete()
            .await?;
        self.upload.take();
        self.permit.take();
        Ok(result)
    }
    async fn abort(&mut self) -> object_store::Result<()> {
        self.upload.as_mut().expect("active upload").abort().await?;
        self.upload.take();
        self.permit.take();
        Ok(())
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let mut upload = match self.upload.take() {
            Some(upload) => upload,
            _ => {
                return;
            }
        };
        let permit = self.permit.take();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    let _permit = permit;
                    match tokio::time::timeout(CLEANUP_TIMEOUT, upload.abort()).await {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => tracing::warn!(
                            event = "storage.multipart_abort_failed",
                            error_type = std::any::type_name_of_val(&error),
                            "multipart abort failed; S3 lifecycle cleanup is required"
                        ),
                        Err(_) => tracing::warn!(
                            event = "storage.multipart_abort_timeout",
                            "multipart abort timed out; S3 lifecycle cleanup is required"
                        ),
                    }
                });
            }
            _ => {
                tracing::warn!(
                    event = "storage.multipart_abort_unavailable",
                    "runtime stopped before multipart abort; S3 lifecycle cleanup is required"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug)]
    struct PendingUpload {
        aborted: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl MultipartUpload for PendingUpload {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            async { Ok(()) }.boxed()
        }
        async fn complete(&mut self) -> object_store::Result<PutResult> {
            std::future::pending().await
        }
        async fn abort(&mut self) -> object_store::Result<()> {
            self.aborted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn canceled_creation_keeps_capacity_until_the_returned_upload_is_aborted() {
        let aborted = Arc::new(AtomicUsize::new(0));
        let slots = Arc::new(Semaphore::new(1));
        let (begun, started) = oneshot::channel();
        let (release, ready) = oneshot::channel();
        let count = aborted.clone();
        let task = tokio::spawn(start(
            async move {
                begun.send(()).unwrap();
                ready.await.unwrap();
                Ok(Box::new(PendingUpload { aborted: count }) as Box<dyn MultipartUpload>)
            },
            1,
            slots.clone(),
        ));
        started.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            slots.available_permits(),
            0,
            "pending creation still owns its slot"
        );
        release.send(()).unwrap();
        let _permit = tokio::time::timeout(Duration::from_secs(1), slots.acquire())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(aborted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_during_receive_or_completion_aborts_and_releases_capacity() {
        for completing in [false, true] {
            let aborted = Arc::new(AtomicUsize::new(0));
            let slots = Arc::new(Semaphore::new(1));
            let guard = Guard {
                upload: Some(Box::new(PendingUpload {
                    aborted: aborted.clone(),
                })),
                permit: Some(slots.clone().acquire_owned().await.unwrap()),
            };
            let mut writer = WriteMultipart::new_with_chunk_size(Box::new(guard), 1);
            writer.write(b"part");
            match completing {
                true => {
                    assert!(
                        tokio::time::timeout(Duration::from_millis(10), writer.finish())
                            .await
                            .is_err()
                    );
                }
                false => {
                    drop(writer);
                }
            }
            let _permit = tokio::time::timeout(Duration::from_secs(1), slots.acquire())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(aborted.load(Ordering::SeqCst), 1);
        }
    }
}
