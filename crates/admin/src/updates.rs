//! Independent, unprivileged HTTP adapter. The worker verifies every capability.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use nelcota_deployment::protocol::{ControllerConfig, Request, Response as Reply};
use serde::Deserialize;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;
const COOKIE: &str = "__Host-nelcota_updates";
#[derive(Clone)]
struct Controller {
    config: Arc<ControllerConfig>,
    admission: Arc<Semaphore>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    HostStatus {
        key: Option<String>,
    },
    HostPlan {
        operation: nelcota_deployment::management::Operation,
    },
    HostStart {
        plan: String,
        key: String,
        password: String,
        confirmation: String,
    },
    HostRecover {
        job: String,
        password: String,
        confirmation: String,
    },
    HostLogs {
        project: String,
        service: nelcota_deployment::management::LogService,
    },
    Login {
        email: String,
        password: String,
    },
    Logout,
    Check,
    Plan {
        project: String,
    },
    Start {
        plan: String,
        key: String,
        password: String,
    },
    Recover {
        job: String,
        password: String,
    },
}
fn failure(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"result":"error","code":code}))).into_response()
}
fn session(headers: &HeaderMap) -> Option<String> {
    let mut matches = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .filter(|(key, _)| *key == COOKIE)
        .map(|(_, value)| value);
    let value = matches.next()?;
    if matches.next().is_some() || !nelcota_deployment::valid_digest(value) {
        return None;
    }
    Some(value.into())
}
async fn boundary(
    State(state): State<Controller>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let expected = state.config.origin.trim_start_matches("https://");
    if request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(expected)
    {
        return failure(StatusCode::FORBIDDEN, "origin_rejected");
    }
    if request.method() != axum::http::Method::GET
        && (request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            != Some(state.config.origin.as_str())
            || request
                .headers()
                .get("x-nelcota-updates")
                .and_then(|value| value.to_str().ok())
                != Some("1"))
    {
        return failure(StatusCode::FORBIDDEN, "origin_rejected");
    }
    match tokio::time::timeout(Duration::from_secs(25), next.run(request)).await {
        Ok(response) => response,
        Err(_) => failure(StatusCode::GATEWAY_TIMEOUT, "controller_timeout"),
    }
}
async fn invoke(state: Controller, request: Request) -> Response {
    let permit = match state.admission.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return failure(StatusCode::TOO_MANY_REQUESTS, "controller_busy"),
    };
    let socket = state.config.worker_socket.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        nelcota_deployment::protocol::call(&socket, &request)
    })
    .await;
    let reply = match result {
        Ok(Ok(reply)) => reply,
        _ => return failure(StatusCode::SERVICE_UNAVAILABLE, "worker_unavailable"),
    };
    match reply {
        Reply::Session { token, email } => {
            if !nelcota_deployment::valid_digest(&token) {
                return failure(StatusCode::BAD_GATEWAY, "worker_unavailable");
            }
            let mut response = Json(json!({"result":"session","email":email})).into_response();
            if let Ok(value) = HeaderValue::from_str(&format!(
                "{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600"
            )) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        Reply::Error { code } => {
            let status = match code.as_str() {
                "session_expired" => StatusCode::UNAUTHORIZED,
                "deployment_state_unavailable" | "policy_changed" => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                _ => StatusCode::FORBIDDEN,
            };
            failure(status, &code)
        }
        reply => Json(reply).into_response(),
    }
}
async fn status(State(state): State<Controller>, headers: HeaderMap) -> Response {
    let token = match session(&headers) {
        Some(token) => token,
        None => return failure(StatusCode::UNAUTHORIZED, "session_required"),
    };
    invoke(state, Request::Status { token }).await
}
async fn action(
    State(state): State<Controller>,
    headers: HeaderMap,
    Json(input): Json<Input>,
) -> Response {
    if let Input::Login { email, password } = input {
        return invoke(state, Request::Login { email, password }).await;
    }
    let token = match session(&headers) {
        Some(token) => token,
        None => return failure(StatusCode::UNAUTHORIZED, "session_required"),
    };
    let logout = matches!(input, Input::Logout);
    let request = match input {
        Input::HostStatus { key } => Request::HostStatus { token, key },
        Input::HostPlan { operation } => Request::HostPlan { token, operation },
        Input::HostStart {
            plan,
            key,
            password,
            confirmation,
        } => Request::HostStart {
            token,
            plan,
            key,
            password,
            confirmation,
        },
        Input::HostRecover {
            job,
            password,
            confirmation,
        } => Request::HostRecover {
            token,
            job,
            password,
            confirmation,
        },
        Input::HostLogs { project, service } => Request::HostLogs {
            token,
            project,
            service,
        },
        Input::Logout => Request::Logout { token },
        Input::Check => Request::Check { token },
        Input::Plan { project } => Request::Plan { token, project },
        Input::Start {
            plan,
            key,
            password,
        } => Request::Start {
            token,
            plan,
            key,
            password,
        },
        Input::Recover { job, password } => Request::Recover {
            token,
            job,
            password,
        },
        Input::Login { .. } => unreachable!(),
    };
    let mut response = invoke(state, request).await;
    if logout {
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_static(
                "__Host-nelcota_updates=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
            ),
        );
    }
    response
}
pub fn controller_router(config: ControllerConfig) -> Router {
    let state = Controller {
        config: Arc::new(config),
        admission: Arc::new(Semaphore::new(8)),
    };
    Router::new()
        .route("/admin/api/updates", get(status).post(action))
        .route(
            "/admin/api/{*rest}",
            get(|| async { StatusCode::NOT_FOUND }).post(|| async { StatusCode::NOT_FOUND }),
        )
        .route("/admin/assets/{*file}", get(crate::assets::asset))
        .route("/admin", get(|| async { Redirect::to("/admin/") }))
        .route("/admin/", get(crate::assets::controller_spa))
        .route("/admin/{*rest}", get(crate::assets::controller_spa))
        .layer(DefaultBodyLimit::max(16384))
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .layer(middleware::from_fn(crate::middleware::security_headers))
        .with_state(state)
}
#[cfg(unix)]
pub async fn serve(config: ControllerConfig) -> anyhow::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let url = url::Url::parse(&config.origin)?;
    if config.schema != 1
        || url.scheme() != "https"
        || config.origin != url.origin().ascii_serialization()
        || !config.worker_socket.is_absolute()
        || !config.http_socket.is_absolute()
    {
        anyhow::bail!("invalid controller configuration");
    }
    let path = config.http_socket.clone();
    if path.exists() {
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink()
            || metadata.uid()
                != std::fs::metadata(
                    path.parent()
                        .ok_or_else(|| anyhow::anyhow!("missing socket directory"))?,
                )?
                .uid()
        {
            anyhow::bail!("unsafe controller socket");
        }
        std::fs::remove_file(&path)?;
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660))?;
    axum::serve(listener, controller_router(config)).await?;
    Ok(())
}
/// Project administrators can locate the controller but cannot grant host authority.
pub async fn information(State(state): State<crate::AdminState>) -> Json<serde_json::Value> {
    let origin = crate::projects::read_registry(&state.host).updates_origin;
    Json(json!({"version":env!("CARGO_PKG_VERSION"),"controller_origin":origin}))
}

