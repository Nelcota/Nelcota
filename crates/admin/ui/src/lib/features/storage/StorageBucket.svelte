<script lang="ts">
  import { dateText } from '$lib/formatting/date'
  import { untrack, onDestroy } from 'svelte'
  import * as Table from '$lib/components/ui/table'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Button } from '$lib/components/ui/button'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Folder from '@lucide/svelte/icons/folder'
  import Upload from '@lucide/svelte/icons/upload'
  import Download from '@lucide/svelte/icons/download'
  import Copy from '@lucide/svelte/icons/copy'
  import Link from '@lucide/svelte/icons/link'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import FileText from '@lucide/svelte/icons/file-text'
  import Image from '@lucide/svelte/icons/image'
  import FileIcon from '@lucide/svelte/icons/file'
  import Eye from '@lucide/svelte/icons/eye'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import X from '@lucide/svelte/icons/x'
  import Settings from '@lucide/svelte/icons/settings'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { toast } from 'svelte-sonner'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import BucketAccess from '$lib/features/storage/components/BucketAccess.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import FilePreviewDialog from '$lib/features/storage/components/FilePreviewDialog.svelte'
  import BucketDialog from '$lib/features/storage/components/BucketDialog.svelte'
  import { StorageBrowser } from '$lib/features/storage/browser.svelte'
  import { storageBrowserAdapter } from '$lib/features/storage/api'
  import { type UploadTarget } from '$lib/features/storage/upload-queue.svelte'
  import { copyText } from '$lib/browser/clipboard'
  import { enc } from '$lib/transport/api'
  import { href, route } from '$lib/navigation/router.svelte'
  import { baseName, folderTrail, formatBytes, publicUrl } from '$lib/features/storage/files'
  import type { StoredFile } from '$lib/contracts/types'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'

  let { bucket }: { bucket: string } = $props()

  const browser = new StorageBrowser(storageBrowserAdapter)
  const infoResource = browser.infoResource
  const filesResource = browser.filesResource
  const uploads = browser.uploads
  const info = $derived(infoResource.loaded && !infoResource.error ? infoResource.data : undefined)
  const files = $derived(filesResource.data?.objects ?? null)
  const folders = $derived(filesResource.data?.folders ?? [])
  const hasNext = $derived(filesResource.data?.has_next ?? false)
  onDestroy(() => browser.cancel())
  const uploading = $derived(uploads.progress)
  const queue = $derived(uploads.items)
  let conflicts = $state<File[]>([])
  let conflictTarget = $state<{ bucket: string; prefix: string } | null>(null)
  let replaceOpen = $state(false)
  $effect(() => {
    if (replaceOpen) return
    conflicts = []
    conflictTarget = null
  })
  let removing = $state<StoredFile | null>(null)
  let removeOpen = $state(false)
  let picker = $state<HTMLInputElement>()
  const loading = $derived(filesResource.loading)
  const error = $derived(filesResource.error ? errorMessage(filesResource.error) : '')
  const infoError = $derived(infoResource.error ? errorMessage(infoResource.error) : '')
  const infoLoading = $derived(infoResource.loading)
  let settingsOpen = $state(false)
  let preview = $state<StoredFile | null>(null)
  let previewOpen = $state(false)
  let dragging = $state(false)
  let dragDepth = 0
  const prefix = $derived(route.query.get('prefix') ?? '')
  const trail = $derived(folderTrail(prefix))
  const base = $derived(`/storage/buckets/${enc(bucket)}`)
  const folderHref = (p: string) => href(`/storage/${enc(bucket)}${p ? `?prefix=${enc(p)}` : ''}`)
  const fileHref = (name: string) => `/admin/api${base}/file?${new URLSearchParams({ name })}`
  const fileIcon = (file: StoredFile) => file.mime_type.startsWith('image/') ? Image : file.mime_type.startsWith('text/') || ['application/pdf', 'application/json'].includes(file.mime_type) ? FileText : FileIcon
  function showPreview(file: StoredFile) { preview = file; previewOpen = true }

  const loadInfo = async () => { await browser.loadInfo() }
  const load = async (more = false) => { await browser.load(more) }
  $effect(() => {
    const target = { bucket, prefix }
    untrack(() => {
      selected = new Set()
      void browser.open(target)
    })
  })

  // Ticked files (by name), for bulk deletion. Only names still listed count.
  let selected = $state<Set<string>>(new Set())
  let removeManyOpen = $state(false)
  // Count shown by the dialog, fixed when it opens (the selection clears on success).
  let removeManyCount = $state(0)
  const selectedNames = $derived(files?.filter((file) => selected.has(file.name)).map((file) => file.name) ?? [])
  const allSelected = $derived(!!files?.length && selectedNames.length === files.length)

  function toggleFile(name: string, on: boolean) {
    const next = new Set(selected)
    switch (on) {
      case true: next.add(name); break
      case false: next.delete(name); break
    }
    selected = next
  }

  async function removeSelected() {
    const names = selectedNames
    try {
      const count = await browser.removeMany(names)
      selected = new Set()
      toast.success(t('storage.browser.deletedMany', { count }))
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
  }

  async function send(list: File[], replace: boolean, target?: UploadTarget) {
    if (!info && !target) return
    const result = await browser.send(list, replace, target)
    if (!result) return
    for (const { file, error } of result.errors) toast.error(`${file.name}: ${errorMessage(error, 'storage.browser.uploadFailed')}`)
    if (result.sent) toast.success(t('storage.browser.uploaded', { count: result.sent }))
    if (result.conflicts.length) {
      conflicts = result.conflicts
      conflictTarget = result.target
      replaceOpen = true
    }
  }

  function picked() {
    if (!picker) return
    const list = [...(picker.files ?? [])]
    picker.value = ''
    if (list.length) send(list, false)
  }

  async function remove() {
    if (!removing) return
    const name = removing.name
    try {
      await browser.remove(name)
      toast.success(t('storage.browser.deleted', { name: baseName(name) }))
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
  }

  function dropped(event: DragEvent) {
    event.preventDefault()
    dragging = false
    dragDepth = 0
    if (event.dataTransfer?.files.length && !uploading && info) send([...event.dataTransfer.files], false)
  }

  const date = $derived(new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }))
  const size = (bytes: number) => formatBytes(bytes, intlLocale())
  // A 16px box with a 40px pointer target around it.
  const HIT_AREA = 'after:-inset-3'
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="mx-auto w-full max-w-page px-4 pt-2 pb-12 sm:px-6 lg:px-8" ondragenter={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; dragging = true } }} ondragleave={() => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragging = false }} ondragover={(event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() }} ondrop={dropped}>
  <!-- From md the top bar already shows Storage > bucket, so only a folder path
       needs its own trail; phones hide that bar and keep the way back here. -->
  <nav class={['mb-4 flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]', prefix ? 'flex' : 'flex md:hidden']} aria-label={t('storage.browser.path')}>
    <a class="text-muted-foreground hover:text-foreground hover:underline md:hidden" href={href('/storage')}>{t('storage.title')}</a>
    <ChevronRight class="size-3.5 shrink-0 text-muted-foreground md:hidden" aria-hidden="true" />
    {#if (prefix)}<a class="font-mono text-muted-foreground hover:text-foreground hover:underline" href={folderHref('')}>{bucket}</a>{/if}
    {#if !(prefix)}<span class="font-mono" aria-current="page">{bucket}</span>{/if}
    {#each trail as folder, index (folder.prefix)}
      <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {#if (index === trail.length - 1)}<span class="font-mono" aria-current="page">{folder.name}</span>
      {/if}
      {#if !(index === trail.length - 1)}<a class="font-mono text-muted-foreground hover:text-foreground hover:underline" href={folderHref(folder.prefix)}>{folder.name}</a>{/if}
    {/each}
  </nav>
  <PageHeader
    title={bucket}
    description={info ? [info.bucket.public ? t('storage.public') : t('storage.private'), t('storage.browser.fileCount', { count: info.bucket.files }), size(info.bucket.bytes)].join(' · ') : undefined}
  >
    {#snippet actions()}
      {#if info}
        <input bind:this={picker} type="file" multiple accept={info.bucket.allowed_mime_types?.join(',')} class="hidden" onchange={picked} />
        <Button disabled={uploading !== null} onclick={() => picker?.click()}>
          {#if (uploading)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
          {#if !(uploading)}<Upload data-icon="inline-start" aria-hidden="true" />{/if}
          {uploading ? t('storage.browser.uploading', uploading) : t('storage.browser.upload')}
        </Button>
        <!-- From xl the access panel sits beside the files: the jump link is only for narrower screens. -->
        <Button variant="outline" class="xl:hidden" href="#bucket-access" aria-label={t('storage.browser.access')}><ShieldCheck data-icon="inline-start" aria-hidden="true" /><span class="sm:hidden">{t('storage.browser.accessShort')}</span><span class="hidden sm:inline">{t('storage.browser.access')}</span></Button>
        <Button variant="outline" size="icon" aria-label={t('storage.browser.settings')} title={t('storage.browser.settings')} onclick={() => (settingsOpen = true)}><Settings aria-hidden="true" /></Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if infoError}<LoadError message={infoError} onretry={loadInfo} busy={infoLoading} />{/if}
  {#if error}<LoadError message={error} onretry={() => load()} busy={loading} />{/if}
  <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
  <section class="min-w-0" aria-label={t('storage.browser.files')}>
  {#if info}
    <button type="button" disabled={uploading !== null} class={['mb-4 flex w-full cursor-pointer flex-col items-center gap-2 rounded-3xl border-2 border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-brand/50 hover:text-foreground disabled:cursor-wait', dragging && 'border-brand bg-brand/5 text-brand']} aria-label={t('storage.browser.dropHint')} aria-describedby="drop-limits" onclick={() => picker?.click()}>
      <Upload class="size-5" aria-hidden="true" />
      <span class="font-medium"><span class="hidden sm:inline">{t('storage.browser.dropHint')}</span><span class="sm:hidden">{t('storage.browser.tapHint')}</span></span>
      <span id="drop-limits" class="text-xs text-muted-foreground">{t('storage.browser.dropLimits', { size: size(info.bucket.file_size_limit ?? info.serverLimit), types: info.bucket.allowed_mime_types?.join(', ') ?? t('storage.anyType').toLowerCase() })}</span>
    </button>
  {/if}
  {#if queue.length}
    <section class="mb-4 grid gap-3 rounded-3xl bg-card p-4" aria-label={t('storage.browser.uploadProgress')}>
      <div class="flex items-center justify-between"><h2 class="text-sm font-medium">{t('storage.browser.uploadProgress')}</h2>{#if !uploading}<Button variant="ghost" size="sm" onclick={() => uploads.clear()}>{t('common.close')}</Button>{/if}</div>
      {#each queue as item, index (index)}
        <div class="grid gap-1"><div class="flex min-w-0 items-center gap-2 text-xs">{#if (item.status === 'done')}<CircleCheck class="size-4 shrink-0 text-brand" aria-hidden="true" />{/if}{#if !(item.status === 'done') && (item.status === 'error' || item.status === 'conflict')}<CircleAlert class="size-4 shrink-0 text-warning" aria-hidden="true" />{/if}{#if !(item.status === 'done') && !(item.status === 'error' || item.status === 'conflict')}<Upload class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}<span class="min-w-0 flex-1 truncate">{item.name}</span><span class="shrink-0 text-muted-foreground" aria-live="polite">{t(`storage.browser.uploadStatus.${item.status}`)}</span></div>{#if item.status === 'sending' || item.status === 'queued'}<progress class="h-1.5 w-full accent-brand" value={item.loaded} max={item.total || 1} aria-label={item.name}></progress>{/if}</div>
      {/each}
    </section>
  {/if}

  {#if (info === null)}
    <EmptyState class="rounded-3xl bg-card" title={t('storage.browser.notFound', { bucket })}>
      {#snippet actions()}
        <Button variant="outline" href={href('/storage')}>{t('storage.browser.back')}</Button>
      {/snippet}
    </EmptyState>
  {/if}
  {#if !(info === null)}
    {#if (files === null)}
      {#if loading}<Skeleton class="h-48 rounded-3xl" />{/if}
    {/if}
    {#if !(files === null) && (files.length === 0 && folders.length === 0)}
      <EmptyState
        class="rounded-3xl bg-card"
        icon={Folder}
        title={prefix ? t('storage.browser.emptyFolder') : t('storage.browser.emptyBucket')}
        description={prefix ? t('storage.browser.emptyFolderDescription') : t('storage.browser.foldersHint')}
      >{#snippet actions()}<Button variant="outline" disabled={!info || uploading !== null} onclick={() => picker?.click()}><Upload data-icon="inline-start" aria-hidden="true" />{t('storage.browser.upload')}</Button>{/snippet}</EmptyState>
    {/if}
    {#if !(files === null) && !(files.length === 0 && folders.length === 0)}
      <div class="overflow-hidden rounded-3xl bg-card">
        {#if selectedNames.length}
          <div class="flex min-h-12 items-center gap-2 border-b border-brand/20 bg-brand/5 px-4 py-2 text-sm" role="region" aria-label={t('storage.browser.selection.selected', { count: selectedNames.length })}>
            <span class="min-w-0 flex-1 truncate font-medium text-foreground" aria-live="polite">{t('storage.browser.selection.selected', { count: selectedNames.length })}</span>
            <div class="flex shrink-0 items-center gap-2">
              <Button variant="destructive" size="sm" aria-label={t('storage.browser.selection.delete')} onclick={() => { removeManyCount = selectedNames.length; removeManyOpen = true }}><Trash2 aria-hidden="true" /><span class="sm:hidden">{t('storage.browser.delete')}</span><span class="hidden sm:inline">{t('storage.browser.selection.delete')}</span></Button>
              <Button variant="ghost" size="icon-sm" aria-label={t('storage.browser.selection.clear')} title={t('storage.browser.selection.clear')} onclick={() => (selected = new Set())}><X /></Button>
            </div>
          </div>
        {/if}
        <Table.Root class="table-fixed md:table-auto">
          <Table.Header>
            <Table.Row class="hover:bg-transparent">
              <Table.Head class="w-12">
                <Checkbox
                  class={HIT_AREA}
                  checked={allSelected}
                  indeterminate={selectedNames.length > 0 && !allSelected}
                  disabled={!files.length}
                  onCheckedChange={(v) => (selected = v === true ? new Set(files?.map((file) => file.name)) : new Set())}
                  aria-label={t('storage.browser.selection.selectAll')}
                />
              </Table.Head>
              <Table.Head>{t('storage.browser.columns.name')}</Table.Head>
              <Table.Head class="hidden w-24 text-right sm:table-cell 2xl:w-auto">{t('storage.browser.columns.size')}</Table.Head>
              <Table.Head class="hidden 2xl:table-cell">{t('storage.browser.columns.type')}</Table.Head>
              <Table.Head class="hidden w-36 md:table-cell 2xl:w-auto">{t('storage.browser.columns.updated')}</Table.Head>
              <Table.Head class="w-12 2xl:w-24"><span class="sr-only">{t('common.actions')}</span></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each folders as folder (folder)}
              <Table.Row>
                <Table.Cell></Table.Cell>
                <Table.Cell class="max-w-0">
                  <a class="flex min-w-0 items-center gap-2 font-medium hover:underline" href={folderHref(`${prefix}${folder}/`)}>
                    <Folder class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span class="truncate">{folder}/</span>
                  </a>
                </Table.Cell>
                <Table.Cell class="hidden sm:table-cell"></Table.Cell><Table.Cell class="hidden 2xl:table-cell"></Table.Cell><Table.Cell class="hidden md:table-cell"></Table.Cell><Table.Cell></Table.Cell>
              </Table.Row>
            {/each}
            {#each files as file (file.id)}
              {@const Icon = fileIcon(file)}
              <Table.Row data-state={selected.has(file.name) ? 'selected' : undefined}>
                <Table.Cell>
                  <Checkbox class={HIT_AREA} checked={selected.has(file.name)} onCheckedChange={(v) => toggleFile(file.name, v === true)} aria-label={t('storage.browser.selection.selectFile', { name: baseName(file.name) })} />
                </Table.Cell>
                <Table.Cell class="max-w-0 font-medium"><button type="button" class="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left hover:text-brand" onclick={() => showPreview(file)} title={file.name}><Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span class="grid min-w-0"><span class="truncate">{baseName(file.name)}</span><span class="text-xs font-normal tabular-nums text-muted-foreground sm:hidden">{size(file.size)}</span></span></button></Table.Cell>
                <Table.Cell class="hidden text-right tabular-nums text-muted-foreground sm:table-cell">{size(file.size)}</Table.Cell>
                <Table.Cell class="hidden font-mono text-xs text-muted-foreground 2xl:table-cell">{file.mime_type}</Table.Cell>
                <Table.Cell class="hidden text-muted-foreground tabular-nums md:table-cell">{dateText(file.updated_at, date.format)}</Table.Cell>
                <Table.Cell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                  <!-- The menu downloads too: the shortcut only shows when the type column fits. -->
                  <Button variant="ghost" size="icon-sm" class="hidden 2xl:inline-flex" href={fileHref(file.name)} download title={t('storage.browser.downloadFile', { name: baseName(file.name) })} aria-label={t('storage.browser.downloadFile', { name: baseName(file.name) })}><Download aria-hidden="true" /></Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      {#snippet child({ props })}
                        <Button variant="ghost" size="icon-sm" aria-label={t('common.actionsFor', { name: baseName(file.name) })} {...props}><Ellipsis aria-hidden="true" /></Button>
                      {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end" class="w-52">
                      <DropdownMenu.Group>
                      <DropdownMenu.Item onclick={() => showPreview(file)}><Eye aria-hidden="true" />{t('storage.browser.preview')}</DropdownMenu.Item>
                      <DropdownMenu.Item>
                        {#snippet child({ props })}
                          <a {...props} href={`/admin/api${base}/file?${new URLSearchParams({ name: file.name })}`} download
                            ><Download aria-hidden="true" />{t('storage.browser.download')}</a
                          >
                        {/snippet}
                      </DropdownMenu.Item>
                      {#if info?.bucket.public}
                        <DropdownMenu.Item
                          onclick={() => copyText(publicUrl(info!.publicOrigin, bucket, file.name), t('storage.browser.urlCopied'))}
                          ><Link aria-hidden="true" />{t('storage.browser.copyUrl')}</DropdownMenu.Item
                        >
                      {/if}
                      <DropdownMenu.Item onclick={() => copyText(file.name, t('storage.browser.pathCopied'))}>
                        <Copy aria-hidden="true" />
                        {t('storage.browser.copyPath')}
                      </DropdownMenu.Item>
                      </DropdownMenu.Group>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Group>
                      <DropdownMenu.Item
                        variant="destructive"
                        onclick={() => {
                          removing = file
                          removeOpen = true
                        }}><Trash2 aria-hidden="true" />{t('storage.browser.delete')}</DropdownMenu.Item
                      >
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
      <!-- Folders have no actions of their own: say where they come from. -->
      <p class="mt-3 px-1 text-xs text-muted-foreground">{t('storage.browser.foldersHint')}</p>
      {#if hasNext}
        <div class="mt-4 flex justify-center">
          <Button variant="outline" size="sm" disabled={loading} onclick={() => load(true)}>{t('storage.browser.more')}</Button>
        </div>
      {/if}
    {/if}
  {/if}
  </section>
  {#if info}<aside class="min-w-0 xl:sticky xl:top-4"><BucketAccess {bucket} /></aside>{/if}
  </div>
</div>

{#if info}<BucketDialog bind:open={settingsOpen} bucket={info.bucket} serverLimit={info.serverLimit} onsaved={loadInfo} />{/if}
{#if preview}<FilePreviewDialog bind:open={previewOpen} file={preview} url={fileHref(preview.name)} />{/if}

<ConfirmDialog
  bind:open={removeManyOpen}
  title={t('storage.browser.confirmDeleteMany.title', { count: removeManyCount })}
  description={t('storage.browser.confirmDeleteMany.description')}
  confirmLabel={t('common.delete')}
  destructive
  onconfirm={removeSelected}
/>
{#if removing}
  <ConfirmDialog
    bind:open={removeOpen}
    title={t('storage.browser.confirmDelete.title')}
    description={t('storage.browser.confirmDelete.description', { name: baseName(removing.name) })}
    confirmLabel={t('common.delete')}
    destructive
    onconfirm={remove}
  />
{/if}
<ConfirmDialog
  bind:open={replaceOpen}
  title={t('storage.browser.replace.title')}
  description={t('storage.browser.replace.description', {
    count: conflicts.length,
    names: conflicts.map((f) => f.name).join(', '),
    destination: `${conflictTarget?.bucket ?? bucket}/${conflictTarget?.prefix ?? prefix}`,
  })}
  confirmLabel={t('storage.browser.replace.confirm')}
  onconfirm={() => send(conflicts, true, conflictTarget ?? undefined)}
/>
