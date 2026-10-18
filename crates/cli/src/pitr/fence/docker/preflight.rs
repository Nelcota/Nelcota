//! Accept only PostgreSQL commands whose complete argument vector is known.
use anyhow::bail;
use serde_json::{Map, Value, json};

pub(super) fn validate(service: &Map<String, Value>) -> anyhow::Result<()> {
    match service.get("environment") {
        None | Some(Value::Null) => {}
        Some(Value::Object(environment)) => {
            if environment
                .get("PGDATA")
                .is_some_and(|value| value.as_str() != Some("/var/lib/postgresql/data"))
            {
                bail!(
                    "unsupported services.postgres.environment.PGDATA; supported configuration: omit PGDATA or set it to /var/lib/postgresql/data"
                );
            }
        }
        Some(_) => bail!(
            "cannot determine services.postgres.environment.PGDATA; supported configuration: resolved environment mapping with PGDATA omitted or /var/lib/postgresql/data"
        ),
    }
    let command = match service.get("command") {
        None | Some(Value::Null) => return Ok(()),
        Some(command) => command,
    };
    if *command == json!(["postgres"]) {
        return Ok(());
    }
    // Exact generated profiles, not a parser/denylist of potentially dangerous
    // flags. Reordering, additions and alternate spellings are unsupported.
    for profile in ["1gb", "2gb", "4gb", "8gb"] {
        let mut supported = vec!["postgres".to_owned()];
        for (key, value) in crate::scaffold::profile_settings(profile) {
            supported.extend(["-c".to_owned(), format!("{key}={value}")]);
        }
        if *command == json!(supported) {
            return Ok(());
        }
    }
    bail!(
        "unsupported services.postgres.command; supported configuration: omit command, use [\"postgres\"], or retain the exact generated 1gb/2gb/4gb/8gb profile command (see the backup/PITR guide)"
    )
}
