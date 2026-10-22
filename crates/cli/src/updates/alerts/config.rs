//! Host-owned settings and closed outbound grants. URLs are write-only secrets.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nelcota_deployment::alerts::Settings;
use rustix::fs::{Mode, OFlags, open, openat};
use std::{fs::File, io::Read, os::unix::fs::MetadataExt};
const MAX_CONFIG_BYTES: u64 = 65536;
// Policy validation owns the host root. Anchor the secret read to that directory
// and inspect the opened descriptor, so replacing the leaf cannot redirect it.
fn private_values(host: &Host) -> anyhow::Result<Vec<(String, String)>> {
    let root = File::from(
        open(
            host.root(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .context("unsafe_alert_configuration_directory")?,
    );
    let owner = root.metadata()?;
    ensure!(
        owner.mode() & 0o022 == 0,
        "unsafe_alert_configuration_directory"
    );
    let file = File::from(
        openat(
            &root,
            "host.env",
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .context("unsafe_alert_configuration_file")?,
    );
    let meta = file.metadata()?;
    ensure!(
        meta.is_file()
            && meta.uid() == owner.uid()
            && meta.mode() & 0o077 == 0
            && meta.len() <= MAX_CONFIG_BYTES,
        "unsafe_alert_configuration_file"
    );
    let mut text = String::new();
    file.take(MAX_CONFIG_BYTES + 1).read_to_string(&mut text)?;
    ensure!(
        text.len() as u64 <= MAX_CONFIG_BYTES,
        "unsafe_alert_configuration_file"
    );
    Ok(crate::envfile::parse(&text))
}
pub(super) struct Config {
    pub settings: Settings,
    pub webhook: Option<String>,
    pub heartbeat: Option<String>,
    pub smtp_identity: Option<String>,
}
const SETTINGS: &str = "NELCOTA_ALERTS_SETTINGS_B64";
const WEBHOOK: &str = "NELCOTA_ALERTS_WEBHOOK_URL";
const HEARTBEAT: &str = "NELCOTA_ALERTS_HEARTBEAT_URL";
const IDENTITY: &str = "NELCOTA_ALERTS_SMTP_ID";
impl Config {
    pub fn read(host: &Host) -> anyhow::Result<Self> {
        let values = private_values(host)?;
        let get = |key: &str| {
            values
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .filter(|v| !v.is_empty())
        };
        let settings = match get(SETTINGS) {
            Some(v) => decode(&v)?,
            None => Settings::default(),
        };
        let config = Self {
            settings,
            webhook: get(WEBHOOK),
            heartbeat: get(HEARTBEAT),
            smtp_identity: get(IDENTITY),
        };
        config.settings.validate()?;
        Ok(config)
    }
    pub fn fingerprint(&self, policy: &Policy) -> anyhow::Result<String> {
        let mut bytes = serde_json::to_vec(&self.settings)?;
        for value in [&self.webhook, &self.heartbeat, &self.smtp_identity] {
            bytes.extend_from_slice(&serde_json::to_vec(value)?);
        }
        bytes.extend_from_slice(&serde_json::to_vec(policy)?);
        Ok(management::settings::bytes_digest(&bytes))
    }
    pub fn smtp(&self, policy: &Policy) -> anyhow::Result<(String, String)> {
        ensure!(self.settings.email_enabled, "alert_email_disabled");
        ensure!(
            policy
                .operators
                .iter()
                .any(|o| o.manage_host && o.email == self.settings.recipient),
            "invalid_alert_recipient"
        );
        let project = management::control_project(policy, &self.settings.smtp_project)?;
        let id = String::from_utf8(read_private(&project.path(".deployment-project-id"), 64)?)?;
        ensure!(
            self.smtp_identity.as_ref() == Some(&id),
            "alert_email_project_changed"
        );
        let url = project
            .env()
            .get("NELCOTA_SMTP_URL")?
            .context("smtp_not_configured")?;
        let from = project
            .env()
            .get("NELCOTA_SMTP_FROM")?
            .context("smtp_not_configured")?;
        management::settings::approved_service(policy, &url)?;
        nelcota_auth::SmtpMailer::new(&url, &from)
            .map_err(|_| anyhow::anyhow!("invalid_smtp_configuration"))?;
        Ok((url, from))
    }
}
fn encode(settings: &Settings) -> anyhow::Result<String> {
    let bytes = serde_json::to_vec(settings)?;
    ensure!(bytes.len() <= 4096, "invalid_alert_configuration");
    Ok(STANDARD.encode(bytes))
}
fn decode(value: &str) -> anyhow::Result<Settings> {
    ensure!(value.len() <= 5500, "invalid_alert_configuration");
    let bytes = STANDARD
        .decode(value)
        .context("invalid_alert_configuration")?;
    let settings: Settings =
        serde_json::from_slice(&bytes).context("invalid_alert_configuration")?;
    settings.validate()?;
    Ok(settings)
}
pub(crate) fn endpoint(policy: &Policy, value: &str) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(value).map_err(|_| anyhow::anyhow!("invalid_alert_endpoint"))?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && value.len() <= 2048
            && !value.chars().any(char::is_control)
            && !value.contains(['\'', '\\', '"']),
        "invalid_alert_endpoint"
    );
    management::settings::approved_service(policy, value)?;
    Ok(url)
}
pub(crate) fn prepare(
    policy: &Policy,
    settings: Settings,
    webhook: Option<String>,
    heartbeat: Option<String>,
) -> anyhow::Result<BTreeMap<String, Option<String>>> {
    settings.validate()?;
    let host = Host::new(&policy.root);
    let old = Config::read(&host)?;
    if !settings.enabled {
        return Ok([(SETTINGS.to_owned(), Some(encode(&settings)?))]
            .into_iter()
            .collect());
    }
    let choose = |enabled: bool,
                  value: Option<String>,
                  old: Option<String>|
     -> anyhow::Result<Option<String>> {
        if !enabled {
            return Ok(None);
        }
        let value = value
            .filter(|s| !s.is_empty())
            .or(old)
            .context("alert_endpoint_required")?;
        endpoint(policy, &value)?;
        Ok(Some(value))
    };
    let webhook = choose(settings.webhook_enabled, webhook, old.webhook)?;
    let heartbeat = choose(settings.heartbeat_enabled, heartbeat, old.heartbeat)?;
    let smtp_identity = match settings.email_enabled {
        true => {
            nelcota_auth::normalize_email(&settings.recipient)
                .map_err(|_| anyhow::anyhow!("invalid_alert_recipient"))?;
            ensure!(
                policy
                    .operators
                    .iter()
                    .any(|o| o.manage_host && o.email == settings.recipient),
                "invalid_alert_recipient"
            );
            let p = management::control_project(policy, &settings.smtp_project)?;
            let id = String::from_utf8(read_private(&p.path(".deployment-project-id"), 64)?)?;
            let probe = Config {
                settings: settings.clone(),
                webhook: None,
                heartbeat: None,
                smtp_identity: Some(id.clone()),
            };
            probe.smtp(policy)?;
            Some(id)
        }
        false => None,
    };
    let encoded = encode(&settings)?;
    Ok([
        (SETTINGS, Some(encoded)),
        (WEBHOOK, webhook),
        (HEARTBEAT, heartbeat),
        (IDENTITY, smtp_identity),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect())
}
pub(crate) fn approve_prepared(policy: &Policy, after: &str) -> anyhow::Result<()> {
    let values = crate::envfile::parse(after)
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    if values
        .get(SETTINGS)
        .is_some_and(|v| decode(v).is_ok_and(|s| !s.enabled))
    {
        return Ok(());
    }
    for key in [WEBHOOK, HEARTBEAT] {
        if let Some(value) = values.get(key) {
            endpoint(policy, value)?;
        }
    }
    if let Some(value) = values.get(SETTINGS) {
        let settings = decode(value)?;
        settings.validate()?;
        if settings.email_enabled {
            let cfg = Config {
                settings,
                webhook: None,
                heartbeat: None,
                smtp_identity: values.get(IDENTITY).cloned(),
            };
            cfg.smtp(policy)?;
        }
    }
    Ok(())
}
pub(super) fn host(url: Option<&String>) -> Option<String> {
    url.and_then(|v| url::Url::parse(v).ok())
        .and_then(|u| u.host_str().map(str::to_owned))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn policy(root: &std::path::Path) -> Policy {
        serde_json::from_value(serde_json::json!({"schema":1,"root":root,"origin":"https://control.example.test","controller_uid":1,"controller_gid":1,"verifier":"/verified/gh","operators":[],"project_ids":{},"enable_installation":false,"validation_report":null,"minimum_free_bytes":1073741824u64,"timeout_seconds":300,"host_management":{"service_hosts":["notify.example.test"],"version":"0.5.1","image_digest":"a".repeat(64),"source_sha":"b".repeat(40),"max_projects":32,"domain_suffixes":["example.test"],"addresses":["1.1.1.1"]}})).unwrap()
    }
    #[test]
    fn private_configuration_rejects_symlinks_public_modes_and_oversized_files() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let host = Host::new(dir.path());
        let target = dir.path().join("original");
        crate::private_fs::write(&target, "KEEP=unchanged\n").unwrap();
        symlink(&target, host.secrets().path()).unwrap();
        assert!(Config::read(&host).is_err(), "symlinked host.env accepted");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "KEEP=unchanged\n"
        );
        std::fs::remove_file(host.secrets().path()).unwrap();
        host.secrets().set("KEEP", "unchanged").unwrap();
        std::fs::set_permissions(
            host.secrets().path(),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(Config::read(&host).is_err(), "public host.env accepted");
        crate::private_fs::write(host.secrets().path(), "x".repeat(65537)).unwrap();
        assert!(Config::read(&host).is_err(), "oversized host.env accepted");
    }
    #[test]
    fn endpoint_grants_are_exact_and_disable_needs_no_outbound_authority() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = policy(dir.path());
        crate::private_fs::write(&dir.path().join("host.env"), "").unwrap();
        for url in [
            "http://notify.example.test",
            "https://foreign.example.test",
            "https://notify.example.test.evil.test",
            "https://user:pass@notify.example.test",
            "https://notify.example.test/#secret",
            "https://127.0.0.1",
        ] {
            assert!(endpoint(&p, url).is_err(), "{url}");
        }
        let url = "https://notify.example.test/token?key=private";
        let settings = Settings {
            enabled: true,
            webhook_enabled: true,
            ..Settings::default()
        };
        let values = prepare(&p, settings.clone(), Some(url.into()), None).unwrap();
        let env = Host::new(dir.path()).secrets();
        for (k, v) in &values {
            if let Some(v) = v {
                env.set(k, v).unwrap();
            }
        }
        let after = std::fs::read_to_string(env.path()).unwrap();
        approve_prepared(&p, &after).unwrap();
        assert_eq!(
            prepare(&p, settings.clone(), Some(String::new()), None).unwrap()[WEBHOOK].as_deref(),
            Some(url)
        );
        p.host_management.as_mut().unwrap().service_hosts.clear();
        assert!(approve_prepared(&p, &after).is_err());
        assert!(prepare(&p, settings, None, None).is_err());
        let disabled = prepare(&p, Settings::default(), None, None).unwrap();
        assert_eq!(disabled.len(), 1);
        env.set(SETTINGS, disabled[SETTINGS].as_ref().unwrap())
            .unwrap();
        approve_prepared(&p, &std::fs::read_to_string(env.path()).unwrap()).unwrap();
        assert_eq!(
            host(Some(&url.into())).as_deref(),
            Some("notify.example.test")
        );
    }
    #[test]
    fn enrolled_email_punctuation_survives_literal_env_roundtrip() {
        let settings = Settings {
            email_enabled: true,
            smtp_project: "base".into(),
            recipient: "o'brien@example.test".into(),
            ..Settings::default()
        };
        let encoded = encode(&settings).unwrap();
        assert!(!encoded.contains(['\'', '\\', '\n']));
        let dir = tempfile::tempdir().unwrap();
        let host = Host::new(dir.path());
        host.secrets().set(SETTINGS, &encoded).unwrap();
        assert_eq!(Config::read(&host).unwrap().settings, settings);
        assert!(decode("not base64").is_err());
    }
}
