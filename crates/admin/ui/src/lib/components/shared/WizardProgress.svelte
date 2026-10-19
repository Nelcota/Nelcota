<script lang="ts">
  import { cn } from '$lib/components/utils'
  import { t } from '$lib/i18n/index.svelte'
  let { step, steps }: { step: number; steps: string[] } = $props()
</script>

<nav aria-label={t('guided.progress')} class="px-6 pt-5">
  <p class="mb-3 text-xs text-muted-foreground" aria-live="polite">{t('guided.step', { current: step + 1, total: steps.length })}</p>
  <ol class="flex gap-2">
    {#each steps as label, index}
      <li class="min-w-0 flex-1" aria-current={index === step ? 'step' : undefined}>
        <div class={cn('mb-2 h-1 rounded-full bg-muted', index <= step && 'bg-primary')} aria-hidden="true"></div>
        <span class={cn('text-xs text-muted-foreground', index === step && 'font-medium text-foreground')}>{label}</span>
      </li>
    {/each}
  </ol>
</nav>
