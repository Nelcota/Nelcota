//! Fixed loopback protocol used inside the managed application container.
use super::*;
use std::time::Duration;

fn client() -> Result<reqwest::Client, reqwest::Error> {
    // This command is a fresh process: no server/mail client has initialized
    // rustls. reqwest's rustls-no-provider backend needs our pinned provider
    // even for a plain HTTP request.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
}

pub(crate) fn print_runtime() -> anyhow::Result<()> {
    let snapshot = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let client = client()?;
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

#[cfg(test)]
mod tests {
    #[test]
    fn transport_initializes_in_a_fresh_process_without_other_tls_clients() {
        const CHILD: &str = "NELCOTA_CONFIGURATION_TRANSPORT_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let _guard = runtime.enter();
            super::client().unwrap();
            return;
        }
        // A provider installed by an unrelated test must not conceal a broken
        // standalone `configuration-state` process.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "configuration::runtime::tests::transport_initializes_in_a_fresh_process_without_other_tls_clients",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
