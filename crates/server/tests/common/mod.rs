//! Integration test harness: starts a real Postgres 17 (testcontainers),
//! applies the migrations and builds the same `Router` as production.
//!
//! Uses Docker by default, or isolated databases in a disposable cluster set
//! through NELCOTA_TEST_DATABASE_URL.
#![allow(dead_code)]

pub mod panel;
mod postgres;

use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use jsonwebtoken::{EncodingKey, Header, get_current_timestamp};
use nelcota_api::{ApiSettings, CatalogHandle, spawn_reload_listener};
use nelcota_auth::{
    AuthSettings, AuthState, Email, Keys, MailError, Mailer, Passwords, RateLimiter,
    generate_ed25519_private_key,
};
use nelcota_core::db;
use nelcota_server::{AppState, app, load_catalog};
use serde_json::{Value, json};
use testcontainers_modules::{
    postgres::Postgres,
    testcontainers::{ContainerAsync, ImageExt, runners::AsyncRunner},
};
use tower::ServiceExt;
use uuid::Uuid;

pub const JWT_SECRET: &str = "test-secret-with-more-than-32-characters";
/// Cluster roles are shared by this process's isolated test databases. Keep
/// one fresh secret per test binary so concurrent bootstraps cannot invalidate
/// another TestApp's API pool.
pub fn authenticator_password() -> &'static str {
    static PASSWORD: OnceLock<String> = OnceLock::new();
    PASSWORD
        .get_or_init(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()))
        .as_str()
}
pub const ADMIN_EMAIL: &str = "admin@example.com";
pub const SSO_SECRET: &str = "host-shared-secret-with-32-chars+";

/// The host's project list used in the tests (this app is "shop").
fn registry_file() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("nelcota-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("projects.json");
    std::fs::write(
        &path,
        json!({
            "panel_login": "shared",
            "projects": [
                { "name": "shop", "url": "https://shop.example.com" },
                { "name": "blog", "url": "https://blog.example.com" },
            ],
        })
        .to_string(),
    )
    .unwrap();
    path
}
pub const ADMIN_PASSWORD: &str = "test-admin-password";

/// App pages that receive the email links in the tests.
pub const RECOVERY_URL: &str = "https://app.example.com/new-password";
pub const CONFIRMATION_URL: &str = "https://app.example.com/confirmed";
pub const MAGIC_LINK_URL: &str = "https://app.example.com/signed-in";

/// Token of an email link (`<page>#type=<kind>&token=<token>`).
pub fn link_token(email: &Email, page: &str, kind: &str) -> String {
    let link = email
        .text
        .split_whitespace()
        .find(|word| word.starts_with(page))
        .unwrap_or_else(|| panic!("no link to {page} in: {}", email.text));
    link.strip_prefix(&format!("{page}#type={kind}&token="))
        .unwrap_or_else(|| panic!("link out of format: {link}"))
        .to_owned()
}

/// Test mailer: keeps the messages instead of sending them.
#[derive(Default)]
pub struct Outbox {
    sent: std::sync::Mutex<Vec<Email>>,
}

impl Outbox {
    pub fn sent(&self) -> Vec<Email> {
        self.sent.lock().unwrap().clone()
    }

