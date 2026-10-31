//! Table structure handlers: available types, create, alter and drop.
//! Validation and SQL live in `ddl::table`; execution in `apply`.

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_postgres::Client;

use crate::{
    AdminState, ApiError,
    apply::{ChangeKind, apply},
    ddl::{
        BASE_TYPES,
        policy::{self, PolicyDef},
        table::{self, AlterAction, Context, CreateTable},
    },
    tables::catalog::table_or_404,
    tables::structure,
};

type ApiResult<T = Value> = Result<Json<T>, ApiError>;

async fn enums(client: &Client, schema: &str) -> Result<Vec<String>, ApiError> {
    Ok(client
        .query(
            "SELECT t.typname::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = $1 AND t.typtype = 'e' ORDER BY 1",
            &[&schema],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

/// `GET /admin/api/types`: types the form offers.
pub async fn types(State(state): State<AdminState>) -> ApiResult<crate::contracts::TypesResponse> {
    let schema = state.catalog.get().schema.clone();
    let client = state.db.get().await?;
    crate::contracts::response::<crate::contracts::TypesResponse>(
        json!({ "base": BASE_TYPES, "enums": enums(&client, &schema).await? }),
    )
}

#[derive(Deserialize)]
pub struct CreateRequest {
    table: CreateTable,
    /// Initial access rules are created atomically with the table.
    #[serde(default)]
    policies: Vec<PolicyDef>,
    #[serde(default)]
    preview: bool,
}

/// `POST /admin/api/tables`
pub async fn create(
    State(state): State<AdminState>,
    Json(body): Json<CreateRequest>,
) -> ApiResult<crate::contracts::DdlResult> {
    let schema = state.catalog.get().schema.clone();
    let enums = enums(&*state.db.get().await?, &schema).await?;
    let mut statements = table::create(
        &Context {
            schema: &schema,
            enums: &enums,
        },
        &body.table,
    )?;
    for definition in &body.policies {
        statements.extend(policy::create(&schema, &body.table.name, definition)?);
    }
    apply(
        &state,
        statements,
        body.preview,
        ChangeKind::TableCreated,
        &body.table.name,
    )
    .await
}

#[derive(Deserialize)]
pub struct AlterRequest {
    actions: Vec<AlterAction>,
    #[serde(default)]
    preview: bool,
}

/// `PATCH /admin/api/tables/{name}`
pub async fn alter(
    State(state): State<AdminState>,
    Path(name): Path<String>,
    Json(body): Json<AlterRequest>,
) -> ApiResult<crate::contracts::DdlResult> {
    let table = table_or_404(&state, &name)?;
    let schema = state.catalog.get().schema.clone();
    let (current, enums) = {
        let client = state.db.get().await?;
        let current = structure::load(&client, &schema, &table.name)
            .await?
            .ok_or_else(|| {
                ApiError::not_found("table_not_found", format!("table '{name}' does not exist"))
                    .params(json!({ "table": name }))
            })?;
        (current, enums(&client, &schema).await?)
    };
    let statements = table::alter(
        &Context {
            schema: &schema,
            enums: &enums,
        },
        &current,
        &body.actions,
    )?;
    apply(
        &state,
        statements,
        body.preview,
        ChangeKind::TableAltered,
        &name,
    )
    .await
}

#[derive(Deserialize)]
pub struct DropQuery {
    #[serde(default)]
    cascade: bool,
    #[serde(default)]
    preview: bool,
}

/// `DELETE /admin/api/tables/{name}`
pub async fn drop(
    State(state): State<AdminState>,
    Path(name): Path<String>,
    Query(params): Query<DropQuery>,
) -> ApiResult<crate::contracts::DdlResult> {
    let table = table_or_404(&state, &name)?;
    let schema = state.catalog.get().schema.clone();
    let statements = table::drop(&schema, &table.name, table.kind, params.cascade);
    apply(
        &state,
        statements,
        params.preview,
        ChangeKind::TableDropped,
        &name,
    )
    .await
}
