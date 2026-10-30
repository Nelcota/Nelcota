//! Auth-only bootstrap, full-host promotion and independent instance contracts.
use axum::{Router, body::Body, http::Request};
use http_body_util::BodyExt;
use nelcota_auth::{AuthSettings, AuthState, EmailLinks, Keys, Passwords};
use nelcota_core::db;
use serde_json::{Value, json};
use std::sync::Arc;
use testcontainers_modules::{
    postgres::Postgres,
    testcontainers::{ContainerAsync, ImageExt, runners::AsyncRunner},
};
use tokio_postgres::{Client, Config, NoTls};
use uuid::Uuid;

fn authenticator_password() -> &'static str {
    // PostgreSQL roles are cluster-global: all concurrent tests in this process
    // must share one generated password when using the shared fixture cluster.
    static VALUE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VALUE.get_or_init(|| Uuid::new_v4().simple().to_string())
}

struct Database {
    admin: Config,
    client: Client,
    _container: Option<ContainerAsync<Postgres>>,
    // All bootstraps in a test can ALTER cluster-global roles. Keep the shared
    // control-database lease for the fixture lifetime, including later retries;
    // concurrent instances within this database still exercise their own locks.
    _cluster_lease: Client,
}

impl Database {
    async fn new() -> Self {
        Self::create(false).await
    }

    async fn create(isolated_cluster: bool) -> Self {
        let (container, root) = match std::env::var("NELCOTA_TEST_DATABASE_URL")
            .ok()
            .filter(|_| !isolated_cluster)
        {
            Some(url) => (None, url.parse::<Config>().unwrap()),
            None => {
                let container = Postgres::default()
                    .with_tag("17-alpine")
                    .with_cmd([
                        "postgres",
                        "-c",
                        "fsync=off",
                        "-c",
                        "shared_preload_libraries=pg_stat_statements",
                    ])
                    .start()
                    .await
                    .unwrap();
                let host = container.get_host().await.unwrap();
                let port = container.get_host_port_ipv4(5432).await.unwrap();
                (
                    Some(container),
                    format!("postgres://postgres:postgres@{host}:{port}/postgres")
                        .parse()
                        .unwrap(),
                )
            }
        };
        let (control, connection) = root.connect(NoTls).await.unwrap();
        tokio::spawn(connection);
        control
            .batch_execute("SELECT pg_advisory_lock(hashtext('nelcota.tests.bootstrap'))")
            .await
            .unwrap();
        let name = format!("nelcota_test_{}", Uuid::new_v4().simple());
        control
            .batch_execute(&format!("CREATE DATABASE \"{name}\" TEMPLATE template0"))
            .await
            .unwrap();
        let mut admin = root;
        admin.dbname(&name);
        nelcota_auth::bootstrap(&admin, authenticator_password(), 10)
            .await
            .unwrap();
        let (client, connection) = admin.connect(NoTls).await.unwrap();
        tokio::spawn(connection);
        Self {
            admin,
            client,
            _container: container,
            _cluster_lease: control,
        }
    }

    async fn versions(&self) -> Vec<i32> {
        self.client
            .query(
                "SELECT version FROM nelcota.schema_migrations ORDER BY version",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }

    fn state(&self, keys: Arc<Keys>) -> AuthState {
        AuthState::new(
            db::api_pool(&self.admin, authenticator_password(), 2),
            keys,
            Arc::new(Passwords::new(1)),
            AuthSettings {
                issuer: "reuse-test".into(),
                access_ttl_secs: 900,
                refresh_ttl_days: 30,
                signup_enabled: true,
                proxy_hops: 0,
                links: EmailLinks::default(),
            },
            1000,
        )
        .unwrap()
    }
}

#[tokio::test]
async fn reused_privileged_request_role_is_rejected_without_silent_downgrade() {
    let database = Database::create(true).await;
    database
        .client
        .batch_execute("ALTER ROLE authenticator SUPERUSER")
        .await
        .unwrap();
    assert!(
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10)
            .await
            .is_err(),
        "Existing privileged authenticator must fail startup"
    );
    database
        .client
        .batch_execute("ALTER ROLE authenticator NOSUPERUSER")
        .await
        .unwrap();
    database
        .client
        .batch_execute("ALTER ROLE anon BYPASSRLS")
        .await
        .unwrap();
    assert!(matches!(
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10).await,
        Err(db::BootstrapError::UnsafeRole("anon"))
    ));
    database
        .client
        .batch_execute(
            "ALTER ROLE anon NOBYPASSRLS; GRANT service_role TO authenticator WITH INHERIT TRUE",
        )
        .await
        .unwrap();
    assert!(matches!(
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10).await,
        Err(db::BootstrapError::UnsafeRole("authenticator"))
    ));
    database
        .client
        .batch_execute("GRANT service_role TO authenticator WITH INHERIT FALSE")
        .await
        .unwrap();
    for role in ["anon", "authenticated", "service_role"] {
        database
            .client
            .batch_execute(&format!("GRANT nelcota_auth TO {role} WITH INHERIT TRUE"))
            .await
            .unwrap();
        let exposed: bool = database
            .client
            .query_one(
                "SELECT has_table_privilege($1::text,'auth.refresh_tokens','SELECT')",
                &[&role],
            )
            .await
            .unwrap()
            .get(0);
        assert!(
            exposed,
            "The fixture must reproduce inherited credential access"
        );
        assert!(
            matches!(nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10).await,
            Err(db::BootstrapError::UnsafeRole(rejected)) if rejected == role)
        );
        database
            .client
            .batch_execute(&format!("REVOKE nelcota_auth FROM {role}"))
            .await
            .unwrap();
    }
    database
        .client
        .batch_execute("GRANT service_role TO nelcota_auth WITH INHERIT TRUE")
        .await
        .unwrap();
    assert!(matches!(
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10).await,
        Err(db::BootstrapError::UnsafeRole("nelcota_auth"))
    ));
    database
        .client
        .batch_execute("REVOKE service_role FROM nelcota_auth")
        .await
        .unwrap();
    for role in ["nelcota_storage", "nelcota_webhooks"] {
        database
            .client
            .batch_execute(&format!("CREATE ROLE {role} NOLOGIN NOINHERIT SUPERUSER"))
            .await
            .unwrap();
        assert!(
            matches!(nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10).await,
            Err(db::BootstrapError::UnsafeRole(rejected)) if rejected == role)
        );
        database
            .client
            .batch_execute(&format!("DROP ROLE {role}"))
            .await
            .unwrap();
    }
    nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10)
        .await
        .unwrap();
}

