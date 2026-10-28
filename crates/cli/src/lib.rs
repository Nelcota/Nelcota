//! Commands of the `nelcota` binary.
//!
//! The same binary serves the API (`nelcota serve`, the default) and operates
//! the host: a folder with Caddy and the projects (each with its own Postgres,
//! app, keys and backups), as containers (N projects) or systemd units (one).
//! Commands that need the database run directly when `NELCOTA_DATABASE_URL` is
//! in the environment (inside the container or in a dev shell) and, on a host,
//! run with the project's app configuration.

mod backup;
mod caddy;
mod checks;
mod db;
mod dev;
mod doctor;
mod envfile;
mod host;
mod init;
mod lifecycle;
mod machine;
mod maintenance;
mod naming;
mod native;
mod panel_login;
mod pitr;
mod private_fs;
mod project;
mod projects;
mod registry;
mod scaffold;
mod update;
mod updates;
mod upgrade;
mod util;

use std::path::PathBuf;

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use nelcota_core::Config;

pub use host::{PanelLogin, Runtime};

#[derive(Parser, Debug)]
#[command(
    name = "nelcota",
    version,
    about = "BaaS on plain Postgres: REST API, auth and deploy in a single binary."
)]
pub struct Cli {
    /// Host folder (default: current directory; update also finds /opt/nelcota).
    #[arg(short = 'C', long = "dir", global = true, env = "NELCOTA_ROOT")]
    pub dir: Option<PathBuf>,

    /// Project (update defaults to all; other project commands may require one).
    #[arg(short = 'p', long = "project", global = true)]
    pub project: Option<String>,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Updates the CLI and projects to the latest stable release, with a preview.
    Update(update::UpdateArgs),
    /// Secure, separately authenticated host update controller.
    Updates(updates::UpdatesArgs),
    /// Starts the HTTP server (the default when no command is given).
    Serve,
    /// Internal container entrypoint: refuses to serve a PITR-fenced project.
    #[command(hide = true)]
    GuardedServe {
        #[arg(long, default_value = "/nelcota-pitr-fence")]
        state: PathBuf,
        #[arg(
            long,
            default_value = "nelcota -C <host> -p <project> pitr recover --yes"
        )]
        recovery: String,
        /// Startup guard only: never loads server config or starts HTTP.
        #[arg(long)]
        check_only: bool,
        /// Capability preflight only: never starts the server.
        #[arg(long)]
        check_support: bool,
    },
    /// Creates a project (and the host, the first time).
    Init(Box<InitArgs>),
    /// Lists the host's projects and the state of each one.
    Projects,
    /// Starts the projects and Caddy (all of them, or only the one from -p).
    Up,
    /// Stops a project (or all with --all). With --volumes, DELETES the data.
    Down {
        /// Also deletes the data volumes (asks for confirmation; Docker only).
        #[arg(long)]
        volumes: bool,
        #[arg(long)]
        all: bool,
        /// Does not ask for confirmation before deleting volumes.
        #[arg(long)]
        yes: bool,
    },
    /// State of the projects (all of them, or only the one from -p).
    Status,
    /// Checks the host: Docker, ports, disk, DNS, backup job and age, S3, health.
    Doctor,
    /// Logs of a project, or of the host's Caddy.
    Logs {
        #[arg(short, long)]
        follow: bool,
        /// app, postgres or caddy (default: the project's app and postgres).
        #[arg(value_enum)]
        service: Option<LogService>,
    },
    /// Removes a project: final backup in archive/, containers and data deleted.
    Remove {
        /// Does not ask for confirmation.
        #[arg(long)]
        yes: bool,
        /// Keeps the project folder (migrations, backups).
        #[arg(long)]
        keep_files: bool,
        /// Skips the final backup (otherwise a stopped Postgres is started for it).
        #[arg(long)]
        no_backup: bool,
    },
    /// Panel login: one for all (shared) or one per project.
    PanelLogin {
        #[arg(value_enum)]
        mode: PanelLogin,
    },
    /// Local development environment (Postgres in a container + server).
    Dev(DevArgs),
    /// Applies SQL migrations from the directory (files V<n>__<name>.sql).
    Migrate {
        #[arg(long, default_value = "migrations")]
        path: PathBuf,
    },
    /// Updates the app image, with a backup first and a rollback if it fails.
    Upgrade {
        /// Target version (default: this binary's version).
        #[arg(long)]
        version: Option<String>,
        /// All projects, one at a time.
        #[arg(long)]
        all: bool,
        /// Allows a target older than the running version.
        #[arg(long)]
        allow_downgrade: bool,
        /// Redeploys even when the project is already on the target version.
        #[arg(long)]
        reinstall: bool,
        /// Only prints the current → target version of each project.
        #[arg(long)]
        dry_run: bool,
        /// Upgrades with this CLI on a host enrolled in the updates controller.
        #[arg(long)]
        without_controller: bool,
    },
    /// Dumps the database to backups/ and uploads it to S3 when host.env has a bucket.
    Backup {
        /// Requires the S3 upload (fails if host.env has no bucket). Without it,
        /// the dump is uploaded whenever the bucket is configured.
        #[arg(long)]
        upload: bool,
        /// Keeps only the N most recent local dumps (at least 1: the new one).
        #[arg(long, value_parser = at_least_one)]
        keep: Option<usize>,
        /// All projects.
        #[arg(long)]
        all: bool,
    },
    /// Restores a dump (replaces the project's current database).
    Restore {
        file: PathBuf,
        /// Also restores the files from the backup bucket (disk storage).
        #[arg(long)]
        files: bool,
        /// Does not ask for confirmation.
        #[arg(long)]
        yes: bool,
    },
    /// Point-in-time recovery: WAL archived to S3 with pgBackRest.
    Pitr {
        #[command(subcommand)]
        action: PitrAction,
    },
    /// Generates TypeScript or Rust types from the exposed schema.
    Types {
        #[arg(long, value_enum, default_value_t = TypesLanguage::Typescript)]
        lang: TypesLanguage,
        #[arg(long, short)]
        out: Option<PathBuf>,
    },
    /// Issues service tokens.
    Token {
        #[command(subcommand)]
        kind: TokenKind,
    },
    /// Generates a new Ed25519 private key (for NELCOTA_JWT_PRIVATE_KEY).
    Keygen,
    /// New panel password (the host's with single sign-on; the project's with per-project login).
    AdminPassword,
    /// Local healthcheck (used by Docker): exits with 0 if /health answers 200.
    Healthcheck {
        #[arg(long, default_value = "127.0.0.1:8000")]
        addr: String,
    },
}