    /// Waits until there are `n` messages (sending runs in the background).
    pub async fn wait_for(&self, n: usize) -> Vec<Email> {
        for _ in 0..250 {
            let sent = self.sent();
            if sent.len() >= n {
                return sent;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("expected {n} email(s), got {}", self.sent().len());
    }
}

impl Mailer for Outbox {
    fn send(
        &self,
        email: Email,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), MailError>> + Send + '_>>
    {
        self.sent.lock().unwrap().push(email);
        Box::pin(async { Ok(()) })
    }
}

pub struct Options {
    pub pool_size: usize,
    pub admin_pool_size: usize,
    pub export_timeout: Duration,
    /// Password recovery and magic link on (with the [`Outbox`] instead of SMTP).
    pub mail: bool,
    /// Another mailer for delivery failure and resource-budget tests.
    pub mailer: Option<Arc<dyn Mailer>>,
    /// Signup waits for the email to be confirmed (needs `mail`).
    pub confirm_email: bool,
    /// Sign-in providers (pointed at a local fake).
    pub oauth: Option<Arc<nelcota_auth::OAuth>>,
    pub signup_enabled: bool,
    /// `migrations/` folder the panel sees.
    pub migrations_dir: Option<std::path::PathBuf>,
    pub rate_limit_per_minute: u32,
    pub panel_rate_limit_per_minute: u32,
    pub access_ttl_secs: u64,
    pub max_rows: Option<i64>,
    /// REST body limit (`NELCOTA_MAX_BODY_BYTES`).
    pub max_body_bytes: usize,
    /// Storage limits (on a disk store in a temporary directory).
    pub storage: nelcota_storage::StorageSettings,
    /// Another store instead of the temporary directory (S3 tests).
    pub store: Option<Arc<nelcota_storage::Store>>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            pool_size: 4,
            admin_pool_size: 2,
            export_timeout: Duration::from_secs(120),
            mail: true,
            mailer: None,
            confirm_email: false,
            oauth: None,
            signup_enabled: true,
            migrations_dir: None,
            rate_limit_per_minute: 10_000,
            panel_rate_limit_per_minute: 1000,
            access_ttl_secs: 900,
            max_rows: None,
            max_body_bytes: nelcota_core::config::DEFAULT_MAX_BODY_BYTES,
            storage: nelcota_storage::StorageSettings {
                max_file_size: 1024 * 1024,
                max_total_size: None,
                min_free_bytes: 0,
                public_url: None,
                upload_timeout: Duration::from_secs(30),
            },
            store: None,
        }
    }
}

pub struct TestApp {
    pub router: Router,
    /// Shared panel dependencies for dedicated-connection transport controls.
    pub panel: nelcota_admin::AdminState,
    pub pool: deadpool_postgres::Pool,
    pub admin_pool: deadpool_postgres::Pool,
    pub admin: tokio_postgres::Config,
    pub admin_client: tokio_postgres::Client,
    pub keys: Arc<Keys>,
    pub catalog: Arc<CatalogHandle>,
    pub user_a: Uuid,
    pub user_b: Uuid,
    pub outbox: Arc<Outbox>,
    pub storage: nelcota_storage::StorageState,
    /// Root of the disk store.
    pub storage_dir: std::path::PathBuf,
    _container: Option<ContainerAsync<Postgres>>,
    _external_database: Option<postgres::ExternalDatabase>,
    _reload_listener: nelcota_api::ReloadListener,
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
    pub text: String,
}

impl TestApp {
    pub async fn spawn() -> Self {
        Self::spawn_with(Options::default()).await
    }

