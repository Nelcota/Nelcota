//! Configuration from environment variables (`NELCOTA_*`) and, optionally, a
//! TOML file (`nelcota.toml` or the path in `NELCOTA_CONFIG`). Environment
//! variables take precedence over the file.

use std::{fmt, net::SocketAddr, str::FromStr};

use figment::{
    Figment,
    providers::{Env, Format, Serialized, Toml},
};
use serde::{Deserialize, Serialize};

/// Validate a positive day interval against PostgreSQL 17's timestamp horizon.
/// Its exclusive upper bound is 294277-01-01 UTC. Keep one day of headroom
/// for fractional seconds and timezone changes when adding a day interval.
pub fn refresh_lifetime_is_representable(now: u64, days: u32) -> bool {
    const END_UNIX_SECS: u64 = 9_224_318_016_000;
    if days == 0 || i32::try_from(days).is_err() {
        return false;
    }
    now.checked_add(u64::from(days) * 86_400)
        .is_some_and(|expires| expires < END_UNIX_SECS - 86_400)
}

/// Sensitive value: never shows in `Debug` (and therefore never reaches a log).
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    #[default]
    Text,
    Json,
}

/// Where storage keeps the bytes (D77).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageBackend {
    /// No storage routes.
    #[default]
    Off,
    /// A local directory (`NELCOTA_STORAGE_DIR`).
    Disk,
    /// An S3-compatible bucket (`NELCOTA_STORAGE_S3_*`).
    S3,
}

