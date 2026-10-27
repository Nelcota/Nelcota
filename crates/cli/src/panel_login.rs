//! Panel login: one for the whole host (default) or one per project.
//!
//! This module is the only one that writes admin credentials into the `.env` files.
//!
//! - **Single** (`shared`): email, hash and SSO secret live in `host.env` and
//!   are copied to every project. Signing in to one panel opens the others
//!   (SSO handoff in the project switcher).
//! - **Per project** (`per-project`): each project has its own email and
//!   password; without an SSO secret, the switcher only takes you to the other
//!   project's panel, which asks for its own login.

use crate::{
    envfile::EnvFile,
    host::{Host, Manifest, PanelLogin},
    project::Project,
    util,
};

const EMAIL: &str = "NELCOTA_ADMIN_EMAIL";
const HASH: &str = "NELCOTA_ADMIN_PASSWORD_HASH";
const SSO_SECRET: &str = "NELCOTA_ADMIN_SSO_SECRET";
/// Scope of the single login shared by every project.
const SHARED_SCOPE: &str = "all projects";

/// Password generated now (shown only once; only the hash is stored).
pub struct NewPassword {
    pub scope: String,
    pub email: String,
    pub password: String,
}

fn hash(password: &str) -> anyhow::Result<String> {
    nelcota_auth::hash_password(password)
        .ok_or_else(|| anyhow::anyhow!("could not hash the password"))
}

fn new_credentials(file: &EnvFile, email: &str, scope: &str) -> anyhow::Result<NewPassword> {
    let password = util::password(20);
    file.set(EMAIL, email)?;
    file.set(HASH, &hash(&password)?)?;
    Ok(NewPassword {
        scope: scope.to_owned(),
        email: email.to_owned(),
        password,
    })
}

/// Default email of the host admin.
pub fn host_email(host: &Host) -> anyhow::Result<Option<String>> {
    host.secrets().get(EMAIL)
}

/// New host credentials (email, password and SSO secret) in `host.env`.
pub fn init_host(host: &Host, email: &str) -> anyhow::Result<NewPassword> {
    let secrets = host.secrets();
    secrets.set(SSO_SECRET, &util::secret(48))?;
    new_credentials(&secrets, email, SHARED_SCOPE)
}

/// Writes the current mode's credentials into the project's `.env`. In
/// per-project mode, generates its own credentials if the project has none yet.
pub fn apply(
    host: &Host,
    manifest: &Manifest,
    project: &Project,
) -> anyhow::Result<Option<NewPassword>> {
    let env = project.env();
    let secrets = host.secrets();
    match manifest.panel_login {
        PanelLogin::Shared => {
            for key in [EMAIL, HASH, SSO_SECRET] {
                match secrets.get(key)? {
                    Some(value) => env.set(key, &value)?,
                    None => env.remove(key)?,
                }
            }
            Ok(None)
        }
        PanelLogin::PerProject => {
            env.remove(SSO_SECRET)?;
            let shared_hash = secrets.get(HASH)?;
            let own = env.get(HASH)?.filter(|h| Some(h) != shared_hash.as_ref());
            if own.is_some() {
                return Ok(None);
            }
            let email = host_email(host)?.unwrap_or_else(|| format!("admin@{}", project.name));
            new_credentials(&env, &email, &project.name).map(Some)
        }
    }
}

/// Switches the host's login mode and reapplies it to every project.
pub fn switch(
    host: &Host,
    manifest: &mut Manifest,
    mode: PanelLogin,
) -> anyhow::Result<Vec<NewPassword>> {
    let mut generated = Vec::new();
    if mode == PanelLogin::Shared && host.secrets().get(SSO_SECRET)?.is_none() {
        host.secrets().set(SSO_SECRET, &util::secret(48))?;
    }
    if mode == PanelLogin::PerProject {
        // Force new credentials: the single password must stop working.
        for project in host.projects(manifest) {
            project.env().remove(HASH)?;
        }
    }
    manifest.panel_login = mode;
    host.save(manifest)?;
    for project in host.projects(manifest) {
        if let Some(new) = apply(host, manifest, &project)? {
            generated.push(new);
        }
    }
    Ok(generated)
}

/// New password: the host's (single sign-on) or the project's (per-project login).
pub fn reset(
    host: &Host,
    manifest: &Manifest,
    project: Option<&Project>,
) -> anyhow::Result<NewPassword> {
    match (manifest.panel_login, project) {
        (PanelLogin::Shared, _) => {
            let email = host_email(host)?.unwrap_or_else(|| "admin@localhost".into());
            let new = new_credentials(&host.secrets(), &email, SHARED_SCOPE)?;
            for project in host.projects(manifest) {
                apply(host, manifest, &project)?;
            }
            Ok(new)
        }
        (PanelLogin::PerProject, Some(project)) => {
            let env = project.env();
            let email = env
                .get(EMAIL)?
                .unwrap_or_else(|| format!("admin@{}", project.name));
            new_credentials(&env, &email, &project.name)
        }
        (PanelLogin::PerProject, None) => {
            anyhow::bail!("per-project login: pick the project with -p <name>")
        }
    }
}