async fn post(router: Router, path: &str, value: Value) -> (u16, Value) {
    use tower::ServiceExt;
    let response = router
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn refresh_lifetimes_match_postgres_range_and_invalid_manual_state_rolls_back() {
    let database = Database::new().await;
    let keys =
        Arc::new(Keys::new(Some(&nelcota_auth::generate_ed25519_private_key()), None).unwrap());
    let mut state = database.state(keys);
    let mut settings = (*state.settings).clone();
    let valid_days: i32 = database
        .client
        .query_one(
            "SELECT floor((extract(epoch FROM '294276-12-30 00:00:00+00'::timestamptz)
                - extract(epoch FROM now())) / 86400)::int4",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    settings.refresh_ttl_days = valid_days as u32;
    assert!(settings.validate().is_ok());
    let representable: bool = database
        .client
        .query_one(
            "SELECT (now() + make_interval(days => $1)) IS NOT NULL",
            &[&valid_days],
        )
        .await
        .unwrap()
        .get(0);
    assert!(representable);
    let invalid_days = i32::MAX;
    assert!(
        database
            .client
            .query_one(
                "SELECT (now() + make_interval(days => $1)) IS NOT NULL",
                &[&invalid_days],
            )
            .await
            .is_err(),
        "The fixture must reproduce timestamp overflow despite fitting int4"
    );
    settings.refresh_ttl_days = invalid_days as u32;
    assert!(settings.validate().is_err());
    assert!(
        AuthState::new(
            state.pool.clone(),
            state.keys.clone(),
            state.passwords.clone(),
            settings.clone(),
            1000,
        )
        .is_err()
    );
    // Public fields retain compatibility: an invalid manually assembled state
    // must fail without leaving a partially created user/session/token.
    state.settings = Arc::new(settings);
    let (status, _) = post(
        nelcota_auth::router(state),
        "/auth/v1/signup",
        json!({"email":"ttl@example.com","password":Uuid::new_v4().to_string()}),
    )
    .await;
    assert_eq!(status, 500);
    let retained: i64 = database
        .client
        .query_one(
            "SELECT (SELECT count(*) FROM auth.users)
                 + (SELECT count(*) FROM auth.sessions)
                 + (SELECT count(*) FROM auth.refresh_tokens)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(retained, 0);
}

#[tokio::test]
async fn fresh_auth_setup_is_scoped_idempotent_and_serializes_instances() {
    let database = Database::new().await;
    assert_eq!(
        database.versions().await,
        nelcota_auth::AUTH_MIGRATION_VERSIONS
    );
    let excluded: i64 = database.client.query_one("SELECT count(*) FROM pg_tables WHERE schemaname IN ('storage','webhooks') OR (schemaname='nelcota' AND tablename <> 'schema_migrations')", &[]).await.unwrap().get(0);
    assert_eq!(excluded, 0);
    let (a, b) = tokio::join!(
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10),
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        database.versions().await,
        nelcota_auth::AUTH_MIGRATION_VERSIONS
    );
    for role in ["anon", "authenticated", "service_role"] {
        let allowed: bool = database
            .client
            .query_one(
                "SELECT has_table_privilege($1::text, 'auth.refresh_tokens', 'SELECT')",
                &[&role],
            )
            .await
            .unwrap()
            .get(0);
        assert!(!allowed, "{role} must not read credential hashes");
    }
}

