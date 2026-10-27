<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { i18n, translate } from '$lib/i18n/index.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { request, sessionExpired } from '../updates/controller'
  import { parseConfiguration, integer, type Configuration, type ConfigurationView, type Section } from './contracts'
  import type { Operation } from '../host/controller'
  let { project, domain, backups = false, disabled, revision, prepare, action, expired, ondirty, navigate }: {
    project: string; domain: string; backups?: boolean; disabled: boolean; revision: string;
    prepare: (configuration: Configuration) => Promise<boolean>; action: (operation: Operation) => Promise<boolean>;
    expired: () => void; ondirty: (dirty: boolean) => void; navigate: (proceed: () => void) => void
  } = $props()
  type SettingsSection = Exclude<Section, 'alerts'>
  const configurationView = new RemoteResource<ConfigurationView>()
  const view = $derived(configurationView.data), loading = $derived(configurationView.loading)
  let failure = $state(''), dirty = $state(false)
  let section = $state<SettingsSection>('smtp'), enabled = $state(false)
  let smtpUrl = $state(''), from = $state(''), recovery = $state(''), confirmation = $state(''), magic = $state('')
  let clientId = $state(''), clientSecret = $state(''), redirects = $state('')
  let endpoint = $state(''), bucket = $state(''), region = $state('us-east-1'), accessKey = $state(''), secretKey = $state('')
  let hour = $state('3'), minute = $state('0'), keep = $state('7'), password = $state(''), repeat = $state('')
  const s = (key: string) => translate(i18n.locale, `server.${key}`)
  const choices = $derived<SettingsSection[]>(backups ? ['backup', 'schedule'] : ['smtp', 'oauth_google', 'oauth_github', 'admin_password'])
  const blocked = $derived(disabled || loading || !view)
  const valid = $derived(section !== 'admin_password' || (password.length >= 16 && password === repeat))
  function mark(value: boolean) { dirty = value; ondirty(value) }
  function clearSecrets() { smtpUrl = ''; clientSecret = ''; accessKey = ''; secretKey = ''; password = ''; repeat = '' }
  function populate() {
    clearSecrets()
    const f = view?.fields ?? {}
    from = f.NELCOTA_SMTP_FROM ?? ''; recovery = f.NELCOTA_PASSWORD_RECOVERY_URL ?? ''; confirmation = f.NELCOTA_EMAIL_CONFIRMATION_URL ?? ''; magic = f.NELCOTA_MAGIC_LINK_URL ?? ''
    clientId = f[section === 'oauth_google' ? 'NELCOTA_OAUTH_GOOGLE_CLIENT_ID' : 'NELCOTA_OAUTH_GITHUB_CLIENT_ID'] ?? ''
    redirects = (f.NELCOTA_OAUTH_REDIRECT_URLS ?? '').split(',').join('\n')
    hour = f.BACKUP_HOUR ?? ''; minute = f.BACKUP_MINUTE ?? ''; keep = f.BACKUP_KEEP ?? ''
    endpoint = f.NELCOTA_BACKUP_S3_ENDPOINT ?? ''; bucket = f.NELCOTA_BACKUP_S3_BUCKET ?? ''; region = f.NELCOTA_BACKUP_S3_REGION ?? 'us-east-1'
    enabled = section === 'smtp' ? (view?.smtp_configured ?? false) : section === 'oauth_google' ? (view?.google_configured ?? false) : section === 'oauth_github' ? (view?.github_configured ?? false) : (view?.backup_configured ?? false)
    mark(false)
  }
  async function load() {
    const selected = project
    failure = ''
    const loaded = await configurationView.load(async signal => {
      const reply = await request({ action: 'host_configuration', project: selected }, signal)
      const next = parseConfiguration(reply.data)
      if (next.project !== selected) throw new Error('project mismatch')
      return next
    })
    if (loaded) { populate(); return }
    // No error: a newer load replaced this one, or the page closed.
    if (configurationView.error === null) return
    if (sessionExpired(configurationView.error)) { expired(); return }
    failure = s('error')
  }
  $effect(() => {
    const selected = project, mode = backups, changed = revision
    untrack(() => {
      if (!dirty && selected) { if (!choices.includes(section)) section = mode ? 'backup' : 'smtp'; void load() }
    })
    void changed
  })
  onDestroy(() => { configurationView.cancel(); clearSecrets() })
  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (blocked || !valid) return
    let configuration: Configuration
    switch (section) {
      case 'smtp': configuration = { section, enabled, url: smtpUrl === '' ? null : smtpUrl, from, recovery_url: recovery, confirmation_url: confirmation, magic_link_url: magic }; break
      case 'oauth_google': case 'oauth_github': configuration = { section, enabled, client_id: clientId, client_secret: clientSecret === '' ? null : clientSecret, redirects: redirects.split('\n').map(s => s.trim()).filter(s => s !== '') }; break
      case 'backup': configuration = { section, enabled, endpoint, bucket, region, access_key: accessKey === '' ? null : accessKey, secret_key: secretKey === '' ? null : secretKey }; break
      case 'schedule': {
        const h = integer(hour, 0, 23), m = integer(minute, 0, 59), k = integer(keep, 1, 365)
        if (h === null || m === null || k === null) { failure = s('invalid_backup_schedule'); return }
        configuration = { section, hour: h, minute: m, keep: k }; break
      }
      case 'admin_password': configuration = { section, new_password: password }; break
    }
    try { if (await prepare(configuration)) mark(false) } finally { clearSecrets() }
  }
  function change(event: Event) {
    const next = (event.target as HTMLSelectElement).value as SettingsSection
    ;(event.target as HTMLSelectElement).value = section
    navigate(() => { section = next; populate() })
  }
