<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import Avatar from './Avatar.svelte'
  import { api } from '$lib/transport/api'
  import { prepareAvatar } from '$lib/features/profile/avatar'
  import { profile } from '$lib/features/profile/profile.svelte'
  import { querySession } from '$lib/resources/query-client'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  let { open = $bindable(false) }: { open?: boolean } = $props()

  let input = $state<HTMLInputElement>()
  // Picked photo, not saved yet.
  let picked = $state<{ dataUrl: string; base64: string } | null>(null)
  let reading = $state(false)
  let saving = $state(false)
  let dragging = $state(false)
  let opening = 0
  let read = 0

  // Closing, reopening or changing sessions retires all previous photo reads.
  $effect(() => {
    void [open, querySession()]
    opening++; read++
    picked = null
    reading = false
    dragging = false
    return () => { opening++; read++ }
  })

  async function use(file: File | undefined) {
    if (!open || reading || saving || !file) return
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.notAnImage'))
      return
    }
    const request = ++read, started = querySession()
    const current = () => request === read && open && started === querySession()
    reading = true
    try {
      const photo = await prepareAvatar(file)
      if (current()) picked = photo
    } catch {
      if (current()) toast.error(t('profile.unreadable'))
    } finally {
      if (current()) {
        reading = false
        if (input) input.value = ''
      }
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    use(event.dataTransfer?.files[0])
  }

  async function save() {
    if (!open || reading || saving || !picked) return
    const dialog = opening, started = querySession(), image = picked.base64
    saving = true
    try {
      const result = await api.put<{ avatar: number }>('/profile/avatar', { image })
      if (started !== querySession()) return
      profile.avatar = result.avatar
      toast.success(t('profile.saved'))
      if (opening === dialog) open = false
    } catch (e) {
      if (started === querySession()) toast.error(errorMessage(e))
    } finally {
      saving = false
    }
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
    } catch (e) {
      if (started === querySession()) toast.error(errorMessage(e))
    } finally {
      saving = false
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>{t('profile.title')}</Dialog.Title>
      <Dialog.Description>{t('profile.description')}</Dialog.Description>
    </Dialog.Header>

    <!-- Click, or drop an image on the area. -->
    <button
      type="button"
      onclick={() => input?.click()}
      ondragover={(e) => {
        e.preventDefault()
        dragging = true
      }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
      disabled={reading || saving}
      class={[
        'grid cursor-pointer justify-items-center gap-3 rounded-lg border border-dashed px-4 py-6 transition-colors hover:border-ring',
        dragging && 'border-brand bg-brand/5',
      ]}
    >
      <Avatar src={picked?.dataUrl ?? null} class="size-28 text-4xl" />
      <span class="text-sm text-muted-foreground">
        {reading ? t('profile.reading') : t('profile.pick')}
      </span>
    </button>
    <input
      bind:this={input}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      class="hidden"
      onchange={(e) => use(e.currentTarget.files?.[0])}
    />

    <Dialog.Footer class="sm:justify-between">
      {#if (profile.avatar !== null && !picked)}
          <Button variant="ghost" class="text-destructive hover:text-destructive" disabled={reading || saving} onclick={remove}>
          {t('profile.remove')}
        </Button>
      {/if}
      {#if !(profile.avatar !== null && !picked)}
        <span class="hidden sm:block"></span>
      {/if}
      <div class="flex flex-col-reverse gap-2 sm:flex-row">
        <Button variant="outline" onclick={() => (open = false)}>{t('common.cancel')}</Button>
        <Button disabled={!picked || reading || saving} onclick={save}>{saving ? t('common.saving') : t('common.save')}</Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
