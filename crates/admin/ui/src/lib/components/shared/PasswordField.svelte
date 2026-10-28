<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Copy from '@lucide/svelte/icons/copy'
  import { copyText } from '$lib/browser/clipboard'
  import { generatePassword, passwordProblem } from '$lib/forms/password'
  import { t } from '$lib/i18n/index.svelte'

  let { value = $bindable(''), id }: { value?: string; id: string } = $props()

  let visible = $state(false)
  const problem = $derived(value ? passwordProblem(value) : null)

  function generate() {
    value = generatePassword()
    // A generated password stays visible: the admin has to copy it to hand it over.
    visible = true
  }

  async function copy() {
    await copyText(value, t('users.password.copied'))
  }
</script>

<div class="grid gap-1.5">
  <div class="flex flex-wrap gap-2">
    <div class="relative min-w-0 basis-full sm:flex-1 sm:basis-auto">
      <Input
        {id}
        type={visible ? 'text' : 'password'}
        bind:value
        autocomplete="new-password"
        class="h-10 pr-10 font-mono"
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-hint`}
      />
      <button
        type="button"
        class="absolute top-1/2 right-0 grid size-10 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={t('users.password.show')}
        aria-pressed={visible}
        onclick={() => (visible = !visible)}
      >
        {#if (visible)}<EyeOff class="size-4" />{/if}
        {#if !(visible)}<Eye class="size-4" />{/if}
      </button>
    </div>
    <Button variant="outline" class="h-10" onclick={generate}>{t('users.password.generate')}</Button>
    <Button variant="outline" size="icon" class="size-10" aria-label={t('users.password.copy')} disabled={!value} onclick={copy}><Copy /></Button>
  </div>
  <p id={`${id}-hint`} class={['text-sm', problem ? 'text-destructive' : 'text-muted-foreground']}>
    {problem ? t(`users.password.${problem}`) : t('users.password.hint')}
  </p>
</div>