pub fn print(host: &Host, passwords: &[NewPassword]) {
    // Absolute, so the command also works from another folder (`init` may have
    // run with the default `-C .`).
    let root = std::fs::canonicalize(host.root()).unwrap_or_else(|_| host.root().to_path_buf());
    for p in passwords {
        println!();
        println!("  Panel ({}):", p.scope);
        println!("    email: {}", p.email);
        println!("    password: {}", p.password);
    }
    if passwords.is_empty() {
        return;
    }
    // Built from the host folder alone, never from the generated credentials.
    println!("  (shown only now; the files keep just the argon2id hash. Copy the password");
    println!(
        "   rather than retyping it. Lost it? {})",
        regenerate_command(&root)
    );
}

/// The command that prints a new panel password for this host.
fn regenerate_command(root: &std::path::Path) -> String {
    format!(
        "nelcota -C {} admin-password, with -p <project> for a per-project login",
        shell_word(&root.display().to_string())
    )
}

/// Quoted for `sh` only when needed, so the usual path stays easy to read.
fn shell_word(value: &str) -> String {
    let plain = !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b));
    match plain {
        true => value.to_owned(),
        false => format!("'{}'", value.replace('\'', r"'\''")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::ProjectEntry;

    fn setup(name: &str) -> (Host, Manifest) {
        let root =
            std::env::temp_dir().join(format!("nelcota-login-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let host = Host::new(&root);
        let manifest = Manifest {
            version: 1,
            panel_login: PanelLogin::Shared,
            base_domain: None,
            local: true,
            runtime: crate::host::Runtime::Docker,
            image: "nelcota".into(),
            projects: vec![
                ProjectEntry {
                    name: "shop".into(),
                    domain: "shop.localhost".into(),
                },
                ProjectEntry {
                    name: "blog".into(),
                    domain: "blog.localhost".into(),
                },
            ],
        };
        for p in &manifest.projects {
            std::fs::create_dir_all(host.project_dir(&p.name)).unwrap();
            std::fs::write(
                host.project_dir(&p.name).join(".env"),
                "POSTGRES_PASSWORD=x\n",
            )
            .unwrap();
        }
        host.save(&manifest).unwrap();
        (host, manifest)
    }

    #[test]
    fn single_login_copies_credentials_and_secret_to_all() {
        let (host, manifest) = setup("shared");
        init_host(&host, "admin@example.com").unwrap();
        for project in host.projects(&manifest) {
            assert!(apply(&host, &manifest, &project).unwrap().is_none());
            let env = project.env();
            assert_eq!(env.get(EMAIL).unwrap(), host.secrets().get(EMAIL).unwrap());
            assert_eq!(env.get(HASH).unwrap(), host.secrets().get(HASH).unwrap());
            assert!(env.get(SSO_SECRET).unwrap().is_some_and(|s| s.len() >= 32));
            assert_eq!(env.get("POSTGRES_PASSWORD").unwrap().as_deref(), Some("x"));
        }
        std::fs::remove_dir_all(host.root()).unwrap();
    }

    #[test]
    fn switching_to_per_project_generates_own_passwords_and_drops_sso() {
        let (host, mut manifest) = setup("switch");
        init_host(&host, "admin@example.com").unwrap();
        for project in host.projects(&manifest) {
            apply(&host, &manifest, &project).unwrap();
        }
        let generated = switch(&host, &mut manifest, PanelLogin::PerProject).unwrap();
        assert_eq!(generated.len(), 2);
        let shared_hash = host.secrets().get(HASH).unwrap();
        for project in host.projects(&manifest) {
            let env = project.env();
            assert!(env.get(SSO_SECRET).unwrap().is_none());
            assert_ne!(env.get(HASH).unwrap(), shared_hash);
        }
        assert_eq!(host.manifest().unwrap().panel_login, PanelLogin::PerProject);

        // And back to single sign-on.
        assert!(
            switch(&host, &mut manifest, PanelLogin::Shared)
                .unwrap()
                .is_empty()
        );
        for project in host.projects(&manifest) {
            assert_eq!(project.env().get(HASH).unwrap(), shared_hash);
        }
        std::fs::remove_dir_all(host.root()).unwrap();
    }

    #[test]
    fn regenerate_command_names_the_host_and_quotes_only_when_needed() {
        assert_eq!(
            regenerate_command(std::path::Path::new("/opt/nelcota")),
            "nelcota -C /opt/nelcota admin-password, with -p <project> for a per-project login"
        );
        assert!(
            regenerate_command(std::path::Path::new("/srv/my host/it's"))
                .starts_with(r"nelcota -C '/srv/my host/it'\''s' admin-password")
        );
    }
}
