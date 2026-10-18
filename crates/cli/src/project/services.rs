//! Docker and systemd service adapters behind the host-project interface.
use super::{Project, Service, run};
use crate::{host::Runtime, native};
use anyhow::{Context, bail};
use std::process::{Command, Stdio};

pub(super) trait Services {
    fn up(&self) -> anyhow::Result<()>;
    fn down(&self, volumes: bool) -> anyhow::Result<()>;
    fn start(&self, services: &[Service]) -> anyhow::Result<()>;
    fn stop(&self, services: &[Service]) -> anyhow::Result<()>;
    fn recreate(&self, service: Service) -> anyhow::Result<()>;
    fn logs(&self, follow: bool, service: Option<Service>) -> anyhow::Result<()>;
    fn health(&self, service: Service) -> Option<String>;
    fn prepare_version(&self, version: &str) -> anyhow::Result<()>;
}

pub(super) fn for_project(project: &Project) -> Box<dyn Services + '_> {
    match project.runtime {
        Runtime::Docker => Box::new(Docker(project)),
        Runtime::Systemd => Box::new(Systemd(project)),
    }
}

struct Docker<'a>(&'a Project);
impl Services for Docker<'_> {
    fn up(&self) -> anyhow::Result<()> {
        self.0.compose_ok(&["up", "-d"])
    }
    fn down(&self, volumes: bool) -> anyhow::Result<()> {
        self.0.compose_ok(match volumes {
            true => &["down", "--volumes"],
            false => &["down"],
        })
    }
    fn start(&self, services: &[Service]) -> anyhow::Result<()> {
        let mut args = vec!["up", "-d"];
        args.extend(services.iter().map(|service| service.compose()));
        self.0.compose_ok(&args)
    }
    fn stop(&self, services: &[Service]) -> anyhow::Result<()> {
        let mut args = vec!["stop"];
        args.extend(services.iter().map(|service| service.compose()));
        self.0.compose_ok(&args)
    }
    fn recreate(&self, service: Service) -> anyhow::Result<()> {
        self.0
            .compose_ok(&["up", "-d", "--force-recreate", service.compose()])
    }
    fn logs(&self, follow: bool, service: Option<Service>) -> anyhow::Result<()> {
        let mut args = vec!["logs", "--tail", "200"];
        if follow {
            args.push("-f");
        }
        if let Some(service) = service {
            args.push(service.compose());
        }
        self.0.compose_ok(&args)
    }
    fn health(&self, service: Service) -> Option<String> {
        let id = self
            .0
            .compose_output(&["ps", "-q", service.compose()])
            .ok()?;
        if id.trim().is_empty() {
            return None;
        }
        let output = Command::new("docker")
            .args(["inspect", "--format", "{{.State.Health.Status}}", id.trim()])
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
    fn prepare_version(&self, version: &str) -> anyhow::Result<()> {
        // Override Compose interpolation only; the running project's .env
        // stays on the previous version until its backup is complete.
        let pulled = self
            .0
            .compose_command()
            .env("NELCOTA_VERSION", version)
            .args(["pull", "app"])
            .status()
            .context("could not pull the target image")?;
        if pulled.success() {
            return Ok(());
        }
        let image = self
            .0
            .env()
            .get("NELCOTA_IMAGE")?
            .context("NELCOTA_IMAGE missing from .env")?;
        if Command::new("docker")
            .args(["image", "inspect", &format!("{image}:{version}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?
            .success()
        {
            return Ok(());
        }
        bail!("target image unavailable; the running version was not changed")
    }
}

struct Systemd<'a>(&'a Project);
impl Systemd<'_> {
    fn unit(&self, service: Service) -> String {
        match service {
            Service::Postgres => native::POSTGRES_UNIT.to_owned(),
            Service::App => native::app_unit(&self.0.name),
        }
    }
    fn units(&self, services: &[Service]) -> Vec<String> {
        services.iter().map(|service| self.unit(*service)).collect()
    }
    fn action(&self, action: &str, services: &[Service]) -> anyhow::Result<()> {
        let mut args = vec![action.to_owned()];
        args.extend(self.units(services));
        native::systemctl(&args)
    }
}
impl Services for Systemd<'_> {
    fn up(&self) -> anyhow::Result<()> {
        let mut args = vec!["enable".to_owned(), "--now".to_owned()];
        args.extend(self.units(&[Service::Postgres, Service::App]));
        native::systemctl(&args)
    }
    fn down(&self, volumes: bool) -> anyhow::Result<()> {
        if volumes {
            bail!("--volumes is for Docker hosts; to delete the data use `nelcota remove`");
        }
        self.stop(&[Service::App, Service::Postgres])
    }
    fn start(&self, services: &[Service]) -> anyhow::Result<()> {
        let mut args = vec!["reset-failed".to_owned()];
        args.extend(self.units(services));
        let _ = native::systemctl_quiet(&args);
        self.action("start", services)
    }
    fn stop(&self, services: &[Service]) -> anyhow::Result<()> {
        self.action("stop", services)
    }
    fn recreate(&self, service: Service) -> anyhow::Result<()> {
        let _ = native::systemctl_quiet(&["reset-failed".to_owned(), self.unit(service)]);
        self.action("restart", &[service])
    }
    fn logs(&self, follow: bool, service: Option<Service>) -> anyhow::Result<()> {
        let units = match service {
            None => self.units(&[Service::Postgres, Service::App]),
            Some(service) => self.units(&[service]),
        };
        let mut command = Command::new("journalctl");
        command.args(["--no-pager", "-n", "200"]);
        if follow {
            command.arg("-f");
        }
        for unit in units {
            command.args(["-u", &unit]);
        }
        run(&mut command, "journalctl")
    }
    fn health(&self, service: Service) -> Option<String> {
        match native::unit_state(&self.unit(service))?.as_str() {
            "active" => {}
            "failed" => return Some("unhealthy".into()),
            "activating" | "reloading" => return Some("starting".into()),
            _ => return None,
        }
        let healthy = match service {
            Service::App => crate::util::healthcheck(native::APP_LISTEN),
            Service::Postgres => self
                .0
                .as_postgres(&["pg_isready", "-q"])
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success()),
        };
        Some(
            match healthy {
                true => "healthy",
                false => "starting",
            }
            .into(),
        )
    }
    fn prepare_version(&self, _version: &str) -> anyhow::Result<()> {
        Ok(())
    }
}
