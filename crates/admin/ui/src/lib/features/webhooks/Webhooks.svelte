<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { toast } from 'svelte-sonner'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Webhook from '@lucide/svelte/icons/webhook'
  import Plus from '@lucide/svelte/icons/plus'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import Callout from '$lib/components/shared/Callout.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { route, navigate, href } from '$lib/navigation/router.svelte'
  import { errorMessage, t } from '$lib/i18n/index.svelte'
  import type { WebhookEndpoints, WebhookDeliveries, WebhookEndpoint, WebhookSecret } from '$lib/contracts/types'
  import EndpointDialog from './components/EndpointDialog.svelte'
  import SecretDialog from './components/SecretDialog.svelte'
  import DeliveryHistory from './components/DeliveryHistory.svelte'
  import { webhooks, type EndpointInput } from './api'
  import { eventLabel } from './format'

  const config = new RemoteResource<WebhookEndpoints>()
  const history = new RemoteResource<WebhookDeliveries>()
  const tab = $derived(route.query.get('tab') === 'deliveries' ? 'deliveries' : 'configuration')
  const endpointFilter = $derived(route.query.get('endpoint') ?? '')
  const statusFilter = $derived(route.query.get('status') ?? '')
  const before = $derived(route.query.get('before') ?? '')
  const query = $derived.by(() => {
    const params = new URLSearchParams()
    if (endpointFilter) params.set('endpoint', endpointFilter)
    if (statusFilter) params.set('status', statusFilter)
    if (before) params.set('before', before)
    return params.size ? `?${params}` : ''
  })
  let editorOpen = $state(false), editing = $state<WebhookEndpoint | null>(null), secret = $state<WebhookSecret | null>(null)
  let busy = $state<string | null>(null), confirmOpen = $state(false), refreshing = $state(false)
  let confirm = $state<{ kind: 'delete' | 'rotate' | 'pause' | 'clear'; endpoint?: WebhookEndpoint } | null>(null)

  async function loadConfig() { await config.load(signal => webhooks.list(signal)) }
  async function loadHistory() { await history.load(signal => webhooks.history(query, signal)) }
  async function reload() { await Promise.all([loadConfig(), tab === 'deliveries' ? loadHistory() : Promise.resolve()]) }
  // Only a manual refresh disables the button; background polling would make it flicker.
  async function refresh() {
    if (refreshing) return
    refreshing = true
    try { await reload() } finally { refreshing = false }
  }
  $effect(() => {
    const currentTab = tab, currentQuery = query
    if (currentTab === 'deliveries') { untrack(() => { void history.load(signal => webhooks.history(currentQuery, signal)) }); return }
    history.cancel()
  })
  onMount(() => {
    void loadConfig()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (!config.loading) void loadConfig()
      if (tab === 'deliveries' && !history.loading) void loadHistory()
    }, 5000)
    return () => { clearInterval(timer); config.cancel(); history.cancel(); secret = null }
  })
  function filters(endpoint: string, status: string, cursor = '') {
    const params = new URLSearchParams({ tab: 'deliveries' })
    if (endpoint) params.set('endpoint', endpoint)
    if (status) params.set('status', status)
    if (cursor) params.set('before', cursor)
    navigate(`/webhooks?${params}`)
  }
  function edit(endpoint: WebhookEndpoint | null) { editing = endpoint; editorOpen = true }
  function request(kind: 'delete' | 'rotate' | 'pause' | 'clear', endpoint?: WebhookEndpoint) { confirm = { kind, endpoint }; confirmOpen = true }
  const confirmText = {
    delete: { title: 'webhooks.deleteTitle', hint: 'webhooks.deleteHint', action: 'webhooks.deleteConfirm' },
    rotate: { title: 'webhooks.rotateTitle', hint: 'webhooks.rotateHint', action: 'webhooks.rotate' },
    pause: { title: 'webhooks.pauseTitle', hint: 'webhooks.pauseHint', action: 'webhooks.pauseConfirm' },
    clear: { title: 'webhooks.clearTitle', hint: 'webhooks.clearHint', action: 'webhooks.clear' },
  } as const
  const confirmCopy = $derived(confirmText[confirm?.kind ?? 'pause'])
  function input(endpoint: WebhookEndpoint, enabled = endpoint.enabled): EndpointInput {
    return { name: endpoint.name, table: endpoint.table, url: endpoint.url, events: endpoint.events, max_attempts: endpoint.max_attempts, enabled }
  }
  async function enable(endpoint: WebhookEndpoint) {
    if (busy) return
    busy = endpoint.id
    try { await webhooks.update(endpoint.id, input(endpoint, true)); await reload() }
    catch (error) { toast.error(errorMessage(error)) } finally { busy = null }
  }
  async function apply() {
    if (!confirm || busy) return
    const action = confirm
    busy = action.endpoint?.id ?? 'clear'
    try {
      switch (action.kind) {
        case 'clear': await webhooks.clear(); toast.success(t('webhooks.cleared')); break
        case 'delete':
          if (action.endpoint) { await webhooks.remove(action.endpoint.id); toast.success(t('webhooks.removed')) }
          break
        case 'rotate':
          if (action.endpoint) secret = await webhooks.rotate(action.endpoint.id)
          break
        case 'pause':
          if (action.endpoint) await webhooks.update(action.endpoint.id, input(action.endpoint, false))
          break
      }
      await reload()
    } catch (error) { toast.error(errorMessage(error)); throw error } finally { busy = null }
  }
  function saved(value?: WebhookSecret) {
    if (value) secret = value
    toast.success(t(value ? 'webhooks.created' : 'webhooks.saved'))
    void reload()
  }
