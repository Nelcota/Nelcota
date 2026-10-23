<script lang="ts">
  import { untrack } from 'svelte'
  import Save from '@lucide/svelte/icons/save'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import ShieldOff from '@lucide/svelte/icons/shield-off'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import GrantsEditor from '$lib/shared/schema/components/GrantsEditor.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import { API_ROLES, grantChanges, type AlterAction, type GrantDef, type Structure } from '$lib/shared/schema/ddl'
  import { t } from '$lib/i18n/index.svelte'

  let {
    structure,
    policies,
    onalter,
    ondrop,
  }: {
    structure: Structure
    /** Policies on the table (unknown: no warning before turning RLS on). */
    policies?: number
    /** Applies the actions; resolves after the structure reloads. */
    onalter: (actions: AlterAction[]) => Promise<void>
    ondrop: () => void
  } = $props()

  const fromStructure = (s: Structure): GrantDef[] =>
    API_ROLES.map((role) => ({ role, privileges: [...(s.grants.find((g) => g.role === role)?.privileges ?? [])] }))

  let name = $state('')
  let comment = $state('')
  let grants = $state<GrantDef[]>([])
  let disableRlsOpen = $state(false)
  let enableRlsOpen = $state(false)
  let renameOpen = $state(false)
  let busy = $state<'identity' | 'grants' | 'rls' | null>(null)
  let previous: Structure | null = null

  // Drafts go back to the saved state whenever the structure reloads.
  $effect(() => {
    const saved = structure
    untrack(() => {
      const changedTable = previous && previous.name !== saved.name
      if (!previous || changedTable || busy === 'identity' || name === previous.name) name = saved.name
      if (!previous || changedTable || busy === 'identity' || comment === (previous.comment ?? '')) comment = saved.comment ?? ''
      if (!previous || changedTable || busy === 'grants' || grantChanges(previous.grants, grants).length === 0) grants = fromStructure(saved)
      previous = saved
    })
  })

  const identityChanges = $derived.by((): AlterAction[] => {
    const actions: AlterAction[] = []
    if ((comment.trim() || null) !== structure.comment) actions.push({ action: 'set_comment', comment: comment.trim() || null })
    if (name.trim() && name.trim() !== structure.name) actions.push({ action: 'rename_table', name: name.trim() })
    return actions
  })
  const pendingGrants = $derived(grantChanges(structure.grants, grants))

  function resetIdentity() {
    name = structure.name
    comment = structure.comment ?? ''
  }

  async function apply(actions: AlterAction[], area: 'identity' | 'grants' | 'rls') {
    if (busy || actions.length === 0) return
    busy = area
    try { await onalter(actions) } finally { busy = null }
  }
</script>

