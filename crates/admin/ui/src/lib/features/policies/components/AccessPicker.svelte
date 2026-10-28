<script lang="ts">
  import Users from '@lucide/svelte/icons/users'
  import UserRound from '@lucide/svelte/icons/user-round'
  import Globe from '@lucide/svelte/icons/globe'
  import Eye from '@lucide/svelte/icons/eye'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import type { AccessLevel, Audience } from '$lib/shared/schema/guided-access'
  import { t } from '$lib/i18n/index.svelte'

  // As opções ficam todas à vista, cada uma com a explicação, em vez de
  // escondidas num select: a escolha é o centro do painel.
  let { audience = $bindable<Audience>('owner'), level = $bindable<AccessLevel>('read') }: { audience?: Audience; level?: AccessLevel } = $props()
  const id = $props.id()

  const AUDIENCES = [
    { value: 'owner', icon: UserRound },
    { value: 'signedIn', icon: Users },
    { value: 'everyone', icon: Globe },
  ] as const
  const LEVELS = [
    { value: 'read', icon: Eye },
    { value: 'full', icon: PenLine },
  ] as const

  // Acesso público é só leitura neste assistente: a opção "full" fica marcada como indisponível.
  const publicOnly = $derived(audience === 'everyone')
  const shownLevel = $derived<AccessLevel>(publicOnly ? 'read' : level)

  const card = 'group flex cursor-pointer items-start gap-3 rounded-2xl border bg-card px-4 py-3.5 transition-colors hover:bg-accent has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:disabled]:hover:bg-card'
</script>

<fieldset class="grid gap-3">
  <legend class="mb-3 text-base font-semibold">{t('guided.access.who')}</legend>
  {#each AUDIENCES as option (option.value)}
    <label class={card}>
      <input type="radio" name={`${id}-audience`} value={option.value} bind:group={audience} class="sr-only" />
      <option.icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="grid gap-0.5">
        <span class="text-base font-medium">{t(`guided.access.audiences.${option.value}.label`)}</span>
        <span class="text-sm text-muted-foreground">{t(`guided.access.audiences.${option.value}.hint`)}</span>
      </span>
      <span class="mt-1 ml-auto size-4 shrink-0 rounded-full border-2 border-border-strong group-has-[:checked]:border-[5px] group-has-[:checked]:border-primary" aria-hidden="true"></span>
    </label>
  {/each}
</fieldset>

<fieldset class="grid gap-3">
  <legend class="mb-3 text-base font-semibold">{t('guided.access.what')}</legend>
  <div class="grid gap-3 sm:grid-cols-2">
    {#each LEVELS as option (option.value)}
      <label class={card}>
        <input
          type="radio"
          name={`${id}-level`}
          value={option.value}
          checked={shownLevel === option.value}
          disabled={publicOnly && option.value === 'full'}
          onchange={() => (level = option.value)}
          class="sr-only"
        />
        <option.icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="text-base font-medium">{t(`guided.access.levels.${option.value}`)}</span>
        <span class="mt-1 ml-auto size-4 shrink-0 rounded-full border-2 border-border-strong group-has-[:checked]:border-[5px] group-has-[:checked]:border-primary" aria-hidden="true"></span>
      </label>
    {/each}
  </div>
  {#if publicOnly}<p class="text-sm text-muted-foreground">{t('guided.access.publicReadOnly')}</p>{/if}
</fieldset>
