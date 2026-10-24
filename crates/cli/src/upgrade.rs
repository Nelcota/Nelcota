//! App version changes and rollback coordinated with a pre-upgrade backup.
use crate::{
    backup,
    host::{Host, Runtime},
    lifecycle::HEALTH_TIMEOUT,
    maintenance::Maintenance,
    native,
    project::{Project, Service},
    util::{ok, step, warn},
};
use anyhow::{Context, bail};

/// `.env` keys only the updates controller writes. A project carrying any of
/// them was created or activated by the controller: its image is pinned, so a
/// CLI version change would not take effect and could fight the controller.
const CONTROLLER_KEYS: [&str; 4] = [
    "NELCOTA_APP_IMAGE",
    "NELCOTA_DEPLOYMENT_ID",
    "NELCOTA_DEPLOYMENT_GATE",
    "NELCOTA_DEPLOYMENT_VALIDATION",
];

/// On an enrolled host, the CLI may only upgrade projects the controller has
/// never activated. Unresolved controller jobs are refused by the host lease.
pub fn require_outside_controller(project: &Project) -> anyhow::Result<()> {
    let env = project.env();
    for key in CONTROLLER_KEYS {
        if env.get(key)?.is_some() {
            bail!(
                "{} is managed by the updates controller ({key} is set); upgrade it from the controller",
                project.name
            );
        }
    }
    Ok(())
}

/// The controller keeps its own binary; deploying that copy as the app would
/// tie the project to the controller's version instead of the installed CLI.
pub fn require_cli_binary() -> anyhow::Result<()> {
    let exe = std::env::current_exe()?.canonicalize()?;
    if exe.starts_with(crate::updates::CONTROLLER_BIN_DIR) {
        bail!("this is the updates controller's binary; run the installed CLI (`nelcota`) instead");
    }
    Ok(())
}

/// Backup → new version → healthcheck. On failure: goes back to the previous
/// version and restores the backup (the new version may have applied
/// migrations). On Docker the version is the image tag; on systemd, this
/// binary replaces the one the unit runs.
pub fn run(
    host: &Host,
    project: &Project,
    version: Option<&str>,
    options: Options,
) -> anyhow::Result<()> {
    let env = project.env();
    let current = env
        .get("NELCOTA_VERSION")?
        .context("NELCOTA_VERSION missing from .env")?;
    let this_binary = env!("CARGO_PKG_VERSION");
    if project.runtime == Runtime::Systemd && version.is_some_and(|v| v != this_binary) {
        bail!(
            "on a systemd host the project runs this binary ({this_binary}): install the version \
             you want first (NELCOTA_VERSION=x.y.z install.sh), then run `nelcota upgrade`"
        );
    }
    let target = version.map_or_else(|| this_binary.to_owned(), str::to_owned);
    let direction = direction(&current, &target);
    if options.dry_run {
        println!(
            "{}: {current} → {target} ({})",
            project.name,
            direction.describe()
        );
        return Ok(());
    }
    match direction {
        Direction::Same if !options.reinstall => {
            ok(&format!(
                "{} is already on version {target} (--reinstall redeploys it)",
                project.name
            ));
            return Ok(());
        }
        Direction::Downgrade if !options.allow_downgrade => {
            let hint = match version.is_none() {
                true => {
                    format!(
                        "this nelcota CLI ({this_binary}) is older than the app ({current}); \
                     reinstall the CLI (curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh) or pass \
                     --version"
                    )
                }
                false => "pass --allow-downgrade if this is intended (migrations are not reverted)"
                    .into(),
            };
            bail!(
                "{}: refusing to downgrade {current} → {target}: {hint}",
                project.name
            );
        }
        Direction::Downgrade => warn(&format!(
            "downgrading {}: migrations applied by {current} are not reverted",
            project.name
        )),
        Direction::Unknown => warn(&format!(
            "cannot compare versions {current} and {target}; continuing"
        )),
        Direction::Upgrade | Direction::Same => {}
    }
    println!("Upgrading {}: {current} → {target}", project.name);

    deploy(&mut HostDeployment {
        host,
        project,
        current: &current,
        target: &target,
        maintenance: None,
        deployed: false,
    })?;
    ok(&format!("{} healthy on version {target}", project.name));
    Ok(())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    /// Allow a target older than the running version.
    pub allow_downgrade: bool,
    /// Only print what would change.
    pub dry_run: bool,
    /// Redeploy even when the project is already on the target version.
    pub reinstall: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Upgrade,
    Same,
    Downgrade,
    /// A tag that is not `x.y.z[-pre]` (e.g. a custom image tag).
    Unknown,
}

impl Direction {
    fn describe(self) -> &'static str {
        match self {
            Direction::Upgrade => "upgrade",
            Direction::Same => "no change",
            Direction::Downgrade => "downgrade: refused without --allow-downgrade",
            Direction::Unknown => "versions not comparable",
        }
    }
}