/// Default REST body limit: axum's own default, which the API always had.
/// A body is buffered and parsed whole, and a 1000-row insert of typical
/// rows fits well under it; raise it for larger batches if memory allows.
pub const DEFAULT_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Upper bound of `NELCOTA_TRUSTED_PROXY_HOPS`; real chains are 1 or 2 deep.
pub const MAX_PROXY_HOPS: u8 = 8;
/// Upper bound for the statement and upload timeouts: one day. Larger values
/// overflow PostgreSQL's millisecond statement_timeout or a deadline instant.
pub const MAX_TIMEOUT_SECS: u64 = 86_400;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Config {
    /// Postgres URL with a role that owns the schema (used only for migrations
    /// and to set the `authenticator` role password). The API connects to the
    /// same host/database, but as `authenticator`.
    pub database_url: Secret,
    /// Password of the `authenticator` role.
    pub authenticator_password: Secret,
    /// Ed25519 private key (PKCS#8, as PEM or one-line base64) used to sign the
    /// JWTs (EdDSA). The public key is published in the JWKS.
    pub jwt_private_key: Option<Secret>,
    /// HS256 secret (simple/legacy mode). With an EdDSA key it is only used to
    /// VERIFY old tokens; otherwise it also signs.
    pub jwt_secret: Option<Secret>,
    /// `iss` claim of issued tokens.
    pub jwt_issuer: String,
    /// Lifetime of the access JWT, in seconds.
    pub jwt_expiry_secs: u64,
    /// Lifetime of the refresh token (renewed on each rotation), in days.
    pub refresh_token_ttl_days: u32,
    pub signup_enabled: bool,
    /// Requests per minute, per IP, on the login/signup endpoints.
    pub auth_rate_limit_per_minute: u32,
    /// Requests per minute, per IP, on the REST and storage APIs; 0 turns
    /// the limit off. `service_role` tokens are exempt.
    pub api_rate_limit_per_minute: u32,
    /// Trust `X-Forwarded-For` (only behind a proxy such as Caddy).
    pub trust_proxy: bool,
    /// With `trust_proxy`, how many trusted proxies append to
    /// `X-Forwarded-For`: 1 for Caddy alone, 2 for a CDN in front of Caddy.
    pub trusted_proxy_hops: u8,
    /// SMTP for auth emails, as `smtps://user:password@host:465` (or
    /// `smtp://...:587?tls=required`). Without it, password recovery is off.
    pub smtp_url: Option<Secret>,
    /// Sender of the emails: `Shop <no-reply@shop.com>`.
    pub smtp_from: Option<String>,
    /// Additional PEM trust anchor for a private SMTP server. TLS validation stays enabled.
    pub smtp_ca_file: Option<std::path::PathBuf>,
    /// App page that receives the password recovery link. The token goes in the
    /// fragment (`#type=recovery&token=...`), which never reaches a server.
    pub password_recovery_url: Option<String>,
    /// App page that receives the signup confirmation link. Setting it makes
    /// signup wait for the email to be confirmed before password sign-in.
    pub email_confirmation_url: Option<String>,
    /// App page that receives the magic link (passwordless sign-in). Without
    /// it, `/auth/v1/magiclink` is off.
    pub magic_link_url: Option<String>,
    /// Public origin of this API (`https://api.shop.com`): sign-in providers
    /// send people back to `<api_url>/auth/v1/callback`.
    pub api_url: Option<String>,
    /// App pages a provider sign-in may return to, comma separated. A
    /// `redirect_to` must sit under one of them (same origin, path below).
    pub oauth_redirect_urls: Option<String>,
    pub oauth_google_client_id: Option<String>,
    pub oauth_google_client_secret: Option<Secret>,
    pub oauth_github_client_id: Option<String>,
    pub oauth_github_client_secret: Option<Secret>,
    /// Panel login (separate from end users). Without both, the panel is off.
    pub admin_email: Option<String>,
    /// PHC argon2id hash of the admin password (generated by `nelcota init`).
    pub admin_password_hash: Option<Secret>,
    /// Secret shared by the projects of one host for the panel's single sign-on
    /// (SSO handoff). Absent = per-project login.
    pub admin_sso_secret: Option<Secret>,
    /// Name of this project on the host (`nelcota init --project`).
    pub project_name: Option<String>,
    /// Public list of the host's projects (name + URL), for the panel switcher.
    pub host_registry: Option<std::path::PathBuf>,
    /// The project's `migrations/` folder, read by the panel when generating
    /// migrations. In the project container, `/migrations` is detected on its own.
    pub migrations_dir: Option<std::path::PathBuf>,
    /// Require application schema changes to arrive through migrations.
    pub production: bool,
    /// Project-scoped local backup agent. Production writes fail closed without it.
    pub migration_backup_socket: Option<std::path::PathBuf>,
    pub migration_backup_token: Option<Secret>,
    /// Local CLI-owned application folder; cannot be enabled through configuration.
    #[serde(skip)]
    pub dev_migrations_dir: Option<std::path::PathBuf>,
    /// Schema exposed by the REST API.
    pub db_schema: String,
    /// Row cap per API collection (`None` uses 1000).
    pub max_rows: Option<i64>,
    /// Largest REST request body (`/rest/v1`), in bytes.
    pub max_body_bytes: usize,
    /// REST requests one caller (a signed-in user, or one client network)
    /// may run at once. `None` uses half of the pool, at least 1; 0
    /// disables the limit. See [`Config::api_concurrency_limit`].
    pub api_concurrency_per_caller: Option<usize>,
    pub listen: SocketAddr,
    pub db_pool_size: usize,
    pub request_timeout_secs: u64,
    /// `statement_timeout` of the API connections.
    pub statement_timeout_secs: u64,
    pub log_format: LogFormat,
    /// Development-only HTTP webhooks to localhost/127.0.0.1/::1. LAN and
    /// metadata addresses stay blocked. Public destinations require HTTPS.
    pub webhooks_allow_loopback: bool,
    /// Controller-owned validation gate; background effects wait for commit.
    pub deployment_validation: bool,
    pub deployment_gate: Option<std::path::PathBuf>,
    /// Binds the gate to exactly one candidate, including after rollback.
    pub deployment_id: Option<String>,
    /// File storage: `off`, `disk` or `s3`.
    pub storage_backend: StorageBackend,
    /// Directory of the disk backend.
    pub storage_dir: Option<std::path::PathBuf>,
    /// S3 endpoint (`https://<account>.r2.cloudflarestorage.com`); empty = AWS.
    pub storage_s3_endpoint: Option<String>,
    pub storage_s3_bucket: Option<String>,
    pub storage_s3_region: String,
    pub storage_s3_access_key_id: Option<String>,
    pub storage_s3_secret_access_key: Option<Secret>,
    /// `bucket.endpoint` URLs instead of `endpoint/bucket`.
    pub storage_s3_virtual_hosted: bool,
    /// Largest file accepted, in bytes (a bucket can only lower it).
    pub storage_max_file_size: u64,
    /// Cap on the bytes of all buckets together (`None` = no cap).
    pub storage_max_total_size: Option<u64>,
    /// Disk backend: refuse an upload that would leave less free space.
    pub storage_min_free_bytes: u64,
    /// Origin of public file URLs (e.g. `https://files.shop.com`); `None` =
    /// the API's own.
    pub storage_public_url: Option<String>,
    /// Longest an upload may take, in seconds.
    pub storage_upload_timeout_secs: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(transparent)]
    Load(#[from] Box<figment::Error>),
    #[error("{0}")]
    Invalid(&'static str),
    #[error("invalid NELCOTA_DATABASE_URL: {0}")]
    DatabaseUrl(tokio_postgres::Error),
}

impl Default for Config {
    fn default() -> Self {
        Config {
            database_url: Secret::default(),
            authenticator_password: Secret::default(),
            jwt_private_key: None,
            jwt_secret: None,
            jwt_issuer: "nelcota".into(),
            jwt_expiry_secs: 900,
            refresh_token_ttl_days: 30,
            signup_enabled: true,
            auth_rate_limit_per_minute: 30,
            api_rate_limit_per_minute: 600,
            trust_proxy: false,
            trusted_proxy_hops: 1,
            smtp_url: None,
            smtp_from: None,
            smtp_ca_file: None,
            password_recovery_url: None,
            email_confirmation_url: None,
            magic_link_url: None,
            api_url: None,
            oauth_redirect_urls: None,
            oauth_google_client_id: None,
            oauth_google_client_secret: None,
            oauth_github_client_id: None,
            oauth_github_client_secret: None,
            admin_email: None,
            admin_password_hash: None,
            admin_sso_secret: None,
            project_name: None,
            host_registry: None,
            migrations_dir: None,
            production: false,
            migration_backup_socket: None,
            migration_backup_token: None,
            dev_migrations_dir: None,
            db_schema: "public".into(),
            max_rows: Some(1000),
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            api_concurrency_per_caller: None,
            listen: SocketAddr::from(([0, 0, 0, 0], 8000)),
            db_pool_size: 10,
            request_timeout_secs: 15,
            statement_timeout_secs: 10,
            log_format: LogFormat::Text,
            webhooks_allow_loopback: false,
            deployment_validation: false,
            deployment_gate: None,
            deployment_id: None,
            storage_backend: StorageBackend::Off,
            storage_dir: None,
            storage_s3_endpoint: None,
            storage_s3_bucket: None,
            storage_s3_region: "auto".into(),
            storage_s3_access_key_id: None,
            storage_s3_secret_access_key: None,
            storage_s3_virtual_hosted: false,
            storage_max_file_size: 50 * 1024 * 1024,
            storage_max_total_size: None,
            storage_min_free_bytes: 1024 * 1024 * 1024,
            storage_public_url: None,
            storage_upload_timeout_secs: 3600,
        }
    }
}

impl Config {
    pub fn load() -> Result<Self, ConfigError> {
        let file = std::env::var("NELCOTA_CONFIG").unwrap_or_else(|_| "nelcota.toml".into());
        let config: Config = Figment::from(Serialized::defaults(Config::default()))
            .merge(Toml::file(file))
            .merge(Env::prefixed("NELCOTA_").ignore(&["config"]))
            .extract()
            .map_err(Box::new)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.deployment_validation && !cfg!(target_os = "linux") {
            return Err(ConfigError::Invalid(
                "deployment validation requires the Linux controller",
            ));
        }
        if self.deployment_validation
            && self.deployment_id.as_ref().is_none_or(|id| {
                id.len() != 64
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
        {
            return Err(ConfigError::Invalid(
                "deployment validation requires a candidate identity",
            ));
        }
        if self.deployment_validation
            && self
                .deployment_gate
                .as_ref()
                .is_none_or(|path| !path.is_absolute())
        {
            return Err(ConfigError::Invalid(
                "deployment validation requires an absolute controller-owned gate",
            ));
        }
        if self.database_url.expose().is_empty() {
            return Err(ConfigError::Invalid("NELCOTA_DATABASE_URL is required"));
        }
        if self.authenticator_password.expose().len() < 16 {
            return Err(ConfigError::Invalid(
                "NELCOTA_AUTHENTICATOR_PASSWORD needs at least 16 characters",
            ));
        }
        match (self.jwt_private_key(), self.jwt_secret()) {
            (None, None) => {
                return Err(ConfigError::Invalid(
                    "set NELCOTA_JWT_PRIVATE_KEY (recommended) or NELCOTA_JWT_SECRET",
                ));
            }
            (_, Some(secret)) if secret.len() < 32 => {
                return Err(ConfigError::Invalid(
                    "NELCOTA_JWT_SECRET needs at least 32 characters",
                ));
            }
            _ => {}
        }
        if self.jwt_expiry_secs == 0 || self.refresh_token_ttl_days == 0 {
            return Err(ConfigError::Invalid(
                "NELCOTA_JWT_EXPIRY_SECS and NELCOTA_REFRESH_TOKEN_TTL_DAYS must be > 0",
            ));
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| ConfigError::Invalid("system clock is before the Unix epoch"))?
            .as_secs();
        if now.checked_add(self.jwt_expiry_secs).is_none()
            || !refresh_lifetime_is_representable(now, self.refresh_token_ttl_days)
        {
            return Err(ConfigError::Invalid(
                "auth token lifetimes exceed their representable range",
            ));
        }
        if self.db_pool_size == 0 {
            return Err(ConfigError::Invalid("NELCOTA_DB_POOL_SIZE must be > 0"));
        }
        if self.max_rows.is_some_and(|rows| rows <= 0) {
            return Err(ConfigError::Invalid("NELCOTA_MAX_ROWS must be > 0"));
        }
        if self.max_body_bytes == 0 {
            return Err(ConfigError::Invalid("NELCOTA_MAX_BODY_BYTES must be > 0"));
        }
        if self.request_timeout_secs == 0 {
            return Err(ConfigError::Invalid(
                "NELCOTA_REQUEST_TIMEOUT_SECS must be > 0",
            ));
        }
        // The statement must time out first, so a slow query answers its own
        // 504 and its transaction ends, instead of the request being dropped
        // while Postgres keeps working (0 turns the statement timeout off).
        if self.statement_timeout_secs > MAX_TIMEOUT_SECS {
            return Err(ConfigError::Invalid(
                "NELCOTA_STATEMENT_TIMEOUT_SECS must be at most 86400 (one day)",
            ));
        }
        if self.statement_timeout_secs > 0
            && self.request_timeout_secs <= self.statement_timeout_secs
        {
            return Err(ConfigError::Invalid(
                "NELCOTA_REQUEST_TIMEOUT_SECS must be greater than NELCOTA_STATEMENT_TIMEOUT_SECS",
            ));
        }
        if self.auth_rate_limit_per_minute == 0 {
            return Err(ConfigError::Invalid(
                "NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE must be > 0 (requests per minute per IP)",
            ));
        }
        // Loopback webhooks allow plain HTTP to any local port: never in production.
        if self.production && self.webhooks_allow_loopback {
            return Err(ConfigError::Invalid(
                "NELCOTA_WEBHOOKS_ALLOW_LOOPBACK=true is development-only; \
                 unset it or set NELCOTA_PRODUCTION=false",
            ));
        }
        if self.trust_proxy && !(1..=MAX_PROXY_HOPS).contains(&self.trusted_proxy_hops) {
            return Err(ConfigError::Invalid(
                "NELCOTA_TRUSTED_PROXY_HOPS must be between 1 and 8 with NELCOTA_TRUST_PROXY",
            ));
        }
        if self.migration_backup_socket.is_some() != self.migration_backup_token.is_some()
            || crate::migration_backup::BackupAgent::from_config(self)
                .is_some_and(|agent| !agent.valid())
        {
            return Err(ConfigError::Invalid(
                "migration backup requires an absolute socket path and a 64-character hexadecimal token",
            ));
        }
        self.mail()?;
        self.validate_storage()?;
        self.database_config()?;
        Ok(())
    }

    fn validate_storage(&self) -> Result<(), ConfigError> {
        let set = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.trim().is_empty());
        match self.storage_backend {
            StorageBackend::Off => return Ok(()),
            StorageBackend::Disk if self.storage_dir.is_none() => {
                return Err(ConfigError::Invalid(
                    "NELCOTA_STORAGE_BACKEND=disk needs NELCOTA_STORAGE_DIR",
                ));
            }
            StorageBackend::S3
                if !set(&self.storage_s3_bucket)
                    || !set(&self.storage_s3_access_key_id)
                    || non_empty(&self.storage_s3_secret_access_key).is_none() =>
            {
                return Err(ConfigError::Invalid(
                    "NELCOTA_STORAGE_BACKEND=s3 needs NELCOTA_STORAGE_S3_BUCKET, \
                     NELCOTA_STORAGE_S3_ACCESS_KEY_ID and NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY",
                ));
            }
            _ => {}
        }
        if self.storage_max_file_size == 0 || self.storage_upload_timeout_secs == 0 {
            return Err(ConfigError::Invalid(
                "NELCOTA_STORAGE_MAX_FILE_SIZE and NELCOTA_STORAGE_UPLOAD_TIMEOUT_SECS must be > 0",
            ));
        }
        if self.storage_upload_timeout_secs > MAX_TIMEOUT_SECS {
            return Err(ConfigError::Invalid(
                "NELCOTA_STORAGE_UPLOAD_TIMEOUT_SECS must be at most 86400 (one day)",
            ));
        }
        if let Some(url) = self.storage_public_url.as_deref().map(str::trim)
            && !url.is_empty()
            && !(url.starts_with("https://") || url.starts_with("http://"))
        {
            return Err(ConfigError::Invalid(
                "NELCOTA_STORAGE_PUBLIC_URL must be an http(s) URL",
            ));
        }
        Ok(())
    }

    /// Trusted proxies in front of the server for reading the client IP:
    /// 0 without `trust_proxy`, `trusted_proxy_hops` with it.
    pub fn proxy_hops(&self) -> u8 {
        match self.trust_proxy {
            true => self.trusted_proxy_hops,
            false => 0,
        }
    }

    /// Whether panel session cookies carry `Secure`: behind a trusted proxy,
    /// or when the public origin (`api_url`) is HTTPS. A TLS-terminating proxy
    /// that is not trusted for client IPs still serves the panel over HTTPS.
    pub fn secure_cookies(&self) -> bool {
        if self.trust_proxy {
            return true;
        }
        trimmed(&self.api_url).is_some_and(|url| {
            url.get(..8)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
        })
    }

    /// Configured EdDSA key (an empty variable counts as absent).
    pub fn jwt_private_key(&self) -> Option<&str> {
        non_empty(&self.jwt_private_key)
    }

    /// Configured HS256 secret (an empty variable counts as absent).
    pub fn jwt_secret(&self) -> Option<&str> {
        non_empty(&self.jwt_secret)
    }

    /// Auth email: `None` when not configured; an error when half configured
    /// (better to fail at startup than on the first "forgot my password").
    pub fn mail(&self) -> Result<Option<MailConfig<'_>>, ConfigError> {
        let url = non_empty(&self.smtp_url);
        let from = trimmed(&self.smtp_from);
        let recovery = trimmed(&self.password_recovery_url);
        let confirmation = trimmed(&self.email_confirmation_url);
        let magic_link = trimmed(&self.magic_link_url);
        let any_page = recovery.is_some() || confirmation.is_some() || magic_link.is_some();
        let (url, from) = match (url, from) {
            (None, None) if !any_page => return Ok(None),
            (Some(url), Some(from)) => (url, from),
            (None, None) => {
                return Err(ConfigError::Invalid(
                    "the email link pages need NELCOTA_SMTP_URL and NELCOTA_SMTP_FROM",
                ));
            }
            _ => {
                return Err(ConfigError::Invalid(
                    "set NELCOTA_SMTP_URL and NELCOTA_SMTP_FROM together (or neither)",
                ));
            }
        };
        let recovery_url = match recovery {
            Some(recovery_url) => recovery_url,
            _ => {
                return Err(ConfigError::Invalid(
                    "with SMTP configured, set NELCOTA_PASSWORD_RECOVERY_URL (the app page that receives the link)",
                ));
            }
        };
        Ok(Some(MailConfig {
            smtp_url: url,
            from,
            recovery_url: link_page(
                recovery_url,
                "NELCOTA_PASSWORD_RECOVERY_URL must be an http(s) URL without a fragment (#)",
            )?,
            confirmation_url: confirmation
                .map(|page| {
                    link_page(
                        page,
                        "NELCOTA_EMAIL_CONFIRMATION_URL must be an http(s) URL without a fragment (#)",
                    )
                })
                .transpose()?,
            magic_link_url: magic_link
                .map(|page| {
                    link_page(
                        page,
                        "NELCOTA_MAGIC_LINK_URL must be an http(s) URL without a fragment (#)",
                    )
                })
                .transpose()?,
        }))
    }

    /// Provider sign-in: `None` without providers; an error when a provider is
    /// half configured or the URLs around the flow are missing.
    pub fn oauth(&self) -> Result<Option<OAuthConfig<'_>>, ConfigError> {
        let google = client(
            &self.oauth_google_client_id,
            &self.oauth_google_client_secret,
            "set NELCOTA_OAUTH_GOOGLE_CLIENT_ID and NELCOTA_OAUTH_GOOGLE_CLIENT_SECRET together",
        )?;
        let github = client(
            &self.oauth_github_client_id,
            &self.oauth_github_client_secret,
            "set NELCOTA_OAUTH_GITHUB_CLIENT_ID and NELCOTA_OAUTH_GITHUB_CLIENT_SECRET together",
        )?;
        if google.is_none() && github.is_none() {
            return Ok(None);
        }
        let api_url = trimmed(&self.api_url)
            .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
            .ok_or(ConfigError::Invalid(
                "sign-in providers need NELCOTA_API_URL, this API's public http(s) origin",
            ))?;
        let redirect_urls: Vec<&str> = trimmed(&self.oauth_redirect_urls)
            .map(|list| {
                list.split(',')
                    .map(str::trim)
                    .filter(|url| !url.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if redirect_urls.is_empty() {
            return Err(ConfigError::Invalid(
                "sign-in providers need NELCOTA_OAUTH_REDIRECT_URLS, the app pages a sign-in may return to",
            ));
        }
        Ok(Some(OAuthConfig {
            api_url,
            redirect_urls,
            google,
            github,
        }))
    }

    /// Concurrent REST requests per caller; 0 means unlimited. By default half
    /// of `NELCOTA_DB_POOL_SIZE` (at least 1): one caller cannot keep every
    /// pooled connection busy, while a server rendering pages with the
    /// anonymous key, which counts as one caller, still has room.
    pub fn api_concurrency_limit(&self) -> usize {
        self.api_concurrency_per_caller
            .unwrap_or((self.db_pool_size / 2).max(1))
    }

    pub fn database_config(&self) -> Result<tokio_postgres::Config, ConfigError> {
        tokio_postgres::Config::from_str(self.database_url.expose())
            .map_err(ConfigError::DatabaseUrl)
    }
}

/// Validated auth email settings (see [`Config::mail`]).
pub struct MailConfig<'a> {
    pub smtp_url: &'a str,
    pub from: &'a str,
    pub recovery_url: &'a str,
    pub confirmation_url: Option<&'a str>,
    pub magic_link_url: Option<&'a str>,
}

impl fmt::Debug for MailConfig<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MailConfig")
            .field("confirmation_enabled", &self.confirmation_url.is_some())
            .field("magic_link_enabled", &self.magic_link_url.is_some())
            .finish_non_exhaustive()
    }
}

