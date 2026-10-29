//! Accepted host task and detached supervision regressions.

use super::super::tests::{fixture, login};
use super::supervision::{mark_interrupted, reconcile_pending};
use super::*;
fn management_fixture() -> (tempfile::TempDir, Arc<State>, String) {
    let (temp, mut state, password) = fixture();
    let s = Arc::get_mut(&mut state).unwrap();
    s.policy.operators[0].manage_host = true;
    s.policy.host_management = Some(super::super::super::policy::Provisioning {
        service_hosts: Vec::new(),
        version: "0.4.0".into(),
        image_digest: token().unwrap(),
        source_sha: token().unwrap()[..40].into(),
        max_projects: 32,
        domain_suffixes: vec!["example.test".into()],
        addresses: vec!["203.0.113.7".into()],
    });
    nelcota_deployment::atomic_write(&s.policy_path, &serde_json::to_vec(&s.policy).unwrap())
        .unwrap();
    s.policy_digest = nelcota_deployment::digest_file(&s.policy_path, 65536).unwrap();
    (temp, state, password)
}
#[tokio::test]
async fn scoped_operators_cannot_create_or_inspect_host_projects() {
    let (_temp, state, password) = fixture();
    let token = login(&state, password).await;
    for request in [
        Request::HostAlerts {
            token: token.clone(),
        },
        Request::HostDiagnostics {
            token: token.clone(),
            project: "shop".into(),
        },
        Request::HostConfiguration {
            token: token.clone(),
            project: "shop".into(),
        },
        Request::HostConfigurePlan {
            token: token.clone(),
            project: "shop".into(),
            configuration: nelcota_deployment::operations::Configuration::AdminPassword {
                new_password: "never-processed-without-authority".into(),
            },
        },
        Request::HostStatus {
            token: token.clone(),
            key: None,
        },
        Request::HostPlan {
            token: token.clone(),
            operation: Operation::Remove {
                project: "shop".into(),
            },
        },
        Request::HostLogs {
            token,
            project: "shop".into(),
            service: nelcota_deployment::management::LogService::App,
        },
    ] {
        assert!(
            matches!(dispatch(&state,request).await.unwrap(),Response::Error {code} if code=="host_forbidden")
        );
    }
}
#[tokio::test]
async fn malformed_creation_and_wrong_confirmation_never_create_jobs() {
    let (_temp, state, password) = management_fixture();
    let session = login(&state, password.clone()).await;
    assert!(
        dispatch(
            &state,
            Request::HostPlan {
                token: session.clone(),
                operation: Operation::Create {
                    project: "../bad".into(),
                    domain: "api.example.test".into(),
                    profile: "1gb".into()
                }
            }
        )
        .await
        .is_err()
    );
    let plan = match dispatch(
        &state,
        Request::HostPlan {
            token: session.clone(),
            operation: Operation::Create {
                project: "shop".into(),
                domain: "shop.example.test".into(),
                profile: "1gb".into(),
            },
        },
    )
    .await
    .unwrap()
    {
        Response::HostPlan { data } => data,
        _ => panic!("plan missing"),
    };
    assert!(plan.blockers.contains(&"project_exists".into()));
    assert!(
        matches!(dispatch(&state,Request::HostStart {token:session,plan:plan.id,key:token().unwrap(),password,confirmation:"REMOVE shop".into()}).await.unwrap(),Response::Error {code} if code=="plan_blocked")
    );
    assert!(
        HostJournal::open(&state.policy.root)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn a_recreated_name_does_not_inherit_scoped_update_authority() {
    let (_temp, state, _) = management_fixture();
    let new_id = token().unwrap();
    nelcota_deployment::atomic_write(
        &state
            .policy
            .root
            .join("projects/shop/.deployment-project-id"),
        new_id.as_bytes(),
    )
    .unwrap();
    state
        .policy
        .record_identity("shop", &new_id, false)
        .unwrap();
    let mut operator = state.policy.operators[0].clone();
    operator.manage_host = false;
    assert!(!state.policy.authorized(&operator, "shop"));
}
#[tokio::test]
async fn controller_hostname_is_reserved_even_with_a_nonstandard_port() {
    let (_temp, mut state, password) = management_fixture();
    let current = Arc::get_mut(&mut state).unwrap();
    current.policy.origin = "https://control.example.test:8443".into();
    nelcota_deployment::atomic_write(
        &current.policy_path,
        &serde_json::to_vec(&current.policy).unwrap(),
    )
    .unwrap();
    current.policy_digest = nelcota_deployment::digest_file(&current.policy_path, 65536).unwrap();
    let session = login(&state, password).await;
    let response = dispatch(
        &state,
        Request::HostPlan {
            token: session,
            operation: Operation::Create {
                project: "new-app".into(),
                domain: "control.example.test".into(),
                profile: "1gb".into(),
            },
        },
    )
    .await
    .unwrap();
    let data = match response {
        Response::HostPlan { data } => data,
        _ => panic!("missing review"),
    };
    assert!(data.blockers.contains(&"domain_exists".into()));
    assert!(
        HostJournal::open(&state.policy.root)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn exit_reconciliation_waits_for_a_transient_host_lease() {
    let (_temp, state, _) = management_fixture();
    let root = &state.policy.root;
    let task = management::tests::accepted(
        &state.policy,
        Operation::Backup {
            project: "shop".into(),
        },
    )
    .unwrap();
    let lease = HostLock::acquire(root).unwrap();
    let reconciliation = mark_interrupted(root, &task.public.id);
    let release = async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(lease);
    };
    let (result, _) = tokio::join!(reconciliation, release);
    result.expect("an unrelated transient lease must not lose exit reconciliation");
    assert_eq!(
        HostJournal::open(root).unwrap().list().unwrap()[0]
            .public
            .stage,
        Stage::NeedsAttention
    );
}
#[tokio::test]
async fn startup_reconciliation_does_not_interrupt_a_newly_accepted_request() {
    let (_temp, state, _) = management_fixture();
    let root = &state.policy.root;
    let mut task = management::tests::accepted(
        &state.policy,
        Operation::Backup {
            project: "shop".into(),
        },
    )
    .unwrap();
    let ids = vec![task.public.id.clone()];
    let lease = HostLock::acquire(root).unwrap();
    let release = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let journal = HostJournal::open(root).unwrap();
        task.public.backup = Some("nelcota-shop-final.dump".into());
        journal.advance(&mut task, Stage::Verifying, None).unwrap();
        journal.advance(&mut task, Stage::Completed, None).unwrap();
        let newer = management::tests::accepted(
            &state.policy,
            Operation::Backup {
                project: "shop".into(),
            },
        )
        .unwrap();
        drop(lease);
        newer.public.id
    };
    let (result, newer) = tokio::join!(reconcile_pending(root, &ids), release);
    result.unwrap();
    assert_eq!(
        HostJournal::open(root)
            .unwrap()
            .list()
            .unwrap()
            .into_iter()
            .find(|task| task.public.id == newer)
            .unwrap()
            .public
            .stage,
        Stage::Accepted
    );
}
