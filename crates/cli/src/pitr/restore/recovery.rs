//! A non-enabled, non-restarting PostgreSQL instance used only by the explicit
//! restore operation. Ordinary PostgreSQL/app units stay fenced throughout WAL
//! replay. A reboot cannot restart this transient unit/one-off container.
use crate::{
    host::Runtime,
    native,
    project::{Project, run},
};
use anyhow::{Context, bail};
use sha2::{Digest, Sha256};
use std::process::{Command, Stdio};

pub(in crate::pitr) struct Recovery<'a> {
    project: &'a Project,
    name: String,
    stopped: bool,
}

impl<'a> Recovery<'a> {
    fn name(project: &Project) -> anyhow::Result<String> {
        let directory = project.dir.canonicalize()?;
        let digest = Sha256::digest(directory.as_os_str().as_encoded_bytes());
        let hash = base16ct::lower::encode_string(&digest[..16]);
        Ok(format!("nelcota-pitr-recovery-{}-{hash}", project.name))
    }

    /// The previous CLI may have been SIGKILLed. Its recovery-only server must
    /// be stopped before another restore can modify the same data directory.
    pub(in crate::pitr) fn stop_previous(project: &'a Project) -> anyhow::Result<()> {
        let name = Self::name(project)?;
        match project.runtime {
            Runtime::Systemd => {
                let output = Command::new("systemctl")
                    .args([
                        "show",
                        &name,
                        "--property=LoadState",
                        "--property=Description",
                    ])
                    .output()?;
                let text = String::from_utf8(output.stdout)?;
                if text.lines().any(|line| line == "LoadState=not-found") {
                    return Ok(());
                }
                let expected = format!("Description=Nelcota PITR recovery: {name}");
                if !output.status.success() || !text.lines().any(|line| line == expected) {
                    bail!("cannot verify the previous PITR replay unit's owner; fence retained");
                }
            }
            Runtime::Docker => {
                let output = Command::new("docker")
                    .args(["inspect", "--format", "{{json .Config.Labels}}", &name])
                    .output()?;
                if !output.status.success() {
                    let error = String::from_utf8_lossy(&output.stderr);
                    if error.contains("No such object:") || error.contains("No such container:") {
                        return Ok(());
                    }
                    bail!("cannot inspect the previous PITR replay container; fence retained");
                }
                if output.stdout.len() > 16384 {
                    bail!("PITR replay ownership metadata exceeds its limit");
                }
                let labels: serde_json::Value = serde_json::from_slice(&output.stdout)?;
                if labels["io.nelcota.pitr-owner"].as_str() != Some(&name) {
                    bail!(
                        "previous PITR replay container belongs to another owner; fence retained"
                    );
                }
            }
        }
        let mut previous = Self {
            project,
            name,
            stopped: false,
        };
        previous.stop()
    }

    pub(in crate::pitr) fn start(project: &'a Project) -> anyhow::Result<Self> {
        Self::stop_previous(project)?;
        let recovery = Self {
            project,
            name: Self::name(project)?,
            stopped: false,
        };
        match project.runtime {
            Runtime::Systemd => {
                let slice = Command::new("systemctl")
                    .args(["show", native::POSTGRES_UNIT, "--property=Slice", "--value"])
                    .output()?;
                if !slice.status.success() {
                    bail!("cannot inspect PostgreSQL's resource slice; fence retained");
                }
                let slice = String::from_utf8(slice.stdout)?.trim().to_owned();
                if slice.is_empty()
                    || slice.len() > 255
                    || !slice
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                {
                    bail!("cannot determine PostgreSQL's resource slice; PITR fence retained");
                }
                run(
                    Command::new("systemd-run").args([
                        "--quiet",
                        "--unit",
                        &recovery.name,
                        &format!("--description=Nelcota PITR recovery: {}", recovery.name),
                        "--slice",
                        &slice,
                        "--property=Type=exec",
                        "--property=User=postgres",
                        "--property=Group=postgres",
                        "--property=Restart=no",
                        "--property=KillSignal=SIGINT",
                        "--property=RuntimeMaxSec=3700",
                        "--property=TimeoutStartSec=120",
                        "--property=TimeoutStopSec=120",
                        "/usr/lib/postgresql/17/bin/postgres",
                        "-D",
                        native::PG_DATA,
                        "-c",
                        "config_file=/etc/postgresql/17/main/postgresql.conf",
                        "-c",
                        "listen_addresses=",
                    ]),
                    "isolated PITR WAL replay unit",
                )?;
            }
            Runtime::Docker => {
                let config: serde_json::Value =
                    serde_json::from_slice(&crate::pitr::fence::read_compose(project)?)?;
                let label = format!("io.nelcota.pitr-owner={}", recovery.name);
                let mut command = vec![
                    "run",
                    "--detach",
                    "--rm",
                    "--no-deps",
                    "--name",
                    &recovery.name,
                    "--label",
                    &label,
                    "--entrypoint",
                    "/usr/local/bin/docker-entrypoint.sh",
                    "postgres",
                ];
                let args: Vec<&str> = match config["services"]["postgres"]["command"].as_array() {
                    Some(values) => values
                        .iter()
                        .map(|v| v.as_str().context("invalid PostgreSQL command"))
                        .collect::<anyhow::Result<_>>()?,
                    None => vec!["postgres"],
                };
                if args.first() != Some(&"postgres") {
                    bail!("custom PostgreSQL command cannot be used for isolated verification");
                }
                command.extend(args);
                command.extend(["-c", "listen_addresses="]);
                project.compose_ok(&command)?;
                let policy = Command::new("docker")
                    .args([
                        "inspect",
                        "--format",
                        "{{.HostConfig.RestartPolicy.Name}}",
                        &recovery.name,
                    ])
                    .output()?;
                if !policy.status.success()
                    || String::from_utf8_lossy(&policy.stdout).trim() != "no"
                {
                    bail!("PITR replay container must have restart policy 'no'; fence retained");
                }
            }
        }
        Ok(recovery)
    }

