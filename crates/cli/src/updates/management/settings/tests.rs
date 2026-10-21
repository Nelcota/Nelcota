use super::view::schedule_values;
use super::*;
#[test]
fn config_patch_is_literal_preserves_unrelated_settings_and_rejects_injection() {
    let before = "# retained\nUNRELATED=keep\nSMTP=old\nSMTP=duplicate\n";
    let values = pairs(&[
        (
            "SMTP",
            "smtp://user:%24secret@example.test?tls=required".into(),
        ),
        ("HASH", "$argon2id$v=19$hash".into()),
    ]);
    let after = patch(before, &values).unwrap();
    assert_eq!(after.matches("SMTP=").count(), 1);
    assert!(after.contains("# retained\nUNRELATED=keep\n"));
    let parsed = crate::envfile::parse(&after);
    assert!(parsed.contains(&("HASH".into(), "$argon2id$v=19$hash".into())));
    for invalid in [
        "secret\nNELCOTA_IMAGE=foreign",
        "secret\rX=1",
        "a'$(touch /tmp/foreign)'",
        "back\\slash",
        "\0",
    ] {
        assert!(patch(before, &pairs(&[("SMTP", invalid.into())])).is_err());
    }
    assert_eq!(
        before,
        "# retained\nUNRELATED=keep\nSMTP=old\nSMTP=duplicate\n"
    );
}
#[test]
fn pages_and_schedules_do_not_accept_ambiguous_or_unbounded_inputs() {
    for bad in [
        "",
        "http://app.test",
        "javascript:alert(1)",
        "https://user:pass@app.test",
        "https://app.test/#token",
        "https://a.test,https://b.test",
    ] {
        assert!(page(bad, false).is_err(), "{bad}");
    }
    assert!(page("", true).is_ok());
    assert!(page("https://app.test/reset?source=auth", false).is_ok());
    assert_eq!(
        schedule_values(
            &crate::machine::backup_schedule("/usr/bin/nelcota", "/opt/nelcota", 23, 59, 30)
                .unwrap()
        ),
        Some((23, 59, 30))
    );
    for bad in [
        "",
        "@reboot root backup --all --keep 7",
        "0 24 * * * root nelcota backup --all --keep 7",
        "0 3 * * * root nelcota backup --all --keep 0",
        "0 3 * * * root nelcota backup --all --keep",
    ] {
        assert_eq!(schedule_values(bad), None);
    }
    assert!(crate::machine::backup_schedule("x", "y", 24, 0, 7).is_err());
    assert!(crate::machine::backup_schedule("x", "y", 3, 60, 7).is_err());
    assert!(crate::machine::backup_schedule("x", "y", 3, 0, 0).is_err());
}
#[test]
fn errors_expose_only_known_codes_never_raw_credentials() {
    assert_eq!(
        error_code(&anyhow::anyhow!("service_not_approved")),
        "service_not_approved"
    );
    assert_eq!(
        error_code(&anyhow::anyhow!("smtp://admin:private@example.test")),
        "operation_failed"
    );
    assert!(secret(None, None).is_err());
    assert_eq!(
        secret(Some(String::new()), Some("existing".into())).unwrap(),
        "existing"
    );
    assert_eq!(
        secret(Some("new".into()), Some("old".into())).unwrap(),
        "new"
    );
}
