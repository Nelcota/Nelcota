//! Panel HTTP adaptation. Session/origin checks are applied by the router;
//! the feature crate owns persistence, validation and replay semantics.
use crate::{
    AdminState, ApiError,
    contracts::{
        self, WebhookCleared, WebhookDeliveries, WebhookDetail, WebhookEndpoint, WebhookEndpoints,
        WebhookReplay, WebhookSecret,
    },
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use nelcota_webhooks::{
    Error, management as hooks,
    models::{EndpointInput, HistoryQuery},
};
use serde_json::json;

fn error(err: Error) -> ApiError {
    match err {
        Error::Invalid { code, message } => ApiError::bad_request(code, message),
        Error::Conflict { code, message } => ApiError::conflict(code, message),
        Error::NotFound => {
            ApiError::not_found("webhook_not_found", "Webhook or delivery not found")
        }
        Error::Pool(_) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "Database unavailable",
        ),
        _ => {
            tracing::warn!("webhook management operation failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Webhook operation failed",
            )
        }
    }
}

fn private<T: serde::Serialize>(body: Json<T>) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], body).into_response()
}

pub async fn list(State(state): State<AdminState>) -> Result<Response, ApiError> {
    let endpoints = hooks::list(&state.db).await.map_err(error)?;
    let tables = hooks::tables(&state.db, &state.catalog.get().schema)
        .await
        .map_err(error)?;
    let client = state.db.get().await?;
    let usage = client
        .query_one(
            "SELECT outstanding,retained FROM nelcota.webhook_queue_usage WHERE singleton",
            &[],
        )
        .await?;
    Ok(private(contracts::response::<WebhookEndpoints>(
        json!({ "endpoints": endpoints,"tables":tables,"allow_loopback":state.webhooks.allow_loopback,"outstanding":usage.get::<_,i64>(0),"retained":usage.get::<_,i64>(1) }),
    )?))
}

pub async fn create(
    State(state): State<AdminState>,
    Json(input): Json<EndpointInput>,
) -> Result<Response, ApiError> {
    let schema = state.catalog.get().schema.clone();
    let created = hooks::create(&state.db, &schema, input, state.webhooks)
        .await
        .map_err(error)?;
    Ok(private(contracts::response::<WebhookSecret>(
        json!({ "endpoint":created.endpoint,"secret":created.secret.expose() }),
    )?))
}
pub async fn update(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    Json(input): Json<EndpointInput>,
) -> Result<Response, ApiError> {
    let endpoint = hooks::update(&state.db, &id, input, state.webhooks)
        .await
        .map_err(error)?;
    Ok(private(contracts::response::<WebhookEndpoint>(
        serde_json::to_value(endpoint)?,
    )?))
}
pub async fn delete(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    hooks::delete(&state.db, &id).await.map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn rotate(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let rotated = hooks::rotate(&state.db, &id).await.map_err(error)?;
    Ok(private(contracts::response::<WebhookSecret>(
        json!({ "endpoint":rotated.endpoint,"secret":rotated.secret.expose() }),
    )?))
}
pub async fn history(
    State(state): State<AdminState>,
    Query(query): Query<HistoryQuery>,
) -> Result<Response, ApiError> {
    let page = hooks::history(&state.db, query).await.map_err(error)?;
    Ok(private(contracts::response::<WebhookDeliveries>(
        json!({ "deliveries":page.deliveries,"next_cursor":page.next_cursor }),
    )?))
}
pub async fn detail(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    Ok(private(contracts::response::<WebhookDetail>(
        serde_json::to_value(hooks::detail(&state.db, &id).await.map_err(error)?)?,
    )?))
}
pub async fn replay(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> Result<Json<WebhookReplay>, ApiError> {
    Ok(Json(WebhookReplay {
        id: hooks::replay(&state.db, &id).await.map_err(error)?,
    }))
}
pub async fn clear_history(
    State(state): State<AdminState>,
) -> Result<Json<WebhookCleared>, ApiError> {
    Ok(Json(WebhookCleared {
        deleted: hooks::clear_history(&state.db).await.map_err(error)?,
    }))
}
