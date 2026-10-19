<script lang="ts">
  import { dateText } from '$lib/formatting/date'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { toast } from 'svelte-sonner'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import { api } from '$lib/transport/api'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'

  const DURATIONS = ['30', '90', '365']
  const durationLabel = (days: string) =>
    days === '365' ? t('connect.token.oneYear') : t('connect.token.days', { count: Number(days) })

  let days = $state('90')
  let issued = $state<{ token: string; expires_at: number } | null>(null)
  let busy = $state(false)

  async function issue() {
    if (busy) return
    busy = true
    try {
      issued = await api.post<{ token: string; expires_at: number }>('/tokens/service-role', { days: Number(days) })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      busy = false
    }
  }

  const expires = (epoch: number) =>
    dateText(epoch * 1000, new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'long' }).format)
</script>

<!-- The token is not stored: it shows once, here, to be copied. -->
<section class="grid gap-4 rounded-3xl bg-card p-6">
  <div>
    <h2 class="text-lg font-semibold">{t('connect.token.title')} <code class="font-mono">service_role</code></h2>
    <p class="mt-1 text-sm text-muted-foreground">{t('connect.token.intro')}</p>
  </div>
  <!-- A standing warning, not a live alert: plain markup instead of role="alert". -->
  <div class="flex items-start gap-3 rounded-2xl bg-warning/10 px-4 py-3 text-sm">
    <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
    <p><span class="font-medium text-warning">{t('connect.token.warningTitle')}.</span> <span class="text-muted-foreground">{t('connect.token.warning')}</span></p>
  </div>
  <p class="text-sm text-muted-foreground">{t('connect.token.details')}</p>

  {#if issued}
    <div class="grid gap-2">
      <CodeBlock code={issued.token} label={t('connect.token.copy')} wrap />
      <p class="text-sm text-warning">
        {t('connect.token.copyNow', { date: expires(issued.expires_at) })}
      </p>
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <Select.Root type="single" bind:value={days}>
      <Select.Trigger class="w-36" aria-label={t('connect.token.validity')}>
        {durationLabel(days)}
      </Select.Trigger>
      <Select.Content>
        {#each DURATIONS as duration (duration)}
          <Select.Item value={duration}>{durationLabel(duration)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <Button variant="outline" disabled={busy} onclick={issue}>
      {#if (busy)}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
      {#if !(busy)}<KeyRound data-icon="inline-start" aria-hidden="true" />{/if}
      {busy ? t('connect.token.generating') : issued ? t('connect.token.generateAnother') : t('connect.token.generate')}
    </Button>
    <span class="text-sm text-muted-foreground">
      {t('connect.token.orOnServer')} <code class="text-xs text-foreground">nelcota token service-role</code>
    </span>
  </div>
</section>
