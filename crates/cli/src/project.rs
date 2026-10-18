//! A project on the host: a folder with `.env`, `migrations/` and `backups/`,
//! and the operations on its two services (Postgres and the app). How they
//! run depends on the host's [`Runtime`]: containers from the project's
//! `docker-compose.yml`, or systemd units on the machine itself.

use std::{
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, bail};

use crate::{envfile::EnvFile, host::Runtime, native};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Service {
    Postgres,
    App,
}

impl Service {
    /// The compose service name.
    fn compose(self) -> &'static str {
        match self {
            Service::Postgres => "postgres",
            Service::App => "app",
        }
    }
}

mod services;

pub struct Project {
    pub name: String,
    pub dir: PathBuf,
    pub runtime: Runtime,
}

impl Project {
    pub fn new(name: &str, dir: &Path, runtime: Runtime) -> Self {
        Project {
            name: name.to_owned(),
            dir: dir.to_path_buf(),
            runtime,
        }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Directory of the disk storage backend, as seen from the host.
    pub fn storage_dir(&self) -> PathBuf {
        match self.runtime {
            Runtime::Docker => self.path("storage"),
            Runtime::Systemd => PathBuf::from(format!("/var/lib/nelcota-{}/storage", self.name)),
        }
    }

    /// Whether the app keeps its files on this host's disk.
    pub fn stores_files_on_disk(&self) -> anyhow::Result<bool> {
        Ok(self
            .env()
            .get("NELCOTA_STORAGE_BACKEND")?
            .is_some_and(|b| b.trim() == "disk"))
    }

    pub fn env(&self) -> EnvFile {
        EnvFile::new(self.path(".env"))
    }

    pub fn exists(&self) -> bool {
        match self.runtime {
            Runtime::Docker => self.path("docker-compose.yml").is_file(),
            Runtime::Systemd => native::unit_path(&self.name).is_file(),
        }
    }

    // ------------------------------------------------------------ lifecycle

    /// Starts everything (and, on systemd, enables it at boot).
    pub fn up(&self) -> anyhow::Result<()> {
        services::for_project(self).up()
    }

    /// Stops everything. With `volumes`, also deletes the data (Docker only:
    /// on systemd, `remove` drops the cluster).
    pub fn down(&self, volumes: bool) -> anyhow::Result<()> {
        services::for_project(self).down(volumes)
    }

    pub fn start(&self, services: &[Service]) -> anyhow::Result<()> {
        services::for_project(self).start(services)
    }

    pub fn stop(&self, services: &[Service]) -> anyhow::Result<()> {
        services::for_project(self).stop(services)
    }

    /// Restarts a service so it rereads its configuration (on Docker, a new
    /// container: also picks up `.env` and image changes).
    pub fn recreate(&self, service: Service) -> anyhow::Result<()> {
        services::for_project(self).recreate(service)
    }

    /// Has the app been created (container or unit)?
    pub fn has_app(&self) -> bool {
        match self.runtime {
            Runtime::Docker => self.has_container("app"),
            Runtime::Systemd => self.exists(),
        }
    }

    pub fn logs(&self, follow: bool, service: Option<Service>) -> anyhow::Result<()> {
        services::for_project(self).logs(follow, service)
    }

    /// Downloads/checks a target version before entering maintenance.
    pub fn prepare_version(&self, version: &str) -> anyhow::Result<()> {
        services::for_project(self).prepare_version(version)
    }

    // --------------------------------------------------------------- health

    /// Health of the service (`healthy`, `starting`, `unhealthy`...), if running.
    pub fn health(&self, service: Service) -> Option<String> {
        services::for_project(self).health(service)
    }

    /// Waits for the service to become `healthy`.
    pub fn wait_healthy(&self, service: Service, timeout: Duration) -> anyhow::Result<()> {
        let name = service.compose();
        let deadline = Instant::now() + timeout;
        loop {
            match self.health(service).as_deref() {
                Some("healthy") => return Ok(()),
                Some("unhealthy") => {
                    bail!("[{}] the {name} service became unhealthy", self.name)
                }
                _ => {}
            }
            if Instant::now() > deadline {
                bail!(
                    "[{}] the {name} service did not become healthy within {}s",
                    self.name,
                    timeout.as_secs()
                );
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    /// Did Postgres die since it was last (re)started? A recovery whose
    /// target the archive does not reach makes it exit.
    pub fn postgres_crashed(&self) -> bool {
        services::for_project(self).postgres_crashed()
    }

    // ------------------------------------------------- commands on the data

    /// A program run as the `postgres` user next to the running database
    /// (`pg_dump`, `psql`, `pgbackrest`...): superuser over the local socket.
    pub fn as_postgres(&self, args: &[&str]) -> Command {
        match self.runtime {
            Runtime::Docker => {
                let mut command = self.compose_command();
                command
                    .args(["exec", "-T", "-u", "postgres", "postgres"])
                    .args(args);
                command
            }
            Runtime::Systemd => native::postgres_command(args),
        }
    }

    /// Like [`Project::as_postgres`], with the database stopped (a restore
    /// that rewrites the data directory).
    pub fn as_postgres_offline(&self, args: &[&str]) -> Command {
        match self.runtime {
            Runtime::Docker => {
                let (program, rest) = args.split_first().expect("a program to run");
                let mut command = self.compose_command();
                command
                    .args([
                        "run",
                        "--rm",
                        "--no-deps",
                        "-T",
                        "-u",
                        "postgres",
                        "--entrypoint",
                    ])
                    .arg(program)
                    .arg("postgres")
                    .args(rest);
                command
            }
            Runtime::Systemd => self.as_postgres(args),
        }
    }

    /// Runs `nelcota <args>` with the app's configuration: inside its
    /// container, or as a local process with the project's `.env`.
    pub fn in_app(&self, args: &[&str]) -> anyhow::Result<()> {
        let mut command = self.app_command(args)?;
        run(&mut command, &format!("nelcota {}", args.join(" ")))
    }

    pub fn in_app_output(&self, args: &[&str]) -> anyhow::Result<String> {
        let output = self
            .app_command(args)?
            .stderr(Stdio::inherit())
            .output()
            .context("could not run nelcota")?;
        if !output.status.success() {
            bail!(
                "[{}] `nelcota {}` failed ({})",
                self.name,
                args.join(" "),
                output.status
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn app_command(&self, args: &[&str]) -> anyhow::Result<Command> {
        match self.runtime {
            Runtime::Docker => {
                let mut command = self.compose_command();
                command
                    .args(["exec", "-T", "app", "/usr/local/bin/nelcota"])
                    .args(args);
                Ok(command)
            }
            Runtime::Systemd => {
                let mut command = Command::new(std::env::current_exe()?);
                command
                    .arg("--dir")
                    .arg(&self.dir)
                    .envs(self.env().read()?)
                    .args(args);
                Ok(command)
            }
        }
    }

    /// Where the app sees the project's migrations.
    pub fn app_migrations_dir(&self) -> String {
        match self.runtime {
            Runtime::Docker => "/migrations".into(),
            Runtime::Systemd => self.path("migrations").display().to_string(),
        }
    }

    // ------------------------------------------------------- docker compose

    pub(crate) fn compose_command(&self) -> Command {
        compose_command(&self.dir)
    }

    /// `docker compose <args>` with the output on the terminal.
    pub fn compose(&self, args: &[&str]) -> anyhow::Result<ExitStatus> {
        self.compose_command()
            .args(args)
            .status()
            .context("could not run `docker compose` (is Docker installed?)")
    }

    pub fn compose_ok(&self, args: &[&str]) -> anyhow::Result<()> {
        let status = self.compose(args)?;
        if !status.success() {
            bail!(
                "[{}] `docker compose {}` failed ({status})",
                self.name,
                args.join(" ")
            );
        }
        Ok(())
    }

    /// `docker compose <args>` capturing standard output.
    pub fn compose_output(&self, args: &[&str]) -> anyhow::Result<String> {
        let output = self
            .compose_command()
            .args(args)
            .stderr(Stdio::inherit())
            .output()
            .context("could not run `docker compose`")?;
        if !output.status.success() {
            bail!(
                "[{}] `docker compose {}` failed ({})",
                self.name,
                args.join(" "),
                output.status
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Like [`Project::compose_output`], without echoing errors: for polling
    /// a state that is expected to fail for a while.
    pub fn compose_output_quiet(&self, args: &[&str]) -> anyhow::Result<String> {
        let output = self
            .compose_command()
            .args(args)
            .stderr(Stdio::null())
            .output()
            .context("could not run `docker compose`")?;
        if !output.status.success() {
            bail!("[{}] `docker compose {}` failed", self.name, args.join(" "));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Does the service's container exist (created, running or stopped)?
    pub fn has_container(&self, service: &str) -> bool {
        self.compose_output(&["ps", "-a", "-q", service])
            .map(|out| !out.trim().is_empty())
            .unwrap_or(false)
    }
}

/// Runs a command with the output on the terminal; a non-zero exit is an error.
pub fn run(command: &mut Command, what: &str) -> anyhow::Result<()> {
    let status = command
        .status()
        .with_context(|| format!("could not run {what}"))?;
    if !status.success() {
        bail!("{what} failed ({status})");
    }
    Ok(())
}

/// `docker compose --project-directory <dir> -f <dir>/docker-compose.yml`.
pub fn compose_command(dir: &Path) -> Command {
    let mut command = Command::new("docker");
    command
        .arg("compose")
        .arg("--project-directory")
        .arg(dir)
        .arg("-f")
        .arg(dir.join("docker-compose.yml"));
    command
}
