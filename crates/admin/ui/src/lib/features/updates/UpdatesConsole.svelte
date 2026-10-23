<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import Logo from '$lib/shell/components/Logo.svelte'
  import HostConsole from '../host/HostConsole.svelte'
  let view = $state<'projects' | 'updates'>('projects')
  let hostConsole = $state<HostConsole>()
  import { t, translate, i18n, setLocale } from '$lib/i18n/index.svelte'
  import { ControllerError, request, parseStatus, parsePlan, parseJob, mergeStatus, newKey, message, terminal, type Status, type Plan, type Job } from './controller'
  let status = $state<Status | null>(null)
  let signedOut = $state(false)
  let email = $state('')
  let password = $state('')
  let approval = $state('')
  let project = $state('')
  let plan = $state<Plan | null>(null)
  let recover = $state<Job | null>(null)
  let failure = $state<string | null>(null)
  let offline = $state(false)
  let busy = $state(false)
  let key = ''
  let alive = true
  let generation = 0
  let polling: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  const requests = new Set<AbortController>()
  const active = $derived((status?.host_busy || status?.jobs.some(job => !terminal(job.phase))) ?? false)
  const selected = $derived(status?.projects.find(item => item.name === project))
  function clearApproval() { plan = null; recover = null; approval = ''; key = '' }
  async function call(body?: object) {
    const abort = new AbortController(); requests.add(abort)
    const timeout = setTimeout(() => abort.abort(), 20000)
    try { return await request(body, abort.signal) } finally { clearTimeout(timeout); requests.delete(abort) }
  }
  function schedule() {
    clearTimeout(timer)
    if (!alive || signedOut || document.hidden) return
    const delay = offline ? Math.min(30000, 2000 * 2 ** Math.min(attempts, 4)) : active || status?.checking ? 2000 : 10000
    timer = setTimeout(() => void refresh(), delay)
  }
  async function refresh() {
    if (!alive || document.hidden || polling === generation) return
    clearTimeout(timer); polling = generation
    const revision = generation
    try {
      const reply = await call()
      if (!alive || revision !== generation) return
      status = mergeStatus(status, parseStatus(reply.data)); signedOut = false; offline = false; attempts = 0
      if (!status.projects.some(item => item.name === project)) { project = status.projects[0]?.name ?? ''; clearApproval() }
    } catch (error) {
      if (!alive || revision !== generation) return
      if (error instanceof ControllerError && error.status === 401) { signedOut = true; status = null; clearApproval(); return }
      offline = true; attempts++
    } finally { if (polling === revision) polling = null; if (alive && revision === generation) schedule() }
  }
  onMount(() => { void refresh(); return () => { alive = false; generation++; clearTimeout(timer); for (const abort of requests) abort.abort() } })
  async function login(event: SubmitEvent) {
    event.preventDefault()
    if (busy || !email.trim() || !password) return
    busy = true; failure = null
    try { await call({ action: 'login', email: email.trim(), password }); if (!alive) return; generation++; clearTimeout(timer); for (const abort of requests) abort.abort(); signedOut = false; await refresh() }
    catch (error) { if (alive) failure = error instanceof ControllerError ? message(error.code) : t('updates.reconnect') }
    finally { password = ''; busy = false }
  }
  async function act(body: object, apply: (reply: Record<string, unknown>) => void) {
    if (busy || offline) return
    busy = true; failure = null
    const revision = generation
    try { const reply = await call(body); if (alive && revision === generation) apply(reply) }
    catch (error) { if (alive && revision === generation) failure = error instanceof ControllerError ? message(error.code) : t('updates.reconnect') }
    finally { busy = false; approval = ''; if (alive && revision === generation) void refresh() }
  }
  function prepare() { clearApproval(); void act({ action: 'plan', project }, reply => { plan = parsePlan(reply.data); key = newKey() }) }
  function accepted(reply: Record<string, unknown>) { const job = parseJob(reply.data); if (status) status = mergeStatus(status, { ...status, jobs: [job, ...status.jobs.filter(entry => entry.id !== job.id)].slice(0, 32) }); clearApproval() }
  function approve(event: SubmitEvent) {
    event.preventDefault()
    if (!approval || busy || offline) return
    if (recover) { void act({ action: 'recover', job: recover.id, password: approval }, accepted); return }
    if (!plan || plan.blockers.length || !status?.enabled) return
    void act({ action: 'start', plan: plan.id, key, password: approval }, accepted)
  }
  async function logout() {
    if (busy) return
    busy = true
    try { await call({ action: 'logout' }); generation++; status = null; signedOut = true; clearApproval(); clearTimeout(timer); for (const abort of requests) abort.abort() }
    catch { failure = t('updates.reconnect') }
    finally { busy = false }
  }
  function blocker(code: string) { const value = translate(i18n.locale, `updates.${code}`); return value === `updates.${code}` ? t('updates.blocked') : value }
  const progress: Record<string, number> = { preparing: 0, pausing: 1, capturing: 2, backup_verified: 3, activating: 4, validating: 5, committing: 6, succeeded: 7 }
