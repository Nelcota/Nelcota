use super::*;
fn sample(state: Observation) -> Sample {
    Sample {
        key: "host.disk".into(),
        project: None,
        kind: Kind::Disk,
        severity: Severity::Critical,
        observation: state,
    }
}
fn engine() -> Engine {
    Engine::new("a".repeat(64))
}
fn active(e: &mut Engine) {
    for now in 1..=3 {
        e.observe(vec![sample(Observation::Bad)], now).unwrap();
    }
}
#[test]
fn transient_failures_and_unknown_samples_cannot_open_or_resolve_incidents() {
    let mut e = engine();
    for s in [
        Observation::Bad,
        Observation::Bad,
        Observation::Unknown,
        Observation::Bad,
        Observation::Good,
    ] {
        e.observe(vec![sample(s)], 10).unwrap();
    }
    assert!(e.public_incidents().is_empty());
    active(&mut e);
    e.observe(vec![sample(Observation::Good)], 20).unwrap();
    e.observe(vec![sample(Observation::Unknown)], 21).unwrap();
    e.observe(vec![sample(Observation::Good)], 22).unwrap();
    assert!(e.public_incidents()[0].active);
    e.observe(vec![sample(Observation::Good)], 23).unwrap();
    assert!(!e.public_incidents()[0].active);
}
#[test]
fn successful_delivery_survives_restart_and_reminders_are_rate_limited() {
    let mut e = engine();
    active(&mut e);
    let batch = e
        .reserve(Channel::Email, 10, 3600, "b".repeat(64))
        .unwrap()
        .unwrap();
    assert_eq!(batch.events.len(), 1);
    e.delivered(Channel::Email, &batch, 11, true).unwrap();
    let mut e: Engine = serde_json::from_slice(&serde_json::to_vec(&e).unwrap()).unwrap();
    assert!(
        e.reserve(Channel::Email, 100, 3600, "c".repeat(64))
            .unwrap()
            .is_none()
    );
    assert!(
        e.reserve(Channel::Email, 3611, 3600, "d".repeat(64))
            .unwrap()
            .is_some()
    );
    assert!(
        e.reserve(Channel::Webhook, 100, 3600, "e".repeat(64))
            .unwrap()
            .is_some()
    );
}
#[test]
fn failed_delivery_retries_same_batch_after_persisted_backoff_and_recovery_supersedes_old_failure()
{
    let mut e = engine();
    active(&mut e);
    let b = e
        .reserve(Channel::Webhook, 10, 3600, "b".repeat(64))
        .unwrap()
        .unwrap();
    e.delivered(Channel::Webhook, &b, 11, false).unwrap();
    let mut e: Engine = serde_json::from_slice(&serde_json::to_vec(&e).unwrap()).unwrap();
    assert!(
        e.reserve(Channel::Webhook, 70, 3600, "c".repeat(64))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        e.reserve(Channel::Webhook, 71, 3600, "c".repeat(64))
            .unwrap()
            .unwrap()
            .id,
        b.id
    );
    e.observe(vec![sample(Observation::Good)], 72).unwrap();
    e.observe(vec![sample(Observation::Good)], 73).unwrap();
    let recovery = e
        .reserve(Channel::Webhook, 131, 3600, "d".repeat(64))
        .unwrap()
        .unwrap();
    assert_ne!(recovery.id, b.id);
    assert!(!recovery.events[0].active);
    e.delivered(Channel::Webhook, &recovery, 132, true).unwrap();
    assert!(
        e.reserve(Channel::Webhook, 5000, 3600, "e".repeat(64))
            .unwrap()
            .is_none()
    );
}
#[test]
fn unnotified_transient_incidents_do_not_send_spurious_recovery_and_malformed_snapshots_do_not_mutate_state()
 {
    let mut e = engine();
    active(&mut e);
    e.observe(vec![sample(Observation::Good)], 4).unwrap();
    e.observe(vec![sample(Observation::Good)], 5).unwrap();
    assert!(
        e.reserve(Channel::Email, 10, 3600, "b".repeat(64))
            .unwrap()
            .is_none()
    );
    let before = serde_json::to_vec(&e).unwrap();
    assert!(
        e.observe(
            vec![sample(Observation::Bad), sample(Observation::Good)],
            11
        )
        .is_err()
    );
    assert_eq!(serde_json::to_vec(&e).unwrap(), before);
    assert!(
        Settings {
            disk_percent: 0,
            ..Settings::default()
        }
        .validate()
        .is_err()
    );
    assert!(
        Settings {
            enabled: true,
            ..Settings::default()
        }
        .validate()
        .is_err()
    );
}
#[test]
fn disabled_email_fields_still_obey_the_panel_response_boundary() {
    for settings in [
        Settings {
            smtp_project: "x".repeat(33),
            ..Settings::default()
        },
        Settings {
            smtp_project: "../foreign".into(),
            ..Settings::default()
        },
        Settings {
            recipient: "x".repeat(255),
            ..Settings::default()
        },
        Settings {
            recipient: "operator\n@example.test".into(),
            ..Settings::default()
        },
    ] {
        assert!(!settings.email_enabled);
        assert!(settings.validate().is_err());
    }
    assert!(Settings::default().validate().is_ok());
}

