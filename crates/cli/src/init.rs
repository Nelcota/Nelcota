//! `nelcota init [DOMAIN] [--project NAME]`: creates the host (the first time)
//! and adds a project. It only orchestrates; each step lives in its own module.

use anyhow::bail;

use crate::{
    InitArgs, caddy, checks,
    envfile::write_private,
    host::{Host, Manifest, ProjectEntry, Runtime},
    machine, naming, native, panel_login, registry, scaffold,
    util::{self, ask, ask_secret, interactive, ok, step, warn},
};

struct S3 {
    endpoint: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    region: String,
}

struct CreatedHost {
    manifest: Manifest,
    password: Option<panel_login::NewPassword>,
    native_lease: Option<native::MachineLease>,
    host_lease: Option<nelcota_deployment::HostLock>,
}

pub fn run(host: &Host, args: InitArgs) -> anyhow::Result<()> {
    // Validate every argument before writing anything: a rejected first call
    // must not leave a half-created host behind.
    let existing = match host.exists() {
        true => {
            let manifest = host.manifest()?;
            if args.local && !manifest.local {
                bail!("this host is not local; --local only applies when the host is created");
            }
            if manifest.runtime == Runtime::Systemd && !manifest.projects.is_empty() {
                bail!(
                    "this host runs its project with systemd, which holds one project per machine; \
                 use a Docker host (nelcota init on another folder or machine) for more"
                );
            }
            Some(manifest)
        }
        false => None,
    };
    let base_domain = match &args.base_domain {
        Some(base) => Some(normalize_base_domain(base)?),
        None => existing.as_ref().and_then(|m| m.base_domain.clone()),
    };
    let local = existing.as_ref().map_or(args.local, |m| m.local);
    let (name, domain) = naming::resolve(
        args.domain.as_deref(),
        args.project.as_deref(),
        base_domain.as_deref(),
        local,
    )?;
    let projects = existing.as_ref().map_or(&[][..], |m| m.projects.as_slice());
    if projects.iter().any(|p| p.name == name) {
        bail!("a project named '{name}' already exists (use --project for another name)");
    }
    if projects.iter().any(|p| p.domain == domain) {
        bail!("the domain {domain} is already used by another project");
    }
    let ram = checks::total_ram_mb().unwrap_or(2048);
    let profile = scaffold::choose_profile(args.profile.as_deref(), ram, projects.len() + 1)?;
    if existing.is_none() {
        validate_s3_flags(&args)?;
    }

    let CreatedHost {
        mut manifest,
        password: host_password,
        native_lease: _native_lease,
        host_lease: _host_lease,
    } = match existing {
        Some(manifest) => {
            let host_lease = lock_existing_host(host, &manifest)?;
            let lease = match manifest.runtime {
                Runtime::Systemd => {
                    native::check_machine()?;
                    Some(native::acquire_machine(host)?)
                }
                Runtime::Docker => None,
            };
            CreatedHost {
                manifest,
                password: None,
                native_lease: lease,
                host_lease: Some(host_lease),
            }
        }
        None => create_host(host, &args)?,
    };
    manifest.base_domain = base_domain;

    step(&format!("Project \"{name}\" at {domain}"));
    if !manifest.local && !args.skip_checks {
        checks::dns(&domain);
    }
    ok(&format!("Postgres profile: {profile}"));

    let entry = ProjectEntry { name, domain };
    let version = args
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    scaffold::create(
        host,
        &scaffold::NewProject {
            entry: &entry,
            runtime: manifest.runtime,
            profile,
            image: &manifest.image,
            version: &version,
        },
    )?;
    manifest.projects.push(entry.clone());
    host.save(&manifest)?;
    let project = host.project(&manifest, &entry);
    let project_password = panel_login::apply(host, &manifest, &project)?;
    if manifest.runtime == Runtime::Systemd {
        let password = project.env().get("POSTGRES_PASSWORD")?.unwrap_or_default();
        native::configure_postgres(profile, &password)?;
        native::deploy_binary()?;
        native::install_unit(&project)?;
    }
    registry::write(host, &manifest)?;
    caddy::write(host, &manifest)?;
    caddy::reload(host, manifest.runtime)?;
    ok(&format!("files in {}", project.dir.display()));

    println!();
    println!("Done. Next step:  nelcota up");
    println!();
    println!("  API:    {}/rest/v1/", entry.url());
    println!("  Auth:   {}/auth/v1/", entry.url());
    println!("  Panel:  {}/admin/", entry.url());
    let passwords: Vec<_> = host_password.into_iter().chain(project_password).collect();
    panel_login::print(&passwords);
    println!();
    println!(
        "  service_role token (BYPASSES RLS; backend only): nelcota -p {} token service-role",
        entry.name
    );
    Ok(())
}

fn normalize_base_domain(base: &str) -> anyhow::Result<String> {
    let base = base.trim().trim_end_matches('.').to_lowercase();
    if !naming::is_valid_domain(&base) {
        bail!("invalid base domain: {base}");
    }
    Ok(base)
}

