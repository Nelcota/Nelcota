# Configuration reference

Configure the server from process environment variables or a TOML file. This
reference is derived from `Config` and its defaults in `crates/core/src/config.rs`,
plus the CLI, installer and backup adapters. Use the matching release source for
published binaries; deployment validation settings below exist only in `main`.

## Loading and file ownership

Precedence is built-in defaults, then `nelcota.toml` (or `NELCOTA_CONFIG`), then
`NELCOTA_` environment variables. TOML uses lowercase field names without the
prefix. `nelcota serve` does not automatically read `.env`. Compose injects the
project file; native systemd uses its environment file; the host CLI reads project
files for operations. `nelcota dev` constructs generated development settings
and reuses `.nelcota/dev.env`; it is not a production environment-file loader.

For standalone serving, set real process variables through your service manager
or use a private TOML file. This example is a shape, not runnable credentials:

```toml
database_url = "postgres://postgres:REPLACE@127.0.0.1:5432/postgres"
authenticator_password = "REPLACE_WITH_A_GENERATED_SECRET"
jwt_private_key = "REPLACE_WITH_KEYGEN_OUTPUT"
listen = "127.0.0.1:8000"
```

Generate keys with `nelcota keygen`, passwords with `openssl rand -base64 48`,
and panel hashes with the CLI. Keep files containing these values owner-readable
and out of version control. Optional secret/mail values that normalize to blank
are absent; do not assume every optional field accepts an empty string.

## Server variables

Types mirror the Rust contract: `Secret` is a string; `Option<T>` is optional;
integer sizes are unsigned except `max_rows`, which must be positive. Durations
and sizes use seconds/days/bytes as specified. Examples containing `REPLACE`,
provider IDs or generated values require your own credentials.

