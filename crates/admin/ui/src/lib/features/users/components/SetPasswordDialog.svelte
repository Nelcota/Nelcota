<script lang="ts">
  import { CloseGuard } from '$lib/forms/close-guard.svelte'
  import UnsavedChangesDialog from '$lib/components/shared/UnsavedChangesDialog.svelte'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import { toast } from 'svelte-sonner'
  import PasswordField from '$lib/components/shared/PasswordField.svelte'
  import { api, enc } from '$lib/transport/api'
  import { passwordProblem } from '$lib/forms/password'
  import type { User } from '$lib/contracts/types'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  let { open = $bindable(false), user, onsaved }: { open?: boolean; user: User; onsaved: () => void } = $props()

  let password = $state('')
  let saving = $state(false)
  // Shown in the dialog, next to the field it is about, like the create dialog.
  let failure = $state('')
  const guard = new CloseGuard(() => password !== '', () => saving, () => (open = false))

  $effect(() => {
    if (open) {
      password = ''
      failure = ''
    }
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (saving || passwordProblem(password)) return
    saving = true
    failure = ''
    try {
      await api.put(`/users/${enc(user.id)}/password`, { password })
      toast.success(t('users.setPassword.saved', { email: user.email }))
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
          <Dialog.Title>{t('users.setPassword.title')}</Dialog.Title>
          <Dialog.Description>
            {t('users.setPassword.descriptionBefore')} <span class="font-medium text-foreground">{user.email}</span>.
            {t('users.setPassword.descriptionAfter')}
          </Dialog.Description>
        </Dialog.Header>
        <div class="grid gap-2">
          <Label for="reset-password">{t('users.setPassword.newPassword')}</Label>
          <PasswordField id="reset-password" bind:value={password} />
        </div>
        {#if failure}<p class="text-sm text-destructive" role="alert">{failure}</p>{/if}
        <Dialog.Footer>
          <Button variant="outline" disabled={saving} onclick={guard.request}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={saving || !!passwordProblem(password)}>
            {#if (saving)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
            {#if !(saving)}<KeyRound data-icon="inline-start" aria-hidden="true" />{/if}
            {saving ? t('common.saving') : t('users.setPassword.submit')}
          </Button>
        </Dialog.Footer>
        </fieldset>
    </form>
  </Dialog.Content>
</Dialog.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
