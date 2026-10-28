<script lang="ts">
  import { untrack } from 'svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import ImagePlus from '@lucide/svelte/icons/image-plus'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import Avatar from './Avatar.svelte'
  import AvatarEditor from './AvatarEditor.svelte'
  import { api } from '$lib/transport/api'
  import { cropGeometry, DEFAULT_CROP, MAX_INPUT_BYTES, prepareSource, reopenSource, renderAvatar, type AvatarSource } from '../avatar'
  import type { AvatarCrop, AvatarEditor as EditorData } from '$lib/contracts/types'
  import { profile } from '$lib/features/profile/profile.svelte'
  import { querySession } from '$lib/resources/query-client'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let input = $state<HTMLInputElement>()
  let source = $state<AvatarSource | null>(null)
  let crop = $state<AvatarCrop>({ ...DEFAULT_CROP })
  let initialSource = $state<AvatarSource | null>(null)
  let initialCrop = $state<AvatarCrop>({ ...DEFAULT_CROP })
  const dirty = $derived(source !== null && (source !== initialSource || Object.keys(DEFAULT_CROP).some(key => crop[key as keyof AvatarCrop] !== initialCrop[key as keyof AvatarCrop])))
  let reading = $state(false)
  let saving = $state(false)
  let dragging = $state(false)
  let loadError = $state('')
  let opening = 0
  let read = 0

  $effect(() => {
    const visible = open, session = querySession()
    const controller = new AbortController()
    opening++; read++
    source = null
    initialSource = null
    crop = { ...DEFAULT_CROP }
    initialCrop = { ...DEFAULT_CROP }
    reading = false
    dragging = false
    loadError = ''
    if (visible) {
      const version = untrack(() => profile.avatar)
      if (version !== null) void loadSaved(version, controller.signal, session)
    }
    return () => { opening++; read++; controller.abort() }
  })

  async function loadSaved(version: number, signal?: AbortSignal, session = querySession()) {
    const request = ++read
    const current = () => request === read && open && session === querySession()
    reading = true
    loadError = ''
    try {
      const data = await api.get<EditorData>(`/profile/avatar/editor?v=${version}`, { signal })
      const image = await reopenSource(data.source)
      if (!current()) return
      const framing = cropGeometry(image.width, image.height, data.crop).crop
      source = initialSource = image
      crop = framing
      initialCrop = { ...framing }
    } catch (error) {
      if (current()) loadError = errorMessage(error)
    } finally { if (current()) reading = false }
  }

  async function use(file: File | undefined) {
    if (!open || reading || saving || !file) return
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)) {
      toast.error(t('profile.notAnImage'))
      return
    }
    if (file.size > MAX_INPUT_BYTES) { toast.error(t('profile.tooLarge', { max_mb: MAX_INPUT_BYTES / 1024 / 1024 })); return }
    const request = ++read, started = querySession()
    const current = () => request === read && open && started === querySession()
    reading = true
    try {
      const photo = await prepareSource(file)
      if (current()) { source = photo; crop = { ...DEFAULT_CROP }; loadError = '' }
    } catch (error) {
      if (current()) toast.error(t(error instanceof RangeError ? 'profile.tooManyPixels' : 'profile.unreadable'))
    } finally {
      if (current()) { reading = false; if (input) input.value = '' }
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    void use(event.dataTransfer?.files[0])
  }

  async function save() {
    if (!open || reading || saving || !source || !dirty) return
    const dialog = opening, started = querySession()
    saving = true
    try {
      const image = renderAvatar(source, crop).base64
      const result = await api.put<{ avatar: number }>('/profile/avatar', { image, source: source.base64, crop })
      if (started !== querySession()) return
      profile.avatar = result.avatar
      toast.success(t('profile.saved'))
      if (opening === dialog) open = false
    } catch (error) {
      if (started === querySession()) toast.error(errorMessage(error))
    } finally { saving = false }
  }

  async function remove() {
    if (!open || reading || saving) return
    const dialog = opening, started = querySession()
    saving = true
    try {
      await api.delete('/profile/avatar')
      if (started !== querySession()) return
      profile.avatar = null
      toast.success(t('profile.removed'))
      if (opening === dialog) open = false
    } catch (error) {
      if (started === querySession()) toast.error(errorMessage(error))
    } finally { saving = false }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="flex flex-col overflow-hidden p-0 max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:translate-0 max-sm:rounded-none sm:max-w-xl">
    <div class="px-6 pt-6">
    <Dialog.Header>
      <Dialog.Title>{t('profile.title')}</Dialog.Title>
      <Dialog.Description>{t('profile.description')}</Dialog.Description>
    </Dialog.Header>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-1">
    {#if loadError}<LoadError message={loadError} onretry={() => { if (profile.avatar !== null) return loadSaved(profile.avatar) }} busy={reading} />{/if}
    {#if reading}<p role="status" class="text-sm text-muted-foreground">{t('profile.reading')}</p>{/if}
    {#if source}
      <AvatarEditor {source} bind:crop disabled={reading || saving} />
      <Button variant="outline" disabled={reading || saving} onclick={() => input?.click()}><ImagePlus aria-hidden="true" />{t('profile.chooseAnother')}</Button>
    {/if}
    {#if !source}
      <button type="button" onclick={() => input?.click()} ondragover={event => { event.preventDefault(); dragging = true }} ondragleave={() => dragging = false} ondrop={onDrop} disabled={reading || saving}
        class={['grid min-h-52 cursor-pointer justify-items-center content-center gap-4 rounded-2xl border border-dashed p-6 transition-colors hover:border-ring', dragging && 'border-primary bg-primary/5']}>
        <Avatar class="size-24 text-3xl" />
        <span class="flex items-center gap-2 text-sm text-muted-foreground"><ImagePlus class="size-4" aria-hidden="true" />{t('profile.pick')}</span>
      </button>
    {/if}
    <input bind:this={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" class="hidden" onchange={event => use(event.currentTarget.files?.[0])} />
    <p class="text-xs leading-relaxed text-muted-foreground">{t('profile.retained')}</p>
    </div>

    <Dialog.Footer class="mx-0 mb-0 mt-0 shrink-0 sm:justify-between">
      {#if profile.avatar !== null}
        <Button variant="ghost" class="text-destructive hover:text-destructive" disabled={reading || saving} onclick={remove}>{t('profile.remove')}</Button>
      {/if}
      {#if profile.avatar === null}<span class="hidden sm:block"></span>{/if}
      <div class="flex flex-col-reverse gap-2 sm:flex-row">
        <Button variant="outline" onclick={() => open = false}>{t('common.cancel')}</Button>
        <Button disabled={!dirty || reading || saving} onclick={save}>{saving ? t('common.saving') : t('common.save')}</Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
