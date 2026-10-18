//! Guard the actual container entrypoints, including daemon/host restarts.
use super::{ACTIVE, Fence, RECEIPT, quote, recovery};
use anyhow::{Context, bail};
use nelcota_deployment::{atomic_write, read_private};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, process::Stdio};

const ORIGINAL: &str = "compose.original.yml";
const ORIGINAL_DIGEST: &str = "compose.original.sha256";
const DIGEST: &str = "compose.guarded.sha256";
const GUARDED: &str = "compose.guarded.json";
const MOUNT: &str = "/nelcota-pitr-fence";

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn arm(fence: &Fence<'_>) -> anyhow::Result<()> {
    let project = fence.project;
    if fence.owned(RECEIPT)? || fence.owned(ACTIVE)? {
        validate_compose(fence)?;
        let guarded = read_private(&fence.state.join(GUARDED), 2 * 1024 * 1024)?;
        atomic_write(&project.path("docker-compose.yml"), &guarded)?;
        // A retry must also remove any existing guarded stopped containers.
        return project.compose_ok(&["rm", "--stop", "--force", "app", "postgres"]);
    }
    // Older scratch app images have no shell and cannot safely enforce a file
    // fence. Refuse before changing PGDATA rather than assuming their version.
    let support = project
        .compose_command()
        .args([
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "--entrypoint",
            "/usr/local/bin/nelcota",
            "app",
            "guarded-serve",
            "--check-support",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !support.success() {
        bail!(
            "the app image must support the PITR entrypoint guard; upgrade it to the matching Nelcota version before restoring (PGDATA was not changed)"
        );
    }
    let original = fs::read(project.path("docker-compose.yml"))?;
    if original.len() > 2 * 1024 * 1024 {
        bail!("compose exceeds the PITR recovery receipt limit");
    }
    let output = project
        .compose_command()
        .args(["config", "--format", "json"])
        .output()?;
    if !output.status.success() || output.stdout.len() > 2 * 1024 * 1024 {
        bail!("could not resolve a bounded Docker configuration before PITR");
    }
    let config: Value = serde_json::from_slice(&output.stdout)?;
    let guarded = guarded_config(fence, config)?;
    // The original is exact bytes, kept private: resolved Compose JSON can
    // contain credentials. Do not print or publish either configuration.
    atomic_write(&fence.state.join(ORIGINAL), &original)?;
    atomic_write(
        &fence.state.join(ORIGINAL_DIGEST),
        digest(&original).as_bytes(),
    )?;
    atomic_write(&fence.state.join(GUARDED), &guarded)?;
    atomic_write(&fence.state.join(DIGEST), digest(&guarded).as_bytes())?;
    atomic_write(&project.path("docker-compose.yml"), &guarded)?;
    // Existing containers retain their old entrypoint and restart policy.
    // Delete them, without deleting volumes, before activating the fence or
    // permitting any restore. New containers always get guarded entrypoints.
    project.compose_ok(&["rm", "--stop", "--force", "app", "postgres"])?;
    Ok(())
}

fn guarded_config(fence: &Fence<'_>, mut config: Value) -> anyhow::Result<Vec<u8>> {
    let message = format!(
        "PITR fence {MOUNT}/{ACTIVE} blocks startup; run `{}` (backup recovery guide)",
        recovery(fence.project)?
    );
    for name in ["postgres", "app"] {
        let service = config
            .get_mut("services")
            .and_then(|services| services.get_mut(name))
            .and_then(Value::as_object_mut)
            .context("PITR requires app and postgres Compose services")?;
        // Keep failed guards from entering a Docker restart loop. The original
        // policy is restored with the exact original Compose file after recovery.
        service.insert("restart".into(), json!("no"));
        if service.get("entrypoint").is_some_and(|v| !v.is_null()) {
            bail!("custom {name} entrypoint requires reviewed PITR fencing before restore");
        }
        let volumes = service
            .entry("volumes")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .context("invalid Compose volumes")?;
        if volumes
            .iter()
            .any(|v| v.get("target").and_then(Value::as_str) == Some(MOUNT))
        {
            bail!("PITR fence mount conflicts with a custom volume");
        }
        volumes.push(
            json!({"type":"bind", "source":fence.state.canonicalize()?, "target":MOUNT,
            "read_only":true,"bind":{"create_host_path":false}}),
        );
        if name == "app" {
            if service
                .get("command")
                .is_some_and(|v| !v.is_null() && *v != json!(["serve"]))
            {
                bail!("custom app command requires reviewed PITR fencing before restore");
            }
            service.insert(
                "entrypoint".into(),
                json!([
                    "/usr/local/bin/nelcota",
                    "guarded-serve",
                    "--state",
                    MOUNT,
                    "--recovery",
                    recovery(fence.project)?
                ]),
            );
            service.insert("command".into(), json!([]));
        }
        if name == "postgres" {
            let pgdata = service.get("environment").and_then(|e| e.get("PGDATA"));
            if pgdata
                .is_some_and(|v| !v.is_null() && v.as_str() != Some("/var/lib/postgresql/data"))
            {
                bail!("custom PGDATA requires reviewed PITR fencing before restore");
            }
            let script = format!(
                "set -eu; if [ -e {MOUNT}/{ACTIVE} ] || [ -L {MOUNT}/{ACTIVE} ] || [ -e {MOUNT}/{RECEIPT} ] || [ -L {MOUNT}/{RECEIPT} ]; then printf '%s\\n' {} >&2; exit 78; fi; exec /usr/local/bin/docker-entrypoint.sh \"$@\"",
                quote(&message)
            );
            service.insert("entrypoint".into(), json!(["/bin/sh", "-c", script, "--"]));
        }
    }
    // `config` already resolved interpolation. Preserve literal dollars on
    // Compose's next read, including credentials and the shell's "$@".
    escape_dollars(&mut config);
    Ok(serde_json::to_vec_pretty(&config)?)
}

fn escape_dollars(value: &mut Value) {
    match value {
        Value::String(text) => *text = text.replace('$', "$$"),
        Value::Array(items) => items.iter_mut().for_each(escape_dollars),
        Value::Object(items) => items.values_mut().for_each(escape_dollars),
        _ => {}
    }
}

fn validate_compose(fence: &Fence<'_>) -> anyhow::Result<Vec<u8>> {
    let original = read_private(&fence.state.join(ORIGINAL), 2 * 1024 * 1024)?;
    if digest(&original).as_bytes() != read_private(&fence.state.join(ORIGINAL_DIGEST), 64)? {
        bail!("saved original Docker configuration changed; PITR fence retained");
    }
    let expected = read_private(&fence.state.join(DIGEST), 64)?;
    let guarded = read_private(&fence.state.join(GUARDED), 2 * 1024 * 1024)?;
    if digest(&guarded).as_bytes() != expected {
        bail!("saved Docker PITR start guard changed; preserve the fence and inspect manually");
    }
    let current = fs::read(fence.project.path("docker-compose.yml"))?;
    // A power cut during release may leave the original already restored.
    if current != original && digest(&current).as_bytes() != expected {
        bail!(
            "Docker configuration changed while PITR-fenced; preserve the fence and inspect manually"
        );
    }
    Ok(original)
}

pub(super) fn restore_compose(fence: &Fence<'_>) -> anyhow::Result<()> {
    let original = validate_compose(fence)?;
    atomic_write(&fence.project.path("docker-compose.yml"), &original)?;
    Ok(())
}

#[cfg(test)]
pub(super) fn render_fixture(fence: &Fence<'_>, config: Value) -> anyhow::Result<Vec<u8>> {
    guarded_config(fence, config)
}