/// Is there a configuration for `serve`: the required database URL in the
/// environment, or the TOML file `Config::load` reads?
fn server_configured() -> bool {
    let file = std::env::var("NELCOTA_CONFIG").unwrap_or_else(|_| "nelcota.toml".into());
    std::env::var_os("NELCOTA_DATABASE_URL").is_some() || std::path::Path::new(&file).is_file()
}

/// `--keep 0` would delete the dump that was just written.
fn at_least_one(value: &str) -> Result<usize, String> {
    match value.parse::<usize>() {
        Ok(0) => Err("must be at least 1 (0 would delete the new backup too)".into()),
        Ok(n) => Ok(n),
        Err(err) => Err(err.to_string()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum LogService {
    App,
    Postgres,
    /// The shared proxy (host-wide; -p is not needed).
    Caddy,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
pub enum TypesLanguage {
    #[default]
    Typescript,
    Rust,
}
impl TypesLanguage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Typescript => "typescript",
            Self::Rust => "rust",
        }
    }
}

#[cfg(test)]
mod types_tests {
    use super::*;
    #[test]
    fn types_default_stays_typescript_and_rust_is_explicit() {
        let default = Cli::try_parse_from(["nelcota", "types"]).unwrap();
        assert!(matches!(
            default.command,
            Some(Command::Types {
                lang: TypesLanguage::Typescript,
                ..
            })
        ));
        let rust = Cli::try_parse_from(["nelcota", "types", "--lang", "rust", "-o", "database.rs"])
            .unwrap();
        assert!(matches!(
            rust.command,
            Some(Command::Types {
                lang: TypesLanguage::Rust,
                out: Some(_)
            })
        ));
        assert!(Cli::try_parse_from(["nelcota", "types", "--lang", "python"]).is_err());
    }

    #[test]
    fn guarded_container_entrypoint_refuses_fence_before_loading_server_config() {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        std::fs::create_dir(&state).unwrap();
        nelcota_deployment::atomic_write(&state.join("active.json"), b"fenced").unwrap();
        let args = [
            "nelcota",
            "guarded-serve",
            "--state",
            state.to_str().unwrap(),
            "--recovery",
            "nelcota -C /owned -p shop pitr recover --yes",
        ];
        let error = match run(Cli::try_parse_from(args).unwrap()) {
            Err(error) => error.to_string(),
            Ok(_) => panic!("fenced entrypoint returned a server configuration"),
        };
        assert!(error.contains("active.json") && error.contains("pitr recover --yes"));
        let mut support = args.to_vec();
        support.push("--check-support");
        assert!(matches!(
            run(Cli::try_parse_from(support).unwrap()).unwrap(),
            Outcome::Done
        ));
        let recovery = Cli::try_parse_from(["nelcota", "pitr", "recover", "--yes"]).unwrap();
        assert!(matches!(
            recovery.command,
            Some(Command::Pitr {
                action: PitrAction::Recover { yes: true }
            })
        ));
    }
}

#[derive(Subcommand, Debug)]
pub enum TokenKind {
    /// JWT with the service_role role (BYPASSES RLS: never use it in a frontend).
    ServiceRole {
        #[arg(long, default_value_t = 3650)]
        days: u64,
    },
}

#[derive(Subcommand, Debug)]
pub enum PitrAction {
    /// Archives every WAL segment to the host's S3 and takes a first full backup.
    Enable,
    /// Stops archiving (the backups already in S3 are kept).
    Disable,
    /// Base backups and the time range that can be restored.
    Status,
    /// Verifies a cleanly stopped PG17 directory and explicitly clears its fence.
    Recover {
        /// Does not ask for confirmation; verification is still mandatory.
        #[arg(long)]
        yes: bool,
    },
    /// Takes a base backup now (full on Sundays, differential otherwise).
    Backup,
    /// Restores the database to a moment (REPLACES the current data).
    Restore {
        /// Target moment, e.g. "2026-10-07 14:30:00+00" (default: the last archived write).
        #[arg(long)]
        time: Option<String>,
        /// Does not ask for confirmation.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Args, Debug)]
pub struct InitArgs {
    /// Project domain (e.g. api.shop.com). Without it, use --project with a
    /// base domain (subdomain) or --local.
    pub domain: Option<String>,
    /// Project name (default: derived from the domain, e.g. api.shop.com → shop).
    #[arg(long)]
    pub project: Option<String>,
    /// Host base domain: `--project shop` becomes `shop.<base>`.
    #[arg(long)]
    pub base_domain: Option<String>,
    /// Local host, without a public domain: HTTPS at https://<project>.localhost.
    #[arg(long)]
    pub local: bool,
    /// Panel login when creating the host: one for all (default) or per project.
    #[arg(long, value_enum, default_value_t = PanelLogin::Shared)]
    pub panel_login: PanelLogin,
    /// Administrator email (default: admin@<domain>).
    #[arg(long)]
    pub email: Option<String>,
    /// Asks no questions (uses the defaults and the flags).
    #[arg(long, short)]
    pub yes: bool,
    /// App image.
    #[arg(
        long,
        env = "NELCOTA_IMAGE",
        default_value = "ghcr.io/nelcota/nelcota-server"
    )]
    pub image: String,
    /// Image tag (default: this binary's version).
    #[arg(long)]
    pub version: Option<String>,
    /// Postgres profile: 1gb, 2gb, 4gb or 8gb (default: by the RAM split across the projects).
    #[arg(long)]
    pub profile: Option<String>,
    #[arg(long)]
    pub s3_endpoint: Option<String>,
    #[arg(long)]
    pub s3_bucket: Option<String>,
    #[arg(long)]
    pub s3_access_key: Option<String>,
    #[arg(long)]
    pub s3_secret_key: Option<String>,
    #[arg(long, default_value = "us-east-1")]
    pub s3_region: String,
    /// How projects run: docker (N per host) or systemd (one, on Debian/Ubuntu,
    /// with Postgres and Caddy from apt). Only when the host is created.
    #[arg(long, value_enum, default_value_t = Runtime::Docker)]
    pub runtime: Runtime,
    /// Configures installed ufw on a new non-local Linux host (SSH, 80 and 443).
    #[arg(long)]
    pub firewall: bool,
    /// Skips Docker, ports, RAM and DNS checks, not installation prerequisites.
    #[arg(long)]
    pub skip_checks: bool,
}

#[derive(Args, Debug)]
pub struct DevArgs {
    /// Capture local auth email with Mailpit and require signup confirmation (needs OpenSSL).
    #[arg(long)]
    pub mail: bool,
    /// Application page receiving local email-link fragments.
    #[arg(
        long,
        default_value = "http://localhost:3000/auth/callback",
        requires = "mail"
    )]
    pub mail_callback: String,
    #[arg(long, default_value = "127.0.0.1:8000")]
    pub listen: std::net::SocketAddr,
    /// Local port of the development Postgres (default: the saved one, else 54322).
    /// A new port is saved in .nelcota/dev.env.
    #[arg(long)]
    pub db_port: Option<u16>,
}

