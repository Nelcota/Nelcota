<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import Plus from '@lucide/svelte/icons/plus'
  import History from '@lucide/svelte/icons/history'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import TableProperties from '@lucide/svelte/icons/table-properties'
  import RlsBadge from '$lib/shared/schema/components/RlsBadge.svelte'
  import TablesWelcome from './TablesWelcome.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api, enc } from '$lib/transport/api'
  import { href } from '$lib/navigation/router.svelte'
  import type { Overview, TableSummary } from '$lib/contracts/types'
  import { intlLocale, t } from '$lib/i18n/index.svelte'

  // What the editor shows with no table open. Beside the sidebar's list of
  // names it adds size, protection, a way straight to the structure and the
  // table the person was last working on; on phones it replaces the list.
  let {
    tables,
    loading,
    last,
    oncreate,
  }: {
    tables: TableSummary[]
    loading: boolean
    /** Last table opened in this browser, if it still exists. */
    last: string | null
    oncreate: () => void
  } = $props()

  // Row counts come from the overview; without them the cards still work.
  const overview = new RemoteResource<Overview>()
  onMount(() => {
    overview.load((signal) => api.get<Overview>('/overview', { signal }))
    return () => overview.cancel()
  })
  const counts = $derived(new Map((overview.data?.tables ?? []).map((table) => [table.name, table])))
  const fmt = $derived(new Intl.NumberFormat(intlLocale()))
  const resume = $derived(last && tables.some((table) => table.name === last) ? last : null)

  function rowsLabel(name: string): string | null {
    const entry = counts.get(name)
    if (!entry || entry.rows === null) return null
    const count = fmt.format(entry.rows)
    return entry.rows_exact ? t('tables.home.rows', { count: entry.rows, formatted: count }) : t('tables.home.rowsEstimate', { count: entry.rows, formatted: count })
  }
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if (loading && !tables.length)}
    <div class="grid gap-4 p-6 lg:p-8" aria-busy="true">
      <Skeleton class="h-12 w-48" />
      <div class="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {#each [1, 2, 3, 4] as i (i)}<Skeleton class="h-32 rounded-3xl" />{/each}
      </div>
    </div>
  {/if}
  {#if !(loading && !tables.length) && (!tables.length)}
    <TablesWelcome {oncreate} />
  {/if}
  {#if !(loading && !tables.length) && !(!tables.length)}
    <div class="grid gap-6 p-4 sm:p-6 lg:p-8">
      <!-- Wide screens title the page in the sidebar, which phones hide here. -->
      <h1 class="sr-only lg:hidden">{t('tables.sidebar.heading')}</h1>
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div class="min-w-0">
          <h2 class="flex items-baseline gap-2">
            <span class="text-4xl font-semibold tracking-tight tabular-nums">{fmt.format(tables.length)}</span>
            <span class="text-base font-medium text-muted-foreground">{t('tables.home.count', { count: tables.length })}</span>
          </h2>
          <p class="mt-1 text-sm text-muted-foreground">{t('tables.home.hint')}</p>
        </div>
        <Button variant="outline" onclick={oncreate}><Plus />{t('tables.editor.newTable')}</Button>
      </header>

      {#if resume}
        <a
          href={href(`/tables/${enc(resume)}`)}
          class="group flex items-center gap-3 rounded-2xl bg-well py-2 pr-4 pl-2 text-sm transition-colors hover:bg-accent"
        >
          <span class="grid size-9 shrink-0 place-items-center rounded-full bg-card text-muted-foreground"><History class="size-4" aria-hidden="true" /></span>
          <span class="min-w-0 flex-1 truncate">
            <span class="text-muted-foreground">{t('tables.home.resume')}</span>
            <span class="font-medium">{resume}</span>
          </span>
          <ArrowRight class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </a>
      {/if}

      <ul class="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3" aria-label={t('tables.sidebar.heading')}>
        {#each tables as table (table.name)}
          {@const rows = rowsLabel(table.name)}
          <li class="relative flex min-w-0 flex-col gap-3 rounded-3xl bg-well p-5 transition-colors focus-within:bg-accent/60 hover:bg-accent/60">
            <div class="flex min-w-0 items-start justify-between gap-3">
              <!-- The name's link covers the card; the structure link sits above it. -->
              <a href={href(`/tables/${enc(table.name)}`)} class="min-w-0 truncate text-base font-semibold outline-none after:absolute after:inset-0 after:rounded-3xl focus-visible:after:ring-2 focus-visible:after:ring-ring" title={table.name}>{table.name}</a>
              <RlsBadge rls={table.rls} />
            </div>
            <div class="mt-auto flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span class="tabular-nums">
                {#if (rows)}{rows}{/if}
                {#if !(rows) && (overview.loading)}<Skeleton class="h-4 w-20" />{/if}
                {#if !(rows) && !(overview.loading) && (table.kind !== 'table')}{t('tables.home.view')}{/if}
              </span>
              <a
                href={href(`/tables/${enc(table.name)}/structure`)}
                class="relative z-[1] inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground"
                aria-label={t('tables.home.structureOf', { table: table.name })}
              ><TableProperties class="size-3.5" aria-hidden="true" />{t('tables.toolbar.structure')}</a>
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
