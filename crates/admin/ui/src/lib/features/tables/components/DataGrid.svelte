<script lang="ts">
  import { tick } from 'svelte'
  import { createTable, tableFeatures, columnVisibilityFeature, rowSelectionFeature } from '@tanstack/svelte-table'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import GridCell from './GridCell.svelte'
  import GridColumnHeader from './GridColumnHeader.svelte'
  import CellDetailDialog from '$lib/components/shared/CellDetailDialog.svelte'
  import { copyText } from '$lib/browser/clipboard'
  import { alignRight, cellPreview, columnKind, columnWidth, editedValue, monospace, nextCell, rowKey, rowPk, type CellPos } from '$lib/features/tables/grid'
  import type { Column, RowData, TableData } from '$lib/contracts/types'
  import { t } from '$lib/i18n/index.svelte'

  let {
    data,
    sort,
    hidden,
    selected = $bindable(),
    onsort,
    onsortset,
    onfilter,
    onhide,
    onexpand,
    oncommit,
    referenceHref,
    disabled = false,
  }: {
    data: TableData
    sort: { column: string; desc: boolean } | null
    /** Columns the user hid. */
    hidden: string[]
    selected: Set<number>
    onsort: (column: string) => void
    onsortset: (column: string, direction: 'asc' | 'desc' | null) => void
    onfilter: (column: string) => void
    onhide: (column: string) => void
    onexpand: (row: RowData) => void
    /** Saves a cell; resolves once stored (or rejects with the error already shown). */
    oncommit: (pk: RowData, column: string, value: string | null) => Promise<void>
    referenceHref: (column: Column, value: string) => string
    disabled?: boolean
  } = $props()

  const selectionState = $derived(Object.fromEntries([...selected].flatMap(index => {
    const row = data.rows[index]
    return row ? [[rowKey(row, data.table.primary_key, index), true as const]] : []
  })))
  const columnVisibility = $derived(Object.fromEntries(hidden.map(name => [name, false])))
  const table = createTable({
    features: tableFeatures({ columnVisibilityFeature, rowSelectionFeature }),
    get data() { return data.rows },
    get columns() { return data.table.columns.map(column => ({ id: column.name, accessorFn: (row: RowData) => row[column.name] })) },
    getRowId: (row, index) => rowKey(row, data.table.primary_key, index),
    get enableRowSelection() { return data.table.editable && !disabled },
    get state() {
      return { columnVisibility, rowSelection: selectionState }
    },
    onRowSelectionChange: updater => {
      const next = typeof updater === 'function' ? updater(selectionState) : updater
      selected = new Set(data.rows.flatMap((row, index) => next[rowKey(row, data.table.primary_key, index)] ? [index] : []))
    },
  })
  const columns = $derived(table.getVisibleLeafColumns().map(visible => {
    const column = data.table.columns.find(column => column.name === visible.id)!
    return { column, kind: columnKind(column), width: columnWidth(column) }
  }))
  const gridRows = $derived(table.getRowModel().rows)
  const editable = $derived(data.table.editable)

  // Inline editing: the cell (row, column) being edited and the draft.
  let editing = $state<{ key: string; pk: RowData; column: string; original: string | null } | null>(null)
  let draft = $state('')
  let detail = $state<{ title: string; value: string | null } | null>(null)
  let detailOpen = $state(false)

  // Keyboard navigation (WAI-ARIA "grid" pattern): one active cell at a time
  // takes focus (roving tabindex); Tab enters and leaves the whole grid.
  let active = $state<CellPos>({ row: 0, col: 0 })
  let tableEl = $state<HTMLTableElement>()

  $effect(() => {
    if (disabled) editing = null
  })

  // Page, filter or columns changed: the active cell moves back within
  // bounds. Only assign on a real change: with 0 rows the clamped position is
  // the same, and assigning a new object would rerun this effect forever.
  $effect(() => {
    const row = Math.min(active.row, Math.max(data.rows.length - 1, 0))
    const col = Math.min(active.col, Math.max(columns.length - 1, 0))
    if (row !== active.row || col !== active.col) active = { row, col }
  })

  async function focusCell(pos: CellPos) {
    active = pos
    await tick()
    const cell = tableEl?.querySelector<HTMLElement>(`[data-cell="${pos.row}:${pos.col}"]`)
    cell?.focus({ preventScroll: true })
    cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  async function startEdit(rowIndex: number, column: Column) {
    if (disabled || !editable || column.generated) return
    const row = data.rows[rowIndex]
    // Same key as the grid row id, so each cell compares strings instead of re-serializing the key.
    editing = { key: rowKey(row, data.table.primary_key, rowIndex), pk: rowPk(row, data.table.primary_key), column: column.name, original: row[column.name] }
    draft = row[column.name] ?? ''
    await tick()
    document.getElementById('inline-editor')?.focus()
  }

  /**
   * Saves the open edit. `refocus` is false when the editor lost focus to
   * something else (a click elsewhere): focus stays where the user put it.
   */
  async function commitEdit(asNull = false, refocus = true) {
    if (!editing) return
    if (disabled) return
    const target = editing
    const { pk, column, original } = editing
    const value = editedValue(original, draft, asNull)
    editing = null
    if (refocus) focusCell(active)
    if (value === undefined) return
    try {
      await oncommit(pk, column, value)
    } catch {
      // Reopen the failed edit, unless another cell is being edited by now.
      if (!editing && data.rows.some((row, i) => rowKey(row, data.table.primary_key, i) === target.key)) {
        editing = target
        if (!refocus) return
        await tick()
        document.getElementById('inline-editor')?.focus()
      }
    }
  }

  function cancelEdit() {
    editing = null
    focusCell(active)
  }

  function onEditorKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      commitEdit()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
    }
  }

  async function copyCell(value: string | null) {
    await copyText(value ?? '', value === null ? t('tables.toast.nullCopied') : t('tables.toast.valueCopied'))
  }

  function onCellKey(event: KeyboardEvent, row: number, col: number) {
    if (editing || disabled) return
    const ctrl = event.ctrlKey || event.metaKey
    const next = nextCell(event.key, { row, col }, data.rows.length, columns.length, ctrl)
    if (next) {
      event.preventDefault()
      focusCell(next)
      return
    }
    const column = columns[col].column
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      if (editable && !column.generated) { startEdit(row, column); return }
      detail = { title: column.name, value: data.rows[row][column.name] }
      detailOpen = true
      return
    }
    if (event.key === ' ' && editable) {
      event.preventDefault()
      toggleRow(row, !selected.has(row))
      return
    }
    if (event.key === 'Escape' && selected.size) {
      selected = new Set()
      return
    }
    if (ctrl && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
      event.preventDefault()
      copyCell(data.rows[row][column.name])
    }
  }

  function toggleRow(index: number, on: boolean) {
    if (!disabled) table.getRowModel().rows[index]?.toggleSelected(on)
  }

  function toggleAll(on: boolean) {
    if (!disabled) table.toggleAllPageRowsSelected(on)
  }

  const sortOf = (name: string) => (sort?.column === name ? (sort.desc ? 'desc' : 'asc') : null)

  // Column pinned to the left (selection + expand): opaque background so the
  // content scrolling underneath does not show through.
  const stickyCell = 'sticky left-0 z-[1] border-r border-b bg-card'