| Variable | Type | Default | Example | Effect / validation |
| --- | --- | --- | --- | --- |
| `NELCOTA_DATABASE_URL` | `Secret` | `empty (required)` | `postgres://postgres:REPLACE@127.0.0.1:5432/postgres` | Required administrator connection for bootstrap and panel; request pools replace credentials with authenticator. Private PostgreSQL only: built-in connectors use NoTls. |
| `NELCOTA_AUTHENTICATOR_PASSWORD` | `Secret` | `empty (required)` | `runtime-generated secret` | Required, at least 16 bytes; cluster-global authenticator password. Coordinate independent databases or use separate clusters. |
| `NELCOTA_JWT_PRIVATE_KEY` | `Option<Secret>` | `unset` | `nelcota keygen output` | Ed25519 PKCS#8 PEM or one-line base64. Signs EdDSA and publishes its public JWKS; preferred over HS256. |
| `NELCOTA_JWT_SECRET` | `Option<Secret>` | `unset` | `runtime-generated 48-byte base64 secret` | HS256 requires at least 32 bytes. Signs when no Ed25519 key exists; otherwise verifies legacy HS256 tokens only. |
| `NELCOTA_JWT_ISSUER` | `String` | `nelcota` | `my-api` | Issued iss claim; built-in verification does not enforce issuer/audience. Choose a consistent nonempty value. |
| `NELCOTA_JWT_EXPIRY_SECS` | `u64` | `900` | `900` | Positive access-token lifetime in seconds; must not overflow its representable range. |
| `NELCOTA_REFRESH_TOKEN_TTL_DAYS` | `u32` | `30` | `30` | Positive refresh lifetime in days, renewed per rotation; bounded by PostgreSQL timestamp horizon. |
| `NELCOTA_SIGNUP_ENABLED` | `bool` | `true` | `false` | Allows public signup. Provider sign-in for existing linked accounts has its own documented flow. |
| `NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` | `u32` | `30` | `30` | Positive password/signup/email/provider budget per IP. Password login also has an email budget. Refresh/PKCE use a separate 10x budget. |
| `NELCOTA_TRUST_PROXY` | `bool` | `false` | `true` | Uses rightmost X-Forwarded-For for caller IP. Enable only behind a correctly configured trusted proxy with direct access restricted. |
| `NELCOTA_SMTP_URL` | `Option<Secret>` | `unset` | `smtps://user:REPLACE@smtp.example.com:465` | Auth email transport; smtps or smtp with required TLS. Set sender and recovery page together. Blank is absent. |
| `NELCOTA_SMTP_FROM` | `Option<String>` | `unset` | `App <no-reply@example.com>` | Sender mailbox/display name. Quote spaces in the deployment environment-file format. |
| `NELCOTA_PASSWORD_RECOVERY_URL` | `Option<String>` | `unset` | `https://app.example.com/recovery` | Required with SMTP; HTTP(S) application link page without a fragment. Production should use HTTPS. |
| `NELCOTA_EMAIL_CONFIRMATION_URL` | `Option<String>` | `unset` | `https://app.example.com/confirm` | With SMTP, makes signup wait for email confirmation. HTTP(S) page without a fragment. |
| `NELCOTA_MAGIC_LINK_URL` | `Option<String>` | `unset` | `https://app.example.com/sign-in` | With SMTP, enables passwordless links for existing accounts. HTTP(S) page without a fragment. |
| `NELCOTA_API_URL` | `Option<String>` | `unset` | `https://api.example.com` | Public API HTTP(S) origin for OAuth callback; required when a provider is enabled. Also used as Vite proxy override during UI development. |
| `NELCOTA_OAUTH_REDIRECT_URLS` | `Option<String>` | `unset` | `https://app.example.com/auth` | Comma-separated application pages allowed after OAuth; same origin and equal/below path. Required with a provider. |
| `NELCOTA_OAUTH_GOOGLE_CLIENT_ID` | `Option<String>` | `unset` | `provider-issued ID` | Google OAuth client ID; set together with its secret and API/redirect URLs. |
| `NELCOTA_OAUTH_GOOGLE_CLIENT_SECRET` | `Option<Secret>` | `unset` | `provider-issued secret` | Google OAuth secret; keep out of frontend configuration. |
| `NELCOTA_OAUTH_GITHUB_CLIENT_ID` | `Option<String>` | `unset` | `provider-issued ID` | GitHub OAuth client ID; set together with its secret and API/redirect URLs. |
| `NELCOTA_OAUTH_GITHUB_CLIENT_SECRET` | `Option<Secret>` | `unset` | `provider-issued secret` | GitHub OAuth secret; keep out of frontend configuration. |
| `NELCOTA_ADMIN_EMAIL` | `Option<String>` | `unset` | `admin@example.com` | Project-panel login identity; panel is disabled without email and password hash. |
| `NELCOTA_ADMIN_PASSWORD_HASH` | `Option<Secret>` | `unset` | `generated PHC argon2id hash` | PHC argon2id hash; generated by init/admin-password. Single-quote dollar signs in environment files. |
| `NELCOTA_ADMIN_SSO_SECRET` | `Option<Secret>` | `unset` | `host-generated secret` | Shared host-panel handoff secret; absent means per-project login. Generated by CLI login management. |
| `NELCOTA_PROJECT_NAME` | `Option<String>` | `unset` | `shop` | Project identity displayed in the panel; generated by host deployment. |
| `NELCOTA_HOST_REGISTRY` | `Option<PathBuf>` | `unset` | `/etc/nelcota/shared/projects.json` | Public project name/URL registry for the switcher; generated by the host CLI. |
| `NELCOTA_MIGRATIONS_DIR` | `Option<PathBuf>` | `unset` | `./migrations` | Folder scanned when allocating panel-generated application migrations; /migrations is detected in the container. |
| `NELCOTA_DB_SCHEMA` | `String` | `public` | `public` | Schema exposed through REST/catalog and type generation. |
| `NELCOTA_MAX_ROWS` | `Option<i64>` | `1000` | `1000` | Positive root/embedded read and set-returning RPC cap; omitted/None uses 1000. Write-embedded collections have their own fixed 1000 cap. |
| `NELCOTA_MAX_BODY_BYTES` | `usize` | `2097152` | `2097152` | Positive REST write/RPC body cap in bytes; bodies are buffered. Does not set the streamed file-upload limit. |
| `NELCOTA_LISTEN` | `SocketAddr` | `0.0.0.0:8000` | `127.0.0.1:8000` | HTTP bind socket. Raw serve defaults to all interfaces; dev overrides to loopback, and host runtime controls binding separately. |
| `NELCOTA_DB_POOL_SIZE` | `usize` | `10` | `10` | Positive request-pool capacity; does not set separate panel/webhook/export budgets. |
| `NELCOTA_REQUEST_TIMEOUT_SECS` | `u64` | `15` | `15` | Positive ordinary HTTP request deadline in seconds. Must exceed nonzero statement timeout; streamed uploads/exports have separate budgets. |
| `NELCOTA_STATEMENT_TIMEOUT_SECS` | `u64` | `10` | `10` | Request-pool PostgreSQL statement timeout in seconds. 0 disables that timeout; use deliberately. Panel SQL has separate fixed budgets. |
| `NELCOTA_LOG_FORMAT` | `LogFormat` | `text` | `json` | text or json tracing output; verbosity comes from RUST_LOG. |
| `NELCOTA_WEBHOOKS_ALLOW_LOOPBACK` | `bool` | `false` | `false` | Development-only HTTP(S) to localhost/127.0.0.1/::1. Does not permit LAN/metadata addresses or arbitrary public HTTP. |
| `NELCOTA_DEPLOYMENT_VALIDATION` | `bool` | `false` | `controller-managed` | Linux controller-owned candidate gate; requires gate path and identity. Never configure manually to enable an update. |
| `NELCOTA_DEPLOYMENT_GATE` | `Option<PathBuf>` | `unset` | `controller-managed absolute path` | Absolute controller-owned gate path bound to the candidate. Keep ownership and protocol managed by enrollment. |
| `NELCOTA_DEPLOYMENT_ID` | `Option<String>` | `unset` | `controller-managed 64-character hex ID` | Controller-owned candidate operation identity; 64 lowercase hexadecimal characters while validation is enabled. |
| `NELCOTA_STORAGE_BACKEND` | `StorageBackend` | `off` | `disk` | off, disk or s3. Raw serve defaults to off; init/dev enable disk with runtime-specific paths. |
| `NELCOTA_STORAGE_DIR` | `Option<PathBuf>` | `unset` | `./storage` | Required for disk. Server must own the directory and enforce private permissions. |
| `NELCOTA_STORAGE_S3_ENDPOINT` | `Option<String>` | `unset` | `https://s3.example.com` | Custom S3 endpoint; absent/blank selects AWS. Production must use verified HTTPS. |
| `NELCOTA_STORAGE_S3_BUCKET` | `Option<String>` | `unset` | `files` | Required with S3 backend; separate from the offsite backup bucket. |
| `NELCOTA_STORAGE_S3_REGION` | `String` | `auto` | `us-east-1` | Provider region. auto is appropriate for R2; set the actual region for AWS. |
| `NELCOTA_STORAGE_S3_ACCESS_KEY_ID` | `Option<String>` | `unset` | `provider-issued ID` | Required with S3 backend; scope provider privileges to the application bucket. |
| `NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY` | `Option<Secret>` | `unset` | `provider-issued secret` | Required with S3 backend; never expose or log the value. |
| `NELCOTA_STORAGE_S3_VIRTUAL_HOSTED` | `bool` | `false` | `false` | Use bucket.endpoint URLs instead of endpoint/bucket when supported by your provider. |
| `NELCOTA_STORAGE_MAX_FILE_SIZE` | `u64` | `52428800` | `52428800` | Positive maximum upload bytes; a bucket can only lower it. Default is 50 MiB. |
| `NELCOTA_STORAGE_MAX_TOTAL_SIZE` | `Option<u64>` | `unset` | `10737418240` | Optional committed total-byte cap across all buckets. Unset has no cap; 0 leaves no capacity for nonempty files. |
| `NELCOTA_STORAGE_MIN_FREE_BYTES` | `u64` | `1073741824` | `1073741824` | Disk backend free-space reserve, in bytes. Default is 1 GiB. |
| `NELCOTA_STORAGE_PUBLIC_URL` | `Option<String>` | `unset` | `https://files.example.com` | Public-file URL origin; absent uses relative API URLs. Configure an HTTPS proxy to public object routes. |
| `NELCOTA_STORAGE_UPLOAD_TIMEOUT_SECS` | `u64` | `3600` | `3600` | Positive admission/policy/byte-reception deadline in seconds when enabled. Metadata publication and multipart cleanup have separate bounded settlement. |

