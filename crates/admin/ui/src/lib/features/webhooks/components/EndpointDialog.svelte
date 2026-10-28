<script lang="ts">
  import { untrack } from 'svelte'
  import * as Sheet from '$lib/components/ui/sheet'
  import * as Field from '$lib/components/ui/field'
  import { Input } from '$lib/components/ui/input'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { CloseGuard } from '$lib/forms/close-guard.svelte'
  import UnsavedChangesDialog from '$lib/components/shared/UnsavedChangesDialog.svelte'
  import { errorMessage, t } from '$lib/i18n/index.svelte'
  import type { WebhookEndpoint, WebhookSecret } from '$lib/contracts/types'
  import { webhooks } from '../api'

  let { open = $bindable(false), endpoint = null, tables, allowLoopback, onsaved }: {
    open?: boolean; endpoint?: WebhookEndpoint | null; tables: string[]; allowLoopback: boolean; onsaved: (secret?: WebhookSecret) => void
  } = $props()
  let name = $state(''), table = $state(''), url = $state('')
  let insert = $state(true), update = $state(false), remove = $state(false), enabled = $state(true)
  let attempts = $state(6), saving = $state(false), failure = $state(''), initial = $state('')
  const snapshot = () => JSON.stringify([name, table, url, insert, update, remove, enabled, attempts])
  const guard = new CloseGuard(() => snapshot() !== initial, () => saving, () => open = false, () => open)
  $effect(() => {
    if (open) untrack(() => {
      name = endpoint?.name ?? ''; table = endpoint?.table ?? ''; url = endpoint?.url ?? ''
      insert = endpoint?.events.includes('INSERT') ?? true; update = endpoint?.events.includes('UPDATE') ?? false; remove = endpoint?.events.includes('DELETE') ?? false
      enabled = endpoint?.enabled ?? true; attempts = endpoint?.max_attempts ?? 6; failure = ''; initial = snapshot()
    })
  })
  const ready = $derived(name.trim() && table && url.trim() && (insert || update || remove) && attempts >= 1 && attempts <= 10 && Number.isInteger(attempts))
  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (!ready || saving) return
    saving = true; failure = ''
    const input = { name, table, url, events: [insert ? 'INSERT' : '', update ? 'UPDATE' : '', remove ? 'DELETE' : ''].filter(Boolean), enabled, max_attempts: attempts }
    try {
      const secret = endpoint ? (await webhooks.update(endpoint.id, input), undefined) : await webhooks.create(input)
      open = false; onsaved(secret)
    } catch (error) { failure = errorMessage(error) } finally { saving = false }
  }
</script>

<Sheet.Root bind:open={() => open, guard.change}>
  <Sheet.Content class="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-xl">
    <Sheet.Header class="shrink-0 border-b px-6 py-5">
      <Sheet.Title>{endpoint ? t('webhooks.edit') : t('webhooks.create')}</Sheet.Title>
      <Sheet.Description>{t('webhooks.description')}</Sheet.Description>
    </Sheet.Header>
    <form id="webhook-form" onsubmit={save} class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6">
      <fieldset disabled={saving} class="contents" aria-busy={saving}>
        <Field.Group class="gap-5">
          <Field.Field><Field.Label for="webhook-name">{t('webhooks.name')}</Field.Label><Input id="webhook-name" bind:value={name} maxlength={80} placeholder={t('webhooks.namePlaceholder')} required autocomplete="off" /></Field.Field>
          <Field.Field><Field.Label for="webhook-table">{t('webhooks.table')}</Field.Label>
            <Select.Root type="single" bind:value={table} disabled={!!endpoint} required>
              <Select.Trigger id="webhook-table" class="w-full min-w-0" aria-required="true"><span class={['truncate', !table && 'text-muted-foreground']}>{table || t('webhooks.chooseTable')}</span></Select.Trigger>
              <Select.Content>
                {#each [...new Set([...tables, ...(endpoint ? [endpoint.table] : [])])] as value (value)}<Select.Item {value} label={value}>{value}</Select.Item>{/each}
              </Select.Content>
            </Select.Root>
          </Field.Field>
          <Field.Field><Field.Label for="webhook-url">{t('webhooks.destination')}</Field.Label><Input id="webhook-url" type="url" bind:value={url} maxlength={2048} placeholder="https://app.example.com/webhooks/orders" required autocomplete="off" spellcheck={false} aria-describedby="webhook-url-hint" />
            <Field.Description id="webhook-url-hint">{t('webhooks.urlHint')} {#if allowLoopback}{t('webhooks.localHint')}{/if} {#if endpoint}{t('webhooks.destinationHint')}{/if}</Field.Description>
          </Field.Field>
          <fieldset class="grid gap-3"><legend class="mb-3 text-sm font-medium">{t('webhooks.events')}</legend>
            <Field.Field orientation="horizontal"><Checkbox id="webhook-insert" bind:checked={insert} /><Field.Label for="webhook-insert">{t('webhooks.insert')}</Field.Label></Field.Field>
            <Field.Field orientation="horizontal"><Checkbox id="webhook-update" bind:checked={update} /><Field.Label for="webhook-update">{t('webhooks.update')}</Field.Label></Field.Field>
            <Field.Field orientation="horizontal"><Checkbox id="webhook-delete" bind:checked={remove} /><Field.Label for="webhook-delete">{t('webhooks.delete')}</Field.Label></Field.Field>
          </fieldset>
          <Field.Field><Field.Label for="webhook-attempts">{t('webhooks.attempts')}</Field.Label><Input id="webhook-attempts" type="number" bind:value={attempts} min={1} max={10} step={1} required aria-describedby="webhook-attempts-hint" /><Field.Description id="webhook-attempts-hint">{t('webhooks.attemptsHint')}</Field.Description></Field.Field>
          <Field.Field><Field.Field orientation="horizontal"><Checkbox id="webhook-enabled" bind:checked={enabled} /><Field.Label for="webhook-enabled">{t('webhooks.enabled')}</Field.Label></Field.Field><Field.Description>{t('webhooks.pauseHint')}</Field.Description></Field.Field>
        </Field.Group>
        {#if failure}<p role="alert" class="text-sm text-destructive">{failure}</p>{/if}
      </fieldset>
    </form>
    <Sheet.Footer class="flex shrink-0 flex-row justify-end gap-2 border-t px-6 py-4">
      <Button variant="outline" disabled={saving} onclick={guard.request}>{t('common.cancel')}</Button>
      <Button type="submit" form="webhook-form" disabled={!ready || saving}>{saving ? t('common.saving') : t('common.save')}</Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