/// The `--s3-*` flags configure the bucket together or not at all.
fn validate_s3_flags(args: &InitArgs) -> anyhow::Result<()> {
    let flags = [
        ("--s3-endpoint", &args.s3_endpoint),
        ("--s3-bucket", &args.s3_bucket),
        ("--s3-access-key", &args.s3_access_key),
        ("--s3-secret-key", &args.s3_secret_key),
    ];
    let missing: Vec<&str> = flags
        .iter()
        .filter(|(_, value)| value.is_none())
        .map(|(flag, _)| *flag)
        .collect();
    if !missing.is_empty() && missing.len() < flags.len() {
        bail!(
            "remote backup needs every S3 flag; missing: {}",
            missing.join(", ")
        );
    }
    Ok(())
}

/// First time: checks, host secrets, Caddy and machine setup.
fn create_host(host: &Host, args: &InitArgs) -> anyhow::Result<CreatedHost> {
    step(&format!("Creating the host at {}", host.root().display()));
    if args.runtime == Runtime::Systemd {
        native::check_machine()?;
    }
    match args.skip_checks {
        true => {
            warn("checks skipped (--skip-checks)");
        }
        false => {
            if args.runtime == Runtime::Docker {
                checks::docker()?;
            }
            checks::ports()?;
            match checks::total_ram_mb() {
                Some(mb) => ok(&format!("RAM: {mb} MB")),
                None => warn("could not measure RAM; assuming 2 GB"),
            }
        }
    }

    let host_lease = lock_new_host(host)?;
    // Hold the machine lease through the caller's final Caddy/unit writes.
    // A partial init keeps its durable owner for explicit same-host recovery.
    let native_lease = match args.runtime {
        Runtime::Systemd => Some(native::acquire_machine(host)?),
        Runtime::Docker => None,
    };
    if args.runtime == Runtime::Systemd {
        native::install_packages()?;
    }
    let s3 = backup_destination(args);
    let mut secrets = format!(
        "# nelcota host secrets (generated at {}). Mode 600, kept out of git.\n",
        util::timestamp()
    );
    if let Some(s3) = &s3 {
        secrets.push_str(&format!(
            "NELCOTA_BACKUP_S3_ENDPOINT={}\nNELCOTA_BACKUP_S3_BUCKET={}\nNELCOTA_BACKUP_S3_ACCESS_KEY={}\n\
             NELCOTA_BACKUP_S3_SECRET_KEY={}\nNELCOTA_BACKUP_S3_REGION={}\n",
            s3.endpoint, s3.bucket, s3.access_key, s3.secret_key, s3.region
        ));
    }
    write_private(host.secrets().path(), &secrets)?;

    let manifest = Manifest {
        version: 1,
        panel_login: args.panel_login,
        base_domain: None,
        local: args.local,
        runtime: args.runtime,
        image: args.image.clone(),
        projects: Vec::new(),
    };
    host.save(&manifest)?;

    let email = args.email.clone().unwrap_or_else(|| {
        let domain = args
            .base_domain
            .clone()
            .or_else(|| args.domain.clone())
            .unwrap_or_else(|| "localhost".into());
        format!("admin@{domain}")
    });
    let shared = panel_login::init_host(host, &email)?;
    ok(&format!("panel login: {}", manifest.panel_login.as_str()));

    registry::write(host, &manifest)?;
    caddy::write(host, &manifest)?;
    std::fs::write(
        host.root().join(".gitignore"),
        "host.env\nprojects/*/.env\nprojects/*/backups/\narchive/\n",
    )?;
    if !args.local {
        machine::setup(host, args.firewall);
    }
    let shown = (manifest.panel_login == crate::host::PanelLogin::Shared).then_some(shared);
    Ok(CreatedHost {
        manifest,
        password: shown,
        native_lease,
        host_lease: Some(host_lease),
    })
}

fn lock_new_host(host: &Host) -> anyhow::Result<nelcota_deployment::HostLock> {
    std::fs::create_dir_all(host.root())?;
    let lease = crate::host::acquire_host_lease(host.root())?;
    if host.exists() {
        bail!("host was created by another initializer; retry using its current registry");
    }
    Ok(lease)
}

fn lock_existing_host(
    host: &Host,
    expected: &Manifest,
) -> anyhow::Result<nelcota_deployment::HostLock> {
    let lease = crate::host::acquire_host_lease(host.root())?;
    if host.require()? != *expected {
        bail!("host registry changed during initialization; retry using its current registry");
    }
    Ok(lease)
}

