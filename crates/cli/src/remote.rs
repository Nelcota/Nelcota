//! Project links and bounded HTTP deployment; credentials never enter URLs or logs.
use anyhow::{Context, bail};
use clap::Args;
use nelcota_core::user_migrations::{MigrationFile, MigrationRequest};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};

#[derive(Args, Default)]
pub struct RemoteArgs {
    /// API origin of a remote project (HTTPS, or loopback HTTP for development).
    #[arg(long, conflicts_with = "local")]
    pub remote: Option<String>,
    /// Linked environment name.
    #[arg(long = "env", default_value = "default")]
    pub environment: String,
    /// Deployment credential. Prefer NELCOTA_DEPLOY_TOKEN to command-line history.
    #[arg(long, env = "NELCOTA_DEPLOY_TOKEN", hide_env_values = true)]
    pub token: Option<String>,
    /// Use the local/host database even when this folder has a project link.
    #[arg(long)]
    pub local: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Link {
    url: String,
    token: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Links {
    environments: BTreeMap<String, Link>,
}
const FILE: &str = ".nelcota/project.json";

pub fn origin(value: &str) -> anyhow::Result<String> {
    let url = url::Url::parse(value).context("invalid project URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        bail!(
            "project URL must be an HTTPS origin without credentials, path, query or fragment (loopback HTTP is allowed locally)"
        );
    }
    Ok(url.origin().ascii_serialization())
}

fn read(root: &Path) -> anyhow::Result<Links> {
    match fs::read(root.join(FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("invalid project link file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Links::default()),
        Err(error) => Err(error).context("could not read the project link"),
    }
}

pub fn target(root: &Path, args: &RemoteArgs) -> anyhow::Result<Option<Link>> {
    if args.local {
        return Ok(None);
    }
    let mut saved = read(root)?.environments.remove(&args.environment);
    if let Some(url) = &args.remote {
        saved = Some(Link {
            url: origin(url)?,
            token: args.token.clone().unwrap_or_default(),
        });
    }
    if saved.is_none() && args.environment != "default" {
        bail!("environment {} is not linked", args.environment);
    }
    if let Some(link) = &mut saved {
        link.url = origin(&link.url)?;
        if let Some(token) = &args.token {
            link.token = token.clone();
        }
        if !valid_token(&link.token) {
            bail!("provide an ndp_ deployment token with NELCOTA_DEPLOY_TOKEN or nelcota link");
        }
    }
    Ok(saved)
}
fn valid_token(token: &str) -> bool {
    token.len() == 47
        && token.starts_with("ndp_")
        && token[4..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}

async fn send(
    link: &Link,
    method: Method,
    path: &str,
    body: Option<&MigrationRequest>,
) -> anyhow::Result<String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // The long total budget covers server-side migrations; an unreachable
        // origin should fail fast instead of waiting all of it out.
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(660))
        .build()?;
    let mut request = client
        .request(method, format!("{}/admin/deploy/v1/{path}", link.url))
        .bearer_auth(&link.token);
    if let Some(body) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(body)?);
    }
    // Never format reqwest errors: an arbitrary server must not echo credentials
    // into diagnostics, and redirects must not forward the bearer token.
    let response = request.send().await.map_err(|_| {
        anyhow::anyhow!(
            "remote deployment request failed; inspect migrate status before retrying a write"
        )
    })?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > 8 * 1024 * 1024)
    {
        bail!("remote response exceeds 8 MiB");
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("remote response interrupted; inspect migrate status"))?
    {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            bail!("remote response exceeds 8 MiB");
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let code = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("code")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "remote_error".into());
        bail!(
            "remote deployment returned HTTP {}: {}",
            status.as_u16(),
            response_remediation(status, &code)
        );
    }
    String::from_utf8(bytes).context("remote response is not UTF-8")
}

fn response_remediation(status: reqwest::StatusCode, code: &str) -> &'static str {
    if status == reqwest::StatusCode::NOT_FOUND {
        return "deployment API endpoint not found; verify the project origin and install matching deployment-capable CLI/server artifacts; published 0.5.6 does not include these endpoints";
    }
    remediation(code)
}

