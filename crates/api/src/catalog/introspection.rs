//! Assembles one catalog snapshot from ordered PostgreSQL metadata reads.
mod columns;
mod constraints;
mod functions;
mod relations;

use super::model::Catalog;
use tokio_postgres::GenericClient;

impl Catalog {
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
        Ok(Catalog {
            schema: schema.to_owned(),
            tables,
            functions,
        })
    }
}
