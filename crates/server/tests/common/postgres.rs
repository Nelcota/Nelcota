//! Optional disposable Postgres cluster for tests on hosts without Docker.
//! Every TestApp gets its own database; the normal CI path uses testcontainers.
use nelcota_core::db;
use tokio_postgres::{Config, NoTls};
use uuid::Uuid;

pub struct ExternalDatabase {
    root: Config,
    name: String,
}
impl ExternalDatabase {
    pub async fn create(url: &str) -> Self {
        let root: Config = url
            .parse()
            .expect("NELCOTA_TEST_DATABASE_URL must be a disposable Postgres cluster");
        let (client, connection) = root.connect(NoTls).await.unwrap();
        tokio::spawn(connection);
        // Advisory locks are database-local but roles are cluster-global. Keep
        // all role-changing bootstrap calls serialized on the control database.
        client
            .batch_execute("SELECT pg_advisory_lock(hashtext('nelcota.tests.bootstrap'))")
            .await
            .unwrap();
        db::bootstrap(&root, super::authenticator_password(), 10)
            .await
            .unwrap();
        let name = format!("nelcota_test_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!("CREATE DATABASE \"{name}\" TEMPLATE template0"))
            .await
            .unwrap();
        let database = Self { root, name };
        db::bootstrap(&database.config(), super::authenticator_password(), 10)
            .await
            .unwrap();
        client
            .batch_execute("SELECT pg_advisory_unlock(hashtext('nelcota.tests.bootstrap'))")
            .await
            .unwrap();
        database
    }
    pub fn config(&self) -> Config {
        let mut config = self.root.clone();
        config.dbname(&self.name);
        config
    }
}
impl Drop for ExternalDatabase {
    fn drop(&mut self) {
        let config = self.root.clone();
        let name = self.name.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Ok((client, connection)) = config.connect(NoTls).await {
                    tokio::spawn(connection);
                    let _ = client
                        .batch_execute(&format!("DROP DATABASE \"{name}\" WITH (FORCE)"))
                        .await;
                }
            });
        }
    }
}
