# Operational alerts

Server 0.5.2 adds **Server → Alerts** to the separately authenticated host
controller. Install a matching CLI/controller release before activation.
No Node process, additional database, migration or background container is needed.

## Authority and activation

Use the Docker host-management enrollment from [host management](host-management.md).
Only an enrolled operator with `manage_host` may view host incidents, configure
channels or approve a delivery test. Project administrators and application
sessions cannot grant that authority. Existing update-installation gates remain
unchanged. Alert configuration changes do not restart applications or databases.

The root-owned host-management `service_hosts` grant must list the exact lowercase
DNS names of SMTP, webhook and heartbeat providers. Its default is empty;
wildcards and IP literals are unsupported. Updating that grant requires the
existing initial SSH policy procedure and worker restart. Subsequent channel and
threshold changes use the panel's review, affected-project list, typed phrase,
operator password and durable recovery workflow.

For email, select a registered project with configured mandatory-TLS SMTP and
one enrolled host-management operator as recipient. The worker reads SMTP
configuration independently of the project's application process. It pins the
project identity; removing/recreating that project requires reviewing the alert
configuration again. SMTP credential rotation is read on the next delivery.

For a webhook, supply an approved HTTPS POST URL. It is a private credential:
use the destination's unguessable path/query token, rotate it when exposed and
use an adapter if the provider expects a different JSON format. Redirects,
userinfo, fragments, private/loopback/link-local DNS answers, shared address
space (`100.64.0.0/10`) and unapproved names are refused. A configured egress proxy remains a trusted routing/DNS boundary.
Full URLs are never returned to the panel, logs or public operation receipts.
Blank inputs preserve saved URLs. Disabling an individual URL channel removes
its URL; disabling the whole monitor preserves channels for later reactivation.

Enable at least email or webhook, review and execute the configuration, then
approve **Test alert delivery**. This sends a clearly labeled test through saved
channels and optional heartbeat. Verify the inbox/webhook independently: a
successful transport response is not proof of inbox delivery. Uncertain explicit
test recovery can resend; it never changes incident confirmation state.

## Checks and confirmation

The worker schedules a scan every minute without overlapping scans or replaying
missed ticks. Three consecutive bad observations confirm an incident, two good
observations confirm recovery. An unavailable observation resets confirmation
counters but never resolves a known incident. Configuration/policy changes reset
the confirmation window and notification state; they can resend active incidents.

- Application and PostgreSQL: Docker health metadata; public HTTPS additionally
  checks TLS validation, approved host DNS and `/health` returning `status: ok`.
- Disk: alert below either 15% free or 3 GiB by default, respecting the existing
  host reserve when larger. Recovery requires five additional percentage points
  and 20% more bytes, then two good observations. This does not replace operation
  preflight reserves or automatically stop services.
- Certificate: warn within 14 days by default; recovery uses a two-day margin.
  The actual HTTPS peer's leaf certificate is checked with the host's `openssl`
  executable. Missing/unusable certificate instrumentation is an observer fault,
  not a healthy result. Expired/untrusted TLS also fails the HTTPS check.
- Backup: warn after 26 hours without recorded success; alert on a failed or
  interrupted attempt. When offsite copies are configured, their verified
  freshness must also satisfy that age. Backup freshness does not prove off-host
  restore acceptance, which remains a separate requirement.
- Monitoring: report unavailable Docker/certificate/receipt observations. While
  a host operation owns the lease, project probes remain unknown; after 15
  minutes this also becomes a monitoring fault. No routine write competes with
  the lease. Removed projects retire their incidents.

Defaults and bounded thresholds are editable in the panel. Reminders default to
24 hours, with a minimum of one hour. Active and recovered incidents, recent scan,
last transport acceptance, retry time and heartbeat status are visible there.

## Successful backup evidence

