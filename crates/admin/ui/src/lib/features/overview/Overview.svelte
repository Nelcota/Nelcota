<script lang="ts">
  import { dateText } from '$lib/formatting/date'
  import { onMount } from 'svelte'
  import * as Table from '$lib/components/ui/table'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Button } from '$lib/components/ui/button'
  import Database from '@lucide/svelte/icons/database'
  import Users from '@lucide/svelte/icons/users'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import Plus from '@lucide/svelte/icons/plus'
  import UserPlus from '@lucide/svelte/icons/user-plus'
  import Plug from '@lucide/svelte/icons/plug'
  import TechnicalToggle from '$lib/shared/schema/components/TechnicalToggle.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import TrafficChart from '$lib/features/overview/components/TrafficChart.svelte'
  import Ring from '$lib/features/overview/components/Ring.svelte'
  import Meter from '$lib/features/overview/components/Meter.svelte'
  import MiniBars from '$lib/features/overview/components/MiniBars.svelte'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'
  import Download from '@lucide/svelte/icons/download'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import Check from '@lucide/svelte/icons/check'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api } from '$lib/transport/api'
  import { href } from '$lib/navigation/router.svelte'
  import { downloadText } from '$lib/browser/download'
  import { toCsv } from '$lib/formatting/tabular'
  import { attention, nextSteps } from '$lib/features/overview/next-steps'
  import { blockReason, blockTarget } from '$lib/features/policies/blocked'
  import { groupSums, percent } from '$lib/features/overview/chart'
  import type { DeniedRequests, MetricsResponse, Overview } from '$lib/contracts/types'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'

  // Resource cards and traffic share the existing requests and lifecycle.
  const overview = new RemoteResource<Overview>()
  const metrics = new RemoteResource<MetricsResponse>()
  const denied = new RemoteResource<DeniedRequests>()
  const data = $derived(overview.data)
  const traffic = $derived(metrics.data)
  let range = $state<'1h' | '24h'>('24h')
  let show = $state<'all' | 'requests' | 'refused'>('all')
  let tableView = $state(false)

  async function loadOverview() {
    await overview.load((signal) => api.get<Overview>('/overview', { signal }))
  }
  // Until the person picks a period, a server counting for under two hours
  // opens on the last hour: a day of it would be two points and a ramp.
  let picked = false
  async function loadMetrics() {
    await metrics.load((signal) => api.get<MetricsResponse>(`/metrics?range=${range}`, { signal }))
    const counted = metrics.data ? Date.now() - new Date(metrics.data.since).getTime() : Infinity
    if (!picked && range === '24h' && counted < 2 * 3_600_000) {
      range = '1h'
      await metrics.load((signal) => api.get<MetricsResponse>('/metrics?range=1h', { signal }))
    }
  }
  async function loadDenied() {
    await denied.load((signal) => api.get<DeniedRequests>('/denied', { signal }))
  }

  onMount(() => {
    void loadOverview()
    void loadMetrics()
    void loadDenied()
    // Traffic moves on its own: refresh it every minute while the page is open.
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadMetrics()
      void loadDenied()
    }, 60_000)
    return () => {
      clearInterval(timer)
      overview.cancel()
      metrics.cancel()
      denied.cancel()
    }
  })

  function choose(next: '1h' | '24h') {
    picked = true
    if (range === next) return
    range = next
    void loadMetrics()
  }

  const fmt = $derived(new Intl.NumberFormat(intlLocale()))
  const format = (n: number) => fmt.format(n)
  const time = $derived(new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }))
  const stamp = $derived(new Intl.DateTimeFormat(intlLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
  const periodText = $derived(range === '1h' ? t('overview.period.textHour') : t('overview.period.textDay'))
  const since = $derived(traffic ? dateText(traffic.since, stamp.format) : '')

  // The chart starts when counting started: a server up for ten minutes shows
  // ten minutes, not a flat day with a spike at the end.
  const chartPoints = $derived.by(() => {
    if (!traffic) return []
    const start = new Date(traffic.since).getTime() - 60_000
    const counted = traffic.points.filter((point) => new Date(point.at).getTime() >= start)
    return counted.length >= 2 ? counted : traffic.points
  })

  const tables = $derived(data ? data.tables.filter((table) => table.kind === 'table') : [])
  const protectedCount = $derived(tables.filter((table) => table.rls.state === 'ok').length)
  const protectedShare = $derived(percent(tables.filter((table) => table.rls.state === 'ok').length, tables.length))
  const signedInShare = $derived(data ? percent(data.counts.signed_in_users, data.counts.users) : 0)
  // Twelve bars across the period, the current one in the accent.
  const refusedBars = $derived(traffic ? groupSums(traffic.points.map((p) => p.refused), Math.ceil(traffic.points.length / 12)) : [])
  const refusedLabels = $derived(
    traffic ? traffic.points.filter((_, i) => i % Math.ceil(traffic.points.length / 12) === 0).map((p) => dateText(p.at, time.format)) : [],
  )

  const totalRows = $derived(data ? data.tables.reduce((sum, table) => sum + (table.rows ?? 0), 0) : 0)
  const byRows = $derived(data ? [...data.tables].sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0)).slice(0, 4) : [])
  const allSteps = $derived(data ? nextSteps(data) : [])
  const steps = $derived(allSteps.filter((step) => !step.done))
  const alerts = $derived(data ? attention(data) : { exposed: [], locked: [] })
  const needs = $derived([
    ...alerts.exposed.map((table) => ({ key: `e-${table}`, title: t('overview.attention.exposed', { table }), text: t('overview.attention.exposedHint'), path: `/policies?table=${encodeURIComponent(table)}` })),
    ...alerts.locked.map((table) => ({ key: `l-${table}`, title: t('overview.attention.blocked', { table }), text: t('overview.attention.blockedHint'), path: `/policies?table=${encodeURIComponent(table)}` })),
  ])
  const recentBlocks = $derived(denied.data ? denied.data.requests.slice(0, 5) : [])

  function download() {
    if (!traffic) return
    const rows = traffic.points.map((p) => [p.at, String(p.requests), String(p.refused), String(p.errors), p.p95_ms === null ? null : String(p.p95_ms)])
    downloadText(`nelcota-trafego-${range}.csv`, toCsv(['at', 'requests', 'refused', 'errors', 'p95_ms'], rows), 'text/csv')
  }

  const card = 'min-w-0 rounded-xl bg-card p-5'
  // The arrow repeats the card's first footer link: a pointer shortcut kept out
  // of the tab order and the accessibility tree, so the destination is reached once.
  const statLink = 'grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
  // 24px tall at least: a comfortable target for small text links (WCAG 2.5.8).
  const footerLink = 'inline-flex min-h-6 items-center py-1 hover:text-foreground'
