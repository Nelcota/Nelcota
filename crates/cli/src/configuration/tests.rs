use super::*;
use serde_json::json;

fn source_env() -> String {
    "# operator source\nUNRELATED=keep\nNELCOTA_DATABASE_URL=postgres://u:private@localhost/db\nNELCOTA_AUTHENTICATOR_PASSWORD=private-password-16\nNELCOTA_JWT_SECRET='private-signing-key-at-least-32-bytes'\nNELCOTA_DB_POOL_SIZE=8\nNELCOTA_SIGNUP_ENABLED=true\n".into()
}
fn changes(v: serde_json::Value) -> BTreeMap<String, Value> {
    serde_json::from_value(v).unwrap()
}
fn prepare_changes(before: &str, changes: serde_json::Value) -> anyhow::Result<Batch> {
    prepare(
        before,
        "project-identity",
        &revision(before, "project-identity"),
        self::changes(changes),
    )
}
fn runtime(before: &str) -> wire::Runtime {
    let config = load(&source(before).unwrap()).unwrap();
    serde_json::from_value(serde_json::to_value(settings::Snapshot::new(&config)).unwrap()).unwrap()
}

#[test]
fn batch_preserves_private_values_and_returns_only_allowlisted_review_values() {
    let before = source_env();
    let batch = prepare_changes(
        &before,
        json!({"signup_enabled": false, "request_timeout_secs": 8, "statement_timeout_secs": 4}),
    )
    .unwrap();
    assert!(batch.after.contains("# operator source\nUNRELATED=keep\n"));
    assert!(
        batch
            .after
            .contains("NELCOTA_JWT_SECRET='private-signing-key-at-least-32-bytes'")
    );
    let next = load(&source(&batch.after).unwrap()).unwrap();
    assert!(!next.signup_enabled);
    assert_eq!(next.request_timeout_secs, 8);
    assert_eq!(next.statement_timeout_secs, 4);
    let public = serde_json::to_string(&batch.changes).unwrap();
    assert!(!public.contains("private"));
    assert_eq!(batch.changes.len(), 3);
    assert_eq!(source_env(), before);
}

#[test]
fn stale_source_replaced_project_and_unknown_or_host_controls_fail_closed() {
    let before = source_env();
    for (text, identity) in [
        (format!("{before}# foreign edit\n"), "project-identity"),
        (before.clone(), "replacement"),
    ] {
        let error = prepare(
            &text,
            identity,
            &revision(&before, "project-identity"),
            changes(json!({"signup_enabled": false})),
        )
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "project_configuration_changed");
    }
    for input in [
        json!({"database_url": null}),
        json!({"production": false}),
        json!({"deployment_validation": false}),
        json!({"storage_backend": null}),
        json!({"admin_password_hash": 1}),
    ] {
        assert!(prepare_changes(&before, input).is_err());
    }
    assert!(
        serde_json::from_value::<BTreeMap<String, Value>>(
            json!({"signup_enabled": "false\nNELCOTA_PRODUCTION=false"})
        )
        .is_err()
    );
}

#[test]
fn ambiguous_env_file_override_and_invalid_candidate_never_leak_source_errors() {
    for extra in [
        "NELCOTA_CONFIG=/private/config.toml\n",
        "NELCOTA_DB_POOL_SIZE=4\n",
        "NELCOTA_MAX_ROWS=${PRIVATE_LIMIT}\n",
        "NELCOTA_MAX_ROWS=1000 # comment\n",
        "export NELCOTA_MAX_ROWS=1000\n",
        "NELCOTA_MAX_ROWS=private-invalid-number\n",
        "NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE=0\n",
        "NELCOTA_SMTP_URL='smtps://user:private@smtp.test'\n",
    ] {
        let before = source_env() + extra;
        let error = prepare_changes(&before, json!({"signup_enabled": false}))
            .err()
            .unwrap();
        assert!(!error.to_string().contains("private"));
        let projected = serde_json::to_string(&view(&before, "id", None).unwrap()).unwrap();
        assert!(!projected.contains("private"));
        assert!(view(&before, "id", None).unwrap().blocked.is_some());
    }
}

#[test]
fn reset_roundtrips_to_default_and_noop_changes_are_rejected() {
    let before = source_env() + "NELCOTA_MAX_ROWS=123\nNELCOTA_API_CONCURRENCY_PER_CALLER=4\n";
    let batch = prepare_changes(
        &before,
        json!({"max_rows": null, "api_concurrency_per_caller": null}),
    )
    .unwrap();
    assert!(!batch.after.contains("NELCOTA_MAX_ROWS="));
    assert!(!batch.after.contains("NELCOTA_API_CONCURRENCY_PER_CALLER="));
    let next = load(&source(&batch.after).unwrap()).unwrap();
    assert_eq!(next.max_rows, Some(1000));
    assert_eq!(next.api_concurrency_per_caller, None);
    assert!(prepare_changes(&before, json!({"signup_enabled": true})).is_err());
    assert!(prepare_changes(&source_env(), json!({"storage_max_total_size": null})).is_err());
    assert!(prepare_changes(&before, json!({})).is_err());
}

