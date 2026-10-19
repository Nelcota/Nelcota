<script lang="ts">
  import { untrack } from 'svelte'
  import { CloseGuard } from '$lib/forms/close-guard.svelte'
  import UnsavedChangesDialog from '$lib/components/shared/UnsavedChangesDialog.svelte'
  import Save from '@lucide/svelte/icons/save'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import * as Sheet from '$lib/components/ui/sheet'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import ColumnFields from './ColumnFields.svelte'
  import SqlPreview from '$lib/shared/schema/components/SqlPreview.svelte'
  import { blankColumn, columnChanges, ddl, toColumnDef, type AlterAction, type ColumnDef, type ColumnInfo } from '$lib/shared/schema/ddl'
  import { loadSchemaColumns, loadTypes } from '$lib/shared/schema/pg-types.svelte'
  import { SqlPreview as Preview } from '$lib/shared/schema/preview.svelte'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  let {
    open = $bindable(false),
    table,
    original = null,
    onsaved,
  }: {
    open?: boolean
    table: string
    /** Column being edited; `null` = add a new column. */
    original?: ColumnInfo | null
    onsaved: () => void
  } = $props()

  let column = $state<ColumnDef>(blankColumn())
  let tables = $state<Record<string, string[]>>({})
  let saving = $state(false)
  let initialValue = $state('')
  const guard = new CloseGuard(() => JSON.stringify(column) !== initialValue, () => saving, () => (open = false))
  const preview = new Preview()

  $effect(() => {
    if (!open) return
    untrack(() => {
      column = original ? toColumnDef(original) : blankColumn()
      initialValue = JSON.stringify(column)
      loadTypes()
      loadSchemaColumns()
        .then((t) => (tables = t))
        .catch(() => (tables = {}))
      })
  })

  const actions = $derived.by((): AlterAction[] => {
    if (!column.name.trim() || !column.data_type.trim()) return []
    return original ? columnChanges(original, column) : [{ action: 'add_column', column: $state.snapshot(column) }]
  })

  $effect(() => {
    const pending = $state.snapshot(actions)
    if (!open || pending.length === 0) return preview.clear()
    preview.schedule((signal) => ddl.alterTable(table, pending, true, { signal }))
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (saving || actions.length === 0) return
    saving = true
    try {
      const result = await ddl.alterTable(table, $state.snapshot(actions))
      toast.success(t('tables.toast.columnSaved'))
      open = false
      onsaved()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      saving = false
    }
  }
</script>

<Sheet.Root bind:open={() => open, guard.change}>
  <Sheet.Content class="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl">
    <Sheet.Header class="border-b px-6 pt-6 pb-5">
      <Sheet.Title>{original ? t('tables.columnSheet.editTitle', { name: original.name }) : t('tables.columnSheet.newTitle')}</Sheet.Title>
      <Sheet.Description>
        {t('tables.columnSheet.in')} <code class="font-mono text-foreground">{table}</code>
        {#if original?.primary_key}· {t('tables.columnSheet.partOfPrimaryKey')}{/if}
      </Sheet.Description>
    </Sheet.Header>

    <form id="column-form" class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6" onsubmit={submit}>
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        <ColumnFields bind:column {tables} mode={original ? 'edit' : 'add'} />
        {#if original && column.data_type.trim() !== original.data_type}
          <p class="rounded-2xl bg-well px-4 py-3 text-xs text-muted-foreground">
            {t('tables.columnSheet.conversionBefore')} <code>{original.name}::{column.data_type}</code>. {t('tables.columnSheet.conversionAfter')}
          </p>
        {/if}
        <SqlPreview {preview} placeholder={original ? t('tables.columnSheet.previewEdit') : t('tables.columnSheet.previewAdd')} />
        </fieldset>
    </form>

    <Sheet.Footer class="flex-row justify-end gap-2 border-t bg-muted/40 px-6 py-4">
      <Button variant="outline" disabled={saving} onclick={guard.request}>{t('common.cancel')}</Button>
      <Button type="submit" form="column-form" disabled={saving || actions.length === 0}>
        {#if (saving)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
        {#if !(saving)}<Save data-icon="inline-start" aria-hidden="true" />{/if}
        {saving ? t('common.saving') : original ? t('tables.columnSheet.saveChanges') : t('tables.columnSheet.addColumn')}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
