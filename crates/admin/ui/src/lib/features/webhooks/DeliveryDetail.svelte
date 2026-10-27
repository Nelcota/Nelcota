<script lang="ts">
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { Button } from '$lib/components/ui/button'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { href, navigate } from '$lib/navigation/router.svelte'
  import { errorMessage, t } from '$lib/i18n/index.svelte'
  import type { WebhookDetail } from '$lib/contracts/types'
  import { webhooks } from './api'
  import { canReplay, dateLabel, durationLabel, eventLabel, failureLabel, statusClass, statusLabel } from './format'

  let { id }: { id: string } = $props()
  const resource = new RemoteResource<WebhookDetail>()
  const delivery = $derived(resource.data?.delivery)
  let replayOpen = $state(false), busy = $state(false), refreshing = $state(false)
  async function load() { await resource.load(signal => webhooks.detail(id, signal)) }
  // Only a manual refresh disables the button; background polling would make it flicker.
  async function refresh() {
    if (refreshing) return
    refreshing = true
    try { await load() } finally { refreshing = false }
  }
  onMount(() => {
    void load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !resource.loading && ['pending', 'processing'].includes(delivery?.status ?? '')) void load() }, 5000)
    return () => { clearInterval(timer); resource.cancel() }
  })
  async function replay() {
    if (busy || !delivery || !canReplay(delivery)) return
    busy = true
    try {
      const result = await webhooks.replay(id)
      toast.success(t('webhooks.replayed'))
      navigate(`/webhooks/deliveries/${result.id}`)
    } catch (error) { toast.error(errorMessage(error)); throw error } finally { busy = false }
  }
</script>

<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8">
  <div><Button variant="outline" href={href('/webhooks?tab=deliveries')}>{t('webhooks.back')}</Button></div>
  <PageHeader title={t('webhooks.deliveryTitle', { id })} description={delivery ? `${delivery.endpoint_name} · ${delivery.schema}.${delivery.table} · ${eventLabel(delivery.event)}` : undefined}>
    {#snippet actions()}<Button variant="outline" onclick={refresh} disabled={refreshing}>{t('common.refresh')}</Button><Button onclick={() => replayOpen = true} disabled={busy || !delivery || !canReplay(delivery)}>{t('webhooks.replay')}</Button>{/snippet}
  </PageHeader>
  {#if resource.error}<LoadError message={errorMessage(resource.error)} onretry={load} busy={resource.loading} />{/if}
  {#if !resource.data && resource.loading}<Skeleton class="h-40 rounded-3xl" />{/if}
  {#if resource.data && delivery}
    <section class="grid gap-4 rounded-3xl bg-card p-5">
      <div class="flex flex-wrap items-center gap-3"><span class={['rounded-full px-3 py-1 text-sm font-medium', statusClass(delivery.status)]}>{statusLabel(delivery.status)}</span><span class="text-sm text-muted-foreground">{t('webhooks.attemptsOf', { done: delivery.attempts, count: delivery.max_attempts })}</span>{#if !delivery.endpoint_enabled}<span class="text-sm text-muted-foreground">{t('webhooks.paused')}</span>{/if}</div>
      {#if delivery.last_error}<p class="text-sm text-destructive">{failureLabel(delivery.last_error)}</p>{/if}
      <dl class="grid gap-4 text-sm sm:grid-cols-2">
        <div class="min-w-0"><dt class="text-muted-foreground">{t('webhooks.destination')}</dt><dd class="mt-1 break-all">{delivery.url}</dd></div>
        <div><dt class="text-muted-foreground">{t('webhooks.sent')}</dt><dd class="mt-1">{dateLabel(delivery.created_at)}</dd></div>
        <div class="min-w-0"><dt class="text-muted-foreground">{t('webhooks.eventId')}</dt><dd class="mt-1 break-all font-mono text-xs">{delivery.event_id}</dd></div>
        {#if delivery.next_attempt_at}<div><dt class="text-muted-foreground">{t('webhooks.nextAttempt')}</dt><dd class="mt-1">{dateLabel(delivery.next_attempt_at)}</dd></div>{/if}
      </dl>
      {#if delivery.replay_of}<a href={href(`/webhooks/deliveries/${delivery.replay_of}`)} class="text-sm text-brand underline">{t('webhooks.replayOf', { id: delivery.replay_of })}</a>{/if}
    </section>
    <section class="grid gap-4 rounded-3xl bg-card p-5"><h2 class="font-semibold">{t('webhooks.attemptHistory')}</h2>
      {#if (resource.data.attempts.length)}<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead><tr class="text-muted-foreground"><th class="py-3 pr-4 font-medium">{t('webhooks.attempt')}</th><th class="py-3 pr-4 font-medium">{t('webhooks.started')}</th><th class="py-3 pr-4 font-medium">{t('webhooks.duration')}</th><th class="py-3 font-medium">{t('webhooks.result')}</th></tr></thead><tbody>
        {#each resource.data.attempts as attempt (attempt.number)}<tr class="border-t border-border"><td class="py-3 pr-4 tabular-nums">{attempt.number}</td><td class="py-3 pr-4 whitespace-nowrap">{dateLabel(attempt.started_at)}</td><td class="py-3 pr-4 whitespace-nowrap tabular-nums">{durationLabel(attempt.duration_ms)}</td><td class="py-3">{attempt.status_code ? `HTTP ${attempt.status_code}` : attempt.finished_at ? '—' : statusLabel('processing')}{#if attempt.error}<p class="mt-1 text-xs text-muted-foreground">{failureLabel(attempt.error)}</p>{/if}</td></tr>{/each}
      </tbody></table></div>{/if}
      {#if !(resource.data.attempts.length)}<p class="text-sm text-muted-foreground">{t('webhooks.noAttempts')}</p>{/if}
    </section>
    <section class="grid gap-4 rounded-3xl bg-card p-5"><h2 class="font-semibold">{t('webhooks.payload')}</h2><CodeBlock code={resource.data.payload} wrap /></section>
  {/if}
</div>
<ConfirmDialog bind:open={replayOpen} title={t('webhooks.replayTitle')} description={t('webhooks.replayHint')} confirmLabel={t('webhooks.replay')} onconfirm={replay} />
