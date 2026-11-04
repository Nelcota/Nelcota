//! Pure routine-settings adaptation shared by the controller and its unit tests.
//! No ambient config or side effects below; the fixed loopback probe is isolated
//! in `runtime`. Private source values never appear in adapter errors.
use anyhow::{Context, bail};
use nelcota_core::{Config, settings};
use nelcota_deployment::settings::{self as wire, Value};
use std::collections::{BTreeMap, HashSet};

mod runtime;
pub(crate) use runtime::print_runtime;

pub(crate) struct Batch {
    pub after: String,
    pub changes: Vec<wire::Change>,
}

pub(crate) fn revision(before: &str, identity: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"nelcota-project-settings-v1\0");
    hash.update(identity.as_bytes());
    hash.update(b"\0");
    hash.update(before.as_bytes());
    base16ct::lower::encode_string(&hash.finalize())
}

fn file_override(entries: &[(String, String)]) -> bool {
    entries
        .iter()
        .any(|(k, v)| k == "NELCOTA_CONFIG" && !v.is_empty())
}

fn load(entries: &[(String, String)]) -> anyhow::Result<Config> {
    let mut seen = HashSet::new();
    if entries.iter().any(|(key, _)| !seen.insert(key)) {
        bail!("ambiguous_project_environment");
    }
    if file_override(entries) {
        bail!("project_configuration_file_override");
    }
    // Figment errors can contain source values, so discard rather than wrap them.
    Config::from_environment(entries.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .map_err(|_| anyhow::anyhow!("invalid_project_configuration"))
}

fn source(before: &str) -> anyhow::Result<Vec<(String, String)>> {
    if before.len() > 65536 {
        bail!("configuration_too_large");
    }
    // EnvFile's permissive legacy reader is not a Compose interpreter. Refuse
    // ambiguous/interpolated source rather than validate a different candidate.
    for line in before.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, raw) = line
            .split_once('=')
            .context("ambiguous_project_environment")?;
        if key.is_empty()
            || !key
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            bail!("ambiguous_project_environment");
        }
        let raw = raw.trim();
        let literal = raw.strip_prefix('\'').and_then(|v| v.strip_suffix('\''));
        if let Some(literal) = literal {
            crate::envfile::validate_environment_literal(key, literal)
                .map_err(|_| anyhow::anyhow!("ambiguous_project_environment"))?;
            continue;
        }
        let value = raw
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(raw);
        if value.contains(['\'', '"', '\\', '$', '#']) || value.chars().any(char::is_control) {
            bail!("ambiguous_project_environment");
        }
    }
    let entries = crate::envfile::parse(before);
    let _config = load(&entries)?;
    Ok(entries)
}

fn value(definition: &settings::Definition, config: &Config) -> anyhow::Result<Value> {
    serde_json::from_value(definition.value(config))
        .map_err(|_| anyhow::anyhow!("invalid_project_setting"))
}
fn effective_value(definition: &settings::Definition, config: &Config) -> anyhow::Result<Value> {
    serde_json::from_value(definition.effective_value(config))
        .map_err(|_| anyhow::anyhow!("invalid_project_setting"))
}

pub(crate) fn prepare(
    before: &str,
    identity: &str,
    expected: &str,
    changes: BTreeMap<String, Value>,
) -> anyhow::Result<Batch> {
    if !nelcota_deployment::valid_digest(expected) || revision(before, identity) != expected {
        bail!("project_configuration_changed");
    }
    let entries = source(before)?;
    let current = load(&entries)?;
    let changes_json = changes
        .iter()
        .map(|(k, v)| Ok((k.clone(), serde_json::to_value(v)?)))
        .collect::<anyhow::Result<BTreeMap<_, _>>>()?;
    let next = settings::candidate(&current, &changes_json)?;
    let mut values = BTreeMap::new();
    let mut review = Vec::new();
    for definition in settings::CATALOG {
        if let Some(change) = changes.get(definition.key) {
            let exists = entries
                .iter()
                .any(|(k, _)| k == &definition.environment_key());
            let unchanged = match change {
                Value::Automatic(()) => !exists,
                _ => exists && value(definition, &current)? == *change,
            };
            if unchanged {
                continue;
            }
            let text = match change {
                Value::Automatic(()) => None,
                Value::Origins(origins) => Some(origins.join(",")),
                _ => Some(serde_json::to_string(change)?),
            };
            values.insert(definition.environment_key(), text);
            review.push(wire::Change {
                key: definition.key.into(),
                before: effective_value(definition, &current)?,
                after: effective_value(definition, &next)?,
            });
        }
    }
    for definition in settings::CATALOG {
        if !changes.contains_key(definition.key)
            && definition.effective_value(&current) != definition.effective_value(&next)
        {
            review.push(wire::Change {
                key: definition.key.into(),
                before: effective_value(definition, &current)?,
                after: effective_value(definition, &next)?,
            });
        }
    }
    let after = crate::envfile::patch_literal(before, &values)?;
    if review.is_empty() || after == before {
        bail!("project_configuration_unchanged");
    }
    // Validate the serialized candidate too: a reset must agree with defaults.
    let persisted = load(&source(&after)?)?;
    persisted
        .validate()
        .map_err(|_| anyhow::anyhow!("invalid_project_configuration"))?;
    for definition in settings::CATALOG {
        if definition.value(&persisted) != definition.value(&next) {
            bail!("invalid_project_configuration");
        }
    }
    Ok(Batch {
        after,
        changes: review,
    })
}

