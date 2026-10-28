<script lang="ts">
  import { untrack } from 'svelte'
  import { CloseGuard } from '$lib/forms/close-guard.svelte'
  import UnsavedChangesDialog from '$lib/components/shared/UnsavedChangesDialog.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import Callout from '$lib/components/shared/Callout.svelte'
  import Save from '@lucide/svelte/icons/save'
  import HardDrive from '@lucide/svelte/icons/hard-drive'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Field from '$lib/components/ui/field'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { toast } from 'svelte-sonner'
  import { api, enc } from '$lib/transport/api'
  import { formatBytes, parseTypes, validBucketName } from '$lib/features/storage/files'
  import type { Bucket } from '$lib/contracts/types'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'

  // Creates a bucket, or edits one when `bucket` is given.
  let {
    open = $bindable(false),
    bucket = null,
    serverLimit,
    onsaved,
  }: { open?: boolean; bucket?: Bucket | null; serverLimit: number; onsaved: () => void } = $props()

  const MB = 1024 * 1024

  let id = $state('')
  let isPublic = $state(false)
  let limitMb = $state('')
  let initialLimitMb = $state('')
  let initialLimit = $state<number | null>(null)
  let types = $state('')
  let saving = $state(false)
  let failure = $state('')
  let confirmPublicOpen = $state(false)
  let initialValue = $state('')
  const snapshot = () => JSON.stringify([id, isPublic, limitMb, types])
  const guard = new CloseGuard(() => snapshot() !== initialValue, () => saving, () => (open = false), () => open)

  $effect(() => {
    if (open) {
      untrack(() => {
        id = bucket?.id ?? ''
        isPublic = bucket?.public ?? false
        initialLimit = bucket?.file_size_limit ?? null
        limitMb = initialLimit === null ? '' : String(initialLimit / MB)
        initialLimitMb = limitMb
        types = bucket?.allowed_mime_types?.join(', ') ?? ''
        failure = ''
        initialValue = snapshot()
        })
    }
  })

  // Display formatting must never become a mutation of an untouched setting.
  const limit = $derived(limitMb === initialLimitMb ? initialLimit : limitMb.trim() === '' ? null : Math.round(Number(limitMb.replace(',', '.')) * MB))
  const limitOk = $derived(limit === null || (Number.isFinite(limit) && limit > 0))
  const ready = $derived((bucket !== null || validBucketName(id)) && limitOk)
  const nameInvalid = $derived(id !== '' && !validBucketName(id))
  // Opening an existing bucket exposes every file already in it: ask first.
  const goingPublic = $derived(bucket !== null && !bucket.public && isPublic)

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (saving || !ready) return
    if (goingPublic) {
      confirmPublicOpen = true
      return
    }
    void save()
  }

  async function save() {
    if (saving || !ready) return
    saving = true
    failure = ''
    const settings = { public: isPublic, file_size_limit: limit, allowed_mime_types: parseTypes(types) }
    try {
      if (bucket) {
        await api.put(`/storage/buckets/${enc(bucket.id)}`, settings)
        toast.success(t('storage.dialog.saved', { bucket: bucket.id }))
        open = false
        onsaved()
        return
      }
      await api.post('/storage/buckets', { id, ...settings })
      toast.success(t('storage.dialog.created', { bucket: id }))
      open = false
      onsaved()
    } catch (e) {
      failure = errorMessage(e)
    } finally {
      saving = false
    }
  }
</script>

