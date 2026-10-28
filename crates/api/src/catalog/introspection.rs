//! Assembles one catalog snapshot from ordered PostgreSQL metadata reads.
mod columns;
mod constraints;
mod functions;
mod relations;
mod types;

use super::model::Catalog;
use tokio_postgres::GenericClient;

impl Catalog {
    /// Reads the catalog of the exposed schema under a single consistent snapshot.
    pub async fn load_snapshot(
        client: &mut tokio_postgres::Client,
        schema: &str,
    ) -> Result<Self, tokio_postgres::Error> {
        let tx = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let catalog = Self::load(&tx, schema).await?;
        tx.commit().await?;
        Ok(catalog)
    }

    /// Reads the catalog of the exposed schema.
    pub async fn load(
        client: &impl GenericClient,
        schema: &str,
    ) -> Result<Self, tokio_postgres::Error> {
        // Keep read order and publication together: no partial snapshot escapes.
        let mut tables = relations::load(client, schema).await?;
        columns::load(client, schema, &mut tables).await?;
        constraints::load(client, schema, &mut tables).await?;
        let functions = functions::load(client, schema).await?;
        let named_types = types::load(client, schema).await?;
        Ok(Catalog {
            named_types,
            schema: schema.to_owned(),
            tables,
            functions,
        })
    }
}
