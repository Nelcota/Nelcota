<script lang="ts">
  import { onMount } from 'svelte'
  import * as Table from '$lib/components/ui/table'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Button } from '$lib/components/ui/button'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Plus from '@lucide/svelte/icons/plus'
  import HardDrive from '@lucide/svelte/icons/hard-drive'
  import Globe from '@lucide/svelte/icons/globe'
  import Lock from '@lucide/svelte/icons/lock'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import { Badge } from '$lib/components/ui/badge'
  import { toast } from 'svelte-sonner'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import SearchField from '$lib/components/shared/SearchField.svelte'
  import Search from '@lucide/svelte/icons/search'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import BucketDialog from '$lib/features/storage/components/BucketDialog.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api, enc } from '$lib/transport/api'
  import { href } from '$lib/navigation/router.svelte'
  import { formatBytes } from '$lib/features/storage/files'
  import type { Bucket, StorageOverview } from '$lib/contracts/types'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'

  const resource = new RemoteResource<StorageOverview>()
  const data = $derived(resource.data)
  const loading = $derived(resource.loading)
  const error = $derived(resource.error ? errorMessage(resource.error) : '')
  let editing = $state<Bucket | null>(null)
  let dialogOpen = $state(false)
  let removing = $state<Bucket | null>(null)
  let confirmOpen = $state(false)
  let search = $state('')
  const visible = $derived(data?.enabled ? data.buckets.filter(bucket => bucket.id.toLowerCase().includes(search.trim().toLowerCase())) : [])

  async function load() {
    await resource.load(signal => api.get<StorageOverview>('/storage', { signal }))
  }
  onMount(() => { void load(); return () => resource.cancel() })


  const size = (bytes: number) => formatBytes(bytes, intlLocale())
  const total = $derived(data?.enabled ? data.buckets.reduce((sum, b) => sum + b.bytes, 0) : 0)

  function edit(bucket: Bucket | null) {
    editing = bucket
    dialogOpen = true
  }

  async function remove() {
    if (!removing) return
    const id = removing.id
    try {
      await api.delete(`/storage/buckets/${enc(id)}`)
      toast.success(t('storage.bucketDeleted', { bucket: id }))
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
  }
</script>

{#snippet bucketActions(bucket: Bucket)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button variant="ghost" size="icon-sm" aria-label={t('common.actionsFor', { name: bucket.id })} {...props}><Ellipsis aria-hidden="true" /></Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-48">
      <DropdownMenu.Item onclick={() => edit(bucket)}><Pencil aria-hidden="true" />{t('storage.edit')}</DropdownMenu.Item>
      <DropdownMenu.Item>
        {#snippet child({ props })}<a {...props} href={href(`/storage/${enc(bucket.id)}`)}><ShieldCheck aria-hidden="true" />{t('storage.accessRules')}</a>{/snippet}
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item variant="destructive" disabled={bucket.files > 0} onclick={() => { removing = bucket; confirmOpen = true }}><Trash2 aria-hidden="true" />{t('storage.deleteBucket')}</DropdownMenu.Item>
      {#if bucket.files > 0}<p class="px-2 py-2 text-xs text-muted-foreground">{t('storage.emptyBeforeDelete')}</p>{/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet accessBadge(bucket: Bucket)}
  <Badge variant={bucket.public ? 'outline' : 'secondary'}>{#if (bucket.public)}<Globe aria-hidden="true" />{/if}{#if !(bucket.public)}<Lock aria-hidden="true" />{/if}{bucket.public ? t('storage.public') : t('storage.private')}</Badge>
{/snippet}

<div class="mx-auto w-full max-w-page px-4 pt-2 pb-12 sm:px-6 lg:px-8">
  <PageHeader
    title={t('storage.title')}
    description={data?.enabled
      ? `${t(data.backend === 's3' ? 'storage.s3Summary' : 'storage.diskSummary', {
          count: data.buckets.length,
          size: size(total),
        })}${data.buckets.length ? ` ${t('storage.bucketHint')}` : ''}`
      : undefined}
  >
    {#snippet actions()}
      {#if data?.enabled}
        <Button onclick={() => edit(null)}><Plus data-icon="inline-start" aria-hidden="true" />{t('storage.newBucket')}</Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if error}<LoadError message={error} onretry={load} busy={loading} />{/if}
  {#if (data === null)}
    {#if loading}<Skeleton class="h-48 rounded-3xl" />{/if}
  {/if}
  {#if !(data === null) && (!data.enabled)}
    <EmptyState icon={HardDrive} class="rounded-3xl bg-card" title={t('storage.disabled')} description={t('storage.disabledDescription')} />
  {/if}
  {#if !(data === null) && !(!data.enabled)}
    {#if (data.buckets.length === 0)}
      <EmptyState icon={HardDrive} class="rounded-3xl bg-card" title={t('storage.empty')} description={t('storage.emptyDescription')}>
        {#snippet actions()}
          <Button variant="outline" onclick={() => edit(null)}><Plus data-icon="inline-start" aria-hidden="true" />{t('storage.newBucket')}</Button>
        {/snippet}
      </EmptyState>
    {/if}
    {#if !(data.buckets.length === 0)}
      <!-- List toolbar: search on the left, filters beside it; the header keeps only buttons. -->
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <div class="w-full sm:w-72"><SearchField bind:value={search} label={t('storage.search')} /></div>
      </div>
      {#if (!visible.length)}
        <EmptyState icon={Search} class="rounded-3xl bg-card" title={t('common.noMatches')}>
          {#snippet actions()}<Button variant="outline" onclick={() => (search = '')}>{t('common.clearSearch')}</Button>{/snippet}
        </EmptyState>
      {/if}
      {#if !(!visible.length)}
      <div class="grid gap-3 md:hidden">
        {#each visible as bucket (bucket.id)}
          <article class="min-w-0 rounded-3xl bg-card p-4">
            <div class="flex min-w-0 items-start justify-between gap-2">
              <div class="min-w-0"><a class="flex items-center gap-2 font-mono font-medium hover:underline" href={href(`/storage/${enc(bucket.id)}`)}><HardDrive class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span class="truncate">{bucket.id}</span></a><div class="mt-2">{@render accessBadge(bucket)}</div></div>
              {@render bucketActions(bucket)}
            </div>
            <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt class="text-muted-foreground">{t('storage.columns.files')}</dt><dd class="text-right tabular-nums">{bucket.files}</dd>
              <dt class="text-muted-foreground">{t('storage.columns.size')}</dt><dd class="text-right tabular-nums">{size(bucket.bytes)}</dd>
              <dt class="text-muted-foreground">{t('storage.columns.limit')}</dt><dd class="text-right">{bucket.file_size_limit ? size(bucket.file_size_limit) : t('storage.serverLimit', { size: size(data.max_file_size) })}</dd>
              <dt class="text-muted-foreground">{t('storage.columns.types')}</dt><dd class="break-words text-right">{bucket.allowed_mime_types?.join(', ') ?? t('storage.anyType')}</dd>
            </dl>
          </article>
        {/each}
      </div>
      <div class="hidden overflow-hidden rounded-3xl bg-card md:block">
        <Table.Root>
          <Table.Header>
            <Table.Row class="hover:bg-transparent">
              <Table.Head>{t('storage.columns.name')}</Table.Head>
              <Table.Head>{t('storage.columns.access')}</Table.Head>
              <Table.Head class="text-right">{t('storage.columns.files')}</Table.Head>
              <Table.Head class="text-right">{t('storage.columns.size')}</Table.Head>
              <Table.Head class="hidden md:table-cell">{t('storage.columns.limit')}</Table.Head>
              <Table.Head class="hidden md:table-cell">{t('storage.columns.types')}</Table.Head>
              <Table.Head class="w-12"><span class="sr-only">{t('common.actions')}</span></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each visible as bucket (bucket.id)}
              <Table.Row>
                <Table.Cell>
                  <a class="inline-flex items-center gap-2 font-mono font-medium hover:underline" href={href(`/storage/${enc(bucket.id)}`)}><HardDrive class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{bucket.id}</a>
                </Table.Cell>
                <Table.Cell class="text-muted-foreground">
                  {@render accessBadge(bucket)}
                </Table.Cell>
                <Table.Cell class="text-right tabular-nums">{bucket.files}</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{size(bucket.bytes)}</Table.Cell>
                <Table.Cell class="hidden text-muted-foreground tabular-nums md:table-cell">
                  {bucket.file_size_limit
                    ? size(bucket.file_size_limit)
                    : t('storage.serverLimit', { size: size(data.max_file_size) })}
                </Table.Cell>
                <Table.Cell class="hidden text-muted-foreground md:table-cell">
                  {#if (bucket.allowed_mime_types)}
                    <span class="font-mono text-xs">{bucket.allowed_mime_types.join(', ')}</span>
                  {/if}
                  {#if !(bucket.allowed_mime_types)}
                    {t('storage.anyType')}
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-right">
                  {@render bucketActions(bucket)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
      {/if}
    {/if}
    <!-- Standing notes about every bucket: who reaches the files, and where they live. -->
    <div class="mt-6 grid gap-4 md:grid-cols-2">
      {#if data.buckets.length}
        <aside class="flex items-start gap-3 rounded-3xl bg-card p-5" aria-labelledby="storage-access-note">
          <span class="grid size-10 shrink-0 place-items-center rounded-full bg-well text-muted-foreground"><ShieldCheck class="size-[18px]" aria-hidden="true" /></span>
          <div class="grid min-w-0 gap-1">
            <h2 id="storage-access-note" class="text-sm font-semibold">{t('storage.notes.access.title')}</h2>
            <p class="text-sm text-muted-foreground">{t('storage.notes.access.text')}</p>
            {#if (data.buckets.length === 1)}
              <Button variant="outline" size="sm" class="mt-2 w-fit" href={href(`/storage/${enc(data.buckets[0].id)}`)}><ShieldCheck data-icon="inline-start" aria-hidden="true" />{t('storage.notes.access.action', { bucket: data.buckets[0].id })}</Button>
            {/if}
            {#if !(data.buckets.length === 1)}
              <p class="text-sm text-muted-foreground">{t('storage.notes.access.openBucket')}</p>
            {/if}
          </div>
        </aside>
      {/if}
      {#if data.backend === 'disk'}
        <aside class="flex items-start gap-3 rounded-3xl bg-card p-5" aria-labelledby="storage-disk-note">
          <span class="grid size-10 shrink-0 place-items-center rounded-full bg-well text-muted-foreground"><HardDrive class="size-[18px]" aria-hidden="true" /></span>
          <div class="grid min-w-0 gap-1">
            <h2 id="storage-disk-note" class="text-sm font-semibold">{t('storage.notes.disk.title')}</h2>
            <p class="text-sm text-muted-foreground">{t('storage.notes.disk.text')}</p>
            <Button variant="outline" size="sm" class="mt-2 w-fit" href={href('/guides/storage?section=turning-it-on')}>{t('storage.notes.disk.action')}<ArrowRight data-icon="inline-end" aria-hidden="true" /></Button>
          </div>
        </aside>
      {/if}
    </div>
  {/if}
</div>

{#if data?.enabled}
  <BucketDialog bind:open={dialogOpen} bucket={editing} serverLimit={data.max_file_size} onsaved={load} />
{/if}
{#if removing}
  <ConfirmDialog
    bind:open={confirmOpen}
    title={t('storage.confirmDeleteBucket.title')}
    description={t('storage.confirmDeleteBucket.description', { bucket: removing.id })}
    confirmLabel={t('common.delete')}
    destructive
    onconfirm={remove}
  />
{/if}
