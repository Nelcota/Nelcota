<script lang="ts">
  import { onMount } from 'svelte'
  import { mode, toggleMode } from 'mode-watcher'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import Server from '@lucide/svelte/icons/server'
  import History from '@lucide/svelte/icons/history'
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole'
  import LogOut from '@lucide/svelte/icons/log-out'
  import SunMoon from '@lucide/svelte/icons/sun-moon'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Download from '@lucide/svelte/icons/download'
  import Layers from '@lucide/svelte/icons/layers'

  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import Logo from '$lib/shell/components/Logo.svelte'
  import HostConsole from '../host/HostConsole.svelte'
  import { hostAreas, type HostArea } from '../host/navigation'
  import SidebarGroup from '$lib/components/shared/SidebarGroup.svelte'
  let hostArea = $state<HostArea>('projects')
  let view = $state<'projects' | 'updates'>('projects')
  let hostConsole = $state<HostConsole>()
  import { t, translate, i18n, setLocale, errorMessage } from '$lib/i18n/index.svelte'
  import { ControllerError, request, pollDelay, parseStatus, parsePlan, parseJob, mergeStatus, newKey, message, terminal, type Status, type Plan, type Job } from './controller'
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
  const IDLE_POLL_MS = 10000
  const requests = new Set<AbortController>()
  const active = $derived((status?.host_busy || status?.jobs.some(job => !terminal(job.phase))) ?? false)
  const selected = $derived(status?.projects.find(item => item.name === project))
  function clearApproval() { plan = null; recover = null; approval = ''; key = '' }
  async function call(body?: object) {
    const abort = new AbortController(); requests.add(abort)
    try { return await request(body, abort.signal) } finally { requests.delete(abort) }
  }
  function schedule() {
    clearTimeout(timer)
    if (!alive || signedOut) return
    const delay = pollDelay({ offline, attempts, active: active || (status?.checking ?? false), idleMs: IDLE_POLL_MS })
    // A hidden tab keeps its schedule without asking the controller.
    timer = setTimeout(() => {
      if (document.hidden) { schedule(); return }
      void refresh()
    }, delay)
  }
  function refreshWhenShown() { if (!document.hidden) void refresh() }
  async function refresh() {
    if (!alive || polling === generation) return
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
  onMount(() => {
    void refresh()
    document.addEventListener('visibilitychange', refreshWhenShown)
    return () => { alive = false; generation++; clearTimeout(timer); document.removeEventListener('visibilitychange', refreshWhenShown); for (const abort of requests) abort.abort() }
  })
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
  async function switchLanguage() {
    try { await setLocale(i18n.locale === 'pt-BR' ? 'en' : 'pt-BR') }
    catch (error) { failure = errorMessage(error) }
  }
  function blocker(code: string) { const value = translate(i18n.locale, `updates.${code}`); return value === `updates.${code}` ? t('updates.blocked') : value }
  const progress: Record<string, number> = { preparing: 0, pausing: 1, capturing: 2, backup_verified: 3, activating: 4, validating: 5, committing: 6, succeeded: 7 }
</script>
<svelte:window ononline={() => void refresh()} onfocus={() => { if (!signedOut) void refresh() }} />
<div class="updates-app">
  <a class="skip-link" href="#updates-content">{t('updates.skip')}</a>
  <header class="console-header">
    <div class="console-brand"><Logo mark /><span class="console-label">{t('updates.console')}</span></div>
    <div class="console-tools">
      <Button variant="ghost" size="sm" onclick={switchLanguage}>{i18n.locale === 'pt-BR' ? 'English' : 'Português'}</Button>
      <Button variant="ghost" size="icon" onclick={toggleMode} aria-label={mode.current === 'dark' ? t('shell.account.lightTheme') : t('shell.account.darkTheme')}><SunMoon class="size-4" aria-hidden="true" /></Button>
      {#if status}<Button variant="ghost" size="sm" disabled={busy} onclick={() => { if (hostConsole) { hostConsole.leave(() => { void logout() }); return }; void logout() }}><LogOut class="size-4" aria-hidden="true" /><span class="sr-only sm:not-sr-only">{t('shell.account.signOut')}</span></Button>{/if}
    </div>
  </header>
  <div class:authenticated={status !== null} class="console-layout">
    {#if status}
      <aside class="console-sidebar">
        <div class="sidebar-context">
          <span class="context-icon"><Server class="size-4" aria-hidden="true" /></span>
          <div><span class="eyebrow">{t(selected && (!status.host_management || view === 'updates') ? 'updates.project' : 'updates.console')}</span><p translate="no">{selected && (!status.host_management || view === 'updates') ? selected.name : t('updates.controller')}</p></div>
        </div>
        <nav class="console-nav" aria-label={t('updates.controller')}>
          {#if status.host_management}
            <SidebarGroup label={t('server.title')} icon={Layers} active={view === 'projects'}>
              {#each hostAreas as item (item.id)}
                <button type="button" class="panel-nav-link panel-nav-child w-full text-left" class:is-active={view === 'projects' && hostArea === item.id} aria-current={view === 'projects' && hostArea === item.id ? 'page' : undefined} disabled={busy || hostConsole?.navigationBusy()} onclick={() => { view = 'projects'; if (hostConsole) { hostConsole.selectArea(item.id); return }; hostArea = item.id }}><item.icon class="size-4 shrink-0" aria-hidden="true" />{t(`server.${item.id}`)}</button>
              {/each}
            </SidebarGroup>
          {/if}
          <button type="button" class="panel-nav-link" class:is-active={!status.host_management || view === 'updates'} aria-current={!status.host_management || view === 'updates' ? 'page' : undefined} onclick={() => { if (hostConsole) { hostConsole.leave(() => { view = 'updates' }); return }; view = 'updates' }}><Download class="size-4" aria-hidden="true" />{t('host.updates')}</button>
        </nav>
        <div class="operator-card"><span class="operator-avatar" aria-hidden="true">{status.email.slice(0, 1).toUpperCase()}</span><div><span class="eyebrow">{t('updates.operator')}</span><p class="operator-email" title={status.email}>{status.email}</p></div></div>
      </aside>
    {/if}
    <main id="updates-content" tabindex="-1" class="console-main">
      {#if failure}<div class="notice notice-error" role="alert"><CircleAlert class="size-4 shrink-0" aria-hidden="true" /><p>{failure}</p></div>{/if}
      {#if offline}<div role="status" class="notice"><CircleAlert class="size-4 shrink-0" aria-hidden="true" /><p>{t('updates.reconnect')}</p><Button variant="outline" size="sm" onclick={() => void refresh()}>{t('updates.retry')}</Button></div>{/if}
      {#if !status && !signedOut && !offline}<div class="console-loading" role="status"><RefreshCw class="size-5 motion-safe:animate-spin" aria-hidden="true" /><p>{t('shell.app.loading')}</p></div>{/if}
      {#if signedOut}
        <div class="operator-login">
          <section class="login-intro">
            <span class="eyebrow">{t('updates.console')}</span>
            <h1>{t('updates.loginTitle')}</h1>
            <p>{t('updates.loginSubtitle')}</p>
            <div class="login-diagram" aria-hidden="true"><Server class="size-8" /><span></span><ShieldCheck class="size-9 text-brand" /><span></span><Download class="size-8" /></div>
            <div class="login-feature"><ShieldCheck class="size-5" aria-hidden="true" /><div><h2>{t('updates.verifiedTitle')}</h2><p>{t('updates.verifiedHint')}</p></div></div>
            <div class="login-feature"><History class="size-5" aria-hidden="true" /><div><h2>{t('updates.recoveryTitle')}</h2><p>{t('updates.recoveryHint')}</p></div></div>
          </section>
          <section class="login-card" aria-labelledby="operator-login-title">
            <span class="login-lock"><LockKeyhole class="size-5" aria-hidden="true" /></span>
            <h2 id="operator-login-title">{t('updates.operatorAccess')}</h2>
            <p class="login-description">{t('updates.authority')}</p>
            <form onsubmit={login} class="grid gap-5" aria-busy={busy}>
              <div class="grid gap-2"><label for="operator-email">{t('login.email')}</label><Input id="operator-email" type="email" autocomplete="username" required maxlength={254} bind:value={email} disabled={busy} /></div>
              <div class="grid gap-2"><label for="operator-password">{t('login.password')}</label><Input id="operator-password" type="password" autocomplete="current-password" required maxlength={1024} bind:value={password} disabled={busy} /></div>
              <Button type="submit" class="w-full" disabled={busy}>{busy ? t('updates.working') : t('login.signIn')}<ArrowRight class="size-4" aria-hidden="true" /></Button>
            </form>
            <p class="login-footnote"><LockKeyhole class="size-3.5 shrink-0" aria-hidden="true" />{t('updates.separateAccess')}</p>
          </section>
        </div>
      {/if}
      {#if status}
        {#if status.host_management && view === 'projects'}
          <div class="page-heading"><div><span class="eyebrow">{t('updates.console')}</span><h1>{t('updates.controller')}</h1></div></div>
          {#key status.email}<HostConsole bind:this={hostConsole} bind:area={hostArea} email={status.email} expired={() => { generation++; signedOut = true; status = null; clearApproval(); clearTimeout(timer); for (const abort of requests) abort.abort() }} />{/key}
        {/if}
        {#if !status.host_management || view === 'updates'}
          <header class="page-heading"><div><span class="eyebrow">{t('updates.controller')}</span><h1>{t('updates.title')}</h1><p>{t('updates.subtitle')}</p></div><Button variant="outline" disabled={busy || offline || status.checking} onclick={() => void act({ action: 'check' }, reply => { status = mergeStatus(status, parseStatus(reply.data)) })}><RefreshCw class={['size-4', status.checking && 'motion-safe:animate-spin']} aria-hidden="true" />{t('updates.check')}</Button></header>
          {#if !status.enabled}<div class="notice notice-warning" role="status"><LockKeyhole class="size-5 shrink-0" aria-hidden="true" /><div><h2>{t('updates.installationLocked')}</h2><p>{t('updates.disabled')}</p></div></div>{/if}
          <div class="updates-grid">
            <div class="updates-primary">
              <section class="release-card" aria-labelledby="release-title">
                <div class="section-heading"><h2 id="release-title"><Download class="size-4" aria-hidden="true" />{t('updates.releaseTitle')}</h2><span class="release-channel">{t('updates.officialChannel')}</span></div>
                <div class="project-field"><label for="update-project">{t('updates.project')}</label><div class="select-wrap"><Server class="size-4" aria-hidden="true" /><select id="update-project" bind:value={project} disabled={busy || active} onchange={clearApproval}><option value="" disabled>{t('updates.select')}</option>{#each status.projects as item (item.name)}<option value={item.name}>{item.name}</option>{/each}</select></div></div>
                <dl class="version-comparison"><div><dt>{t('updates.current')}</dt><dd translate="no">{selected?.version ?? '—'}</dd></div><ArrowRight class="version-arrow size-5" aria-hidden="true" /><div><dt>{t('updates.available')}</dt><dd class:version-available={selected?.update_available} translate="no">{status.release?.version ?? '—'}</dd></div></dl>
                <div class="release-status" aria-live="polite">
                  {#if status.checking}<p><RefreshCw class="size-4 motion-safe:animate-spin" aria-hidden="true" />{t('updates.checking')}</p>{/if}
                  {#if status.check_error}<p role="alert" class="text-warning"><CircleAlert class="size-4 shrink-0" aria-hidden="true" />{blocker(status.check_error)}</p>{/if}
                  {#if status.release && selected && !selected.update_available}<p><CircleCheck class="size-4 shrink-0" aria-hidden="true" />{t('updates.noUpdate')}</p>{/if}
                  {#if !status.release && !status.checking && !status.check_error}<p>{t('updates.noRelease')}</p>{/if}
                </div>
                <div class="release-actions"><p>{t('updates.planHint')}</p><Button disabled={busy || offline || active || !status.release || !project || !selected?.update_available} onclick={prepare}>{t('updates.plan')}<ArrowRight class="size-5" aria-hidden="true" /></Button></div>
              </section>
              {#if plan || recover}
                <form onsubmit={approve} class="review-card" aria-busy={busy} aria-labelledby="review-title">
                  <h2 id="review-title"><ShieldCheck class="size-5" aria-hidden="true" />{t(recover ? 'updates.recover' : 'updates.review')}</h2>
                  {#if plan}<p class="review-version" translate="no">{plan.project}: {plan.current} → {plan.target}</p><div class="artifact-identity"><span>{t('updates.digest')}</span><code translate="no">{plan.digest}</code></div><p class="text-sm text-muted-foreground">{t('updates.expires')}</p>{#if plan.blockers.length}<div class="requirements"><h3>{t('updates.requirements')}</h3><ul>{#each plan.blockers as code}<li><CircleAlert class="size-4 shrink-0" aria-hidden="true" />{blocker(code)}</li>{/each}</ul></div>{/if}{/if}
                  {#if recover}<p>{t(recover.committed ? 'updates.committed' : 'updates.uncommitted')}</p><p class="review-version" translate="no">{recover.project}: {recover.current} → {recover.target}</p>{/if}
                  <p class="impact-note">{t('updates.impact')}</p>
                  <div class="grid gap-2"><label for="approval-password">{t('updates.password')}</label><Input id="approval-password" type="password" autocomplete="current-password" required maxlength={1024} bind:value={approval} disabled={busy || offline || (plan !== null && (plan.blockers.length > 0 || !status.enabled))} /></div>
                  <div class="flex flex-wrap gap-3"><Button type="submit" disabled={busy || offline || !approval || (plan !== null && (plan.blockers.length > 0 || !status.enabled))}>{t(recover ? 'updates.recover' : 'updates.approve')}</Button><Button type="button" variant="outline" onclick={clearApproval} disabled={busy}>{t('common.cancel')}</Button></div>
                </form>
              {/if}
              <section class="history-section" aria-labelledby="history-title">
                <div class="section-heading"><h2 id="history-title"><History class="size-4" aria-hidden="true" />{t('updates.history')}</h2><span class="history-count">{status.jobs.length}</span></div>
                {#if status.jobs.length === 0}<div class="history-empty"><span><History class="size-5" aria-hidden="true" /></span><h3>{t('updates.emptyHistory')}</h3><p>{t('updates.emptyHistoryHint')}</p></div>{/if}
                {#each status.jobs as job (job.id)}
                  <article class="job-card">
                    <div class="job-heading"><p translate="no">{job.project}<span>{job.current} → {job.target}</span></p><span class="job-phase" class:job-success={job.phase === 'succeeded' || job.phase === 'recovered'} class:job-warning={job.phase === 'needs_operator' || job.phase === 'failed_before_change'} role="status">{t(`updates.${job.phase}`)}</span></div>
                    {#if progress[job.phase] !== undefined}<progress max="7" value={progress[job.phase]} aria-label={t(`updates.${job.phase}`)}></progress>{/if}
                    <p class="job-id" translate="no">{job.id}</p>
                    {#if job.phase === 'needs_operator'}<Button class="w-fit" variant="outline" disabled={busy || offline} onclick={() => { clearApproval(); recover = job }}>{t('updates.recover')}</Button>{/if}
                  </article>
                {/each}
              </section>
            </div>
            <aside class="safety-card" aria-labelledby="safety-title">
              <span class="safety-icon"><ShieldCheck class="size-5" aria-hidden="true" /></span><h2 id="safety-title">{t('updates.safetyTitle')}</h2><p>{t('updates.safetyHint')}</p>
              <ol class="safety-steps"><li><span>01</span><div><h3>{t('updates.stepReview')}</h3><p>{t('updates.stepReviewHint')}</p></div></li><li><span>02</span><div><h3>{t('updates.stepBackup')}</h3><p>{t('updates.stepBackupHint')}</p></div></li><li><span>03</span><div><h3>{t('updates.stepValidate')}</h3><p>{t('updates.stepValidateHint')}</p></div></li></ol>
              <p class="safety-footnote"><LockKeyhole class="size-4 shrink-0" aria-hidden="true" />{t('updates.operatorConfirmation')}</p>
            </aside>
          </div>
        {/if}
      {/if}
    </main>
  </div>
</div>

<style>
  .updates-app { min-height: 100dvh; background: var(--background); color: var(--foreground); }
  .skip-link { position: fixed; top: -5rem; left: 1rem; z-index: 50; padding: .75rem 1rem; border-radius: .5rem; background: var(--primary); color: var(--primary-foreground); }
  .skip-link:focus { top: .5rem; }
  .console-header { position: sticky; top: 0; z-index: 20; background: var(--background); min-height: 4.5rem; padding: 0 1.5rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .console-brand, .console-tools { display: flex; align-items: center; gap: .75rem; }
  .console-label { font-size: .75rem; color: var(--muted-foreground); border-left: 1px solid var(--border-strong); padding-left: 1rem; }
  .console-layout.authenticated { display: grid; grid-template-columns: 13.5rem minmax(0, 1fr); min-height: calc(100dvh - 4.5rem); }
  .console-sidebar { position: sticky; top: 4.5rem; height: calc(100dvh - 4.5rem); min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 1.5rem .75rem .75rem; border-right: 1px solid var(--border); }
  .sidebar-context { display: flex; align-items: center; gap: .75rem; padding: 0 .75rem 1.5rem; min-width: 0; }
  .sidebar-context > div { min-width: 0; }
  .sidebar-context p { font-size: .875rem; font-weight: 600; margin-top: .25rem; overflow-wrap: anywhere; }
  .context-icon { display: grid; place-items: center; width: 2rem; height: 2rem; flex-shrink: 0; border-radius: .5rem; background: var(--well); color: var(--muted-foreground); }
  .console-nav { display: grid; gap: .25rem; }
  .console-nav button { width: 100%; text-align: left; cursor: pointer; }
  .console-nav button :global(svg) { flex-shrink: 0; stroke-width: 1.6; }
  .operator-card { margin-top: auto; padding: 1.5rem .75rem .25rem; display: flex; gap: .625rem; align-items: center; min-width: 0; }
  .operator-card > div { min-width: 0; }
  .operator-avatar { display: grid; place-items: center; width: 2rem; height: 2rem; flex-shrink: 0; border-radius: .5rem; background: var(--accent); font-size: .75rem; font-weight: 600; }
  .operator-email { max-width: 9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .75rem; margin-top: .2rem; }
  .eyebrow { font-size: .6875rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted-foreground); font-weight: 600; }
  .console-main { min-width: 0; padding: 2.5rem clamp(1.25rem, 3vw, 3.5rem); max-width: 100rem; width: 100%; margin-inline: auto; }
  .console-main:focus { outline: none; }
  .page-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1.25rem; margin-bottom: 2rem; }
  .page-heading h1 { font-size: 1.875rem; font-weight: 650; letter-spacing: -.04em; line-height: 1.3; margin-top: .375rem; }
  .page-heading p { color: var(--muted-foreground); font-size: .875rem; margin-top: .5rem; }
  .notice { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; border: 1px solid var(--border-strong); background: var(--card); border-radius: .75rem; padding: 1rem 1.25rem; margin-bottom: 1.5rem; font-size: .8125rem; }
  .notice > p { flex: 1; min-width: 12rem; }
  .notice-warning { border-color: color-mix(in srgb, var(--warning) 30%, transparent); background: color-mix(in srgb, var(--warning) 5%, var(--background)); }
  .notice-warning > :global(svg) { color: var(--warning); }
  .notice h2 { font-weight: 600; margin-bottom: .25rem; }
  .notice p { line-height: 1.65; color: var(--muted-foreground); }
  .notice-error, .notice-error p { color: var(--destructive); }
  .updates-grid { display: grid; grid-template-columns: minmax(0, 1fr) 18rem; align-items: start; gap: 1.5rem; }
  .updates-primary { min-width: 0; display: grid; gap: 1.5rem; }
  .release-card, .review-card, .safety-card { background: var(--card); border: 1px solid var(--border); border-radius: .875rem; padding: 1.5rem; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .section-heading h2, .review-card h2 { display: flex; gap: .625rem; align-items: center; font-size: .875rem; font-weight: 600; }
  .section-heading h2 :global(svg) { color: var(--muted-foreground); }
  .release-channel, .history-count { font-size: .6875rem; border: 1px solid var(--border-strong); padding: .25rem .5rem; border-radius: .375rem; color: var(--muted-foreground); }
  .project-field { display: grid; gap: .5rem; margin-top: 1.5rem; }
  label { font-size: .8125rem; font-weight: 500; }
  .select-wrap { position: relative; }
  .select-wrap > :global(svg) { position: absolute; left: .875rem; top: 50%; transform: translateY(-50%); color: var(--muted-foreground); pointer-events: none; }
  select { width: 100%; min-height: 2.75rem; border: 1px solid var(--input); border-radius: .5rem; background: var(--field); color: var(--foreground); font: inherit; font-size: .875rem; padding: .5rem 2rem .5rem 2.5rem; color-scheme: light dark; }
  select:disabled { opacity: .5; }
  .version-comparison { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 1.5rem; align-items: center; margin-top: 1.5rem; padding: 1.5rem; border-radius: .625rem; background: var(--well); }
  .version-comparison dt { color: var(--muted-foreground); font-size: .75rem; }
  .version-comparison dd { margin-top: .625rem; font: 500 clamp(1.25rem, 2.3vw, 1.875rem)/1.2 var(--font-mono); overflow-wrap: anywhere; }
  .version-comparison .version-available { color: var(--brand); }
  .version-comparison :global(.version-arrow) { color: var(--muted-foreground); }
  .release-status { color: var(--muted-foreground); font-size: .8125rem; line-height: 1.7; margin-top: 1rem; }
  .release-status p { display: flex; align-items: center; gap: .5rem; }
  .release-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; border-top: 1px solid var(--border); padding-top: 1.25rem; margin-top: 1.25rem; }
  .release-actions p { color: var(--muted-foreground); font-size: .75rem; max-width: 17rem; line-height: 1.7; }
  .review-card { display: grid; gap: 1.25rem; border-color: color-mix(in srgb, var(--brand) 30%, transparent); }
  .review-version { font-family: var(--font-mono); font-size: .875rem; overflow-wrap: anywhere; }
  .artifact-identity { background: var(--well); padding: .875rem; border-radius: .5rem; display: grid; gap: .5rem; font-size: .75rem; color: var(--muted-foreground); }
  .artifact-identity code { overflow-wrap: anywhere; color: var(--foreground); }
  .requirements h3 { font-size: .875rem; font-weight: 600; margin-bottom: .75rem; }
  .requirements li { display: flex; align-items: start; gap: .5rem; font-size: .8125rem; margin-top: .5rem; color: var(--warning); }
  .impact-note { border-left: 2px solid var(--warning); padding-left: .875rem; font-size: .8125rem; color: var(--muted-foreground); line-height: 1.7; }
  .history-section { display: grid; gap: 1rem; }
  .history-empty { border: 1px dashed var(--border-strong); border-radius: .875rem; padding: 2.5rem 1rem; text-align: center; }
  .history-empty > span { display: inline-flex; padding: .75rem; border-radius: .75rem; background: var(--well); color: var(--muted-foreground); margin-bottom: 1rem; }
  .history-empty h3 { font-size: .875rem; font-weight: 500; }
  .history-empty p { font-size: .75rem; color: var(--muted-foreground); margin-top: .5rem; }
  .job-card { padding: 1.25rem; background: var(--card); border: 1px solid var(--border); border-radius: .75rem; display: grid; gap: .875rem; }
  .job-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; }
  .job-heading p { font-weight: 600; font-size: .875rem; overflow-wrap: anywhere; }
  .job-heading p span { display: block; color: var(--muted-foreground); font: 400 .75rem var(--font-mono); margin-top: .375rem; }
  .job-phase { padding: .375rem .625rem; border-radius: .375rem; background: var(--well); font-size: .75rem; }
  .job-success { color: var(--success); }
  .job-warning { color: var(--warning); }
  .job-id { font: .6875rem var(--font-mono); color: var(--muted-foreground); overflow-wrap: anywhere; }
  progress { appearance: none; width: 100%; height: .25rem; border: 0; border-radius: 1rem; overflow: hidden; background: var(--well); accent-color: var(--brand); }
  progress::-webkit-progress-bar { background: var(--well); }
  progress::-webkit-progress-value { background: var(--brand); }
  progress::-moz-progress-bar { background: var(--brand); }
  .safety-icon, .login-lock { display: inline-flex; padding: .625rem; background: var(--brand-soft); color: var(--brand); border-radius: .625rem; margin-bottom: 1rem; }
  .safety-card h2 { font-size: .875rem; font-weight: 600; }
  .safety-card > p { color: var(--muted-foreground); font-size: .75rem; line-height: 1.8; margin-top: .5rem; }
  .safety-steps { display: grid; gap: 1.5rem; margin-top: 1.75rem; }
  .safety-steps li { display: flex; gap: .875rem; }
  .safety-steps li > span { font: .6875rem var(--font-mono); color: var(--muted-foreground); padding-top: .125rem; }
  .safety-steps h3 { font-size: .8125rem; font-weight: 500; }
  .safety-steps p { font-size: .75rem; color: var(--muted-foreground); line-height: 1.7; margin-top: .375rem; }
  .safety-card .safety-footnote { display: flex; align-items: start; gap: .5rem; border-top: 1px solid var(--border); padding-top: 1rem; margin-top: 1.5rem; }
  .operator-login { max-width: 64rem; min-height: calc(100dvh - 12rem); margin: auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 25rem); align-items: center; gap: clamp(2rem, 6vw, 6rem); }
  .login-intro h1 { font-size: clamp(2rem, 3.5vw, 3rem); line-height: 1.15; font-weight: 600; letter-spacing: -.045em; margin-top: 1rem; text-wrap: balance; }
  .login-intro > p { font-size: .9375rem; line-height: 1.8; color: var(--muted-foreground); margin-top: 1rem; }
  .login-diagram { display: flex; align-items: center; gap: 1rem; padding: 2rem 0; max-width: 21rem; color: var(--muted-foreground); }
  .login-diagram span { height: 1px; flex: 1; background: var(--border-strong); }
  .login-feature { display: flex; gap: .875rem; margin-top: 1rem; }
  .login-feature > :global(svg) { color: var(--muted-foreground); flex-shrink: 0; margin-top: .125rem; }
  .login-feature h2 { font-size: .8125rem; font-weight: 600; }
  .login-feature p { font-size: .75rem; line-height: 1.7; color: var(--muted-foreground); margin-top: .25rem; }
  .login-card { border: 1px solid var(--border-strong); border-radius: 1rem; padding: 2rem; background: var(--card); }
  .login-card h2 { font-size: 1.25rem; font-weight: 600; letter-spacing: -.025em; }
  .login-description { color: var(--muted-foreground); font-size: .8125rem; line-height: 1.8; margin: .75rem 0 1.75rem; }
  .login-footnote { display: flex; gap: .5rem; align-items: start; color: var(--muted-foreground); font-size: .6875rem; line-height: 1.7; border-top: 1px solid var(--border); padding-top: 1.25rem; margin-top: 1.5rem; }
  .console-loading { display: flex; align-items: center; justify-content: center; gap: .75rem; min-height: 50dvh; color: var(--muted-foreground); font-size: .875rem; }
  @media (max-width: 1200px) { .updates-grid { grid-template-columns: minmax(0, 1fr); } .safety-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 800px) {
    .console-header { padding: .75rem 1rem; gap: .5rem; }
    .console-label { display: none; }
    .console-layout.authenticated { grid-template-columns: minmax(0, 1fr); min-height: auto; }
    .console-sidebar { position: static; height: auto; overflow: visible; padding: .75rem 1rem; border-right: 0; border-bottom: 1px solid var(--border); }
    .sidebar-context, .operator-card { display: none; }
    .console-nav { display: flex; flex-wrap: wrap; }
    .console-nav button { width: auto; padding: .625rem .875rem; }
    .console-main { padding: 1.5rem 1rem; }
    .operator-login { grid-template-columns: minmax(0, 1fr); gap: 1.75rem; max-width: 28rem; min-height: auto; padding: 1rem 0; }
    .login-intro h1 { font-size: 2rem; }
    .login-diagram, .login-feature { display: none; }
    .login-card { padding: 1.5rem; }
  }
  @media (max-width: 480px) {
    .console-tools { gap: .125rem; }
    .console-brand { gap: .25rem; }
    .page-heading h1 { font-size: 1.625rem; }
    .release-card, .review-card, .safety-card { padding: 1.125rem; }
    .version-comparison { padding: 1rem; gap: .75rem; }
    .version-comparison dt { font-size: .6875rem; }
    .safety-steps { grid-template-columns: minmax(0, 1fr); }
    .notice { padding: 1rem; }
  }
</style>