All 52 fields are listed above. `Secret` affects log formatting, not encryption
of the environment file. API signatures are not a substitute for private key
storage. Backend and backup S3 credentials/settings are separate.

## CLI and installer variables

| Variable | Scope / type | Default | Example | Effect |
| --- | --- | --- | --- | --- |
| `NELCOTA_CONFIG` | server path | `nelcota.toml` | `/etc/nelcota/server.toml` | Selects TOML file; environment overrides it. |
| `NELCOTA_ROOT` | CLI host path | `.` | `/opt/nelcota` | Equivalent to global `--dir`; does not chdir the raw server TOML loader. |
| `NELCOTA_IMAGE` | init image string | `ghcr.io/nelcota/nelcota-server` | `ghcr.io/nelcota/nelcota-server` | Default project app image; custom images are outside controlled-update V1. |
| `NELCOTA_VERSION` | installer/host version string | installer: `latest`; init: CLI version | `0.5.0` | Installer release selection; persisted host image tag. Installing the CLI does not upgrade running projects. |
| `NELCOTA_REPO` | installer repository string | `Nelcota/Nelcota` | `Nelcota/Nelcota` | Release source override; use official artifacts for supported deployments. |
| `PREFIX` | installer directory | `/usr/local/bin` | `$HOME/.local/bin` | Writable user-owned prefix can avoid sudo for binary installation. Add it to your PATH yourself. |
| `NELCOTA_SKIP_DOCKER` | installer string switch | `0` | `1` | Exactly `1` skips Docker installation; does not provide Docker for dev. |
| `NELCOTA_APP_IMAGE` | controller-managed image identity | unset | controller-managed digest | Pins the app image on enrolled Docker hosts; do not hand-edit during a job. |
| `RUST_LOG` | server tracing filter | `info,tower_http=info` | `info,tower_http=info` | Controls log levels, independently of text/json format. Debug diagnostics can contain operational details. |

