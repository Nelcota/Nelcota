<script lang="ts">
  import { tick } from 'svelte'
  import Copy from '@lucide/svelte/icons/copy'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { copyText } from '$lib/browser/clipboard'
  import { beforeNavigate, href } from '$lib/navigation/router.svelte'
  import { t } from '$lib/i18n/index.svelte'
  import type { WebhookSecret } from '$lib/contracts/types'
  let { value = $bindable(null) }: { value?: WebhookSecret | null } = $props()
  // The key is shown once: only an explicit button closes the dialog, and
  // closing before any copy asks once more.
  let copied = $state(false), warned = $state(false)
  // Each state renders its own footer, so the focused button disappears on a
  // switch: move focus to the safe next step instead of losing it to the page.
  let warnCopyButton = $state<HTMLElement | null>(null), doneButton = $state<HTMLElement | null>(null)
  async function settle(next: () => HTMLElement | null) { await tick(); next()?.focus() }
  // Leaving the page unmounts the dialog and drops the key: a link, the sidebar
  // or Back gets the same one-time warning as the close button.
  let leave: (() => void) | null = null
  $effect(() => {
    if (value) { copied = false; warned = false; leave = null }
  })
  $effect(() => {
    if (!value) return
    return beforeNavigate({
      blocked: () => value !== null && !copied,
      request: proceed => { leave = proceed; if (!warned) { warned = true; void settle(() => warnCopyButton) } },
    })
  })
  async function copy() {
    if (!value) return
    if (await copyText(value.secret)) copiedKey()
  }
  // Copying answers the warning; a navigation it interrupted stays cancelled.
  function copiedKey() {
    copied = true
    leave = null
    if (warned) { warned = false; void settle(() => doneButton) }
  }
  function close() {
    if (!copied && !warned) { warned = true; void settle(() => warnCopyButton); return }
    const proceed = leave
    leave = null
    value = null
    proceed?.()
  }
</script>
<Dialog.Root open={value !== null}>
  <Dialog.Content class="sm:max-w-xl" showCloseButton={false} escapeKeydownBehavior="ignore" interactOutsideBehavior="ignore">
    <Dialog.Header><Dialog.Title>{t('webhooks.secretTitle')}</Dialog.Title><Dialog.Description>{t('webhooks.secretHint')}</Dialog.Description></Dialog.Header>
    {#if value}<pre class="rounded-xl bg-well px-4 py-3.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap sm:text-[0.8125rem]" oncopy={copiedKey}>{value.secret}</pre>{/if}
    <p class="text-sm text-muted-foreground">{t('webhooks.secretHelp')}</p>
    <!-- A new tab, so reading the guide does not leave the key behind. -->
    <a class="text-sm text-brand underline" href={href('/guides/webhooks')} target="_blank" rel="noopener">{t('webhooks.guide')}<span class="sr-only"> {t('common.newTab')}</span></a>
    {#if warned}<p role="alert" class="text-sm text-warning">{t('webhooks.secretNotCopied')}</p>{/if}
    {#if !warned}
      <Dialog.Footer><Button variant="outline" onclick={copy}><Copy data-icon="inline-start" aria-hidden="true" />{t('webhooks.copySecret')}</Button><Button bind:ref={doneButton} onclick={close}>{t('webhooks.secretCopied')}</Button></Dialog.Footer>
    {/if}
    {#if warned}
      <!-- The copy action takes the primary slot so a double click cannot discard the key. -->
      <Dialog.Footer><Button variant="outline" onclick={close}>{t('webhooks.closeWithoutCopy')}</Button><Button bind:ref={warnCopyButton} onclick={copy}><Copy data-icon="inline-start" aria-hidden="true" />{t('webhooks.copySecret')}</Button></Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
