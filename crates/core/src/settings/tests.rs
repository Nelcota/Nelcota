use super::*;
use crate::Secret;
use serde_json::json;

fn valid() -> Config {
    Config {
        database_url: Secret::new("postgres://u:private@localhost/db"),
        authenticator_password: Secret::new("private-password-16"),
        jwt_secret: Some(Secret::new("private-signing-key-at-least-32-bytes")),
        ..Config::default()
    }
}
fn changes(value: Value) -> BTreeMap<String, Value> {
    serde_json::from_value(value).unwrap()
}

#[test]
fn joint_edits_validate_the_full_candidate_without_mutating_the_original() {
    let current = valid();
    assert!(matches!(
        candidate(&current, &changes(json!({"request_timeout_secs": 10}))),
        Err(SettingsError::Combination)
    ));
    let next = candidate(
        &current,
        &changes(
            json!({"request_timeout_secs": 10, "statement_timeout_secs": 5,
            "signup_enabled": false, "db_pool_size": 8, "api_concurrency_per_caller": 4}),
        ),
    )
    .unwrap();
    assert_eq!(next.request_timeout_secs, 10);
    assert_eq!(next.statement_timeout_secs, 5);
    assert!(!next.signup_enabled);
    assert!(current.signup_enabled);
    assert_eq!(current.request_timeout_secs, 15);
    assert_eq!(next.jwt_secret(), current.jwt_secret());
    assert!(matches!(
        candidate(
            &Config::default(),
            &changes(json!({"signup_enabled": false}))
        ),
        Err(SettingsError::Candidate)
    ));
}

#[test]
fn catalog_is_closed_typed_bounded_and_never_projects_credentials() {
    let current = valid();
    for invalid in [
        json!({"jwt_secret": null}),
        json!({"database_url": 1}),
        json!({"production": false}),
        json!({"trust_proxy": true}),
        json!({"deployment_validation": false}),
        json!({"signup_enabled": "false"}),
        json!({"jwt_expiry_secs": 59}),
        json!({"jwt_expiry_secs": 86_401}),
        json!({"db_pool_size": 0}),
        json!({"db_pool_size": 257}),
        json!({"storage_max_file_size": -1}),
        json!({"max_body_bytes": 1.5}),
        json!({"storage_uploads_per_caller": 33}),
        json!({"storage_max_total_size": 9_007_199_254_740_992_u64}),
        json!({"db_pool_size": 2, "api_concurrency_per_caller": 3}),
        json!({}),
    ] {
        assert!(
            candidate(&current, &changes(invalid.clone())).is_err(),
            "{invalid}"
        );
    }
    let projected: BTreeMap<_, _> = CATALOG.iter().map(|d| (d.key, d.value(&current))).collect();
    assert!(
        !serde_json::to_string(&projected)
            .unwrap()
            .contains("private")
    );
    let mut keys = std::collections::HashSet::new();
    for d in CATALOG {
        assert!(keys.insert(d.key));
        d.validate(&d.default_value()).unwrap();
        for dependency in d.dependencies {
            assert!(CATALOG.iter().any(|d| &d.key == dependency));
        }
    }
}

#[test]
fn explicit_environment_matches_env_types_and_does_not_load_a_local_file() {
    let current = Config::from_environment([
        ("NELCOTA_DATABASE_URL", "postgres://u:p@localhost/db"),
        ("NELCOTA_AUTHENTICATOR_PASSWORD", "private-password-16"),
        (
            "NELCOTA_JWT_SECRET",
            "private-signing-key-at-least-32-bytes",
        ),
        ("NELCOTA_SIGNUP_ENABLED", "false"),
        ("NELCOTA_MAX_ROWS", "2000"),
        ("NELCOTA_API_CONCURRENCY_PER_CALLER", "0"),
        ("NELCOTA_SMTP_URL", ""),
        ("NELCOTA_DB_POOL_SIZE", "4"),
        ("POSTGRES_PASSWORD", "not-a-config-field"),
    ])
    .unwrap();
    current.validate().unwrap();
    assert!(!current.signup_enabled);
    assert_eq!(current.max_rows, Some(2000));
    assert_eq!(current.db_pool_size, 4);
    assert_eq!(current.api_concurrency_limit(), 0);
    assert_eq!(
        Config::from_environment([]).unwrap().database_url.expose(),
        ""
    );
    assert!(Config::from_environment([("NELCOTA_DB_POOL_SIZE", "private-bad-number")]).is_err());
}

#[test]
fn automatic_and_disabled_limits_preserve_existing_runtime_semantics() {
    let next = candidate(
        &valid(),
        &changes(json!({"max_rows": null, "api_concurrency_per_caller": null,
            "storage_max_total_size": null, "api_rate_limit_per_minute": 0,
            "statement_timeout_secs": 0, "storage_uploads_per_caller": 0})),
    )
    .unwrap();
    assert_eq!(next.max_rows, Some(1000));
    assert_eq!(next.api_concurrency_limit(), next.db_pool_size / 2);
    assert_eq!(next.storage_max_total_size, None);
    assert_eq!(next.api_rate_limit_per_minute, 0);
    assert_eq!(
        candidate(&valid(), &changes(json!({"storage_max_total_size": 0})))
            .unwrap()
            .storage_max_total_size,
        Some(0)
    );
}

#[test]
fn cors_rejects_credentials_wildcards_paths_opaque_origins_and_ambiguous_lists() {
    let current = valid();
    assert_eq!(current.cors_origins().unwrap(), None);
    for origin in [
        "*",
        "null",
        "https://user:private@app.test",
        "https://app.test/",
        "https://app.test/path",
        "https://app.test?q=private",
        "https://app.test#private",
        "data:text/plain,x",
        "https://app.test,https://other.test",
        "",
        " https://app.test ",
    ] {
        let result = candidate(&current, &changes(json!({"cors_allow_origins": [origin]})));
        assert!(result.is_err(), "{origin}");
        assert!(!result.unwrap_err().to_string().contains("private"));
    }
    assert!(
        candidate(
            &current,
            &changes(json!({"cors_allow_origins": ["https://app.test", "https://app.test"]}))
        )
        .is_err()
    );
    assert!(
        candidate(
            &current,
            &changes(json!({"cors_allow_origins": vec!["https://app.test"; 33]}))
        )
        .is_err()
    );
    for allowed in [
        json!({"cors_allow_origins": null}),
        json!({"cors_allow_origins": []}),
        json!({"cors_allow_origins": ["https://app.test", "http://localhost:5173", "https://[::1]:8443"]}),
    ] {
        candidate(&current, &changes(allowed)).unwrap();
    }
    let snapshot = serde_json::to_value(Snapshot::new(&current)).unwrap();
    assert_eq!(snapshot["schema"], 1);
    assert_eq!(snapshot["values"].as_object().unwrap().len(), CATALOG.len());
    assert!(!snapshot.to_string().contains("private"));
}