fn direction(current: &str, target: &str) -> Direction {
    if current.trim() == target.trim() {
        return Direction::Same;
    }
    match (parse_version(current), parse_version(target)) {
        (Some(from), Some(to)) => match to.cmp_precedence(&from) {
            std::cmp::Ordering::Greater => Direction::Upgrade,
            std::cmp::Ordering::Equal => Direction::Same,
            std::cmp::Ordering::Less => Direction::Downgrade,
        },
        _ => Direction::Unknown,
    }
}

/// SemVer precedence, with an optional leading `v` for image tags.
fn parse_version(version: &str) -> Option<semver::Version> {
    let version = version.trim();
    let version = version.strip_prefix('v').unwrap_or(version);
    semver::Version::parse(version).ok()
}

// The workflow owns when traffic may resume; runtime and snapshot operations
// stay behind this private interface so failure recovery can be exercised.
trait Deployment {
    type Snapshot;
    fn prepare(&mut self) -> anyhow::Result<()>;
    fn pause(&mut self) -> anyhow::Result<()>;
    fn capture(&mut self) -> anyhow::Result<Self::Snapshot>;
    fn activate(&mut self) -> anyhow::Result<()>;
    fn restore(&mut self, snapshot: &Self::Snapshot) -> anyhow::Result<()>;
    fn restart_previous(&mut self) -> anyhow::Result<()>;
    fn resume(&mut self) -> anyhow::Result<()>;
}

fn deploy(deployment: &mut impl Deployment) -> anyhow::Result<()> {
    deployment.prepare()?;
    deployment.pause()?;
    let snapshot = match deployment.capture() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            deployment.restart_previous()?;
            deployment.resume()?;
            return Err(error).context("pre-upgrade backup failed; previous version restarted");
        }
    };
    if let Err(error) = deployment.activate() {
        deployment
            .restore(&snapshot)
            .context("rollback failed; project remains in maintenance")?;
        deployment.resume()?;
        return Err(error).context("upgrade failed and was reverted");
    }
    deployment.resume()
}

struct HostDeployment<'a> {
    host: &'a Host,
    project: &'a Project,
    current: &'a str,
    target: &'a str,
    maintenance: Option<Maintenance<'a>>,
    deployed: bool,
}