/// Validated provider sign-in settings (see [`Config::oauth`]).
pub struct OAuthConfig<'a> {
    pub api_url: &'a str,
    pub redirect_urls: Vec<&'a str>,
    /// Client id and secret of each enabled provider.
    pub google: Option<(&'a str, &'a str)>,
    pub github: Option<(&'a str, &'a str)>,
}

impl fmt::Debug for OAuthConfig<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthConfig")
            .field("google_enabled", &self.google.is_some())
            .field("github_enabled", &self.github.is_some())
            .finish_non_exhaustive()
    }
}

fn client<'a>(
    id: &'a Option<String>,
    secret: &'a Option<Secret>,
    incomplete: &'static str,
) -> Result<Option<(&'a str, &'a str)>, ConfigError> {
    match (trimmed(id), non_empty(secret)) {
        (Some(id), Some(secret)) => Ok(Some((id, secret))),
        (None, None) => Ok(None),
        _ => Err(ConfigError::Invalid(incomplete)),
    }
}

/// An app page that receives a link: the token is appended as the fragment,
/// so the page must not carry one.
fn link_page<'a>(page: &'a str, invalid: &'static str) -> Result<&'a str, ConfigError> {
    let http = page.starts_with("https://") || page.starts_with("http://");
    if !http || page.contains('#') {
        return Err(ConfigError::Invalid(invalid));
    }
    Ok(page)
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn non_empty(value: &Option<Secret>) -> Option<&str> {
    value
        .as_ref()
        .map(|s| s.expose().trim())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest configuration that passes `validate`.
    fn valid() -> Config {
        Config {
            database_url: Secret::new("postgres://u:p@localhost/db"),
            authenticator_password: Secret::new("a-password-of-16+"),
            jwt_secret: Some(Secret::new("a-secret-with-at-least-32-characters")),
            ..Config::default()
        }
    }

    #[test]
    fn token_lifetimes_cannot_overflow() {
        for value in [
            Config {
                jwt_expiry_secs: u64::MAX,
                ..valid()
            },
            Config {
                refresh_token_ttl_days: u32::MAX,
                ..valid()
            },
            Config {
                refresh_token_ttl_days: i32::MAX as u32,
                ..valid()
            },
        ] {
            assert!(value.validate().is_err());
        }
    }

    #[test]
    fn refresh_lifetime_respects_timestamp_headroom_and_checked_addition() {
        let now = 1_791_849_600;
        let maximum = ((9_224_318_016_000 - 86_400 - now - 1) / 86_400) as u32;
        assert!(refresh_lifetime_is_representable(now, maximum));
        assert!(!refresh_lifetime_is_representable(now, maximum + 1));
        assert!(!refresh_lifetime_is_representable(now, 0));
        assert!(!refresh_lifetime_is_representable(u64::MAX, 1));
    }

    #[test]
    fn body_limit_must_be_positive() {
        assert!(valid().validate().is_ok());
        assert_eq!(valid().max_body_bytes, 2 * 1024 * 1024);
        let zero = Config {
            max_body_bytes: 0,
            ..valid()
        };
        assert!(zero.validate().is_err());
    }

    #[test]
    fn api_concurrency_defaults_to_half_of_the_pool() {
        let config = |db_pool_size, api_concurrency_per_caller| Config {
            db_pool_size,
            api_concurrency_per_caller,
            ..valid()
        };
        assert_eq!(config(10, None).api_concurrency_limit(), 5);
        assert_eq!(config(40, None).api_concurrency_limit(), 20);
        assert_eq!(config(1, None).api_concurrency_limit(), 1);
        assert_eq!(config(10, Some(0)).api_concurrency_limit(), 0);
        assert_eq!(config(10, Some(7)).api_concurrency_limit(), 7);
        assert!(config(10, Some(0)).validate().is_ok());
    }

    #[test]
    fn timeouts_and_rate_limit_are_checked() {
        for invalid in [
            Config {
                request_timeout_secs: 0,
                ..valid()
            },
            Config {
                request_timeout_secs: 10,
                statement_timeout_secs: 10,
                ..valid()
            },
            Config {
                auth_rate_limit_per_minute: 0,
                ..valid()
            },
            Config {
                trust_proxy: true,
                trusted_proxy_hops: 0,
                ..valid()
            },
            Config {
                trust_proxy: true,
                trusted_proxy_hops: MAX_PROXY_HOPS + 1,
                ..valid()
            },
        ] {
            assert!(invalid.validate().is_err(), "{invalid:?}");
        }
        let no_statement_timeout = Config {
            request_timeout_secs: 5,
            statement_timeout_secs: 0,
            ..valid()
        };
        assert!(no_statement_timeout.validate().is_ok());
        // Beyond a day the statement timeout overflows PostgreSQL's integer milliseconds.
        let day = Config {
            request_timeout_secs: MAX_TIMEOUT_SECS + 1,
            statement_timeout_secs: MAX_TIMEOUT_SECS,
            ..valid()
        };
        assert!(day.validate().is_ok());
        let too_long = Config {
            request_timeout_secs: u64::MAX,
            statement_timeout_secs: 2_147_484,
            ..valid()
        };
        assert!(too_long.validate().is_err());
        let no_api_limit = Config {
            api_rate_limit_per_minute: 0,
            ..valid()
        };
        assert!(no_api_limit.validate().is_ok(), "0 turns the API limit off");
        let untrusted = Config {
            trusted_proxy_hops: 0,
            ..valid()
        };
        assert!(
            untrusted.validate().is_ok(),
            "hops only matter when trusted"
        );
    }

    #[test]
    fn proxy_hops_apply_only_when_the_proxy_is_trusted() {
        let config = Config {
            trusted_proxy_hops: 2,
            ..valid()
        };
        assert_eq!(config.proxy_hops(), 0);
        let trusted = Config {
            trust_proxy: true,
            ..config
        };
        assert_eq!(trusted.proxy_hops(), 2);
    }

    #[test]
    fn secure_cookies_follow_a_trusted_proxy_or_an_https_public_origin() {
        assert!(!valid().secure_cookies(), "plain local HTTP");
        let trusted = Config {
            trust_proxy: true,
            ..valid()
        };
        assert!(trusted.secure_cookies());
        for (url, secure) in [
            ("https://api.shop.com", true),
            (" HTTPS://api.shop.com ", true),
            ("http://localhost:8000", false),
            ("", false),
        ] {
            let config = Config {
                api_url: Some(url.into()),
                ..valid()
            };
            assert_eq!(config.secure_cookies(), secure, "{url:?}");
        }
    }

    #[test]
    fn production_rejects_loopback_webhooks() {
        let development = Config {
            webhooks_allow_loopback: true,
            ..valid()
        };
        assert!(development.validate().is_ok());
        let production = Config {
            production: true,
            ..development
        };
        let message = production.validate().unwrap_err().to_string();
        assert!(message.contains("NELCOTA_WEBHOOKS_ALLOW_LOOPBACK"));
        assert!(message.contains("NELCOTA_PRODUCTION"));
        assert!(!message.contains("  "), "{message}");
        let public_only = Config {
            production: true,
            ..valid()
        };
        assert!(public_only.validate().is_ok());
    }

    #[test]
    fn s3_error_names_each_variable_once() {
        let s3 = Config {
            storage_backend: StorageBackend::S3,
            ..Config::default()
        };
        let message = s3.validate_storage().unwrap_err().to_string();
        assert!(!message.contains("  "), "{message}");
        assert!(message.contains("_BUCKET, NELCOTA_STORAGE_S3_ACCESS_KEY_ID"));
    }

    #[test]
    fn secret_never_shows_in_debug() {
        let config = Config {
            jwt_secret: Some(Secret::new("super-secret")),
            ..Config::default()
        };
        assert!(!format!("{config:?}").contains("super-secret"));
    }

    fn with_mail(url: Option<&str>, from: Option<&str>, recovery: Option<&str>) -> Config {
        Config {
            smtp_url: url.map(Secret::new),
            smtp_from: from.map(Into::into),
            password_recovery_url: recovery.map(Into::into),
            ..Config::default()
        }
    }

    #[test]
    fn email_off_or_complete() {
        assert!(with_mail(None, None, None).mail().unwrap().is_none());
        assert!(
            with_mail(Some(""), Some(" "), None)
                .mail()
                .unwrap()
                .is_none()
        );
        let config = with_mail(
            Some("smtps://u:p@smtp.x.com"),
            Some("a@x.com"),
            Some("https://app.x.com/new-password"),
        );
        let mail = config.mail().unwrap().unwrap();
        assert_eq!(mail.recovery_url, "https://app.x.com/new-password");
        assert_eq!(mail.confirmation_url, None);
        assert_eq!(mail.magic_link_url, None);
    }

    #[test]
    fn optional_link_pages_need_smtp_and_a_plain_url() {
        let complete = with_mail(
            Some("smtps://u:p@smtp.x.com"),
            Some("a@x.com"),
            Some("https://app.x.com/new-password"),
        );
        let config = Config {
            email_confirmation_url: Some("https://app.x.com/confirmed".into()),
            magic_link_url: Some("https://app.x.com/signed-in".into()),
            ..complete.clone()
        };
        let mail = config.mail().unwrap().unwrap();
        assert_eq!(mail.confirmation_url, Some("https://app.x.com/confirmed"));
        assert_eq!(mail.magic_link_url, Some("https://app.x.com/signed-in"));

        let fragment = Config {
            magic_link_url: Some("https://app.x.com/in#x".into()),
            ..complete
        };
        assert!(fragment.mail().is_err());
        let without_smtp = Config {
            email_confirmation_url: Some("https://app.x.com/confirmed".into()),
            ..Config::default()
        };
        assert!(without_smtp.mail().is_err());
    }

    #[test]
    fn oauth_needs_complete_clients_and_its_urls() {
        assert!(Config::default().oauth().unwrap().is_none());
        let github = Config {
            oauth_github_client_id: Some("id".into()),
            oauth_github_client_secret: Some(Secret::new("secret")),
            ..Config::default()
        };
        assert!(github.oauth().is_err(), "needs the API and redirect URLs");
        let complete = Config {
            api_url: Some("https://api.shop.com".into()),
            oauth_redirect_urls: Some("https://shop.com/auth, http://localhost:5173".into()),
            ..github.clone()
        };
        let oauth = complete.oauth().unwrap().unwrap();
        assert_eq!(oauth.github, Some(("id", "secret")));
        assert!(oauth.google.is_none());
        assert_eq!(
            oauth.redirect_urls,
            ["https://shop.com/auth", "http://localhost:5173"]
        );
        let half = Config {
            oauth_google_client_id: Some("only-id".into()),
            ..complete
        };
        assert!(half.oauth().is_err());
    }

    #[test]
    fn upload_timeout_is_bounded() {
        let disk = |storage_upload_timeout_secs| Config {
            storage_backend: StorageBackend::Disk,
            storage_dir: Some("/storage".into()),
            storage_upload_timeout_secs,
            ..valid()
        };
        assert!(disk(MAX_TIMEOUT_SECS).validate_storage().is_ok());
        // An unbounded value panics when the upload deadline instant is computed.
        assert!(disk(MAX_TIMEOUT_SECS + 1).validate_storage().is_err());
        assert!(disk(u64::MAX).validate_storage().is_err());
    }

    #[test]
    fn storage_needs_its_backend_settings() {
        let disk = Config {
            storage_backend: StorageBackend::Disk,
            ..Config::default()
        };
        assert!(disk.validate_storage().is_err());
        let disk = Config {
            storage_dir: Some("/storage".into()),
            ..disk
        };
        assert!(disk.validate_storage().is_ok());

        let s3 = Config {
            storage_backend: StorageBackend::S3,
            storage_s3_bucket: Some("files".into()),
            storage_s3_access_key_id: Some("key".into()),
            ..Config::default()
        };
        assert!(s3.validate_storage().is_err());
        let s3 = Config {
            storage_s3_secret_access_key: Some(Secret::new("secret")),
            ..s3
        };
        assert!(s3.validate_storage().is_ok());
        let s3 = Config {
            storage_public_url: Some("files.shop.com".into()),
            ..s3
        };
        assert!(s3.validate_storage().is_err());
    }

    #[test]
    fn half_configured_email_fails_at_startup() {
        for config in [
            with_mail(
                Some("smtps://u:p@smtp.x.com"),
                None,
                Some("https://app.x.com"),
            ),
            with_mail(None, Some("a@x.com"), Some("https://app.x.com")),
            with_mail(None, None, Some("https://app.x.com")),
            with_mail(Some("smtps://u:p@smtp.x.com"), Some("a@x.com"), None),
            with_mail(
                Some("smtps://u:p@smtp.x.com"),
                Some("a@x.com"),
                Some("app.x.com"),
            ),
            with_mail(
                Some("smtps://u:p@smtp.x.com"),
                Some("a@x.com"),
                Some("https://x.com/#/password"),
            ),
        ] {
            assert!(config.mail().is_err(), "{config:?}");
        }
    }
    #[test]
    fn migration_backup_configuration_rejects_partial_or_invalid_capabilities() {
        // An absolute path on every platform; "/run/..." is relative on Windows.
        let mut config = Config {
            migration_backup_socket: Some(std::env::temp_dir().join("agent.sock")),
            ..valid()
        };
        assert!(config.validate().is_err());
        config.migration_backup_token = Some(Secret::new("not-a-capability"));
        assert!(config.validate().is_err());
        config.migration_backup_token = Some(Secret::new("a".repeat(64)));
        assert!(config.validate().is_ok());
        assert!(!format!("{config:?}").contains(&"a".repeat(64)));
        config.migration_backup_socket = Some("relative.sock".into());
        assert!(config.validate().is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn a_validation_candidate_requires_a_bounded_identity_and_absolute_gate() {
        let mut config = Config {
            deployment_validation: true,
            ..Config::default()
        };
        assert!(matches!(
            config.validate(),
            Err(ConfigError::Invalid(
                "deployment validation requires a candidate identity"
            ))
        ));
        config.deployment_id = Some("a".repeat(64));
        config.deployment_gate = Some("relative/gate".into());
        assert!(matches!(
            config.validate(),
            Err(ConfigError::Invalid(
                "deployment validation requires an absolute controller-owned gate"
            ))
        ));
        config.deployment_id = Some("../invalid".into());
        assert!(config.validate().is_err());
        let previous: Config =
            serde_json::from_value(serde_json::to_value(Config::default()).unwrap()).unwrap();
        assert!(!previous.deployment_validation);
        assert!(previous.deployment_gate.is_none());
        assert!(previous.deployment_id.is_none());
    }
}

#[cfg(test)]
mod g06_diagnostics {
    use super::*;
    #[test]
    fn mail_config_debug_hides_credentials() {
        let sensitive = format!(
            "sensitive-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let url = format!("smtps://operator:{sensitive}@mail.example.test:465");
        let config = MailConfig {
            smtp_url: &url,
            from: "mail@example.test",
            recovery_url: "https://app.example.test/recover",
            confirmation_url: None,
            magic_link_url: None,
        };
        assert!(!format!("{config:?}").contains(&sensitive));
    }
    #[test]
    fn oauth_config_debug_hides_credentials() {
        let sensitive = format!(
            "sensitive-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let config = OAuthConfig {
            api_url: "https://api.example.test",
            redirect_urls: vec!["https://app.example.test/auth"],
            google: Some(("client", &sensitive)),
            github: Some(("client", &sensitive)),
        };
        assert!(!format!("{config:?}").contains(&sensitive));
    }
}