New CLI backups write a private `backups/.last-outcome.json` receipt before work
and after completion. Only complete successful capture/upload/readback/retention
advances success. Failure preserves the previous success, and interruption leaves
a running receipt recognized as failed once no host operation owns the lease.
A partial dump or file mtime never qualifies as success. Project identity changes
do not inherit previous success. Failed panel backup jobs also count as failures.
Inconsistent completion receipts are refused without replacing their contents;
they are unavailable evidence, never proof of a successful backup.

Upgrade the executable used by the daily cron job to the same reviewed release
as the controller, preserving its existing path/root. The old published CLI does
not produce these receipts. Run one successful backup after upgrading and verify
it in the panel. Existing dump/files remain usable; legacy backups alone cannot
establish current success. This change does not configure an offsite provider.

## Independent outage observer

A dead VPS, worker or network cannot report its own outage. Create a monitor
outside this VPS, using an independent notification route. Configure a one-minute
period and **at least four minutes grace**, and provide its private HTTPS POST
heartbeat URL in the panel. It must accept an empty POST and return 2xx without
redirecting. The external service, notification credentials and escalation
recipients must be configured by the operator; enabling a URL does not create
those resources.

The worker withholds heartbeat when host observation or incident delivery fails;
a local disk/state failure also prevents progress. The panel records heartbeat
acceptance, not external notification delivery. A long host operation may continue
heartbeat during its initial monitoring grace. Project incidents are sent by the
ordinary channels. In disposable staging, stop the worker past the external
monitor grace, confirm an actual missed-ping notification, restart it and confirm
recovery. Also rehearse total network failure from the observer. Do not perform
this rehearsal against production during routine setup.

## Delivery contract and persistence

Each enabled channel receives at most one incident digest per scan, bounded to
258 incidents for at most 32 projects. Sampling allows four concurrent project
probes and a 90-second stage deadline. Each send has an eight-second deadline.
Retry backoff grows from one minute to one hour and survives worker restart.
There is no unbounded queue or exactly-once guarantee.

Webhook POST includes `Content-Type: application/json` and `Idempotency-Key`
with the delivery's 64-character identifier. The body has this shape (timestamps
are Unix seconds in UTC; `test` deliveries have an empty event list):

```json
{
  "schema": 1,
  "source": "nelcota",
  "test": false,
  "controller": "https://control.example.com",
  "delivery": {
    "id": "64_LOWERCASE_HEX_CHARACTERS",
    "created_at": 1792598400,
    "events": [{
      "key": "host.disk",
      "project": null,
      "kind": "disk",
      "severity": "critical",
      "active": true,
      "since": 1792598280,
      "changed_at": 1792598400,
      "version": 1
    }]
  }
}
```

Kinds are `application`, `database`, `https`, `certificate`, `disk`, `backup_late`,
`backup_failed` and `monitoring`. Severity is `warning` or `critical`; recovery
sets `active: false`. Project keys use the enrolled project identity plus kind.
Retries of the same snapshot preserve identifier and payload. A newer snapshot
can supersede a pending one, so consumers must handle transitions and deduplicate
by delivery ID; uncertain sends can duplicate. Each channel acknowledges
independently. Emails use the same digest identity and plain text, without private destination URLs,
SQL, user records, logs, tokens or provider errors.

Settings and URLs live in root-private `host.env`; private configuration recovery
files contain before/after secrets. Configuration reads use one bounded, private,
owner-checked descriptor anchored to the trusted host directory and refuse symlinks.
Incident/cooldown state is atomically persisted
and synchronized under `updates/alerts/state.json`. Invalid state, symlinks,
foreign ownership or unsafe types fail closed; no automatic erasure or reset of
corrupt evidence occurs. The panel prioritizes a persistent-state error over a
missing-scan notice and explains that automatic sends and heartbeat are suspended.
Keep trusted ownership, inspect worker logs and preserve
state for diagnosis before explicit administrator recovery. A disabled monitor
sends nothing. Provider activation and a real external outage rehearsal are
required operational checks after installation, not results of repository tests.
