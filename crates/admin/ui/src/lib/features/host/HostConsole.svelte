<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { CloseGuard } from '$lib/forms/close-guard.svelte'
  import UnsavedChangesDialog from '$lib/components/shared/UnsavedChangesDialog.svelte'
  import Health from '../server/Health.svelte'
  import Alerts from '../server/Alerts.svelte'
  import Settings from '../server/Settings.svelte'
  import type { Configuration } from '../server/contracts'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { t, i18n, translate } from '$lib/i18n/index.svelte'
  import { request, newKey, pollDelay, ControllerError } from '../updates/controller'
  import { dateTimeText } from '$lib/formatting/date'
  import { formatGibibytes } from '../storage/files'
  import {
    parseStatus,
    parsePlan,
    parseJob,
    parsePending,
    parseLogs,
    mergeStatus,
    terminal,
    type Status,
    type Plan,
    type Job,
    type Operation,
    type Pending,
    type LogEntry
  } from './controller'
  import type { HostArea } from './navigation'
  let { email, expired, area = $bindable<HostArea>('projects') }: { email: string; expired: () => void; area?: HostArea } = $props()
  export function selectArea(next: HostArea): void { leave(() => { area = next }) }
  export function navigationBusy(): boolean { return busy }
  let dirty = $state(false)
  let nextNavigation: (() => void) | null = null
  const guard = new CloseGuard(() => dirty, () => busy, () => { dirty = false; const next = nextNavigation; nextNavigation = null; next?.() }, () => true)
  export function leave(proceed: () => void): void { nextNavigation = proceed; guard.request() }
  let status = $state<Status | null>(null),
    plan = $state<Plan | null>(null),
    recovery = $state<Job | null>(null),
    pending = $state<Pending | null>(null)
  let name = $state(''),
    domain = $state(''),
    profile = $state('1gb'),
    selected = $state(''),
    backup = $state(''),
    service = $state<'app' | 'database'>('app')
  let confirmation = $state(''),
    password = $state(''),
    acknowledged = $state(false),
    rescue = $state(false)
  let busy = $state(false),
    offline = $state(false),
    failure = $state<string | null>(null),
    notice = $state<string | null>(null)
  let logs = $state<LogEntry[] | null>(null),
    now = $state(Math.floor(Date.now() / 1000))
  let alive = true,
    mutationEpoch = 0,
    attempts = 0,
    key = '',
    rejected = false
  let reviewForm = $state<HTMLFormElement>()
  let polling = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined,
    clock: ReturnType<typeof setInterval> | undefined
  const requests = new Set<AbortController>()
  const IDLE_POLL_MS = 8000
  const storageKey = $derived(`nelcota.host.request:${email}`)
  const active = $derived(
    (status?.busy || status?.jobs.some((j) => !terminal(j.stage))) ?? false
  )
  const project = $derived(status?.projects.find((p) => p.name === selected))
  const target = $derived(
    plan?.operation ?? recovery?.operation ?? pending?.operation ?? null
  )
  const phrase = $derived(
    recovery
      ? `RESUME ${recovery.operation.project}`
      : (plan?.confirmation ?? pending?.confirmation ?? '')
  )
  const seconds = $derived(
    plan ? Math.min(300, Math.max(0, plan.expires_at - now)) : 0
  )
  const canApprove = $derived(
    !busy &&
      !offline &&
      !!target &&
      !!password &&
      confirmation === phrase &&
      acknowledged &&
      rescue &&
      (!active || recovery !== null || pending !== null) &&
      (!plan || (seconds > 0 && plan.blockers.length === 0))
  )
  const h = (key: string) => {
    const value = translate(i18n.locale, `host.${key}`)
    if (value !== `host.${key}`) return value
    const server = translate(i18n.locale, `server.${key}`)
    return server === `server.${key}` ? value : server
  }
  const serverText = (key: string) => translate(i18n.locale, `server.${key}`)
  const size = (bytes: number) => formatGibibytes(bytes, i18n.locale)
  function reset() {
    plan = null
    recovery = null
    confirmation = ''
    password = ''
    acknowledged = false
    rescue = false
    key = ''
    rejected = false
  }
  function savePending(value: Pending | null): boolean {
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value))
      if (!value) sessionStorage.removeItem(storageKey)
      pending = value
      return true
    } catch {
      if (!value) pending = null
      failure = h(value ? 'storageFailure' : 'storageCleanupFailure')
      return false
    }
  }
  async function call(body: object) {
    const abort = new AbortController()
    requests.add(abort)
    try {
      return await request(body, abort.signal)
    } finally {
      requests.delete(abort)
    }
  }
  function schedule() {
    clearTimeout(timer)
    if (!alive) return
    const delay = pollDelay({ offline, attempts, active: active || pending !== null, idleMs: IDLE_POLL_MS })
    // A hidden tab keeps its schedule without asking the controller.
    timer = setTimeout(() => {
      if (document.hidden) { schedule(); return }
      void refresh()
    }, delay)
  }
  function refreshWhenShown() { if (!document.hidden) void refresh() }
  async function refresh() {
    if (!alive || polling || busy) {
      schedule()
      return
    }
    clearTimeout(timer)
    polling = true
    const requestedKey = pending?.key ?? null
    const revision = mutationEpoch
    try {
      const reply = await call({
        action: 'host_status',
        key: requestedKey
      })
      if (!alive || revision !== mutationEpoch) return
      status = mergeStatus(status, parseStatus(reply.data), true)
      offline = false
      attempts = 0
      if (
        pending &&
        pending.key === requestedKey &&
        (status.receipt?.request_key === pending.key ||
          status.jobs.some((j) => j.request_key === pending?.key))
      ) {
        savePending(null)
        reset()
        notice = h('submitted')
      }
      if (
        recovery &&
        status.jobs.some(
          (j) => j.id === recovery?.id && j.stage !== 'needs_attention'
        )
      ) {
        reset()
        notice = h('submitted')
      }
      if (
        pending &&
        pending.key === requestedKey &&
        rejected &&
        status.receipt === null
      ) {
        savePending(null)
        reset()
        rejected = false
        failure = h('error')
      }
      if (!selected) selected = status.projects[0]?.name ?? ''
      if (selected && !status.projects.some((p) => p.name === selected)) {
        selected = ''
        backup = ''
        logs = null
      }
    } catch (error) {
      if (!alive) return
      if (error instanceof ControllerError && error.status === 401) {
        expired()
        return
      }
      offline = true
      attempts++
    } finally {
      polling = false
      if (alive) schedule()
    }
  }
  onMount(() => {
    try {
      pending = parsePending(
        JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
      )
    } catch {
      pending = null
    }
    clock = setInterval(() => {
      now = Math.floor(Date.now() / 1000)
    }, 1000)
    void refresh()
    document.addEventListener('visibilitychange', refreshWhenShown)
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(clock)
      document.removeEventListener('visibilitychange', refreshWhenShown)
      for (const abort of requests) abort.abort()
      password = ''
    }
  })
  async function preview(operation: Operation | null, configuration?: Configuration): Promise<boolean> {
    if (busy || offline || active || pending) return false
    reset()
    failure = null
    notice = null
    busy = true
    try {
      const reply = await call(configuration ? { action: 'host_configure_plan', project: selected, configuration } : { action: 'host_plan', operation })
      if (!alive) return false
      plan = parsePlan(reply.data)
      key = newKey()
      await tick()
      if (alive) {
        reviewForm?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        reviewForm?.querySelector<HTMLElement>('h3')?.focus()
      }
      return true
    } catch (error) {
      if (!alive) return false
      const detail = error instanceof ControllerError ? serverText(error.code) : ''
      failure = detail !== '' && detail !== `server.${error instanceof ControllerError ? error.code : ''}` ? detail : h('error')
      if (error instanceof ControllerError && error.status === 401) expired()
      return false
    } finally {
      busy = false
      if (alive) schedule()
    }
  }
  async function approve(event: SubmitEvent) {
    event.preventDefault()
    if (!canApprove || !target) return
    busy = true
    failure = null
    notice = null
    rejected = false
    let body: object | null = null
    if (recovery)
      body = {
        action: 'host_recover',
        job: recovery.id,
        password,
        confirmation
      }
    if (!recovery) {
      const value: Pending | null =
        pending ??
        (plan
          ? {
              plan: plan.id,
              key,
              operation: plan.operation,
              confirmation: plan.confirmation
            }
          : null)
      if (!value || !savePending(value)) {
        busy = false
        password = ''
        return
      }
      body = {
        action: 'host_start',
        plan: value.plan,
        key: value.key,
        password,
        confirmation
      }
    }
    if (!body) {
      busy = false
      password = ''
      return
    }
    try {
      const reply = await call(body)
      if (!alive) return
      const job = parseJob(reply.data)
      mutationEpoch++
      if (status)
        status = mergeStatus(status, {
          ...status,
          jobs: [job, ...status.jobs.filter((j) => j.id !== job.id)].slice(
            0,
            32
          )
        })
      savePending(null)
      reset()
      notice = h('submitted')
    } catch (error) {
      if (!alive) return
      failure = h('uncertain')
      rejected =
        error instanceof ControllerError &&
        [
          'reauthentication_failed',
          'plan_expired',
          'plan_blocked',
          'plan_changed'
        ].includes(error.code)
      if (error instanceof ControllerError && error.status === 401) expired()
    } finally {
      busy = false
      password = ''
      if (alive) void refresh()
    }
  }
  async function readLogs() {
    if (!selected || busy || offline) return
    busy = true
    failure = null
    const name = selected,
      requestedService = service
    try {
      const reply = await call({
        action: 'host_logs',
        project: name,
        service: requestedService
      })
      if (alive && selected === name && service === requestedService)
        logs = parseLogs(reply.data)
    } catch (error) {
      if (alive && error instanceof ControllerError && error.status === 401) {
        expired()
        return
      }
      if (alive) failure = h('error')
    } finally {
      busy = false
      if (alive) schedule()
    }
  }
  async function recover(job: Job) {
    if (busy || offline || pending) return
    reset()
    recovery = job
    failure = null
    await tick()
    if (alive) {
      reviewForm?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      reviewForm?.querySelector<HTMLElement>('h3')?.focus()
    }
  }
  function label(value: string) {
    const translated = h(value)
    return translated === `host.${value}` ? h('unknown') : translated
  }
  function steps(op: Operation): string[] {
    if (op.kind === 'create')
      return [
        'accepted',
        'validating',
        'provisioning',
        'starting',
        'applying',
        'verifying',
        'completed'
      ]
    if (['configure', 'restart'].includes(op.kind)) return ['accepted', 'validating', 'applying', 'starting', 'verifying', 'completed']
    if (['test_smtp', 'test_backup', 'test_alerts'].includes(op.kind)) return ['accepted', 'validating', 'applying', 'verifying', 'completed']
    return [
      'accepted',
      'validating',
      'backing_up',
      ...(op.kind === 'backup' ? [] : ['applying']),
      'verifying',
      'completed'
    ]
  }
