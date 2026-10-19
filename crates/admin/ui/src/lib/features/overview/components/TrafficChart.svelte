<script lang="ts">
  import { dateText } from '$lib/formatting/date'
  import { areaPath, monotonePath, nearestIndex, niceTicks, type Point } from '$lib/features/overview/chart'
  import type { MetricsPoint } from '$lib/contracts/types'
  import { intlLocale, t } from '$lib/i18n/index.svelte'

  // API traffic over time (D98): requests as a green area, refused calls as a
  // grey one, on one scale. Values come from the crosshair (pointer or arrow
  // keys, exposed as a slider), the tooltip and the table view below.
  let {
    points,
    hourly,
    show = 'all',
  }: { points: MetricsPoint[]; hourly: boolean; show?: 'all' | 'requests' | 'refused' } = $props()

  const HEIGHT = 340
  const PAD = { top: 12, right: 4, bottom: 30, left: 4 }
  const id = `traffic-${Math.random().toString(36).slice(2, 8)}`
  let width = $state(0)
  let active = $state<number | null>(null)

  const showRequests = $derived(show !== 'refused')
  const showRefused = $derived(show !== 'requests')
  const plotWidth = $derived(Math.max(0, width - PAD.left - PAD.right))
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const max = $derived(Math.max(1, ...points.map((p) => Math.max(showRequests ? p.requests : 0, showRefused ? p.refused : 0))))
  const ticks = $derived(niceTicks(max))
  const top = $derived(ticks[ticks.length - 1] ?? 1)
  const x = (i: number) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotWidth : 0)
  const y = (v: number) => PAD.top + plotHeight - (v / top) * plotHeight
  const series = (pick: (p: MetricsPoint) => number): Point[] => points.map((p, i) => ({ x: x(i), y: y(pick(p)) }))
  const requests = $derived(series((p) => p.requests))
  const refused = $derived(series((p) => p.refused))

  const fmt = $derived(new Intl.NumberFormat(intlLocale()))
  const time = $derived(new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }))
  // Labels every 10 minutes (last hour) or every 3 hours (last day), spaced
  // further apart when the chart is too narrow for them to fit.
  const every = $derived.by(() => {
    const base = hourly ? 10 : 12
    const fit = Math.max(1, Math.floor(plotWidth / 64))
    return base * Math.max(1, Math.ceil(points.length / base / fit))
  })
  const labels = $derived(points.map((p, i) => ({ i, text: dateText(p.at, time.format) })).filter(({ i }) => (points.length - 1 - i) % every === 0))

  const current = $derived(active === null ? null : points[active])
  const valueText = $derived.by(() => {
    const point = current ?? points[points.length - 1]
    if (!point) return ''
    return `${dateText(point.at, time.format)}: ${fmt.format(point.requests)} ${t('overview.traffic.requests')}, ${fmt.format(point.refused)} ${t('overview.traffic.refused')}`
  })
  // Beside the crosshair, on the side with room, so it never hides the point.
  const TOOLTIP = 176
  const tooltipLeft = $derived.by(() => {
    if (active === null) return 0
    const at = x(active)
    return at > width / 2 ? Math.max(0, at - TOOLTIP - 14) : Math.min(width - TOOLTIP, at + 14)
  })

  function move(event: PointerEvent) {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect()
    active = nearestIndex(event.clientX - box.left, PAD.left, plotWidth, points.length)
  }

  function key(event: KeyboardEvent) {
    if (!points.length) return
    const last = points.length - 1
    switch (event.key) {
      case 'ArrowLeft': active = Math.max(0, (active ?? last) - 1); break
      case 'ArrowRight': active = Math.min(last, (active ?? last) + 1); break
      case 'Home': active = 0; break
      case 'End': active = last; break
      case 'Escape': active = null; break
      default: return
    }
    event.preventDefault()
  }
</script>

<div class="relative" bind:clientWidth={width}>
  {#if width > 0}
    <svg
      {width}
      height={HEIGHT}
      role="slider"
      tabindex="0"
      aria-label={t('overview.traffic.chartLabel')}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, points.length - 1)}
      aria-valuenow={active ?? points.length - 1}
      aria-valuetext={valueText}
      class="block max-w-full touch-none rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      onpointermove={move}
      onpointerleave={() => (active = null)}
      onkeydown={key}
      onblur={() => (active = null)}
    >
      <defs>
        <linearGradient id={`${id}-requests`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" style="stop-color: var(--chart-1)" stop-opacity="0.45" />
          <stop offset="100%" style="stop-color: var(--chart-1)" stop-opacity="0.02" />
        </linearGradient>
        <linearGradient id={`${id}-refused`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" style="stop-color: var(--chart-2)" stop-opacity="0.3" />
          <stop offset="100%" style="stop-color: var(--chart-2)" stop-opacity="0.02" />
        </linearGradient>
      </defs>

      {#each ticks as tick (tick)}
        <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} class="stroke-border" stroke-width="1" />
      {/each}
      {#each labels as label (label.i)}
        <text x={x(label.i)} y={HEIGHT - 6} text-anchor={label.i === points.length - 1 ? 'end' : 'middle'} class="fill-muted-foreground text-3xs tabular-nums">{label.text}</text>
      {/each}

      {#if showRequests}
        <path d={areaPath(requests, y(0))} fill={`url(#${id}-requests)`} />
        <path d={monotonePath(requests)} class="stroke-chart-1" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      {/if}
      {#if showRefused}
        <path d={areaPath(refused, y(0))} fill={`url(#${id}-refused)`} />
        <path d={monotonePath(refused)} class="stroke-chart-2" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
      {/if}

      {#if active !== null && current}
        <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotHeight} class="stroke-muted-foreground/50" stroke-width="1" stroke-dasharray="3 3" />
        {#if showRequests}<circle cx={x(active)} cy={y(current.requests)} r="4.5" class="fill-chart-1 stroke-card" stroke-width="2" />{/if}
        {#if showRefused}<circle cx={x(active)} cy={y(current.refused)} r="4.5" class="fill-chart-2 stroke-card" stroke-width="2" />{/if}
      {/if}
    </svg>
  {/if}

  {#if active !== null && current}
    <div class="pointer-events-none absolute top-4 z-10 w-44 rounded-2xl bg-popover p-3 text-xs shadow-raised" style:left={`${tooltipLeft}px`} role="status">
      <p class="mb-2 text-muted-foreground">{dateText(current.at, time.format)}</p>
      {#if showRequests}
        <p class="flex items-center gap-2">
          <span class="h-0.5 w-3 rounded-full bg-chart-1" aria-hidden="true"></span>
          <span class="text-sm font-semibold text-foreground tabular-nums">{fmt.format(current.requests)}</span>
          <span class="text-muted-foreground">{t('overview.traffic.requests')}</span>
        </p>
      {/if}
      {#if showRefused}
        <p class="mt-1 flex items-center gap-2">
          <span class="h-0.5 w-3 rounded-full bg-chart-2" aria-hidden="true"></span>
          <span class="text-sm font-semibold text-foreground tabular-nums">{fmt.format(current.refused)}</span>
          <span class="text-muted-foreground">{t('overview.traffic.refused')}</span>
        </p>
      {/if}
      {#if current.p95_ms !== null}
        <p class="mt-2 text-muted-foreground">{t('overview.traffic.p95', { ms: fmt.format(current.p95_ms) })}</p>
      {/if}
    </div>
  {/if}
</div>