/// What `main` should do after the command.
pub enum Outcome {
    Done,
    /// Start the HTTP server with this configuration.
    Serve(Box<Config>),
    UpdatesServe(nelcota_deployment::protocol::ControllerConfig),
}

pub fn run(cli: Cli) -> anyhow::Result<Outcome> {
    let default_dir = match &cli.command {
        Some(Command::Update(_)) => update::default_dir(),
        _ => PathBuf::from("."),
    };
    let dir = std::path::absolute(cli.dir.as_ref().unwrap_or(&default_dir))
        .context("could not resolve the host directory")?;
    let host = host::Host::new(&dir);
    // Every enrolled host mutation participates in the same deployment lease.
    let _deployment = match cli.command.as_ref() {
        Some(
            Command::Up
            | Command::Down { .. }
            | Command::Remove { .. }
            | Command::PanelLogin { .. }
            | Command::Upgrade { .. }
            | Command::Backup { .. }
            | Command::Restore { .. }
            | Command::Pitr { .. }
            | Command::AdminPassword,
        ) => {
            host.require()?;
            Some(host::acquire_mutation_lease(&dir)?)
        }
        _ => None,
    };
    let enrolled = dir.join("updates-controller.json").is_file();
    if matches!(
        cli.command,
        Some(Command::Upgrade {
            without_controller: false,
            ..
        })
    ) && enrolled
    {
        bail!(
            "enrolled hosts upgrade through the updates controller; pass --without-controller to upgrade with this CLI, or use `updates recover` over SSH for recovery"
        );
    }
    let selection = cli.project.as_deref();
    let done = |r: anyhow::Result<()>| r.map(|()| Outcome::Done);

    // A bare `nelcota` on a machine with no server configuration is someone
    // looking for the commands, not trying to start the API.
    if cli.command.is_none() && !server_configured() {
        use clap::CommandFactory;
        Cli::command().print_help()?;
        println!();
        return Ok(Outcome::Done);
    }

    match cli.command.unwrap_or(Command::Serve) {
        // The newly installed CLI acquires the host lease when it runs upgrade.
        // Holding that lease while waiting for the child would deadlock it.
        Command::Update(args) => done(update::run(&host, selection, args)),
        Command::Serve => {
            pitr::fence::require_native_clear()?;
            Ok(Outcome::Serve(Box::new(Config::load()?)))
        }
        Command::GuardedServe {
            state,
            recovery,
            check_only,
            check_support,
        } => {
            if check_support {
                return Ok(Outcome::Done);
            }
            pitr::fence::require_guard_clear_at(&state, &recovery)?;
            pitr::fence::require_native_clear()?;
            if check_only {
                return Ok(Outcome::Done);
            }
            Ok(Outcome::Serve(Box::new(Config::load()?)))
        }
        Command::Updates(args) => updates::run(&dir, args),
        Command::Init(mut args) => {
            if args.project.is_none() {
                args.project = cli.project.clone();
            }
            done(init::run(&host, *args))
        }
        Command::Projects => done(projects::list(&host)),
        Command::Up => {
            let manifest = host.require()?;
            let targets = match selection {
                Some(_) => vec![host.select(&manifest, selection)?],
                None => host.projects(&manifest),
            };
            done(lifecycle::up(&host, &manifest, &targets))
        }
        Command::Down { volumes, all, yes } => {
            let manifest = host.require()?;
            let targets = match all {
                true => host.projects(&manifest),
                false => {
                    vec![host.select(&manifest, selection)?]
                }
            };
            if volumes && manifest.runtime == Runtime::Docker {
                lifecycle::confirm_volume_deletion(&targets, all, yes)?;
            }
            for project in &targets {
                lifecycle::down(project, volumes)?;
            }
            if all {
                caddy::down(&host, manifest.runtime, volumes)?;
            }
            Ok(Outcome::Done)
        }
        Command::Status => {
            let manifest = host.require()?;
            let targets = match selection {
                Some(_) => vec![host.select(&manifest, selection)?],
                None => host.projects(&manifest),
            };
            done(lifecycle::status(&host, &manifest, &targets))
        }
        Command::Doctor => done(doctor::run(&host)),
        Command::Logs { follow, service } => {
            let manifest = host.require()?;
            let service = match service {
                Some(LogService::Caddy) => {
                    return done(caddy::logs(&host, manifest.runtime, follow));
                }
                Some(LogService::App) => Some(project::Service::App),
                Some(LogService::Postgres) => Some(project::Service::Postgres),
                None => None,
            };
            done(lifecycle::logs(
                &host.select(&manifest, selection)?,
                follow,
                service,
            ))
        }
        Command::Remove {
            yes,
            keep_files,
            no_backup,
        } => {
            let name = match selection {
                Some(name) => name,
                _ => {
                    bail!("name the project to remove: nelcota -p <name> remove");
                }
            };
            done(projects::remove(&host, name, yes, keep_files, no_backup))
        }
        Command::PanelLogin { mode } => done(projects::set_panel_login(&host, mode)),
        Command::Dev(args) => dev::run(&dir, args),
        Command::Migrate { path } => done(db::migrate(&host, selection, &path)),
        Command::Upgrade {
            version,
            all,
            allow_downgrade,
            dry_run,
            reinstall,
            without_controller: _,
        } => {
            let manifest = host.require()?;
            let options = upgrade::Options {
                allow_downgrade,
                dry_run,
                reinstall,
            };
            let targets = match all {
                true => host.projects(&manifest),
                false => {
                    vec![host.select(&manifest, selection)?]
                }
            };
            if enrolled {
                upgrade::require_cli_binary()?;
                for project in &targets {
                    upgrade::require_outside_controller(project)?;
                }
            }
            let mut failed = Vec::new();
            for project in &targets {
                // One failed upgrade (already rolled back) does not stop the others.
                if let Err(err) = upgrade::run(&host, project, version.as_deref(), options) {
                    util::warn(&format!("{err:#}"));
                    failed.push(project.name.clone());
                }
            }
            if !failed.is_empty() {
                bail!("upgrade failed for: {}", failed.join(", "));
            }
            Ok(Outcome::Done)
        }
        Command::Backup { upload, keep, all } => {
            let manifest = host.require()?;
            let targets = match all {
                true => host.projects(&manifest),
                false => {
                    vec![host.select(&manifest, selection)?]
                }
            };
            // S3 added to host.env after `init` is picked up without editing the cron.
            let upload = upload || backup::s3_configured(&host);
            let mut failed = Vec::new();
            for project in &targets {
                // A project with a problem does not stop the others from being backed up.
                let result = backup::run(&host, project, upload, keep).and_then(|_| {
                    if pitr::enabled(project) {
                        pitr::backup(project)?;
                    }
                    Ok(())
                });
                if let Err(err) = result {
                    util::warn(&format!("{err:#}"));
                    failed.push(project.name.clone());
                }
            }
            if !failed.is_empty() {
                bail!("backup failed for: {}", failed.join(", "));
            }
            Ok(Outcome::Done)
        }
        Command::Restore { file, files, yes } => {
            let manifest = host.require()?;
            done(backup::restore(
                &host,
                &host.select(&manifest, selection)?,
                &file,
                files,
                yes,
            ))
        }
        Command::Pitr { action } => {
            let manifest = host.require()?;
            let project = host.select(&manifest, selection)?;
            done(match action {
                PitrAction::Enable => pitr::enable(&host, &project),
                PitrAction::Disable => pitr::disable(&project),
                PitrAction::Status => pitr::status(&project),
                PitrAction::Recover { yes } => pitr::recover(&project, yes),
                PitrAction::Backup => pitr::backup(&project),
                PitrAction::Restore { time, yes } => pitr::restore(&project, time.as_deref(), yes),
            })
        }
        Command::Types { out, lang } => done(db::types(&host, selection, out.as_deref(), lang)),
        Command::Token {
            kind: TokenKind::ServiceRole { days },
        } => done(db::service_role_token(&host, selection, days)),
        Command::Keygen => {
            println!("{}", nelcota_auth::generate_ed25519_private_key());
            Ok(Outcome::Done)
        }
        Command::AdminPassword => {
            let manifest = host.require()?;
            let project = match manifest.panel_login {
                PanelLogin::Shared => None,
                PanelLogin::PerProject => Some(host.select(&manifest, selection)?),
            };
            let new = panel_login::reset(&host, &manifest, project.as_ref())?;
            // The hash is already on disk: show the password before a restart
            // can fail, or it would be lost.
            panel_login::print(&host, &[new]);
            println!();
            let affected = match project {
                Some(project) => vec![project],
                None => host.projects(&manifest),
            };
            lifecycle::recreate_apps(&affected)?;
            Ok(Outcome::Done)
        }
        Command::Healthcheck { addr } => match util::healthcheck(&addr) {
            true => Ok(Outcome::Done),
            false => std::process::exit(1),
        },
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn update_accepts_explicit_host_and_project_without_changing_upgrade() {
        let cli = Cli::try_parse_from([
            "nelcota",
            "-C",
            "/srv/host with spaces",
            "-p",
            "shop",
            "update",
            "--version",
            "0.5.6",
            "--dry-run",
            "--yes",
        ])
        .unwrap();
        assert_eq!(cli.dir, Some(PathBuf::from("/srv/host with spaces")));
        assert_eq!(cli.project.as_deref(), Some("shop"));
        assert!(matches!(cli.command, Some(Command::Update(_))));
        assert!(Cli::try_parse_from(["nelcota", "update", "--without-controller"]).is_err());
        assert!(Cli::try_parse_from(["nelcota", "update", "--allow-downgrade"]).is_err());
    }

    #[test]
    fn down_volumes_takes_an_explicit_yes() {
        let cli = Cli::try_parse_from(["nelcota", "down", "--all", "--volumes", "--yes"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Down {
                volumes: true,
                all: true,
                yes: true
            })
        ));
        let cli = Cli::try_parse_from(["nelcota", "down", "--volumes"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Down { yes: false, .. })
        ));
    }

    #[test]
    fn logs_take_a_known_service() {
        for (name, service) in [
            ("app", LogService::App),
            ("postgres", LogService::Postgres),
            ("caddy", LogService::Caddy),
        ] {
            let cli = Cli::try_parse_from(["nelcota", "logs", "-f", name]).unwrap();
            assert!(matches!(
                cli.command,
                Some(Command::Logs { follow: true, service: Some(s) }) if s == service
            ));
        }
        assert!(Cli::try_parse_from(["nelcota", "logs", "redis"]).is_err());
    }

    #[test]
    fn backup_keeps_at_least_the_new_dump() {
        assert!(Cli::try_parse_from(["nelcota", "backup", "--keep", "0"]).is_err());
        assert!(Cli::try_parse_from(["nelcota", "backup", "--keep", "-1"]).is_err());
        let cli = Cli::try_parse_from(["nelcota", "backup", "--all", "--keep", "7"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Backup { keep: Some(7), .. })
        ));
    }

    #[test]
    fn upgrade_flags() {
        let cli = Cli::try_parse_from(["nelcota", "upgrade", "--all", "--dry-run"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Upgrade {
                all: true,
                dry_run: true,
                allow_downgrade: false,
                version: None,
                reinstall: false,
                without_controller: false
            })
        ));
        let cli = Cli::try_parse_from(["nelcota", "upgrade", "--without-controller"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Upgrade {
                without_controller: true,
                ..
            })
        ));
        let cli = Cli::try_parse_from([
            "nelcota",
            "upgrade",
            "--version",
            "0.1.0",
            "--allow-downgrade",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Upgrade {
                allow_downgrade: true,
                version: Some(_),
                ..
            })
        ));
    }
}
