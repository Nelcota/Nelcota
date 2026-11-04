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
        prepare_changes(
            &before,
            json!({"signup_enabled": "false\nNELCOTA_PRODUCTION=false"})
        )
        .is_err()
    );
}

#[test]
fn text_transport_values_do_not_bypass_the_catalogs_per_field_types() {
    let before = source_env();
    for input in [
        json!({"signup_enabled": "false"}),
        json!({"jwt_expiry_secs": "900"}),
        json!({"cors_allow_origins": "https://example.test"}),
        json!({"email_recovery_ttl_minutes": "10"}),
        json!({"email_language": false}),
        json!({"email_recovery_text_base64": true}),
        json!({"email_recovery_subject_base64": 123}),
        json!({"email_signup_text_base64": ["{{link}}"]}),
    ] {
        let error = prepare_changes(&before, input).err().unwrap();
        assert_eq!(error.to_string(), "invalid_project_setting");
    }
}

#[test]
fn email_templates_preserve_multiline_literals_and_language_derived_impact() {
    let before = source_env();
    let text = "Olá {{email}}!\nD'água, $HOME, \\ e # continuam literais.\n{{link}}\n{{validity}}";
    let batch = prepare_changes(
        &before,
        json!({
            "email_language": "pt-BR", "email_recovery_text_base64": text,
            "email_recovery_ttl_minutes": 10
        }),
    )
    .unwrap();
    assert!(!batch.after.contains("Olá"));
    assert!(batch.after.contains("NELCOTA_EMAIL_RECOVERY_TEXT_BASE64='"));
    assert_eq!(
        load(&source(&batch.after).unwrap()).unwrap().email_language,
        "pt-BR"
    );
    let config = load(&source(&batch.after).unwrap()).unwrap();
    let policy = nelcota_core::email::Settings::from_config(&config).unwrap();
    assert_eq!(policy.content(nelcota_core::email::Kind::Recovery).1, text);
    assert_eq!(policy.recovery.ttl_minutes, 10);
    assert!(
        batch
            .changes
            .iter()
            .any(|change| change.key == "email_signup_subject_base64")
    );
    verify_runtime(&batch.after, &runtime(&batch.after)).unwrap();
    assert!(verify_runtime(&before, &runtime(&batch.after)).is_err());
    let reset = prepare_changes(&batch.after, json!({"email_recovery_text_base64": null})).unwrap();
    assert!(!reset.after.contains("NELCOTA_EMAIL_RECOVERY_TEXT_BASE64="));
    let public =
        serde_json::to_string(&view(&batch.after, "id", Some(&runtime(&batch.after))).unwrap())
            .unwrap();
    assert!(!public.contains("private"));
    for input in [
        json!({"email_language": "unknown"}),
        json!({"email_recovery_subject_base64": "x\r\nBcc: private@example.test"}),
        json!({"email_recovery_text_base64": "{{secret}} {{link}}"}),
        json!({"email_recovery_text_base64": "no link"}),
        json!({"email_magiclink_ttl_minutes": 61}),
        json!({"email_signup_ttl_minutes": 0}),
    ] {
        let error = prepare_changes(&before, input).err().unwrap();
        assert!(!error.to_string().contains("private"));
    }
}

#[test]
fn combined_escaped_email_and_cors_batches_fit_the_shared_http_and_ipc_bound() {
    let label = "a".repeat(60);
    let origins = (0..32)
        .map(|n| format!("https://{label}.{label}.{label}.{label}.test:{}", 60000 + n))
        .collect::<Vec<_>>();
    let text = format!("{}{{{{link}}}}", "\n".repeat(2040));
    let input = json!({"cors_allow_origins": origins, "email_language": "pt-BR", "email_recovery_text_base64": text, "email_signup_text_base64": text, "email_magiclink_text_base64": text});
    let request = nelcota_deployment::protocol::Request::HostConfigurePlan {
        token: "a".repeat(64),
        project: "shop".into(),
        configuration: nelcota_deployment::operations::Configuration::ProjectSettings {
            expected_revision: "b".repeat(64),
            values: changes(input.clone()),
        },
    };
    let bytes = serde_json::to_vec(&request).unwrap();
    assert!(bytes.len() > 16384);
    assert!(bytes.len() <= nelcota_deployment::protocol::MAX_REQUEST_BYTES);
    let batch = prepare_changes(&source_env(), input).unwrap();
    verify_runtime(&batch.after, &runtime(&batch.after)).unwrap();
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

#[test]
fn cors_lists_above_eight_kib_roundtrip_without_loosening_secret_limits() {
    let label = "a".repeat(60);
    let origins = (0..32)
        .map(|n| format!("https://{label}.{label}.{label}.{label}.test:{}", 60000 + n))
        .collect::<Vec<_>>();
    let text = origins.join(",");
    assert!(text.len() > 8192);
    assert!(text.len() <= nelcota_core::config::MAX_CORS_ORIGIN_LIST_BYTES);
    let batch = prepare_changes(&source_env(), json!({"cors_allow_origins": origins})).unwrap();
    assert_eq!(
        load(&source(&batch.after).unwrap())
            .unwrap()
            .cors_origins()
            .unwrap(),
        Some(origins)
    );
    verify_runtime(&batch.after, &runtime(&batch.after)).unwrap();
    // An unrelated edit must accept the literal source written by this batch.
    prepare_changes(&batch.after, json!({"signup_enabled": false})).unwrap();
    assert!(
        crate::envfile::patch_literal(
            "",
            &BTreeMap::from([("NELCOTA_JWT_SECRET".into(), Some("x".repeat(8193)))])
        )
        .is_err()
    );
    assert!(
        crate::envfile::patch_literal(
            "",
            &BTreeMap::from([(
                "NELCOTA_CORS_ALLOW_ORIGINS".into(),
                Some("x".repeat(nelcota_core::config::MAX_CORS_ORIGIN_LIST_BYTES + 1))
            )])
        )
        .is_err()
    );
}