</script>

<svelte:window ononline={() => void refresh()} onfocus={() => void refresh()} />
<section class="grid gap-6" aria-labelledby="host-title">
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h2 id="host-title" class="text-2xl font-semibold">{serverText('title')}</h2>
      <p class="mt-2 text-sm text-muted-foreground">{serverText('description')}</p>
    </div>
    <Button
      variant="outline"
      disabled={busy || polling}
      onclick={() => void refresh()}>{h('refresh')}</Button
    >
  </header>
  {#if failure}<div
      class="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
      role="alert"
    >
      {failure}
    </div>{/if}
  {#if notice}<div
      class="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"
      role="status"
    >
      {notice}
    </div>{/if}
  {#if offline}<p class="rounded-2xl bg-well p-4 text-sm" role="status">
      {h('offline')}
    </p>{/if}
  {#if !status}<p role="status">{t('shell.app.loading')}</p>{/if}
  {#if status}
    {#if status.projects.length}<label class="grid gap-2"><span class="text-sm font-medium">{serverText('project')}</span><select class="rounded-xl border border-border bg-card p-3" value={selected} disabled={busy} onchange={event => { const value = event.currentTarget.value; event.currentTarget.value = selected; leave(() => { selected = value; backup = ''; logs = null }) }}>{#each status.projects as p}<option value={p.name}>{p.name} · {p.domain}</option>{/each}</select></label>{/if}
    <dl class="grid gap-3 sm:grid-cols-3">
      {#each [[h('count'), `${status.projects.length} / ${status.max_projects}`], [h('ram'), size(status.ram_mb * 1024 ** 2)], [h('disk'), size(status.free_bytes)]] as item}<div
          class="rounded-2xl border border-border bg-card p-5"
        >
          <dt class="text-xs text-muted-foreground">{item[0]}</dt>
          <dd class="mt-2 text-2xl font-semibold">{item[1]}</dd>
        </div>{/each}
    </dl>
    {#if status.busy}<p class="rounded-2xl bg-well p-4 text-sm" role="status">
        {h('host_busy')}
      </p>{/if}{#if !status.enabled}<p role="status">{h('readOnly')}</p>{/if}
    {#if area === 'projects'}<form
      onsubmit={(event) => {
        event.preventDefault()
        void preview({ kind: 'create', project: name, domain, profile })
      }}
      class="grid gap-4 rounded-3xl border border-border bg-card p-6"
      aria-busy={busy}
    >
      <h3 class="text-lg font-semibold">{h('create')}</h3>
      <p class="text-sm text-muted-foreground">{h('isolation')}</p>
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="grid gap-2">
          <label for="host-name">{h('name')}</label><Input
            id="host-name"
            required
            maxlength={32}
            pattern="[a-z0-9][a-z0-9-]*"
            placeholder="shop"
            bind:value={name}
            disabled={busy || active || pending !== null}
          />
        </div>
        <div class="grid gap-2">
          <label for="host-domain">{h('domain')}</label><Input
            id="host-domain"
            required
            maxlength={253}
            placeholder="api.shop.com"
            bind:value={domain}
            disabled={busy || active || pending !== null}
          />
        </div>
        <div class="grid gap-2">
          <label for="host-profile">{h('profile')}</label><select
            id="host-profile"
            class="rounded-xl border border-border bg-background p-3"
            bind:value={profile}
            disabled={busy || active || pending !== null}
            >{#each ['1gb', '2gb', '4gb', '8gb'] as value}<option {value}
                >{value}</option
              >{/each}</select
          >
        </div>
      </div>
      <p class="text-xs text-muted-foreground">{h('estimated')}</p>
      <Button
        class="w-fit"
        type="submit"
        disabled={busy ||
          offline ||
          active ||
          pending !== null ||
          !status.enabled ||
          status.projects.length >= status.max_projects}
        >{busy ? h('busy') : h('preview')}</Button
      >
    </form>
    <div class="grid gap-4 sm:grid-cols-2">
      {#each status.projects as item (item.name)}<article
          class="grid gap-4 rounded-3xl border border-border bg-card p-5"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="font-semibold" translate="no">{item.name}</h3>
              <p class="break-all text-sm text-muted-foreground" translate="no">
                {item.domain}
              </p>
            </div>
            <span class="rounded-full bg-well px-3 py-1 text-xs" translate="no"
              >{item.version ? `v${item.version}` : h('unknown')}</span
            >
          </div>
          <dl class="grid grid-cols-2 gap-3 text-sm">
            {#each [[h('app'), item.app], [h('database'), item.database]] as entry}<div
              >
                <dt class="text-xs text-muted-foreground">{entry[0]}</dt>
                <dd class="mt-1 flex items-center gap-2">
                  <span
                    class={`size-2 rounded-full ${entry[1] === 'healthy' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                    aria-hidden="true"
                  ></span>{label(entry[1])}
                </dd>
              </div>{/each}
          </dl>
          <div class="flex flex-wrap gap-2">
            <a
              class="rounded-xl border border-border px-3 py-2 text-sm"
              href={`https://${item.domain}/admin/`}
              target="_blank"
              rel="noopener noreferrer">{h('openPanel')}<span class="sr-only"> {t('common.newTab')}</span></a
            ><Button
              size="sm"
              variant="outline"
              disabled={busy || offline || active || pending !== null}
              onclick={() =>
                void preview({ kind: 'backup', project: item.name })}
              >{h('backup')}</Button
            ><Button
              size="sm"
              variant="outline"
              onclick={() => {
                selected = item.name
                backup = ''
                logs = null
              }}>{h('select')}</Button
            >
          </div>
        </article>{/each}
    </div>
    {#if !status.projects.length}<p class="rounded-2xl bg-card p-6">
        {h('noProjects')}
      </p>{/if}
    {/if}
    {#if project && area === 'alerts'}{#key project.name}<Alerts project={project.name} disabled={busy || offline || active || pending !== null || plan !== null || recovery !== null} revision={status.jobs.filter(job => terminal(job.stage)).map(job => `${job.id}:${job.sequence}`).join('|')} prepare={configuration => preview(null, configuration)} action={operation => preview(operation)} {expired} ondirty={value => { dirty = value }} navigate={leave} />{/key}{/if}
    {#if project && area === 'health'}{#key project.name}<Health project={project.name} {expired} />{/key}{/if}
    {#if project && (area === 'settings' || area === 'backups')}{#key `${project.name}:${area}`}<Settings project={project.name} domain={project.domain} backups={area === 'backups'} disabled={busy || offline || active || pending !== null || plan !== null || recovery !== null} revision={status.jobs.filter(job => terminal(job.stage)).map(job => `${job.id}:${job.sequence}`).join('|')} prepare={configuration => preview(null, configuration)} action={operation => preview(operation)} {expired} ondirty={value => { dirty = value }} navigate={leave} />{/key}{/if}
    {#if project && area === 'settings'}<div class="grid gap-3 rounded-3xl bg-card p-6"><p class="text-sm text-muted-foreground">{serverText('restartImpact')}</p><Button class="w-fit" variant="outline" disabled={busy || offline || active || pending !== null || plan !== null || recovery !== null || dirty} onclick={() => void preview({ kind: 'restart', project: project.name })}>{serverText('restart')}</Button></div>{/if}
    {#if project && (area === 'projects' || area === 'backups')}<section
        class="grid gap-4 rounded-3xl border border-border bg-card p-6"
      >
        <h3 class="text-lg font-semibold" translate="no">{project.name}</h3>
        <label for="host-backup">{h('backupFile')}</label><select
          id="host-backup"
          class="rounded-xl border border-border bg-background p-3"
          bind:value={backup}
          disabled={busy || active || pending !== null}
          ><option value="">{h('selectBackup')}</option
          >{#each project.backups as file}<option value={file}>{file}</option
            >{/each}</select
        >
        <div class="flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={!backup || busy || offline || active || pending !== null}
            onclick={() =>
              void preview({ kind: 'restore', project: project.name, backup })}
            >{h('restore')}</Button
          ><Button
            variant="destructive"
            disabled={busy || offline || active || pending !== null}
            onclick={() =>
              void preview({ kind: 'remove', project: project.name })}
            >{h('remove')}</Button
          >
        </div>
        <div class="grid gap-2">
          <label for="host-log-service">{h('logService')}</label><select
            id="host-log-service"
            class="rounded-xl border border-border bg-background p-3"
            bind:value={service}
            onchange={() => {
              logs = null
            }}
            ><option value="app">{h('app')}</option><option value="database"
              >{h('database')}</option
            ></select
          ><Button
            class="w-fit"
            variant="outline"
            disabled={busy || offline}
            onclick={() => void readLogs()}>{h('logs')}</Button
          >
        </div>
        <p class="text-xs text-muted-foreground">{h('logPrivacy')}</p>
        {#if logs}<div
            class="max-h-72 overflow-auto rounded-xl bg-well p-3 text-xs"
            role="log"
            aria-label={h('logs')}
          >
            {#if !logs.length}<p>{h('noLogs')}</p>{/if}{#each logs as line}<p
                class="break-all font-mono"
                translate="no"
              >
                {line.timestamp}
                {line.level}
                {line.target} <span translate="yes">{h('metadata')}</span>
              </p>{/each}
          </div>{/if}
      </section>{/if}
    {#if target}<form
        bind:this={reviewForm}
        onsubmit={approve}
        class={`grid gap-5 rounded-3xl border-2 bg-card p-6 ${target.kind === 'remove' || target.kind === 'restore' ? 'border-destructive/40' : 'border-primary/30'}`}
        aria-busy={busy}
      >
        <h3 tabindex="-1" class="text-xl font-semibold focus:outline-none">
          {recovery ? h('resume') : h('review')}
        </h3>
        <div class="rounded-2xl bg-well p-4">
          <p class="text-xs font-medium text-muted-foreground">
            1 · {h('select')}
          </p>
          <p class="mt-2 text-lg font-semibold" translate="no">
            {target.project}
          </p>
          {#if (plan?.affected_projects ?? recovery?.affected_projects)?.length}<p class="mt-2 text-sm">{serverText('affected')}: <span translate="no">{(plan?.affected_projects ?? recovery?.affected_projects ?? []).join(', ')}</span></p>{/if}
          {#if target.kind === 'create'}<p translate="no">
              {target.domain} · {target.profile}
            </p>{/if}{#if target.kind === 'configure'}<p>{serverText(target.section)}</p><p class="text-sm">{serverText('impact')}</p>{/if}{#if target.kind === 'restart'}<p class="text-sm">{serverText('restartImpact')}</p>{/if}{#if target.kind === 'backup_offsite'}<p class="text-sm">{serverText('offsiteImpact')}</p>{/if}{#if target.kind === 'test_smtp'}<p class="text-sm">{serverText('testImpact')}</p>{/if}{#if target.kind === 'restore'}<p
              class="break-all text-sm"
              translate="no"
            >
              {target.backup}
            </p>{/if}
        </div>
        <div class="grid gap-2 rounded-2xl bg-well p-4">
          <p class="text-xs font-medium text-muted-foreground">
            2 · {h('acknowledge')}
          </p>
          {#if target.kind === 'create'}<p class="text-sm">
              {h('isolation')}
            </p>
            <p class="text-sm">
              {h('imagePending')}
            </p>{/if}{#if target.kind === 'backup'}<p class="text-sm">
              {h('backupImpact')}
            </p>{/if}{#if target.kind === 'remove'}<p class="text-sm">
              {h('destructive')}
              {h('removeImpact')}
            </p>{/if}{#if target.kind === 'restore' && recovery?.last_stage !== 'verifying'}<p
              class="text-sm"
            >
              {h('destructive')}
              {h('restoreImpact')}
            </p>{/if}{#if recovery}<p class="text-sm">
              {target.kind === 'configure' ? serverText('configurationRecovery') : target.kind === 'restore' && recovery.last_stage === 'verifying'
                ? h('preserveWrites')
                : h('recovery')}
            </p>{/if}{#if plan}<p class="text-sm">
              {h('version')}: <strong translate="no">{plan.version}</strong>
            </p>
            <p class="break-all text-xs">
              {h('image')}:
              <span translate="no">sha256:{plan.image_digest}</span>
            </p>
            <p class="text-xs">
              {h('remaining')}: {translate(i18n.locale, 'host.secondsLeft', { count: seconds })}
            </p>{/if}
        </div>
        {#if plan && plan.blockers.length}<div
            role="alert"
            class="rounded-2xl bg-destructive/5 p-4"
          >
            <p class="font-medium">{h('blocked')}</p>
            <ul class="mt-2 list-inside list-disc text-sm">
              {#each plan.blockers as code}<li>{label(code)}</li>{/each}
            </ul>
          </div>{/if}
        {#if plan && seconds === 0}<p role="alert">
            {h('planExpired')}
          </p>{/if}{#if pending && !plan}<p role="status">
            {h('pending')} — {h('uncertain')}
          </p>{/if}
        <fieldset
          class="grid gap-4"
          disabled={busy ||
            offline ||
            (plan !== null && (plan.blockers.length > 0 || seconds === 0))}
        >
          <legend class="mb-3 text-xs font-medium text-muted-foreground"
            >3 · {h('approve')}</legend
          ><label class="flex items-start gap-3 text-sm"
            ><input
              type="checkbox"
              required
              bind:checked={acknowledged}
              class="mt-1"
            />{h('acknowledge')}</label
          ><label class="flex items-start gap-3 text-sm"
            ><input
              type="checkbox"
              required
              bind:checked={rescue}
              class="mt-1"
            />{h('rescue')}</label
          ><label for="host-confirmation">{h('typed')}</label><code
            id="host-confirmation-phrase"
            class="w-fit rounded-lg bg-well px-3 py-2"
            translate="no">{phrase}</code
          ><Input
            id="host-confirmation"
            aria-describedby="host-confirmation-phrase"
            required
            maxlength={100}
            autocomplete="off"
            bind:value={confirmation}
          /><label for="host-password">{h('password')}</label><Input
            id="host-password"
            required
            type="password"
            maxlength={1024}
            autocomplete="current-password"
            bind:value={password}
          /><Button class="w-fit" type="submit" disabled={!canApprove}
            >{busy ? h('busy') : h('approve')}</Button
          >
        </fieldset>
        {#if !pending}<Button
            class="w-fit"
            type="button"
            variant="outline"
            disabled={busy}
            onclick={reset}>{h('cancel')}</Button
          >{/if}
      </form>{/if}
    <section class="grid gap-4" aria-labelledby="host-history">
      <h3 id="host-history" class="text-lg font-semibold">{h('history')}</h3>
      {#if !status.jobs.length}<p class="text-sm text-muted-foreground">
          {h('noHistory')}
        </p>{/if}{#each status.jobs as job (job.id)}<article
          class={`grid gap-4 rounded-3xl border bg-card p-5 ${job.stage === 'completed' ? 'border-emerald-500/30' : job.stage === 'needs_attention' || job.stage === 'failed' ? 'border-amber-500/40' : 'border-border'}`}
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="font-semibold" translate="no">
              {job.operation.project}
              <span
                class="text-sm font-normal text-muted-foreground"
                translate="yes">· {h(job.operation.kind)}</span
              >
            </p>
            <span class="rounded-full bg-well px-3 py-1 text-xs" role="status"
              >{label(job.stage)}</span
            >
          </div>
          <ol class="flex flex-wrap gap-2 text-xs" aria-label={h('progress')}>
            {#each steps(job.operation) as stage, index}<li
                class={`rounded-lg px-3 py-2 ${job.stage === stage || job.stage === 'completed' ? 'bg-primary/10 text-brand' : 'bg-well text-muted-foreground'}`}
                aria-current={job.stage === stage ? 'step' : undefined}
              >
                {index + 1} · {label(stage)}
              </li>{/each}
          </ol>
          {#if job.last_stage}<p class="text-sm">
              {h('lastStage')}: {label(job.last_stage)}
            </p>{/if}{#if job.error}<p class="text-sm">
              {label(job.error)}
            </p>{/if}{#if job.backup}<p class="break-all text-xs">
              {h('backupSaved')}: <span translate="no">{job.backup}</span>
            </p>{/if}
          <details class="text-xs text-muted-foreground">
            <summary>{h('result')}</summary>
            <p class="mt-2 break-all font-mono" translate="no">{job.id}</p>
            <p>{dateTimeText(job.updated_at * 1000, i18n.locale)}</p>
          </details>
          {#if job.stage === 'needs_attention'}<p class="text-sm">
              {h('recovery')}
            </p>
            <Button
              class="w-fit"
              variant="outline"
              disabled={busy || offline || pending !== null}
              onclick={() => recover(job)}>{h('resume')}</Button
            >{/if}{#if job.stage === 'completed' && job.operation.kind === 'create'}<a
              class="w-fit text-sm underline"
              href={`https://${job.operation.domain}/admin/`}
              target="_blank"
              rel="noopener noreferrer">{h('openPanel')}<span class="sr-only"> {t('common.newTab')}</span></a
            >{/if}
        </article>{/each}
    </section>
  {/if}
</section>

<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
