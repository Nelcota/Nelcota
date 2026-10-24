<script lang="ts">
  import type { Component } from 'svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import MailCheck from '@lucide/svelte/icons/mail-check'
  import RotateCcwKey from '@lucide/svelte/icons/rotate-ccw-key'
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import BrandMark from '$lib/features/sign-in/components/BrandMark.svelte'
  import { envSnippet, type OptionId, type SignInOption } from '$lib/features/sign-in/sign-in-options'
  import { t } from '$lib/i18n/index.svelte'

  // One way to sign in: what it does, whether it is on and the .env lines that
  // change that, folded away until asked for.
  let { option }: { option: SignInOption } = $props()
  let open = $state(false)

  const ICONS: Partial<Record<OptionId, Component>> = { password: KeyRound, confirmation: MailCheck, recovery: RotateCcwKey, magicLink: WandSparkles }
  const Icon = $derived(ICONS[option.id])
  const panel = `signin-${Math.random().toString(36).slice(2, 8)}`
</script>

<article class="flex flex-col gap-4 rounded-3xl bg-card p-5">
  <div class="flex items-center justify-between gap-3">
    <span class="grid size-10 place-items-center rounded-full bg-well text-muted-foreground">
      {#if (Icon)}<Icon class="size-[18px]" aria-hidden="true" />{/if}
      {#if !(Icon) && (option.id === 'google' || option.id === 'github')}<BrandMark brand={option.id} />{/if}
    </span>
    <span class={['flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', option.on ? 'bg-success/10 text-success' : 'bg-well text-muted-foreground']}>
      <span class={['size-1.5 rounded-full', option.on ? 'bg-success' : 'bg-muted-foreground/60']} aria-hidden="true"></span>
      {option.on ? t('signIn.on') : t('signIn.off')}
    </span>
  </div>

  <div class="grid gap-1">
    <h3 class="text-base font-semibold">{t(`signIn.options.${option.id}.title`)}</h3>
    <p class="text-sm text-muted-foreground">{option.id === 'password' ? t(option.on ? 'signIn.options.password.textOn' : 'signIn.options.password.textOff') : t(`signIn.options.${option.id}.text`)}</p>
  </div>

  {#if option.variables.length}
    <div class="mt-auto grid gap-3">
      <button
        type="button"
        class="flex w-fit cursor-pointer items-center gap-1 text-sm font-medium text-foreground/80 hover:text-foreground"
        aria-expanded={open}
        aria-controls={panel}
        onclick={() => (open = !open)}
      >
        {option.change === 'disable' ? t('signIn.howToOff') : t('signIn.howTo')}
        <ChevronDown class={['size-4 transition-transform', open && 'rotate-180']} aria-hidden="true" />
      </button>
      {#if open}
        <div id={panel} class="grid gap-2">
          <p class="text-xs text-muted-foreground">{option.change === 'disable' ? t('signIn.envHintOff') : t('signIn.envHint')}</p>
          <CodeBlock code={envSnippet(option.variables)} label={t('signIn.copyEnv')} lang="env" wrap />
        </div>
      {/if}
    </div>
  {/if}
</article>
