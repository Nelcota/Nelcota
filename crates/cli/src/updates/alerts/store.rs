use super::*;
fn path(policy: &Policy) -> PathBuf {
    policy.root.join("updates/alerts/state.json")
}
pub(super) fn load(policy: &Policy, revision: &str) -> anyhow::Result<Engine> {
    let file = path(policy);
    match std::fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Engine::new(revision.into()));
        }
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    super::super::policy::trusted_path(&file)?;
    let state: Engine = serde_json::from_slice(&read_private(&file, 2 * 1024 * 1024)?)?;
    state.validate()?;
    if state.configuration != revision {
        return Ok(Engine::new(revision.into()));
    }
    Ok(state)
}
pub(super) fn save(policy: &Policy, state: &Engine) -> anyhow::Result<()> {
    state.validate()?;
    let file = path(policy);
    let dir = file.parent().context("alert state directory")?;
    if std::fs::symlink_metadata(dir).is_ok() {
        super::super::policy::trusted_path(dir)?;
    }
    nelcota_deployment::private_dir(dir)?;
    super::super::policy::trusted_path(dir)?;
    if std::fs::symlink_metadata(&file).is_ok() {
        super::super::policy::trusted_path(&file)?;
    }
    let bytes = serde_json::to_vec(state)?;
    ensure!(bytes.len() <= 2 * 1024 * 1024, "alert_state_limit");
    nelcota_deployment::atomic_write(&file, &bytes)
}