#[tokio::test]
async fn promotion_preserves_users_tokens_and_checksums_across_auth_instances() {
    let database = Database::new().await;
    let keys =
        Arc::new(Keys::new(Some(&nelcota_auth::generate_ed25519_private_key()), None).unwrap());
    let first = nelcota_auth::router(database.state(keys.clone()));
    let second = nelcota_auth::router(database.state(keys));
    let password = Uuid::new_v4().to_string();
    let (status, session) = post(
        first.clone(),
        "/auth/v1/signup",
        json!({"email":"reuse@example.com","password":password}),
    )
    .await;
    assert_eq!(status, 201);
    let history = database
        .client
        .query(
            "SELECT version,checksum FROM nelcota.schema_migrations ORDER BY version",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get::<_, i32>(0), r.get::<_, String>(1)))
        .collect::<Vec<_>>();
    db::bootstrap(&database.admin, authenticator_password(), 10)
        .await
        .unwrap();
    nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10)
        .await
        .unwrap();
    assert_eq!(database.versions().await, (1..=20).collect::<Vec<_>>());
    for (version, checksum) in history {
        let current: String = database
            .client
            .query_one(
                "SELECT checksum FROM nelcota.schema_migrations WHERE version=$1",
                &[&version],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(current, checksum);
    }
    let (status, refreshed) = post(
        second.clone(),
        "/auth/v1/token?grant_type=refresh_token",
        json!({"refresh_token":session["refresh_token"]}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(refreshed["user"]["id"], session["user"]["id"]);
    let (status, _) = post(
        first,
        "/auth/v1/token?grant_type=password",
        json!({"email":"reuse@example.com","password":password}),
    )
    .await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn failed_promotion_rolls_back_lower_gaps_and_can_be_retried() {
    let database = Database::new().await;
    database
        .client
        .batch_execute("CREATE TABLE nelcota.panel_migrations(blocker integer)")
        .await
        .unwrap();
    assert!(
        db::bootstrap(&database.admin, authenticator_password(), 10)
            .await
            .is_err()
    );
    assert_eq!(
        database.versions().await,
        nelcota_auth::AUTH_MIGRATION_VERSIONS
    );
    let avatar: Option<String> = database
        .client
        .query_one("SELECT to_regclass('nelcota.admin_avatar')::text", &[])
        .await
        .unwrap()
        .get(0);
    assert!(avatar.is_none(), "V4 must roll back when V6 fails");
    database
        .client
        .batch_execute("DROP TABLE nelcota.panel_migrations")
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        db::bootstrap(&database.admin, authenticator_password(), 10),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(database.versions().await, (1..=20).collect::<Vec<_>>());
}

#[tokio::test]
async fn corrupt_history_fails_closed_and_releases_bootstrap_lock() {
    let database = Database::new().await;
    let checksum: String = database
        .client
        .query_one(
            "SELECT checksum FROM nelcota.schema_migrations WHERE version=2",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    database
        .client
        .execute(
            "UPDATE nelcota.schema_migrations SET checksum='0' WHERE version=2",
            &[],
        )
        .await
        .unwrap();
    assert!(matches!(
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10).await,
        Err(db::BootstrapError::History { version: 2, .. })
    ));
    database
        .client
        .execute(
            "UPDATE nelcota.schema_migrations SET checksum=$1 WHERE version=2",
            &[&checksum],
        )
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10),
    )
    .await
    .unwrap()
    .unwrap();
    database.client.batch_execute("INSERT INTO nelcota.schema_migrations VALUES(999,'unknown','2026-10-13T00:00:00Z','0')").await.unwrap();
    assert!(matches!(
        nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10).await,
        Err(db::BootstrapError::History { version: 999, .. })
    ));
}

#[tokio::test]
async fn arbitrary_full_history_gaps_are_not_treated_as_auth_promotion() {
    let database = Database::new().await;
    db::bootstrap(&database.admin, authenticator_password(), 10)
        .await
        .unwrap();
    database
        .client
        .batch_execute("DELETE FROM nelcota.schema_migrations WHERE version=6")
        .await
        .unwrap();
    assert!(
        db::bootstrap(&database.admin, authenticator_password(), 10)
            .await
            .is_err()
    );
    for selection in [&[1, 1][..], &[2][..], &[1, 999][..]] {
        assert!(matches!(
            db::bootstrap_migrations(&database.admin, authenticator_password(), 10, selection)
                .await,
            Err(db::BootstrapError::InvalidSelection(_))
        ));
    }
}

