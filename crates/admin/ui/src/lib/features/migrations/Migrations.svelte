<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import FilePlus from '@lucide/svelte/icons/file-plus'
  import Download from '@lucide/svelte/icons/download'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { Badge } from '$lib/components/ui/badge'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import { CloseGuard } from '$lib/forms/close-guard.svelte'
  import UnsavedChangesDialog from '$lib/components/shared/UnsavedChangesDialog.svelte'
  import * as Table from '$lib/components/ui/table'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Field from '$lib/components/ui/field'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { toast } from 'svelte-sonner'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api } from '$lib/transport/api'
  import { downloadText } from '$lib/browser/download'
  import type { ExportedMigration, MigrationsData } from '$lib/contracts/types'
  import { errorMessage, hasMessage, i18n, intlLocale, t, translate } from '$lib/i18n/index.svelte'

  const resource = new RemoteResource<MigrationsData>()
  const data = $derived(resource.data)
  const error = $derived(resource.error ? errorMessage(resource.error) : '')
  const loading = $derived(resource.loading)

  async function load() {
    await resource.load(signal => api.get<MigrationsData>('/migrations', { signal }))
  }
  onMount(() => { void load(); return () => resource.cancel() })


  // "Generate migration" dialog. The default name follows the panel language.
  let dialogOpen = $state(false)
  let name = $state(t('migrations.dialog.defaultName'))
  let saving = $state(false)
  let initialName = $state('')
  const guard = new CloseGuard(() => name !== initialName, () => saving, () => (dialogOpen = false), () => dialogOpen)
  $effect(() => { if (dialogOpen) untrack(() => (initialName = name)) })
  // Last migration generated in this visit, to remind the next step.
  let generated = $state<ExportedMigration | null>(null)

  const validName = $derived(/^[a-z0-9][a-z0-9_]{0,59}$/.test(name))

  async function generate(event: SubmitEvent) {
    event.preventDefault()
    if (!validName || saving) return
    saving = true
    try {
      const result = await api.post<ExportedMigration>('/migrations', { name })
      downloadText(result.filename, result.sql, 'application/sql')
      generated = result
      dialogOpen = false
      toast.success(t('migrations.generatedToast', { filename: result.filename }))
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      saving = false
    }
  }

  const when = $derived(new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }))
  const date = (value: string | null) => {
    if (!value) return '—'
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : when.format(parsed)
  }

  const steps = $derived([
    { id: 'generate', title: t('migrations.steps.generate'), hint: generated ? generated.filename : t('migrations.steps.generateHint'), done: !!generated },
    { id: 'keep', title: t('migrations.steps.keep'), hint: t('migrations.steps.keepHint'), done: false },
    { id: 'apply', title: t('migrations.steps.apply'), hint: t('migrations.steps.applyHint'), done: false },
  ])

  type Row = MigrationsData['migrations'][number]
  // Status of each migration; colour only for what needs action (D55).
  function status(m: Row): { label: string; warn: boolean } {
    if (!m.applied_on) return { label: t('migrations.status.notApplied'), warn: true }
    if (m.in_folder === false) return { label: t('migrations.status.outsideFolder'), warn: true }
    return { label: t('migrations.status.applied'), warn: false }
  }

  // In the panel language when the server recorded the kind; else the stored text.
  function describe(change: MigrationsData['pending'][number]): string {
    const key = `migrations.changes.${change.kind}`
    return change.kind && change.target !== null && hasMessage(key)
      ? translate(i18n.locale, key, { name: change.target })
      : change.summary
  }
</script>

