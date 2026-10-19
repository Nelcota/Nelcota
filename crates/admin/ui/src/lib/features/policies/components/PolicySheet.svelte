<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { CloseGuard } from '$lib/forms/close-guard.svelte'
  import UnsavedChangesDialog from '$lib/components/shared/UnsavedChangesDialog.svelte'
  import WizardProgress from '$lib/components/shared/WizardProgress.svelte'
  import Save from '@lucide/svelte/icons/save'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import * as Sheet from '$lib/components/ui/sheet'
  import * as Select from '$lib/components/ui/select'
  import * as Field from '$lib/components/ui/field'
  import * as Alert from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { toast } from 'svelte-sonner'
  import AccessChoices from '$lib/shared/schema/components/AccessChoices.svelte'
  import PolicySqlFields from '$lib/shared/schema/components/PolicySqlFields.svelte'
  import SqlPreview from '$lib/shared/schema/components/SqlPreview.svelte'
  import { ddl, policyFields, type PolicyDef, type ColumnInfo } from '$lib/shared/schema/ddl'
  import { guidedPolicy, uniquePolicyName, nameProblem, type Audience, type AccessLevel } from '$lib/shared/schema/guided-access'
  import { guessOwnerColumn } from '$lib/features/policies/policy-templates'
  import { SqlPreview as Preview } from '$lib/shared/schema/preview.svelte'
  import { errorMessage, t } from '$lib/i18n/index.svelte'
  import { href } from '$lib/navigation/router.svelte'

  let { open = $bindable(false), table, original = null, existingNames = [], onsaved }: { open?: boolean; table: string; original?: PolicyDef | null; existingNames?: string[]; onsaved: () => void } = $props()
  const blank = (): PolicyDef => ({ name: '', command: 'select', roles: ['authenticated'], permissive: true, using: '', check: '' })
  let custom = $state<PolicyDef>(blank())
  let advanced = $state(false)
  let prepareAccess = $state(false)
  let audience = $state<Audience>('owner')
  let level = $state<AccessLevel>('read')
  let ownerColumn = $state('')
  let initialOwner = $state('')
  let createOwner = $state(false)
  let initialCreateOwner = $state(false)
  let columns = $state<ColumnInfo[]>([])
  let loading = $state(false)
  let loadError = $state('')
  let rlsEnabled = $state(true)
  let request: AbortController | undefined
  let name = $state('')
  let nameEdited = $state(false)
  let saving = $state(false)
  let step = $state(0)
  let attempted = $state(false)
  let failure = $state('')
  let heading = $state<HTMLHeadingElement | null>(null)
  let initialValue = $state('')
  const draft = $derived(JSON.stringify({ custom, advanced, prepareAccess, audience, level, name: nameEdited ? name : '', ownerColumn: ownerColumn === initialOwner ? '' : ownerColumn, createOwner: createOwner !== initialCreateOwner }))
  const guard = new CloseGuard(() => draft !== initialValue, () => saving, () => (open = false))
  const preview = new Preview()
  const ownerColumns = $derived(columns.filter(column => column.data_type === 'uuid' && (!column.primary_key || !column.default)))
  const addOwner = $derived(!advanced && audience === 'owner' && !ownerColumns.length && createOwner && !columns.some(column => column.name === 'user_id'))
  const selectedOwner = $derived(addOwner ? 'user_id' : ownerColumn)
  const ownerValid = $derived(audience !== 'owner' || addOwner || ownerColumns.some(column => column.name === ownerColumn))
  const generated = $derived(guidedPolicy(audience, level, selectedOwner)!)
  const suggestedName = $derived(uniquePolicyName(generated.name, existingNames))
  const fields = $derived(policyFields(custom.command))
  const payload = $derived<PolicyDef>(advanced ? {
    ...custom, name: custom.name.trim(), using: fields.using ? custom.using?.trim() || null : null, check: fields.check ? custom.check?.trim() || null : null,
  } : { ...generated, name: nameEdited ? name.trim() : suggestedName })
  const nameError = $derived(nameProblem(payload.name) ?? (payload.name !== original?.name && existingNames.includes(payload.name) ? 'duplicate' : null))
  const ready = $derived(!nameError && (advanced ? payload.command === 'insert' ? !!payload.check : !!payload.using : !loading && !loadError && ownerValid))
  const summary = $derived(t(`guided.access.summary.${audience}`, { actions: t(`guided.access.actions.${level}`) }))
  const steps = $derived([t('guided.policy.steps.who'), t('guided.policy.steps.action'), t('guided.policy.steps.review')])

  async function loadColumns() {
    request?.abort()
    const controller = request = new AbortController()
    loading = true; loadError = ''
    try {
      const structure = await ddl.structure(table, { signal: controller.signal })
      if (controller.signal.aborted) return
      columns = structure.columns; rlsEnabled = structure.rls_enabled
      const candidates = structure.columns.filter(column => column.data_type === 'uuid' && (!column.primary_key || !column.default))
      const guessed = guessOwnerColumn(candidates)
      ownerColumn = candidates.find(column => column.name === guessed)?.name ?? candidates[0]?.name ?? ''
      initialOwner = ownerColumn
      createOwner = !candidates.length && !structure.columns.some(column => column.name === 'user_id')
      initialCreateOwner = createOwner
    } catch (error) { if (!controller.signal.aborted) loadError = errorMessage(error) }
    finally { if (!controller.signal.aborted) loading = false }
  }
  $effect(() => {
    if (!open) return
    untrack(() => {
      custom = original ? { ...original, roles: [...original.roles] } : blank()
      advanced = !!original; prepareAccess = false; audience = 'owner'; level = 'read'; ownerColumn = ''; initialOwner = ''; columns = []; createOwner = false; initialCreateOwner = false
      name = ''; nameEdited = false; saving = false; step = 0; attempted = false; failure = ''; loadError = ''
      initialValue = JSON.stringify({ custom, advanced, prepareAccess, audience, level, name: '', ownerColumn: '', createOwner: false })
      void loadColumns()
    })
    return () => { request?.abort(); preview.clear() }
  })
  $effect(() => {
    if (!open || !ready || !advanced && step !== 2) return preview.clear()
    const snapshot = $state.snapshot(payload)
    const prepare = !advanced || prepareAccess
    const ownerField = addOwner ? 'user_id' : undefined
    preview.schedule(signal => original ? ddl.replacePolicy(table, original.name, snapshot, true, { signal, prepareAccess: prepare }) : ddl.createPolicy(table, snapshot, true, { signal, prepareAccess: prepare, ownerColumn: ownerField }))
  })
  async function changeStep(value: number) {
    step = value; attempted = false; failure = ''
    await tick(); heading?.focus()
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (saving) return
    attempted = true
    if (!advanced && step < 2) {
      if (loading || loadError || step === 1 && !ownerValid) return
      return changeStep(step + 1)
    }
    if (!ready) { await tick(); document.querySelector<HTMLInputElement>('#policy-form [aria-invalid="true"]')?.focus(); return }
    saving = true; failure = ''
    try {
      const snapshot = $state.snapshot(payload)
      const options = { prepareAccess: !advanced || prepareAccess, ownerColumn: addOwner ? 'user_id' : undefined }
      if (original) {
        await ddl.replacePolicy(table, original.name, snapshot, false, options)
        toast.success(t('policies.sheet.saved', { name: snapshot.name })); open = false; onsaved()
        return
      }
      await ddl.createPolicy(table, snapshot, false, options)
      toast.success(t('policies.sheet.saved', { name: snapshot.name })); open = false; onsaved()
    } catch (error) { failure = errorMessage(error) }
    finally { saving = false }
  }