<fieldset class="grid min-w-0 gap-4"disabled={busy !== null} aria-busy={busy !== null}>
  <section class="rounded-3xl bg-well p-5">
    <h2 class="text-base font-semibold">{t('tables.settings.table')}</h2>
    <form
      class="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
      onsubmit={(e) => {
        e.preventDefault()
        // A new name moves the REST endpoint: confirm before breaking clients.
        if (identityChanges.some((a) => a.action === 'rename_table')) { renameOpen = true; return }
        apply(identityChanges, 'identity').catch(() => {})
      }}
    >
      <div class="grid gap-2">
        <Label for="settings-name">{t('tables.settings.name')}</Label>
        <Input id="settings-name" bind:value={name} class="font-mono" />
      </div>
      <div class="grid gap-2">
        <Label for="settings-comment">{t('tables.settings.description')}</Label>
        <Input id="settings-comment" bind:value={comment} placeholder={t('tables.settings.descriptionPlaceholder')} />
      </div>
      <!-- Filled only while there is something to save, so the state reads at a glance. -->
      <Button size="sm" type="submit" variant={identityChanges.length ? 'default' : 'outline'} disabled={busy !== null || identityChanges.length === 0}>{#if (busy === 'identity')}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}{#if !(busy === 'identity')}<Save data-icon="inline-start" aria-hidden="true" />{/if}{busy === 'identity' ? t('common.saving') : t('tables.settings.save')}</Button>
      {#if identityChanges.length && busy !== 'identity'}
        <p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground sm:col-span-3" role="status">
          {t('tables.settings.unsaved')}
          <button type="button" class="cursor-pointer text-foreground underline underline-offset-4" onclick={resetIdentity}>{t('tables.settings.undo')}</button>
        </p>
      {/if}
    </form>
  </section>

  <section class="flex flex-wrap items-center gap-4 rounded-3xl bg-well p-5">
    {#if (structure.rls_enabled)}
      <div class="min-w-0 flex-1 basis-60">
        <h2 class="text-base font-semibold">{t('tables.settings.rls')}</h2>
        <p class="mt-0.5 text-sm text-muted-foreground">{t('tables.settings.rlsOn')}</p>
      </div>
      <Button variant="outline" disabled={busy !== null} onclick={() => (disableRlsOpen = true)}><ShieldOff data-icon="inline-start" aria-hidden="true" />{t('tables.settings.disable')}</Button>
    {/if}
    {#if !(structure.rls_enabled)}
      <div class="min-w-0 flex-1 basis-60">
        <h2 class="text-base font-semibold">{t('tables.settings.rls')}</h2>
        <p class="mt-0.5 text-sm text-destructive">{t('tables.settings.rlsOff')}</p>
      </div>
      <Button
        disabled={busy !== null}
        onclick={() => {
          // No policy yet: RLS would hide every row from the API; ask first.
          if (policies === 0) { enableRlsOpen = true; return }
          apply([{ action: 'set_rls', enabled: true }], 'rls').catch(() => {})
        }}>{#if (busy === 'rls')}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}{#if !(busy === 'rls')}<ShieldCheck data-icon="inline-start" aria-hidden="true" />{/if}{t('tables.settings.enableRls')}</Button>
    {/if}
  </section>

  <section class="grid gap-3 rounded-3xl bg-well p-5">
    <div class="min-w-0">
      <h2 class="text-base font-semibold">{t('tables.settings.grants')}</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">{t('tables.settings.grantsHint')}</p>
    </div>
    <GrantsEditor bind:grants surface="bg-card" />
    <!-- The save sits under the checkboxes it saves, not above them. -->
    <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      {#if pendingGrants.length && busy !== 'grants'}
        <p class="mr-auto flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" role="status">
          {t('tables.settings.unsaved')}
          <button type="button" class="cursor-pointer text-foreground underline underline-offset-4" onclick={() => (grants = fromStructure(structure))}>{t('tables.settings.undo')}</button>
        </p>
      {/if}
      <Button size="sm" variant={pendingGrants.length ? 'default' : 'outline'} disabled={busy !== null || pendingGrants.length === 0} onclick={() => apply(pendingGrants, 'grants').catch(() => {})}>
        {#if (busy === 'grants')}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
        {#if !(busy === 'grants')}<Save data-icon="inline-start" aria-hidden="true" />{/if}
        {busy === 'grants' ? t('common.saving') : t('tables.settings.saveGrants')}
      </Button>
    </div>
  </section>

  <section class="flex flex-wrap items-center gap-4 rounded-3xl bg-destructive/10 p-5">
    <div class="min-w-0 flex-1 basis-60">
      <h2 class="text-base font-semibold">{t('tables.settings.dropTitle')}</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">{t('tables.settings.dropHint')}</p>
    </div>
    <Button variant="destructive" disabled={busy !== null} onclick={ondrop}><Trash2 data-icon="inline-start" aria-hidden="true" />{t('tables.settings.dropTitle')}</Button>
  </section>
</fieldset>

<ConfirmDialog
  bind:open={disableRlsOpen}
  title={t('tables.settings.disableRlsTitle')}
  description={t('tables.settings.disableRlsDescription')}
  confirmLabel={t('tables.settings.disable')}
  destructive
  onconfirm={() => apply([{ action: 'set_rls', enabled: false }], 'rls')}
/>

<ConfirmDialog
  bind:open={renameOpen}
  title={t('tables.settings.renameTitle', { from: structure.name, to: name.trim() })}
  description={t('tables.settings.renameDescription', { from: structure.name, to: name.trim() })}
  confirmLabel={t('tables.settings.renameConfirm')}
  destructive
  onconfirm={() => apply(identityChanges, 'identity')}
/>

<ConfirmDialog
  bind:open={enableRlsOpen}
  title={t('policies.enableRlsEmpty.title', { table: structure.name })}
  description={t('policies.enableRlsEmpty.description')}
  confirmLabel={t('policies.enableRlsEmpty.confirm')}
  onconfirm={() => apply([{ action: 'set_rls', enabled: true }], 'rls')}
/>