fn remediation(code: &str) -> &'static str {
    match code {
        "migration_backup_required" => {
            "automatic backup protection is missing; on the project host run `nelcota -C <host> -p <project> migration-backup enable`, set production mode and recreate the app, then inspect migrate status and preview the complete folder"
        }
        "migration_backup_failed" => {
            "automatic backup failed or was interrupted; inspect the project backup service and migrate status; preserve its recovery fence and preview before retrying"
        }
        "migration_diverged" => {
            "migration history differs; restore the original applied files, include the complete folder and run migrate status before creating a new version"
        }
        "migration_busy" => {
            "another migration is running; wait for completion and run migrate status before retrying"
        }
        "invalid_migration" => {
            "invalid migration files; check V<number>__<name>.sql names, duplicate versions and SQL, then run migrate --dry-run"
        }
        "db_error" => {
            "migration SQL failed; inspect private server diagnostics and migrate status; earlier files may have committed, so reconcile the complete folder before retrying"
        }
        "invalid_deploy_token" => {
            "deployment credential was refused; create or renew a scoped token in Connect, supply NELCOTA_DEPLOY_TOKEN and link the intended environment again"
        }
        _ => {
            "remote request failed; verify the linked environment and credential, then inspect migrate status before retrying a write"
        }
    }
}

pub fn link(root: &Path, args: &RemoteArgs) -> anyhow::Result<()> {
    if args.environment.is_empty()
        || args.environment.len() > 40
        || !args
            .environment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        bail!("environment name must contain 1-40 letters, digits, underscores or hyphens");
    }
    let link = target(root, args)?.context("provide --remote and NELCOTA_DEPLOY_TOKEN")?;
    runtime()?.block_on(send(&link, Method::GET, "typescript", None))?;
    let mut links = read(root)?;
    links.environments.insert(args.environment.clone(), link);
    crate::private_fs::dir(&root.join(".nelcota"))?;
    crate::private_fs::write(&root.join(FILE), serde_json::to_vec_pretty(&links)?)?;
    fs::write(root.join(".nelcota/.gitignore"), "*\n")?;
    crate::util::ok(&format!(
        "linked environment {} (credentials in {FILE})",
        args.environment
    ));
    Ok(())
}

pub fn migrate(
    link: &Link,
    files: Vec<MigrationFile>,
    status: bool,
    dry_run: bool,
) -> anyhow::Result<()> {
    let request = MigrationRequest { files, dry_run };
    let path = match status {
        true => "migrations/status",
        false => "migrations",
    };
    let response = runtime()?.block_on(send(link, Method::POST, path, Some(&request)))?;
    let value: serde_json::Value = serde_json::from_str(&response)?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    if !status && !dry_run {
        println!(
            "Regenerate Context for AI: {}/admin/connect?section=api-ai",
            link.url
        );
    }
    Ok(())
}
pub fn types(link: &Link) -> anyhow::Result<String> {
    runtime()?.block_on(send(link, Method::GET, "typescript", None))
}

impl std::fmt::Debug for RemoteArgs {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemoteArgs")
            .field("remote", &self.remote)
            .field("environment", &self.environment)
            .field("local", &self.local)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_remediation_is_actionable_and_never_reflects_unknown_body_text() {
        assert!(remediation("migration_backup_required").contains("migration-backup enable"));
        assert!(remediation("migration_diverged").contains("original applied files"));
        let secret = "ndp_private_echo_from_an_untrusted_server";
        assert!(!remediation(secret).contains(secret));
        assert!(remediation(secret).contains("migrate status"));
    }
    #[test]
    fn missing_deployment_endpoints_identify_the_capability_mismatch() {
        let message = response_remediation(reqwest::StatusCode::NOT_FOUND, "private_server_body");
        assert!(message.contains("deployment-capable CLI/server"));
        assert!(!message.contains("private_server_body"));
    }
    #[test]
    fn rejects_unsafe_remote_origins_and_token_redirects() {
        for value in [
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com/path",
            "https://example.com/?token=x",
            "https://example.com/#token",
        ] {
            assert!(origin(value).is_err());
        }
        assert_eq!(
            origin("https://example.com/").unwrap(),
            "https://example.com"
        );
        assert!(origin("http://127.0.0.1:8000").is_ok());
    }
}
