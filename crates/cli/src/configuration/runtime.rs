//! Fixed loopback protocol used inside the managed application container.
use super::*;
use std::time::Duration;

pub(crate) fn print_runtime() -> anyhow::Result<()> {
    let snapshot = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3))
                .build()?;
            let mut response = client
                .get("http://127.0.0.1:8000/health/configuration")
                .send()
                .await
                .context("runtime_configuration_unavailable")?;
            if !response.status().is_success() {
                bail!("runtime_configuration_unavailable");
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len() + chunk.len() > 65536 {
                    bail!("runtime_configuration_too_large");
                }
                bytes.extend_from_slice(&chunk);
            }
            let snapshot: wire::Runtime = serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("invalid_runtime_configuration"))?;
            checked_runtime(&snapshot)?;
            Ok::<_, anyhow::Error>(snapshot)
        })?;
    println!("{}", serde_json::to_string(&snapshot)?);
    Ok(())
}
