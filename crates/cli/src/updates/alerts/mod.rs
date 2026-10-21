//! Operational alerts run independently of browser sessions and project processes.
use super::{management, policy::Policy};
use crate::host::Host;
use anyhow::{Context, ensure};
use nelcota_deployment::alerts::{
    Batch, CHECK_INTERVAL, Channel, ChannelView, Engine, Kind, Observation, Sample, Severity,
    Status,
};
use nelcota_deployment::management::{Operation, Stage};
use nelcota_deployment::{HostLock, read_private};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
pub(crate) mod config;
mod delivery;
mod probes;
mod store;
#[cfg(test)]
mod tests;

pub(super) struct Monitor(tokio::task::JoinHandle<()>);
impl Drop for Monitor {
    fn drop(&mut self) {
        self.0.abort();
    }
}
pub(super) fn spawn(path: PathBuf) -> Monitor {
    Monitor(tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(CHECK_INTERVAL));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            // Reload authority each cycle. Invalid/revoked policy stops all egress,
            // including heartbeat, so the independent observer can report it.
            if let Ok(policy) = Policy::load(&path)
                && policy.host_management.is_some()
                && cycle(&policy).await.is_err()
            {
                eprintln!("nelcota operational alert cycle failed; inspect Server > Alerts");
            }
        }
    }))
}
pub(crate) fn status(policy: &Policy) -> anyhow::Result<Status> {
    let cfg = config::Config::read(&Host::new(&policy.root))?;
    let revision = cfg.fingerprint(policy)?;
    let (state, error) = match store::load(policy, &revision) {
        Ok(s) => (s, None),
        Err(_) => (
            Engine::new(revision),
            Some("alert_state_unavailable".into()),
        ),
    };
    Ok(Status {
        recipients: policy
            .operators
            .iter()
            .filter(|o| o.manage_host)
            .map(|o| o.email.clone())
            .collect(),
        projects: Host::new(&policy.root)
            .require()?
            .projects
            .into_iter()
            .map(|p| p.name)
            .collect(),
        webhook_configured: cfg.webhook.is_some(),
        heartbeat_configured: cfg.heartbeat.is_some(),
        webhook_host: config::host(cfg.webhook.as_ref()),
        heartbeat_host: config::host(cfg.heartbeat.as_ref()),
        settings: cfg.settings,
        last_scan_at: state.last_scan_at,
        heartbeat_accepted_at: state.heartbeat_accepted_at,
        heartbeat_error: state.heartbeat_error.clone(),
        monitor_error: error.or(state.monitor_error.clone()),
        maintenance: state.busy_since.is_some(),
        incidents: state.public_incidents(),
        channels: state
            .channels
            .iter()
            .map(|(channel, s)| ChannelView {
                channel: *channel,
                last_success_at: s.last_success_at,
                last_error: s.last_error.clone(),
                next_attempt_at: (s.next_attempt_at > 0).then_some(s.next_attempt_at),
            })
            .collect(),
    })
}
type DeliveryFuture<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>;
trait Transport {
    fn send<'a>(
        &'a self,
        policy: &'a Policy,
        cfg: &'a config::Config,
        channel: Channel,
        batch: &'a Batch,
        test: bool,
    ) -> DeliveryFuture<'a>;
    fn heartbeat<'a>(&'a self, policy: &'a Policy, url: &'a str) -> DeliveryFuture<'a>;
}
struct Network;
impl Transport for Network {
    fn send<'a>(
        &'a self,
        p: &'a Policy,
        c: &'a config::Config,
        ch: Channel,
        b: &'a Batch,
        test: bool,
    ) -> DeliveryFuture<'a> {
        Box::pin(delivery::send(p, c, ch, b, test))
    }
    fn heartbeat<'a>(&'a self, p: &'a Policy, url: &'a str) -> DeliveryFuture<'a> {
        Box::pin(async move {
            matches!(
                tokio::time::timeout(Duration::from_secs(8), delivery::post(p, url, None, false))
                    .await,
                Ok(Ok(()))
            )
        })
    }
}
async fn flush(
    policy: &Policy,
    cfg: &config::Config,
    state: &mut Engine,
    transport: &impl Transport,
    mut clock: impl FnMut() -> anyhow::Result<u64>,
    mut persist: impl FnMut(&Engine) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    for (channel, enabled) in [
        (Channel::Email, cfg.settings.email_enabled),
        (Channel::Webhook, cfg.settings.webhook_enabled),
    ] {
        if !enabled {
            continue;
        }
        let batch = state.reserve(
            channel,
            clock()?,
            u64::from(cfg.settings.reminder_hours) * 3600,
            nelcota_deployment::token()?,
        )?;
        // Even a no-send reservation can cap a backward-clock deadline or retire
        // an obsolete failure. Save that transition before the next scan/reboot.
        persist(state)?;
        if let Some(batch) = batch {
            let ok = transport.send(policy, cfg, channel, &batch, false).await;
            state.delivered(channel, &batch, clock()?, ok)?;
            persist(state)?;
        }
    }
    // Outstanding delivery failure must not be hidden by a liveness ping.
    // A dead-man provider can then notify through its independent channels.
    if cfg.settings.heartbeat_enabled
        && state.monitor_error.is_none()
        && state.channels.values().all(|c| c.last_error.is_none())
    {
        let url = cfg
            .heartbeat
            .as_deref()
            .context("alert_endpoint_required")?;
        match transport.heartbeat(policy, url).await {
            true => {
                state.heartbeat_accepted_at = Some(clock()?);
                state.heartbeat_error = None;
            }
            false => state.heartbeat_error = Some("alert_heartbeat_failed".into()),
        }
        persist(state)?;
    }
    Ok(())
}
async fn cycle(policy: &Policy) -> anyhow::Result<()> {
    let host = Host::new(&policy.root);
    let cfg = config::Config::read(&host)?;
    if !cfg.settings.enabled {
        return Ok(());
    }
    let revision = cfg.fingerprint(policy)?;
    let mut state = store::load(policy, &revision)?;
    let now = nelcota_deployment::management::now()?;
    if state
        .last_scan_at
        .is_some_and(|at| now.checked_sub(at).is_some_and(|age| age < CHECK_INTERVAL))
    {
        return Ok(());
    }
    let lease = HostLock::acquire(&policy.root).ok();
    let mut samples = Vec::new();
    let mut targets = Vec::new();
    let mut enrolled = std::collections::BTreeSet::new();
    let disk_active = state.incidents.get("host.disk").is_some_and(|i| i.active);
    let disk = probes::disk(policy, &cfg.settings, disk_active);
    let mut observer_failed = disk.observation == Observation::Unknown;
    samples.push(disk);
    match lease.as_ref() {
        None => {
            let since = *state.busy_since.get_or_insert(now);
            observer_failed |= now.checked_sub(since).is_none_or(|age| age >= 900);
            for (key, item) in &state.incidents {
                if item.project.is_some() {
                    samples.push(Sample {
                        key: key.clone(),
                        project: item.project.clone(),
                        kind: item.kind,
                        severity: item.severity,
                        observation: Observation::Unknown,
                    });
                }
            }
        }
        Some(_) => {
            state.busy_since = None;
            let manifest = host.require()?;
            ensure!(manifest.projects.len() <= 32, "alert_project_limit");
            for p in manifest.projects {
                enrolled.insert(p.name.clone());
                match probes::target(policy, &p.name, &p.domain, now) {
                    Ok(t) => targets.push(t),
                    Err(_) => {
                        observer_failed = true;
                        for (key, item) in &state.incidents {
                            if item.project.as_deref() == Some(&p.name) {
                                samples.push(Sample {
                                    key: key.clone(),
                                    project: item.project.clone(),
                                    kind: item.kind,
                                    severity: item.severity,
                                    observation: Observation::Unknown,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    drop(lease);
    if cfg.settings.email_enabled && cfg.smtp(policy).is_err() {
        observer_failed = true;
    }
    if !targets.is_empty() {
        let container_health = probes::containers().await;
        let mut tasks = tokio::task::JoinSet::new();
        let mut pending = targets.into_iter();
        // Four bounded read probes at a time; one cycle owns all of its tasks.
        let sample_stage = async {
            loop {
                while tasks.len() < 4
                    && let Some(target) = pending.next()
                {
                    let health = container_health
                        .as_ref()
                        .map(|m| m.get(&target.project).copied().unwrap_or((false, false)));
                    let recover = state
                        .incidents
                        .get(&format!("{}.certificate", target.identity))
                        .is_some_and(|i| i.active);
                    let policy = policy.clone();
                    let settings = cfg.settings.clone();
                    tasks.spawn(async move {
                        probes::project(&policy, target, health, now, recover, &settings).await
                    });
                }
                if tasks.is_empty() {
                    break;
                }
                match tasks.join_next().await {
                    Some(Ok(rows)) => {
                        observer_failed |= rows.iter().any(|s| {
                            s.kind == Kind::Monitoring && s.observation != Observation::Good
                        });
                        samples.extend(rows);
                    }
                    Some(Err(_)) => observer_failed = true,
                    None => break,
                }
            }
        };
        if tokio::time::timeout(Duration::from_secs(90), sample_stage)
            .await
            .is_err()
        {
            tasks.shutdown().await;
            observer_failed = true;
            // Keep known incidents unresolved when a sampling deadline is hit.
            for (key, item) in &state.incidents {
                if item.project.is_some() && !samples.iter().any(|s| s.key == *key) {
                    samples.push(Sample {
                        key: key.clone(),
                        project: item.project.clone(),
                        kind: item.kind,
                        severity: item.severity,
                        observation: Observation::Unknown,
                    });
                }
            }
        }
    }
    // Failed or cancelled tasks must never erase an existing incident for a
    // still-enrolled project. Removed projects deliberately retire their keys.
    for (key, item) in &state.incidents {
        if item.project.as_ref().is_some_and(|p| enrolled.contains(p))
            && !samples.iter().any(|s| s.key == *key)
        {
            samples.push(Sample {
                key: key.clone(),
                project: item.project.clone(),
                kind: item.kind,
                severity: item.severity,
                observation: Observation::Unknown,
            });
        }
    }
    state.monitor_error = observer_failed.then(|| "alert_probe_failed".into());
    samples.push(Sample {
        key: "host.monitoring".into(),
        project: None,
        kind: Kind::Monitoring,
        severity: Severity::Critical,
        observation: match observer_failed {
            true => Observation::Bad,
            false => Observation::Good,
        },
    });
    // A reviewed setting changed while network probes ran: discard this snapshot.
    ensure!(
        config::Config::read(&host)?.fingerprint(policy)? == revision,
        "alert_configuration_changed"
    );
    state.observe(samples, now)?;
    store::save(policy, &state)?;
    flush(
        policy,
        &cfg,
        &mut state,
        &Network,
        nelcota_deployment::management::now,
        |s| store::save(policy, s),
    )
    .await
}
pub(crate) fn configured(policy: &Policy) -> anyhow::Result<bool> {
    Ok(config::Config::read(&Host::new(&policy.root))?
        .settings
        .enabled)
}
pub(crate) fn test(policy: &Policy) -> anyhow::Result<()> {
    let cfg = config::Config::read(&Host::new(&policy.root))?;
    ensure!(cfg.settings.enabled, "alerts_not_configured");
    let batch = Batch::test(
        nelcota_deployment::token()?,
        nelcota_deployment::management::now()?,
    )?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            for (channel, enabled) in [
                (Channel::Email, cfg.settings.email_enabled),
                (Channel::Webhook, cfg.settings.webhook_enabled),
            ] {
                if enabled && !Network.send(policy, &cfg, channel, &batch, true).await {
                    anyhow::bail!("alert_delivery_failed");
                }
            }
            if cfg.settings.heartbeat_enabled
                && !Network
                    .heartbeat(
                        policy,
                        cfg.heartbeat
                            .as_deref()
                            .context("alert_endpoint_required")?,
                    )
                    .await
            {
                anyhow::bail!("alert_heartbeat_failed");
            }
            Ok(())
        })
}
