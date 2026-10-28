//! The "Connect an app" page's download: the schema's TypeScript types, the
//! same file `nelcota types` writes, so a project can be typed without the CLI.
use crate::{AdminState, ApiError};
use axum::{
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};

/// `GET /admin/api/typescript`
pub async fn typescript(State(state): State<AdminState>) -> Result<Response, ApiError> {
    let mut client = state.db.get().await?;
    let transaction = client
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await?;
    let catalog = nelcota_api::Catalog::load(&*transaction, &state.catalog.get().schema).await?;
    let has_migrations: bool = transaction
        .query_one(
            "SELECT to_regclass('nelcota.user_migrations') IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    let migration_version: Option<i32> = match has_migrations {
        true => transaction
            .query_one("SELECT max(version) FROM nelcota.user_migrations", &[])
            .await?
            .get(0),
        false => None,
    };
    let version =
        migration_version.map_or_else(|| "none".to_owned(), |version| version.to_string());
    transaction.commit().await?;
    let code = nelcota_api::typescript::generate(&catalog);
    let mut response = (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"database.ts\"",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        code,
    )
        .into_response();
    response.headers_mut().insert(
        "x-nelcota-migration-version",
        version.parse().expect("numeric migration version"),
    );
    Ok(response)
}