</script>

{#snippet cardHeader(title: string, path: string)}
  <div class="flex items-center justify-between gap-3">
    <h2 class="text-sm font-medium text-muted-foreground">{title}</h2>
    <a href={href(path)} class="grid size-10 place-items-center rounded-xl bg-secondary text-muted-foreground transition-colors hover:text-foreground" aria-label={`${t('overview.open')}: ${title}`}>
      <Maximize2 class="size-4" aria-hidden="true" />
    </a>
  </div>
{/snippet}

<div class="@container grid gap-5 mx-auto w-full max-w-page px-4 pt-6 pb-10 sm:px-6 lg:px-8">
  <!-- Real project actions and period totals remain available at every width. -->
  <section class="grid min-w-0 gap-5 @min-[60rem]:grid-cols-2 @min-[60rem]:items-center">
    <div class="grid gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">{t('overview.title')}</h1>
      <nav class="flex flex-wrap gap-2" aria-label={t('overview.quickActions')}>
        <Button size="sm" href={href('/tables?create=true')}><Plus data-icon="inline-start" aria-hidden="true" />{t('tables.editor.newTable')}</Button>
        <Button variant="outline" size="sm" href={href('/users?create=true')}><UserPlus data-icon="inline-start" aria-hidden="true" />{t('users.new')}</Button>
        <Button variant="outline" size="sm" href={href('/connect')}><Plug data-icon="inline-start" aria-hidden="true" />{t('connect.start')}</Button>
      </nav>
    </div>
    {#if (traffic)}
      <div class="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] items-end gap-5 rounded-xl bg-card px-5 py-4">
        <div class="grid min-w-0 gap-2">
          <p class="text-sm text-muted-foreground">{t('overview.hero.requests')}</p>
          <p class="text-2xl leading-none font-semibold tabular-nums [overflow-wrap:anywhere]">{fmt.format(traffic.totals.requests)}</p>
        </div>
        <div class="grid min-w-0 gap-2">
          <p class="text-sm text-muted-foreground">{t('overview.hero.refused')}</p>
          <Meter label={t('overview.hero.refused')} part={traffic.totals.refused} whole={traffic.totals.requests} {format} />
        </div>
        <div class="grid min-w-0 gap-2">
          <p class="text-sm text-muted-foreground">{t('overview.hero.errors')}</p>
          <Meter label={t('overview.hero.errors')} part={traffic.totals.errors} whole={traffic.totals.requests} {format} tone="destructive" />
        </div>
      </div>
    {/if}
    {#if !(traffic) && (metrics.loading)}
      <Skeleton class="h-16 w-[40rem] max-w-full rounded-2xl" />
    {/if}
  </section>

  {#if needs.length > 0}
    <a href={href('/policies')} class="flex items-center gap-3 rounded-2xl bg-warning/10 px-4 py-3 font-medium text-warning">
      <CircleAlert class="size-5 shrink-0" aria-hidden="true" />
      <span>{t('overview.needs.title')} · {fmt.format(needs.length)}</span>
      <ArrowUpRight class="ml-auto size-5 shrink-0" aria-hidden="true" />
    </a>
  {/if}

  <section class="resource-canvas" aria-label={t('overview.resources')}>
    {#if overview.error}<div class="resource-error min-w-0"><LoadError message={errorMessage(overview.error)} onretry={loadOverview} busy={overview.loading} /></div>{/if}
      {#if (data)}
        <article class={card}>
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span class="flex items-center gap-2 font-medium text-foreground"><Database class="size-4 text-sky-500 dark:text-sky-400" aria-hidden="true" />{t('overview.cards.database')}</span>
            <a href={href('/tables')} class={statLink} tabindex="-1" aria-hidden="true" title={t('overview.cards.open', { page: t('shell.pages.tables') })}><ArrowUpRight class="size-4" aria-hidden="true" /></a>
          </div>
          <div class="mt-4 flex items-end justify-between gap-4">
            <div class="grid gap-1">
              <p class="text-sm text-muted-foreground">{t('overview.cards.tables')}</p>
              <p class="text-3xl leading-none font-semibold tracking-[-0.03em]">{fmt.format(data.counts.tables)}</p>
              <p class="text-xs text-muted-foreground">{t('overview.cards.tablesCaption', { count: protectedCount })}</p>
            </div>
            <Ring value={protectedShare} label={t('overview.cards.tablesRing', { percent: protectedShare })} />
          </div>
          <div class="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
            <a class={footerLink} href={href('/tables')}>{t('overview.tables.openEditor')}</a>
            <a class={footerLink} href={href('/sql')}>{t('shell.pages.sql')}</a>
            <a class={footerLink} href={href('/migrations')}>{t('shell.pages.migrations')}</a>
          </div>
        </article>
        <article class={card}>
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span class="flex items-center gap-2 font-medium text-foreground"><Users class="size-4 text-violet-600 dark:text-violet-400" aria-hidden="true" />{t('overview.cards.auth')}</span>
            <a href={href('/users')} class={statLink} tabindex="-1" aria-hidden="true" title={t('overview.cards.open', { page: t('shell.pages.users') })}><ArrowUpRight class="size-4" aria-hidden="true" /></a>
          </div>
          <div class="mt-4 flex items-end justify-between gap-4">
            <div class="grid gap-1">
              <p class="text-sm text-muted-foreground">{t('overview.cards.users')}</p>
              <p class="text-3xl leading-none font-semibold tracking-[-0.03em]">{fmt.format(data.counts.users)}</p>
              <p class="text-xs text-muted-foreground">{t('overview.cards.usersCaption', { count: data.counts.signed_in_users })}</p>
            </div>
            <Ring value={signedInShare} label={t('overview.cards.usersRing', { percent: signedInShare })} />
          </div>
          <div class="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
            <a class={footerLink} href={href('/users')}>{t('shell.pages.users')}</a>
            <a class={footerLink} href={href('/sign-in')}>{t('shell.pages.userSignIn')}</a>
          </div>
        </article>
      {/if}
      {#if !data && overview.loading}
        <Skeleton class="h-36 rounded-3xl" />
        <Skeleton class="h-36 rounded-3xl" />
      {/if}
      {#if (traffic)}
        <article class={card}>
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span class="flex items-center gap-2 font-medium text-foreground"><ShieldCheck class="size-4 text-success" aria-hidden="true" />{t('overview.resourcesAccess')}</span>
            <a href={href('/policies')} class={statLink} tabindex="-1" aria-hidden="true" title={t('overview.cards.open', { page: t('shell.pages.policies') })}><ArrowUpRight class="size-4" aria-hidden="true" /></a>
          </div>
          <div class="mt-4 flex items-end justify-between gap-4">
            <div class="grid gap-1">
              <p class="text-sm text-muted-foreground">{t('overview.cards.refused')}</p>
              <p class="text-3xl leading-none font-semibold tracking-[-0.03em]">{fmt.format(traffic.totals.refused)}</p>
            </div>
            <MiniBars values={refusedBars} labels={refusedLabels} describe={t('overview.cards.refusedBars', { total: fmt.format(refusedBars.reduce((sum, value) => sum + value, 0)) })} />
          </div>
          <div class="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
            <a class={footerLink} href={href('/policies')}>{t('shell.pages.policies')}</a>
            <a class={footerLink} href={href('/connect')}>{t('shell.pages.connect')}</a>
          </div>
        </article>
      {/if}
      {#if !traffic && metrics.loading}
        <Skeleton class="h-36 rounded-3xl" />
      {/if}
  </section>

  <!-- One period for the whole page. -->
  <section class="flex flex-wrap items-center justify-between gap-3">
    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span>{since ? `${periodText} · ${t('overview.period.since', { date: since })}` : periodText}</span>
      <TechnicalToggle />
    </p>
    <div class="panel-segments" role="group" aria-label={t('overview.period.label')}>
      <button type="button" class="panel-segment" aria-pressed={range === '1h'} onclick={() => choose('1h')}>{t('overview.period.hour')}</button>
      <button type="button" class="panel-segment" aria-pressed={range === '24h'} onclick={() => choose('24h')}>{t('overview.period.day')}</button>
    </div>
  </section>


  <!-- Lead with traffic on phones; supplementary stats follow in source order. -->
  <section class="grid min-w-0 gap-4">
    <article class={['grid min-w-0 content-start gap-4', card]}>
      <div class="flex flex-wrap items-center gap-2">
        <div class="panel-segments" role="group" aria-label={t('overview.filters.label')}>
          <button type="button" class="panel-segment" aria-pressed={show === 'all'} onclick={() => (show = 'all')}>{t('overview.filters.all')}</button>
          <button type="button" class="panel-segment" aria-pressed={show === 'requests'} onclick={() => (show = 'requests')}>
            <span class="mr-1.5 inline-block size-2 rounded-full bg-chart-1 align-middle" aria-hidden="true"></span>{t('overview.filters.requests')}
          </button>
          <button type="button" class="panel-segment" aria-pressed={show === 'refused'} onclick={() => (show = 'refused')}>
            <span class="mr-1.5 inline-block size-2 rounded-full bg-chart-2 align-middle" aria-hidden="true"></span>{t('overview.filters.refused')}
          </button>
        </div>
        <div class="ml-auto flex items-center gap-3">
          {#if traffic?.totals.p95_ms != null}
            <span class="text-sm text-muted-foreground tabular-nums">{t('overview.traffic.p95Title', { ms: fmt.format(traffic.totals.p95_ms) })}</span>
          {/if}
          <button
            type="button"
            class="grid size-10 cursor-pointer place-items-center rounded-xl border border-border-strong text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            onclick={download}
            disabled={!traffic}
            aria-label={t('overview.download')}
            title={t('overview.download')}><Download class="size-4" aria-hidden="true" /></button
          >
        </div>
      </div>

      {#if (metrics.error)}
        <LoadError message={errorMessage(metrics.error)} onretry={loadMetrics} busy={metrics.loading} />
      {/if}
      {#if !(metrics.error) && (traffic)}
        <!-- A refetch keeps the previous frame, dimmed. -->
        <div class={['transition-opacity', metrics.loading && 'opacity-60']}>
          <TrafficChart points={chartPoints} hourly={range === '1h'} {show} />
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{traffic.totals.requests === 0 ? t('overview.traffic.empty') : t('overview.traffic.since', { date: since })}</span>
          <button type="button" class="cursor-pointer underline-offset-4 hover:text-foreground hover:underline" onclick={() => (tableView = !tableView)}>
            {tableView ? t('overview.traffic.hideTable') : t('overview.traffic.showTable')}
          </button>
        </div>
        {#if tableView}
          <div class="max-h-72 overflow-auto rounded-2xl border">
            <Table.Root>
              <Table.Header>
                <Table.Row class="hover:bg-transparent">
                  <Table.Head>{t('overview.traffic.time')}</Table.Head>
                  <Table.Head class="text-right">{t('overview.traffic.requests')}</Table.Head>
                  <Table.Head class="text-right">{t('overview.traffic.refused')}</Table.Head>
                  <Table.Head class="text-right">{t('overview.traffic.latency')}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each [...traffic.points].reverse() as point (point.at)}
                  <Table.Row>
                    <Table.Cell class="tabular-nums">{dateText(point.at, time.format)}</Table.Cell>
                    <Table.Cell class="text-right tabular-nums">{fmt.format(point.requests)}</Table.Cell>
                    <Table.Cell class="text-right tabular-nums">{fmt.format(point.refused)}</Table.Cell>
                    <Table.Cell class="text-right tabular-nums">{point.p95_ms === null ? '—' : fmt.format(point.p95_ms)}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}
      {/if}
      {#if !(metrics.error) && !(traffic)}
        <Skeleton class="h-[22rem] rounded-2xl" />
      {/if}
    </article>



  </section>

  <!-- Three cards: where the data is, what was refused, what needs doing. -->
  <section class="grid gap-4 @min-[40rem]:grid-cols-2 @min-[60rem]:grid-cols-3">
    {#if data || overview.loading}
    <article class={['grid content-start gap-5', card]}>
      {@render cardHeader(t('overview.rows.title'), '/tables')}
      {#if !data && overview.loading}
        <Skeleton class="h-40 rounded-2xl" />
      {/if}
      {#if !(!data) && (byRows.length === 0)}
        <p class="text-sm text-muted-foreground">{t('overview.rows.empty')}</p>
      {/if}
      {#if !(!data) && !(byRows.length === 0)}
        <ul class="grid gap-5">
          {#each byRows as table (table.name)}
            {@const share = percent(table.rows ?? 0, totalRows)}
            <li class="grid gap-2">
              <div class="flex items-baseline justify-between gap-3">
                <a href={href(`/tables/${encodeURIComponent(table.name)}`)} class="truncate font-medium hover:text-brand">{table.name}</a>
                <span class="font-medium tabular-nums">{table.rows === null ? '—' : `${table.rows_exact ? '' : '~'}${fmt.format(table.rows)}`}</span>
              </div>
              <div class="h-1.5 overflow-hidden rounded-full bg-secondary"><div class="h-full rounded-full bg-brand" style:width={`${share}%`}></div></div>
              <p class="text-xs text-muted-foreground">{t('overview.rows.detail', { percent: share, protection: t(`policies.plain.state.${table.rls.state}`) })}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </article>

    {/if}

    <article class={['grid content-start gap-4', card]}>
      {@render cardHeader(t('overview.blocked.title'), '/policies')}
      {#if denied.error}<LoadError message={errorMessage(denied.error)} onretry={loadDenied} busy={denied.loading} />{/if}
      {#if !denied.data && denied.loading}
        <Skeleton class="h-40 rounded-2xl" />
      {/if}
      {#if !(!denied.data) && (recentBlocks.length === 0)}
        <p class="text-sm text-muted-foreground">{t('overview.blocked.none')}</p>
      {/if}
      {#if !(!denied.data) && !(recentBlocks.length === 0)}
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-muted-foreground">
              <th class="pb-2 text-left font-normal">{t('overview.blocked.who')}</th>
              <th class="pb-2 text-left font-normal">{t('overview.blocked.where')}</th>
              <th class="pb-2 text-right font-normal">{t('overview.blocked.when')}</th>
            </tr>
          </thead>
          <tbody>
            {#each recentBlocks as block, i (`${block.at}-${i}`)}
              {@const target = blockTarget(block.path)}
              <tr class="border-t" title={t(`policies.blocked.reasons.${blockReason(block)}`)}>
                <td class="max-w-28 truncate py-2.5 pr-3">{block.email ?? t(`policies.blocked.who.${block.role === 'anon' || block.role === 'invalid_token' || block.role === 'service_role' ? block.role : 'authenticated'}`)}</td>
                <td class="max-w-32 truncate py-2.5 pr-3 text-muted-foreground">{target ? target.name : block.path}</td>
                <td class="py-2.5 text-right text-muted-foreground tabular-nums">{dateText(block.at, time.format)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </article>

    {#if data || overview.loading}
    <article class={['grid content-start gap-4', card]}>
      <h2 class="text-sm font-medium text-muted-foreground">{t('overview.needs.title')}</h2>
      {#if !data && overview.loading}
        <Skeleton class="h-40 rounded-2xl" />
      {/if}
      {#if !(!data)}
        {#if (needs.length)}
          <ul class="grid gap-3">
            {#each needs.slice(0, 3) as item (item.key)}
              <li>
                <a href={href(item.path)} class="group flex gap-3 rounded-2xl bg-warning/10 px-4 py-3">
                  <CircleAlert class="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
                  <span class="grid gap-0.5">
                    <span class="font-medium group-hover:underline">{item.title}</span>
                    <span class="text-sm text-muted-foreground">{item.text}</span>
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
        {#if !(needs.length)}
          <p class="flex items-center gap-2 text-sm font-medium"><CircleCheck class="size-5 shrink-0 text-success" aria-hidden="true" />{t('overview.needs.allGood')}</p>
        {/if}
        <!-- The first steps, always in view: each is ticked by what the project
             shows, so the list doubles as a health check. -->
        <div class="grid gap-2">
          <p class="flex items-baseline justify-between text-xs text-muted-foreground">
            {t('overview.steps.title')}<span class="tabular-nums">{t('overview.steps.progress', { done: allSteps.length - steps.length, total: allSteps.length })}</span>
          </p>
          <ol class="grid gap-1">
            {#each allSteps as step (step.id)}
              <li>
                <a href={href(step.path)} class="group flex items-center gap-3 rounded-2xl px-2 py-2 transition-colors hover:bg-well">
                  {#if (step.done)}
                    <span class="grid size-6 shrink-0 place-items-center rounded-full bg-brand/15 text-brand"><Check class="size-3.5" aria-hidden="true" /></span>
                  {/if}
                  {#if !(step.done)}
                    <span class="size-6 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/40" aria-hidden="true"></span>
                  {/if}
                  <span class={['min-w-0 flex-1 text-sm', step.done ? 'text-muted-foreground line-through decoration-muted-foreground/40' : 'font-medium']}>{t(`overview.steps.${step.id}.label`)}</span>
                  <span class="sr-only">{step.done ? t('overview.steps.done') : ''}</span>
                  {#if !step.done}<ArrowUpRight class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />{/if}
                </a>
              </li>
            {/each}
          </ol>
        </div>
      {/if}
    </article>
    {/if}
  </section>
</div>