</script>

<Sheet.Root bind:open={() => open, guard.change}>
  <Sheet.Content class="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl">
    <Sheet.Header class="shrink-0 border-b px-6 py-5">
      <Sheet.Title>{original ? t('policies.sheet.edit') : t('guided.policy.submit')}</Sheet.Title>
      <Sheet.Description>{t('policies.sheet.onTable')} <span class="font-medium text-foreground [overflow-wrap:anywhere]">{table}</span>. {t('guided.policy.description')}</Sheet.Description>
    </Sheet.Header>
    {#if !advanced}<WizardProgress {step} {steps} />{/if}
    <form id="policy-form" class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6" onsubmit={submit} novalidate>
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        {#if !original}<Button variant="ghost" size="sm" class="self-start" onclick={() => { advanced = !advanced; failure = ''; attempted = false }}>{advanced ? t('guided.policy.guided') : t('guided.policy.advanced')}</Button>{/if}
        {#if loadError}<Alert.Root variant="destructive"><Alert.Description>{loadError}</Alert.Description><Button variant="outline" size="sm" onclick={loadColumns}>{t('guided.policy.retry')}</Button></Alert.Root>{/if}
        {#if (advanced)}
          <p class="text-sm text-muted-foreground">{t('guided.policy.advancedHint')}</p>
          <Field.Group><Field.Field data-invalid={attempted && !!nameError}><Field.Label for="policy-name">{t('guided.policy.name')}</Field.Label><Input id="policy-name" bind:value={custom.name} aria-invalid={attempted && !!nameError} />{#if attempted && nameError}<Field.Error>{nameError === 'duplicate' ? t('guided.policy.duplicate') : t(`guided.problems.${nameError}`)}</Field.Error>{/if}</Field.Field></Field.Group>
          <PolicySqlFields bind:policy={custom} {ownerColumn} />
          <Field.Group><Field.Field orientation="horizontal"><Checkbox id="policy-prepare" bind:checked={prepareAccess} /><Field.Content><Field.Label for="policy-prepare">{t('guided.policy.activate')}</Field.Label><Field.Description>{t('guided.policy.activateHint')}</Field.Description></Field.Content></Field.Field></Field.Group>
          {#if !rlsEnabled && !prepareAccess}<Alert.Root><Alert.Description>{t('guided.policy.inactive')}</Alert.Description></Alert.Root>{/if}
          <SqlPreview {preview} />
        {/if}
        {#if !(advanced)}
          <div class="flex flex-col gap-1.5"><h3 bind:this={heading} tabindex="-1" class="text-lg font-semibold outline-none">{step === 0 ? t('guided.policy.whoTitle') : step === 1 ? t('guided.policy.actionTitle') : t('guided.review')}</h3>{#if step === 2}<p class="text-sm text-muted-foreground">{t('guided.policy.reviewHint')}</p>{/if}</div>
          {#if loading}<p class="text-sm text-muted-foreground" role="status">{t('guided.policy.loading')}</p>{/if}
          {#if (step === 0)}
            <AccessChoices bind:audience bind:level part="who" />
          {/if}
          {#if !(step === 0) && (step === 1)}
            <AccessChoices bind:audience bind:level part="action" />
            {#if audience === 'owner' && !loading && !loadError}
              {#if (!ownerColumns.length)}
                {#if (!columns.some(column => column.name === 'user_id'))}
                  <Field.Group><Field.Field orientation="horizontal"><Checkbox id="policy-add-owner" bind:checked={createOwner} /><Field.Content><Field.Label for="policy-add-owner">{t('guided.policy.addOwner')}</Field.Label><Field.Description>{t('guided.policy.addOwnerHint')}</Field.Description></Field.Content></Field.Field></Field.Group>
                {/if}
                {#if !(!columns.some(column => column.name === 'user_id'))}
                  <Alert.Root><Alert.Description>{t('guided.policy.noOwner')}</Alert.Description></Alert.Root>
                  <div class="flex flex-wrap gap-2"><Button variant="outline" href={href(`/tables/${encodeURIComponent(table)}/structure`)} target="_blank" rel="noopener">{t('guided.policy.structure')}</Button><Button variant="ghost" onclick={loadColumns}>{t('guided.policy.retry')}</Button></div>
                {/if}
              {/if}
              {#if !(!ownerColumns.length)}
                <Field.Group><Field.Field><Field.Label for="policy-owner-column">{t('guided.policy.ownerField')}</Field.Label><Select.Root type="single" bind:value={ownerColumn}><Select.Trigger id="policy-owner-column" class="w-full"><span class="truncate">{ownerColumn}</span></Select.Trigger><Select.Content><Select.Group>{#each ownerColumns as column}<Select.Item value={column.name}>{column.name}</Select.Item>{/each}</Select.Group></Select.Content></Select.Root><Field.Description>{t('guided.policy.ownerHint')}</Field.Description></Field.Field></Field.Group>
              {/if}
            {/if}
          {/if}
          {#if !(step === 0) && !(step === 1)}
            <Alert.Root><Alert.Title>{table}</Alert.Title><Alert.Description>{summary}</Alert.Description></Alert.Root>
            {#if audience === 'owner'}<p class="text-sm text-muted-foreground">{t('guided.policy.ownerSummary', { column: selectedOwner })}</p>{/if}
            {#if addOwner}<Alert.Root><Alert.Description>{t('guided.policy.newOwnerReview')}</Alert.Description></Alert.Root>{/if}
            <p class="text-sm text-muted-foreground">{t('guided.access.protected')}</p>
            <Field.Group><Field.Field data-invalid={attempted && !!nameError}><Field.Label for="policy-name">{t('guided.policy.name')}</Field.Label><Input id="policy-name" value={nameEdited ? name : suggestedName} oninput={event => { name = event.currentTarget.value; nameEdited = true }} aria-invalid={attempted && !!nameError} /><Field.Description>{t('guided.policy.nameHint')}</Field.Description>{#if attempted && nameError}<Field.Error>{nameError === 'duplicate' ? t('guided.policy.duplicate') : t(`guided.problems.${nameError}`)}</Field.Error>{/if}</Field.Field></Field.Group>
            <SqlPreview {preview} />
          {/if}
        {/if}
        {#if failure}<Field.Error role="alert">{failure}</Field.Error>{/if}
      </fieldset>
    </form>
    <Sheet.Footer class="grid shrink-0 grid-cols-2 items-center gap-2 border-t px-6 py-4 sm:flex sm:flex-row sm:justify-between">
      <Button variant="ghost" disabled={saving} onclick={guard.request}>{t('common.cancel')}</Button>
      <div class="contents sm:flex sm:gap-2">
        {#if !advanced && step > 0}<Button variant="outline" disabled={saving} onclick={() => changeStep(step - 1)}>{t('guided.back')}</Button>{/if}
        <Button class={advanced || step > 0 ? 'max-sm:col-span-2' : undefined} type="submit" form="policy-form" disabled={saving || !advanced && (loading || !!loadError || step === 1 && !ownerValid)}>
          {#if (saving)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
          {#if !(saving) && (advanced || step === 2)}<Save data-icon="inline-start" aria-hidden="true" />{/if}
          {saving ? t('common.saving') : !advanced && step < 2 ? t('guided.next') : original ? t('policies.sheet.savePolicy') : t('guided.policy.submit')}
        </Button>
      </div>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