    pub async fn spawn_with(options: Options) -> Self {
        let (container, external_database, admin) = match std::env::var("NELCOTA_TEST_DATABASE_URL")
        {
            Ok(url) => {
                let database = postgres::ExternalDatabase::create(&url).await;
                let config = database.config();
                (None, Some(database), config)
            }
            _ => {
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
                    .expect("Docker must be running for the integration tests");
                let host = container.get_host().await.unwrap();
                let port = container.get_host_port_ipv4(5432).await.unwrap();
                let admin: tokio_postgres::Config =
                    format!("postgres://postgres:postgres@{host}:{port}/postgres")
                        .parse()
                        .unwrap();
                (Some(container), None, admin)
            }
        };

        if external_database.is_none() {
            db::bootstrap(&admin, authenticator_password(), 10)
                .await
                .unwrap();
        }

        // Fixture: the example table + one row per user, inserted as the
        // superuser (which bypasses RLS).
        let (user_a, user_b) = (Uuid::new_v4(), Uuid::new_v4());
        let (admin_client, connection) = admin.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(connection);
        admin_client
            .batch_execute(include_str!("../../../../examples/todos.sql"))
            .await
            .unwrap();
        admin_client
            .batch_execute(include_str!("../fixtures/api.sql"))
            .await
            .unwrap();
        admin_client
            .execute(
                "INSERT INTO public.todos (user_id, title) VALUES ($1, 'task of A'), ($2, 'task of B')",
                &[&user_a, &user_b],
            )
            .await
            .unwrap();

        // Signs with EdDSA (as in production) and also accepts HS256, so the
        // tests can mint arbitrary tokens with `token()`.
        let keys = Arc::new(
            Keys::new(
                Some(&generate_ed25519_private_key()),
                Some(JWT_SECRET.as_bytes()),
            )
            .unwrap(),
        );
        let pool = db::api_pool(&admin, authenticator_password(), options.pool_size);
        let catalog = load_catalog(&pool, "public").await.unwrap();
        let reload_listener = spawn_reload_listener(
            catalog.clone(),
            pool.clone(),
            db::authenticator_config(&admin, authenticator_password()),
        );
        let state = AppState {
            pool: pool.clone(),
            verifier: keys.clone(),
            catalog: catalog.clone(),
            api: Arc::new(ApiSettings {
                max_rows: options.max_rows,
                max_body_bytes: options.max_body_bytes,
            }),
        };
        let passwords = Arc::new(Passwords::new(2));
        let admin_pool = db::admin_pool(&admin, options.admin_pool_size);
        let panel = nelcota_admin::AdminState {
            webhooks: nelcota_webhooks::destination::Policy::default(),
            sql: Arc::default(),
            exports: Arc::new(nelcota_admin::ExportExecutor::new(options.export_timeout)),
            db: admin_pool.clone(),
            db_config: admin.clone(),
            catalog: catalog.clone(),
            credentials: Arc::new(nelcota_admin::Credentials {
                email: ADMIN_EMAIL.into(),
                password_hash: nelcota_auth::hash_password(ADMIN_PASSWORD).unwrap(),
            }),
            sessions: Arc::default(),
            limiter: Arc::new(RateLimiter::new(options.panel_rate_limit_per_minute)),
            passwords: passwords.clone(),
            trust_proxy: false,
            secure_cookies: false,
            host: Arc::new(nelcota_admin::HostLink {
                project: "shop".into(),
                registry: Some(registry_file()),
                sso: Some(nelcota_admin::Sso::new(SSO_SECRET.as_bytes())),
            }),
            tokens: Arc::new(nelcota_admin::TokenIssuer {
                keys: keys.clone(),
                issuer: "nelcota-test".into(),
            }),
            migrations_dir: options.migrations_dir.clone(),
            storage: None,
            sign_in: Arc::new(nelcota_admin::contracts::SignIn {
                signup_enabled: options.signup_enabled,
                email: options.mail,
                email_confirmation: options.mail && options.confirm_email,
                password_recovery: options.mail,
                magic_link: options.mail,
                providers: nelcota_admin::contracts::SignInProviders {
                    google: false,
                    github: options.oauth.is_some(),
                },
                redirect_urls: Vec::new(),
                callback_url: None,
                access_ttl_secs: options.access_ttl_secs,
                refresh_ttl_days: 30,
                rate_limit_per_minute: options.rate_limit_per_minute,
            }),
            denied: Arc::default(),
            metrics: Arc::default(),
        };
        let outbox = Arc::new(Outbox::default());
        let auth = AuthState {
            mail_delivery: Arc::default(),
            mailer: options.mail.then(|| {
                options
                    .mailer
                    .clone()
                    .unwrap_or_else(|| outbox.clone() as Arc<dyn Mailer>)
            }),
            oauth: options.oauth.clone(),
            pool: pool.clone(),
            keys: keys.clone(),
            passwords,
            limiter: Arc::new(RateLimiter::new(options.rate_limit_per_minute)),
            session_limiter: Arc::new(RateLimiter::new(
                options
                    .rate_limit_per_minute
                    .saturating_mul(nelcota_auth::SESSION_RATE_LIMIT_FACTOR),
            )),
            settings: Arc::new(AuthSettings {
                issuer: "nelcota-test".into(),
                access_ttl_secs: options.access_ttl_secs,
                refresh_ttl_days: 30,
                signup_enabled: options.signup_enabled,
                trust_proxy: false,
                links: nelcota_auth::EmailLinks {
                    recovery: options.mail.then(|| RECOVERY_URL.to_owned()),
                    signup_confirmation: (options.mail && options.confirm_email)
                        .then(|| CONFIRMATION_URL.to_owned()),
                    magic_link: options.mail.then(|| MAGIC_LINK_URL.to_owned()),
                },
            }),
        };
        let storage_dir = std::env::temp_dir().join(format!("nelcota-storage-{}", Uuid::new_v4()));
        let store = match options.store.clone() {
            Some(store) => store,
            None => Arc::new(nelcota_storage::Store::disk(storage_dir.clone()).unwrap()),
        };
        let storage = nelcota_storage::StorageState::new(
            pool.clone(),
            keys.clone(),
            store,
            options.storage.clone(),
        );
        let panel = nelcota_admin::AdminState {
            storage: Some(storage.clone()),
            ..panel
        };
        TestApp {
            panel: panel.clone(),
            router: app(
                state,
                auth,
                Some(panel),
                Some(storage.clone()),
                Duration::from_secs(10),
            ),
            storage,
            storage_dir,
            pool,
            admin_pool,
            admin,
            admin_client,
            keys,
            catalog,
            user_a,
            user_b,
            outbox,
            _container: container,
            _external_database: external_database,
            _reload_listener: reload_listener,
        }
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Reply {
        self.request_with(method, path, token, body, &[]).await
    }

    pub async fn request_with(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
        extra_headers: &[(&str, &str)],
    ) -> Reply {
        let mut request = Request::builder().method(method).uri(encode_uri(path));
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let body = match body {
            Some(json) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply {
            status,
            headers,
            body,
            text: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }

    /// Request with an arbitrary body (panel forms).
    pub async fn raw(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: String,
    ) -> Reply {
        let mut request = Request::builder().method(method).uri(encode_uri(path));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            headers,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            text: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }

    /// Request with a raw body, returning the raw response bytes (files).
    pub async fn bytes(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        headers: &[(&str, &str)],
        body: Vec<u8>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::builder().method(method).uri(encode_uri(path));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, bytes.to_vec())
    }

    pub async fn get(&self, path: &str, token: Option<&str>) -> (StatusCode, Value) {
        let reply = self.request(Method::GET, path, token, None).await;
        (reply.status, reply.body)
    }

    pub async fn post(&self, path: &str, token: Option<&str>, body: Value) -> Reply {
        self.request(Method::POST, path, token, Some(body)).await
    }
}

/// Percent-encodes the bytes that cannot appear raw in a URI (space, quotes,
/// accents...), so the tests can write readable queries.
pub fn encode_uri(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b' ' | b'"' | b'\\' | b'<' | b'>' | b'`' | b'{' | b'}' | b'|' | b'^' | 0x80.. => {
                format!("%{b:02X}")
            }
            _ => (b as char).to_string(),
        })
        .collect()
}

/// HS256 JWT with the given claims (default `exp`: 1 hour from now).
pub fn token(claims: Value) -> String {
    token_with_secret(claims, JWT_SECRET)
}

pub fn token_with_secret(mut claims: Value, secret: &str) -> String {
    if claims.get("exp").is_none() {
        claims["exp"] = json!(get_current_timestamp() + 3600);
    }
    jsonwebtoken::encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

pub fn user_token(sub: Uuid) -> String {
    token(json!({ "role": "authenticated", "sub": sub }))
}

pub fn service_token() -> String {
    token(json!({ "role": "service_role" }))
}