fn backup_destination(args: &InitArgs) -> Option<S3> {
    if let (Some(endpoint), Some(bucket), Some(access_key), Some(secret_key)) = (
        &args.s3_endpoint,
        &args.s3_bucket,
        &args.s3_access_key,
        &args.s3_secret_key,
    ) {
        return Some(S3 {
            endpoint: endpoint.clone(),
            bucket: bucket.clone(),
            access_key: access_key.clone(),
            secret_key: secret_key.clone(),
            region: args.s3_region.clone(),
        });
    }
    if args.yes || !interactive() {
        warn(
            "remote backup not configured (dumps stay in projects/<name>/backups/; see docs/backup.md)",
        );
        return None;
    }
    println!();
    println!(
        "Remote backup to S3-compatible storage (AWS, Backblaze B2, Cloudflare R2, MinIO...)."
    );
    let endpoint = ask("S3 endpoint (Enter to skip)", "");
    if endpoint.is_empty() {
        warn("remote backup not configured");
        return None;
    }
    Some(S3 {
        endpoint,
        bucket: ask("Bucket", "nelcota-backups"),
        access_key: ask("Access key", ""),
        secret_key: ask_secret("Secret key (not shown)"),
        region: ask("Region", &args.s3_region),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn init_args(argv: &[&str]) -> InitArgs {
        let cli = crate::Cli::try_parse_from(argv).unwrap();
        match cli.command {
            Some(crate::Command::Init(args)) => *args,
            _ => unreachable!(),
        }
    }

    fn fixture_manifest() -> Manifest {
        Manifest {
            version: 1,
            panel_login: crate::host::PanelLogin::Shared,
            base_domain: None,
            local: true,
            runtime: Runtime::Docker,
            image: "owned fixture".into(),
            projects: Vec::new(),
        }
    }

    #[test]
    fn concurrent_new_hosts_cannot_overwrite_the_first_accepted_registry() {
        let temporary = tempfile::tempdir().unwrap();
        let host = Host::new(&temporary.path().join("host"));
        let lease = lock_new_host(&host).unwrap();
        assert!(lock_new_host(&host).is_err());
        let manifest = host.root().join(crate::host::MANIFEST);
        host.save(&fixture_manifest()).unwrap();
        let accepted = std::fs::read(&manifest).unwrap();
        drop(lease);
        let error = lock_new_host(&host).err().unwrap();
        assert!(error.to_string().contains("another initializer"));
        assert_eq!(std::fs::read(&manifest).unwrap(), accepted);
    }

    #[test]
    fn changed_existing_registry_is_rejected_before_initialization_writes() {
        let temporary = tempfile::tempdir().unwrap();
        let host = Host::new(&temporary.path().join("host"));
        let expected = fixture_manifest();
        host.save(&expected).unwrap();
        let mut current = expected.clone();
        current.projects.push(ProjectEntry {
            name: "accepted".into(),
            domain: "accepted.localhost".into(),
        });
        host.save(&current).unwrap();
        let error = lock_existing_host(&host, &expected).err().unwrap();
        assert!(error.to_string().contains("registry changed"));
        assert_eq!(host.require().unwrap(), current);
        drop(lock_existing_host(&host, &current).unwrap());
    }

    #[test]
    fn an_empty_native_host_cannot_reclaim_machine_ownership_through_up() {
        let temporary = tempfile::tempdir().unwrap();
        let host = Host::new(&temporary.path().join("host"));
        let mut manifest = fixture_manifest();
        manifest.runtime = Runtime::Systemd;
        host.save(&manifest).unwrap();
        let error = crate::host::acquire_mutation_lease(host.root())
            .err()
            .unwrap();
        assert!(error.to_string().contains("no single native project"));
        drop(lock_existing_host(&host, &manifest).unwrap());
    }

    #[test]
    fn rejected_arguments_leave_no_host_behind() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("host");
        let host = Host::new(&dir);
        for argv in [
            &["nelcota", "init", "not a domain", "--skip-checks"][..],
            &["nelcota", "init", "--project", "shop", "--skip-checks"],
            &[
                "nelcota",
                "init",
                "--local",
                "--project",
                "Bad!",
                "--skip-checks",
            ],
            &[
                "nelcota",
                "init",
                "--project",
                "shop",
                "--base-domain=bad_domain",
                "--skip-checks",
            ],
            &[
                "nelcota",
                "init",
                "--local",
                "--project",
                "shop",
                "--profile",
                "3gb",
                "--skip-checks",
            ],
            &[
                "nelcota",
                "init",
                "--local",
                "--project",
                "shop",
                "--s3-endpoint",
                "https://s3.example.com",
                "--skip-checks",
            ],
        ] {
            assert!(run(&host, init_args(argv)).is_err(), "{argv:?}");
            assert!(!dir.exists(), "{argv:?} created {}", dir.display());
        }
    }

    #[test]
    fn s3_flags_go_together() {
        assert!(validate_s3_flags(&init_args(&["nelcota", "init"])).is_ok());
        let all = init_args(&[
            "nelcota",
            "init",
            "--s3-endpoint",
            "e",
            "--s3-bucket",
            "b",
            "--s3-access-key",
            "a",
            "--s3-secret-key",
            "s",
        ]);
        assert!(validate_s3_flags(&all).is_ok());
        let partial = init_args(&["nelcota", "init", "--s3-bucket", "b"]);
        let err = validate_s3_flags(&partial).unwrap_err().to_string();
        assert!(err.contains("--s3-endpoint") && !err.contains("--s3-bucket,"));
    }
}