</script>
<section class="grid gap-5 rounded-3xl border border-border bg-card p-6" aria-busy={loading} aria-labelledby="server-settings-title">
  <div class="flex flex-wrap items-center justify-between gap-3"><h2 id="server-settings-title" class="text-xl font-semibold">{s(backups ? 'backups' : 'settings')}</h2><Button variant="outline" disabled={disabled || loading} onclick={() => navigate(() => { mark(false); void load() })}>{s('reload')}</Button></div>
  {#if failure}<p role="alert" class="text-sm text-destructive">{failure}</p>{/if}
  {#if loading}<p role="status">{s('refreshing')}</p>{/if}
  <label class="grid gap-2"><span>{s(backups ? 'backups' : 'settings')}</span><select class="rounded-xl border border-border bg-background p-3" value={section} onchange={change} disabled={blocked}>{#each choices as choice}<option value={choice}>{s(choice)}</option>{/each}</select></label>
  <form class="grid gap-4" onsubmit={submit} oninput={() => mark(true)}>
    <p class="text-sm text-muted-foreground">{s('credentials')}</p>
    {#if ['smtp', 'oauth_google', 'oauth_github', 'backup'].includes(section)}<label class="flex items-center gap-3"><input type="checkbox" bind:checked={enabled} disabled={blocked} />{s('enabled')}</label>{/if}
    {#if section === 'smtp'}
      <label class="grid gap-2"><span>{s('smtpUrl')}</span><Input type="password" autocomplete="new-password" maxlength={4096} bind:value={smtpUrl} disabled={blocked || !enabled} placeholder="smtps://user:password@smtp.example.com:465" /></label>
      <label class="grid gap-2"><span>{s('from')}</span><Input bind:value={from} maxlength={1024} disabled={blocked || !enabled} required={enabled} /></label>
      <label class="grid gap-2"><span>{s('recovery')}</span><Input type="url" bind:value={recovery} maxlength={2048} disabled={blocked || !enabled} required={enabled} /></label>
      <label class="grid gap-2"><span>{s('confirmation')}</span><Input type="url" bind:value={confirmation} maxlength={2048} disabled={blocked || !enabled} /></label>
      <label class="grid gap-2"><span>{s('magic')}</span><Input type="url" bind:value={magic} maxlength={2048} disabled={blocked || !enabled} /></label>
      <p class="text-sm text-muted-foreground">{s('testImpact')}</p>
      <Button type="button" variant="outline" disabled={blocked || dirty || !view?.smtp_configured} onclick={() => void action({ kind: 'test_smtp', project })}>{s('testSmtp')}</Button>
    {/if}
    {#if section === 'oauth_google' || section === 'oauth_github'}
      <p class="text-sm text-muted-foreground">{s('redirectShared')}</p>
      <p class="break-all text-sm">{s('callback')}: <span translate="no">https://{domain}/auth/v1/callback</span></p>
      <label class="grid gap-2"><span>{s('clientId')}</span><Input bind:value={clientId} maxlength={1024} disabled={blocked || !enabled} required={enabled} /></label>
      <label class="grid gap-2"><span>{s('clientSecret')}</span><Input type="password" autocomplete="new-password" bind:value={clientSecret} maxlength={4096} disabled={blocked || !enabled} /></label>
      <label class="grid gap-2"><span>{s('redirects')}</span><textarea class="min-h-24 rounded-xl border border-border bg-background p-3" bind:value={redirects} maxlength={8192} disabled={blocked || !enabled} required={enabled}></textarea></label>
    {/if}
    {#if section === 'backup'}
      <p class="text-sm text-muted-foreground">{s('backupImpact')}</p>
      <label class="grid gap-2"><span>{s('endpoint')}</span><Input type="url" bind:value={endpoint} maxlength={2048} disabled={blocked || !enabled} required={enabled} /></label>
      <label class="grid gap-2"><span>{s('bucket')}</span><Input bind:value={bucket} maxlength={63} disabled={blocked || !enabled} required={enabled} /></label>
      <label class="grid gap-2"><span>{s('region')}</span><Input bind:value={region} maxlength={64} disabled={blocked || !enabled} required={enabled} /></label>
      <label class="grid gap-2"><span>{s('accessKey')}</span><Input type="password" autocomplete="new-password" bind:value={accessKey} maxlength={4096} disabled={blocked || !enabled} /></label>
      <label class="grid gap-2"><span>{s('secretKey')}</span><Input type="password" autocomplete="new-password" bind:value={secretKey} maxlength={4096} disabled={blocked || !enabled} /></label>
    {/if}
    {#if section === 'schedule'}
      <label class="grid gap-2"><span>{s('hour')}</span><Input type="number" min={0} max={23} step={1} value={hour} oninput={e => hour = e.currentTarget.value} disabled={blocked} required /></label>
      <label class="grid gap-2"><span>{s('minute')}</span><Input type="number" min={0} max={59} step={1} value={minute} oninput={e => minute = e.currentTarget.value} disabled={blocked} required /></label>
      <label class="grid gap-2"><span>{s('keep')}</span><Input type="number" min={1} max={365} step={1} value={keep} oninput={e => keep = e.currentTarget.value} disabled={blocked} required /></label>
    {/if}
    {#if section === 'admin_password'}
      <p class="text-sm text-muted-foreground">{s('passwordImpact')}</p>
      {#if view?.shared_login}<p role="status" class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{s('sharedPassword')}</p>{/if}
      <label class="grid gap-2"><span>{s('newPassword')}</span><Input type="password" autocomplete="new-password" bind:value={password} minlength={16} maxlength={1024} disabled={blocked} required /></label>
      <label class="grid gap-2"><span>{s('confirmPassword')}</span><Input type="password" autocomplete="new-password" bind:value={repeat} minlength={16} maxlength={1024} disabled={blocked} required /></label>
    {/if}
    <p class="text-sm text-muted-foreground">{s(section === 'backup' ? 'backupImpact' : section === 'schedule' ? 'scheduleImpact' : 'impact')}</p>
    {#if dirty}<p role="status" class="text-sm text-warning">{s('dirty')}</p>{/if}
    <Button class="w-fit" type="submit" disabled={blocked || !valid}>{s('preview')}</Button>
  </form>
  {#if backups}<div class="grid gap-3 border-t border-border pt-4"><p class="text-sm text-muted-foreground">{s('offsiteImpact')}</p><div class="flex flex-wrap gap-3"><Button variant="outline" disabled={blocked || dirty} onclick={() => void action({ kind: 'backup', project })}>{s('backupNow')}</Button><Button variant="outline" disabled={blocked || dirty || !view?.backup_configured} onclick={() => void action({ kind: 'test_backup', project })}>{s('testBackup')}</Button><Button disabled={blocked || dirty || !view?.backup_configured} onclick={() => void action({ kind: 'backup_offsite', project })}>{s('offsiteNow')}</Button></div></div>{/if}
</section>
