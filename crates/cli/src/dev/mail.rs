//! Project-owned local email capture with verified STARTTLS.
use super::{PROJECT_LABEL, check_owner, inspect_container};
use anyhow::{Context, bail};
use nelcota_core::{Config, Secret};
use std::{fs, path::Path, process::Command};

pub(super) fn configure(
    root: &Path,
    postgres: &str,
    callback: &str,
    config: &mut Config,
) -> anyhow::Result<()> {
    let page = url::Url::parse(callback).context("invalid --mail-callback URL")?;
    if !matches!(page.scheme(), "http" | "https")
        || page.host_str().is_none()
        || page.fragment().is_some()
        || !page.username().is_empty()
        || page.password().is_some()
    {
        bail!(
            "--mail-callback must be an HTTP(S) application page without credentials or a fragment"
        );
    }
    let directory = root.join(".nelcota/mail");
    crate::private_fs::dir(&directory)?;
    let cert = directory.join("smtp.pem");
    let key = directory.join("smtp.key");
    let ca = directory.join("ca.pem");
    let container = postgres.replace("-postgres-", "-mail-");
    // A stable private certificate lets an existing Mailpit container restart.
    if !cert.exists() || !key.exists() || !ca.exists() {
        if inspect_container(&container)?.is_some() {
            bail!(
                "Mailpit certificate is missing; remove the project container {container} and retry"
            );
        }
        let temporary = tempfile::tempdir_in(&directory)?;
        let ca_key = temporary.path().join("ca.key");
        let ca_cert = temporary.path().join("ca.pem");
        let leaf_key = temporary.path().join("key.pem");
        let csr = temporary.path().join("smtp.csr");
        let leaf_cert = temporary.path().join("cert.pem");
        let extensions = temporary.path().join("smtp.ext");
        fs::write(
            &extensions,
            "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
        )?;
        let mut command = Command::new("openssl");
        command
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "3650",
                "-subj",
                "/CN=Nelcota local mail CA",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
                "-keyout",
            ])
            .arg(&ca_key)
            .arg("-out")
            .arg(&ca_cert);
        openssl(&mut command)?;
        let mut command = Command::new("openssl");
        command
            .args([
                "req",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-subj",
                "/CN=localhost",
                "-keyout",
            ])
            .arg(&leaf_key)
            .arg("-out")
            .arg(&csr);
        openssl(&mut command)?;
        let mut command = Command::new("openssl");
        command
            .args(["x509", "-req", "-in"])
            .arg(&csr)
            .arg("-CA")
            .arg(&ca_cert)
            .arg("-CAkey")
            .arg(&ca_key)
            .args(["-CAcreateserial", "-days", "3650", "-extfile"])
            .arg(&extensions)
            .arg("-out")
            .arg(&leaf_cert);
        openssl(&mut command)?;
        crate::private_fs::write(&ca, fs::read(&ca_cert)?)?;
        crate::private_fs::write(&cert, fs::read(temporary.path().join("cert.pem"))?)?;
        crate::private_fs::write(&key, fs::read(temporary.path().join("key.pem"))?)?;
    }
    match inspect_container(&container)? {
        Some(info) => {
            check_owner(&container, &info, root)?;
            if info["State"]["Running"].as_bool() != Some(true) {
                if !Command::new("docker")
                    .args(["start", &container])
                    .status()?
                    .success()
                {
                    bail!("could not start {container}");
                }
            }
        }
        None => {
            let status = Command::new("docker")
                .args(["run", "-d", "--name", &container, "--label"])
                .arg(format!("{PROJECT_LABEL}={}", root.display()))
                .args([
                    "-e",
                    "MP_SMTP_DISABLE_RDNS=true",
                    "-p",
                    "127.0.0.1::1025",
                    "-p",
                    "127.0.0.1::8025",
                    "-v",
                ])
                .arg(format!("{}:/smtp.pem:ro", cert.display()))
                .arg("-v")
                .arg(format!("{}:/smtp.key:ro", key.display()))
                .args([
                    "axllent/mailpit:v1.27.0",
                    "--smtp-tls-cert",
                    "/smtp.pem",
                    "--smtp-tls-key",
                    "/smtp.key",
                    "--smtp-require-starttls",
                ])
                .status()?;
            if !status.success() {
                bail!("could not create local Mailpit container {container}");
            }
        }
    }
    let info = inspect_container(&container)?.context("Mailpit container disappeared")?;
    let port = |name: &str| -> anyhow::Result<u16> {
        info["NetworkSettings"]["Ports"][name][0]["HostPort"]
            .as_str()
            .context("Mailpit port is not published")?
            .parse()
            .context("invalid Mailpit port")
    };
    config.smtp_url = Some(Secret::new(format!(
        "smtp://127.0.0.1:{}?tls=required",
        port("1025/tcp")?
    )));
    config.smtp_from = Some("Nelcota local <no-reply@localhost.test>".into());
    config.smtp_ca_file = Some(ca);
    config.password_recovery_url = Some(callback.into());
    config.email_confirmation_url = Some(callback.into());
    config.magic_link_url = Some(callback.into());
    config.mail()?;
    println!(
        "  Mailpit:  http://127.0.0.1:{} (local inbox; confirmation enabled)",
        port("8025/tcp")?
    );
    println!("  Callback: {callback}");
    Ok(())
}

fn openssl(command: &mut Command) -> anyhow::Result<()> {
    let output = command
        .output()
        .context("OpenSSL is required by nelcota dev --mail")?;
    if !output.status.success() {
        bail!("could not generate the local SMTP certificate");
    }
    Ok(())
}
