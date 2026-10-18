//! Guard the actual container entrypoints, including daemon/host restarts.
use super::files::Directory;
use super::{ACTIVE, Fence, RECEIPT, quote, recovery};
use anyhow::{Context, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::process::Stdio;

const ORIGINAL: &str = "compose.original.yml";
const ORIGINAL_DIGEST: &str = "compose.original.sha256";
const DIGEST: &str = "compose.guarded.sha256";
const GUARDED: &str = "compose.guarded.json";
const MOUNT: &str = "/nelcota-pitr-fence";
const MOUNT_STATE: &str = "/nelcota-pitr-fence/pitr-fence";

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn arm(fence: &Fence<'_>) -> anyhow::Result<()> {
    let project = fence.project;
    let directory = fence.directory()?;
    let project_directory =
        Directory::open(&project.dir, false, false)?.context("PITR project is missing")?;
    if fence.owned(RECEIPT)? || fence.owned(ACTIVE)? {
        validate_compose(fence)?;
        let guarded = directory.read(GUARDED, 2 * 1024 * 1024, true)?;
        let upgraded = upgraded_guard(fence, &guarded)?;
        project_directory.write_config("docker-compose.yml", &upgraded)?;
        return project.compose_ok(&["rm", "--stop", "--force", "app", "postgres"]);
    }
    // Inspect the primary config without following links before invoking
    // Compose, even for its non-serving capability preflight.
    let original = project_directory.read("docker-compose.yml", 2 * 1024 * 1024, false)?;
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
            "--check-only",
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
    directory.write(ORIGINAL, &original)?;
    directory.write(ORIGINAL_DIGEST, digest(&original).as_bytes())?;
    directory.write(GUARDED, &guarded)?;
    directory.write(DIGEST, digest(&guarded).as_bytes())?;
    project_directory.write_config("docker-compose.yml", &guarded)?;
    // Existing containers retain their old entrypoint and restart policy.
    // Delete them, without deleting volumes, before activating the fence or
    // permitting any restore. New containers always get guarded entrypoints.
    project.compose_ok(&["rm", "--stop", "--force", "app", "postgres"])?;
    Ok(())
}

fn guarded_config(fence: &Fence<'_>, mut config: Value) -> anyhow::Result<Vec<u8>> {
    let message = format!(
        "PITR fence {MOUNT_STATE}/{ACTIVE} blocks startup; run `{}` (backup recovery guide)",
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
            json!({"type":"bind", "source":fence.project.dir.canonicalize()?, "target":MOUNT,
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
                    MOUNT_STATE,
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
                "set -eu; if [ -L {MOUNT_STATE} ] || [ ! -d {MOUNT_STATE} ] || [ \"$(stat -c %u {MOUNT_STATE})\" != \"$(stat -c %u {MOUNT})\" ] || [ -e {MOUNT_STATE}/{ACTIVE} ] || [ -L {MOUNT_STATE}/{ACTIVE} ] || [ -e {MOUNT_STATE}/{RECEIPT} ] || [ -L {MOUNT_STATE}/{RECEIPT} ] || [ ! -f {MOUNT_STATE}/release.verified.json ] || [ -L {MOUNT_STATE}/release.verified.json ] || [ \"$(stat -c %u {MOUNT_STATE}/release.verified.json)\" != \"$(stat -c %u {MOUNT})\" ] || [ \"$(stat -c %a {MOUNT_STATE}/release.verified.json)\" != 600 ] || [ \"$(stat -c %h {MOUNT_STATE}/release.verified.json)\" != 1 ]; then printf '%s\\n' {} >&2; exit 78; fi; exec /usr/local/bin/docker-entrypoint.sh \"$@\"",
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

fn upgraded_guard(fence: &Fence<'_>, guarded: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut config: Value = serde_json::from_slice(guarded)?;
    unescape_dollars(&mut config);
    for name in ["app", "postgres"] {
        let service = config["services"][name]
            .as_object_mut()
            .context("invalid saved PITR service")?;
        service.remove("entrypoint");
        if name == "app" {
            service.remove("command");
        }
        if let Some(volumes) = service.get_mut("volumes").and_then(Value::as_array_mut) {
            volumes.retain(|v| v.get("target").and_then(Value::as_str) != Some(MOUNT));
        }
    }
    guarded_config(fence, config)
}

pub(super) fn original(fence: &Fence<'_>) -> anyhow::Result<Vec<u8>> {
    let directory = fence.directory()?;
    let original = directory.read(ORIGINAL, 2 * 1024 * 1024, true)?;
    if digest(&original).as_bytes() != directory.read(ORIGINAL_DIGEST, 64, true)? {
        bail!(
            "PITR fence {}: saved original Compose changed; all markers retained",
            directory.path.join(ORIGINAL).display()
        );
    }
    Ok(original)
}

fn validate_compose(fence: &Fence<'_>) -> anyhow::Result<Vec<u8>> {
    let original = original(fence)?;
    let directory = fence.directory()?;
    let expected = directory.read(DIGEST, 64, true)?;
    let guarded = directory.read(GUARDED, 2 * 1024 * 1024, true)?;
    if digest(&guarded).as_bytes() != expected {
        bail!("PITR fence saved Docker guard changed; preserve all markers");
    }
    let project =
        Directory::open(&fence.project.dir, false, false)?.context("PITR project is missing")?;
    let current = project.read("docker-compose.yml", 2 * 1024 * 1024, false)?;
    // Accept a pre-fix interrupted release only so explicit recovery can
    // re-arm its guards BEFORE touching PostgreSQL. Never clear it directly.
    if current != original
        && digest(&current).as_bytes() != expected
        && current != upgraded_guard(fence, &guarded)?
    {
        bail!(
            "PITR fence {}: Docker configuration changed; preserve all markers",
            project.path.join("docker-compose.yml").display()
        );
    }
    Ok(original)
}

pub(super) fn validate_for_recovery(fence: &Fence<'_>) -> anyhow::Result<()> {
    validate_compose(fence)?;
    fence.owned(super::RELEASED)?;
    Ok(())
}

pub(super) fn require_guarded(fence: &Fence<'_>) -> anyhow::Result<()> {
    validate_compose(fence)?;
    let project =
        Directory::open(&fence.project.dir, false, false)?.context("PITR project is missing")?;
    let current = project.read("docker-compose.yml", 2 * 1024 * 1024, false)?;
    let saved = fence.directory()?.read(GUARDED, 2 * 1024 * 1024, true)?;
    if current != saved && current != upgraded_guard(fence, &saved)? {
        bail!("PITR fence requires guarded Compose before release; rerun pitr recover --yes");
    }
    Ok(())
}

pub(super) fn require_original(fence: &Fence<'_>) -> anyhow::Result<()> {
    let project =
        Directory::open(&fence.project.dir, false, false)?.context("PITR project is missing")?;
    if project.read("docker-compose.yml", 2 * 1024 * 1024, false)? != original(fence)? {
        bail!("PITR fence has no committed original Compose; preserve diagnostics");
    }
    Ok(())
}

fn unescape_dollars(value: &mut Value) {
    match value {
        Value::String(text) => *text = text.replace("$$", "$"),
        Value::Array(items) => items.iter_mut().for_each(unescape_dollars),
        Value::Object(items) => items.values_mut().for_each(unescape_dollars),
        _ => {}
    }
}

#[cfg(test)]
pub(super) fn render_fixture(fence: &Fence<'_>, config: Value) -> anyhow::Result<Vec<u8>> {
    guarded_config(fence, config)
}