#[test]
fn projection_distinguishes_defaults_saved_runtime_and_unavailable_evidence() {
    let before = source_env();
    let runtime = runtime(&before.replace(
        "NELCOTA_SIGNUP_ENABLED=true",
        "NELCOTA_SIGNUP_ENABLED=false",
    ));
    let projection = view(&before, "id", Some(&runtime)).unwrap();
    assert!(matches!(
        projection.runtime_status,
        wire::RuntimeStatus::Effective
    ));
    let signup = projection
        .settings
        .iter()
        .find(|s| s.key == "signup_enabled")
        .unwrap();
    assert_eq!(signup.saved_value, Value::Boolean(true));
    assert_eq!(signup.runtime_value, Value::Boolean(false));
    assert_eq!(signup.pending_restart, Some(true));
    let jwt = projection
        .settings
        .iter()
        .find(|s| s.key == "jwt_expiry_secs")
        .unwrap();
    assert!(matches!(jwt.source, wire::Source::Default));
    assert_eq!(jwt.pending_restart, Some(false));
    let unavailable = view(&before, "id", None).unwrap();
    assert!(matches!(
        unavailable.runtime_status,
        wire::RuntimeStatus::Unavailable
    ));
    assert!(
        unavailable
            .settings
            .iter()
            .all(|s| s.pending_restart.is_none())
    );
    assert!(
        !serde_json::to_string(&projection)
            .unwrap()
            .contains("private")
    );
    let overridden = wire::Runtime {
        schema: 2,
        values: BTreeMap::new(),
    };
    assert!(matches!(
        view(&before, "id", Some(&overridden))
            .unwrap()
            .runtime_status,
        wire::RuntimeStatus::Invalid
    ));
}

#[test]
fn runtime_must_match_the_process_snapshot_before_and_after_applying_a_batch() {
    let before = source_env();
    let old = runtime(&before);
    verify_runtime(&before, &old).unwrap();
    let batch = prepare_changes(&before, json!({"signup_enabled": false})).unwrap();
    assert_eq!(
        verify_runtime(&batch.after, &old).unwrap_err().to_string(),
        "project_configuration_not_effective"
    );
    verify_runtime(&batch.after, &runtime(&batch.after)).unwrap();
    let mut injected = runtime(&before);
    injected.values.remove("signup_enabled");
    injected
        .values
        .insert("jwt_secret".into(), Value::Boolean(true));
    assert!(checked_runtime(&injected).is_err());
    let mut wrong_type = runtime(&before);
    wrong_type
        .values
        .insert("signup_enabled".into(), Value::Integer(1));
    assert!(checked_runtime(&wrong_type).is_err());
}

#[test]
fn automatic_limits_show_actual_values_and_pool_changes_review_derived_impact() {
    let before = source_env();
    let live = runtime(&before);
    assert_eq!(live.values["api_concurrency_per_caller"], Value::Integer(4));
    let projection = view(&before, "id", Some(&live)).unwrap();
    let concurrency = projection
        .settings
        .iter()
        .find(|d| d.key == "api_concurrency_per_caller")
        .unwrap();
    assert_eq!(concurrency.saved_value, Value::Automatic(()));
    assert_eq!(concurrency.expected_value, Value::Integer(4));
    assert_eq!(concurrency.pending_restart, Some(false));
    let batch = prepare_changes(&before, json!({"db_pool_size": 12})).unwrap();
    let derived = batch
        .changes
        .iter()
        .find(|c| c.key == "api_concurrency_per_caller")
        .unwrap();
    assert_eq!(derived.before, Value::Integer(4));
    assert_eq!(derived.after, Value::Integer(6));
    assert!(!batch.after.contains("NELCOTA_API_CONCURRENCY_PER_CALLER="));
    verify_runtime(&batch.after, &runtime(&batch.after)).unwrap();
}

#[test]
fn cors_allowlist_roundtrips_default_restricted_and_explicitly_empty_states() {
    let before = source_env();
    let restricted = prepare_changes(
        &before,
        json!({"cors_allow_origins": ["https://app.test", "http://localhost:5173"]}),
    )
    .unwrap();
    assert_eq!(
        load(&source(&restricted.after).unwrap())
            .unwrap()
            .cors_origins()
            .unwrap(),
        Some(vec![
            "https://app.test".into(),
            "http://localhost:5173".into()
        ])
    );
    verify_runtime(&restricted.after, &runtime(&restricted.after)).unwrap();
    let closed = prepare_changes(&restricted.after, json!({"cors_allow_origins": []})).unwrap();
    assert!(closed.after.contains("NELCOTA_CORS_ALLOW_ORIGINS=''"));
    assert_eq!(
        load(&source(&closed.after).unwrap())
            .unwrap()
            .cors_origins()
            .unwrap(),
        Some(vec![])
    );
    let reset = prepare_changes(&closed.after, json!({"cors_allow_origins": null})).unwrap();
    assert!(!reset.after.contains("NELCOTA_CORS_ALLOW_ORIGINS="));
    assert_eq!(
        load(&source(&reset.after).unwrap())
            .unwrap()
            .cors_origins()
            .unwrap(),
        None
    );
    let private = source_env() + "NELCOTA_CORS_ALLOW_ORIGINS='https://user:private@app.test'\n";
    assert!(
        !serde_json::to_string(&view(&private, "id", None).unwrap())
            .unwrap()
            .contains("private")
    );
}