pub(crate) fn view(
    before: &str,
    identity: &str,
    runtime: Option<&wire::Runtime>,
) -> anyhow::Result<wire::View> {
    let entries = source(before);
    let saved = entries
        .as_ref()
        .ok()
        .and_then(|e| load(e).ok())
        .filter(|c| c.validate().is_ok() && c.oauth().is_ok());
    let blocked = match saved {
        None if file_override(&crate::envfile::parse(before)) => Some(wire::Blocker::FileOverride),
        None => Some(wire::Blocker::InvalidSavedConfiguration),
        Some(_) => None,
    };
    let live = runtime.filter(|r| checked_runtime(r).is_ok());
    let runtime_status = match (runtime, live) {
        (_, Some(_)) => wire::RuntimeStatus::Effective,
        (None, _) => wire::RuntimeStatus::Unavailable,
        _ => wire::RuntimeStatus::Invalid,
    };
    let mut projected = Vec::new();
    if let Some(saved) = saved {
        for definition in settings::CATALOG {
            let saved_value = value(definition, &saved)?;
            let expected_value = effective_value(definition, &saved)?;
            let runtime_value = match live {
                Some(snapshot) => snapshot
                    .values
                    .get(definition.key)
                    .context("invalid_runtime_configuration")?
                    .clone(),
                None => Value::Automatic(()),
            };
            let source = match entries
                .as_ref()
                .is_ok_and(|e| e.iter().any(|(k, _)| k == &definition.environment_key()))
            {
                true => wire::Source::Environment,
                false => wire::Source::Default,
            };
            projected.push(wire::Setting {
                key: definition.key.into(),
                group: match definition.group {
                    settings::Group::Authentication => wire::Group::Authentication,
                    settings::Group::Api => wire::Group::Api,
                    settings::Group::Storage => wire::Group::Storage,
                },
                kind: match definition.kind {
                    settings::Kind::Boolean => wire::Kind::Boolean,
                    settings::Kind::Integer => wire::Kind::Integer,
                    settings::Kind::Origins => wire::Kind::Origins,
                },
                nullable: definition.nullable,
                minimum: definition.minimum,
                maximum: definition.maximum,
                dependencies: definition
                    .dependencies
                    .iter()
                    .map(|v| (*v).into())
                    .collect(),
                default_value: serde_json::from_value(definition.default_value())?,
                pending_restart: live.map(|_| expected_value != runtime_value),
                expected_value,
                saved_value,
                runtime_value,
                source,
            });
        }
    }
    Ok(wire::View {
        revision: revision(before, identity),
        settings: projected,
        runtime_status,
        blocked,
    })
}

pub(crate) fn checked_runtime(snapshot: &wire::Runtime) -> anyhow::Result<()> {
    if snapshot.schema != 1 || snapshot.values.len() != settings::CATALOG.len() {
        bail!("invalid_runtime_configuration");
    }
    for definition in settings::CATALOG {
        let value = snapshot
            .values
            .get(definition.key)
            .context("invalid_runtime_configuration")?;
        let valid = match (definition.kind, value) {
            (_, Value::Automatic(())) => definition.nullable,
            (settings::Kind::Boolean, Value::Boolean(_)) => true,
            (settings::Kind::Integer, Value::Integer(_)) => true,
            (settings::Kind::Origins, Value::Origins(_)) => {
                definition.validate(&serde_json::to_value(value)?).is_ok()
            }
            _ => false,
        };
        if !valid {
            bail!("invalid_runtime_configuration");
        }
    }
    Ok(())
}

/// Compare saved values to an actual process-start snapshot, not merely the
/// container's environment or the controller's assumptions about old defaults.
pub(crate) fn verify_runtime(before: &str, runtime: &wire::Runtime) -> anyhow::Result<()> {
    checked_runtime(runtime)?;
    let config = load(&source(before)?)?;
    for definition in settings::CATALOG {
        if runtime.values.get(definition.key) != Some(&effective_value(definition, &config)?) {
            bail!("project_configuration_not_effective");
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests;
