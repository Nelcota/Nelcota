<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { copyText } from '$lib/browser/clipboard'
  import { href } from '$lib/navigation/router.svelte'
  import { t } from '$lib/i18n/index.svelte'
  import type { WebhookSecret } from '$lib/contracts/types'
  let { value = $bindable(null) }: { value?: WebhookSecret | null } = $props()
  // The key is shown once: only an explicit button closes the dialog, and
  // closing before any copy asks once more.
  let copied = $state(false), warned = $state(false)
  $effect(() => {
    if (value) { copied = false; warned = false }
  })
  async function copy() {
    if (!value) return
    if (!(await copyText(value.secret))) return
    copied = true; warned = false
  }
  function close() {
    if (!copied && !warned) { warned = true; return }
    value = null
  }
</script>
<Dialog.Root open={value !== null}>
  <Dialog.Content class="sm:max-w-xl" showCloseButton={false} escapeKeydownBehavior="ignore" interactOutsideBehavior="ignore">
    <Dialog.Header><Dialog.Title>{t('webhooks.secretTitle')}</Dialog.Title><Dialog.Description>{t('webhooks.secretHint')}</Dialog.Description></Dialog.Header>
    {#if value}<pre class="rounded-xl bg-well px-4 py-3.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap sm:text-[0.8125rem]" oncopy={() => { copied = true; warned = false }}>{value.secret}</pre>{/if}
    <p class="text-sm text-muted-foreground">{t('webhooks.secretHelp')}</p>
    <a class="text-sm text-brand underline" href={href('/guides/webhooks')}>{t('webhooks.guide')}</a>
    {#if warned}<p role="alert" class="text-sm text-warning">{t('webhooks.secretNotCopied')}</p>{/if}
    {#if !warned}
      <Dialog.Footer><Button variant="outline" onclick={copy}><Copy data-icon="inline-start" aria-hidden="true" />{t('webhooks.copySecret')}</Button><Button onclick={close}>{t('webhooks.secretCopied')}</Button></Dialog.Footer>
    {/if}
    {#if warned}
      <!-- The copy action takes the primary slot so a double click cannot discard the key. -->
      <Dialog.Footer><Button variant="outline" onclick={close}>{t('webhooks.closeWithoutCopy')}</Button><Button onclick={copy}><Copy data-icon="inline-start" aria-hidden="true" />{t('webhooks.copySecret')}</Button></Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
