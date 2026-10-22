use super::*;
use nelcota_deployment::alerts::Settings;
use std::sync::{Arc, Mutex};
struct Fake {
    sent: Arc<Mutex<Vec<String>>>,
    succeed: bool,
}
impl Transport for Fake {
    fn send<'a>(
        &'a self,
        _: &'a Policy,
        _: &'a config::Config,
        _: Channel,
        b: &'a Batch,
        _: bool,
    ) -> DeliveryFuture<'a> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(b.id.clone());
            self.succeed
        })
    }
    fn heartbeat<'a>(&'a self, _: &'a Policy, _: &'a str) -> DeliveryFuture<'a> {
        Box::pin(async move {
            self.sent.lock().unwrap().push("heartbeat".into());
            true
        })
    }
}
fn policy() -> Policy {
    serde_json::from_value(serde_json::json!({"schema":1,"root":"/owned","origin":"https://control.example.test","controller_uid":1,"controller_gid":1,"verifier":"/verified/gh","operators":[],"project_ids":{},"enable_installation":false,"validation_report":null,"minimum_free_bytes":1073741824u64,"timeout_seconds":300})).unwrap()
}
fn config() -> config::Config {
    config::Config {
        settings: Settings {
            enabled: true,
            webhook_enabled: true,
            heartbeat_enabled: true,
            ..Settings::default()
        },
        webhook: Some("https://notify.example.test/private-token".into()),
        heartbeat: Some("https://heartbeat.example.test/private-token".into()),
        smtp_identity: None,
    }
}
fn active() -> Engine {
    let mut e = Engine::new("a".repeat(64));
    for now in 1..=3 {
        e.observe(
            vec![Sample {
                key: "host.disk".into(),
                kind: Kind::Disk,
                project: None,
                severity: Severity::Critical,
                observation: Observation::Bad,
            }],
            now,
        )
        .unwrap();
    }
    e
}
#[tokio::test]
async fn persistence_failure_prevents_delivery_and_failed_delivery_withholds_heartbeat() {
    let p = policy();
    let c = config();
    let mut e = active();
    let fake = Fake {
        sent: Arc::default(),
        succeed: false,
    };
    assert!(
        flush(
            &p,
            &c,
            &mut e,
            &fake,
            || Ok(10),
            |_| anyhow::bail!("disk unavailable")
        )
        .await
        .is_err()
    );
    assert!(fake.sent.lock().unwrap().is_empty());
    let mut e = active();
    let mut saved = Vec::new();
    flush(
        &p,
        &c,
        &mut e,
        &fake,
        || Ok(11),
        |s| {
            saved.push(serde_json::to_vec(s)?);
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(fake.sent.lock().unwrap().len(), 1);
    assert!(saved.len() >= 2);
    let mut restarted: Engine = serde_json::from_slice(saved.last().unwrap()).unwrap();
    flush(&p, &c, &mut restarted, &fake, || Ok(12), |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(fake.sent.lock().unwrap().len(), 1);
    let fake = Fake {
        sent: fake.sent.clone(),
        succeed: true,
    };
    flush(&p, &c, &mut restarted, &fake, || Ok(71), |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(fake.sent.lock().unwrap().len(), 3);
    let sent = fake.sent.lock().unwrap().clone();
    assert_eq!(sent[0], sent[1]);
    assert_eq!(restarted.heartbeat_accepted_at, Some(71));
}

#[tokio::test]
async fn no_send_scan_persists_a_backward_clock_cap_so_restart_can_retry() {
    let p = policy();
    let mut c = config();
    c.settings.heartbeat_enabled = false;
    let mut e = active();
    let b = e
        .reserve(Channel::Webhook, 10000, 3600, "b".repeat(64))
        .unwrap()
        .unwrap();
    e.delivered(Channel::Webhook, &b, 10000, false).unwrap();
    let fake = Fake {
        sent: Arc::default(),
        succeed: true,
    };
    let mut saved = Vec::new();
    flush(
        &p,
        &c,
        &mut e,
        &fake,
        || Ok(1),
        |s| {
            saved.push(serde_json::to_vec(s)?);
            Ok(())
        },
    )
    .await
    .unwrap();
    assert!(fake.sent.lock().unwrap().is_empty());
    assert!(
        !saved.is_empty(),
        "no-send scheduler transition must reach disk"
    );
    let mut restarted: Engine = serde_json::from_slice(saved.last().unwrap()).unwrap();
    flush(&p, &c, &mut restarted, &fake, || Ok(61), |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(&*fake.sent.lock().unwrap(), &[b.id]);
}
#[test]
fn punctual_ticks_are_not_skipped_for_whole_second_clock_jitter() {
    assert!(scan_due(None, 100));
    // The previous scan read its clock late within its second; this tick read
    // it early within its second, so only 59 whole seconds appear to elapse.
    assert!(scan_due(Some(100), 159));
    assert!(scan_due(Some(100), 160));
    // A restarted worker still does not rescan immediately.
    assert!(!scan_due(Some(100), 100));
    assert!(!scan_due(Some(100), 130));
    // A backward clock must not stop scanning.
    assert!(scan_due(Some(100), 50));
}