</script>

<!-- table-layout fixed + per-column widths: editing a cell does not resize
     the other columns. The last column, without a width, fills the rest. -->
<table
  bind:this={tableEl}
  role="grid"
  aria-label={t('tables.grid.label', { table: data.table.name })}
  aria-multiselectable={editable}
  class="w-max min-w-full table-fixed border-separate border-spacing-0 text-xs"
>
  <colgroup>
    {#if editable}<col style:width="76px" />{/if}
    {#each columns as { column, width } (column.name)}<col style:width={`${width}px`} />{/each}
    <col />
  </colgroup>
  <thead class="sticky top-0 z-10">
    <tr>
      {#if editable}
        <th class={[stickyCell, 'z-[2] bg-card px-3.5 py-2.5 text-left shadow-[inset_0_-1px_0_var(--border)]']}>
          <Checkbox
            checked={table.getIsAllPageRowsSelected()}
            indeterminate={!table.getIsAllPageRowsSelected() && table.getIsSomePageRowsSelected()}
            onCheckedChange={(v) => toggleAll(v === true)}
            aria-label={t('tables.grid.selectAll')}
            {disabled}
          />
        </th>
      {/if}
      {#each columns as { column, kind } (column.name)}
        <th aria-sort={sortOf(column.name) === 'asc' ? 'ascending' : sortOf(column.name) === 'desc' ? 'descending' : undefined} class="border-r border-b bg-card p-0 align-top font-normal shadow-[inset_0_-1px_0_var(--border)]">
          <GridColumnHeader
            {column}
            {kind}
            sort={sortOf(column.name)}
            onsort={() => onsort(column.name)}
            onsortset={(direction) => onsortset(column.name, direction)}
            onfilter={() => onfilter(column.name)}
            onhide={() => onhide(column.name)}
          />
        </th>
      {/each}
      <th class="border-b bg-card" aria-hidden="true"></th>
    </tr>
  </thead>
  <tbody>
    {#each gridRows as gridRow (gridRow.id)}
      {@const row = gridRow.original}
      {@const i = gridRow.index}
      {@const isSelected = gridRow.getIsSelected()}
      <tr aria-selected={editable ? isSelected : undefined} class={['group transition-colors', isSelected ? 'bg-primary/[0.07]' : 'hover:bg-muted/60']}>
        {#if editable}
          <td role="gridcell" class={[stickyCell, 'px-3.5 py-2', isSelected ? 'bg-[color-mix(in_oklch,var(--primary)_7%,var(--background))]' : 'group-hover:bg-[color-mix(in_oklch,var(--muted)_60%,var(--background))]']}>
            <div class="flex items-center gap-2">
              <Checkbox checked={isSelected} {disabled} onCheckedChange={(v) => toggleRow(i, v === true)} aria-label={t('tables.grid.selectRow', { n: i + 1 })} />
              <button
                type="button"
                class="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                aria-label={t('tables.grid.expandRow', { n: i + 1 })}
                title={t('tables.grid.expandTitle')}
                onclick={() => onexpand(row)}
                {disabled}
              >
                <Maximize2 class="size-3.5" />
              </button>
            </div>
          </td>
        {/if}
        {#each columns as { column, kind }, c (column.name)}
          {@const value = row[column.name]}
          {@const isEditing = editing?.key === gridRow.id && editing.column === column.name}
          <td
            role="gridcell"
            data-cell={`${i}:${c}`}
            tabindex={active.row === i && active.col === c ? 0 : -1}
            aria-selected={isSelected}
            class={[
              'group/cell border-b p-0 focus-visible:bg-brand/[0.06] focus-visible:outline-offset-[-2px]',
              // Only rows are ruled; an editable cell lights up under the pointer.
              editable && !column.generated && 'cursor-text hover:bg-accent/50',
            ]}
            onfocus={() => (active = { row: i, col: c })}
            onkeydown={(e) => onCellKey(e, i, c)}
            ondblclick={() => startEdit(i, column)}
          >
            {#if editing !== null && isEditing}
              <div class="flex items-center gap-1 bg-card p-0.5 ring-2 ring-brand ring-inset" onfocusout={(event) => {
                // Focus left the editor (click elsewhere, Tab): save like Enter
                // does. Escape and Enter clear `editing` first, so this is a no-op.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitEdit(false, false)
              }}>
                {#if (editing.original?.includes('\n'))}
                  <!-- Multi-line text: an <input> would flatten the line breaks.
                       Enter saves, Shift+Enter adds a line. -->
                  <textarea
                    id="inline-editor"
                    rows="4"
                    class={['w-full min-w-0 resize-y bg-transparent px-2.5 py-1.5 text-xs outline-none', monospace(kind) && 'font-mono']}
                    bind:value={draft}
                    onkeydown={onEditorKey}
                    aria-label={t('tables.grid.edit', { column: column.name })}
                  ></textarea>
                {/if}
                {#if !(editing.original?.includes('\n'))}
                  <input
                    id="inline-editor"
                    class={[
                      'w-full min-w-0 bg-transparent px-2.5 py-1.5 text-xs outline-none',
                      monospace(kind) && 'font-mono',
                      alignRight(kind) && 'text-right',
                    ]}
                    bind:value={draft}
                    onkeydown={onEditorKey}
                    aria-label={t('tables.grid.edit', { column: column.name })}
                  />
                {/if}
                {#if column.nullable}
                  <button
                    class="shrink-0 cursor-pointer rounded border border-border-strong bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground hover:text-foreground"
                    type="button"
                    onkeydown={(event) => { if (event.key === 'Escape') cancelEdit() }}
                    onmousedown={(event) => event.preventDefault()}
                    onclick={() => commitEdit(true)}>NULL</button
                  >
                {/if}
              </div>
            {/if}
            {#if isEditing === false}
              <div class="flex min-h-10 items-center gap-1 px-3.5 py-2" title={value === null ? 'NULL' : cellPreview(value)}>
                <span class="min-w-0 flex-1"><GridCell {value} type={column.type} {kind} /></span>
                {#if value && (value.length > 80 || value.includes('\n'))}
                  <button type="button" class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t('common.details')} onclick={() => { detail = { title: column.name, value }; detailOpen = true }} ondblclick={(event) => event.stopPropagation()}><Maximize2 class="size-3.5" aria-hidden="true" /></button>
                {/if}
                {#if column.references && value !== null}
                  <a
                    href={referenceHref(column, value)}
                    class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 group-hover/cell:opacity-100 hover:bg-accent hover:text-brand focus-visible:opacity-100"
                    title={t('tables.grid.openIn', { table: column.references.table })}
                    aria-label={t('tables.grid.openReferenced', { table: column.references.table })}
                    ondblclick={(e) => e.stopPropagation()}
                  >
                    <ArrowUpRight class="size-3.5" />
                  </a>
                {/if}
              </div>
            {/if}
          </td>
        {/each}
        <td class="border-b" aria-hidden="true"></td>
      </tr>
    {/each}
  </tbody>
</table>
{#if detail}<CellDetailDialog bind:open={detailOpen} title={detail.title} value={detail.value} />{/if}