#[test]
fn backwards_clock_does_not_flood() {
    let mut e = engine();
    active(&mut e);
    let b = e
        .reserve(Channel::Email, 10000, 3600, "b".repeat(64))
        .unwrap()
        .unwrap();
    e.delivered(Channel::Email, &b, 10000, false).unwrap();
    assert!(
        e.reserve(Channel::Email, 1, 3600, "c".repeat(64))
            .unwrap()
            .is_none()
    );
    assert!(
        e.reserve(Channel::Email, 60, 3600, "c".repeat(64))
            .unwrap()
            .is_none()
    );
    assert!(
        e.reserve(Channel::Email, 61, 3600, "c".repeat(64))
            .unwrap()
            .is_some()
    );
}

#[test]
fn thirty_two_project_outage_is_one_bounded_digest_per_channel() {
    let mut e = engine();
    for now in 1..=3 {
        let mut rows = vec![sample(Observation::Bad)];
        for project in 0..32 {
            for kind in [
                Kind::Application,
                Kind::Database,
                Kind::Https,
                Kind::Certificate,
                Kind::BackupLate,
                Kind::BackupFailed,
                Kind::Monitoring,
            ] {
                rows.push(Sample {
                    key: format!("{project:064x}.{}", kind.code()),
                    project: Some(format!("project-{project}")),
                    kind,
                    severity: Severity::Critical,
                    observation: Observation::Bad,
                });
            }
        }
        e.observe(rows, now).unwrap();
    }
    for (channel, id) in [(Channel::Email, "b"), (Channel::Webhook, "c")] {
        let batch = e
            .reserve(channel, 10, 3600, id.repeat(64))
            .unwrap()
            .unwrap();
        assert_eq!(batch.events.len(), 225);
        e.delivered(channel, &batch, 11, true).unwrap();
        assert!(
            e.reserve(channel, 12, 3600, "d".repeat(64))
                .unwrap()
                .is_none()
        );
    }
    e.validate().unwrap();
}

#[test]
fn persisted_incidents_reject_mismatched_kinds_and_future_delivery_acknowledgements() {
    let mut e = engine();
    active(&mut e);
    let value = serde_json::to_value(&e).unwrap();
    let mut wrong_kind = value.clone();
    wrong_kind["incidents"]["host.disk"]["kind"] = serde_json::json!("database");
    assert!(
        serde_json::from_value::<Engine>(wrong_kind)
            .unwrap()
            .validate()
            .is_err()
    );
    let batch = e
        .reserve(Channel::Email, 10, 3600, "b".repeat(64))
        .unwrap()
        .unwrap();
    e.delivered(Channel::Email, &batch, 11, true).unwrap();
    let mut future = serde_json::to_value(&e).unwrap();
    future["incidents"]["host.disk"]["receipts"]["email"]["version"] = serde_json::json!(99);
    assert!(
        serde_json::from_value::<Engine>(future)
            .unwrap()
            .validate()
            .is_err()
    );
}