    pub(in crate::pitr) fn in_recovery(&self) -> Option<bool> {
        let args = [
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-AtXc",
            "SELECT pg_is_in_recovery()",
        ];
        let mut command = self.command(&args);
        let output = command.stderr(Stdio::null()).output().ok()?;
        if !output.status.success() {
            return None;
        }
        match String::from_utf8_lossy(&output.stdout).trim() {
            "t" => Some(true),
            "f" => Some(false),
            _ => None,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = match self.project.runtime {
            Runtime::Systemd => native::postgres_command(args),
            Runtime::Docker => {
                let mut command = Command::new("docker");
                command
                    .args([
                        "exec",
                        "-u",
                        "postgres",
                        "-e",
                        "PGCONNECT_TIMEOUT=5",
                        "-e",
                        "PGOPTIONS=-c statement_timeout=300000",
                        &self.name,
                    ])
                    .args(args);
                command
            }
        };
        command
            .env("PGCONNECT_TIMEOUT", "5")
            .env("PGOPTIONS", "-c statement_timeout=300000");
        command
    }

    pub(in crate::pitr) fn crashed(&self) -> bool {
        match self.project.runtime {
            Runtime::Systemd => native::unit_state(&self.name)
                .is_none_or(|state| matches!(state.as_str(), "failed" | "inactive")),
            Runtime::Docker => Command::new("docker")
                .args(["inspect", "--format", "{{.State.Running}}", &self.name])
                .output()
                .is_ok_and(|output| {
                    !output.status.success()
                        || String::from_utf8_lossy(&output.stdout).trim() == "false"
                }),
        }
    }

    pub(in crate::pitr) fn check_relations(&self) -> anyhow::Result<()> {
        let program = match self.project.runtime {
            Runtime::Systemd => "/usr/lib/postgresql/17/bin/pg_amcheck",
            Runtime::Docker => "pg_amcheck",
        };
        run(
            &mut self.command(&[
                program,
                "--all",
                "--install-missing=pg_catalog",
                "--heapallindexed",
                "--rootdescend",
                "--checkunique",
                "--jobs=2",
                "--host=/var/run/postgresql",
                "--username=postgres",
                "--no-password",
            ]),
            "PITR heap/TOAST/B-tree verification",
        )
    }

    pub(in crate::pitr) fn stop(&mut self) -> anyhow::Result<()> {
        match self.project.runtime {
            Runtime::Systemd => native::systemctl(&["stop".into(), self.name.clone()])?,
            Runtime::Docker => run(
                Command::new("docker").args(["stop", "--time", "120", &self.name]),
                "stop isolated PITR replay",
            )?,
        }
        self.stopped = true;
        Ok(())
    }
}

impl Drop for Recovery<'_> {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        if let Err(error) = self
            .stop()
            .context("could not stop isolated PITR replay; ordinary services remain fenced")
        {
            crate::util::warn(&format!("{error:#}"));
        }
    }
}