impl Deployment for HostDeployment<'_> {
    type Snapshot = std::path::PathBuf;

    fn prepare(&mut self) -> anyhow::Result<()> {
        self.project.prepare_version(self.target)
    }

    fn pause(&mut self) -> anyhow::Result<()> {
        self.maintenance = Some(Maintenance::enter(self.host, self.project)?);
        // Drain old requests before capturing either the database or files.
        self.project.stop(&[Service::App])
    }

    fn capture(&mut self) -> anyhow::Result<Self::Snapshot> {
        let dump = backup::run(self.host, self.project, false, None)?;
        println!("Pre-upgrade backup: {}", dump.display());
        Ok(dump)
    }

    fn activate(&mut self) -> anyhow::Result<()> {
        step("Restarting the app on the new version");
        self.project.env().set("NELCOTA_VERSION", self.target)?;
        if self.project.runtime == Runtime::Systemd {
            native::deploy_binary()?;
            self.deployed = true;
        }
        self.project.recreate(Service::App)?;
        self.project.wait_healthy(Service::App, HEALTH_TIMEOUT)
    }

    fn restore(&mut self, dump: &Self::Snapshot) -> anyhow::Result<()> {
        warn(&format!("version {} did not become healthy", self.target));
        step(&format!("Rolling back to {}", self.current));
        self.project.stop(&[Service::App])?;
        self.project.env().set("NELCOTA_VERSION", self.current)?;
        if self.deployed {
            native::rollback_binary()?;
        }
        if self.project.stores_files_on_disk()? {
            let manifest = backup::validate(dump)?;
            backup::restore_files(self.project, dump, &manifest)?;
        }
        backup::restore_dump(self.project, dump)?;
        self.project.recreate(Service::App)?;
        self.project.wait_healthy(Service::App, HEALTH_TIMEOUT)?;
        ok(&format!(
            "rollback finished: version {}, pre-upgrade backup restored",
            self.current
        ));
        Ok(())
    }

    fn restart_previous(&mut self) -> anyhow::Result<()> {
        self.project.start(&[Service::App])?;
        self.project.wait_healthy(Service::App, HEALTH_TIMEOUT)
    }

    fn resume(&mut self) -> anyhow::Result<()> {
        self.maintenance
            .take()
            .context("upgrade maintenance gate missing")?
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy)]
    enum Fail {
        Never,
        Prepare,
        Backup,
        Activate,
        Restore,
    }

    struct App {
        fail: Fail,
        paused: bool,
        running: bool,
        healthy: bool,
        database: String,
        file: Option<String>,
    }

    impl App {
        fn new(fail: Fail) -> Self {
            Self {
                fail,
                paused: false,
                running: true,
                healthy: true,
                database: "accepted-write".into(),
                file: Some("original-file".into()),
            }
        }

        fn accepts_writes(&self) -> bool {
            self.running && !self.paused
        }
    }

    impl Deployment for App {
        type Snapshot = (String, Option<String>);

        fn prepare(&mut self) -> anyhow::Result<()> {
            if matches!(self.fail, Fail::Prepare) {
                bail!("target image unavailable");
            }
            Ok(())
        }

        fn pause(&mut self) -> anyhow::Result<()> {
            self.paused = true;
            self.running = false;
            Ok(())
        }

        fn capture(&mut self) -> anyhow::Result<Self::Snapshot> {
            assert!(!self.accepts_writes());
            if matches!(self.fail, Fail::Backup) {
                bail!("snapshot failed");
            }
            Ok((self.database.clone(), self.file.clone()))
        }

        fn activate(&mut self) -> anyhow::Result<()> {
            self.running = true;
            assert!(!self.accepts_writes());
            self.database = "new-migration".into();
            self.file = None;
            self.healthy = matches!(self.fail, Fail::Never);
            if !self.healthy {
                bail!("new version unhealthy");
            }
            Ok(())
        }

        fn restore(&mut self, snapshot: &Self::Snapshot) -> anyhow::Result<()> {
            self.running = false;
            if matches!(self.fail, Fail::Restore) {
                bail!("restore failed");
            }
            (self.database, self.file) = snapshot.clone();
            self.running = true;
            self.healthy = true;
            Ok(())
        }

        fn restart_previous(&mut self) -> anyhow::Result<()> {
            self.running = true;
            self.healthy = true;
            Ok(())
        }

        fn resume(&mut self) -> anyhow::Result<()> {
            assert!(self.healthy);
            self.paused = false;
            Ok(())
        }
    }

    #[test]
    fn compares_versions() {
        assert_eq!(direction("0.2.0", "0.2.0"), Direction::Same);
        assert_eq!(direction("0.2.0", "v0.2.0"), Direction::Same);
        assert_eq!(direction("0.2.0", "0.3.0"), Direction::Upgrade);
        assert_eq!(direction("0.2.9", "0.10.0"), Direction::Upgrade);
        assert_eq!(direction("1.0.0", "0.9.9"), Direction::Downgrade);
        assert_eq!(direction("0.3.0-rc.1", "0.3.0"), Direction::Upgrade);
        assert_eq!(direction("0.3.0", "0.3.0-rc.1"), Direction::Downgrade);
        assert_eq!(direction("0.3.0-rc.1", "0.3.0-rc.2"), Direction::Upgrade);
        assert_eq!(direction("0.3.0-rc.2", "0.3.0-rc.10"), Direction::Upgrade);
        assert_eq!(direction("0.3.0-rc.10", "0.3.0-rc.2"), Direction::Downgrade);
        assert_eq!(direction("1.0.0-2", "1.0.0-alpha"), Direction::Upgrade);
        assert_eq!(direction("1.0.0+first", "1.0.0+second"), Direction::Same);
        assert_eq!(direction("1.0.0-rc.02", "1.0.0"), Direction::Unknown);
        assert_eq!(direction("0.2.0", "edge"), Direction::Unknown);
        assert_eq!(direction("0.2", "0.3.0"), Direction::Unknown);
        assert_eq!(direction("0.2.0.1", "0.3.0"), Direction::Unknown);
    }

    #[test]
    fn failed_upgrade_restores_accepted_data_and_historical_file_bytes() {
        let mut app = App::new(Fail::Activate);
        assert!(deploy(&mut app).is_err());
        assert!(app.accepts_writes());
        assert_eq!(app.database, "accepted-write");
        assert_eq!(app.file.as_deref(), Some("original-file"));
    }

    #[test]
    fn backup_failure_restarts_the_unchanged_previous_app() {
        let mut app = App::new(Fail::Backup);
        assert!(deploy(&mut app).is_err());
        assert!(app.accepts_writes());
        assert_eq!(app.database, "accepted-write");
        assert_eq!(app.file.as_deref(), Some("original-file"));
    }

    #[test]
    fn failed_restore_keeps_public_traffic_blocked() {
        let mut app = App::new(Fail::Restore);
        assert!(deploy(&mut app).is_err());
        assert!(!app.accepts_writes());
        assert!(app.paused);
    }

    #[test]
    fn unavailable_target_does_not_interrupt_the_live_app() {
        let mut app = App::new(Fail::Prepare);
        assert!(deploy(&mut app).is_err());
        assert!(app.accepts_writes());
        assert_eq!(app.database, "accepted-write");
    }

    #[test]
    fn healthy_upgrade_opens_the_gate_with_the_new_data() {
        let mut app = App::new(Fail::Never);
        deploy(&mut app).unwrap();
        assert!(app.accepts_writes());
        assert_eq!(app.database, "new-migration");
    }

    #[test]
    fn controller_activated_projects_cannot_be_upgraded_by_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let project = Project::new("shop", dir.path(), Runtime::Docker);
        std::fs::write(project.path(".env"), "NELCOTA_VERSION=0.5.2\n").unwrap();
        require_outside_controller(&project).unwrap();
        for key in CONTROLLER_KEYS {
            std::fs::write(
                project.path(".env"),
                format!("NELCOTA_VERSION=0.5.2\n{key}=value\n"),
            )
            .unwrap();
            assert!(require_outside_controller(&project).is_err());
        }
    }
}
