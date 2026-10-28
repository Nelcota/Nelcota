//! Commands over the set of projects: list, remove and switch the panel
//! login mode.

use std::fs;

use anyhow::{Context, bail};

use crate::{
    backup, caddy,
    host::{Host, PanelLogin, Runtime},
    lifecycle, naming, native, panel_login,
    project::Service,
    registry,
    util::{self, ok, step, warn},
};

/// `nelcota projects`
pub fn list(host: &Host) -> anyhow::Result<()> {
    let manifest = host.require()?;
    println!(
        "Panel login: {}{}",
        manifest.panel_login.as_str(),
        manifest
            .base_domain
            .as_deref()
            .map(|b| format!(" · base domain: {b}"))
            .unwrap_or_default()
    );
    println!();
    if manifest.projects.is_empty() {
        println!("No projects. Create one with `nelcota init`.");
        return Ok(());
    }
    lifecycle::status(host, &manifest, &host.projects(&manifest))
}

/// `nelcota remove -p <name>`: final backup in `archive/`, containers and data
/// deleted, project out of Caddy and the registry.
pub fn remove(
    host: &Host,
    name: &str,
    yes: bool,
    keep_files: bool,
    no_backup: bool,
) -> anyhow::Result<()> {
    naming::validate_project_name(name)?;
    let mut manifest = host.require()?;
    let entry = match manifest.projects.iter().find(|p| p.name == name).cloned() {
        Some(entry) => entry,
        _ => {
            bail!("project '{name}' does not exist");
        }
    };
    if !yes
        && !(util::interactive()
            && util::confirm(&format!(
                "Remove the project {name} ({})? {} and the data is deleted.",
                entry.domain,
                match no_backup {
                    true => "There is NO final backup (--no-backup)",
                    false => "A final backup goes to archive/",
                }
            )))
    {
        bail!("removal cancelled (use --yes to skip the question)");
    }

    let native_lease = match manifest.runtime {
        Runtime::Systemd => Some(native::acquire_machine(host)?),
        Runtime::Docker => None,
    };
    let project = host.project(&manifest, &entry);
    crate::pitr::fence::require_clear(&project)?;
    match no_backup {
        true => {
            warn("--no-backup: removing without a final backup");
        }
        false => {
            if project.health(Service::Postgres).as_deref() != Some("healthy") {
                step(&format!(
                    "Starting the {name} Postgres for the final backup"
                ));
                project
                    .start(&[Service::Postgres])
                    .and_then(|()| {
                        project.wait_healthy(Service::Postgres, lifecycle::HEALTH_TIMEOUT)
                    })
                    .context(
                        "could not start Postgres for the final backup; nothing was removed \
                     (fix it, or pass --no-backup to remove without one)",
                    )?;
            }
            let dump = backup::run(host, &project, false, None)?;
            fs::create_dir_all(host.archive_dir())?;
            let archived = host
                .archive_dir()
                .join(dump.file_name().unwrap_or_default());
            crate::backup::archive(&dump, &archived)?;
            ok(&format!("final backup at {}", archived.display()));
        }
    }
    crate::migration_backup::install::remove(&project)?;
    match manifest.runtime {
        Runtime::Docker if project.exists() => lifecycle::down(&project, true)?,
        Runtime::Docker => {}
        Runtime::Systemd => native::remove(&project)?,
    }

    manifest.projects.retain(|p| p.name != name);
    host.save(&manifest)?;
    registry::write(host, &manifest)?;
    caddy::write(host, &manifest)?;
    caddy::reload(host, manifest.runtime)?;

    match keep_files {
        true => {
            ok(&format!("files kept at {}", project.dir.display()));
        }
        false => {
            fs::remove_dir_all(&project.dir)?;
            ok(&format!("folder {} removed", project.dir.display()));
        }
    }
    if let Some(lease) = native_lease {
        lease.release()?;
    }
    ok(&format!("project {name} removed"));
    Ok(())
}

/// `nelcota panel-login shared|per-project`
pub fn set_panel_login(host: &Host, mode: PanelLogin) -> anyhow::Result<()> {
    let mut manifest = host.require()?;
    if manifest.panel_login == mode {
        println!("The panel login is already {}.", mode.as_str());
        return Ok(());
    }
    step(&format!(
        "Panel login: {} → {}",
        manifest.panel_login.as_str(),
        mode.as_str()
    ));
    let generated = panel_login::switch(host, &mut manifest, mode)?;
    // The new hashes are already written: show the passwords before a restart
    // can fail, or they would be lost.
    if mode == PanelLogin::Shared {
        println!();
        println!("Single sign-on on: use the host email and password on any panel.");
        println!("(Forgot the password? `nelcota admin-password`.)");
    }
    panel_login::print(host, &generated);
    println!();
    registry::write(host, &manifest)?;
    lifecycle::recreate_apps(&host.projects(&manifest))?;
    Ok(())
}