</script>

<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8">
  <PageHeader title={t('webhooks.title')} description={t('webhooks.description')}>
    {#snippet actions()}<Button variant="outline" onclick={refresh} disabled={refreshing}><RefreshCw data-icon="inline-start" aria-hidden="true" class={refreshing ? 'animate-spin' : ''} />{t('common.refresh')}</Button>{#if tab === 'configuration'}<Button onclick={() => edit(null)} disabled={!config.data?.tables.length}><Plus data-icon="inline-start" aria-hidden="true" />{t('webhooks.create')}</Button>{/if}{/snippet}
  </PageHeader>
  {#if config.error}<LoadError message={errorMessage(config.error)} onretry={loadConfig} busy={config.loading} />{/if}
  {#if !config.data && config.loading}<Skeleton class="h-40 rounded-3xl" />{/if}
  {#if config.data}
    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-3xl bg-card p-4 sm:p-5"><p class="text-sm text-muted-foreground">{t('webhooks.outstanding')}</p><p class="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold tabular-nums">{config.data.outstanding}<span class="text-xs font-normal whitespace-nowrap text-muted-foreground">/ 10 000</span></p></div>
      <div class="rounded-3xl bg-card p-4 sm:p-5"><p class="text-sm text-muted-foreground">{t('webhooks.retained')}</p><p class="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold tabular-nums">{config.data.retained}<span class="text-xs font-normal whitespace-nowrap text-muted-foreground">/ 100 000</span></p></div>
    </div>
    {#if config.data.outstanding >= 8000 || config.data.retained >= 80000}<Callout variant="warning" title={t('webhooks.capacity')} />{/if}
    {#if (tab === 'configuration')}
      {#if !config.data.endpoints.length}
        <EmptyState class="rounded-3xl bg-card" icon={Webhook} title={t(config.data.tables.length ? 'webhooks.emptyTitle' : 'webhooks.noTables')} description={t(config.data.tables.length ? 'webhooks.emptyHint' : 'webhooks.noTablesHint')}>
          {#snippet actions()}{#if (config.data?.tables.length)}<Button onclick={() => edit(null)}>{t('webhooks.create')}</Button>{/if}{#if !(config.data?.tables.length)}<Button href={href('/tables?create=true')}>{t('tables.editor.newTable')}</Button>{/if}{/snippet}
        </EmptyState>
      {/if}
      <div class="grid gap-4 lg:grid-cols-2">
        {#each config.data.endpoints as hook (hook.id)}
          <section class="grid min-w-0 content-start gap-4 rounded-3xl bg-card p-5">
            <header class="flex flex-wrap items-center justify-between gap-2"><h2 class="min-w-0 break-words font-semibold">{hook.name}</h2>
              {#if !hook.table_available}<span class="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">{t('webhooks.tableMissing')}</span>{/if}
              {#if hook.table_available}<span class={['rounded-full px-2.5 py-1 text-xs font-medium', hook.enabled ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground']}>{t(hook.enabled ? 'webhooks.enabled' : 'webhooks.paused')}</span>{/if}
            </header>
            <p class="font-mono text-sm text-muted-foreground">{hook.schema}.{hook.table}</p>
            {#if !hook.table_available}<p class="text-sm text-warning">{t('webhooks.missingTable')}</p>{/if}
            <p class="break-all text-sm text-muted-foreground">{hook.url}</p>
            <div class="flex flex-wrap gap-2">{#each hook.events as event}<span class="rounded-full bg-well px-3 py-1 text-xs">{eventLabel(event)}</span>{/each}</div>
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onclick={() => edit(hook)} disabled={busy !== null}><Pencil data-icon="inline-start" aria-hidden="true" />{t('common.edit')}</Button>
              <!-- Without its table no new changes are captured, but pausing still holds the
                   pending deliveries; only resuming needs the table back (the server refuses it). -->
              {#if hook.enabled || hook.table_available}<Button variant="outline" size="sm" onclick={() => hook.enabled ? request('pause', hook) : enable(hook)} disabled={busy !== null}>{t(hook.enabled ? 'webhooks.pause' : 'webhooks.resume')}</Button>{/if}
              <Button variant="outline" size="sm" onclick={() => filters(hook.id, '')}>{t('webhooks.deliveries')}</Button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger disabled={busy !== null}>
                  {#snippet child({ props })}<Button variant="ghost" size="icon-sm" aria-label={t('common.actionsFor', { name: hook.name })} {...props}><Ellipsis aria-hidden="true" /></Button>{/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-48">
                  <DropdownMenu.Item onclick={() => request('rotate', hook)}><KeyRound aria-hidden="true" />{t('webhooks.rotate')}</DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item variant="destructive" onclick={() => request('delete', hook)}><Trash2 aria-hidden="true" />{t('webhooks.remove')}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          </section>
        {/each}
      </div>
      <p class="text-sm text-muted-foreground">{t('webhooks.retryGuide')} <a href={href('/guides/webhooks')} class="text-brand underline">{t('webhooks.guide')}</a></p>
    {/if}
    {#if !(tab === 'configuration')}
      {#if history.error}<LoadError message={errorMessage(history.error)} onretry={loadHistory} busy={history.loading} />{/if}
      {#if !history.data && history.loading}<Skeleton class="h-48 rounded-3xl" />{/if}
      <DeliveryHistory data={history.data} endpoints={config.data.endpoints} endpoint={endpointFilter} status={statusFilter} hasCursor={!!before} onfilter={filters} onnext={() => filters(endpointFilter, statusFilter, history.data?.next_cursor ?? '')} onfirst={() => filters(endpointFilter, statusFilter)} />
      <div><Button variant="outline" onclick={() => request('clear')} disabled={busy !== null || !config.data.retained}>{t('webhooks.clear')}</Button></div>
    {/if}
    <EndpointDialog bind:open={editorOpen} endpoint={editing} tables={config.data.tables} allowLoopback={config.data.allow_loopback} onsaved={saved} />
  {/if}
</div>
<SecretDialog bind:value={secret} />
<ConfirmDialog bind:open={confirmOpen} title={t(confirmCopy.title, { name: confirm?.endpoint?.name ?? '' })} description={t(confirmCopy.hint)} confirmLabel={t(confirmCopy.action)} destructive={confirm?.kind === 'delete' || confirm?.kind === 'clear'} onconfirm={apply} />