#[tokio::test]
async fn separate_auth_instances_rotate_and_revoke_without_resurrecting_sessions() {
    let database = Database::new().await;
    let keys =
        Arc::new(Keys::new(Some(&nelcota_auth::generate_ed25519_private_key()), None).unwrap());
    let first = nelcota_auth::router(database.state(keys.clone()));
    let second = nelcota_auth::router(database.state(keys));
    let (status, session) = post(
        first.clone(),
        "/auth/v1/signup",
        json!({"email":"race@example.com","password":Uuid::new_v4().to_string()}),
    )
    .await;
    assert_eq!(status, 201);
    let refresh = json!({"refresh_token":session["refresh_token"]});
    let (left, right) = tokio::join!(
        post(
            first.clone(),
            "/auth/v1/token?grant_type=refresh_token",
            refresh.clone()
        ),
        post(
            second.clone(),
            "/auth/v1/token?grant_type=refresh_token",
            refresh
        )
    );
    // The documented retry grace allows both responses; only the newest
    // successor remains usable, with database locks shared across instances.
    assert_eq!(left.0, 200);
    assert_eq!(right.0, 200);
    let live: i64 = database
        .client
        .query_one(
            "SELECT count(*) FROM auth.refresh_tokens WHERE NOT revoked",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(live, 1);
    use tower::ServiceExt;
    let logout = first.oneshot(
        Request::post("/auth/v1/logout")
            .header(
                "authorization",
                format!("Bearer {}", session["access_token"].as_str().unwrap()),
            )
            .body(Body::empty())
            .unwrap(),
    );
    let rotate = post(
        second.clone(),
        "/auth/v1/token?grant_type=refresh_token",
        json!({"refresh_token":right.1["refresh_token"]}),
    );
    let (logout, _) = tokio::join!(logout, rotate);
    assert!(logout.unwrap().status().is_success());
    let revoked: bool = database
        .client
        .query_one(
            "SELECT revoked_at IS NOT NULL FROM auth.sessions LIMIT 1",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(revoked);
    for token in [&left.1["refresh_token"], &right.1["refresh_token"]] {
        assert_eq!(
            post(
                second.clone(),
                "/auth/v1/token?grant_type=refresh_token",
                json!({"refresh_token":token})
            )
            .await
            .0,
            400
        );
    }
}

#[tokio::test]
async fn cancelled_bootstrap_does_not_retain_a_connection_waiting_for_migration_lock() {
    let database = Database::new().await;
    database
        .client
        .batch_execute("SELECT pg_advisory_lock(hashtext('nelcota.migrations'))")
        .await
        .unwrap();
    let admin = database.admin.clone();
    let task =
        tokio::spawn(
            async move { nelcota_auth::bootstrap(&admin, authenticator_password(), 10).await },
        );
    let waiting = || async {
        database.client.query_one("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'", &[]).await.unwrap().get::<_,i64>(0)
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while waiting().await == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "bootstrap did not wait for the lock"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    task.abort();
    let _ = task.await;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while waiting().await > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "cancelled bootstrap retained its connection"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    database
        .client
        .batch_execute("SELECT pg_advisory_unlock(hashtext('nelcota.migrations'))")
        .await
        .unwrap();
    nelcota_auth::bootstrap(&database.admin, authenticator_password(), 10)
        .await
        .unwrap();
}

#[tokio::test]
async fn stopped_runtime_does_not_leave_bootstrap_waiting_for_migration_lock() {
    let database = Database::new().await;
    database
        .client
        .batch_execute("SELECT pg_advisory_lock(hashtext('nelcota.migrations'))")
        .await
        .unwrap();
    let admin = database.admin.clone();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let isolated = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::select! {
                    result = nelcota_auth::bootstrap(&admin, authenticator_password(), 10) => {
                        panic!("Bootstrap bypassed the held migration lock: {result:?}");
                    }
                    _ = stopped => {}
                }
            })
            .await
            .unwrap();
        });
        // Drop immediately: asynchronous Drop cleanup cannot run afterwards.
    });
    let observed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let waiting: i64 = database.client.query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
                &[]).await.unwrap().get(0);
            if waiting > 0 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }).await;
    stop.send(()).unwrap();
    isolated.await.unwrap();
    let cleared = tokio::time::timeout(std::time::Duration::from_secs(4), async {
        loop {
            let waiting: i64 = database.client.query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
                &[]).await.unwrap().get(0);
            if waiting == 0 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }).await;
    database
        .client
        .batch_execute("SELECT pg_advisory_unlock(hashtext('nelcota.migrations'))")
        .await
        .unwrap();
    assert!(
        observed.is_ok(),
        "The fixture must observe bootstrap waiting before stopping its runtime"
    );
    assert!(
        cleared.is_ok(),
        "A stopped runtime left a bootstrap backend waiting"
    );
}
