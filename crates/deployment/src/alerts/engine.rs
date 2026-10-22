use super::*;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    Good,
    Bad,
    Unknown,
}
pub struct Sample {
    pub key: String,
    pub project: Option<String>,
    pub kind: Kind,
    pub severity: Severity,
    pub observation: Observation,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u64,
    sent_at: u64,
    sent_active: bool,
    attempted_active: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Incident {
    pub project: Option<String>,
    pub kind: Kind,
    pub severity: Severity,
    pub active: bool,
    pub since: u64,
    pub changed_at: u64,
    pub version: u64,
    bad: u8,
    good: u8,
    receipts: BTreeMap<Channel, Receipt>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub key: String,
    pub project: Option<String>,
    pub kind: Kind,
    pub severity: Severity,
    pub active: bool,
    pub since: u64,
    pub changed_at: u64,
    pub version: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub id: String,
    pub created_at: u64,
    pub events: Vec<Event>,
    attempts: u8,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryState {
    pub last_success_at: Option<u64>,
    pub last_error: Option<String>,
    pub next_attempt_at: u64,
    pending: Option<Batch>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Engine {
    pub schema: u8,
    pub configuration: String,
    pub last_scan_at: Option<u64>,
    pub heartbeat_accepted_at: Option<u64>,
    pub heartbeat_error: Option<String>,
    pub monitor_error: Option<String>,
    pub busy_since: Option<u64>,
    pub incidents: BTreeMap<String, Incident>,
    pub channels: BTreeMap<Channel, DeliveryState>,
}
impl Engine {
    pub fn new(configuration: String) -> Self {
        Self {
            schema: 1,
            configuration,
            last_scan_at: None,
            heartbeat_accepted_at: None,
            heartbeat_error: None,
            monitor_error: None,
            busy_since: None,
            incidents: BTreeMap::new(),
            channels: BTreeMap::new(),
        }
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            self.schema == 1
                && valid_digest(&self.configuration)
                && self.incidents.len() <= MAX_INCIDENTS
                && self.channels.len() <= 2,
            "invalid_alert_state"
        );
        for (key, item) in &self.incidents {
            ensure!(
                valid_key(key, item.project.as_deref())
                    && key.ends_with(&format!(".{}", item.kind.code()))
                    && item.receipts.values().all(|r| r.version <= item.version)
                    && item.bad <= 3
                    && item.good <= 2
                    && item.receipts.len() <= 2,
                "invalid_alert_state"
            );
        }
        ensure!(
            self.heartbeat_error
                .as_deref()
                .is_none_or(|e| e == "alert_heartbeat_failed")
                && self.monitor_error.as_deref().is_none_or(|e| matches!(
                    e,
                    "alert_probe_failed"
                        | "alert_state_unavailable"
                        | "alert_configuration_invalid"
                        | "alert_observer_unavailable"
                        | "alert_policy_changed"
                )),
            "invalid_alert_state"
        );
        for channel in self.channels.values() {
            ensure!(
                channel
                    .last_error
                    .as_deref()
                    .is_none_or(|e| e == "alert_delivery_failed"),
                "invalid_alert_state"
            );
            if let Some(batch) = &channel.pending {
                ensure!(
                    valid_digest(&batch.id)
                        && !batch.events.is_empty()
                        && batch.events.len() <= MAX_INCIDENTS,
                    "invalid_alert_state"
                );
                for event in &batch.events {
                    ensure!(
                        valid_key(&event.key, event.project.as_deref())
                            && event.key.ends_with(&format!(".{}", event.kind.code())),
                        "invalid_alert_state"
                    );
                }
            }
        }
        Ok(())
    }
    pub fn observe(&mut self, samples: Vec<Sample>, now: u64) -> anyhow::Result<()> {
        ensure!(samples.len() <= MAX_INCIDENTS, "alert_sample_limit");
        let mut keys = std::collections::BTreeSet::new();
        // Validate the whole snapshot before mutating any incident.
        for sample in &samples {
            ensure!(
                valid_key(&sample.key, sample.project.as_deref())
                    && sample.key.ends_with(&format!(".{}", sample.kind.code()))
                    && keys.insert(sample.key.clone()),
                "invalid_alert_sample"
            );
            if let Some(old) = self.incidents.get(&sample.key) {
                ensure!(
                    old.project == sample.project && old.kind == sample.kind,
                    "alert_identity_changed"
                );
            }
        }
        self.incidents.retain(|key, _| keys.contains(key));
        for s in samples {
            let item = self.incidents.entry(s.key).or_insert_with(|| Incident {
                project: s.project,
                kind: s.kind,
                severity: s.severity,
                active: false,
                since: now,
                changed_at: now,
                version: 0,
                bad: 0,
                good: 0,
                receipts: BTreeMap::new(),
            });
            let before = (item.active, item.severity);
            match s.observation {
                Observation::Unknown => {
                    item.bad = 0;
                    item.good = 0;
                }
                Observation::Bad => {
                    if item.bad == 0 && !item.active {
                        item.since = now;
                    }
                    item.bad = item.bad.saturating_add(1).min(3);
                    item.good = 0;
                    if item.bad == 3 {
                        item.active = true;
                        item.severity = s.severity;
                    }
                }
                Observation::Good => {
                    item.bad = 0;
                    item.good = item.good.saturating_add(1).min(2);
                    if item.good == 2 {
                        item.active = false;
                    }
                }
            }
            if before != (item.active, item.severity) {
                item.version = item
                    .version
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("alert_version_overflow"))?;
                item.changed_at = now;
            }
        }
        self.last_scan_at = Some(now);
        Ok(())
    }
    /// Reserve and persist this result BEFORE sending. Retry IDs survive restart.
    pub fn reserve(
        &mut self,
        channel: Channel,
        now: u64,
        reminder: u64,
        id: String,
    ) -> anyhow::Result<Option<Batch>> {
        ensure!(
            valid_digest(&id) && reminder >= 3600,
            "invalid_alert_delivery"
        );
        let state = self.channels.entry(channel).or_default();
        let events = self
            .incidents
            .iter()
            .filter_map(|(key, item)| {
                let r = item.receipts.get(&channel).cloned().unwrap_or_default();
                let changed = item.version > r.version;
                let repeat = now
                    .checked_sub(r.sent_at)
                    .is_some_and(|age| age >= reminder);
                let due = (item.active && (changed || repeat))
                    || (!item.active && changed && (r.sent_active || r.attempted_active));
                due.then(|| Event {
                    key: key.clone(),
                    project: item.project.clone(),
                    kind: item.kind,
                    severity: item.severity,
                    active: item.active,
                    since: item.since,
                    changed_at: item.changed_at,
                    version: item.version,
                })
            })
            .collect::<Vec<_>>();
        if events.is_empty() {
            state.pending = None;
            state.last_error = None;
            state.next_attempt_at = 0;
            return Ok(None);
        }
        // Backward wall-clock changes cannot stall retries for an unbounded time.
        if state.next_attempt_at > now.saturating_add(3600) {
            state.next_attempt_at = now.saturating_add(60);
        }
        if state.next_attempt_at > now {
            return Ok(None);
        }
        let mut batch = match state.pending.take() {
            Some(old) if old.events == events => old,
            _ => Batch {
                id,
                created_at: now,
                events,
                attempts: 0,
            },
        };
        batch.attempts = batch.attempts.saturating_add(1);
        for event in &batch.events {
            if let Some(item) = self.incidents.get_mut(&event.key) {
                item.receipts.entry(channel).or_default().attempted_active |= event.active;
            }
        }
        state.next_attempt_at = now.saturating_add(60);
        state.pending = Some(batch.clone());
        Ok(Some(batch))
    }
    pub fn delivered(
        &mut self,
        channel: Channel,
        batch: &Batch,
        now: u64,
        succeeded: bool,
    ) -> anyhow::Result<()> {
        let state = self
            .channels
            .get_mut(&channel)
            .ok_or_else(|| anyhow::anyhow!("alert_delivery_missing"))?;
        ensure!(
            state
                .pending
                .as_ref()
                .is_some_and(|p| p.id == batch.id && p.events == batch.events),
            "alert_delivery_changed"
        );
        if !succeeded {
            state.last_error = Some("alert_delivery_failed".into());
            state.next_attempt_at =
                now.saturating_add((60u64 << batch.attempts.saturating_sub(1).min(6)).min(3600));
            return Ok(());
        }
        for event in &batch.events {
            if let Some(item) = self.incidents.get_mut(&event.key) {
                item.receipts.insert(
                    channel,
                    Receipt {
                        version: event.version,
                        sent_at: now,
                        sent_active: event.active,
                        attempted_active: false,
                    },
                );
            }
        }
        state.last_success_at = Some(now);
        state.last_error = None;
        state.next_attempt_at = 0;
        state.pending = None;
        Ok(())
    }
    pub fn public_incidents(&self) -> Vec<IncidentView> {
        self.incidents
            .iter()
            .filter(|(_, i)| i.version > 0)
            .map(|(key, i)| IncidentView {
                key: key.clone(),
                project: i.project.clone(),
                kind: i.kind,
                severity: i.severity,
                active: i.active,
                since: i.since,
                changed_at: i.changed_at,
            })
            .collect()
    }
}

impl Batch {
    pub fn test(id: String, created_at: u64) -> anyhow::Result<Self> {
        ensure!(valid_digest(&id), "invalid_alert_delivery");
        Ok(Self {
            id,
            created_at,
            events: Vec::new(),
            attempts: 1,
        })
    }
}
