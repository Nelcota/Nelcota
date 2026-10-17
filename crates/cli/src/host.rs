//! Host: the root folder that holds the shared Caddy and the projects.
//!
//! ```text
//! <root>/
//! ├── nelcota-host.json   registry (source of truth): login mode, base domain, projects
//! ├── host.env            host secrets (0600): admin, SSO secret, S3
//! ├── shared/             public project list, mounted into the apps (read-only)
//! ├── caddy/              shared Caddy
//! └── projects/<name>/    one isolated project (compose, .env, migrations/, backups/)
//! ```

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

use crate::{envfile::EnvFile, naming, project::Project};

pub const MANIFEST: &str = "nelcota-host.json";

/// All host mutations, including the first init, share this deployment lease.
pub(crate) fn acquire_host_lease(root: &Path) -> anyhow::Result<nelcota_deployment::HostLock> {
    let lease = nelcota_deployment::HostLock::acquire(root)?;
    nelcota_deployment::management::ensure_idle(root)?;
    let journal = nelcota_deployment::Journal::open(root)?;
    if journal
        .list()?
        .iter()
        .any(|job| !job.public.phase.terminal())
    {
        bail!("deployment needs recovery: use nelcota updates recover before mutating this host");
    }
    Ok(lease)
}

pub(crate) fn acquire_mutation_lease(root: &Path) -> anyhow::Result<nelcota_deployment::HostLock> {
    let lease = acquire_host_lease(root)?;
    let host = Host::new(root);
    let manifest = host.require()?;
    if manifest.runtime == Runtime::Systemd {
        if manifest.projects.len() != 1 {
            bail!("no single native project is configured; use init before mutating this host");
        }
        // The host lease prevents its owner from being removed while this
        // command runs; another directory cannot release the durable claim.
        drop(crate::native::acquire_machine(&host)?);
    }
    Ok(lease)
}

/// How admins sign in to the panels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum PanelLogin {
    /// One login for every panel on the host (SSO between projects).
    #[default]
    Shared,
    /// Each project with its own login.
    PerProject,
}

impl PanelLogin {
    pub fn as_str(self) -> &'static str {
        match self {
            PanelLogin::Shared => "shared",
            PanelLogin::PerProject => "per-project",
        }
    }
}

/// How the projects run: containers (N projects per host) or systemd units
/// on the machine itself (one project).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Runtime {
    #[default]
    Docker,
    Systemd,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub name: String,
    pub domain: String,
}