<Dialog.Root bind:open={() => open, guard.change}>
  <Dialog.Content class="sm:max-w-lg">
    <form class="grid gap-5" onsubmit={submit}>
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        <Dialog.Header>
          <Dialog.Title>
            {bucket ? t('storage.dialog.editTitle', { bucket: bucket.id }) : t('storage.dialog.createTitle')}
          </Dialog.Title>
        </Dialog.Header>
        <Field.Group class="gap-5">
        {#if !bucket}
          <Field.Field data-invalid={nameInvalid}>
            <Field.Label for="bucket-id">{t('storage.dialog.name')}</Field.Label>
            <Input
              id="bucket-id"
              name="bucket-name"
              bind:value={id}
              placeholder={t('storage.dialog.namePlaceholder')}
              autocomplete="off"
              spellcheck={false}
              class="font-mono"
              aria-invalid={nameInvalid}
              aria-describedby="bucket-id-hint"
              required
            />
            {#if (nameInvalid)}<Field.Error id="bucket-id-hint">{t('storage.dialog.nameInvalid')}</Field.Error>
            {/if}
            {#if !(nameInvalid)}<Field.Description id="bucket-id-hint">{t('storage.dialog.nameHint')}</Field.Description>{/if}
          </Field.Field>
        {/if}
        <Field.Field>
          <Field.Field orientation="horizontal">
            <Checkbox id="bucket-public" bind:checked={isPublic} aria-describedby="bucket-public-hint" />
            <Field.Label for="bucket-public">{t('storage.dialog.public')}</Field.Label>
          </Field.Field>
          <Field.Description id="bucket-public-hint">{t('storage.dialog.publicHint')}</Field.Description>
          {#if !bucket && isPublic}<Callout>{t('storage.dialog.publicWarning')}</Callout>{/if}
        </Field.Field>
        <Field.Field data-invalid={!limitOk}>
          <Field.Label for="bucket-limit">{t('storage.dialog.limit')}</Field.Label>
          <Input
            id="bucket-limit"
            name="file-size-limit"
            bind:value={limitMb}
            inputmode="decimal"
            autocomplete="off"
            class="font-mono"
            aria-invalid={!limitOk}
            aria-describedby="bucket-limit-hint"
          />
          {#if (!limitOk)}<Field.Error id="bucket-limit-hint">{t('storage.dialog.limitInvalid')}</Field.Error>
          {/if}
          {#if !(!limitOk)}<Field.Description id="bucket-limit-hint">
            {t('storage.dialog.limitHint', { size: formatBytes(serverLimit, intlLocale()) })}
          </Field.Description>{/if}
        </Field.Field>
        <Field.Field>
          <Field.Label for="bucket-types">{t('storage.dialog.types')}</Field.Label>
          <Input id="bucket-types" name="accepted-types" bind:value={types} placeholder="image/*" autocomplete="off" spellcheck={false} class="font-mono" aria-describedby="bucket-types-hint" />
          <Field.Description id="bucket-types-hint">{t('storage.dialog.typesHint')}</Field.Description>
        </Field.Field>
        </Field.Group>
        {#if failure}<Field.Error>{failure}</Field.Error>{/if}
        {#if !bucket && !validBucketName(id)}<p id="bucket-submit-hint" class="text-sm text-muted-foreground">{t('storage.dialog.nameRequired')}</p>{/if}
        <Dialog.Footer>
          <Button variant="outline" disabled={saving} onclick={guard.request}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={saving || !ready} aria-describedby={!bucket && !validBucketName(id) ? 'bucket-submit-hint' : undefined}>
            {#if (saving)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
            {#if !(saving) && (bucket)}<Save data-icon="inline-start" aria-hidden="true" />{/if}
            {#if !(saving) && !(bucket)}<HardDrive data-icon="inline-start" aria-hidden="true" />{/if}
            {saving ? t('common.saving') : bucket ? t('storage.dialog.save') : t('storage.dialog.create')}
          </Button>
        </Dialog.Footer>
        </fieldset>
    </form>
  </Dialog.Content>
</Dialog.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
{#if bucket}
  <ConfirmDialog
    bind:open={confirmPublicOpen}
    title={t('storage.dialog.confirmPublic.title', { bucket: bucket.id })}
    description={bucket.files ? t('storage.dialog.confirmPublic.description', { count: bucket.files }) : t('storage.dialog.confirmPublic.empty')}
    confirmLabel={t('storage.dialog.confirmPublic.confirm')}
    destructive
    onconfirm={save}
  />
{/if}
