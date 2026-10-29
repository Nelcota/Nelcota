//! Separate deployment capability: opaque scoped tokens never authenticate REST or panel routes.
use crate::{
    AdminState, ApiError,
    contracts::{DeployToken, DeployTokenInfo, DeployTokens},
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use nelcota_core::user_migrations::{self, MigrationRequest};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenRequest {
    name: String,
    days: u32,
}

pub async fn issue(
    State(state): State<AdminState>,
    Json(request): Json<TokenRequest>,
) -> Result<Response, ApiError> {
    if !(1..=90).contains(&request.days)
        || request.name.trim().is_empty()
        || request.name.len() > 100
    {
        return Err(ApiError::bad_request(
            "invalid_deploy_token",
            "provide a name (1-100 bytes) and validity of 1-90 days",
        ));
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    let token = format!("ndp_{}", URL_SAFE_NO_PAD.encode(bytes));
    let hash = base16ct::lower::encode_string(&Sha256::digest(token.as_bytes()));
    let days = i64::from(request.days);
    let client = state.db.get().await?;
    let row = client.query_one("INSERT INTO nelcota.deploy_tokens (token_hash, name, issued_by, expires_at) VALUES ($1, $2, $3, now() + $4::bigint * interval '1 day') RETURNING id, expires_at::text", &[&hash, &request.name.trim(), &state.credentials.email, &days]).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(DeployToken {
            id: row.get(0),
            token,
            expires_at: row.get(1),
        }),
    )
        .into_response())
}

pub async fn list_tokens(State(state): State<AdminState>) -> Result<Json<DeployTokens>, ApiError> {
    let rows = state.db.get().await?.query("SELECT id, name, issued_by, issued_at::text, expires_at::text, revoked_at::text FROM nelcota.deploy_tokens ORDER BY id DESC LIMIT 100", &[]).await?;
    Ok(Json(DeployTokens {
        tokens: rows
            .iter()
            .map(|row| DeployTokenInfo {
                id: row.get(0),
                name: row.get(1),
                issued_by: row.get(2),
                issued_at: row.get(3),
                expires_at: row.get(4),
                revoked_at: row.get(5),
            })
            .collect(),
    }))
}

pub async fn revoke(
    State(state): State<AdminState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    state.db.get().await?.execute("UPDATE nelcota.deploy_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", &[&id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn authenticate(state: &AdminState, headers: &HeaderMap) -> Result<String, ApiError> {
    let denied = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_deploy_token",
            "a valid unexpired deployment token is required",
        )
    };
    // Browser origins do not get a bearer-token alternative to panel CSRF.
    if headers.contains_key(header::ORIGIN) || headers.contains_key("sec-fetch-site") {
        return Err(denied());
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(denied)?;
    if token.len() != 47 || !token.starts_with("ndp_") {
        return Err(denied());
    }
    let hash = base16ct::lower::encode_string(&Sha256::digest(token.as_bytes()));
    let row = state.db.get().await?.query_opt("SELECT id, issued_by FROM nelcota.deploy_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()", &[&hash]).await?.ok_or_else(denied)?;
    Ok(format!(
        "deploy:{}:{}",
        row.get::<_, i64>(0),
        row.get::<_, String>(1)
    ))
}

fn migration_error(error: user_migrations::Error) -> ApiError {
    match error {
        user_migrations::Error::Invalid(message) => {
            ApiError::bad_request("invalid_migration", message)
        }
        user_migrations::Error::Diverged => ApiError::conflict(
            "migration_diverged",
            "migration history differs; inspect status and restore the original files",
        ),
        user_migrations::Error::BackupRequired => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "migration_backup_required",
            "configure the project's automatic backup agent before production migrations",
        ),
        user_migrations::Error::BackupFailed | user_migrations::Error::BackupInterrupted => {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "migration_backup_failed",
                "automatic backup unavailable or interrupted; inspect migration status before retrying",
            )
        }
        user_migrations::Error::Busy => ApiError::conflict(
            "migration_busy",
            "another protected migration deployment is running",
        ),
        user_migrations::Error::Database(error) => ApiError::from(error),
    }
}

pub async fn apply(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(request): Json<MigrationRequest>,
) -> Result<Response, ApiError> {
    let actor = authenticate(&state, &headers).await?;
    apply_response(&state, &request, &actor).await
}

pub async fn status(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(request): Json<MigrationRequest>,
) -> Result<Response, ApiError> {
    authenticate(&state, &headers).await?;
    let client = state.db.get().await?;
    Ok(Json(json!({"migrations": user_migrations::status(&**client, &request.files).await.map_err(migration_error)?})).into_response())
}

pub async fn typescript(
    State(state): State<AdminState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authenticate(&state, &headers).await?;
    crate::connect::typescript(State(state)).await
}

/// Session-authenticated file application for the panel's migration upload.
pub async fn panel_apply(
    State(state): State<AdminState>,
    Json(request): Json<MigrationRequest>,
) -> Result<Response, ApiError> {
    let actor = format!("panel:{}", state.credentials.email);
    apply_response(&state, &request, &actor).await
}

// Migration SQL can change session settings or create temporary objects. Keep
// its pool admission for the operation, then discard this physical connection,
// including on an error or cancellation, before another panel request can use it.
struct MigrationConnection(Option<deadpool_postgres::Object>);
impl Drop for MigrationConnection {
    fn drop(&mut self) {
        if let Some(client) = self.0.take() {
            let cancel = client.cancel_token();
            // PostgreSQL may continue computing after a TCP close until it
            // next writes a response. Cancel explicitly before closing the
            // driver; retain pool admission during this bounded cleanup.
            match tokio::runtime::Handle::try_current() {
                Ok(runtime) => {
                    runtime.spawn(async move {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(2),
                            cancel.cancel_query(tokio_postgres::NoTls),
                        )
                        .await;
                        drop(deadpool_postgres::Object::take(client));
                    });
                }
                Err(_) => drop(deadpool_postgres::Object::take(client)),
            }
        }
    }
}
async fn apply_response(
    state: &AdminState,
    request: &MigrationRequest,
    actor: &str,
) -> Result<Response, ApiError> {
    let mut connection = MigrationConnection(Some(state.db.get().await?));
    let report = nelcota_core::migration_backup::apply(
        connection.0.as_mut().expect("owned migration connection"),
        request,
        actor,
        state.production,
        state.migration_backup.as_ref(),
    )
    .await
    .map_err(migration_error)?;
    drop(connection);
    // Catalog failure is post-commit: never ask a client to replay accepted SQL.
    let ready = state.catalog.refresh(&state.db).await;
    Ok(
        crate::contracts::response::<crate::contracts::MigrationApplication>(
            json!({"report": report, "catalog_pending": !ready}),
        )?
        .into_response(),
    )
}