</script>
<svelte:document onvisibilitychange={() => { clearTimeout(timer); if (!document.hidden && !signedOut) void refresh() }} />
<svelte:window ononline={() => void refresh()} onfocus={() => { if (!signedOut) void refresh() }} />
<main class="min-h-dvh bg-background px-4 py-6 sm:px-8">
  <div class="mx-auto grid w-full max-w-4xl gap-6">
    <header class="flex flex-wrap items-center justify-between gap-3"><Logo /><div class="flex items-center gap-2"><Button variant="ghost" onclick={() => setLocale(i18n.locale === 'pt-BR' ? 'en' : 'pt-BR')}>{i18n.locale === 'pt-BR' ? 'English' : 'Português'}</Button>{#if status}<Button variant="outline" disabled={busy} onclick={() => { if (hostConsole) { hostConsole.leave(() => { void logout() }); return }; void logout() }}>{t('shell.account.signOut')}</Button>{/if}</div></header>
    <div class="grid gap-2"><h1 class="text-2xl font-semibold">{t('updates.controller')}</h1><p class="text-sm text-muted-foreground">{t('updates.authority')}</p></div>
    {#if failure}<p class="rounded-2xl bg-card p-4 text-sm text-destructive" role="alert">{failure}</p>{/if}
    {#if offline}<div role="status" class="flex flex-wrap items-center gap-3 rounded-2xl bg-card p-4"><p>{t('updates.reconnect')}</p><Button variant="outline" onclick={() => void refresh()}>{t('updates.retry')}</Button></div>{/if}
    {#if !status && !signedOut && !offline}<p role="status">{t('shell.app.loading')}</p>{/if}
    {#if signedOut}
      <form onsubmit={login} class="grid max-w-md gap-4 rounded-3xl bg-card p-6" aria-busy={busy}>
        <label for="operator-email">{t('login.email')}</label><Input id="operator-email" type="email" autocomplete="username" required maxlength={254} bind:value={email} disabled={busy} />
        <label for="operator-password">{t('login.password')}</label><Input id="operator-password" type="password" autocomplete="current-password" required maxlength={1024} bind:value={password} disabled={busy} />
        <Button type="submit" disabled={busy}>{busy ? t('updates.working') : t('login.signIn')}</Button>
      </form>
    {/if}
    {#if status}
      <p class="text-sm text-muted-foreground">{t('updates.session', { email: status.email })}</p>
      <nav class="flex gap-2" aria-label={t('updates.controller')}>{#if status.host_management}<Button variant={view === 'projects' ? 'default' : 'outline'} onclick={() => { view = 'projects' }}>{t('server.title')}</Button>{/if}<Button variant={view === 'updates' ? 'default' : 'outline'} onclick={() => { if (hostConsole) { hostConsole.leave(() => { view = 'updates' }); return }; view = 'updates' }}>{t('host.updates')}</Button></nav>
      {#if status.host_management && view === 'projects'}{#key status.email}<HostConsole bind:this={hostConsole} email={status.email} expired={() => { generation++; signedOut = true; status = null; clearApproval(); clearTimeout(timer); for (const abort of requests) abort.abort() }} />{/key}{/if}
      {#if !status.host_management || view === 'updates'}
      <section class="grid gap-4 rounded-3xl bg-card p-6" aria-labelledby="release-title">
        <h2 id="release-title" class="text-lg font-semibold">{t('updates.title')}</h2>
        {#if !status.enabled}<p class="rounded-2xl bg-well p-4 text-sm" role="status">{t('updates.disabled')}</p>{/if}
        <label for="update-project">{t('updates.project')}</label><select id="update-project" class="rounded-xl border border-border bg-background p-3" bind:value={project} disabled={busy || active} onchange={clearApproval}><option value="" disabled>{t('updates.select')}</option>{#each status.projects as item (item.name)}<option value={item.name}>{item.name}</option>{/each}</select>
        <dl class="grid grid-cols-2 gap-3 text-sm"><dt>{t('updates.current')}</dt><dd translate="no">{selected?.version ?? '—'}</dd><dt>{t('updates.available')}</dt><dd translate="no">{status.release?.version ?? '—'}</dd></dl>
        {#if status.checking}<p role="status">{t('updates.checking')}</p>{/if}
        {#if status.check_error}<p role="alert" class="text-sm text-muted-foreground">{blocker(status.check_error)}</p>{/if}
        {#if status.release && selected && !selected.update_available}<p class="text-sm text-muted-foreground">{t('updates.noUpdate')}</p>{/if}
        {#if !status.release && !status.checking && !status.check_error}<p class="text-sm text-muted-foreground">{t('updates.noRelease')}</p>{/if}
        <div class="flex flex-wrap gap-3"><Button variant="outline" disabled={busy || offline || status.checking} onclick={() => void act({ action: 'check' }, reply => { status = mergeStatus(status, parseStatus(reply.data)) })}>{t('updates.check')}</Button><Button disabled={busy || offline || active || !status.release || !project || !selected?.update_available} onclick={prepare}>{t('updates.plan')}</Button></div>
      </section>
      {#if plan || recover}
        <form onsubmit={approve} class="grid gap-4 rounded-3xl bg-card p-6" aria-busy={busy}>
          <h2 class="text-lg font-semibold">{t(recover ? 'updates.recover' : 'updates.review')}</h2>
          {#if plan}<p translate="no">{plan.project}: {plan.current} → {plan.target}</p><p class="break-all text-xs text-muted-foreground">{t('updates.digest')}: <span translate="no">{plan.digest}</span></p><p class="text-sm text-muted-foreground">{t('updates.expires')}</p>{#if plan.blockers.length}<h3 class="font-medium">{t('updates.requirements')}</h3><ul class="list-inside list-disc text-sm">{#each plan.blockers as code}<li>{blocker(code)}</li>{/each}</ul>{/if}{/if}
          {#if recover}<p>{t(recover.committed ? 'updates.committed' : 'updates.uncommitted')}</p><p translate="no">{recover.project}: {recover.current} → {recover.target}</p>{/if}
          <p class="text-sm text-muted-foreground">{t('updates.impact')}</p>
          <label for="approval-password">{t('updates.password')}</label><Input id="approval-password" type="password" autocomplete="current-password" required maxlength={1024} bind:value={approval} disabled={busy || offline || (plan !== null && (plan.blockers.length > 0 || !status.enabled))} />
          <div class="flex flex-wrap gap-3"><Button type="submit" disabled={busy || offline || !approval || (plan !== null && (plan.blockers.length > 0 || !status.enabled))}>{t(recover ? 'updates.recover' : 'updates.approve')}</Button><Button type="button" variant="outline" onclick={clearApproval} disabled={busy}>{t('common.cancel')}</Button></div>
        </form>
      {/if}
      <section class="grid gap-4" aria-labelledby="history-title"><h2 id="history-title" class="text-lg font-semibold">{t('updates.history')}</h2>{#each status.jobs as job (job.id)}<article class="grid gap-3 rounded-3xl bg-card p-5"><p class="font-medium" translate="no">{job.project}: {job.current} → {job.target}</p><p role="status">{t(`updates.${job.phase}`)}</p>{#if progress[job.phase] !== undefined}<progress class="h-2 w-full" max="7" value={progress[job.phase]} aria-label={t(`updates.${job.phase}`)}></progress>{/if}<p class="break-all text-xs text-muted-foreground" translate="no">{job.id}</p>{#if job.phase === 'needs_operator'}<Button class="w-fit" variant="outline" disabled={busy || offline} onclick={() => { clearApproval(); recover = job }}>{t('updates.recover')}</Button>{/if}</article>{/each}</section>
      {/if}
    {/if}
  </div>
</main>
