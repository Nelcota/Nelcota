//! Operator-only configuration preparation. Secrets never enter public receipts.
use super::*;
use nelcota_deployment::operations::{Configuration, ConfigurationView, Section};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) enum Target {
    Project { name: String, identity: String },
    Host,
    Schedule,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Edit {
    pub target: Target,
    pub before: String,
    pub after: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Prepared {
    pub revision: String,
    pub section: Section,
    pub(super) edits: Vec<Edit>,
    pub restarts: Vec<String>,
}
#[cfg(test)]
mod tests;
mod validation;
mod view;
pub(crate) use validation::{approved_service, bytes_digest, error_code};
use validation::{page, patch, secret, text};
pub(crate) use view::view;

fn env_edit(
    target: Target,
    path: &Path,
    values: BTreeMap<String, Option<String>>,
) -> anyhow::Result<Edit> {
    trusted_path(path)?;
    let before = String::from_utf8(read_private(path, 65536)?)?;
    let after = patch(&before, &values)?;
    Ok(Edit {
        target,
        before,
        after,
    })
}
fn pairs(values: &[(&str, String)]) -> BTreeMap<String, Option<String>> {
    values
        .iter()
        .map(|(k, v)| (k.to_string(), (!v.is_empty()).then(|| v.clone())))
        .collect()
}
fn project_target(project: &Project) -> anyhow::Result<Target> {
    Ok(Target::Project {
        name: project.name.clone(),
        identity: String::from_utf8(read_private(&project.path(".deployment-project-id"), 64)?)?,
    })
}
pub(crate) fn prepare(
    policy: &Policy,
    name: &str,
    input: Configuration,
) -> anyhow::Result<Prepared> {
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    let project = control_project(policy, name)?;
    crate::pitr::fence::require_clear(&project)?;
    let env = project.env();
    let section = input.section();
    let mut restarts = Vec::new();
    let mut edits = Vec::new();
    match input {
        Configuration::Smtp {
            enabled,
            url,
            from,
            recovery_url,
            confirmation_url,
            magic_link_url,
        } => {
            let mut values = pairs(&[
                ("NELCOTA_SMTP_FROM", from.clone()),
                ("NELCOTA_PASSWORD_RECOVERY_URL", recovery_url.clone()),
                ("NELCOTA_EMAIL_CONFIRMATION_URL", confirmation_url.clone()),
                ("NELCOTA_MAGIC_LINK_URL", magic_link_url.clone()),
            ]);
            match enabled {
                true => {
                    let url = secret(url, env.get("NELCOTA_SMTP_URL")?)?;
                    approved_service(policy, &url)?;
                    nelcota_auth::SmtpMailer::new(&url, &from)
                        .context("invalid_smtp_configuration")?;
                    page(&recovery_url, false)?;
                    page(&confirmation_url, true)?;
                    page(&magic_link_url, true)?;
                    values.insert("NELCOTA_SMTP_URL".into(), Some(url));
                }
                false => {
                    for key in [
                        "NELCOTA_SMTP_URL",
                        "NELCOTA_SMTP_FROM",
                        "NELCOTA_PASSWORD_RECOVERY_URL",
                        "NELCOTA_EMAIL_CONFIRMATION_URL",
                        "NELCOTA_MAGIC_LINK_URL",
                    ] {
                        values.insert(key.into(), None);
                    }
                }
            }
            edits.push(env_edit(
                project_target(&project)?,
                &project.path(".env"),
                values,
            )?);
            restarts.push(name.into());
        }
        Configuration::OauthGoogle {
            enabled,
            client_id,
            client_secret,
            redirects,
        }
        | Configuration::OauthGithub {
            enabled,
            client_id,
            client_secret,
            redirects,
        } => {
            let provider = match section {
                Section::OauthGoogle => "GOOGLE",
                _ => "GITHUB",
            };
            let id_key = format!("NELCOTA_OAUTH_{provider}_CLIENT_ID");
            let secret_key = format!("NELCOTA_OAUTH_{provider}_CLIENT_SECRET");
            let mut values = BTreeMap::new();
            match enabled {
                true => {
                    text(&client_id, 1024)?;
                    if client_id.trim().is_empty() || redirects.is_empty() || redirects.len() > 16 {
                        bail!("invalid_oauth_configuration");
                    }
                    for url in &redirects {
                        page(url, false)?;
                    }
                    values.insert(id_key, Some(client_id));
                    values.insert(
                        secret_key.clone(),
                        Some(secret(client_secret, env.get(&secret_key)?)?),
                    );
                    values.insert(
                        "NELCOTA_API_URL".into(),
                        Some(format!(
                            "https://{}",
                            manifest
                                .projects
                                .iter()
                                .find(|p| p.name == name)
                                .context("project missing")?
                                .domain
                        )),
                    );
                    values.insert(
                        "NELCOTA_OAUTH_REDIRECT_URLS".into(),
                        Some(redirects.join(",")),
                    );
                }
                false => {
                    values.insert(id_key, None);
                    values.insert(secret_key, None);
                }
            }
            edits.push(env_edit(
                project_target(&project)?,
                &project.path(".env"),
                values,
            )?);
            restarts.push(name.into());
        }
        Configuration::Backup {
            enabled,
            endpoint,
            bucket,
            region,
            access_key,
            secret_key,
        } => {
            let secrets = host.secrets();
            let mut values = BTreeMap::new();
            match enabled {
                true => {
                    page(&endpoint, false)?;
                    let url = url::Url::parse(&endpoint)?;
                    if url.path() != "/" || url.query().is_some() {
                        bail!("invalid_backup_endpoint");
                    }
                    approved_service(policy, &endpoint)?;
                    if !(3..=63).contains(&bucket.len())
                        || !bucket.bytes().all(|b| {
                            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.'
                        })
                        || bucket.starts_with('-')
                        || bucket.ends_with('-')
                        || bucket.contains("..")
                    {
                        bail!("invalid_backup_bucket");
                    }
                    if region.is_empty()
                        || region.len() > 64
                        || !region
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    {
                        bail!("invalid_backup_region");
                    }
                    values = pairs(&[
                        ("NELCOTA_BACKUP_S3_ENDPOINT", endpoint),
                        ("NELCOTA_BACKUP_S3_BUCKET", bucket),
                        ("NELCOTA_BACKUP_S3_REGION", region),
                        (
                            "NELCOTA_BACKUP_S3_ACCESS_KEY",
                            secret(access_key, secrets.get("NELCOTA_BACKUP_S3_ACCESS_KEY")?)?,
                        ),
                        (
                            "NELCOTA_BACKUP_S3_SECRET_KEY",
                            secret(secret_key, secrets.get("NELCOTA_BACKUP_S3_SECRET_KEY")?)?,
                        ),
                    ]);
                }
                false => {
                    for key in [
                        "NELCOTA_BACKUP_S3_ENDPOINT",
                        "NELCOTA_BACKUP_S3_BUCKET",
                        "NELCOTA_BACKUP_S3_REGION",
                        "NELCOTA_BACKUP_S3_ACCESS_KEY",
                        "NELCOTA_BACKUP_S3_SECRET_KEY",
                    ] {
                        values.insert(key.into(), None);
                    }
                }
            }
            edits.push(env_edit(Target::Host, host.secrets().path(), values)?);
        }
        Configuration::Schedule { hour, minute, keep } => {
            let path = Path::new(crate::machine::BACKUP_CRON);
            trusted_path(path)?;
            let before = String::from_utf8(read_private(path, 16384)?)?;
            let after = crate::machine::backup_schedule(&before, hour, minute, keep)?;
            edits.push(Edit {
                target: Target::Schedule,
                before,
                after,
            });
        }
        Configuration::AdminPassword { new_password } => {
            if !(16..=1024).contains(&new_password.len()) {
                bail!("admin_password_length");
            }
            let hash =
                nelcota_auth::hash_password(&new_password).context("password_hash_failed")?;
            let values = pairs(&[("NELCOTA_ADMIN_PASSWORD_HASH", hash)]);
            match manifest.panel_login {
                crate::host::PanelLogin::Shared => {
                    edits.push(env_edit(
                        Target::Host,
                        host.secrets().path(),
                        values.clone(),
                    )?);
                    for entry in &manifest.projects {
                        let p = control_project(policy, &entry.name)?;
                        crate::pitr::fence::require_clear(&p)?;
                        edits.push(env_edit(
                            project_target(&p)?,
                            &p.path(".env"),
                            values.clone(),
                        )?);
                        restarts.push(entry.name.clone());
                    }
                }
                crate::host::PanelLogin::PerProject => {
                    edits.push(env_edit(
                        project_target(&project)?,
                        &project.path(".env"),
                        values,
                    )?);
                    restarts.push(name.into());
                }
            }
        }
    }
    let prepared = Prepared {
        revision: nelcota_deployment::token()?,
        section,
        edits,
        restarts,
    };
    if serde_json::to_vec(&prepared)?.len() > 4 * 1024 * 1024 {
        bail!("configuration_too_large");
    }
    Ok(prepared)
}

/// Service grants are rechecked by the executing worker, not only by the browser plan.
pub(crate) fn approve_services(policy: &Policy, prepared: &Prepared) -> anyhow::Result<()> {
    for edit in &prepared.edits {
        for (key, value) in crate::envfile::parse(&edit.after) {
            if (prepared.section == Section::Smtp && key == "NELCOTA_SMTP_URL")
                || (prepared.section == Section::Backup && key == "NELCOTA_BACKUP_S3_ENDPOINT")
            {
                approved_service(policy, &value)?;
            }
        }
    }
    Ok(())
}