#[cfg(not(unix))]
pub async fn serve(_config: ControllerConfig) -> anyhow::Result<()> {
    anyhow::bail!("host updates require Unix sockets");
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    fn config() -> ControllerConfig {
        ControllerConfig {
            schema: 1,
            origin: "https://updates.example.test".into(),
            worker_socket: "/invalid/worker.sock".into(),
            http_socket: "/invalid/http.sock".into(),
        }
    }
    fn post(origin: Option<&str>, host: &str, body: &str) -> Request<Body> {
        let mut request = Request::builder()
            .method("POST")
            .uri("/admin/api/updates")
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-nelcota-updates", "1");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        request.body(Body::from(body.to_owned())).unwrap()
    }
    #[tokio::test]
    async fn csrf_login_and_proxy_host_are_checked_before_worker_contact() {
        let app = controller_router(config());
        for request in [
            post(
                None,
                "updates.example.test",
                r#"{"action":"login","email":"x","password":"x"}"#,
            ),
            post(
                Some("https://project.example.test"),
                "updates.example.test",
                r#"{"action":"login","email":"x","password":"x"}"#,
            ),
            post(
                Some("https://updates.example.test"),
                "project.example.test",
                r#"{"action":"check"}"#,
            ),
        ] {
            let reply = app.clone().oneshot(request).await.unwrap();
            assert_eq!(reply.status(), StatusCode::FORBIDDEN);
            assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
            assert!(
                reply
                    .headers()
                    .contains_key(header::CONTENT_SECURITY_POLICY)
            );
        }
        let mut request = post(
            Some("https://updates.example.test"),
            "updates.example.test",
            r#"{"action":"check"}"#,
        );
        request.headers_mut().remove("x-nelcota-updates");
        assert_eq!(
            app.oneshot(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn project_cookies_bearer_tokens_duplicate_cookies_and_injected_fields_are_rejected() {
        let app = controller_router(config());
        for cookie in [
            "nelcota_session=project-session".to_owned(),
            format!("{COOKIE}={}; {COOKIE}={}", "a".repeat(64), "b".repeat(64)),
        ] {
            let mut request = post(
                Some("https://updates.example.test"),
                "updates.example.test",
                r#"{"action":"check"}"#,
            );
            request
                .headers_mut()
                .insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
            request.headers_mut().insert(
                header::AUTHORIZATION,
                HeaderValue::from_static("Bearer service-role-token"),
            );
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let request = post(
            Some("https://updates.example.test"),
            "updates.example.test",
            r#"{"action":"start","plan":"x","key":"x","password":"x","token":"privileged"}"#,
        );
        assert_eq!(
            app.oneshot(request).await.unwrap().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn login_cookie_is_secure_and_worker_token_never_appears_in_json() {
        use std::io::{Read, Write};
        let temporary = tempfile::tempdir().unwrap();
        let socket = temporary.path().join("worker.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (mut client, _) = listener.accept().unwrap();
            let mut length = [0; 4];
            client.read_exact(&mut length).unwrap();
            let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
            client.read_exact(&mut bytes).unwrap();
            assert!(matches!(
                serde_json::from_slice::<nelcota_deployment::protocol::Request>(&bytes).unwrap(),
                nelcota_deployment::protocol::Request::Login { .. }
            ));
            let bytes = serde_json::to_vec(&Reply::Session {
                token: "a".repeat(64),
                email: "operator@example.test".into(),
            })
            .unwrap();
            client
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .unwrap();
            client.write_all(&bytes).unwrap();
        });
        let mut settings = config();
        settings.worker_socket = socket;
        let reply = controller_router(settings)
            .oneshot(post(
                Some("https://updates.example.test"),
                "updates.example.test",
                r#"{"action":"login","email":"operator@example.test","password":"test"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(reply.status(), 200);
        let cookie = reply.headers()[header::SET_COOKIE].to_str().unwrap();
        for flag in [
            "__Host-nelcota_updates=",
            "Secure",
            "HttpOnly",
            "SameSite=Strict",
            "Path=/",
        ] {
            assert!(cookie.contains(flag));
        }
        use http_body_util::BodyExt;
        let bytes = reply.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value.get("token").is_none());
        assert_eq!(value["email"], "operator@example.test");
        server.join().unwrap();
    }
}
