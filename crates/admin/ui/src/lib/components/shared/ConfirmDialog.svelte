<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { buttonVariants } from '$lib/components/ui/button'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { t } from '$lib/i18n/index.svelte'

  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel,
    destructive = false,
    onconfirm,
  }: {
    open?: boolean
    title: string
    description?: string
    confirmLabel?: string
    destructive?: boolean
    onconfirm: () => void | Promise<void>
  } = $props()

  let busy = $state(false)

  async function confirm() {
    if (busy) return
    busy = true
    try {
      await onconfirm()
      open = false
    } catch {
      // The caller already showed the error; the dialog stays open to try again.
    } finally {
      busy = false
    }
  }
</script>

<AlertDialog.Root bind:open={() => open, (next) => {
  if (busy) return
  open = next
}}>
  <AlertDialog.Content aria-busy={busy}>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      {#if description}
        <AlertDialog.Description>{description}</AlertDialog.Description>
      {/if}
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
      <AlertDialog.Action
        class={destructive ? buttonVariants({ variant: 'destructive' }) : ''}
        disabled={busy}
        onclick={confirm}
      >
        {#if busy}<LoaderCircle class="size-4 animate-spin" aria-hidden="true" /><span>{t('common.working')}</span>{/if}
        {#if !busy}{confirmLabel ?? t('common.confirm')}{/if}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
