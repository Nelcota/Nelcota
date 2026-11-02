//! Validation candidates reject traffic even if a client bypasses the proxy.
use axum::{
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
#[derive(Clone)]
pub struct TrafficGate(Arc<AtomicBool>, Option<Arc<(PathBuf, String)>>);
impl TrafficGate {
    pub fn new(validation: bool) -> Self {
        Self(Arc::new(AtomicBool::new(!validation)), None)
    }
    pub fn with_proof(path: PathBuf, id: String) -> Self {
        Self(Arc::new(AtomicBool::new(false)), Some(Arc::new((path, id))))
    }
    pub fn commit(&self) {
        self.0.store(true, Ordering::Release);
    }
}
pub async fn reject_uncommitted(
    State(gate): State<TrafficGate>,
    request: Request,
    next: Next,
) -> Response {
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }
    let open = gate.0.load(Ordering::Acquire)
        && match &gate.1 {
            Some(proof) => proof_committed(proof.clone()).await,
            None => true,
        };
    if !open {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "60")],
            "Project in deployment validation",
        )
            .into_response();
    }
    next.run(request).await
}
/// [`committed`] on the blocking pool: it stats and reads a file, which must
/// not stall the async workers (this runs on every request of a candidate).
async fn proof_committed(proof: Arc<(PathBuf, String)>) -> bool {
    tokio::task::spawn_blocking(move || committed(&proof.0, &proof.1))
        .await
        .unwrap_or(false)
}
/// [`committed`] for async callers, off the async workers.
pub async fn committed_async(path: PathBuf, id: String) -> bool {
    proof_committed(Arc::new((path, id))).await
}
pub fn committed(path: &Path, id: &str) -> bool {
    if id.len() != 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return false;
    }
    use std::io::Read;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 75 {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return false;
        }
    }
    let mut bytes = [0; 76];
    matches!(
        std::fs::File::open(path).and_then(|mut file| file.read(&mut bytes)),
        Ok(75)
    ) && &bytes[..75] == format!("COMMITTED {id}\n").as_bytes()
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Request, routing::get};
    use tower::ServiceExt;
    #[tokio::test]
    async fn an_atomic_commit_flag_cannot_bypass_a_missing_or_wrong_candidate_proof() {
        let gate = TrafficGate::with_proof("/missing/deployment/gate".into(), "a".repeat(64));
        gate.commit();
        let app = Router::new()
            .route("/admin/api/whoami", get(|| async { "project" }))
            .layer(axum::middleware::from_fn_with_state(
                gate,
                reject_uncommitted,
            ));
        assert_eq!(
            app.oneshot(
                Request::builder()
                    .uri("/admin/api/whoami")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(!committed(Path::new("/missing/deployment/gate"), "../id"));
    }
    #[tokio::test]
    async fn candidate_blocks_direct_writes_sessions_and_websocket_before_commit() {
        let gate = TrafficGate::new(true);
        let app = Router::new()
            .route("/health", get(|| async { "healthy" }))
            .route(
                "/rest/v1/notes",
                get(|| async { "data" }).post(|| async { "written" }),
            )
            .route("/admin/api/session", get(|| async { "session" }))
            .layer(axum::middleware::from_fn_with_state(
                gate.clone(),
                reject_uncommitted,
            ));
        for (method, path, expected) in [
            ("GET", "/health", 200),
            ("GET", "/rest/v1/notes", 503),
            ("POST", "/rest/v1/notes", 503),
            ("GET", "/admin/api/session", 503),
            ("GET", "/realtime/v1/websocket", 503),
        ] {
            let reply = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(reply.status().as_u16(), expected);
        }
        gate.commit();
        let reply = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/rest/v1/notes")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status(), 200);
    }
}