{#snippet howTo(data: MigrationsData)}
  <!-- How a panel change reaches the other environments. -->
  <section class="grid gap-4" aria-label={t('migrations.steps.title')}>
    <h2 class="text-sm font-semibold">{t('migrations.steps.title')}</h2>
    <ol class="grid gap-4" aria-label={t('migrations.steps.label')}>
      {#each steps as step, index (step.id)}
        <li class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-1">
          <span class={['grid size-7 place-items-center rounded-full text-xs font-semibold tabular-nums', step.done ? 'bg-brand/15 text-brand' : 'bg-well']}>
            {#if (step.done)}<CircleCheck class="size-4" aria-hidden="true" />{/if}
            {#if !(step.done)}{index + 1}{/if}
          </span>
          <p class="self-center text-sm font-medium">{step.title}</p>
          <p class={['col-start-2 text-sm text-muted-foreground', step.id === 'generate' && generated && 'break-all font-mono text-xs']}>{step.hint}</p>
          {#if step.id === 'keep' && generated}
            <Badge variant="secondary" class="col-start-2 mt-1 justify-self-start">{t(data.migrations.some((migration) => migration.version === generated!.version && migration.in_folder === true) ? 'migrations.steps.inFolder' : 'migrations.steps.pending')}</Badge>
          {/if}
        </li>
      {/each}
    </ol>
    {#if generated}
      <p class="rounded-2xl bg-well px-4 py-3 text-sm">
        <span class="font-mono">{generated.filename}</span> {t('migrations.generatedBefore')}
        <span class="font-mono">migrations/</span> {t('migrations.generatedMiddle')}
        <span class="font-mono">nelcota migrate</span> {t('migrations.generatedAfter')}
      </p>
    {/if}
  </section>
{/snippet}

<!-- Same frame as Tables and SQL: the Database tabs head a sidebar card on
     the left, the work fills the rest. -->
<div class="mx-auto flex w-full max-w-page flex-col gap-3 px-4 pt-1 pb-4 *:min-w-0 sm:px-6 lg:h-full lg:min-h-0 lg:flex-row lg:px-8">
  <aside aria-label={t('migrations.title')} class="flex w-full shrink-0 flex-col overflow-hidden rounded-3xl bg-card lg:w-64 xl:w-72">
    <div class="grid gap-3 border-b p-4">
      <div class="grid gap-1 px-1">
        <h1 class="text-sm font-semibold">{t('migrations.title')}</h1>
        <p class="text-xs text-muted-foreground">{t('migrations.description')}</p>
      </div>
    </div>
    <div class="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
      {#if (data)}
        <dl class="grid grid-cols-3 gap-3 lg:grid-cols-1">
          <div class="grid content-start gap-1 lg:flex lg:items-baseline lg:justify-between">
            <dt class="text-xs text-muted-foreground lg:text-sm">{t('migrations.stats.pending')}</dt>
            <dd class={['text-2xl font-semibold tracking-tight tabular-nums', data.pending.length > 0 && 'text-warning']}>{data.pending.length}</dd>
          </div>
          <div class="grid content-start gap-1 lg:flex lg:items-baseline lg:justify-between">
            <dt class="text-xs text-muted-foreground lg:text-sm">{t('migrations.stats.applied')}</dt>
            <dd class="text-2xl font-semibold tracking-tight tabular-nums">{data.migrations.filter((migration) => migration.applied_on).length}</dd>
          </div>
          <div class="grid content-start gap-1 lg:flex lg:items-baseline lg:justify-between">
            <dt class="text-xs text-muted-foreground lg:text-sm">{t('migrations.stats.next')}</dt>
            <dd class="font-mono text-2xl font-semibold tracking-tight tabular-nums">V{data.next_version}</dd>
          </div>
        </dl>
        <div class="hidden border-t pt-5 lg:block">{@render howTo(data)}</div>
      {/if}
      {#if !(data) && (loading)}
        {#each [0, 1, 2] as i (i)}<Skeleton class="h-7 w-full" />{/each}
      {/if}
    </div>
  </aside>

  <div class="grid min-w-0 flex-1 content-start gap-3 lg:overflow-y-auto lg:rounded-3xl">
    {#if error}<LoadError message={error} onretry={load} busy={loading} />{/if}
    {#if (!data && loading)}
      <Skeleton class="h-40 rounded-3xl" />
      <Skeleton class="h-72 rounded-3xl" />
    {/if}
    {#if !(!data && loading) && (data)}
    <section class="grid gap-4 rounded-3xl bg-card p-5" aria-labelledby="migrations-pending">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="grid gap-1">
          <h2 id="migrations-pending" class="text-lg font-semibold">{t('migrations.pendingTitle')}</h2>
          <p class="text-sm text-muted-foreground">{t('migrations.pendingHint')}</p>
        </div>
        {#if data.pending.length}
          <Button onclick={() => (dialogOpen = true)}><FilePlus data-icon="inline-start" aria-hidden="true" />{t('migrations.generate')}</Button>
        {/if}
      </div>

      {#if (data.pending.length === 0)}
        <div class="flex items-center gap-3 rounded-2xl bg-well px-4 py-3.5">
          <CircleCheck class="size-5 shrink-0 text-brand" aria-hidden="true" />
          <div class="grid gap-0.5">
            <p class="text-sm font-medium">{t('migrations.nothingPending')}</p>
            <p class="text-sm text-muted-foreground">{t('migrations.nothingPendingHint')}</p>
          </div>
        </div>
      {/if}
      {#if !(data.pending.length === 0)}
        <ol class="grid gap-2">
          {#each data.pending as change (change.id)}
            <li class="rounded-2xl bg-well px-4 py-3">
              <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p class="text-sm font-medium">{describe(change)}</p>
                <p class="text-xs text-muted-foreground">{date(change.applied_at)}</p>
              </div>
              <details class="mt-1 text-sm">
                <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
                  {t('migrations.statements', { count: change.statements.length })}
                </summary>
                <div class="mt-2"><CodeBlock code={change.statements
                    .map((s) => s.trim().replace(/;$/, '') + ';')
                    .join('\n')} lang="sql" /></div>
              </details>
            </li>
          {/each}
        </ol>
      {/if}
    </section>

    <section class="grid gap-4 rounded-3xl bg-card p-5" aria-labelledby="migrations-list">
      <h2 id="migrations-list" class="text-lg font-semibold">{t('migrations.listTitle')}</h2>
      {#if (data.migrations.length === 0)}
        <div class="flex items-center gap-3 rounded-2xl bg-well px-4 py-3.5">
          <FilePlus class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div class="grid gap-0.5">
            <p class="text-sm font-medium">{t('migrations.noMigrations')}</p>
            <p class="text-sm text-muted-foreground">{t('migrations.noMigrationsHint')}</p>
          </div>
        </div>
      {/if}
      {#if !(data.migrations.length === 0)}
        <div class="grid gap-2 md:hidden">
          {#each data.migrations as migration (migration.version)}
            {@const situation = status(migration)}
            <article class="grid min-w-0 gap-3 rounded-2xl bg-well p-4">
              <p class="break-words font-mono text-xs"><span class="text-muted-foreground">V{migration.version}</span> · {migration.name}</p>
              <div class="flex flex-wrap items-center gap-2"><Badge variant="outline" class={situation.warn ? 'border-warning/30 text-warning' : 'text-muted-foreground'}>{#if (situation.warn)}<CircleAlert aria-hidden="true" />{/if}{#if !(situation.warn)}<CircleCheck aria-hidden="true" />{/if}{situation.label}</Badge>{#if migration.from_panel}<span class="text-xs text-muted-foreground">{t('migrations.fromPanel')}</span>{/if}</div>
              <p class="text-xs text-muted-foreground">{t('migrations.columns.appliedOn')}: {date(migration.applied_on)}</p>
              {#if migration.from_panel}<Button variant="outline" size="sm" class="justify-self-start" href={`/admin/api/migrations/${migration.version}/file`} download><Download data-icon="inline-start" aria-hidden="true" />{t('common.download')}</Button>{/if}
            </article>
          {/each}
        </div>
        <!-- Edge cells drop their outer padding so the table lines up with the
             heading without bleeding past the card; tighter cells and a
             truncating name keep it within the card beside the side column. -->
        <div class="hidden md:block">
          <Table.Root>
            <Table.Header>
              <Table.Row class="hover:bg-transparent">
                <Table.Head class="pr-3 pl-0">{t('migrations.columns.version')}</Table.Head>
                <Table.Head class="w-full px-3">{t('migrations.columns.name')}</Table.Head>
                <Table.Head class="px-3">{t('migrations.columns.status')}</Table.Head>
                <Table.Head class="px-3">{t('migrations.columns.appliedOn')}</Table.Head>
                <Table.Head class="pr-0 pl-3"><span class="sr-only">{t('common.actions')}</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each data.migrations as migration (migration.version)}
                {@const situation = status(migration)}
                <Table.Row>
                  <Table.Cell class="pr-3 pl-0 font-mono text-xs tabular-nums">V{migration.version}</Table.Cell>
                  <Table.Cell class="max-w-0 min-w-32 px-3">
                    <span class="block truncate font-mono text-xs" title={migration.name}>{migration.name}</span>
                    {#if migration.from_panel}<span class="block truncate text-xs text-muted-foreground">{t('migrations.fromPanel')}</span>{/if}
                  </Table.Cell>
                  <Table.Cell class="px-3"><Badge variant="outline" class={situation.warn ? 'border-warning/30 text-warning' : 'text-muted-foreground'}>{#if (situation.warn)}<CircleAlert aria-hidden="true" />{/if}{#if !(situation.warn)}<CircleCheck aria-hidden="true" />{/if}{situation.label}</Badge></Table.Cell>
                  <Table.Cell class="px-3 whitespace-normal text-muted-foreground">{date(migration.applied_on)}</Table.Cell>
                  <Table.Cell class="pr-0 pl-3 text-right">
                    {#if migration.from_panel}
                      <!-- Icon-only until 2xl; the hidden text keeps the accessible name. -->
                      <Button
                        variant="ghost"
                        size="sm"
                        href={`/admin/api/migrations/${migration.version}/file`}
                        title={t('common.download')}
                        download><Download data-icon="inline-start" aria-hidden="true" /><span class="sr-only 2xl:not-sr-only">{t('common.download')}</span></Button
                      >
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      {/if}
      <p class="flex items-start gap-2 text-xs text-muted-foreground">
        <FolderOpen class="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {#if (data.folder)}
            {t('migrations.folderRead')} <span class="font-mono">{data.folder}</span>.
          {/if}
          {#if !(data.folder)}
            {t('migrations.folderMissing')}
          {/if}
        </span>
      </p>
    </section>

      <div class="rounded-3xl bg-card p-5 lg:hidden">{@render howTo(data)}</div>
    {/if}
  </div>
</div>

<Dialog.Root bind:open={() => dialogOpen, guard.change}>
  <Dialog.Content class="sm:max-w-md">
    <form class="grid gap-5" onsubmit={generate}>
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
      <Dialog.Header>
        <Dialog.Title>{t('migrations.generate')}</Dialog.Title>
        <Dialog.Description>
          {t('migrations.dialog.description', { count: data?.pending.length ?? 0 })}
        </Dialog.Description>
      </Dialog.Header>
      <Field.Group>
      <Field.Field data-invalid={!validName}>
        <Field.Label for="migration-name">{t('common.name')}</Field.Label>
        <Input id="migration-name" name="migration-name" bind:value={name} maxlength={60} autocomplete="off" spellcheck={false} aria-invalid={!validName} aria-describedby="migration-name-hint" />
          {#if (validName)}<Field.Description id="migration-name-hint">
            {t('migrations.dialog.file')} <span class="font-mono">V{data?.next_version}__{name}.sql</span>
          </Field.Description>{/if}
          {#if !(validName)}<Field.Error id="migration-name-hint">
            {t('migrations.dialog.nameRule')}
          </Field.Error>{/if}
      </Field.Field>
      </Field.Group>
      <Dialog.Footer>
        <Button variant="outline" disabled={saving} onclick={guard.request}>{t('common.cancel')}</Button>
        <Button type="submit" disabled={!validName || saving}>{#if (saving)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}{#if !(saving)}<FilePlus data-icon="inline-start" aria-hidden="true" />{/if}{saving ? t('migrations.dialog.generating') : t('migrations.dialog.submit')}</Button>
      </Dialog.Footer>
    </fieldset>
    </form>
  </Dialog.Content>
</Dialog.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