impl ProjectEntry {
    pub fn url(&self) -> String {
        format!("https://{}", self.domain)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub panel_login: PanelLogin,
    /// Base domain for subdomains (`--project shop` → `shop.<base>`).
    #[serde(default)]
    pub base_domain: Option<String>,
    /// Local install: HTTPS with Caddy's internal certificate.
    #[serde(default)]
    pub local: bool,
    /// Hosts from before this field are Docker hosts.
    #[serde(default)]
    pub runtime: Runtime,
    /// App image (the tag lives in each project's `.env`).
    pub image: String,
    #[serde(default)]
    pub projects: Vec<ProjectEntry>,
}

pub struct Host {
    root: PathBuf,
}

impl Host {
    pub fn new(root: &Path) -> Self {
        Host {
            root: root.to_path_buf(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn exists(&self) -> bool {
        self.root.join(MANIFEST).is_file()
    }

    pub fn require(&self) -> anyhow::Result<Manifest> {
        if !self.exists() {
            bail!(
                "no host at {} ({MANIFEST} not found). Run `nelcota init` or use -C <root>.",
                self.root.display()
            );
        }
        self.manifest()
    }

    pub fn manifest(&self) -> anyhow::Result<Manifest> {
        let path = self.root.join(MANIFEST);
        let bytes =
            fs::read(&path).with_context(|| format!("could not read {}", path.display()))?;
        serde_json::from_slice(&bytes).with_context(|| format!("{} is invalid", path.display()))
    }

    /// Writes the registry atomically (temporary file + rename).
    pub fn save(&self, manifest: &Manifest) -> anyhow::Result<()> {
        fs::create_dir_all(&self.root)?;
        let tmp = self.root.join(format!("{MANIFEST}.tmp"));
        fs::write(&tmp, serde_json::to_string_pretty(manifest)? + "\n")?;
        fs::rename(&tmp, self.root.join(MANIFEST))?;
        Ok(())
    }

    pub fn secrets(&self) -> EnvFile {
        EnvFile::new(self.root.join("host.env"))
    }

    pub fn caddy_dir(&self) -> PathBuf {
        self.root.join("caddy")
    }

    pub fn shared_dir(&self) -> PathBuf {
        self.root.join("shared")
    }

    pub fn archive_dir(&self) -> PathBuf {
        self.root.join("archive")
    }

    pub fn project_dir(&self, name: &str) -> PathBuf {
        self.root.join("projects").join(name)
    }

    pub fn project(&self, manifest: &Manifest, entry: &ProjectEntry) -> Project {
        Project::new(
            &entry.name,
            &self.project_dir(&entry.name),
            manifest.runtime,
        )
    }

    pub fn projects(&self, manifest: &Manifest) -> Vec<Project> {
        manifest
            .projects
            .iter()
            .map(|e| self.project(manifest, e))
            .collect()
    }

    /// The project from `-p`; without `-p`, the host's only project.
    pub fn select(&self, manifest: &Manifest, name: Option<&str>) -> anyhow::Result<Project> {
        let entry = select_entry(manifest, name)?;
        Ok(self.project(manifest, entry))
    }
}

pub fn select_entry<'a>(
    manifest: &'a Manifest,
    name: Option<&str>,
) -> anyhow::Result<&'a ProjectEntry> {
    match (name, manifest.projects.as_slice()) {
        (Some(name), projects) => {
            naming::validate_project_name(name)?;
            projects.iter().find(|p| p.name == name).ok_or_else(|| {
                anyhow::anyhow!("project '{name}' does not exist (see `nelcota projects`)")
            })
        }
        (None, [only]) => Ok(only),
        (None, []) => bail!("no projects yet: create one with `nelcota init`"),
        (None, projects) => {
            let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
            bail!(
                "there are {} projects ({}): pick one with -p <name>",
                names.len(),
                names.join(", ")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(names: &[&str]) -> Manifest {
        Manifest {
            version: 1,
            panel_login: PanelLogin::Shared,
            base_domain: None,
            local: true,
            runtime: Runtime::Docker,
            image: "nelcota".into(),
            projects: names
                .iter()
                .map(|n| ProjectEntry {
                    name: (*n).into(),
                    domain: format!("{n}.localhost"),
                })
                .collect(),
        }
    }

    #[test]
    fn project_selection() {
        let one = manifest(&["shop"]);
        assert_eq!(select_entry(&one, None).unwrap().name, "shop");
        let two = manifest(&["shop", "blog"]);
        assert!(
            select_entry(&two, None)
                .unwrap_err()
                .to_string()
                .contains("-p <name>")
        );
        assert_eq!(select_entry(&two, Some("blog")).unwrap().name, "blog");
        assert!(select_entry(&two, Some("nothing")).is_err());
        assert!(select_entry(&two, Some("../etc")).is_err());
        assert!(select_entry(&manifest(&[]), None).is_err());
    }

    #[test]
    fn registry_round_trip() {
        let root = std::env::temp_dir().join(format!("nelcota-host-{}", std::process::id()));
        let host = Host::new(&root);
        let m = manifest(&["shop"]);
        host.save(&m).unwrap();
        let back = host.manifest().unwrap();
        assert_eq!(back.projects, m.projects);
        assert_eq!(back.panel_login, PanelLogin::Shared);
        assert!(
            fs::read_to_string(root.join(MANIFEST))
                .unwrap()
                .contains("\"panel_login\": \"shared\"")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
