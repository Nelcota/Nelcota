<script lang="ts">
  import { tick, untrack } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import Plus from '@lucide/svelte/icons/plus'
  import X from '@lucide/svelte/icons/x'
  import { UI_OPERATORS, fromUi, needsValue, toUi, type TableFilter, type UiOp } from '$lib/features/tables/filters'
  import type { Column } from '$lib/contracts/types'
  import { t } from '$lib/i18n/index.svelte'

  let {
    columns,
    filters,
    preset,
    onapply,
    onclose,
  }: {
    columns: Column[]
    filters: TableFilter[]
    /** Column for a new, prefilled row (column menu). */
    preset?: string
    onapply: (filters: TableFilter[]) => void
    onclose: () => void
  } = $props()

  type Row = { key: number; column: string; op: UiOp; value: string }

  let nextKey = 0
  const toRow = (f: TableFilter): Row => ({ key: nextKey++, column: f.column, ...toUi(f) })
  const blankRow = (column = columns[0]?.name ?? ''): Row => ({ key: nextKey++, column, op: 'eq', value: '' })

  // Local draft, copied once on open: it only reaches the URL (and the API)
  // when applied.
  let rows = $state<Row[]>(
    untrack(() =>
      preset ? [...filters.map(toRow), blankRow(preset)] : filters.length ? filters.map(toRow) : [blankRow()],
    ),
  )

  const opLabel = (op: UiOp) => {
    const key = UI_OPERATORS.find((o) => o.value === op)?.label
    return key ? t(key) : op
  }
  const complete = (r: Row) => r.column !== '' && (!needsValue(r.op) || r.value !== '')

  // A filter left without its value used to be dropped silently on Apply,
  // so the grid ignored what the person thought they had asked for.
  let attempted = $state(false)
  const missingValue = (r: Row) => attempted && !complete(r) && rows.some(complete)
  let form = $state<HTMLFormElement>()

  async function apply(event: SubmitEvent) {
    event.preventDefault()
    // Only blank rows (nothing typed anywhere): same as clearing.
    if (rows.some(complete) && !rows.every(complete)) {
      attempted = true
      await tick()
      form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }
    onapply(rows.filter(complete).map((r) => fromUi(r.column, r.op, r.value)))
  }
</script>

<!-- Phones: column, operator and value stack full width; wider screens keep one line per filter. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
  bind:this={form}
  class="grid gap-3 border-b bg-muted/40 px-4 py-4"
  onsubmit={apply}
  onkeydown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) onclose()
  }}
  aria-label={t('tables.toolbar.filter')}
>
  {#each rows as row, i (row.key)}
    {@const invalid = missingValue(row)}
    <div class="flex items-start gap-2">
      <span class="w-10 shrink-0 pt-2.5 text-right text-xs text-muted-foreground sm:w-12">{i === 0 ? t('tables.filters.where') : t('tables.filters.and')}</span>
      <div class="grid min-w-0 flex-1 gap-2 sm:flex sm:flex-none sm:flex-wrap sm:items-start">
      <Select.Root type="single" bind:value={row.column}>
        <Select.Trigger aria-label={t('tables.filters.column')} class="w-full font-mono text-xs sm:w-48">{row.column || t('tables.filters.column')}</Select.Trigger>
        <Select.Content>
          {#each columns as column (column.name)}
            <Select.Item value={column.name} class="font-mono text-xs">{column.name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Select.Root type="single" bind:value={row.op}>
        <Select.Trigger aria-label={t('tables.filters.operator')} class="w-full text-sm sm:w-48">{opLabel(row.op)}</Select.Trigger>
        <Select.Content>
          {#each UI_OPERATORS as op (op.value)}
            <Select.Item value={op.value}>{t(op.label)}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if needsValue(row.op)}
        <div class="grid gap-1 sm:w-56">
          <Input
            bind:value={row.value}
            aria-label={t('tables.filters.value')}
            placeholder={t('tables.filters.value')}
            class="w-full font-mono text-xs"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `filter-${row.key}-error` : undefined}
          />
          {#if invalid}<p id={`filter-${row.key}-error`} class="px-1 text-xs text-destructive">{t('tables.filters.needsValue')}</p>{/if}
        </div>
      {/if}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        class="mt-0.5 shrink-0"
        aria-label={t('tables.filters.remove')}
        title={t('tables.filters.remove')}
        onclick={() => (rows = rows.filter((r) => r.key !== row.key))}
      >
        <X />
      </Button>
    </div>
  {/each}

  <div class="mt-1 flex flex-wrap items-center gap-2 sm:pl-14">
    <Button variant="outline" size="sm" onclick={() => (rows = [...rows, blankRow()])}>
      <Plus />{t('tables.filters.add')}
    </Button>
    <div class="ml-auto flex items-center gap-2">
      {#if filters.length}
        <Button variant="ghost" size="sm" onclick={() => onapply([])}>{t('tables.filters.clear')}</Button>
      {/if}
      <Button variant="ghost" size="sm" onclick={onclose}>{t('common.close')}</Button>
      <Button type="submit" size="sm">{t('tables.filters.apply')}</Button>
    </div>
  </div>
</form>
