//! Real Docker/database/files effects with explicit provenance/TLS/proxy doubles.
use super::*;
use nelcota_deployment::management::{PublicJob, now};
use std::cell::Cell;
#[test]
fn log_metadata_omits_free_form_messages_and_sql() {
    let lines = "plaintext secret\nnull\n{\"timestamp\":\"2026-10-14T00:00:00Z\",\"level\":\"INFO\",\"target\":\"nelcota\",\"fields\":{\"message\":\"private credential\",\"sql\":\"SELECT secret\"}}";
    let metadata = log_metadata(lines);
    assert_eq!(metadata.len(), 1);
    assert_eq!(metadata[0].level, "INFO");
    assert_eq!(metadata[0].message, "event_metadata_only");
    let serialized = serde_json::to_string(&metadata).unwrap();
    assert!(!serialized.contains("credential"));
    assert!(!serialized.contains("secret"));
}

fn full_identity_inventory_keeps_existing_state_readable(policy: &Policy) {
    let directory = tempfile::tempdir_in(&policy.root).unwrap();
    let mut bounded = policy.clone();
    bounded.root = directory.path().to_path_buf();
    bounded.project_ids.clear();
    for index in 0..256 {
        let name = format!("retired-{index:03}");
        let id = nelcota_deployment::token().unwrap();
        bounded.record_identity(&name, &id, true).unwrap();
        bounded.project_ids.insert(name, id);
    }
    assert!(
        bounded.identities_valid(),
        "retired identities stay readable at capacity"
    );
    let path = bounded.root.join("updates/host-identities.json");
    let before = fs::read(&path).unwrap();
    let records: serde_json::Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(records.as_object().unwrap().len(), 256);
    let failure = bounded
        .record_identity("one-too-many", &nelcota_deployment::token().unwrap(), true)
        .unwrap_err();
    assert_eq!(failure.to_string(), "host identity inventory full");
    assert_eq!(
        fs::read(&path).unwrap(),
        before,
        "rejection cannot evict identities"
    );

    // Reusing an existing name at the cap is permitted. Recording its identity
    // alone must never authorize a project whose matching runtime is absent.
    let name = "retired-000";
    let original = bounded.project_ids[name].clone();
    let replacement = nelcota_deployment::token().unwrap();
    bounded.record_identity(name, &replacement, false).unwrap();
    assert!(!bounded.project_enrolled(name));
    assert!(!bounded.identities_valid());
    bounded.record_identity(name, &original, true).unwrap();
    assert!(bounded.identities_valid());
    assert_eq!(fs::read(path).unwrap(), before);
}
struct FixtureEffects {
    image: String,
    fail_finish: Cell<bool>,
}
impl Effects for FixtureEffects {
    fn prepare(&self, p: &Project) -> anyhow::Result<()> {
        fs::write(p.path("postgres/Dockerfile"), "FROM postgres:17-alpine\n")?;
        Ok(())
    }
    fn preflight(&self, _: &Policy, _: &Operation) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }
    fn verify_image(&self, _: &Policy, _: &Path) -> anyhow::Result<()> {
        Ok(())
    }
    fn image(&self, _: &Provisioning) -> String {
        self.image.clone()
    }
    fn publish(&self, host: &Host) -> anyhow::Result<()> {
        let manifest = host.require()?;
        registry::write(host, &manifest)?;
        caddy::write(host, &manifest)
    }
    fn verify_https(&self, _: &Policy, p: &Project) -> anyhow::Result<()> {
        p.wait_healthy(Service::App, crate::lifecycle::HEALTH_TIMEOUT)
    }
    fn finish(&self, j: &HostJournal, t: &mut Task) -> anyhow::Result<()> {
        if self.fail_finish.replace(false) {
            bail!("injected receipt failure after the gate reopened");
        }
        j.advance(t, Stage::Completed, None)
    }
}
struct Cleanup {
    projects: Vec<Project>,
    volumes: Vec<String>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        for p in &self.projects {
            let _ = p.down(true);
        }
        for name in &self.volumes {
            let _ = Command::new("docker").args(["volume", "rm", name]).status();
        }
    }
}
pub(in crate::updates) fn accepted(policy: &Policy, op: Operation) -> anyhow::Result<Task> {
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    let name = op.project();
    let (identity, env_sha) = match op {
        Operation::Create { .. } => (nelcota_deployment::token()?, None),
        _ => {
            let p = host.select(&manifest, Some(name))?;
            (
                String::from_utf8(read_private(&p.path(".deployment-project-id"), 64)?)?,
                Some(digest_file(&p.path(".env"), 65536)?),
            )
        }
    };
    let backup_sha = match &op {
        Operation::Restore { backup, .. } => {
            Some(backup_identity(&approved_backup(policy, name, backup)?)?)
        }
        _ => None,
    };
    let key = nelcota_deployment::token()?;
    let p = policy.host_management.as_ref().unwrap();
    let public = PublicJob {
        id: nelcota_deployment::token()?,
        request_key: key.clone(),
        operation: op,
        stage: Stage::Accepted,
        last_stage: None,
        sequence: 1,
        updated_at: now()?,
        changed: false,
        backup: None,
        error: None,
    };
    let journal = HostJournal::open(&policy.root)?;
    let task = journal.begin(
        Task {
            schema: 1,
            public,
            actor: policy.operators[0].email.clone(),
            key,
            plan: nelcota_deployment::token()?,
            manifest_sha: digest_file(&policy.root.join(crate::host::MANIFEST), 1024 * 1024)?,
            env_sha,
            identity,
            backup_sha,
            version: p.version.clone(),
            image_digest: p.image_digest.clone(),
            interrupted: None,
        },
        &policy.root,
    )?;
    Ok(task)
}
fn run(policy: &Policy, op: Operation, effects: &FixtureEffects) -> anyhow::Result<Task> {
    let task = accepted(policy, op)?;
    let _ = execute_with(policy, &task.public.id, false, effects);
    Ok(HostJournal::open(&policy.root)?
        .list()?
        .into_iter()
        .find(|t| t.public.id == task.public.id)
        .unwrap())
}
fn sql(p: &Project, query: &str) -> String {
    let output = p
        .as_postgres(&[
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-Atc",
            query,
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "fixture query failed");
    String::from_utf8(output.stdout).unwrap().trim().into()
}
async fn api(p: &Project) -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = p;
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}
fn url(p: &Project) -> String {
    let id = p.compose_output(&["ps", "-q", "app"]).unwrap();
    let output = Command::new("docker")
        .args([
            "inspect",
            "--format",
            "{{json .NetworkSettings.Networks}}",
            id.trim(),
        ])
        .output()
        .unwrap();
    let networks: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let ip = networks
        .as_object()
        .unwrap()
        .iter()
        .find(|(name, _)| name.ends_with("_internal"))
        .unwrap()
        .1["IPAddress"]
        .as_str()
        .unwrap();
    format!("http://{ip}:8000")
}
#[test]
#[ignore = "requires the isolated root Docker harness in scripts/test-host-management.py"]
fn docker_lifecycle_preserves_other_projects_and_verified_restore_writes() {
    let base = std::env::var("NELCOTA_HOST_FIXTURE_ROOT").expect("root Docker harness required");
    let temp = tempfile::tempdir_in(base).unwrap();
    let root = temp.path().to_path_buf();
    let host = Host::new(&root);
    let nonce = nelcota_deployment::token().unwrap();
    let shop = format!("hm{}-shop", &nonce[..8]);
    let seed = format!("hm{}-seed", &nonce[..8]);
    let mut cleanup = Cleanup {
        volumes: vec![],
        projects: vec![
            Project::new(&shop, &host.project_dir(&shop), Runtime::Docker),
            Project::new(&seed, &host.project_dir(&seed), Runtime::Docker),
        ],
    };
    host.save(&crate::host::Manifest {
        version: 1,
        panel_login: crate::host::PanelLogin::Shared,
        base_domain: None,
        local: true,
        runtime: Runtime::Docker,
        image: "ghcr.io/nelcota/nelcota-server".into(),
        projects: vec![],
    })
    .unwrap();
    let password = nelcota_deployment::token().unwrap();
    host.secrets()
        .set("NELCOTA_ADMIN_EMAIL", "admin@example.test")
        .unwrap();
    host.secrets()
        .set(
            "NELCOTA_ADMIN_PASSWORD_HASH",
            &nelcota_auth::hash_password(&password).unwrap(),
        )
        .unwrap();
    host.secrets()
        .set(
            "NELCOTA_ADMIN_SSO_SECRET",
            &nelcota_deployment::token().unwrap(),
        )
        .unwrap();
    let mut policy = Policy {
        schema: 1,
        root: root.clone(),
        origin: "https://control.example.test".into(),
        controller_uid: 1000,
        controller_gid: 1000,
        verifier: "/missing/gh".into(),
        operators: vec![super::super::policy::Operator {
            email: "operator@example.test".into(),
            password_hash: nelcota_auth::hash_password(&password).unwrap(),
            projects: vec![],
            manage_host: true,
        }],
        project_ids: Default::default(),
        enable_installation: false,
        validation_report: None,
        minimum_free_bytes: 1 << 30,
        timeout_seconds: 300,
        host_management: Some(Provisioning {
            version: env!("CARGO_PKG_VERSION").into(),
            image_digest: nelcota_deployment::token().unwrap(),
            source_sha: nonce[..40].into(),
            max_projects: 32,
            domain_suffixes: vec!["example.test".into()],
            addresses: vec!["203.0.113.7".into()],
        }),
    };
    full_identity_inventory_keeps_existing_state_readable(&policy);
    let effects = FixtureEffects {
        image: std::env::var("NELCOTA_HOST_TEST_IMAGE").unwrap(),
        fail_finish: Cell::new(false),
    };
    let orphan = format!("hm{}-orphan", &nonce[..8]);
    let volume = format!("nelcota-{orphan}_pgdata");
    assert!(
        Command::new("docker")
            .args(["volume", "create", &volume])
            .status()
            .unwrap()
            .success()
    );
    cleanup.volumes.push(volume.clone());
    assert_eq!(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(docker_namespace_blocker(&orphan)),
        Some("docker_namespace_exists")
    );
    assert!(
        Command::new("docker")
            .args(["volume", "rm", &volume])
            .status()
            .unwrap()
            .success()
    );
    cleanup.volumes.clear();
    for name in [&seed, &shop] {
        effects.fail_finish.set(name == &shop);
        let task = run(
            &policy,
            Operation::Create {
                project: name.clone(),
                domain: format!("{name}.example.test"),
                profile: "1gb".into(),
            },
            &effects,
        )
        .unwrap();
        if name == &shop {
            assert_eq!(task.public.stage, Stage::NeedsAttention);
            assert_eq!(task.interrupted, Some(Stage::Verifying));
            let target = host.select(&host.require().unwrap(), Some(name)).unwrap();
            let original_env = fs::read(target.path(".env")).unwrap();
            sql(
                &target,
                "CREATE TABLE public.creation_probe(value text); INSERT INTO public.creation_probe VALUES ('preserved');",
            );
            execute_with(&policy, &task.public.id, true, &effects).unwrap();
            assert_eq!(fs::read(target.path(".env")).unwrap(), original_env);
            assert_eq!(
                sql(&target, "SELECT value FROM public.creation_probe"),
                "preserved"
            );
        }
        if name == &seed {
            assert_eq!(task.public.stage, Stage::Completed, "creation failed");
        }
    }
    // An old scoped grant survives a managed project being recreated under its name.
    policy.operators[0].projects = vec![shop.clone()];
    policy
        .project_ids
        .insert(shop.clone(), nelcota_deployment::token().unwrap());
    let policy_file = root.join("policy.json");
    atomic_write(&policy_file, &serde_json::to_vec(&policy).unwrap()).unwrap();
    Policy::load(&policy_file).expect("a tracked new identity must permit worker restart");
    let p = &cleanup.projects[0];
    let other = &cleanup.projects[1];
    sql(
        p,
        "CREATE TABLE public.host_probe (value text); INSERT INTO public.host_probe VALUES ('before');",
    );
    sql(
        other,
        "CREATE TABLE public.host_probe (value text); INSERT INTO public.host_probe VALUES ('untouched');",
    );
    sql(
        p,
        "INSERT INTO storage.buckets (id,public) VALUES ('files',false); CREATE POLICY fixture_owner ON storage.objects FOR ALL TO authenticated USING (bucket_id='files' AND (storage.foldername(name))[1]=auth.uid()::text) WITH CHECK (bucket_id='files' AND (storage.foldername(name))[1]=auth.uid()::text);",
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (token, path) = rt.block_on(async {
        let client = api(p).await;
        let reply = client
            .post(format!("{}/auth/v1/signup", url(p)))
            .header("content-type", "application/json")
            .body(
                serde_json::to_vec(&serde_json::json!({
                    "email": "fixture@example.test",
                    "password": nelcota_deployment::token().unwrap()
                }))
                .unwrap(),
            )
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        let token = reply["access_token"].as_str().unwrap().to_owned();
        let path = format!(
            "/storage/v1/object/files/{}/probe.txt",
            reply["user"]["id"].as_str().unwrap()
        );
        client
            .post(format!("{}{path}", url(p)))
            .bearer_auth(&token)
            .header("content-type", "text/plain")
            .body("before")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        (token, path)
    });
    let task = run(
        &policy,
        Operation::Backup {
            project: shop.clone(),
        },
        &effects,
    )
    .unwrap();
    assert_eq!(task.public.stage, Stage::Completed);
    let backup = task.public.backup.unwrap();
    sql(p, "UPDATE public.host_probe SET value='changed';");
    let journal = HostJournal::open(&root).unwrap();
    let mut task = accepted(
        &policy,
        Operation::Restore {
            project: shop.clone(),
            backup,
        },
    )
    .unwrap();
    changed(&journal, &mut task, Stage::BackingUp).unwrap();
    p.stop(&[Service::App]).unwrap();
    let safety = backup::run(&host, p, false, None).unwrap();
    backup::validate(&safety).unwrap();
    let copy = root.join("safety-copy.dump");
    fs::copy(&safety, &copy).unwrap();
    task.public.backup = Some(safety.file_name().unwrap().to_str().unwrap().to_owned());
    journal.advance(&mut task, Stage::Applying, None).unwrap();
    journal.reconcile().unwrap();
    fs::remove_file(&safety).unwrap();
    assert!(execute_with(&policy, &task.public.id, true, &effects).is_err());
    assert_eq!(
        sql(p, "SELECT value FROM public.host_probe"),
        "changed",
        "missing safety backup must block destructive recovery"
    );
    fs::copy(copy, &safety).unwrap();
    effects.fail_finish.set(true);
    assert!(execute_with(&policy, &task.public.id, true, &effects).is_err());
    let task = journal
        .list()
        .unwrap()
        .into_iter()
        .find(|entry| entry.public.id == task.public.id)
        .unwrap();
    assert_eq!(task.public.stage, Stage::NeedsAttention);
    assert_eq!(task.interrupted, Some(Stage::Verifying));
    assert_eq!(sql(p, "SELECT value FROM public.host_probe"), "before");
    assert_eq!(
        sql(other, "SELECT value FROM public.host_probe"),
        "untouched"
    );
    rt.block_on(async {
        let client = api(p).await;
        let bytes = client
            .get(format!("{}{path}", url(p)))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(bytes, "before");
    });
    sql(p, "UPDATE public.host_probe SET value='after-commit';");
    execute_with(&policy, &task.public.id, true, &effects).unwrap();
    assert_eq!(
        sql(p, "SELECT value FROM public.host_probe"),
        "after-commit",
        "recovery must not replay the old snapshot"
    );
    // Simulate interruption after volumes/configuration are retired, before the
    // identity inventory and host manifest are committed.
    let journal = HostJournal::open(&root).unwrap();
    let mut task = accepted(
        &policy,
        Operation::Remove {
            project: shop.clone(),
        },
    )
    .unwrap();
    changed(&journal, &mut task, Stage::BackingUp).unwrap();
    p.stop(&[Service::App]).unwrap();
    let final_dump = backup::run(&host, p, false, None).unwrap();
    nelcota_deployment::private_dir(&host.archive_dir()).unwrap();
    let filename = final_dump.file_name().unwrap().to_str().unwrap().to_owned();
    backup::archive(&final_dump, &host.archive_dir().join(&filename)).unwrap();
    task.public.backup = Some(filename.clone());
    journal.advance(&mut task, Stage::Applying, None).unwrap();
    p.down(true).unwrap();
    fs::rename(
        &p.dir,
        host.archive_dir()
            .join(format!("project-{}-{}", shop, task.public.id)),
    )
    .unwrap();
    journal.reconcile().unwrap();
    let restarted = Policy::load(&policy_file)
        .expect("partially removed recreated identity must allow recovery");
    let inventory = rt
        .block_on(status(&restarted))
        .expect("partial removal must not hide history");
    assert!(
        inventory
            .jobs
            .iter()
            .any(|job| job.id == task.public.id && job.stage == Stage::NeedsAttention)
    );
    execute_with(&restarted, &task.public.id, true, &effects).unwrap();
    let task = journal
        .list()
        .unwrap()
        .into_iter()
        .find(|item| item.public.id == task.public.id)
        .unwrap();
    assert_eq!(task.public.stage, Stage::Completed);
    assert!(!host.project_dir(&shop).exists());
    assert_eq!(
        sql(other, "SELECT value FROM public.host_probe"),
        "untouched"
    );
    assert!(
        host.require()
            .unwrap()
            .projects
            .iter()
            .any(|p| p.name == seed)
    );
    backup::validate(&host.archive_dir().join(task.public.backup.unwrap())).unwrap();
    // Restart during creation of a previously retired name before it is published.
    let operation = Operation::Create {
        project: shop.clone(),
        domain: format!("{shop}.example.test"),
        profile: "1gb".into(),
    };
    let mut creation = accepted(&policy, operation).unwrap();
    changed(&journal, &mut creation, Stage::Provisioning).unwrap();
    nelcota_deployment::private_dir(&p.dir).unwrap();
    atomic_write(&p.path(".host-job-id"), creation.public.id.as_bytes()).unwrap();
    journal.reconcile().unwrap();
    let restarted =
        Policy::load(&policy_file).expect("pending recreation must permit worker restart");
    execute_with(&restarted, &creation.public.id, true, &effects).unwrap();
    let restarted = Policy::load(&policy_file).unwrap();
    assert!(restarted.authorized(&restarted.operators[0], &shop));
    let mut old_operator = restarted.operators[0].clone();
    old_operator.manage_host = false;
    assert!(!restarted.authorized(&old_operator, &shop));
    rt.block_on(async {
        let response = api(p)
            .await
            .get(format!("{}/auth/v1/user", url(p)))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "a recreated project must reject the former project's JWT"
        );
    });
    assert_eq!(
        sql(other, "SELECT value FROM public.host_probe"),
        "untouched"
    );
}
