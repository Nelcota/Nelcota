<script lang="ts">
  import DatabaseTabs from '$lib/components/shared/DatabaseTabs.svelte'
  import { Button } from '$lib/components/ui/button'
  import SearchField from '$lib/components/shared/SearchField.svelte'
  import Search from '@lucide/svelte/icons/search'
  import Plus from '@lucide/svelte/icons/plus'
  import Rows3 from '@lucide/svelte/icons/rows-3'
  import RlsDot from '$lib/shared/schema/components/RlsDot.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { href } from '$lib/navigation/router.svelte'
  import { cn } from '$lib/components/utils'
  import type { TableSummary } from '$lib/contracts/types'
  import { t } from '$lib/i18n/index.svelte'

  let {
    tables,
    current,
    oncreate,
    loading = false,
    error = '',
    onretry,
  }: {
    tables: TableSummary[]
    /** Open table (`undefined` = none: on phones the list fills the screen). */
    current?: string
    oncreate: () => void
    loading?: boolean
    error?: string
    onretry: () => void
  } = $props()

  let search = $state('')
  const visible = $derived(tables.filter((table) => table.name.toLowerCase().includes(search.trim().toLowerCase())))

  // Tooltip from the RLS state (the server's label is English).
  function rlsTitle(rls: TableSummary['rls']): string {
    if (rls.state === 'ok') return t('tables.sidebar.rls.ok', { count: rls.policies })
    return t(`tables.sidebar.rls.${rls.state}`)
  }
</script>

<aside
  aria-label={t('tables.sidebar.label')}
  class={cn('w-full shrink-0 flex-col overflow-hidden rounded-3xl bg-card lg:flex lg:w-64 xl:w-72', current ? 'hidden' : 'flex lg:w-64 xl:w-72')}
>
  <div class="grid gap-3 border-b p-4">
    <DatabaseTabs fill />
    <div class="flex items-center justify-between gap-2">
      <svelte:element this={current ? 'p' : 'h1'} class="min-w-0 truncate px-1 text-sm font-semibold">{t('tables.sidebar.title')}</svelte:element>
      <Button variant="outline" size="sm" title={t('tables.sidebar.newTable')} aria-label={t('tables.sidebar.newTable')} onclick={oncreate}>
        <Plus data-icon="inline-start" aria-hidden="true" />{t('tables.sidebar.new')}
      </Button>
    </div>
    <SearchField bind:value={search} label={t('tables.sidebar.search')} />
  </div>
  <p class="flex items-center justify-between px-5 pt-4 pb-2 text-xs font-medium text-muted-foreground">
    {t('tables.sidebar.heading')}<span class="tabular-nums">{visible.length}</span>
  </p>
  <nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3" aria-label={t('tables.sidebar.heading')}>
    {#if error}<LoadError message={error} onretry={onretry} busy={loading} />{/if}
    {#if (loading && !tables.length)}
      {#each Array(4) as _}<Skeleton class="mb-1 h-9 w-full" />{/each}
    {/if}
    {#if !(loading && !tables.length)}
    {#each visible as table (table.name)}
      <a
        href={href(`/tables/${encodeURIComponent(table.name)}`)}
        title={rlsTitle(table.rls)}
        aria-current={table.name === current ? 'page' : undefined}
        class={cn(
          'flex h-11 items-center gap-2.5 rounded-xl px-3.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground md:h-9',
          table.name === current && 'bg-accent font-medium text-foreground',
        )}
      >
        <Rows3 class={['size-4 shrink-0', table.name === current && 'text-brand']} strokeWidth={1.6} />
        <span class="truncate">{table.name}</span>
        <span class="ml-auto flex"><RlsDot state={table.rls.state} /></span>
        {#if table.kind !== 'table'}<span class="text-2xs text-muted-foreground">{t('tables.sidebar.view')}</span>{/if}
      </a>
    {/each}
      {#if !visible.length && !error}
        <EmptyState icon={search.trim() ? Search : Rows3} title={search.trim() ? t('common.noMatches') : t('tables.sidebar.empty')} class="px-3 py-6">
          {#snippet actions()}
            {#if (search.trim())}<Button variant="outline" size="sm" onclick={() => (search = '')}>{t('common.clearSearch')}</Button>
            {/if}
            {#if !(search.trim()) && (!tables.length)}<Button variant="outline" size="sm" onclick={oncreate}><Plus data-icon="inline-start" aria-hidden="true" />{t('tables.sidebar.newTable')}</Button>{/if}
          {/snippet}
        </EmptyState>
      {/if}
    {/if}
  </nav>
</aside>
