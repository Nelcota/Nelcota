//! Environment checks before installing: Docker, ports, RAM and DNS.

use std::{
    fs,
    net::{IpAddr, TcpListener, ToSocketAddrs},
    path::Path,
    process::Command,
};

use anyhow::bail;

use crate::util::{ok, warn};

pub fn docker() -> anyhow::Result<()> {
    match Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
    {
        Ok(out) if out.status.success() => {
            ok(&format!(
                "Docker {}",
                String::from_utf8_lossy(&out.stdout).trim()
            ));
        }
        Ok(out) => bail!(
            "Docker is installed but {}",
            docker_failure(&String::from_utf8_lossy(&out.stderr))
        ),
        Err(_) => {
            bail!("Docker not found. Install it with: curl -fsSL https://get.docker.com | sh")
        }
    }
    match Command::new("docker")
        .args(["compose", "version", "--short"])
        .output()
    {
        Ok(out) if out.status.success() => {
            ok(&format!(
                "Docker Compose {}",
                String::from_utf8_lossy(&out.stdout).trim()
            ));
            Ok(())
        }
        _ => bail!("`docker compose` plugin not found (apt install docker-compose-plugin)"),
    }
}

/// Why `docker version` failed, from its error output.
fn docker_failure(stderr: &str) -> String {
    if stderr.to_lowercase().contains("permission denied") {
        return "this user may not use it: run with sudo, or add the user to the docker group \
         (sudo usermod -aG docker $USER, then log in again)"
            .to_owned();
    }
    "the daemon does not answer (systemctl start docker)".to_owned()
}

/// Caddy needs 80 and 443: another web server there makes HTTPS fail later.
pub fn ports() -> anyhow::Result<()> {
    let mut busy = Vec::new();
    for port in [80u16, 443] {
        match TcpListener::bind(("0.0.0.0", port)) {
            Ok(_) => ok(&format!("port {port} free")),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                warn(&format!(
                    "no permission to test port {port} (run as root to check)"
                ));
            }
            Err(_) => busy.push(port),
        }
    }
    if busy.is_empty() {
        return Ok(());
    }
    bail!("{}", ports_in_use(&busy))
}

fn ports_in_use(ports: &[u16]) -> String {
    let list: Vec<String> = ports.iter().map(u16::to_string).collect();
    format!(
        "port(s) {} in use: stop the service holding them (nginx? apache?). \
         Find it with `sudo ss -ltnp 'sport = :{}'` (or `sudo lsof -i :{}`), \
         or pass --skip-checks to continue anyway",
        list.join(" and "),
        ports[0],
        ports[0]
    )
}

/// Total machine RAM in MB (Linux).
pub fn total_ram_mb() -> Option<u64> {
    let meminfo = fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024)
}

/// Bytes available to unprivileged users on the filesystem holding `path`.
#[cfg(unix)]
pub(crate) fn free_bytes(path: &Path) -> Option<u64> {
    let stats = rustix::fs::statvfs(path).ok()?;
    stats.f_bavail.checked_mul(stats.f_frsize)
}

#[cfg(not(unix))]
pub(crate) fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Free space (MB) on the filesystem holding `path`.
pub fn free_disk_mb(path: &Path) -> Option<u64> {
    free_bytes(path).map(|bytes| bytes / (1024 * 1024))
}

/// Does the domain point at this machine's public IP? False when it does
/// not resolve or points elsewhere.
pub fn dns(domain: &str) -> bool {
    let resolved: Vec<IpAddr> = (domain, 443)
        .to_socket_addrs()
        .map(|addrs| addrs.map(|a| a.ip()).collect())
        .unwrap_or_default();
    if resolved.is_empty() {
        warn(&format!(
            "{domain} does not resolve in DNS yet: create an A record pointing at this machine \
             (HTTPS only works after that)"
        ));
        return false;
    }
    let public = Command::new("curl")
        .args(["-fsS", "--max-time", "4", "https://api.ipify.org"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<IpAddr>()
                .ok()
        });
    match public {
        Some(ip) if resolved.contains(&ip) => {
            ok(&format!("DNS: {domain} → {ip} (this machine)"));
            true
        }
        Some(ip) => {
            warn(&format!(
                "DNS: {domain} → {resolved:?}, but this machine's public IP is {ip}"
            ));
            false
        }
        None => {
            ok(&format!(
                "DNS: {domain} → {resolved:?} (public IP not verified)"
            ));
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_permission_errors_suggest_the_docker_group() {
        let denied = "permission denied while trying to connect to the Docker daemon socket at \
                      unix:///var/run/docker.sock";
        assert!(docker_failure(denied).contains("usermod -aG docker $USER"));
        assert!(docker_failure("Cannot connect to the Docker daemon").contains("systemctl"));
    }

    #[cfg(unix)]
    #[test]
    fn measures_free_space_of_an_existing_path_only() {
        let dir = tempfile::tempdir().unwrap();
        // Other processes write to /tmp, so only check that a value comes back.
        assert!(free_bytes(dir.path()).is_some());
        assert!(free_disk_mb(dir.path()).is_some());
        assert_eq!(free_bytes(&dir.path().join("missing")), None);
        assert_eq!(free_disk_mb(&dir.path().join("missing")), None);
    }

    #[test]
    fn busy_ports_say_how_to_find_the_process() {
        let message = ports_in_use(&[80, 443]);
        assert!(message.contains("80 and 443"));
        assert!(message.contains("ss -ltnp 'sport = :80'"));
        assert!(message.contains("--skip-checks"));
    }
}
