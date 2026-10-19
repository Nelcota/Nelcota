<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Button } from '$lib/components/ui/button'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import { formatCell } from '$lib/features/tables/format'
  import { formatJson as prettyJson } from '$lib/features/tables/json-format'
  import { canonicalType, columnKind } from '$lib/features/tables/grid'
  import type { FieldState } from '$lib/features/tables/row-form'
  import type { Column } from '$lib/contracts/types'
  import { t } from '$lib/i18n/index.svelte'
  import type { FieldProblem } from '$lib/features/tables/row-form'

  let {
    column,
    field = $bindable(),
    inserting,
    problem,
  }: {
    column: Column
    field: FieldState
    inserting: boolean
    problem: FieldProblem | null
  } = $props()

  const id = $derived(`f-${column.name}`)
  const kind = $derived(columnKind(column))
  // Keep the same control while typing, so focus and selection never jump.
  const multiline = $derived(kind === 'json' || kind === 'text')
  const descriptionId = $derived(problem ? `${id}-error` : column.comment ? `${id}-description` : undefined)
  // Only on insert does an empty field mean something (the default, or NULL);
  // when editing, an empty field is an empty value and a hint would mislead.
  const placeholder = $derived(
    !inserting ? '' : column.has_default ? t('tables.row.defaultPlaceholder') : column.nullable ? t('tables.row.nullPlaceholder') : '',
  )
  const required = $derived(inserting && !column.nullable && !column.has_default)
  const preview = $derived(
    kind === 'temporal' && field.value && !field.isNull ? formatCell(field.value, column.type) : null,
  )
  const options = $derived(kind === 'boolean' ? ['true', 'false'] : kind === 'enum' ? column.enum_values : [])

  function formatJson() {
    try {
      field.value = prettyJson(field.value)
    } catch {
      // Invalid: the error message is already visible.
    }
  }
</script>

<div class="grid gap-2">
  <div class="flex items-center gap-2">
    <label for={id} class="flex items-center gap-1.5 text-sm font-medium">
      {#if column.is_pk}<KeyRound class="size-3.5 text-muted-foreground" aria-label={t('tables.row.primaryKey')} />{/if}{column.name}
    </label>
    <span class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{column.full_type}</span>
    {#if required}<span class="text-2xs text-muted-foreground">{t('tables.row.required')}</span>{/if}
    {#if column.nullable}
      <label class="ml-auto flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Checkbox checked={field.isNull} onCheckedChange={(v) => (field.isNull = v === true)} />
        NULL
      </label>
    {/if}
  </div>

  {#if (field.isNull)}
    <div class="flex h-9 items-center rounded-xl border border-dashed border-border-strong bg-well px-3 font-mono text-xs text-muted-foreground">NULL</div>
  {/if}
  {#if !(field.isNull) && (options.length)}
    <Select.Root type="single" bind:value={field.value}>
      <Select.Trigger {id} class="w-full" aria-invalid={problem ? true : undefined} aria-describedby={descriptionId}>{field.value || placeholder || t('tables.row.select')}</Select.Trigger>
      <Select.Content>
        {#each options as option (option)}<Select.Item value={option}>{option}</Select.Item>{/each}
      </Select.Content>
    </Select.Root>
  {/if}
  {#if !(field.isNull) && !(options.length) && (multiline)}
    <Textarea
      {id}
      class={['field-sizing-content min-h-20 text-sm', kind === 'json' && 'min-h-28 font-mono text-xs']}
      {placeholder}
      bind:value={field.value}
      aria-invalid={problem ? true : undefined}
      aria-describedby={descriptionId}
    />
  {/if}
  {#if !(field.isNull) && !(options.length) && !(multiline)}
    <Input
      {id}
      class={['text-sm', (kind === 'number' || kind === 'uuid' || kind === 'temporal') && 'font-mono text-xs']}
      inputmode={kind === 'number' ? 'decimal' : undefined}
      {placeholder}
      bind:value={field.value}
      aria-invalid={problem ? true : undefined}
      aria-describedby={descriptionId}
    />
  {/if}

  {#if (problem)}
    <p id={`${id}-error`} class="text-xs text-destructive">{t(`tables.row.problems.${problem}`)}</p>
  {/if}
  {#if !(problem) && (preview && preview.text !== field.value)}
    <p class="text-xs text-muted-foreground">= {preview.text}{canonicalType(column.type) === 'timestamp with time zone' ? ` ${t('tables.row.inYourTimeZone')}` : ''}</p>
  {/if}
  {#if kind === 'json' && !field.isNull && field.value.trim()}
    <Button variant="ghost" size="xs" class="justify-self-start text-muted-foreground" onclick={formatJson}>{t('tables.row.formatJson')}</Button>
  {/if}
  {#if column.comment}<p id={`${id}-description`} class="text-xs text-muted-foreground">{column.comment}</p>{/if}
</div>
