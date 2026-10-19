<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import { href } from '$lib/navigation/router.svelte'
  import { t } from '$lib/i18n/index.svelte'
  import type { WebhookSecret } from '$lib/contracts/types'
  let { value = $bindable(null) }: { value?: WebhookSecret | null } = $props()
</script>
<Dialog.Root bind:open={() => value !== null, open => { if (!open) value = null }}>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header><Dialog.Title>{t('webhooks.secretTitle')}</Dialog.Title><Dialog.Description>{t('webhooks.secretHint')}</Dialog.Description></Dialog.Header>
    {#if value}<CodeBlock code={value.secret} wrap />{/if}
    <p class="text-sm text-muted-foreground">{t('webhooks.secretHelp')}</p>
    <a class="text-sm text-primary underline" href={href('/guides/webhooks')}>{t('webhooks.guide')}</a>
    <Dialog.Footer><Button onclick={() => value = null}>{t('common.close')}</Button></Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
