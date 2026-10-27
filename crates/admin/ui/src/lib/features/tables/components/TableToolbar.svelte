<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Plus from '@lucide/svelte/icons/plus'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import Funnel from '@lucide/svelte/icons/funnel'
  import Download from '@lucide/svelte/icons/download'
  import Rows3 from '@lucide/svelte/icons/rows-3'
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import RlsBadge from '$lib/shared/schema/components/RlsBadge.svelte'
  import RunAsPicker from '$lib/components/shared/RunAsPicker.svelte'
  import type { RunAsLabels, Viewer } from '$lib/shared/run-as'
  import { enc } from '$lib/transport/api'
  import { href, route } from '$lib/navigation/router.svelte'
  import type { Rls, TableData } from '$lib/contracts/types'
  import { t } from '$lib/i18n/index.svelte'

  let {
    name,
    view,
    data,
    filterCount,
    filterOpen = $bindable(false),
    loading,
    hiddenColumns,
    ontogglecolumn,
    onshowallcolumns,
    exportHref,
    viewing = false,
    onreload,
    oninsert,
    viewer,
    viewerLabels,
    onviewer,
    listedRls,
  }: {
    name: string
    view: 'data' | 'structure'
    data: TableData | null
    filterCount: number
    filterOpen?: boolean
    loading: boolean
    hiddenColumns: string[]
    ontogglecolumn: (column: string) => void
    onshowallcolumns: () => void
    /** "View as" is active; downloads still use full access. */
    viewing?: boolean
    exportHref: (format: 'csv' | 'json') => string
    onreload: () => void
    oninsert: () => void
    viewer: Viewer
    viewerLabels: RunAsLabels
    onviewer: (viewer: Viewer) => void
    /** Protection from the table list: the structure view loads no rows. */
    listedRls?: Rls
  } = $props()

  const rls = $derived(data?.table.rls ?? listedRls)

  const tabs = [
    { view: 'data', icon: Rows3, label: 'tables.toolbar.data', suffix: '' },
    { view: 'structure', icon: Columns3, label: 'tables.toolbar.structure', suffix: '/structure' },
  ] as const
</script>

<!-- Phones: name on top, then the views with "Insert row", then the tools
     on their own row. Wider screens keep everything on one line: the tools and
     "Insert row" stay icon-only (named for screen readers, titled for pointers)
     until the toolbar itself has room for their labels. -->
<div class="@container flex min-h-16 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b bg-card px-4 py-3 sm:px-5 @5xl:gap-x-3">
  <div class="flex min-w-0 items-center gap-2 max-sm:basis-full">
    <a
      href={href('/tables')}
      class="-ml-1 grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
      aria-label={t('tables.toolbar.back')}><ChevronLeft class="size-4" /></a
    >
    <h1 class="min-w-0 truncate text-base font-semibold" title={name}>{name}</h1>
    {#if rls}<RlsBadge {rls} />{/if}
  </div>
  <nav class="panel-segments panel-segments-scroll sm:ml-1" aria-label={t('tables.toolbar.views')}>
    {#each tabs as tab (tab.view)}
      <a
        href={href(`/tables/${enc(name)}${tab.suffix}${route.query.size ? `?${route.query}` : ''}`)}
        aria-current={view === tab.view ? 'page' : undefined}
        class="panel-segment"><tab.icon class="size-4" aria-hidden="true" />{t(tab.label)}</a
      >
    {/each}
  </nav>
  {#if view === 'data'}
    <!-- Who reads, then the tools as plain buttons: one height, no boxes
         around them, a hairline between the two. -->
    <div class="flex min-w-0 flex-wrap items-center gap-2 max-sm:order-last max-sm:basis-full sm:ml-auto">
      <RunAsPicker {viewer} labels={viewerLabels} onchange={onviewer} />
      <span class="h-5 w-px shrink-0 bg-border-strong max-sm:hidden" aria-hidden="true"></span>
      <div class="flex shrink-0 items-center gap-0.5 max-sm:ml-auto">
      <Button
        variant={filterOpen || filterCount ? 'secondary' : 'ghost'}
        size="sm"
        onclick={() => (filterOpen = !filterOpen)}
        aria-expanded={filterOpen}
        title={t('tables.toolbar.filter')}
      >
        <Funnel /><span class="sr-only @5xl:not-sr-only">{t('tables.toolbar.filter')}</span>{#if filterCount}<span class="text-muted-foreground tabular-nums">{filterCount}</span>{/if}
      </Button>
      {#if data}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button variant={hiddenColumns.length ? 'secondary' : 'ghost'} size="sm" title={t('tables.toolbar.columns')} {...props}>
                <Columns3 /><span class="sr-only @5xl:not-sr-only">{t('tables.toolbar.columns')}</span>{#if hiddenColumns.length}<span
                    class="text-muted-foreground tabular-nums"
                    title={t('tables.toolbar.hidden', { count: hiddenColumns.length })}>{hiddenColumns.length}</span
                  >{/if}
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="max-h-96 w-64 overflow-y-auto">
            <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">{t('tables.toolbar.visibleColumns')}</DropdownMenu.Label>
            {#each data.table.columns as column (column.name)}
              <DropdownMenu.CheckboxItem
                checked={!hiddenColumns.includes(column.name)}
                closeOnSelect={false}
                onCheckedChange={() => ontogglecolumn(column.name)}
                class="font-mono text-xs">{column.name}</DropdownMenu.CheckboxItem
              >
            {/each}
            {#if hiddenColumns.length}
              <DropdownMenu.Separator />
              <DropdownMenu.Item onclick={onshowallcolumns}>{t('tables.toolbar.showAll')}</DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button variant="ghost" size="sm" title={t('tables.toolbar.export')} {...props}><Download /><span class="sr-only @5xl:not-sr-only">{t('tables.toolbar.export')}</span></Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-72">
          <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
            {filterCount ? t('tables.toolbar.exportFiltered') : t('tables.toolbar.exportAll')}
          </DropdownMenu.Label>
          {#if viewing}<p class="px-2 pb-1.5 text-xs text-warning">{t('tables.toolbar.exportFullAccess')}</p>{/if}
          {#each [{ format: 'csv', label: 'CSV', hint: t('tables.toolbar.csvHint') }, { format: 'json', label: 'JSON', hint: t('tables.toolbar.jsonHint') }] as const as option (option.format)}
            <DropdownMenu.Item class="flex-col items-start gap-0">
              {#snippet child({ props })}<a {...props} href={exportHref(option.format)} download>
                  <span class="font-medium">{option.label}</span>
                  <span class="text-xs text-muted-foreground">{option.hint}</span>
                </a>{/snippet}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <Button variant="ghost" size="icon-sm" disabled={loading} onclick={onreload} aria-label={t('tables.toolbar.reload')} title={t('tables.toolbar.reload')}>
        <RefreshCw class={loading ? 'animate-spin' : ''} />
      </Button>
      </div>
    </div>
    {#if data?.table.insertable}
      <Button size="sm" class="max-sm:ml-auto sm:@max-5xl:px-2.5" disabled={loading} onclick={oninsert} title={t('tables.toolbar.insertRow')}
        ><Plus aria-hidden="true" /><span class="sm:@max-5xl:sr-only">{t('tables.toolbar.insertRow')}</span></Button
      >
    {/if}
  {/if}
</div>
