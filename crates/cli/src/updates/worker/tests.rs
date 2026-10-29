//! Worker authentication, policy freshness and IPC ownership regressions.
use super::State;
use super::session_key;
use crate::updates::policy::Policy;
use nelcota_deployment::Journal;
use nelcota_deployment::protocol::Request;
use nelcota_deployment::protocol::Response;
use nelcota_deployment::token;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Semaphore;

use super::*;
pub(super) fn fixture() -> (tempfile::TempDir, Arc<State>, String) {
    let temporary = match std::env::var_os("NELCOTA_IPC_FIXTURE_BASE") {
        Some(base) => tempfile::tempdir_in(base).unwrap(),
        None => tempfile::tempdir().unwrap(),
    };
    let root = temporary.path().to_path_buf();
    let host = crate::host::Host::new(&root);
    nelcota_deployment::atomic_write(&root.join("host.env"), b"# private host fixture\n").unwrap();
    let manifest = crate::host::Manifest {
        version: 1,
        panel_login: crate::host::PanelLogin::Shared,
        base_domain: None,
        local: false,
        runtime: crate::host::Runtime::Docker,
        image: "ghcr.io/nelcota/nelcota-server".into(),
        projects: ["shop", "blog"]
            .into_iter()
            .map(|name| crate::host::ProjectEntry {
                name: name.into(),
                domain: format!("{name}.example.test"),
            })
            .collect(),
    };
    host.save(&manifest).unwrap();
    for project in host.projects(&manifest) {
        std::fs::create_dir_all(project.path("")).unwrap();
        project.env().set("NELCOTA_VERSION", "0.4.0").unwrap();
    }
    let password = token().unwrap();
    let operator = super::super::policy::Operator {
        manage_host: false,
        email: "operator@example.test".into(),
        password_hash: nelcota_auth::hash_password(&password).unwrap(),
        projects: vec!["shop".into()],
    };
    let id = token().unwrap();
    nelcota_deployment::atomic_write(
        &root.join("projects/shop/.deployment-project-id"),
        id.as_bytes(),
    )
    .unwrap();
    let policy = Policy {
        host_management: None,
        schema: 1,
        root: root.clone(),
        origin: "https://updates.example.test".into(),
        controller_uid: 1000,
        controller_gid: 1000,
        verifier: "/invalid/gh".into(),
        operators: vec![operator],
        project_ids: std::collections::BTreeMap::from([("shop".into(), id)]),
        enable_installation: false,
        validation_report: None,
        minimum_free_bytes: 1 << 30,
        timeout_seconds: 60,
    };
    let path = root.join("policy.json");
    nelcota_deployment::atomic_write(&path, &serde_json::to_vec(&policy).unwrap()).unwrap();
    let state = Arc::new(State {
        host_reads: Arc::new(Semaphore::new(1)),
        host_plans: Mutex::default(),
        policy,
        policy_path: path.clone(),
        policy_digest: nelcota_deployment::digest_file(&path, 65536).unwrap(),
        passwords: nelcota_auth::Passwords::new(1),
        sessions: Mutex::default(),
        plans: Mutex::default(),
        cache: Mutex::default(),
        checks: Arc::new(Semaphore::new(1)),
        preflights: Arc::new(Semaphore::new(1)),
        logins: Mutex::default(),
    });
    (temporary, state, password)
}
pub(super) async fn login(state: &Arc<State>, password: String) -> String {
    match dispatch(
        state,
        Request::Login {
            email: "operator@example.test".into(),
            password,
        },
    )
    .await
    .unwrap()
    {
        Response::Session { token, .. } => token,
        _ => panic!("operator login failed"),
    }
}
#[tokio::test]
async fn operator_is_scoped_even_when_project_sso_covers_the_host() {
    let (_temporary, state, password) = fixture();
    let session = login(&state, password).await;
    let journal = Journal::open(&state.policy.root).unwrap();
    journal
        .begin(
            "blog",
            "0.4.0",
            "0.5.0",
            "another",
            &token().unwrap(),
            &token().unwrap(),
        )
        .unwrap();
    let status = state.status(state.operator(&session).unwrap()).unwrap();
    assert_eq!(status.projects.len(), 1);
    assert_eq!(status.projects[0].name, "shop");
    assert!(status.jobs.is_empty());
    assert!(
        matches!(dispatch(&state,Request::Plan{token:session.clone(),project:"blog".into()}).await.unwrap(),Response::Error{code} if code=="project_forbidden")
    );
    assert!(state.operator("service_role.jwt").is_err());
    assert!(state.operator(&token().unwrap()).is_err());
    dispatch(
        &state,
        Request::Logout {
            token: session.clone(),
        },
    )
    .await
    .unwrap();
    assert!(state.operator(&session).is_err());
}
#[tokio::test]
async fn a_session_cannot_start_or_recover_without_fresh_password_confirmation() {
    let (_temporary, state, password) = fixture();
    let session = login(&state, password).await;
    let result = dispatch(
        &state,
        Request::Start {
            token: session.clone(),
            plan: token().unwrap(),
            key: token().unwrap(),
            password: token().unwrap(),
        },
    )
    .await
    .unwrap();
    assert!(matches!(result,Response::Error{code} if code=="reauthentication_failed"));
    let result = dispatch(
        &state,
        Request::Recover {
            token: session,
            job: token().unwrap(),
            password: token().unwrap(),
        },
    )
    .await
    .unwrap();
    assert!(matches!(result,Response::Error{code} if code=="reauthentication_failed"));
    assert!(
        Journal::open(&state.policy.root)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn policy_revocation_and_session_expiry_fail_closed() {
    let (_temporary, state, password) = fixture();
    let session = login(&state, password).await;
    state
        .sessions
        .lock()
        .unwrap()
        .get_mut(&session_key(&session))
        .unwrap()
        .expires = Instant::now() - Duration::from_secs(1);
    assert!(state.operator(&session).is_err());
    nelcota_deployment::atomic_write(&state.policy_path, b"{}").unwrap();
    assert!(
        matches!(dispatch(&state,Request::Status{token:session}).await.unwrap(),Response::Error{code} if code=="policy_changed")
    );
}
#[test]
fn clients_cannot_add_paths_shell_commands_or_host_authority_to_ipc() {
    for value in [
        r#"{"action":"start","token":"x","plan":"x","key":"x","password":"x","command":"rm"}"#,
        r#"{"action":"plan","token":"x","project":"shop","root":"/"}"#,
        r#"{"action":"execute","job":"x"}"#,
    ] {
        assert!(serde_json::from_str::<Request>(value).is_err());
    }
}
#[test]
fn real_worker_transport_enforces_uid_and_operator_scope() {
    const TEST: &str =
        "updates::worker::tests::real_worker_transport_enforces_uid_and_operator_scope";
    let mode = std::env::var("NELCOTA_IPC_TEST_MODE").unwrap_or_default();
    if mode.is_empty() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.tools/reports/updates/ipc-fixtures");
        std::fs::create_dir_all(&directory).unwrap();
        let temporary = tempfile::tempdir_in(directory).unwrap();
        let executable = temporary.path().join("fixture-test");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let status = std::process::Command::new("docker")
            .args([
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--memory",
                "512m",
                "--pids-limit",
                "64",
                "--cap-drop",
                "ALL",
                "--cap-add",
                "CHOWN",
                "--cap-add",
                "SETUID",
                "--cap-add",
                "SETGID",
                "--tmpfs",
                "/fixture:rw,mode=0755",
                "--tmpfs",
                "/run:rw,mode=0755",
                "-e",
                "NELCOTA_IPC_TEST_MODE=worker",
                "-e",
                "NELCOTA_IPC_FIXTURE_BASE=/fixture",
                "-v",
            ])
            .arg(format!("{}:/fixture-test:ro", executable.display()))
            .args([
                "debian:trixie-slim",
                "/fixture-test",
                "--exact",
                TEST,
                "--nocapture",
            ])
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let socket = PathBuf::from(super::super::WORKER_SOCKET);
    if mode == "rogue" {
        assert!(
            nelcota_deployment::protocol::call(
                &socket,
                &Request::Login {
                    email: "operator@example.test".into(),
                    password: std::env::var("NELCOTA_IPC_TEST_PASSWORD").unwrap()
                }
            )
            .is_err()
        );
        return;
    }
    if mode == "client" {
        let password = std::env::var("NELCOTA_IPC_TEST_PASSWORD").unwrap();
        let value = match nelcota_deployment::protocol::call(
            &socket,
            &Request::Login {
                email: "operator@example.test".into(),
                password: password.clone(),
            },
        )
        .unwrap()
        {
            Response::Session { token, .. } => token,
            _ => panic!("IPC login rejected"),
        };
        match nelcota_deployment::protocol::call(
            &socket,
            &Request::Status {
                token: value.clone(),
            },
        )
        .unwrap()
        {
            Response::Status { data } => {
                assert_eq!(data.projects.len(), 1);
                assert_eq!(data.projects[0].name, "shop");
                assert!(!data.enabled);
                assert!(data.jobs.is_empty());
            }
            _ => panic!("IPC status rejected"),
        }
        assert!(
            matches!(nelcota_deployment::protocol::call(&socket,&Request::Plan{token:value.clone(),project:"blog".into()}).unwrap(),Response::Error{code} if code=="project_forbidden")
        );
        assert!(
            matches!(nelcota_deployment::protocol::call(&socket,&Request::Start{token:value,plan:token().unwrap(),key:token().unwrap(),password}).unwrap(),Response::Error{code} if code=="installation_not_validated")
        );
        return;
    }
    assert_eq!(mode, "worker");
    let (_temporary, state, password) = fixture();
    let host = crate::host::Host::new(&state.policy.root);
    std::fs::create_dir_all(host.shared_dir()).unwrap();
    std::fs::create_dir_all(host.caddy_dir().join("config")).unwrap();
    std::fs::write(host.caddy_dir().join("docker-compose.yml"), b"fixture").unwrap();
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    assert!(
        std::process::Command::new("chown")
            .arg("0:1000")
            .arg(socket.parent().unwrap())
            .status()
            .unwrap()
            .success()
    );
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        socket.parent().unwrap(),
        std::fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let path = state.policy_path.clone();
        let worker = tokio::spawn(async move { run(path).await.unwrap() });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !socket.exists() {
            assert!(!worker.is_finished());
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        for (mode, uid) in [("rogue", 1001), ("client", 1000)] {
            let password = password.clone();
            let result = tokio::task::spawn_blocking(move || {
                use std::os::unix::process::CommandExt;
                std::process::Command::new("/fixture-test")
                    .args(["--exact", TEST, "--nocapture"])
                    .env("NELCOTA_IPC_TEST_MODE", mode)
                    .env("NELCOTA_IPC_TEST_PASSWORD", password)
                    .uid(uid)
                    .gid(1000)
                    .status()
                    .unwrap()
            })
            .await
            .unwrap();
            assert!(result.success());
        }
        worker.abort();
        let _ = worker.await;
    });
    assert!(
        Journal::open(&state.policy.root)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}
