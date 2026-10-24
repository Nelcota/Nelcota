<script lang="ts">
  import { onMount } from 'svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Button } from '$lib/components/ui/button'
  import Plus from '@lucide/svelte/icons/plus'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import ShieldOff from '@lucide/svelte/icons/shield-off'
  import ShieldAlert from '@lucide/svelte/icons/shield-alert'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import Search from '@lucide/svelte/icons/search'
  import Rows3 from '@lucide/svelte/icons/rows-3'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import SearchField from '$lib/components/shared/SearchField.svelte'
  import { toast } from 'svelte-sonner'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import RecentlyBlocked from '$lib/features/policies/components/RecentlyBlocked.svelte'
  import RlsBadge from '$lib/shared/schema/components/RlsBadge.svelte'
  import PolicySheet from '$lib/features/policies/components/PolicySheet.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import Callout from '$lib/components/shared/Callout.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import TechnicalToggle from '$lib/shared/schema/components/TechnicalToggle.svelte'
  import { technical } from '$lib/shared/schema/technical.svelte'
  import { describePolicy, type PolicyMeaning } from '$lib/shared/schema/plain'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api } from '$lib/transport/api'
  import { ddl, toPolicyDef, type PolicyDef } from '$lib/shared/schema/ddl'
  import { href, navigate, route } from '$lib/navigation/router.svelte'
  import type { PoliciesData } from '$lib/contracts/types'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  const resource = new RemoteResource<PoliciesData>()
  const data = $derived(resource.data)
  const error = $derived(resource.error ? errorMessage(resource.error) : '')
  const loading = $derived(resource.loading)
  const exposedRelations = $derived(data?.exposed_without_rls.filter(name => !data.tables.some(table => table.name === name)) ?? [])
  // Keep filters in the URL, including links from overview warnings (`?table=`).
  const appliedSearch = $derived(route.query.get('q') ?? route.query.get('table') ?? '')
  let search = $state('')
  type Filter = 'all' | 'enabled' | 'disabled' | 'attention'
  const filterIcons = { all: Rows3, enabled: ShieldCheck, disabled: ShieldOff, attention: CircleAlert }
  const FILTERS: Filter[] = ['all', 'enabled', 'disabled', 'attention']
  // The badge states spelled out on the page: their hints are tooltips, which touch screens never open.
  const LEGEND = [
    { state: 'ok', icon: ShieldCheck, tone: 'text-success' },
    { state: 'warn', icon: ShieldAlert, tone: 'text-warning' },
    { state: 'danger', icon: ShieldAlert, tone: 'text-destructive' },
  ] as const
  const rlsFilter = $derived<Filter>(FILTERS.find(filter => filter === route.query.get('filter')) ?? 'all')
  $effect(() => { search = appliedSearch })
  let debounce: ReturnType<typeof setTimeout>
  $effect(() => () => clearTimeout(debounce))

  function setFilters(filter: Filter, query = search, replace = false) {
    clearTimeout(debounce)
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (filter !== 'all') params.set('filter', filter)
    navigate(`/policies${params.size ? `?${params}` : ''}`, replace)
  }
  function onSearch() {
    clearTimeout(debounce)
    debounce = setTimeout(() => setFilters(rlsFilter, search, true), 250)
  }
  let enabling = $state<string | null>(null)
  type Table = PoliciesData['tables'][number]
  const inFilter = (table: Table, filter: Filter) =>
    filter === 'all' ||
    (filter === 'enabled' && table.rls.enabled) ||
    (filter === 'disabled' && !table.rls.enabled && table.rls.state !== 'view') ||
    (filter === 'attention' && ['danger', 'warn'].includes(table.rls.state))
  const visible = $derived(data?.tables.filter((table) => table.name.toLowerCase().includes(search.trim().toLowerCase()) && inFilter(table, rlsFilter)) ?? [])
  // How many tables each pill would show, so an empty filter is visible before a click.
  const filterCounts = $derived(Object.fromEntries(FILTERS.map((filter) => [filter, data?.tables.filter((table) => inFilter(table, filter)).length ?? 0])) as Record<Filter, number>)

  const stats = $derived.by(() => {
    const tables = data?.tables.filter((table) => table.rls.state !== 'view') ?? []
    return {
      tables: tables.length,
      protected: tables.filter((table) => table.rls.enabled).length,
      policies: tables.reduce((sum, table) => sum + table.policies.length, 0),
      attention: tables.filter((table) => ['danger', 'warn'].includes(table.rls.state)).length + exposedRelations.length,
    }
  })
  /** A policy in words; custom rules are named as such and keep their SQL in view. */
  function sentence(meaning: PolicyMeaning): string {
    switch (meaning.kind) {
      case 'everyoneReads':
      case 'signedInReads':
        return t(`policies.plain.rule.${meaning.kind}`)
      case 'owner':
        return t(`policies.plain.rule.owner.${meaning.command}`)
      default:
        return t('policies.plain.rule.custom')
    }
  }

  async function load() {
    await resource.load(signal => api.get<PoliciesData>('/policies', { signal }))
  }
  onMount(() => { void load(); return () => resource.cancel() })


  // Sheet: target table and the policy being edited (`null` = new).
  let sheetOpen = $state(false)
  let sheetTable = $state('')
  let editing = $state<PolicyDef | null>(null)
  let toDelete = $state<{ table: string; policy: string } | null>(null)
  let deleteOpen = $state(false)

  function openSheet(table: string, policy: PolicyDef | null) {
    sheetTable = table
    editing = policy
    sheetOpen = true
  }

  // Turning RLS on with no policy hides every row from anon/authenticated:
  // ask first. With policies, it applies right away.
  let toEnable = $state<string | null>(null)
  let enableOpen = $state(false)

  function requestEnableRls(table: string, policies: number) {
    if (policies > 0) {
      enableRls(table).catch(() => {})
      return
    }
    toEnable = table
    enableOpen = true
  }

  /** Rejects after showing the error, so the confirm dialog stays open. */
  async function enableRls(table: string) {
    if (enabling) return
    enabling = table
    try {
      await ddl.alterTable(table, [{ action: 'set_rls', enabled: true }])
      toast.success(t('policies.rlsEnabled', { table }))
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    } finally {
      enabling = null
    }
  }

  async function dropPolicy() {
    if (!toDelete) return
    try {
      await ddl.dropPolicy(toDelete.table, toDelete.policy)
      toast.success(t('policies.deleted', { name: toDelete.policy }))
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
  }

</script>

<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8 [&>:first-child]:mb-0">
  <PageHeader title={t('policies.title')} description={t('policies.description')}>
    {#snippet actions()}<TechnicalToggle />{/snippet}
  </PageHeader>

  {#if error}<LoadError message={error} onretry={load} busy={loading} />{/if}
  {#if (!data && loading)}
    <div class="grid gap-4">
      {#each [0, 1, 2] as i (i)}<Skeleton class="h-36 rounded-3xl" />{/each}
    </div>
  {/if}
  {#if !(!data && loading) && (data)}
    {#if data.exposed_without_rls.length}
      <Callout variant="danger" title={t('policies.exposed', { tables: data.exposed_without_rls.join(', ') })}>
        {t('policies.exposedHint')}
        {#if exposedRelations.length}
          <p class="mt-2">{t('policies.exposedRelations', { relations: exposedRelations.join(', ') })}</p>
        {/if}
        {#snippet actions()}
          <Button variant="outline" size="sm" onclick={() => setFilters('attention')}><ShieldCheck data-icon="inline-start" aria-hidden="true" />{t('common.reviewAccess')}</Button>
          {#if exposedRelations.length}<Button variant="outline" size="sm" href={href('/sql')}>{t('policies.reviewSql')}</Button>{/if}
        {/snippet}
      </Callout>
    {/if}

    <!-- The page at a glance, in the overview's figure style. -->
    <!-- Same columns as below: the last figure sits over the side column. -->
    <!-- Three across even on a phone: the figures are short, stacking them pushed the tables a screen down. -->
    <div class="grid grid-cols-3 gap-3 sm:gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_24rem] xl:gap-6">
      <div class="grid content-start gap-1 rounded-3xl bg-card p-4 sm:p-5">
        <p class="text-xs text-muted-foreground sm:text-sm">{t('policies.stats.protected')}</p>
        <p class="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{stats.protected}<span class="ml-1.5 text-sm font-medium text-muted-foreground sm:text-base">{t('policies.stats.of', { count: stats.tables })}</span></p>
      </div>
      <div class="grid content-start gap-1 rounded-3xl bg-card p-4 sm:p-5">
        <p class="text-xs text-muted-foreground sm:text-sm">{t('policies.stats.policies')}</p>
        <p class="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{stats.policies}</p>
      </div>
      <div class="grid content-start gap-1 rounded-3xl bg-card p-4 sm:p-5">
        <p class="text-xs text-muted-foreground sm:text-sm">{t('policies.stats.attention')}</p>
        <p class={['text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl', stats.attention > 0 && 'text-warning']}>{stats.attention}</p>
      </div>
    </div>

    {#if data.tables.length}
      <section class="grid gap-3 rounded-3xl bg-card p-5" aria-labelledby="rls-legend">
        <div class="grid gap-0.5">
          <h2 id="rls-legend" class="text-sm font-semibold">{t('policies.legend.title')}</h2>
          <p class="text-xs text-muted-foreground">{t('policies.legend.intro')}</p>
        </div>
        <dl class="grid gap-3 sm:grid-cols-3">
          {#each LEGEND as item (item.state)}
            <div class="grid content-start gap-1">
              <dt class={['flex items-center gap-1.5 text-sm font-medium', item.tone]}><item.icon class="size-4 shrink-0" aria-hidden="true" />{t(`policies.plain.state.${item.state}`)}</dt>
              <dd class="text-xs text-muted-foreground">{t(`policies.plain.stateHint.${item.state}`)}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/if}

    <div class="grid gap-6 *:min-w-0 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
    <div class="grid min-w-0 gap-4">
    {#if (data.tables.length === 0)}
      <EmptyState class="rounded-3xl bg-card" icon={ShieldCheck} title={t('policies.noTables')} description={t('policies.noTablesHint')}>{#snippet actions()}<Button href={href('/tables?create=true')}><Plus data-icon="inline-start" aria-hidden="true" />{t('tables.editor.newTable')}</Button>{/snippet}</EmptyState>
    {/if}
    {#if !(data.tables.length === 0)}
      <!-- List toolbar: search on the left, filters beside it; the header keeps only buttons. -->
      <div class="flex flex-wrap items-center gap-3">
        <div class="w-full sm:w-72"><SearchField bind:value={search} oninput={onSearch} label={t('policies.search')} /></div>
        <!-- Wraps on a phone instead of hiding the last filters behind a scroll. -->
        <div class="panel-segments" role="group" aria-label={t('policies.filterLabel')}>
          {#each FILTERS as option (option)}
            {@const on = rlsFilter === option}
            {@const Icon = filterIcons[option]}
            <button type="button" class="panel-segment" aria-pressed={on} onclick={() => setFilters(option)}><Icon class="size-4" aria-hidden="true" />{t(`policies.filters.${option}`)}<span class={['text-xs tabular-nums', on ? 'opacity-70' : 'text-muted-foreground/80']}>{filterCounts[option]}</span></button>
          {/each}
        </div>
      </div>
      {#if !visible.length}
        {#if ((rlsFilter === 'all' || rlsFilter === 'attention') && exposedRelations.some(name => name.toLowerCase().includes(search.trim().toLowerCase())))}
          <EmptyState class="rounded-3xl bg-card" icon={ShieldCheck} title={t('policies.relationsAttention')} description={t('policies.exposedRelations', { relations: exposedRelations.join(', ') })} />
        {/if}
        {#if !((rlsFilter === 'all' || rlsFilter === 'attention') && exposedRelations.some(name => name.toLowerCase().includes(search.trim().toLowerCase()))) && (!search.trim() && rlsFilter !== 'all')}
          <!-- A filter with nothing in it is usually good news: say so instead of "no matches". -->
          <EmptyState class="rounded-3xl bg-card" icon={ShieldCheck} title={t(`policies.filterEmpty.${rlsFilter}.title`)} description={t(`policies.filterEmpty.${rlsFilter}.text`)}>{#snippet actions()}<Button variant="outline" onclick={() => setFilters('all', '')}>{t('policies.showAll')}</Button>{/snippet}</EmptyState>
        {/if}
        {#if !((rlsFilter === 'all' || rlsFilter === 'attention') && exposedRelations.some(name => name.toLowerCase().includes(search.trim().toLowerCase()))) && !(!search.trim() && rlsFilter !== 'all')}
          <EmptyState class="rounded-3xl bg-card" icon={Search} title={t('common.noMatches')}>{#snippet actions()}<Button variant="outline" onclick={() => setFilters('all', '')}>{t('common.clearFilters')}</Button>{/snippet}</EmptyState>
        {/if}
      {/if}
    {/if}
      {#each visible as table (table.name)}
        <section class="@container grid gap-4 rounded-3xl bg-card p-5">
          <header class="flex flex-wrap items-center gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-full bg-well text-muted-foreground"><Rows3 class="size-[18px]" aria-hidden="true" /></span>
            <div class="grid min-w-0 gap-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-base font-semibold">
                  <a href={href(`/tables/${encodeURIComponent(table.name)}`)} class="hover:underline">{table.name}</a>
                </h2>
                <RlsBadge rls={table.rls} />
              </div>
              <p class="text-xs text-muted-foreground">{t('policies.count', { count: table.policies.length })}</p>
            </div>
            <div class="ml-auto flex items-center gap-2">
              {#if !table.rls.enabled}
                <Button variant="outline" size="sm" disabled={enabling !== null} onclick={() => requestEnableRls(table.name, table.policies.length)}>{#if (enabling === table.name)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}{#if !(enabling === table.name)}<ShieldCheck data-icon="inline-start" aria-hidden="true" />{/if}{t('policies.enableRls')}</Button>
              {/if}
              <Button variant="outline" size="sm" onclick={() => openSheet(table.name, null)}><Plus />{t('policies.newPolicy')}</Button>
            </div>
          </header>
          {#if (table.policies.length === 0)}
            <p class="rounded-2xl bg-well px-4 py-3.5 text-sm text-muted-foreground">
              {#if (table.rls.enabled)}
                {t('policies.noPoliciesRlsBefore')} <code class="text-xs text-foreground">service_role</code> {t('policies.noPoliciesRlsAfter')}
              {/if}
              {#if !(table.rls.enabled)}
                {t('policies.noPolicies')}
              {/if}
            </p>
          {/if}
          {#if !(table.policies.length === 0)}
            <div class="grid gap-2">
              {#each table.policies as policy (policy.name)}
                {@const meaning = describePolicy(policy)}
                {@const showSql = technical.on || meaning.kind === 'custom'}
                <div class={['grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl bg-well px-4 py-3 text-sm', showSql && '@4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] @4xl:items-start']}>
                  <div class="min-w-0">
                    <p class="break-words font-medium">
                      {sentence(meaning)}
                      {#if !policy.permissive}<span class="ml-1 text-xs font-normal text-muted-foreground">{t('policies.restrictiveTag')}</span>{/if}
                    </p>
                    <p class="mt-0.5 break-words text-xs text-muted-foreground">
                      {policy.name}{#if meaning.kind === 'owner'}{' · '}{t('policies.plain.rule.ownerColumn', { column: meaning.column })}{/if}
                    </p>
                  </div>
                  {#if showSql}
                  <p class="col-start-1 break-words text-xs text-muted-foreground @4xl:col-start-auto">
                    <span class="mr-1.5 rounded border px-1.5 py-px font-mono text-foreground">{policy.command}</span>
                    {policy.roles.join(', ')}
                  </p>
                  <div class="col-start-1 grid min-w-0 gap-1 font-mono text-xs @4xl:col-start-auto">
                    {#if policy.using}
                      {#if (policy.using.length > 160)}<details><summary class="cursor-pointer text-muted-foreground">USING · {t('common.details')}</summary><CodeBlock code={policy.using} lang="sql" wrap /></details>{/if}
                      {#if !(policy.using.length > 160)}<p class="break-words"><span class="text-muted-foreground">using</span> {policy.using}</p>{/if}
                    {/if}
                    {#if policy.check}
                      {#if (policy.check.length > 160)}<details><summary class="cursor-pointer text-muted-foreground">WITH CHECK · {t('common.details')}</summary><CodeBlock code={policy.check} lang="sql" wrap /></details>{/if}
                      {#if !(policy.check.length > 160)}<p class="break-words"><span class="text-muted-foreground">with check</span> {policy.check}</p>{/if}
                    {/if}
                  </div>
                  {/if}
                  <div class={['col-start-2 row-start-1 flex items-start justify-end gap-1', showSql && 'row-span-3 @4xl:col-start-auto @4xl:row-start-auto @4xl:row-span-1']}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('policies.editLabel', { name: policy.name })}
                      title={t('common.edit')}
                      onclick={() => openSheet(table.name, toPolicyDef(policy))}><Pencil /></Button
                    >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('policies.deleteLabel', { name: policy.name })}
                      title={t('common.delete')}
                      onclick={() => {
                        toDelete = { table: table.name, policy: policy.name }
                        deleteOpen = true
                      }}><Trash2 /></Button
                    >
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>

    <aside class="grid gap-4 xl:sticky xl:top-24">
      <RecentlyBlocked />

    {#if data.anon_functions.length}
      <section class="rounded-3xl bg-card p-5">
        <h2 class="text-sm font-semibold">{t('policies.anonFunctions')}</h2>
        <p class="mt-2 font-mono text-xs">{data.anon_functions.join(', ')}</p>
        <p class="mt-3 text-sm text-muted-foreground">
          {t('policies.anonFunctionsHint')}
          <code class="text-xs text-foreground">revoke execute on function f() from public</code>.
        </p>
      </section>
    {/if}
    </aside>
    </div>
  {/if}
</div>

<PolicySheet bind:open={sheetOpen} table={sheetTable} original={editing} existingNames={data?.tables.find(table => table.name === sheetTable)?.policies.map(policy => policy.name) ?? []} onsaved={load} />
{#if toDelete}
  <ConfirmDialog
    bind:open={deleteOpen}
    title={t('policies.confirmDelete.title', { name: toDelete.policy })}
    description={t('policies.confirmDelete.description', { table: toDelete.table })}
    confirmLabel={t('policies.confirmDelete.confirm')}
    destructive
    onconfirm={dropPolicy}
  />
{/if}
{#if toEnable}
  {@const table = toEnable}
  <ConfirmDialog
    bind:open={enableOpen}
    title={t('policies.enableRlsEmpty.title', { table })}
    description={t('policies.enableRlsEmpty.description')}
    confirmLabel={t('policies.enableRlsEmpty.confirm')}
    onconfirm={() => enableRls(table)}
  />
{/if}
