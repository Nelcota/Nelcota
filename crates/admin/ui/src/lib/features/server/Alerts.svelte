<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { i18n, translate } from '$lib/i18n/index.svelte'
  import { request, ControllerError } from '../updates/controller'
  import { integer, type Configuration } from './contracts'
  import { parseAlertStatus, type AlertSettings, type AlertStatus } from './alerts-contracts'
  import type { Operation } from '../host/controller'
  let { project, disabled, revision, prepare, action, expired, ondirty, navigate }: {
    project: string; disabled: boolean; revision: string; prepare: (configuration: Configuration) => Promise<boolean>;
    action: (operation: Operation) => Promise<boolean>; expired: () => void; ondirty: (value: boolean) => void; navigate: (proceed: () => void) => void
  } = $props()
  const a = (key: string) => translate(i18n.locale, `alerts.${key}`)
  let view = $state<AlertStatus | null>(null), loading = $state(false), failure = $state(''), dirty = $state(false), stale = $state(false)
  let enabled = $state(false), email = $state(false), webhook = $state(false), heartbeat = $state(false)
  let smtpProject = $state(''), recipient = $state(''), webhookUrl = $state(''), heartbeatUrl = $state('')
  let diskPercent = $state('15'), diskGib = $state('3'), certDays = $state('14'), backupHours = $state('26'), reminderHours = $state('24')
  let alive = true, generation = 0, saved = '', poll: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined
  const blocked = $derived(disabled || !view || (loading && view === null))
  const active = $derived(view?.incidents.filter(i => i.active) ?? [])
  const clockStale = $derived(view?.last_scan_at === null || (view && Date.now() / 1000 - (view.last_scan_at ?? 0) > 300))
  function date(value: number | null | undefined): string { if (value == null) return a('never'); return new Date(value * 1000).toLocaleString(i18n.locale) }
  function mark(value: boolean) { dirty = value; ondirty(value) }
  function populate(v: AlertStatus) {
    const s = v.settings; saved = JSON.stringify(s)
    enabled = s.enabled; email = s.email_enabled; webhook = s.webhook_enabled; heartbeat = s.heartbeat_enabled
    smtpProject = s.smtp_project !== '' ? s.smtp_project : project; recipient = s.recipient !== '' ? s.recipient : (v.recipients[0] ?? '')
    diskPercent = String(s.disk_percent); diskGib = String(s.disk_gib); certDays = String(s.certificate_days); backupHours = String(s.backup_hours); reminderHours = String(s.reminder_hours)
    webhookUrl = ''; heartbeatUrl = ''; stale = false; mark(false)
  }
  async function load(replace = false) {
    if (!alive) return
    clearTimeout(poll); abort?.abort(); abort = new AbortController(); const current = abort, id = ++generation
    const timeout = setTimeout(() => current.abort(), 20000)
    loading = true
    try {
      const reply = await request({ action: 'host_alerts' }, current.signal)
      if (!alive || id !== generation) return
      const next = parseAlertStatus(reply.data)
      if (!dirty || replace) populate(next)
      if (dirty && JSON.stringify(next.settings) !== saved) stale = true
      view = next; failure = ''
    } catch (e) { if (alive && id === generation) { if (e instanceof ControllerError && e.status === 401) { expired(); return }; failure = a('loadFailed') } }
    finally { clearTimeout(timeout); if (alive && id === generation) { loading = false; poll = setTimeout(() => { if (!document.hidden) void load(); if (document.hidden) poll = setTimeout(() => void load(), 30000) }, 30000) } }
  }
  $effect(() => { const changed = revision; untrack(() => { void load() }); void changed })
  onDestroy(() => { alive = false; generation++; clearTimeout(poll); abort?.abort(); webhookUrl = ''; heartbeatUrl = '' })
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (blocked || stale) return
    const dp = integer(diskPercent, 5, 50), dg = integer(diskGib, 1, 1024), cd = integer(certDays, 1, 60), bh = integer(backupHours, 1, 168), rh = integer(reminderHours, 1, 168)
    if (dp === null || dg === null || cd === null || bh === null || rh === null) { failure = a('invalid_alert_limits'); return }
    const settings: AlertSettings = { enabled, email_enabled: email, webhook_enabled: webhook, heartbeat_enabled: heartbeat, smtp_project: smtpProject, recipient, disk_percent: dp, disk_gib: dg, certificate_days: cd, backup_hours: bh, reminder_hours: rh }
    try { if (await prepare({ section: 'alerts', settings, webhook_url: webhookUrl === '' ? null : webhookUrl, heartbeat_url: heartbeatUrl === '' ? null : heartbeatUrl })) mark(false) }
    finally { webhookUrl = ''; heartbeatUrl = '' }
  }
