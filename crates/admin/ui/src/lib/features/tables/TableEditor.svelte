<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import ShieldAlert from '@lucide/svelte/icons/shield-alert'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import Eye from '@lucide/svelte/icons/eye'
  import { toast } from 'svelte-sonner'
  import TableSidebar from '$lib/features/tables/components/TableSidebar.svelte'
  import TableToolbar from '$lib/features/tables/components/TableToolbar.svelte'
  import FilterChips from '$lib/features/tables/components/FilterChips.svelte'
  import DataGrid from '$lib/features/tables/components/DataGrid.svelte'
  import GridFooter from '$lib/features/tables/components/GridFooter.svelte'
  import SelectionBar from '$lib/features/tables/components/SelectionBar.svelte'
  import GridState from '$lib/features/tables/components/GridState.svelte'
  import RowSheet from '$lib/features/tables/components/RowSheet.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import FilterBar from '$lib/features/tables/components/FilterBar.svelte'
  import CreateTableSheet from '$lib/features/tables/components/CreateTableSheet.svelte'
  import StructureView from '$lib/features/tables/components/StructureView.svelte'
  import TablesHome from '$lib/features/tables/components/TablesHome.svelte'
  import { readText, write } from '$lib/browser/local-storage'
  import { api, enc, ApiError } from '$lib/transport/api'
  import type { RunAsLabels, Viewer } from '$lib/shared/run-as'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { HiddenColumns } from '$lib/features/tables/hidden-columns.svelte'
  import { filtersParam, filtersToSearch, parseFilters, type TableFilter } from '$lib/features/tables/filters'
  import { href, navigate, route } from '$lib/navigation/router.svelte'
  import { cn } from '$lib/components/utils'
  import { TableRows } from '$lib/features/tables/table-rows.svelte'
  import { tableRowsApi } from '$lib/features/tables/api'
  import { parseTableView, tableViewSearch, type TableView } from '$lib/features/tables/table-view'
  import type { Column, RowData, TablesResponse } from '$lib/contracts/types'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  let { name, view = 'data' }: { name?: string; view?: 'data' | 'structure' } = $props()

  const tablesResource = new RemoteResource<TablesResponse>()
  const tables = $derived(tablesResource.data?.tables ?? [])
  const tablesLoading = $derived(tablesResource.loading)
  const tablesError = $derived(tablesResource.error ? errorMessage(tablesResource.error) : '')
  const emptyCatalog = $derived(tablesResource.loaded && !tablesLoading && !tablesError && !tables.length && !name)
  const rows = new TableRows(tableRowsApi)
  let active = true
  const data = $derived(rows.data)
  const loading = $derived(rows.loading)
  const savingCell = $derived(rows.saving)
  // Who the grid reads as (not persisted: a reload goes back to full access).
  let viewer = $state<Viewer>({ mode: 'owner', user: null })
  const viewing = $derived(viewer.mode !== 'owner')
  const viewerLabels: RunAsLabels = $derived({
    label: t('tables.viewAs.label'),
    owner: t('tables.viewAs.owner'),
    ownerHint: t('tables.viewAs.ownerHint'),
    anon: t('tables.viewAs.anon'),
    anonHint: t('tables.viewAs.anonHint'),
    authenticated: t('tables.viewAs.authenticated'),
    authenticatedHint: t('tables.viewAs.authenticatedHint'),
    asVisitor: t('tables.viewAs.asVisitor'),
    asUser: (email: string) => t('tables.viewAs.asUser', { email }),
    ownerTrigger: t('tables.viewAs.ownerTrigger'),
    pickTitle: t('tables.viewAs.pickTitle'),
    search: t('tables.viewAs.search'),
    empty: t('tables.viewAs.empty'),
    noUsers: t('tables.viewAs.noUsers'),
    loading: t('tables.viewAs.loading'),
  })
  // A role without a GRANT is the answer to "what do they see", not a failure.
  const denied = $derived.by(() => {
    const failure = rows.error
    if (!(failure instanceof ApiError) || failure.code !== 'view_denied') return ''
    return failure.params?.role === 'anon' ? t('tables.viewAs.denied.anon') : t('tables.viewAs.denied.authenticated')
  })
  const error = $derived(rows.error && !denied ? errorMessage(rows.error) : '')

  function setViewer(next: Viewer) {
    rows.clear()
    viewer = next
  }
  const tableView = $derived(parseTableView(route.query))
  const page = $derived(tableView.page)
  const size = $derived(tableView.size)
  const sort = $derived(tableView.sort)
  const selected = $derived(rows.selected)

  let sheetOpen = $state(false)
  let sheetRow = $state<RowData | null>(null)
  let confirmOpen = $state(false)
  let filterOpen = $state(false)
  let filterPreset = $state<string | undefined>(undefined)
  let createOpen = $state(false)

  // Hidden columns, remembered per table.
  const hidden = new HiddenColumns()
  $effect(() => {
    if (name) hidden.load(name)
  })
  $effect(() => {
    if (data) hidden.prune(data.table.columns.map((c) => c.name))
  })

  // Filters come from the URL (`?price=gte.10`): links can be shared and the
  // browser's back button works. The text key avoids reloading without a real change.
  const filters = $derived(parseFilters(route.query))
  const filtersKey = $derived(filtersToSearch(filters))

  // The last table opened in this browser, offered again on the list page.
  const LAST_TABLE = 'nelcota:tables-last'
  let lastTable = $state<string | null>(readText(LAST_TABLE, '') || null)
  $effect(() => {
    if (!name || name === lastTable) return
    lastTable = name
    write(LAST_TABLE, name)
  })

  async function loadTables() {
    if (!active) return
    await tablesResource.load(signal => api.get<TablesResponse>('/tables', { signal }))
  }

  onMount(() => {
    loadTables()
    if (route.query.get('create') === 'true') {
      createOpen = true
      navigate('/tables', true)
    }
    return () => { active = false; tablesResource.cancel() }
  })

  async function onCreated(table: string) {
    const origin = route.revision
    if (!active) return
    await loadTables()
    if (!active || route.revision !== origin) return
    navigate(`/tables/${enc(table)}`)
  }

  async function onRenamed(table: string) {
    const origin = route.revision
    if (!active) return
    await loadTables()
    if (!active || route.revision !== origin) return
    navigate(`/tables/${enc(table)}/structure`, true)
  }

  async function onDropped() {
    const origin = route.revision
    if (!active) return
    await loadTables()
    if (!active || route.revision !== origin) return
    navigate('/tables')
  }

  /** Current order and filters, in the API format (listing and export). */
  function rowsParams(): URLSearchParams {
    const params = new URLSearchParams()
    if (sort) {
      params.set('sort', sort.column)
      if (sort.desc) params.set('desc', 'true')
    }
    const f = filtersParam(filters)
    if (f) params.set('filters', f)
    return params
  }

  async function load() {
    if (!active) return
    rows.setTable(name)
    if (!name || view !== 'data') return
    const params = rowsParams()
    params.set('page', String(page))
    params.set('size', size)
    if (viewer.mode !== 'owner') params.set('as', viewer.mode)
    if (viewer.mode === 'authenticated' && viewer.user) params.set('user', viewer.user.id)
    await rows.load(name, params)
  }

  // Reload when the table, page, size, sort or filters change.
  $effect(() => {
    void [name, view, page, size, sort?.column, sort?.desc, filtersKey, viewer.mode, viewer.user?.id]
    untrack(load)
    return () => rows.cancel()
  })

  function setFilters(next: TableFilter[]) {
    filterOpen = false
    filterPreset = undefined
    const search = tableViewSearch(new URLSearchParams(filtersToSearch(next)), { page: 0, size, sort })
    navigate(`/tables/${enc(name!)}${search ? `?${search}` : ''}`)
  }

  const exportHref = (format: 'csv' | 'json') => {
    const params = rowsParams()
    params.set('format', format)
    return href(`/api/tables/${enc(name!)}/export?${params}`)
  }

  /** Link to the row referenced by the foreign key. */
  const referenceHref = (column: Column, value: string) =>
    href(
      `/tables/${enc(column.references!.table)}?${filtersToSearch([{ column: column.references!.column, op: 'eq', value }])}`,
    )

  function toggleSort(column: string) {
    updateView({ page: 0, sort: sort?.column === column ? (sort.desc ? null : { column, desc: true }) : { column, desc: false } })
  }

  function setSort(column: string, direction: 'asc' | 'desc' | null) {
    updateView({ page: 0, sort: direction ? { column, desc: direction === 'desc' } : null })
  }

  function updateView(patch: Partial<TableView>) {
    const search = tableViewSearch(route.query, patch)
    navigate(`/tables/${enc(name!)}${search ? `?${search}` : ''}`)
  }

  /** Column menu: opens the filter bar with a row for that column. */
  function filterBy(column: string) {
    filterPreset = column
    filterOpen = true
  }

  async function commitCell(pk: RowData, column: string, value: string | null) {
    try {
      const count = await rows.edit(pk, column, value)
      if (count !== undefined) toast.success(t('tables.toast.rowsUpdated', { count }))
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
  }

  async function deleteSelected() {
    try {
      const count = await rows.deleteSelected()
      if (count !== undefined) toast.success(t('tables.toast.rowsDeleted', { count }))
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
  }

  function openSheet(row: RowData | null) {
    sheetRow = row
    sheetOpen = true
  }
</script>

<div class={cn("mx-auto flex h-full min-h-0 w-full max-w-page px-4 pt-1 pb-4 sm:px-6 lg:px-8", emptyCatalog ? "flex-col" : "gap-3")}>
  {#if !emptyCatalog}
    <TableSidebar {tables} current={name} loading={tablesLoading} error={tablesError} onretry={loadTables} oncreate={() => (createOpen = true)} />
  {/if}

  <section class={cn('min-h-0 min-w-0 flex-1 flex-col overflow-hidden', emptyCatalog ? 'flex' : 'rounded-3xl bg-card', !emptyCatalog && (name ? 'flex' : 'hidden lg:flex'))}>
    {#if !name && !tablesError}
      <TablesHome {tables} loading={tablesLoading || !tablesResource.loaded} last={lastTable} oncreate={() => (createOpen = true)} />
    {/if}
    {#if !(!name)}
      <TableToolbar
        {name}
        {view}
        {data}
        filterCount={filters.length}
        bind:filterOpen
        loading={loading || savingCell}
        hiddenColumns={hidden.names}
        ontogglecolumn={(column) => hidden.toggle(column)}
        onshowallcolumns={() => hidden.showAll()}
        {exportHref}
        onreload={load}
        oninsert={() => openSheet(null)}
        {viewer}
        {viewerLabels}
        onviewer={setViewer}
        listedRls={tables.find((entry) => entry.name === name)?.rls}
      />

      {#if (view === 'structure')}
        <div class="min-h-0 flex-1 overflow-auto">
          <StructureView {name} policies={tables.find((entry) => entry.name === name)?.rls.policies} onrenamed={onRenamed} ondropped={onDropped} onaltered={loadTables} />
        </div>
      {/if}
      {#if !(view === 'structure')}
        {#if (filterOpen && data)}
          {#key filterPreset}
            <FilterBar
              columns={data.table.columns}
              {filters}
              preset={filterPreset}
              onapply={setFilters}
              onclose={() => {
                filterOpen = false
                filterPreset = undefined
              }}
            />
          {/key}
        {/if}
        {#if !(filterOpen && data) && (filters.length || sort)}
          <FilterChips {filters} {sort} onchange={setFilters} onclearsort={() => setSort('', null)} />
        {/if}

        {#if data && selected.size > 0}
          <SelectionBar
            table={name}
            columns={data.table.columns.map((c) => c.name)}
            rows={[...selected].sort((a, b) => a - b).map((i) => data!.rows[i]).filter(Boolean)}
            deletable={data.table.editable && !loading && !savingCell}
            onclear={() => (rows.selected = new Set())}
            ondelete={() => (confirmOpen = true)}
          />
        {/if}

        {#if (viewing)}
          <p class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
            <Eye class="size-4 shrink-0" aria-hidden="true" />
            <span>{viewer.mode === 'anon' ? t('tables.viewAs.bannerVisitor') : t('tables.viewAs.bannerUser', { email: viewer.user?.email ?? '' })}</span>
            <button type="button" class="cursor-pointer text-foreground underline underline-offset-4" onclick={() => setViewer({ mode: 'owner', user: null })}>{t('tables.viewAs.back')}</button>
          </p>
        {/if}
        {#if !(viewing) && (data?.table.exposed_without_rls)}
          <p class="flex items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
            <ShieldAlert class="size-4 shrink-0" />{t(data.table.kind === 'table' ? 'tables.editor.noRls' : 'tables.editor.noRowProtection')}
          </p>
        {/if}
        {#if !(viewing) && !(data?.table.exposed_without_rls) && (data && !data.table.editable && data.table.kind === 'table')}
          <p class="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
            <KeyRound class="size-4 shrink-0" />{t('tables.editor.noPrimaryKey')}
          </p>
        {/if}

        <div class="relative min-h-0 flex-1 overflow-auto" aria-busy={loading || savingCell}>
          <!-- Reload (order, filter, page): a bar at the top and a dimmed grid,
               so the old data does not look like the new one. -->
          {#if (loading || savingCell) && data}
            <div class="pointer-events-none sticky top-0 z-20 h-0.5 overflow-hidden bg-brand/15" aria-hidden="true">
              <div class="animate-progress h-full w-2/5 bg-brand"></div>
            </div>
          {/if}
          {#if (denied)}
            <p class="mx-auto max-w-xl p-8 text-center text-sm text-muted-foreground">{denied}</p>
          {/if}
          {#if !(denied) && (error && !data)}
            <GridState state="error" message={error} onretry={load} />
          {/if}
          {#if !(denied) && !(error && !data) && (!data)}
            <GridState state="loading" />
          {/if}
          {#if !(denied) && !(error && !data) && !(!data)}
            {#if error}<GridState state="error" message={error} onretry={load} />{/if}
            <div class={['transition-opacity', loading && 'opacity-60']}>
              <DataGrid
                {data}
                disabled={loading || savingCell}
                {sort}
                hidden={hidden.names}
                bind:selected={rows.selected}
                onsort={toggleSort}
                onsortset={setSort}
                onfilter={filterBy}
                onhide={(column) => hidden.hide(column)}
                onexpand={openSheet}
                oncommit={commitCell}
                {referenceHref}
              />
            </div>
            {#if data.rows.length === 0}
              {#if (filters.length)}
                <GridState state="no-match" onclearfilters={() => setFilters([])} />
              {/if}
              {#if !(filters.length) && (viewing)}
                <p class="p-8 text-center text-sm text-muted-foreground">{t('tables.viewAs.hidden')}</p>
              {/if}
              {#if !(filters.length) && !(viewing)}
                <GridState state="empty" table={name} insertable={data.table.insertable} oninsert={() => openSheet(null)} />
              {/if}
            {/if}
          {/if}
        </div>

        {#if data}<GridFooter {data} {page} {size} disabled={loading || savingCell} onpage={(page) => updateView({ page })} onsize={(size) => updateView({ page: 0, size })} />{/if}
      {/if}
    {/if}
  </section>
</div>

<CreateTableSheet bind:open={createOpen} oncreated={onCreated} />

{#if data && name}
  <RowSheet
    bind:open={sheetOpen}
    table={name}
    columns={data.table.columns}
    primaryKey={data.table.primary_key}
    row={sheetRow}
    onsaved={load}
  />
  <ConfirmDialog
    bind:open={confirmOpen}
    title={t('tables.editor.deleteTitle', { count: selected.size })}
    description={t('tables.editor.deleteDescription')}
    confirmLabel={t('common.delete')}
    destructive
    onconfirm={deleteSelected}
  />
{/if}
