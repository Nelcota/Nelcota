<script lang="ts">
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { Button } from '$lib/components/ui/button'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import SearchField from '$lib/components/shared/SearchField.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import History from '@lucide/svelte/icons/history'
  import ShieldAlert from '@lucide/svelte/icons/shield-alert'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import RlsBadge from '$lib/shared/schema/components/RlsBadge.svelte'
  import TablesWelcome from './TablesWelcome.svelte'
  import TableRowMenu from './TableRowMenu.svelte'
  import DropTableDialog from './DropTableDialog.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api, enc } from '$lib/transport/api'
  import { href, navigate, route } from '$lib/navigation/router.svelte'
  import { ddl } from '$lib/shared/schema/ddl'
  import { accessSummary, arrangeTables, HOME_FILTERS, isView, needsAttention, type AccessPart, type HomeFilter, type HomeSort, type HomeSortKey } from '$lib/features/tables/home'
  import type { Overview, OverviewTable, SchemaResponse, TableSummary } from '$lib/contracts/types'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'

  // What the editor shows with no table open: every table in one list with
  // search, filters, order, who can reach it and its protection, the tables
  // that need attention with a fix, the recently opened ones and each table's
  // actions. The sidebar list only appears once a table is open.
  let {
    tables,
    loading,
    recent,
    oncreate,
    onchanged,
  }: {
    tables: TableSummary[]
    loading: boolean
    /** Tables opened last in this browser, most recent first. */
    recent: string[]
    oncreate: () => void
    /** The catalog changed here (protection turned on, table deleted). */
    onchanged: () => Promise<void>
  } = $props()

  // Rows, grants and comments come from the overview, column counts from the
  // schema; without them the list still works.
  const overview = new RemoteResource<Overview>()
  const schema = new RemoteResource<SchemaResponse>()
  const loadOverview = () => overview.load((signal) => api.get<Overview>('/overview', { signal }))
  onMount(() => {
    loadOverview()
    schema.load((signal) => api.get<SchemaResponse>('/schema', { signal }))
    return () => {
      overview.cancel()
      schema.cancel()
    }
  })

  let search = $state('')
  // The sidebar picks the filter through `?filter=`; anything else lists every table.
  const filter = $derived<HomeFilter>(HOME_FILTERS.find((option) => option === route.query.get('filter')) ?? 'all')
  let sort = $state<HomeSort>({ key: 'name', desc: false })
  let searchBox = $state<HTMLElement | null>(null)

  const details = $derived(new Map((overview.data?.tables ?? []).map((table) => [table.name, table])))
  const arranged = $derived(arrangeTables(tables, details, { search, filter, sort }))
  const attention = $derived(tables.filter((table) => needsAttention(table.rls.state)))
  const OWNER_VIEW = 'view owner privileges'
  // Width and visibility of each column, shared by the header, the rows and the views group row.
  const COLUMN_CLASS = {
    columns: 'hidden w-28 lg:table-cell',
    rows: 'hidden w-28 sm:table-cell',
    access: 'hidden w-56 xl:table-cell',
    protection: 'w-36 sm:w-40',
    actions: 'w-12',
  } as const
  const recentTables = $derived(recent.filter((name) => tables.some((table) => table.name === name)))
  const fmt = $derived(new Intl.NumberFormat(intlLocale()))
  const list = $derived(new Intl.ListFormat(intlLocale(), { type: 'conjunction' }))

  function rowsLabel(entry: OverviewTable | undefined): string | null {
    if (entry == null || entry.rows === null) return null
    const count = fmt.format(entry.rows)
    return entry.rows_exact ? t('tables.home.rows', { count: entry.rows, formatted: count }) : t('tables.home.rowsEstimate', { count: entry.rows, formatted: count })
  }

  function columnsLabel(name: string): string | null {
    const columns = schema.data?.tables[name]
    if (columns == null) return null
    return t('tables.home.columnCount', { count: columns.length })
  }

  function accessText(part: AccessPart): string {
    const who = t(`policies.plain.who.${part.who}`)
    if (part.level !== 'partial') return t('tables.home.accessPart', { who, access: t(`policies.plain.access.${part.level}`) })
    const verbs = list.format(part.verbs.map((verb) => t(`policies.plain.verbs.${verb}`)))
    return t('tables.home.accessPart', { who, access: t('policies.plain.access.partial', { verbs }) })
  }

  function toggleSort(key: HomeSortKey) {
    // Names start A→Z; row counts start with the largest tables.
    if (sort.key !== key) {
      sort = { key, desc: key === 'rows' }
      return
    }
    sort = { key, desc: sort.desc === false }
  }

  function ariaSort(key: HomeSortKey): 'ascending' | 'descending' | 'none' {
    if (sort.key !== key) return 'none'
    return sort.desc ? 'descending' : 'ascending'
  }

  // `/` jumps to the search unless the person is typing somewhere else.
  function onWindowKey(event: KeyboardEvent) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
    const input = searchBox?.querySelector('input')
    if (input == null) return
    event.preventDefault()
    input.focus()
  }

  // The whole row opens the table for pointer users; the name link and the
  // menu keep their own behaviour and stay the keyboard targets.
  function openFromRow(event: MouseEvent, name: string) {
    if (event.target instanceof Element && event.target.closest('a, button, [role="menu"]') !== null) return
    navigate(`/tables/${enc(name)}`)
  }

  // Turning protection on without rules hides every row from the API: ask first.
  let enabling = $state<string | null>(null)
  let toEnable = $state<string | null>(null)
  let enableOpen = $state(false)

  function requestEnable(table: TableSummary) {
    if (table.rls.policies > 0) {
      // enableRls already showed the error; nothing else to do here.
      enableRls(table.name).catch(() => undefined)
      return
    }
    toEnable = table.name
    enableOpen = true
  }

  /** Rejects after showing the error, so the confirm dialog stays open. */
  async function enableRls(name: string) {
    if (enabling !== null) return
    enabling = name
    try {
      await ddl.alterTable(name, [{ action: 'set_rls', enabled: true }])
      toast.success(t('policies.rlsEnabled', { table: name }))
      await onchanged()
      loadOverview()
    } catch (error) {
      toast.error(errorMessage(error))
      throw error
    } finally {
      enabling = null
    }
  }

  let toDrop = $state<string | null>(null)
  let dropOpen = $state(false)

  function requestDrop(name: string) {
    toDrop = name
    dropOpen = true
  }

  async function afterDrop() {
    await onchanged()
    loadOverview()
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#snippet pending(loadingNow: boolean)}
  {#if (loadingNow)}<Skeleton class="h-4 w-14" />{/if}
  {#if (loadingNow === false)}<span class="text-muted-foreground">—</span>{/if}
{/snippet}

{#snippet sortHeader(key: HomeSortKey, label: string)}
  <button type="button" class="inline-flex items-center gap-1 rounded-md hover:text-foreground" onclick={() => toggleSort(key)} title={t('tables.home.sortBy', { column: label })}>
    {label}
    {#if (sort.key === key && sort.desc === false)}<ArrowUp class="size-3.5" aria-hidden="true" />{/if}
    {#if (sort.key === key && sort.desc)}<ArrowDown class="size-3.5" aria-hidden="true" />{/if}
  </button>
{/snippet}

{#snippet row(table: TableSummary)}
  {@const entry = details.get(table.name)}
  {@const rows = rowsLabel(entry)}
  {@const columns = columnsLabel(table.name)}
  <tr class="cursor-pointer border-t border-border transition-colors hover:bg-accent/40" onclick={(event) => openFromRow(event, table.name)}>
    <td class="min-w-0 px-4 py-3">
      <a href={href(`/tables/${enc(table.name)}`)} class="block truncate font-medium hover:underline" title={table.name}>{table.name}</a>
      {#if entry?.comment}<p class="truncate text-[0.8125rem] text-muted-foreground" title={entry.comment}>{entry.comment}</p>{/if}
      <!-- Phones have no room for the count columns. -->
      {#if (rows !== null || columns !== null)}<p class="text-xs text-muted-foreground tabular-nums sm:hidden">{[columns, rows].filter((part) => part !== null).join(' · ')}</p>{/if}
    </td>
    <td class={[COLUMN_CLASS.columns, 'px-4 py-3 text-muted-foreground tabular-nums']}>
      {#if (columns !== null)}{columns}{/if}
      {#if (columns === null)}{@render pending(schema.loading)}{/if}
    </td>
    <td class={[COLUMN_CLASS.rows, 'px-4 py-3 tabular-nums']}>
      {#if (rows !== null)}{rows}{/if}
      {#if (rows === null)}{@render pending(overview.loading)}{/if}
    </td>
    <td class={[COLUMN_CLASS.access, 'px-4 py-3']}>
      {#if (entry)}
        {@const parts = accessSummary(entry.grants)}
        {#if (parts.length === 0)}<span class="text-muted-foreground">{t('tables.home.accessBackendOnly')}</span>{/if}
        {#each parts as part (part.who)}<span class="block">{accessText(part)}</span>{/each}
      {/if}
      {#if (entry == null)}{@render pending(overview.loading)}{/if}
    </td>
    <td class={[COLUMN_CLASS.protection, 'px-4 py-3']}>
      {#if (table.rls.state === 'view')}<span class="text-muted-foreground" title={t('policies.plain.stateHint.view')}>{t('tables.home.view')}</span>{/if}
      {#if (table.rls.state !== 'view')}<RlsBadge rls={table.rls} />{/if}
    </td>
    <td class={[COLUMN_CLASS.actions, 'px-2 py-3 text-right']}>
      <TableRowMenu name={table.name} view={isView(table)} ondrop={() => requestDrop(table.name)} />
    </td>
  </tr>
{/snippet}

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if (loading && tables.length === 0)}
    <div class="grid gap-3 p-6 lg:p-8" aria-busy="true">
      <Skeleton class="h-9 w-72" />
      {#each [1, 2, 3, 4] as i (i)}<Skeleton class="h-12 rounded-xl" />{/each}
    </div>
  {/if}
  {#if (loading === false || tables.length > 0) && tables.length === 0}
    <TablesWelcome {oncreate} />
  {/if}
  {#if (loading === false || tables.length > 0) && tables.length > 0}
    <div class="grid gap-5 p-4 sm:p-6 lg:p-8">
      <header class="grid gap-4">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div class="min-w-0">
            <h1 class="flex items-baseline gap-2 text-2xl font-semibold tracking-tight">
              {t('tables.sidebar.heading')}<span class="text-base font-normal text-muted-foreground tabular-nums">{fmt.format(tables.length)}</span>
            </h1>
            <p class="mt-1 text-sm text-muted-foreground">{t('tables.home.hint')}</p>
          </div>
          <Button onclick={oncreate}><Plus aria-hidden="true" />{t('tables.editor.newTable')}</Button>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <div class="w-full sm:w-72" bind:this={searchBox} title={t('tables.home.searchShortcut')}>
            <SearchField bind:value={search} label={t('tables.sidebar.search')} />
          </div>
        </div>
      </header>

      {#if (attention.length > 0)}
        <section class="grid gap-3 rounded-2xl border border-warning/30 bg-warning/5 p-4" aria-labelledby="tables-attention-title">
          <h2 id="tables-attention-title" class="flex items-center gap-2 text-sm font-semibold text-warning">
            <ShieldAlert class="size-4" aria-hidden="true" />{t('tables.home.attention.title', { count: attention.length })}
          </h2>
          <ul class="grid gap-2">
            {#each attention as table (table.name)}
              <li class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <a href={href(`/tables/${enc(table.name)}`)} class="font-mono text-sm font-medium hover:underline">{table.name}</a>
                <span class="min-w-0 flex-1 text-sm text-muted-foreground">{table.rls.label === OWNER_VIEW ? t('policies.ownerViewHint') : t(`policies.plain.stateHint.${table.rls.state}`)}</span>
                {#if (table.rls.state === 'danger' && table.rls.label !== OWNER_VIEW)}
                  <Button size="sm" variant="outline" disabled={enabling !== null} onclick={() => requestEnable(table)}>
                    {#if (enabling === table.name)}<LoaderCircle class="animate-spin" aria-hidden="true" />{/if}
                    {#if (enabling !== table.name)}<ShieldCheck aria-hidden="true" />{/if}
                    {t('policies.enableRls')}
                  </Button>
                {/if}
                {#if (table.rls.state === 'warn')}
                  <Button size="sm" variant="outline" href={href(`/policies?table=${encodeURIComponent(table.name)}`)}>{t('tables.home.attention.createRule')}</Button>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if (recentTables.length > 0)}
        <nav class="flex flex-wrap items-center gap-2" aria-label={t('tables.home.recent')}>
          <span class="flex items-center gap-1.5 text-sm text-muted-foreground"><History class="size-4" aria-hidden="true" />{t('tables.home.recent')}</span>
          {#each recentTables as name (name)}
            <a href={href(`/tables/${enc(name)}`)} class="rounded-full bg-well px-3 py-1 font-mono text-[0.8125rem] transition-colors hover:bg-accent">{name}</a>
          {/each}
        </nav>
      {/if}

      {#if (arranged.tables.length === 0 && arranged.views.length === 0)}
        <p class="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{t('tables.home.noMatches')}</p>
      {/if}
      {#if (arranged.tables.length > 0 || arranged.views.length > 0)}
        <div class="overflow-hidden rounded-2xl border border-border">
          <table class="w-full table-fixed text-sm">
            <caption class="sr-only">{t('tables.sidebar.heading')}</caption>
            <thead class="bg-well text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" class="px-4 py-2.5 font-medium" aria-sort={ariaSort('name')}>{@render sortHeader('name', t('tables.home.columns.table'))}</th>
                <th scope="col" class={[COLUMN_CLASS.columns, 'px-4 py-2.5 font-medium']}>{t('tables.home.columns.columns')}</th>
                <th scope="col" class={[COLUMN_CLASS.rows, 'px-4 py-2.5 font-medium']} aria-sort={ariaSort('rows')}>{@render sortHeader('rows', t('tables.home.columns.rows'))}</th>
                <th scope="col" class={[COLUMN_CLASS.access, 'px-4 py-2.5 font-medium']}>{t('tables.home.columns.access')}</th>
                <th scope="col" class={[COLUMN_CLASS.protection, 'px-4 py-2.5 font-medium']}>{t('tables.home.columns.protection')}</th>
                <th scope="col" class={[COLUMN_CLASS.actions, 'px-2 py-2.5']}><span class="sr-only">{t('tables.home.columns.actions')}</span></th>
              </tr>
            </thead>
            {#if (arranged.tables.length > 0)}
              <tbody>{#each arranged.tables as table (table.name)}{@render row(table)}{/each}</tbody>
            {/if}
            {#if (arranged.views.length > 0)}
              <tbody>
                <!-- One cell per column (no colspan): a span over columns hidden on phones breaks the fixed layout. -->
                <tr class="border-t border-border bg-well/60 text-left text-xs text-muted-foreground">
                  <th scope="rowgroup" class="px-4 py-2 font-medium">{t('tables.home.viewsGroup')}</th>
                  <td class={COLUMN_CLASS.columns}></td><td class={COLUMN_CLASS.rows}></td><td class={COLUMN_CLASS.access}></td><td class={COLUMN_CLASS.protection}></td><td class={COLUMN_CLASS.actions}></td>
                </tr>
                {#each arranged.views as table (table.name)}{@render row(table)}{/each}
              </tbody>
            {/if}
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if toEnable}
  {@const name = toEnable}
  <ConfirmDialog
    bind:open={enableOpen}
    title={t('policies.enableRlsEmpty.title', { table: name })}
    description={t('policies.enableRlsEmpty.description')}
    confirmLabel={t('policies.enableRlsEmpty.confirm')}
    onconfirm={() => enableRls(name)}
  />
{/if}
{#if toDrop}
  <DropTableDialog bind:open={dropOpen} table={toDrop} ondropped={() => void afterDrop()} />
{/if}