</script>
<section class="grid gap-5 rounded-3xl border border-border bg-card p-6" aria-labelledby="alerts-title" aria-busy={loading && !view}>
  <div class="flex flex-wrap items-center justify-between gap-3"><h2 id="alerts-title" class="text-xl font-semibold">{a('title')}</h2><Button variant="outline" disabled={disabled || loading} onclick={() => navigate(() => { mark(false); void load(true) })}>{a('reload')}</Button></div>
  <p class="text-sm text-muted-foreground">{a('description')}</p>
  {#if failure}<p role="alert" class="text-sm text-destructive">{failure}</p>{/if}
  {#if stale}<p role="alert" class="text-sm text-amber-700 dark:text-amber-400">{a('staleForm')}</p>{/if}
  {#if !view}<p role="status">{a('loading')}</p>{/if}
  {#if view}
    <div class="grid gap-3 rounded-2xl bg-well p-4" role="status">
      <p class="font-medium">{view.settings.enabled ? clockStale ? a('observerStale') : view.maintenance ? a('maintenance') : view.monitor_error ? a('observerFailed') : active.length > 0 ? `${active.length} · ${a('active')}` : a('noConfirmed') : a('disabled')}</p>
      <p class="text-sm">{a('lastScan')}: {date(view.last_scan_at)}</p>
      <p class="text-sm">{a('heartbeatAccepted')}: {date(view.heartbeat_accepted_at)}</p>
      {#if view.heartbeat_error}<p class="text-sm text-destructive">{a('alert_heartbeat_failed')}</p>{/if}
      {#each view.channels as channel}<p class="text-sm">{a(channel.channel)} · {a('lastDelivery')}: {date(channel.last_success_at)}{#if channel.last_error}<span class="text-destructive"> · {a('alert_delivery_failed')} · {a('retry')}: {date(channel.next_attempt_at)}</span>{/if}</p>{/each}
    </div>
    <div class="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm"><p class="font-medium">{a('externalTitle')}</p><p class="mt-2">{a('externalRequired')}</p><p class="mt-2">{a('externalSetup')}</p></div>
    {#if view.incidents.length}<ul class="grid gap-2" aria-label={a('incidents')}>{#each view.incidents as item}<li class={`grid gap-1 break-words rounded-xl border p-4 ${item.active ? 'border-amber-500/40' : 'border-border'}`}><p class="font-medium">{item.project ?? a('host')} · {a(item.kind)}</p><p class="text-sm">{item.active ? a(item.severity) : a('recovered')} · {a('changed')}: {date(item.changed_at)}</p></li>{/each}</ul>{/if}
  {/if}
  <form class="grid gap-4" onsubmit={submit} oninput={() => mark(true)}>
    <label class="flex items-center gap-3"><input type="checkbox" bind:checked={enabled} disabled={blocked} />{a('enable')}</label>
    <p class="text-sm text-muted-foreground">{a('scope')}</p>
    <fieldset class="grid gap-3 rounded-2xl border border-border p-4" disabled={blocked || !enabled}><legend class="px-2">{a('email')}</legend>
      <label class="flex items-center gap-3"><input type="checkbox" bind:checked={email} />{a('emailEnable')}</label>
      <label class="grid gap-2"><span>{a('smtpProject')}</span><select class="rounded-xl border border-border bg-background p-3" bind:value={smtpProject} disabled={!email} required={email}><option value="">{a('select')}</option>{#each view?.projects ?? [] as name}<option value={name}>{name}</option>{/each}</select></label>
      <label class="grid gap-2"><span>{a('recipient')}</span><select class="rounded-xl border border-border bg-background p-3" bind:value={recipient} disabled={!email} required={email}><option value="">{a('select')}</option>{#each view?.recipients ?? [] as address}<option value={address}>{address}</option>{/each}</select></label>
      <p class="text-sm text-muted-foreground">{a('smtpNotice')}</p>
    </fieldset>
    <fieldset class="grid gap-3 rounded-2xl border border-border p-4" disabled={blocked || !enabled}><legend class="px-2">{a('webhook')}</legend>
      <label class="flex items-center gap-3"><input type="checkbox" bind:checked={webhook} />{a('webhookEnable')}</label>
      <label class="grid gap-2"><span>{a('webhookUrl')}</span><Input type="password" autocomplete="new-password" maxlength={2048} bind:value={webhookUrl} disabled={!webhook} /></label>
      <p class="break-all text-sm text-muted-foreground">{a('currentHost')}: {view?.webhook_host ?? a('notConfigured')}. {a('privateUrls')}</p><p class="text-sm text-muted-foreground">{a('webhookNotice')}</p>
    </fieldset>
    <fieldset class="grid gap-3 rounded-2xl border border-border p-4" disabled={blocked || !enabled}><legend class="px-2">{a('heartbeat')}</legend>
      <label class="flex items-center gap-3"><input type="checkbox" bind:checked={heartbeat} />{a('heartbeatEnable')}</label>
      <label class="grid gap-2"><span>{a('heartbeatUrl')}</span><Input type="password" autocomplete="new-password" maxlength={2048} bind:value={heartbeatUrl} disabled={!heartbeat} /></label>
      <p class="break-all text-sm text-muted-foreground">{a('currentHost')}: {view?.heartbeat_host ?? a('notConfigured')}. {a('privateUrls')}</p>
    </fieldset>
    <div class="grid gap-4 sm:grid-cols-2">
      {#each [['diskPercent', a('diskPercent'), 5, 50], ['diskGib', a('diskGib'), 1, 1024], ['certDays', a('certDays'), 1, 60], ['backupHours', a('backupHours'), 1, 168], ['reminderHours', a('reminderHours'), 1, 168]] as [key, label, min, max]}
        <label class="grid gap-2"><span>{label}</span><Input type="number" min={min} max={max} step={1} value={key === 'diskPercent' ? diskPercent : key === 'diskGib' ? diskGib : key === 'certDays' ? certDays : key === 'backupHours' ? backupHours : reminderHours} oninput={event => { const value = event.currentTarget.value; switch (key) { case 'diskPercent': diskPercent = value; break; case 'diskGib': diskGib = value; break; case 'certDays': certDays = value; break; case 'backupHours': backupHours = value; break; default: reminderHours = value } }} disabled={blocked} required /></label>
      {/each}
    </div>
    <p class="text-sm text-muted-foreground">{a('confirmationPolicy')}</p>
    <div class="flex flex-wrap gap-3"><Button type="submit" disabled={blocked || stale}>{a('preview')}</Button><Button type="button" variant="outline" disabled={blocked || dirty || stale || !view?.settings.enabled} onclick={() => void action({ kind: 'test_alerts', project })}>{a('test')}</Button></div>
    <p class="text-sm text-muted-foreground">{a('testNotice')}</p>
  </form>
</section>
