//! Compare live container metadata without returning or logging its credentials.
use super::effects::output;
use crate::project::Project;
use anyhow::Context;
use anyhow::bail;
use std::process::Command;
fn inspect(id: &str) -> anyhow::Result<Command> {
    let id = id.trim();
    if !(12..=64).contains(&id.len()) || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("running_configuration_unavailable");
    }
    let mut command = Command::new("docker");
    command.args(["inspect", "--format", "{{json .Config.Env}}", id]);
    Ok(command)
}
fn matches(project: &Project, body: &str) -> anyhow::Result<bool> {
    let actual: Vec<String> =
        serde_json::from_str(body).context("running_configuration_unavailable")?;
    Ok(equal(&project.env().read()?, &actual))
}
fn overridden(key: &str) -> bool {
    matches!(
        key,
        "NELCOTA_LISTEN"
            | "NELCOTA_TRUST_PROXY"
            | "NELCOTA_PROJECT_NAME"
            | "NELCOTA_HOST_REGISTRY"
            | "NELCOTA_DEPLOYMENT_VALIDATION"
            | "NELCOTA_DEPLOYMENT_ID"
            | "NELCOTA_DEPLOYMENT_GATE"
    )
}
fn equal(expected: &[(String, String)], actual: &[String]) -> bool {
    let actual = actual
        .iter()
        .filter_map(|s| s.split_once('='))
        .collect::<std::collections::HashMap<_, _>>();
    let expected = expected
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    let forward = expected
        .iter()
        .all(|(key, value)| overridden(key) || actual.get(key).is_some_and(|live| live == value));
    // Removal is a change too. Do not let an unapplied deleted credential become
    // the rollback baseline just because it is absent from the disk-side map.
    forward
        && actual
            .iter()
            .filter(|(key, _)| key.starts_with("NELCOTA_") || **key == "POSTGRES_PASSWORD")
            .all(|(key, value)| {
                overridden(key) || expected.get(key).is_some_and(|disk| disk == value)
            })
}
pub(super) async fn check(project: &Project) -> anyhow::Result<bool> {
    let mut command = project.compose_command();
    command.args(["ps", "-a", "-q", "app"]);
    let id = output(command).await?;
    matches(project, &output(inspect(&id)?).await?)
}
pub(super) fn check_sync(project: &Project) -> anyhow::Result<()> {
    let mut command = project.compose_command();
    command.args(["ps", "-a", "-q", "app"]);
    let id = super::super::probes::output(&command)?;
    if !matches(project, &super::super::probes::output(&inspect(&id)?)?)? {
        bail!("running_configuration_changed");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comparison_keeps_secret_delimiters_and_does_not_accept_a_manual_setting_change() {
        let expected = vec![
            (
                "NELCOTA_SMTP_URL".into(),
                "smtps://user:encoded=something@example.test".into(),
            ),
            ("NELCOTA_LISTEN".into(), "127.0.0.1:8000".into()),
        ];
        let current = vec![
            "NELCOTA_SMTP_URL=smtps://user:encoded=something@example.test".into(),
            "NELCOTA_LISTEN=0.0.0.0:8000".into(),
        ];
        assert!(equal(&expected, &current));
        assert!(!equal(
            &expected,
            &["NELCOTA_SMTP_URL=smtps://changed@example.test".into()]
        ));
        assert!(!equal(&expected, &[]));
        assert!(!equal(
            &[],
            &["NELCOTA_SMTP_URL=smtps://old@example.test".into()]
        ));
        assert!(inspect("--format=credentials").is_err());
        assert!(inspect("abc\n--privileged").is_err());
    }
}
