<script lang="ts">
  import { untrack } from 'svelte'
  import { createVirtualizer } from '@tanstack/svelte-virtual'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'
  import { Button } from '$lib/components/ui/button'
  import { t } from '$lib/i18n/index.svelte'
  import type { SqlResult } from '$lib/contracts/types'
  import { columnWidthCss, columnWidths, needsDetail } from '$lib/features/sql/result-layout'

  let { result, resultIndex, scrollElement, scrollMargin, ondetail }: {
    result: SqlResult
    resultIndex: number
    /** The results pane, which scrolls every result. */
    scrollElement: () => HTMLElement | undefined
    /** Where this table's rows start in the pane's content, measured by the editor. */
    scrollMargin: number
    ondetail: (column: string, value: string) => void
  } = $props()

  // A row is one 13px line with a 1rem line height, py-2 (2 × 0.5rem) and a 1px border.
  // The details button must not make its row taller: a row taller than the
  // estimate makes the virtualizer correct the scroll position, which
  // interrupts the browser's own smooth scrolling (End, Page Down).
  const ROW_HEIGHT_REM = 2
  const ROW_BORDER_PX = 1
  const DEFAULT_REM_PX = 16
  const OVERSCAN_ROWS = 12
  // Small results stay entirely in the DOM, so the browser's find and text
  // selection still see every row. Larger ones only render what is in view.
  const FULL_RENDER_ROWS = 200

  function rowHeight(): number {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    return (Number.isFinite(rem) && rem > 0 ? rem : DEFAULT_REM_PX) * ROW_HEIGHT_REM + ROW_BORDER_PX
  }
  const overscanFor = (count: number) => (count <= FULL_RENDER_ROWS ? count : OVERSCAN_ROWS)

  const widths = $derived(columnWidths(result.columns, result.rows))
  const estimatedRow = rowHeight()
  const virtualizer = createVirtualizer<HTMLElement, HTMLTableRowElement>(untrack(() => ({
    count: result.rows.length,
    overscan: overscanFor(result.rows.length),
    scrollMargin,
    getScrollElement: () => scrollElement() ?? null,
    estimateSize: () => estimatedRow,
  })))
  const items = $derived($virtualizer.getVirtualItems())
  const margin = $derived($virtualizer.options.scrollMargin)
  const before = $derived(items.length === 0 ? 0 : items[0].start - margin)
  const after = $derived(items.length === 0 ? 0 : $virtualizer.getTotalSize() - (items[items.length - 1].end - margin))

  $effect(() => {
    const next = scrollMargin
    untrack(() => {
      if (Math.abs(next - $virtualizer.options.scrollMargin) < 1) return
      $virtualizer.setOptions({ scrollMargin: next })
    })
  })

  function measure(row: HTMLTableRowElement) {
    $virtualizer.measureElement(row)
  }

  // Scrolling unmounts rows: a focused details button would leave focus on
  // <body>, so before its row goes, hand focus to the results pane, which
  // keyboard users scroll.
  let body = $state<HTMLTableSectionElement>()
  $effect.pre(() => {
    const kept = new Set(items.map(item => item.index))
    untrack(() => {
      const focused = document.activeElement
      if (body === undefined || focused === null || body.contains(focused) === false) return
      const row = focused.closest<HTMLElement>('tr[data-index]')
      if (row === null || kept.has(Number(row.dataset.index))) return
      scrollElement()?.focus({ preventScroll: true })
    })
  })
</script>

<table class="w-0 min-w-full table-fixed border-separate border-spacing-0 text-sm" aria-rowcount={result.rows.length + 1}>
  <colgroup>
    <!-- With a fixed layout and no width of its own, the table is as wide as
         these columns (or the pane). -->
    {#each widths as width, columnIndex (columnIndex)}<col class="font-mono text-[0.8125rem]/4" style:width={columnWidthCss(width)} />{/each}
  </colgroup>
  <thead class="sticky top-0 z-10">
    <tr aria-rowindex={1}>
      {#each result.columns as column, columnIndex (columnIndex)}
        <th class="truncate border-r border-b bg-muted px-3 py-2 text-left font-mono text-[0.8125rem]/4 font-medium" title={column}>{column}</th>
      {/each}
    </tr>
  </thead>
  <tbody bind:this={body} data-result-index={resultIndex}>
    {#if before > 0}<tr aria-hidden="true"><td class="p-0" colspan={result.columns.length} style:height={`${before}px`}></td></tr>{/if}
    {#each items as item (item.index)}
      {@const row = result.rows[item.index] ?? []}
      <tr class="hover:bg-muted/40" data-index={item.index} aria-rowindex={item.index + 2} use:measure>
        {#each row as cell, columnIndex (columnIndex)}
          <td class="truncate border-r border-b px-3 py-2 font-mono text-[0.8125rem]/4" title={cell ?? 'NULL'}>
            <div class="flex items-center gap-2"><span class="min-w-0 flex-1 truncate">{#if cell === null}<span class="text-3xs text-muted-foreground/80">NULL</span>{:else}{cell}{/if}</span>{#if needsDetail(cell)}<Button class="-my-1.5" variant="ghost" size="icon-xs" aria-label={t('common.details')} onclick={() => ondetail(result.columns[columnIndex], cell)}><Maximize2 aria-hidden="true" /></Button>{/if}</div>
          </td>
        {/each}
      </tr>
    {/each}
    {#if after > 0}<tr aria-hidden="true"><td class="p-0" colspan={result.columns.length} style:height={`${after}px`}></td></tr>{/if}
  </tbody>
</table>
