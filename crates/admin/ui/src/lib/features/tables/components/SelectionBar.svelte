<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Copy from '@lucide/svelte/icons/copy'
  import Download from '@lucide/svelte/icons/download'
  import X from '@lucide/svelte/icons/x'
  import { copyText } from '$lib/browser/clipboard'
  import { downloadText } from '$lib/browser/download'
  import { toCsv, toJson } from '$lib/formatting/tabular'
  import type { RowData } from '$lib/contracts/types'
  import { t } from '$lib/i18n/index.svelte'

  let {
    table,
    columns,
    rows,
    deletable,
    onclear,
    ondelete,
  }: {
    table: string
    columns: string[]
    /** Selected rows, in grid order. */
    rows: RowData[]
    deletable: boolean
    onclear: () => void
    ondelete: () => void
  } = $props()

  const matrix = $derived(rows.map((row) => columns.map((c) => row[c] ?? null)))
  const label = $derived(t('tables.selection.selected', { count: rows.length }))

  async function copyJson() {
    await copyText(toJson(columns, matrix), t('tables.toast.rowsCopied', { count: rows.length }))
  }

  function exportAs(format: 'csv' | 'json') {
    const name = `${table.replace(/[^\w-]+/g, '_')}-${t('tables.selection.fileSuffix')}.${format}`
    if (format === 'csv') { downloadText(name, toCsv(columns, matrix), 'text/csv;charset=utf-8'); return }
    downloadText(name, toJson(columns, matrix), 'application/json')
  }
</script>

<!-- Actions on the selection; only shown with ticked rows. -->
<div
  class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-brand/20 bg-brand/5 px-4 py-2 text-sm"
  role="region"
  aria-label={t('tables.selection.region')}
>
  <span class="font-medium text-foreground" aria-live="polite">{label}</span>
  <span class="text-muted-foreground">{t('tables.selection.onPage')}</span>
  <div class="ml-auto flex flex-wrap items-center gap-2">
    <Button variant="ghost" size="sm" onclick={copyJson}><Copy />{t('tables.selection.copyJson')}</Button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button variant="ghost" size="sm" {...props}><Download />{t('tables.selection.exportSelection')}</Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-40">
        <DropdownMenu.Item onclick={() => exportAs('csv')}>CSV</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => exportAs('json')}>JSON</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {#if deletable}
      <Button variant="destructive" size="sm" onclick={ondelete}><Trash2 />{t('tables.selection.delete')}</Button>
    {/if}
    <Button variant="ghost" size="icon-sm" aria-label={t('tables.selection.clear')} title={t('tables.selection.clearTitle')} onclick={onclear}><X /></Button>
  </div>
</div>