## Offsite backup and PITR settings

Set these in the host's private `host.env`, not the public app client. Endpoint,
bucket, access key and secret must be configured together. Docker invokes an
AWS CLI container; systemd offsite transport requires native AWS CLI v2.

| Variable | Type | Default | Example | Effect |
| --- | --- | --- | --- | --- |
| `NELCOTA_BACKUP_S3_ENDPOINT` | HTTPS URL | unset | `https://s3.example.com` | Required backup/PITR provider endpoint. |
| `NELCOTA_BACKUP_S3_BUCKET` | string | unset | `private-backups` | Host backup bucket, shared by project prefixes. |
| `NELCOTA_BACKUP_S3_ACCESS_KEY` | secret string | unset | provider-issued ID | Backup transport credential. |
| `NELCOTA_BACKUP_S3_SECRET_KEY` | secret string | unset | provider-issued secret | Keep private; unrelated to the app storage credential. |
| `NELCOTA_BACKUP_S3_REGION` | string | `us-east-1` | `us-west-002` | Backup/PITR provider region. |
| `NELCOTA_BACKUP_S3_URI_STYLE` | `host` or `path` | `host` | `path` | pgBackRest addressing style; regenerate with pitr enable. |
| `NELCOTA_BACKUP_S3_VERIFY_TLS` | string switch | verified TLS | leave unset | pgBackRest disables verification only for the literal false setting. Keep verification enabled; install trusted certificates for private providers. |

## Development and test scope

Test/example variables such as `NELCOTA_TEST_DATABASE_URL`, S3 fixture settings,
`NELCOTA_URL`/`NELCOTA_EMAIL`/`NELCOTA_PASSWORD` and benchmark controls do not
configure the production server. See [CONTRIBUTING](../CONTRIBUTING.md) and each example/benchmark
guide for their scope. Never point test database variables at valuable data.

## Troubleshooting

- Missing required values: configure the process/TOML, not an unconsumed `.env` file.
- SMTP/provider startup failure: configure each required group together and use permitted link pages.
- Timeouts: keep request timeout greater than a nonzero statement timeout; different workloads use separate budgets.
- Storage disabled: raw serve defaults to off; select backend and required directory/provider credentials.
- Update validation error: repair enrollment/job state over SSH; never manually disable a candidate gate.

Related: [CLI](cli.md), [deploy](deploy.md), [auth](schema-auth.md),
[storage](storage.md), [backup](backup.md) and [security](security/README.md).
